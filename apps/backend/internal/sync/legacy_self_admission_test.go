package sync

// Regression tests for the legacy-path SELF-ADMISSION arm in PushEvents
// (internal/sync/service.go) — the fix for "a member never gets added to the
// first kaata I created, but a kaata I made later works".
//
// Shape of the bug: a kaata that reached the server through the SIGN-IN
// pending-registration block landed with vaults.vault_trust_anchor_pubkey
// NULL, because that block carried no anchor field until 2026-09. A NULL
// anchor turns the whole M2 membership-chain path off server-side, so the
// joiner's own vault_member_added / vault_device_added — the two events the
// invite-accept screen emits — fell through to the legacy role matrix, which
// demands `owner` for both. The joiner is an editor, so every push cycle
// rejected them insufficient_role; the client treats that reason as
// retryable (it never stamps rejected_at, by design — that would be silent
// data loss), so the events retried forever, never reached the events table,
// and the OWNER, whose members list is built from applied membership events,
// never saw the member at all. A kaata created through POST /v1/vaults has
// always carried its anchor, which is why a later one worked.
//
// The arm authorizes on the SESSION plus the server's OWN vault_members row
// (the one AcceptInvite wrote), never on the wire, and is scoped to
// anchor-less vaults. These tests pin both halves: what it now allows, and
// everything it still refuses.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// seedAnchorlessVault creates a vault with NO vault_trust_anchor_pubkey —
// exactly what the pre-2026-09 sign-in pending block produced — owned by the
// fixture's owner account, and returns its id. Deliberately NOT newM2Fixture's
// own vault, which is anchored.
func (f *m2Fixture) seedAnchorlessVault(t *testing.T, name string) string {
	t.Helper()
	ctx := context.Background()
	vaultID := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, $3, 'AFN', 0)
	`, vaultID, f.ownerAcct, name); err != nil {
		t.Fatalf("seed anchor-less vault: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, vaultID, f.ownerAcct); err != nil {
		t.Fatalf("seed anchor-less owner membership: %v", err)
	}
	return vaultID
}

// seedAcceptedMember writes the vault_members row AcceptInvite writes: an
// accepted, non-revoked member at `role`.
func (f *m2Fixture) seedAcceptedMember(t *testing.T, vaultID, accountID, role string) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(), `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid)
	`, vaultID, accountID, role, f.ownerAcct); err != nil {
		t.Fatalf("seed accepted member (%s): %v", role, err)
	}
}

// pushToVault is pushAs for a vault other than the fixture's anchored one.
func (f *m2Fixture) pushToVault(
	t *testing.T, vaultID, accountID, deviceID string, events ...PushEvent,
) *PushResponse {
	t.Helper()
	res, err := f.svc.PushEvents(context.Background(), PushInput{
		AccountID: accountID,
		VaultID:   vaultID,
		DeviceID:  deviceID,
		Events:    events,
	})
	if err != nil {
		t.Fatalf("PushEvents: %v", err)
	}
	return res
}

func (f *m2Fixture) eventStored(t *testing.T, eventID string) bool {
	t.Helper()
	var exists bool
	if err := f.pool.QueryRow(context.Background(), `
		SELECT EXISTS (SELECT 1 FROM events WHERE event_id = $1::uuid)
	`, eventID).Scan(&exists); err != nil {
		t.Fatalf("read events row: %v", err)
	}
	return exists
}

// memberRowIn is memberRow for an arbitrary vault ("" = no active row).
func (f *m2Fixture) memberRowIn(t *testing.T, vaultID, accountID string) string {
	t.Helper()
	var role string
	if err := f.pool.QueryRow(context.Background(), `
		SELECT role FROM vault_members
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
		   AND revoked_at IS NULL AND accepted_at IS NOT NULL
	`, vaultID, accountID).Scan(&role); err != nil {
		return ""
	}
	return role
}

func requireRejectedReason(t *testing.T, res *PushResponse, eventID, reason string) {
	t.Helper()
	if len(res.Accepted) != 0 || len(res.Rejected) != 1 {
		t.Fatalf("push = accepted:%d rejected:%+v, want exactly 1 rejection (%s)",
			len(res.Accepted), res.Rejected, reason)
	}
	if res.Rejected[0].EventID != eventID || res.Rejected[0].Reason != reason {
		t.Fatalf("rejected[0] = %+v, want {%s %s}", res.Rejected[0], eventID, reason)
	}
}

func randomPubkeyB64(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	return base64.StdEncoding.EncodeToString(pub)
}

// TestLegacySelfAdmissionOnAnchorlessVaultAccepted is the bug itself: a
// joiner's OWN member_added + device_added, unsigned, on an anchor-less
// vault, pushed under the joiner's own JWT at the role the server already
// recorded for them. Before the fix both rejected insufficient_role forever.
func TestLegacySelfAdmissionOnAnchorlessVaultAccepted(t *testing.T) {
	f := newM2Fixture(t)

	vaultID := f.seedAnchorlessVault(t, "First Kaata")
	joiner := f.seedAccount(t, "joiner@gmail.com")
	f.seedAcceptedMember(t, vaultID, joiner, "editor")
	joinerDevID := uuid.NewString()

	added := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, joiner,
		map[string]any{"account_id": joiner, "role": "editor"})
	res := f.pushToVault(t, vaultID, joiner, joinerDevID, added)
	requireAccepted(t, res, 1)
	if !f.eventStored(t, added.EventID) {
		t.Fatalf("accepted self-admission did not reach the events table")
	}

	bound := f.membershipEvent(EventVaultDeviceAdded, joinerDevID, joiner, joinerDevID,
		map[string]any{
			"account_id":    joiner,
			"device_id":     joinerDevID,
			"device_pubkey": randomPubkeyB64(t),
		})
	res2 := f.pushToVault(t, vaultID, joiner, joinerDevID, bound)
	requireAccepted(t, res2, 1)
	if !f.eventStored(t, bound.EventID) {
		t.Fatalf("accepted self device-bind did not reach the events table")
	}

	// Accepted into the LOG only. The legacy path's writers stay the Phase 4
	// REST endpoints, so neither event folds: the membership row is still
	// exactly what AcceptInvite wrote, and no vault_devices row appears.
	if role := f.memberRowIn(t, vaultID, joiner); role != "editor" {
		t.Errorf("joiner role after self-admission = %q, want unchanged 'editor'", role)
	}
	var deviceRows int
	if err := f.pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM vault_devices WHERE vault_id = $1::uuid
	`, vaultID).Scan(&deviceRows); err != nil {
		t.Fatalf("count vault_devices: %v", err)
	}
	if deviceRows != 0 {
		t.Errorf("legacy device_added folded into vault_devices (%d rows); it must not", deviceRows)
	}
}

