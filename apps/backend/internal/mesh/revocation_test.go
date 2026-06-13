package mesh

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"

	"github.com/google/uuid"
)

// TestGetRevocationsEventSourced verifies the M4 re-sourced revocation set
// (docs/m4-retire-vmc.md §3): a (vault, device) is revoked iff a device-level
// removal (vault_devices.removed_at_ms) OR a member-level removal
// (vault_members.revoked_at) applies to it. This mirrors what the old
// vault_credentials_issued-sourced set returned for a removed member/device,
// re-derived from the membership fold tables.
func TestGetRevocationsEventSourced(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	// Two member accounts in the vault, each with one bound device.
	memberA := f.seedAccount(t, "a@gmail.com")
	memberB := f.seedAccount(t, "b@gmail.com")
	devA := uuid.NewString()
	devB := uuid.NewString()

	seedMember := func(acct string) {
		t.Helper()
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
			VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
		`, f.vaultID, acct, f.ownerAcct); err != nil {
			t.Fatalf("seed member: %v", err)
		}
	}
	seedDevice := func(acct, dev string, removedAtMS *int64) {
		t.Helper()
		// device_pubkey is an arbitrary 32-byte blob; the revocation query
		// never inspects it.
		pub := make([]byte, 32)
		pub[0] = 1
		if _, err := f.pool.Exec(ctx, `
			INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms, removed_at_ms)
			VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 1000, $5)
		`, f.vaultID, dev, pub, acct, removedAtMS); err != nil {
			t.Fatalf("seed device: %v", err)
		}
	}

	seedMember(memberA)
	seedMember(memberB)
	// devA: still active (no removal). devB: still active for now.
	seedDevice(memberA, devA, nil)
	seedDevice(memberB, devB, nil)

	// Baseline: nothing removed → empty set.
	revs, err := f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault baseline: %v", err)
	}
	if len(revs) != 0 {
		t.Fatalf("baseline revocations = %d, want 0: %+v", len(revs), revs)
	}

	// Device-level removal of devA at HLC physical_ms 5000 (the
	// vault_device_removed fold target).
	const devARemovedMS int64 = 5000
	if _, err := f.pool.Exec(ctx, `
		UPDATE vault_devices SET removed_at_ms = $3
		 WHERE vault_id = $1::uuid AND device_id = $2::uuid
	`, f.vaultID, devA, devARemovedMS); err != nil {
		t.Fatalf("remove devA: %v", err)
	}

	revs, err = f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault after device removal: %v", err)
	}
	if len(revs) != 1 || revs[0].DeviceID != devA || revs[0].RevokedAtMS != devARemovedMS {
		t.Fatalf("after device removal = %+v, want [{device=%s at=%d}]", revs, devA, devARemovedMS)
	}

	// Member-level removal of memberB via the Phase-4 path: stamp
	// vault_members.revoked_at WITHOUT touching vault_devices (the
	// server-side RevokeMember/Leave behavior). The device should still be
	// reported revoked, sourced from the member signal.
	if _, err := f.pool.Exec(ctx, `
		UPDATE vault_members SET revoked_at = to_timestamp(6000 / 1000.0)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
	`, f.vaultID, memberB); err != nil {
		t.Fatalf("revoke memberB: %v", err)
	}

	revs, err = f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault after member removal: %v", err)
	}
	got := map[string]int64{}
	for _, r := range revs {
		got[r.DeviceID] = r.RevokedAtMS
	}
	if len(got) != 2 {
		t.Fatalf("after member removal = %+v, want 2 entries", revs)
	}
	if got[devA] != devARemovedMS {
		t.Errorf("devA revoked_at = %d, want %d", got[devA], devARemovedMS)
	}
	if got[devB] != 6000 {
		t.Errorf("devB (member-removed, Phase-4 path) revoked_at = %d, want 6000", got[devB])
	}

	// Cursor semantics: sinceMs strictly excludes <= cursor. With cursor
	// 5000, devA (at 5000) drops out; only devB (at 6000) remains.
	revs, err = f.svc.GetRevocationsForVault(ctx, f.vaultID, 5000)
	if err != nil {
		t.Fatalf("GetRevocationsForVault with cursor: %v", err)
	}
	if len(revs) != 1 || revs[0].DeviceID != devB {
		t.Fatalf("with cursor 5000 = %+v, want only devB", revs)
	}
}

// TestGetRevocationsMemberRemovedNoDeviceRow is the regression guard for the
// HIGH-severity M4 revocation bug: a member removed via the Phase-4 path
// (vault_members.revoked_at set) with ZERO vault_devices rows MUST still
// appear in the revocations delta, keyed by the member's install_id (== the
// device_id the mobile handshake presents). The previous FROM-vault_devices
// query dropped this member entirely because the member-level signal was read
// only via a correlated subquery per existing vault_devices ROW — so a member
// with no device row never produced a delta entry, and the mobile
// isRevoked() early-reject kept letting them mesh.
//
// Server-side, the member's device_id is recovered via installs.account_id →
// device_keys (a registered mesh device presenting that install_id), with NO
// vault_devices row in play. This mirrors the original
// vault_credentials_issued-sourced set, which was keyed on install_id.
func TestGetRevocationsMemberRemovedNoDeviceRow(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	// A member account with an install bound to it (installs.account_id) and a
	// registered mesh device key — but NO vault_devices row at all. This is
	// the server-email-invited member whose vault_device_added chain event has
	// not yet folded server-side.
	member := f.seedAccount(t, "noderow@gmail.com")
	memberInst := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_id) VALUES ($1::uuid, $2::uuid)
	`, memberInst, member); err != nil {
		t.Fatalf("seed install with account: %v", err)
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate device key: %v", err)
	}
	if err := f.svc.RegisterKey(ctx, memberInst, pub); err != nil {
		t.Fatalf("register device key: %v", err)
	}

	// Active member seat — no vault_devices row exists for this account.
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, f.vaultID, member, f.ownerAcct); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	// Sanity: no vault_devices row, so nothing revoked yet.
	revs, err := f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault baseline: %v", err)
	}
	if len(revs) != 0 {
		t.Fatalf("baseline revocations = %d, want 0: %+v", len(revs), revs)
	}

	// Phase-4 member removal: stamp vault_members.revoked_at ONLY (the
	// RevokeMember / Leave / TransferOwnership-leave behavior). No
	// vault_devices write — there is no row to write.
	if _, err := f.pool.Exec(ctx, `
		UPDATE vault_members SET revoked_at = to_timestamp(7000 / 1000.0)
		 WHERE vault_id = $1::uuid AND account_id = $2::uuid
	`, f.vaultID, member); err != nil {
		t.Fatalf("revoke member (Phase-4 path): %v", err)
	}

	revs, err = f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault after member removal: %v", err)
	}
	if len(revs) != 1 {
		t.Fatalf("after member removal = %+v, want exactly 1 entry (the member's install_id)", revs)
	}
	if revs[0].DeviceID != memberInst {
		t.Errorf("revoked device_id = %s, want member install_id %s", revs[0].DeviceID, memberInst)
	}
	if revs[0].RevokedAtMS != 7000 {
		t.Errorf("revoked_at_ms = %d, want 7000 (the member's revoked_at)", revs[0].RevokedAtMS)
	}

	// Cursor semantics still hold: strict > excludes the entry at its own ms.
	revs, err = f.svc.GetRevocationsForVault(ctx, f.vaultID, 7000)
	if err != nil {
		t.Fatalf("GetRevocationsForVault with cursor: %v", err)
	}
	if len(revs) != 0 {
		t.Fatalf("with cursor 7000 = %+v, want empty (strict >)", revs)
	}
}

