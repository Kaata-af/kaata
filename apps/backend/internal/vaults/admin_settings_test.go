package vaults

import (
	"errors"
	"testing"
)

// Daily configuration follows the same manager+ authority as the mobile
// permission table and vault_setting_set events. Ownership actions do not.
func TestAdminCanUpdateDailySettingsOnly(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	name, currency := "Managed shop", "USD"
	for _, role := range []string{"editor", "clerk", "viewer"} {
		if _, err := f.svc.Update(t.Context(), UpdateInput{
			AccountID: f.members[role], VaultID: f.vault, Name: &name, Currency: &currency,
		}); !errors.Is(err, ErrNotOwner) {
			t.Fatalf("%s settings update = %v, want owner/admin required", role, err)
		}
	}
	manager := f.members["manager"]
	if _, err := f.svc.Update(t.Context(), UpdateInput{
		AccountID: manager, VaultID: f.vault, Name: &name, Currency: &currency,
	}); err != nil {
		t.Fatalf("admin daily settings: %v", err)
	}
	var gotName, gotCurrency, gotOwner string
	if err := f.pool.QueryRow(t.Context(), `SELECT name,currency,owner_account_id::text FROM vaults WHERE vault_id=$1::uuid`, f.vault).
		Scan(&gotName, &gotCurrency, &gotOwner); err != nil {
		t.Fatal(err)
	}
	if gotName != name || gotCurrency != currency || gotOwner != f.owner {
		t.Fatalf("settings update = %q/%q owner=%s", gotName, gotCurrency, gotOwner)
	}
	if _, err := f.svc.Archive(t.Context(), f.vault, manager); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("admin archive = %v, want owner only", err)
	}
	if _, err := f.svc.TransferOwnership(t.Context(), TransferInput{
		VaultID: f.vault, AccountID: manager, ToAccountID: f.members["editor"], DemoteSelfTo: "editor",
	}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("admin transfer = %v, want owner only", err)
	}
	// Failed ownership actions leave the manager's accepted seat and live kaata.
	var unchanged bool
	if err := f.pool.QueryRow(t.Context(), `SELECT v.archived_at IS NULL AND m.role='manager'
	 FROM vaults v JOIN vault_members m ON m.vault_id=v.vault_id
	 WHERE v.vault_id=$1::uuid AND m.account_id=$2::uuid AND m.revoked_at IS NULL`, f.vault, manager).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("ownership protection changed daily access: %v err=%v", unchanged, err)
	}
}

func TestArchivedKaataDailySettingsRemainOwnerOnly(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	if _, err := f.svc.Archive(t.Context(), f.vault, f.owner); err != nil {
		t.Fatal(err)
	}
	name := "Archived kaata"
	if _, err := f.svc.Update(t.Context(), UpdateInput{
		AccountID: f.members["manager"], VaultID: f.vault, Name: &name,
	}); !errors.Is(err, ErrAlreadyArchived) {
		t.Fatalf("admin changed archived kaata: %v", err)
	}
	if _, err := f.svc.Update(t.Context(), UpdateInput{
		AccountID: f.owner, VaultID: f.vault, Name: &name,
	}); err != nil {
		t.Fatalf("owner cannot manage archived kaata: %v", err)
	}
}