// TestLegacySelfAdmissionCannotElevateOrAdmitOthers pins every refusal the
// arm keeps. The corroboration read is what makes these impossible: the
// payload's account must be the JWT-authenticated pusher AND vault_members
// must already say so, at exactly that role.
func TestLegacySelfAdmissionCannotElevateOrAdmitOthers(t *testing.T) {
	f := newM2Fixture(t)

	vaultID := f.seedAnchorlessVault(t, "First Kaata")
	joiner := f.seedAccount(t, "joiner@gmail.com")
	f.seedAcceptedMember(t, vaultID, joiner, "editor")
	joinerDevID := uuid.NewString()

	// (a) Self-elevation: the payload claims a role the server did not
	// record. wantRole != stored role → no corroboration → role matrix.
	coup := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, joiner,
		map[string]any{"account_id": joiner, "role": "owner"})
	requireRejectedReason(t, f.pushToVault(t, vaultID, joiner, joinerDevID, coup),
		coup.EventID, "insufficient_role")

	// (b) Admitting someone else, honestly actored: the payload account is
	// not the session account, so the arm never engages.
	stranger := f.seedAccount(t, "stranger@gmail.com")
	other := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, stranger,
		map[string]any{"account_id": stranger, "role": "editor"})
	requireRejectedReason(t, f.pushToVault(t, vaultID, joiner, joinerDevID, other),
		other.EventID, "insufficient_role")

	// (c) Admitting someone else with a SPOOFED actor_account_id (claiming
	// the owner authored it). PRE-EXISTING legacy-path property, unchanged by
	// this arm and mirrored by the self-leave coup case: the unsigned ACL
	// trusts the wire's actor, so the event is logged — but the arm stays
	// false, the fold gate still excludes it, and the stranger does NOT
	// become a member. Wire-actor authentication is exactly what the M2
	// chain replaced this path for.
	ownerActor := f.ownerAcct
	spoof := f.membershipEvent(EventVaultMemberAdded, joinerDevID, ownerActor, stranger,
		map[string]any{"account_id": stranger, "role": "editor"})
	resSpoof := f.pushToVault(t, vaultID, joiner, joinerDevID, spoof)
	if len(resSpoof.Accepted) != 1 {
		t.Fatalf("spoofed-actor member_added = %+v, want legacy log-accept", resSpoof)
	}
	if role := f.memberRowIn(t, vaultID, stranger); role != "" {
		t.Errorf("spoofed member_added folded: stranger is now %q", role)
	}

	// (d) Binding a device to someone else's account.
	foreignBind := f.membershipEvent(EventVaultDeviceAdded, joinerDevID, joiner, joinerDevID,
		map[string]any{
			"account_id":    stranger,
			"device_id":     uuid.NewString(),
			"device_pubkey": randomPubkeyB64(t),
		})
	requireRejectedReason(t, f.pushToVault(t, vaultID, joiner, joinerDevID, foreignBind),
		foreignBind.EventID, "insufficient_role")

	// (e) A REVOKED member cannot re-admit themselves. The outer membership
	// gate refuses them too, with ErrNotMember — but it reads through a
	// 60-second cache, so the corroboration read inside the transaction is
	// the authoritative one. Push through a FRESH service so the cache the
	// pushes above warmed cannot be what produces the refusal.
	if _, err := f.pool.Exec(context.Background(), `
		UPDATE vault_members SET revoked_at = NOW()
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
	`, vaultID, joiner); err != nil {
		t.Fatalf("revoke joiner: %v", err)
	}
	readmit := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, joiner,
		map[string]any{"account_id": joiner, "role": "editor"})
	fresh := NewService(f.pool)
	if _, err := fresh.PushEvents(context.Background(), PushInput{
		AccountID: joiner, VaultID: vaultID, DeviceID: joinerDevID,
		Events: []PushEvent{readmit},
	}); err == nil {
		t.Fatalf("revoked member self-readmission succeeded; want ErrNotMember")
	}
	if f.eventStored(t, readmit.EventID) {
		t.Errorf("revoked member self-readmission reached the events table")
	}
}