// TestGetRevocationsEarliestRemovalWins verifies that when BOTH signals fire
// for a device (its own removal AND its account's member removal), the
// EARLIEST instant is reported — the device became untrusted at the first
// applicable removal, keeping the per-vault cursor monotonic.
func TestGetRevocationsEarliestRemovalWins(t *testing.T) {
	f := newWitnessFixture(t)
	ctx := context.Background()

	member := f.seedAccount(t, "c@gmail.com")
	dev := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, revoked_at)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid, to_timestamp(9000 / 1000.0))
	`, f.vaultID, member, f.ownerAcct); err != nil {
		t.Fatalf("seed revoked member: %v", err)
	}
	pub := make([]byte, 32)
	pub[0] = 7
	// Device removed EARLIER (3000) than the member removal (9000).
	if _, err := f.pool.Exec(ctx, `
		INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms, removed_at_ms)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 1000, 3000)
	`, f.vaultID, dev, pub, member); err != nil {
		t.Fatalf("seed device: %v", err)
	}

	revs, err := f.svc.GetRevocationsForVault(ctx, f.vaultID, 0)
	if err != nil {
		t.Fatalf("GetRevocationsForVault: %v", err)
	}
	if len(revs) != 1 || revs[0].DeviceID != dev || revs[0].RevokedAtMS != 3000 {
		t.Fatalf("got %+v, want earliest removal at 3000 for device %s", revs, dev)
	}
}
