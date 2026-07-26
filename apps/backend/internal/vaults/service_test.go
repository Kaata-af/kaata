package vaults

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/matee/kaata-backend/internal/testutil"
)

// GET /v1/vaults now carries a members array (the display-name channel for
// mobile members screens — the signed membership chain deliberately carries
// no names). Covers: accounts.name primary, install self_name fallback for
// nameless accounts, and revoked members excluded.
func TestListAttachesMemberNames(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := context.Background()
	svc := NewService(pool)

	seedAccount := func(name string) string {
		var id string
		if err := pool.QueryRow(ctx, `
			INSERT INTO accounts (google_sub, email, email_verified, name)
			VALUES ($1, $2, TRUE, $3)
			RETURNING id::text
		`, "sub-"+uuid.NewString(), uuid.NewString()+"@gmail.com", name).Scan(&id); err != nil {
			t.Fatalf("seed account: %v", err)
		}
		return id
	}
	owner := seedAccount("Matee Saafi")
	editor := seedAccount("") // no provider name — must fall back to install self_name
	revoked := seedAccount("Gone Person")

	vaultID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO vaults (vault_id, owner_account_id, name, currency, vault_epoch)
		VALUES ($1::uuid, $2::uuid, 'Shop', 'AFN', 0)
	`, vaultID, owner); err != nil {
		t.Fatalf("seed vault: %v", err)
	}
	for _, m := range []struct {
		account, role string
		revoked       bool
	}{{owner, "owner", false}, {editor, "editor", false}, {revoked, "editor", true}} {
		revokedSQL := "NULL"
		if m.revoked {
			revokedSQL = "NOW()"
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO vault_members (vault_id, account_id, role, invited_at, accepted_at, invited_by, revoked_at)
			VALUES ($1::uuid, $2::uuid, $3, NOW(), NOW(), $4::uuid, `+revokedSQL+`)
		`, vaultID, m.account, m.role, owner); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	// Check-in-reported self identity for the nameless account.
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_id, self_name)
		VALUES ($1::uuid, $2::uuid, 'Ahmad Wali')
	`, uuid.NewString(), editor); err != nil {
		t.Fatalf("seed install: %v", err)
	}

	listings, err := svc.List(ctx, owner)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listings) != 1 {
		t.Fatalf("List returned %d vaults, want 1", len(listings))
	}
	got := map[string]VaultMember{}
	for _, m := range listings[0].Members {
		got[m.AccountID] = m
	}
	if len(got) != 2 {
		t.Fatalf("members = %v, want exactly owner+editor (revoked excluded)", listings[0].Members)
	}
	if m := got[owner]; m.Name != "Matee Saafi" || m.Role != "owner" {
		t.Fatalf("owner member = %+v, want name 'Matee Saafi' role 'owner'", m)
	}
	if m := got[editor]; m.Name != "Ahmad Wali" || m.Role != "editor" {
		t.Fatalf("editor member = %+v, want install-fallback name 'Ahmad Wali' role 'editor'", m)
	}
	if _, ok := got[revoked]; ok {
		t.Fatalf("revoked member leaked into members array")
	}
}
