package sync

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func pushHTTP(t *testing.T, f *m2Fixture, accountID string, events ...PushEvent) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(pushRequest{VaultID: f.vaultID, DeviceID: f.anchorDeviceID, Events: events})
	if err != nil {
		t.Fatal(err)
	}
	token, err := auth.SignSession(testJWTSecret, accountID, f.anchorDeviceID, "google", "synthetic")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/push", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	auth.RequireSession(testJWTSecret)(http.HandlerFunc(NewHandler(f.svc).Push)).ServeHTTP(rec, req)
	return rec
}

// Mirrors onboarding -> local tallies -> sign-in -> invite. The local genesis
// MUST travel unchanged: dropping/relabeling it breaks the joiner's chain.
func TestPreSignInFirstVaultDrainsAndRestores(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()
	localID := "local:" + base64.RawURLEncoding.EncodeToString(f.anchorPub)[:16]
	genesis := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, "", localID,
		map[string]any{"account_id": localID, "role": "owner"})
	f.signEvent(t, &genesis, f.anchorPriv)
	queued := []PushEvent{genesis}
	relations := make([]string, 18)
	for i := range relations {
		relations[i] = uuid.NewString()
		personID := uuid.NewString()
		ev := f.membershipEvent("person_added", f.anchorDeviceID, "", personID, map[string]any{
			"user_id": personID, "name": "Synthetic customer", "phone_e164": nil, "relationship_context": "peer",
		})
		ev.RelationshipID = &relations[i]
		f.signEvent(t, &ev, f.anchorPriv)
		queued = append(queued, ev)
	}
	for i := 0; i < 70; i++ {
		relID := relations[i%len(relations)]
		entryID := uuid.NewString()
		ev := f.membershipEvent("entry_created", f.anchorDeviceID, "", entryID, map[string]any{
			"entry_id": entryID, "relationship_id": relID, "type": "debt", "amount_afn": 123.45, "note": "synthetic",
		})
		ev.RelationshipID = &relID
		f.signEvent(t, &ev, f.anchorPriv)
		queued = append(queued, ev)
	}
	boundary := queued[len(queued)-1]
	binding := f.membershipEvent("account_bound", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{
		"account_id": f.ownerAcct, "retroactive_through_event_id": boundary.EventID, "from_user_id": uuid.NewString(),
	})
	f.signEvent(t, &binding, f.anchorPriv)
	queued = append(queued, binding)
	original := append([]PushEvent(nil), queued...)
	// Normal retries, not a database repair or rewrite. Older pre-binding rows
	// may need a subsequent pass after the binding + cutoff become available.
	for pass := 0; pass < 4 && len(queued) > 0; pass++ {
		rec := pushHTTP(t, f, f.ownerAcct, queued...)
		if rec.Code != http.StatusOK {
			t.Fatalf("pass %d: %d %s", pass, rec.Code, rec.Body.String())
		}
		var response PushResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		next := make([]PushEvent, 0)
		for _, ev := range queued {
			if !accepted(&response, ev.EventID) {
				next = append(next, ev)
			}
		}
		queued = next
	}
	if len(queued) != 0 {
		t.Fatalf("%d pre-sign-in records remain stranded", len(queued))
	}
	// Repeating the original upload is entirely idempotent.
	rec := pushHTTP(t, f, f.ownerAcct, original...)
	var retry PushResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &retry) != nil || len(retry.Duplicates) != len(original) {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	var members int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid`, f.vaultID).Scan(&members); err != nil {
		t.Fatal(err)
	}
	if members != 1 {
		t.Fatal("local sentinel must not create a server ACL seat")
	}
	joiner := f.seedAccount(t, "joiner@example.com")
	_, err := f.pool.Exec(ctx, `INSERT INTO vault_members (vault_id,account_id,role,accepted_at) VALUES ($1::uuid,$2::uuid,'editor',NOW())`, f.vaultID, joiner)
	if err != nil {
		t.Fatal(err)
	}
	pulled, err := f.svc.PullEvents(ctx, PullInput{AccountID: joiner, VaultID: f.vaultID, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	assertSignedRoundTrip(t, f, original, pulled.Events)
	tail, err := f.svc.pullTail(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.svc.resolveBindingsOnPulled(ctx, f.vaultID, tail)
	assertSignedRoundTrip(t, f, original, tail)
	chain, err := f.svc.pullMembershipChain(ctx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	f.svc.resolveBindingsOnPulled(ctx, f.vaultID, chain)
	assertSignedRoundTrip(t, f, []PushEvent{genesis}, chain)
	// Snapshot generation must also read the extended target without changing
	// tallies, amounts, or notes. The membership carve-out above restores proof.
	tx, err := f.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	blob, _, err := buildSnapshotInTx(ctx, tx, f.vaultID, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	var projection Projection
	if err := json.Unmarshal(blob, &projection); err != nil {
		t.Fatal(err)
	}
	if len(projection.Entries) != 70 {
		t.Fatalf("snapshot has %d entries, want 70", len(projection.Entries))
	}
	if len(projection.Users) != 18 || len(projection.Relationships) != 18 {
		t.Fatalf("contacts missing: %d users, %d relationships", len(projection.Users), len(projection.Relationships))
	}
	for _, entry := range projection.Entries {
		if entry.AmountAFN.String() != "123.45" || entry.Note == nil || *entry.Note != "synthetic" {
			t.Fatalf("amount changed: %s", entry.AmountAFN)
		}
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	// The invitee's witnessed admission must also reach the owner's stream,
	// where mobile builds its Members list. No new vault is involved.
	_, joinKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	admit := f.membershipEvent(EventVaultMemberAdded, uuid.NewString(), joiner, joiner, nil)
	admit.Payload, _ = json.Marshal(map[string]any{
		"account_id": joiner, "role": "editor", "display_name": "Synthetic member",
		"witness": f.memberWitness(t, joiner, f.ownerAcct, "editor", admit.HLC.PhysicalMS),
	})
	f.signEvent(t, &admit, joinKey)
	rec = pushHTTP(t, f, joiner, admit)
	var joined PushResponse
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &joined) != nil || !accepted(&joined, admit.EventID) {
		t.Fatalf("join admission: %d %s", rec.Code, rec.Body.String())
	}
	ownerPull, err := f.svc.PullEvents(ctx, PullInput{AccountID: f.ownerAcct, VaultID: f.vaultID, AfterServerSeq: pulled.NextAfterServerSeq, Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	if len(ownerPull.Events) != 1 || ownerPull.Events[0].EventID != admit.EventID || derefStr(ownerPull.Events[0].TargetID) != joiner {
		t.Fatal("member admission missing from owner stream")
	}
}

func assertSignedRoundTrip(t *testing.T, f *m2Fixture, original []PushEvent, pulled []PulledEvent) {
	t.Helper()
	if len(pulled) != len(original) {
		t.Fatalf("got %d events, want %d", len(pulled), len(original))
	}
	byID := map[string]PushEvent{}
	for _, ev := range original {
		byID[ev.EventID] = ev
	}
	for _, got := range pulled {
		want, ok := byID[got.EventID]
		if !ok {
			t.Fatalf("unexpected event %s", got.EventID)
		}
		wire := PushEvent{EventID: got.EventID, EventType: got.EventType, SchemaVersion: got.SchemaVersion,
			HLC:      PushHLC{PhysicalMS: got.HLC.PMS, Logical: got.HLC.L, DeviceID: got.HLC.DID},
			TargetID: got.TargetID, RelationshipID: got.RelationshipID, ActorAccountID: got.AccountID, Payload: got.Payload}
		wantBytes, _ := canonicalSignableEvent(f.vaultID, &want)
		gotBytes, err := canonicalSignableEvent(f.vaultID, &wire)
		if err != nil || !bytes.Equal(wantBytes, gotBytes) {
			t.Fatalf("signed envelope changed for %s: %s -> %s", got.EventType, wantBytes, gotBytes)
		}
		sig, err := base64.StdEncoding.DecodeString(derefStr(got.EventSigB64))
		if err != nil || !ed25519.Verify(f.anchorPub, gotBytes, sig) {
			t.Fatal("replica cannot verify original signature")
		}
	}
}

func TestLocalMemberTargetRequiresChainProof(t *testing.T) {
	f := newM2Fixture(t)
	ctx := context.Background()
	localID := "local:" + base64.RawURLEncoding.EncodeToString(f.anchorPub)[:16]
	makeEvent := func(kind string) PushEvent {
		return f.membershipEvent(kind, f.anchorDeviceID, f.ownerAcct, localID,
			map[string]any{"account_id": localID, "role": "owner"})
	}
	// Round-trip all three member event kinds, not arbitrary text targets.
	for _, kind := range []string{EventVaultMemberAdded, EventVaultMemberRoleChng, EventVaultMemberRemoved} {
		ev := makeEvent(kind)
		f.signEvent(t, &ev, f.anchorPriv)
		rec := pushHTTP(t, f, f.ownerAcct, ev)
		var res PushResponse
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || !accepted(&res, ev.EventID) {
			t.Fatalf("%s: %d %s", kind, rec.Code, rec.Body.String())
		}
	}
	assertRejected := func(ev PushEvent) {
		t.Helper()
		rec := pushHTTP(t, f, f.ownerAcct, ev)
		var res PushResponse
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil {
			t.Fatalf("%d %s", rec.Code, rec.Body.String())
		}
		requireRejectedUnverified(t, &res, ev.EventID)
	}
	assertRejected(makeEvent(EventVaultMemberAdded)) // JWT owner alone is insufficient.
	_, foreignKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ev := makeEvent(EventVaultMemberAdded)
	f.signEvent(t, &ev, foreignKey)
	assertRejected(ev)
	ev = makeEvent(EventVaultMemberAdded)
	f.signEvent(t, &ev, f.anchorPriv)
	ev.Payload = json.RawMessage(`{"account_id":"` + localID + `","role":"editor"}`)
	assertRejected(ev) // A syntactically-valid target doesn't bypass signature verification.
	for _, kind := range []string{"entry_created", "account_bound", EventVaultDeviceAdded} {
		ev := makeEvent(kind)
		f.signEvent(t, &ev, f.anchorPriv)
		if rec := pushHTTP(t, f, f.ownerAcct, ev); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s target escape: %d %s", kind, rec.Code, rec.Body.String())
		}
	}
	for _, target := range []string{"local:short", "local:AbCdEfGhIjKlMnO!", "arbitrary-text", "local:AbCdEfGhIjKlMnOp-extra"} {
		ev := makeEvent(EventVaultMemberAdded)
		ev.TargetID = &target
		ev.Payload, _ = json.Marshal(map[string]any{"account_id": target, "role": "owner"})
		f.signEvent(t, &ev, f.anchorPriv)
		if rec := pushHTTP(t, f, f.ownerAcct, ev); rec.Code != http.StatusBadRequest {
			t.Fatalf("bad target accepted: %d", rec.Code)
		}
	}
	ev = makeEvent(EventVaultMemberAdded)
	ev.Payload = json.RawMessage(`{"account_id":"local:AbCdEfGhIjKlMnOp","role":"owner"}`)
	f.signEvent(t, &ev, f.anchorPriv)
	if rec := pushHTTP(t, f, f.ownerAcct, ev); rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatched payload target accepted: %d", rec.Code)
	}
	stranger := f.seedAccount(t, "stranger@example.com")
	ev = makeEvent(EventVaultMemberAdded)
	ev.ActorAccountID = nil
	f.signEvent(t, &ev, f.anchorPriv)
	if rec := pushHTTP(t, f, stranger, ev); rec.Code != http.StatusForbidden {
		t.Fatalf("non-member admitted: %d", rec.Code)
	}
	// Legacy/anchorless server vaults cannot accept these using the JWT arm.
	if _, err := f.pool.Exec(ctx, `UPDATE vaults SET vault_trust_anchor_pubkey=NULL WHERE vault_id=$1::uuid`, f.vaultID); err != nil {
		t.Fatal(err)
	}
	assertRejected(ev)
}

func TestPendingBindingCutoffDoesNotWidenAuthority(t *testing.T) {
	for _, scenario := range []string{"different_event", "different_device", "after_binding", "different_account", "insufficient_role"} {
		t.Run(scenario, func(t *testing.T) {
			f := newM2Fixture(t)
			candidate := f.membershipEvent("vault_setting_set", f.anchorDeviceID, "", f.vaultID,
				map[string]any{"key": "name", "value": "must not apply"})
			binding := f.membershipEvent("account_bound", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{
				"account_id": f.ownerAcct, "retroactive_through_event_id": candidate.EventID,
			})
			pusher := f.ownerAcct
			switch scenario {
			case "different_event":
				candidate.EventID = uuid.NewString()
			case "different_device":
				candidate.HLC.DeviceID = uuid.NewString()
			case "after_binding":
				candidate.HLC.PhysicalMS = binding.HLC.PhysicalMS + 1
			case "different_account", "insufficient_role":
				pusher = f.seedAccount(t, "viewer@example.com")
				if _, err := f.pool.Exec(context.Background(), `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'viewer',NOW())`, f.vaultID, pusher); err != nil {
					t.Fatal(err)
				}
				if scenario == "insufficient_role" {
					binding.ActorAccountID = &pusher
					binding.Payload, _ = json.Marshal(map[string]any{"account_id": pusher, "retroactive_through_event_id": candidate.EventID})
				}
			}
			bindPusher := *binding.ActorAccountID
			if rec := pushHTTP(t, f, bindPusher, binding); rec.Code != http.StatusOK {
				t.Fatalf("binding: %d %s", rec.Code, rec.Body.String())
			}
			rec := pushHTTP(t, f, pusher, candidate)
			var res PushResponse
			if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || len(res.Rejected) != 1 || len(res.Accepted) != 0 {
				t.Fatalf("authority widened: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestUnsignedLegacyBindingAttributionStillWorks(t *testing.T) {
	f := newM2Fixture(t)
	entry := f.membershipEvent("entry_created", f.anchorDeviceID, "", uuid.NewString(), map[string]any{"amount_afn": 15})
	bind := f.membershipEvent("account_bound", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{
		"account_id": f.ownerAcct, "retroactive_through_event_id": entry.EventID,
	})
	for _, ev := range []PushEvent{bind, entry} {
		rec := pushHTTP(t, f, f.ownerAcct, ev)
		var res PushResponse
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &res) != nil || !accepted(&res, ev.EventID) {
			t.Fatalf("legacy: %d %s", rec.Code, rec.Body.String())
		}
	}
	pulled, err := f.svc.PullEvents(context.Background(), PullInput{AccountID: f.ownerAcct, VaultID: f.vaultID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range pulled.Events {
		if ev.EventID == entry.EventID && derefStr(ev.AccountID) != f.ownerAcct {
			t.Fatal("unsigned legacy attribution regressed")
		}
	}
}