// TestSelfAdmissionArmIsScopedToAnchorlessVaults: on an ANCHORED vault the
// chain rules are strictly stronger and must keep applying — an unsigned
// self member_added there is still insufficient_role, because the correct
// fix for an anchored vault is to SIGN the event.
func TestSelfAdmissionArmIsScopedToAnchorlessVaults(t *testing.T) {
	f := newM2Fixture(t)

	joiner := f.seedAccount(t, "joiner@gmail.com")
	f.seedAcceptedMember(t, f.vaultID, joiner, "editor")
	joinerDevID := uuid.NewString()

	unsigned := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, joiner,
		map[string]any{"account_id": joiner, "role": "editor"})
	requireRejectedReason(t, f.pushToVault(t, f.vaultID, joiner, joinerDevID, unsigned),
		unsigned.EventID, "insufficient_role")

	// Sanity: the fixture vault really is anchored (guards against the
	// fixture drifting to a NULL anchor and making this test vacuous).
	var anchor []byte
	if err := f.pool.QueryRow(context.Background(), `
		SELECT vault_trust_anchor_pubkey FROM vaults WHERE vault_id = $1::uuid
	`, f.vaultID).Scan(&anchor); err != nil {
		t.Fatalf("read anchor: %v", err)
	}
	if len(anchor) != ed25519.PublicKeySize {
		t.Fatalf("fixture vault anchor = %d bytes, want %d", len(anchor), ed25519.PublicKeySize)
	}
}

// TestSelfAdmissionPayloadIsNotTrustedForRole guards the corroboration read
// itself: a malformed or empty payload must never corroborate.
func TestSelfAdmissionPayloadIsNotTrustedForRole(t *testing.T) {
	f := newM2Fixture(t)

	vaultID := f.seedAnchorlessVault(t, "First Kaata")
	joiner := f.seedAccount(t, "joiner@gmail.com")
	f.seedAcceptedMember(t, vaultID, joiner, "editor")
	joinerDevID := uuid.NewString()

	// Empty payload: no account_id, so p.AccountID == "" != in.AccountID.
	empty := f.membershipEvent(EventVaultMemberAdded, joinerDevID, joiner, joiner,
		map[string]any{})
	requireRejectedReason(t, f.pushToVault(t, vaultID, joiner, joinerDevID, empty),
		empty.EventID, "insufficient_role")

	// Non-object payload: json.Unmarshal fails, so the arm never engages.
	raw, _ := json.Marshal("not-an-object")
	tgt := joiner
	garbage := PushEvent{
		EventID:        uuid.NewString(),
		HLC:            PushHLC{PhysicalMS: f.nextPMS(), Logical: 0, DeviceID: joinerDevID},
		EventType:      EventVaultMemberAdded,
		SchemaVersion:  1,
		ActorAccountID: &tgt,
		TargetID:       &tgt,
		Payload:        raw,
	}
	requireRejectedReason(t, f.pushToVault(t, vaultID, joiner, joinerDevID, garbage),
		garbage.EventID, "insufficient_role")
}
