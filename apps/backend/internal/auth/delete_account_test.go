package auth

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

// Regression tests for DELETE /v1/account against the REAL FK graph.
//
// Prod incident 2026-07-18: every owner of an anchored vault got a 500 on
// account deletion — vault_devices.vault_id had a plain (NO ACTION) FK, so
// `DELETE FROM vaults WHERE owner_account_id = …` violated
// vault_devices_vault_id_fkey and rolled the whole tx back. Migration 031
// moved vault_devices into the vault cascade, made the audit-log principal
// FKs SET NULL, and DeleteAccount now also clears the account's device
// bindings in vaults it does not own.

func seedAccount(t *testing.T, pool *pgxpool.Pool, email string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO accounts (email, email_normalized, email_verified, name)
		VALUES ($1, $1, TRUE, $1) RETURNING id::text
	`, email).Scan(&id); err != nil {
		t.Fatalf("seed account %s: %v", email, err)
	}
	return id
}

func seedVault(t *testing.T, pool *pgxpool.Pool, ownerID string) string {
	t.Helper()
	ctx := context.Background()
	vaultID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vaultID, ownerID); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW(), $2::uuid)
	`, vaultID, ownerID); err != nil {
		t.Fatalf("seed owner membership: %v", err)
	}
	return vaultID
}

func seedDevice(t *testing.T, pool *pgxpool.Pool, vaultID, accountID string) {
	t.Helper()
	pub := make([]byte, 32)
	copy(pub, uuid.NewString())
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO vault_devices (vault_id, device_id, device_pubkey, account_id, added_at_ms)
		VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 1)
	`, vaultID, uuid.NewString(), pub, accountID); err != nil {
		t.Fatalf("seed device binding: %v", err)
	}
}

// The prod repro: an owner whose anchored vault has device bindings (their
// own + a member's) deletes their account. Pre-031 this 500'd on
// vault_devices_vault_id_fkey.
func TestDeleteAccount_OwnerWithDeviceBindings(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", "0123456789abcdef0123456789abcdef")

	owner := seedAccount(t, pool, "owner@gmail.com")
	member := seedAccount(t, pool, "member@gmail.com")
	vault := seedVault(t, pool, owner)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, vault, member, owner); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	seedDevice(t, pool, vault, owner)
	seedDevice(t, pool, vault, member)
	// Audit rows of the kind the invite/leave flows write.
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_audit_log (vault_id, actor_id, kind, target_id, payload)
		VALUES ($1::uuid, $2::uuid, 'invite_accepted', $3::uuid, '{"role":"editor"}'::jsonb)
	`, vault, owner, member); err != nil {
		t.Fatalf("seed audit row: %v", err)
	}

	if err := svc.DeleteAccount(ctx, owner); err != nil {
		t.Fatalf("DeleteAccount(owner) = %v, want success (the 2026-07-18 prod bug)", err)
	}

	var vaults, devices, accounts int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vaults WHERE vault_id = $1::uuid`, vault).Scan(&vaults); err != nil {
		t.Fatalf("count vaults: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_devices WHERE vault_id = $1::uuid`, vault).Scan(&devices); err != nil {
		t.Fatalf("count devices: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM accounts WHERE id = $1::uuid`, owner).Scan(&accounts); err != nil {
		t.Fatalf("count accounts: %v", err)
	}
	if vaults != 0 || devices != 0 || accounts != 0 {
		t.Errorf("after owner deletion: vaults=%d devices=%d accounts=%d, want all 0", vaults, devices, accounts)
	}
}

// The latent second blocker: a MEMBER of someone else's vault carries audit
// rows (invite_accepted / member_left target them) and device bindings there.
// Their account deletion must succeed, the owner's vault must survive
// untouched, and the audit history must survive with the principal NULLed.
func TestDeleteAccount_MemberOfForeignVault(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool, "test-client-id", "0123456789abcdef0123456789abcdef")

	owner := seedAccount(t, pool, "owner2@gmail.com")
	member := seedAccount(t, pool, "member2@gmail.com")
	vault := seedVault(t, pool, owner)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by)
		VALUES ($1::uuid, $2::uuid, 'editor', NOW(), NOW(), $3::uuid)
	`, vault, member, owner); err != nil {
		t.Fatalf("seed member: %v", err)
	}
	seedDevice(t, pool, vault, member)
	if _, err := pool.Exec(ctx, `
		INSERT INTO vault_audit_log (vault_id, actor_id, kind, target_id, payload)
		VALUES ($1::uuid, $2::uuid, 'member_left', $2::uuid, '{"role_at_leave":"editor"}'::jsonb)
	`, vault, member); err != nil {
		t.Fatalf("seed audit row: %v", err)
	}

	if err := svc.DeleteAccount(ctx, member); err != nil {
		t.Fatalf("DeleteAccount(member) = %v, want success (audit-log FK blocker)", err)
	}

	var vaults, memberDevices, auditRows, nulledAudit int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vaults WHERE vault_id = $1::uuid`, vault).Scan(&vaults); err != nil {
		t.Fatalf("count vaults: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_devices WHERE vault_id = $1::uuid`, vault).Scan(&memberDevices); err != nil {
		t.Fatalf("count devices: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_audit_log WHERE vault_id = $1::uuid`, vault).Scan(&auditRows); err != nil {
		t.Fatalf("count audit rows: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM vault_audit_log
		WHERE vault_id = $1::uuid AND actor_id IS NULL AND target_id IS NULL
	`, vault).Scan(&nulledAudit); err != nil {
		t.Fatalf("count nulled audit rows: %v", err)
	}
	if vaults != 1 {
		t.Errorf("owner's vault deleted by member's account deletion — must survive")
	}
	if memberDevices != 0 {
		t.Errorf("member's device bindings survived their account deletion: %d", memberDevices)
	}
	if auditRows != 1 || nulledAudit != 1 {
		t.Errorf("audit rows=%d nulled=%d, want 1/1 (history survives, principal anonymised)", auditRows, nulledAudit)
	}
}
