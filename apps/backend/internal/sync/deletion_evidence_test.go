package sync

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func TestSignedSharedLedgerSurvivesAuthorAccountDeletion(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	staff := f.seedAccount(t, "departing@example.test")
	_, staffKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	staffDevice := uuid.NewString()
	admit := f.membershipEvent(EventVaultMemberAdded, f.anchorDeviceID, f.ownerAcct, staff,
		map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &admit, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, admit), 1)
	bind := f.membershipEvent(EventVaultDeviceAdded, staffDevice, staff, staff, nil)
	bind.Payload, err = json.Marshal(map[string]any{
		"account_id": staff, "device_id": staffDevice, "device_pubkey": b64pub(staffKey),
		"witness": f.deviceWitness(t, staff, staffDevice, b64pub(staffKey), bind.HLC.PhysicalMS),
	})
	if err != nil {
		t.Fatal(err)
	}
	f.signEvent(t, &bind, staffKey)
	requireAccepted(t, f.pushAs(t, staff, bind), 1)
	entryID, relationshipID := uuid.NewString(), uuid.NewString()
	entry := f.membershipEvent("entry_created", staffDevice, staff, entryID, map[string]any{
		"entry_id": entryID, "relationship_id": relationshipID, "type": "debt", "amount_afn": 42,
	})
	entry.RelationshipID = &relationshipID
	f.signEvent(t, &entry, staffKey)
	settled := f.membershipEvent("entry_settled", staffDevice, staff, entryID, map[string]any{"entry_id": entryID})
	settled.RelationshipID = &relationshipID
	f.signEvent(t, &settled, staffKey)
	requireAccepted(t, f.pushAs(t, staff, entry, settled), 2)
	original := []PushEvent{admit, bind, entry, settled}

	if err := auth.NewService(f.pool, "test", "secret").DeleteAccount(ctx, staff); err != nil {
		t.Fatal(err)
	}
	var liveActor, retainedActor *string
	if err := f.pool.QueryRow(ctx, `SELECT account_id::text, signed_actor_account_id::text FROM events WHERE event_id=$1::uuid`, entry.EventID).Scan(&liveActor, &retainedActor); err != nil {
		t.Fatal(err)
	}
	if liveActor != nil || retainedActor == nil || *retainedActor != staff {
		t.Fatalf("live actor = %v; signed actor = %v", liveActor, retainedActor)
	}
	// All replica restore routes must return the same canonical envelope and
	// signature, even though the actor has no account or server membership.
	pulled, err := f.svc.PullEvents(ctx, PullInput{AccountID: f.ownerAcct, VaultID: f.vaultID, Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	assertPreservedSignedEvents(t, f.vaultID, original, pulled.Events)
	tail, err := f.svc.pullTail(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatal(err)
	}
	assertPreservedSignedEvents(t, f.vaultID, original, tail)
	chain, err := f.svc.pullMembershipChain(ctx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	assertPreservedSignedEvents(t, f.vaultID, []PushEvent{admit, bind}, chain)
	chapters, err := f.svc.pullSettlementEvents(ctx, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	assertPreservedSignedEvents(t, f.vaultID, []PushEvent{settled}, chapters)
	projectionEvents, _, err := loadVaultEvents(ctx, f.pool, f.vaultID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range projectionEvents {
		if ev.EventID == entry.EventID && (ev.ActorAccountID == nil || *ev.ActorAccountID != staff) {
			t.Fatal("snapshot projection lost signed actor")
		}
	}
	if _, err := f.svc.PullEvents(ctx, PullInput{AccountID: staff, VaultID: f.vaultID, Limit: 100}); err == nil {
		t.Fatal("preserved evidence must not restore deleted actor's access")
	}
	retry := f.pushAs(t, f.ownerAcct, entry)
	if len(retry.Duplicates) != 1 || retry.Duplicates[0] != entry.EventID {
		t.Fatalf("retained deleted-author retry must be a duplicate: %+v", retry)
	}
	unseen := entry
	unseen.EventID = uuid.NewString()
	f.signEvent(t, &unseen, staffKey)
	rejected := f.pushAs(t, f.ownerAcct, unseen)
	if len(rejected.Rejected) != 1 || rejected.Rejected[0].Reason != "insufficient_role" {
		t.Fatalf("new deleted-author FK must be rejected without rewriting signature: %+v", rejected)
	}
	// Future inserts keep using the original actor.
	future := f.membershipEvent("entry_created", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{})
	f.signEvent(t, &future, f.anchorPriv)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, future), 1)
	if err := f.pool.QueryRow(ctx, `SELECT signed_actor_account_id::text FROM events WHERE event_id=$1::uuid`, future.EventID).Scan(&retainedActor); err != nil || retainedActor == nil || *retainedActor != f.ownerAcct {
		t.Fatalf("new signed event actor not preserved: %v, %v", retainedActor, err)
	}
}

func TestSignedActorMigrationPreservesKnownAndUnknownHistory(t *testing.T) {
	f := newM2Fixture(t)
	ctx := t.Context()
	known := f.membershipEvent("entry_created", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{})
	f.signEvent(t, &known, f.anchorPriv)
	unknown := f.membershipEvent("entry_created", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{})
	f.signEvent(t, &unknown, f.anchorPriv)
	unsigned := f.membershipEvent("entry_created", f.anchorDeviceID, f.ownerAcct, uuid.NewString(), map[string]any{})
	requireAccepted(t, f.pushAs(t, f.ownerAcct, known, unknown, unsigned), 3)
	// Replay migration on old-schema rows, including an actor already erased
	// by an earlier deletion. Never infer that missing actor from a device.
	if _, err := f.pool.Exec(ctx, `DROP TRIGGER signed_event_actor_evidence ON events;
		DROP FUNCTION preserve_signed_event_actor(); ALTER TABLE events DROP COLUMN signed_actor_account_id;`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE events SET account_id=NULL WHERE event_id=$1::uuid`, unknown.EventID); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../db/migrations/050_signed_event_actor_evidence.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		id   string
		want *string
	}{{known.EventID, &f.ownerAcct}, {unknown.EventID, nil}, {unsigned.EventID, nil}} {
		var got *string
		if err := f.pool.QueryRow(ctx, `SELECT signed_actor_account_id::text FROM events WHERE event_id=$1::uuid`, sample.id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if (got == nil) != (sample.want == nil) || got != nil && *got != *sample.want {
			t.Fatalf("migration actor for %s = %v, want %v", sample.id, got, sample.want)
		}
	}
	// A live FK change or attempted evidence rewrite must not restamp history.
	if _, err := f.pool.Exec(ctx, `UPDATE events SET account_id=NULL, signed_actor_account_id=NULL WHERE event_id=$1::uuid`, known.EventID); err != nil {
		t.Fatal(err)
	}
	tail, err := f.svc.pullTail(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range tail {
		if ev.EventID == known.EventID {
			assertPreservedSignedEvents(t, f.vaultID, []PushEvent{known}, []PulledEvent{ev})
		}
	}
}

func assertPreservedSignedEvents(t *testing.T, vaultID string, original []PushEvent, pulled []PulledEvent) {
	t.Helper()
	if len(original) != len(pulled) {
		t.Fatalf("got %d events, want %d", len(pulled), len(original))
	}
	wants := map[string]PushEvent{}
	for _, ev := range original {
		wants[ev.EventID] = ev
	}
	for _, got := range pulled {
		want, ok := wants[got.EventID]
		if !ok {
			t.Fatalf("unexpected event %s", got.EventID)
		}
		wire := PushEvent{EventID: got.EventID, EventType: got.EventType, SchemaVersion: got.SchemaVersion,
			HLC:      PushHLC{PhysicalMS: got.HLC.PMS, Logical: got.HLC.L, DeviceID: got.HLC.DID},
			TargetID: got.TargetID, RelationshipID: got.RelationshipID, ActorAccountID: got.AccountID, Payload: got.Payload}
		wantBytes, err := canonicalSignableEvent(vaultID, &want)
		if err != nil {
			t.Fatal(err)
		}
		gotBytes, err := canonicalSignableEvent(vaultID, &wire)
		if err != nil || !bytes.Equal(wantBytes, gotBytes) {
			t.Fatalf("canonical envelope changed for %s", got.EventID)
		}
		if derefStr(got.EventSigB64) != derefStr(want.EventSigB64) || derefStr(got.SignerDevicePubkey) != derefStr(want.SignerDevicePubkeyB64) {
			t.Fatal("signature material changed")
		}
		sig, _ := base64.StdEncoding.DecodeString(derefStr(got.EventSigB64))
		pub, _ := base64.StdEncoding.DecodeString(derefStr(got.SignerDevicePubkey))
		if !ed25519.Verify(pub, gotBytes, sig) {
			t.Fatal("surviving replica cannot verify signature")
		}
	}
}
