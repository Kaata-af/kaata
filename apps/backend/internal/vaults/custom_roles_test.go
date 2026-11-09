package vaults

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/rolepolicy"
)

func TestCustomRolesOwnerAndSeatScope(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	ctx := t.Context()
	editor, manager := f.members["editor"], f.members["manager"]
	router := chi.NewRouter()
	router.Use(auth.RequireSession(creditPermissionTestSecret))
	h := NewHandler(f.svc)
	router.Get("/v1/vaults/{vault_id}/custom-roles", h.CustomRoles)
	router.Post("/v1/vaults/{vault_id}/custom-roles", h.SaveCustomRole)
	router.Put("/v1/vaults/{vault_id}/members/{account_id}/custom-role", h.AssignCustomRole)
	basePath := "/v1/vaults/" + f.vault
	path := basePath + "/custom-roles"
	definition := `{"name":"  Counter staff  ","base_role":"editor","permissions":["person.edit"]}`
	request := func(method, path, account, body string, want int) []byte {
		t.Helper()
		r := creditPermissionsRequest(t, router, method, path, account, body)
		if r.Code != want {
			t.Fatalf("%s %s as %s: %d, want %d: %s", method, path, account, r.Code, want, r.Body)
		}
		return r.Body.Bytes()
	}
	request("POST", path, manager, definition, http.StatusForbidden)
	request("POST", path, f.owner, `{"name":"Privilege escalation","base_role":"clerk","permissions":["entry.delete"]}`, http.StatusBadRequest)
	var role CustomRole
	if err := json.Unmarshal(request("POST", path, f.owner, definition, http.StatusCreated), &role); err != nil || role.Name != "Counter staff" || role.ID == "" {
		t.Fatalf("saved role = %+v, %v", role, err)
	}
	request("POST", path, f.owner, `{"name":"COUNTER STAFF","base_role":"editor","permissions":[]}`, http.StatusConflict)
	assign := `{"role_id":"` + role.ID + `"}`
	request("PUT", basePath+"/members/"+editor+"/custom-role", manager, assign, http.StatusForbidden)
	request("PUT", basePath+"/members/"+editor+"/custom-role", f.owner, assign, http.StatusNoContent)
	if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, f.members["clerk"], &role.ID); !errors.Is(err, errCustomRoleBaseMismatch) {
		t.Fatalf("assigned role with mismatched preset: %v", err)
	}
	if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, f.members["pending"], &role.ID); !errors.Is(err, ErrTargetNotMember) {
		t.Fatalf("assigned a pending seat: %v", err)
	}
	request("GET", path, f.members["outsider"], "", http.StatusForbidden)
	var memberView CustomRoles
	if err := json.Unmarshal(request("GET", path, editor, "", http.StatusOK), &memberView); err != nil || memberView.EffectiveRole == nil ||
		memberView.EffectiveRole.ID != role.ID || len(memberView.Roles) != 0 || len(memberView.Assignments) != 0 {
		t.Fatalf("member view discloses other roles or misses effective role: %+v %v", memberView, err)
	}
	if err := f.svc.DeleteCustomRole(ctx, f.vault, f.owner, role.ID); !errors.Is(err, errCustomRoleInUse) {
		t.Fatalf("assigned template was deletable: %v", err)
	}
	if _, err := f.svc.SetMemberRole(ctx, f.vault, manager, editor, "clerk"); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager cleared another member's assignment: %v", err)
	}
	if _, err := f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: manager, TargetID: editor}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("manager removed a seat with owner-assigned restrictions: %v", err)
	}
	managerRole, err := f.svc.SaveCustomRole(ctx, f.vault, f.owner, CustomRole{
		Name: "Ledger admin", BaseRole: "manager", Permissions: []string{rolepolicy.EntryCreate},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, manager, &managerRole.ID); err != nil {
		t.Fatal(err)
	}
	name := "Blocked rename"
	if _, err := f.svc.Update(ctx, UpdateInput{AccountID: manager, VaultID: f.vault, Name: &name}); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("restricted manager changed settings: %v", err)
	}
	if _, err := f.svc.SetMemberRole(ctx, f.vault, manager, f.members["viewer"], "clerk"); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("restricted manager changed an unassigned member: %v", err)
	}
	otherVault := uuid.NewString()
	if _, err := f.svc.Create(ctx, CreateInput{AccountID: f.owner, VaultID: otherVault, Name: "Another shop", Currency: "AFN"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'editor',NOW())`, otherVault, editor); err != nil {
		t.Fatal(err)
	}
	if err := f.svc.AssignCustomRole(ctx, otherVault, f.owner, editor, &role.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("assignment crossed Kaata scope: %v", err)
	}
	for _, preset := range []string{"clerk", "editor"} {
		if _, err := f.svc.SetMemberRole(ctx, f.vault, f.owner, editor, preset); err != nil {
			t.Fatal(err)
		}
	}
	if view, err := f.svc.ListCustomRoles(ctx, f.vault, editor); err != nil || view.EffectiveRole != nil {
		t.Fatalf("old custom role survived preset changes: %+v %v", view, err)
	}
	if err := f.svc.AssignCustomRole(ctx, f.vault, f.owner, editor, &role.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.RevokeMember(ctx, RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: editor}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `UPDATE vault_members SET revoked_at=NULL WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, editor); err != nil {
		t.Fatal(err)
	}
	if view, err := f.svc.ListCustomRoles(ctx, f.vault, editor); err != nil || view.EffectiveRole != nil {
		t.Fatalf("old custom role survived revocation and reactivation: %+v %v", view, err)
	}
	if err := f.svc.DeleteCustomRole(ctx, f.vault, f.owner, role.ID); err != nil {
		t.Fatal(err)
	}
}
