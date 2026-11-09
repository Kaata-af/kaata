package sync

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

func TestCustomRolesRestrictFreshLedgerAndManagerEvents(t *testing.T) {
	f, manager, managerKey := newManagerFixture(t)
	ctx := t.Context()
	device := uuid.NewString()
	newTally := func(actor string) PushEvent {
		entryID, relationshipID := uuid.NewString(), uuid.NewString()
		event := f.membershipEvent(EventEntryCreated, device, actor, entryID, map[string]any{
			"entry_id": entryID, "relationship_id": relationshipID, "type": "debt", "amount_afn": 42,
		})
		event.RelationshipID = &relationshipID
		return event
	}
	stored, offline := newTally(manager), newTally(manager)
	requireAccepted(t, f.pushAs(t, manager, stored), 1)
	staff := f.seedAccount(t, "custom-role-staff@example.test")
	admitted := f.membershipEvent(EventVaultMemberAdded, device, manager, staff, map[string]any{"account_id": staff, "role": "clerk"})
	f.signEvent(t, &admitted, managerKey)
	requireAccepted(t, f.pushAs(t, manager, admitted), 1)
	roleID := uuid.NewString()
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_custom_roles(id,vault_id,name,base_role,permissions)
	 VALUES($1::uuid,$2::uuid,'Contact admin','manager',$3)`, roleID, f.vaultID, []string{rolepolicy.PersonEdit}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET custom_role_id=$3::uuid
	 WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vaultID, manager, roleID); err != nil {
		t.Fatal(err)
	}
	for _, event := range []PushEvent{offline, newTally(f.ownerAcct), newTally("")} {
		res := f.pushAs(t, manager, event)
		if len(res.Accepted) != 0 || len(res.Duplicates) != 0 || len(res.Rejected) != 1 {
			t.Fatalf("fresh tally bypassed current policy: %+v", res)
		}
	}
	for _, event := range []PushEvent{stored, admitted} {
		res := f.pushAs(t, manager, event)
		if len(res.Duplicates) != 1 || res.Duplicates[0] != event.EventID || len(res.Rejected) != 0 {
			t.Fatalf("previously stored event lost acknowledgement: %+v", res)
		}
	}
	promote := f.membershipEvent(EventVaultMemberRoleChng, device, manager, staff, map[string]any{"account_id": staff, "role": "editor"})
	f.signEvent(t, &promote, managerKey)
	requireRejectedUnverified(t, f.pushAs(t, manager, promote), promote.EventID)
	if role := f.memberRow(t, staff); role != "clerk" {
		t.Fatalf("restricted manager changed the target role to %q", role)
	}
	h := NewHandler(f.svc)
	token, err := auth.SignSession(testJWTSecret, manager, device, "google", "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []struct {
		name   string
		method string
		serve  http.HandlerFunc
	}{{"credit limits", "PUT", h.CreditLimits}, {"credit alerts", "PUT", h.CreditAlerts},
		{"credit alerts", "DELETE", h.CreditAlerts}, {"limit notifications", "PUT", h.CreditLimitNotifications},
		{"limit notifications", "DELETE", h.CreditLimitNotifications}} {
		t.Run(route.method+" "+route.name, func(t *testing.T) {
			req := httptest.NewRequest(route.method, "/?vault_id="+f.vaultID, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-Kaata-Currencies", "1")
			recorder := httptest.NewRecorder()
			auth.RequireSession(testJWTSecret)(route.serve).ServeHTTP(recorder, req)
			if recorder.Code != http.StatusForbidden {
				t.Fatalf("credit configuration bypassed settings policy: %d %s", recorder.Code, recorder.Body)
			}
		})
	}
	contact := uuid.NewString()
	edit := f.membershipEvent(EventPersonRenamed, device, manager, contact, map[string]any{"display_name": "Updated contact"})
	requireAccepted(t, f.pushAs(t, manager, edit), 1)
	leave := f.membershipEvent(EventVaultMemberRemoved, device, manager, manager, map[string]any{"account_id": manager})
	f.signEvent(t, &leave, managerKey)
	requireAccepted(t, f.pushAs(t, manager, leave), 1)
	if role := f.memberRow(t, manager); role != "" {
		t.Fatalf("restricted manager could not leave their Kaata: %q", role)
	}
}
