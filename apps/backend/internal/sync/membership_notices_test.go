package sync

import (
	"github.com/matee/kaata-backend/internal/vaults"
	"testing"
	"time"
)

func TestMembershipNoticesDeduplicateRESTAndSignedMirrors(t *testing.T) {
	f := newM2Fixture(t)
	guest := f.seedAccount(t, "notice-guest@example.test")
	books := vaults.NewService(f.pool)
	books.SetMembershipInvalidator(f.svc)
	ownerEvent := func(kind, role string) PushEvent {
		t.Helper()
		f.pms = max(f.pms, time.Now().UnixMilli())
		payload := map[string]any{"account_id": guest}
		if role != "" {
			payload["role"] = role
		}
		ev := f.membershipEvent(kind, f.anchorDeviceID, f.ownerAcct, guest, payload)
		f.signEvent(t, &ev, f.anchorPriv)
		return ev
	}
	count := func(kind string, want int) {
		t.Helper()
		var got int
		if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM account_connection_notifications WHERE event_kind=$1 AND recipient_account_id=$2::uuid`, kind, guest).Scan(&got); err != nil || got != want {
			t.Fatalf("%s notices=%d want%d: %v", kind, got, want, err)
		}
	}
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberAdded, "editor")), 1)
	if _, err := books.SetMemberRole(t.Context(), f.vaultID, f.ownerAcct, guest, "viewer"); err != nil {
		t.Fatal(err)
	}
	count("vault_member_role_changed", 1)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberRoleChng, "viewer")), 1)
	count("vault_member_role_changed", 1)
	change := ownerEvent(EventVaultMemberRoleChng, "clerk")
	requireAccepted(t, f.pushAs(t, f.ownerAcct, change), 1)
	f.pushAs(t, f.ownerAcct, change)
	count("vault_member_role_changed", 2)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberRoleChng, "viewer")), 1)
	requireAccepted(t, f.pushAs(t, f.ownerAcct, ownerEvent(EventVaultMemberRoleChng, "viewer")), 1)
	count("vault_member_role_changed", 3)
	remove := ownerEvent(EventVaultMemberRemoved, "")
	requireAccepted(t, f.pushAs(t, f.ownerAcct, remove), 1)
	f.pushAs(t, f.ownerAcct, remove)
	count("vault_member_removed", 1)
	var sources int
	if err := f.pool.QueryRow(t.Context(), `SELECT COUNT(DISTINCT source_id) FROM account_connection_notifications WHERE event_kind='vault_member_role_changed' AND recipient_account_id=$1::uuid`, guest).Scan(&sources); err != nil || sources != 3 {
		t.Fatalf("future role cycles reused source: %d %v", sources, err)
	}
}
