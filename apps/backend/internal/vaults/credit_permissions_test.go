package vaults

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/auth"
	"github.com/matee/kaata-backend/internal/credit"
	"github.com/matee/kaata-backend/internal/testutil"
)

const creditPermissionTestSecret = "member-credit-permissions-test-secret"

type creditPermissionsFixture struct {
	pool         *pgxpool.Pool
	svc          *Service
	vault, owner string
	members      map[string]string
}

func newCreditPermissionsFixture(t *testing.T) *creditPermissionsFixture {
	t.Helper()
	f := &creditPermissionsFixture{pool: testutil.ConnectTestDB(t), vault: uuid.NewString(), members: make(map[string]string)}
	f.svc = NewService(f.pool)
	seed := func(role string) string {
		var account string
		if err := f.pool.QueryRow(t.Context(), `INSERT INTO accounts(google_sub,email,email_verified,name)
		 VALUES($1,$2,TRUE,'Member') RETURNING id::text`, uuid.NewString(), uuid.NewString()+"@shop.af").Scan(&account); err != nil {
			t.Fatal(err)
		}
		return account
	}
	f.owner = seed("owner")
	f.members["owner"] = f.owner
	if _, err := f.svc.Create(t.Context(), CreateInput{AccountID: f.owner, VaultID: f.vault, Name: "Shop", Currency: "AFN"}); err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"manager", "editor", "clerk", "viewer", "outsider", "pending", "revoked"} {
		id := seed(role)
		f.members[role] = id
		if role == "outsider" {
			continue
		}
		storedRole := role
		if role == "pending" || role == "revoked" {
			storedRole = "editor"
		}
		if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_by,accepted_at,revoked_at)
		 VALUES($1::uuid,$2::uuid,$3,$4::uuid,CASE WHEN $5 THEN NULL ELSE NOW() END,CASE WHEN $6 THEN NOW() ELSE NULL END)`, f.vault, id, storedRole, f.owner, role == "pending", role == "revoked"); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func creditPermissionsRouter(svc *Service) http.Handler {
	r := chi.NewRouter()
	r.Use(auth.RequireSession(creditPermissionTestSecret))
	h := NewHandler(svc)
	r.Get("/v1/vaults/{vault_id}/credit-permissions", h.MemberCreditPermissions)
	r.Put("/v1/vaults/{vault_id}/members/{account_id}/credit-permission", h.SetMemberCreditPermission)
	return r
}

func creditPermissionsRequest(t *testing.T, router http.Handler, method, path, account, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if account != "" {
		token, err := auth.SignSession(creditPermissionTestSecret, account, uuid.NewString(), "google", "credit-test")
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

// Input validation and the enrollment refusal must not reach a database.
func TestMemberCreditPermissionHandlerValidation(t *testing.T) {
	router := creditPermissionsRouter(NewService(nil))
	vault, account := uuid.NewString(), uuid.NewString()
	path := "/v1/vaults/" + vault + "/members/" + uuid.NewString() + "/credit-permission"
	for _, body := range []string{"", `{}`, `{"credit_limit_override":"admin"}`, `{"credit_limit_override":"enforce","role":"owner"}`, `{"credit_limit_override":"enforce"} {}`, `{"credit_limit_override":null}`} {
		if r := creditPermissionsRequest(t, router, "PUT", path, account, body); r.Code != 400 {
			t.Fatalf("body %q: %d %s", body, r.Code, r.Body.String())
		}
	}
	if r := creditPermissionsRequest(t, router, "PUT", path, "", `{"credit_limit_override":"enforce"}`); r.Code != 401 {
		t.Fatalf("anonymous %d", r.Code)
	}
	localPath := "/v1/vaults/" + vault + "/members/local:offline-device/credit-permission"
	if r := creditPermissionsRequest(t, router, "PUT", localPath, account, `{"credit_limit_override":"enforce"}`); r.Code != 409 || !strings.Contains(r.Body.String(), "member_cloud_enrollment_required") {
		t.Fatalf("unenrolled %d %s", r.Code, r.Body.String())
	}
}

func TestMemberCreditPermissionsAuthorityAndScope(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	router := creditPermissionsRouter(f.svc)
	getPath := "/v1/vaults/" + f.vault + "/credit-permissions"
	putPath := "/v1/vaults/" + f.vault + "/members/" + f.members["editor"] + "/credit-permission"
	for _, role := range []string{"owner", "manager", "editor", "clerk", "viewer", "outsider", "pending", "revoked"} {
		wantGet, wantPut := 200, 403
		if role == "owner" || role == "manager" {
			wantPut = 200
		}
		if role == "outsider" || role == "pending" || role == "revoked" {
			wantGet = 403
		}
		if r := creditPermissionsRequest(t, router, "GET", getPath, f.members[role], ""); r.Code != wantGet {
			t.Fatalf("%s GET %d %s", role, r.Code, r.Body.String())
		}
		if r := creditPermissionsRequest(t, router, "PUT", putPath, f.members[role], `{"credit_limit_override":"enforce"}`); r.Code != wantPut {
			t.Fatalf("%s PUT %d %s", role, r.Code, r.Body.String())
		}
	}
	for _, callerRole := range []string{"owner", "manager"} {
		for _, targetRole := range []string{"owner", "manager"} {
			_, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.members[callerRole], f.members[targetRole], "bypass")
			if !errors.Is(err, ErrCreditPermissionProtected) {
				t.Fatalf("%s changed %s: %v", callerRole, targetRole, err)
			}
		}
		for _, targetRole := range []string{"editor", "clerk", "viewer"} {
			for _, override := range []string{"enforce", "bypass", "inherit"} {
				p, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.members[callerRole], f.members[targetRole], override)
				if err != nil || p.CreditLimitOverride != override {
					t.Fatalf("%s %s %s: %+v %v", callerRole, targetRole, override, p, err)
				}
			}
		}
	}
	for _, target := range []string{"outsider", "pending", "revoked"} {
		if _, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, f.members[target], "bypass"); !errors.Is(err, ErrTargetNotMember) {
			t.Fatalf("invalid target %s: %v", target, err)
		}
	}
	if r := creditPermissionsRequest(t, router, "GET", getPath, f.owner, ""); r.Code != 200 {
		t.Fatal(r.Body.String())
	} else {
		var rows []MemberCreditPermission
		if err := json.Unmarshal(r.Body.Bytes(), &rows); err != nil || len(rows) != 5 {
			t.Fatalf("active rows %s err=%v", r.Body.String(), err)
		}
	}
	var audits int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM vault_audit_log WHERE kind='credit_permission_changed'`).Scan(&audits); err != nil || audits == 0 {
		t.Fatalf("missing audit count=%d err=%v", audits, err)
	}
	// Retained membership rows cannot keep access after account deletion starts.
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ListMemberCreditPermissions(t.Context(), f.vault, f.owner); !errors.Is(err, ErrNotMember) {
		t.Fatalf("pending caller read: %v", err)
	}
	if _, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, f.members["editor"], "enforce"); !errors.Is(err, ErrNotMember) {
		t.Fatalf("pending caller write: %v", err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL,disabled_at=NOW() WHERE id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.ListMemberCreditPermissions(t.Context(), f.vault, f.owner); !errors.Is(err, ErrNotMember) {
		t.Fatalf("disabled caller read: %v", err)
	}
	if _, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, f.members["editor"], "enforce"); !errors.Is(err, ErrNotMember) {
		t.Fatalf("disabled caller write: %v", err)
	}
}

func TestMemberCreditPermissionDoesNotSurviveReinvitation(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	editor := f.members["editor"]
	first, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, editor, "bypass")
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, editor, "bypass")
	if err != nil || again != first {
		t.Fatalf("idempotent save %+v %+v %v", first, again, err)
	}
	if _, err := f.svc.RevokeMember(t.Context(), RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: editor}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members(vault_id,account_id,role,invited_by,accepted_at)
	 VALUES($1::uuid,$2::uuid,'editor',$3::uuid,NOW())`, f.vault, editor, f.owner); err != nil {
		t.Fatal(err)
	}
	rows, err := f.svc.ListMemberCreditPermissions(t.Context(), f.vault, editor)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.AccountID == editor && (row.CreditLimitOverride != "inherit" || row.UpdatedAtMS != 0) {
			t.Fatalf("old seat exception leaked: %+v", row)
		}
	}
	if _, err := f.svc.SetMemberCreditPermission(t.Context(), f.vault, f.owner, editor, "enforce"); err != nil {
		t.Fatal(err)
	}
	var matches bool
	if err := f.pool.QueryRow(t.Context(), `SELECT p.vault_member_id=m.id FROM vault_member_credit_permissions p JOIN vault_members m
	 ON m.vault_id=p.vault_id AND m.account_id=p.account_id AND m.revoked_at IS NULL WHERE p.account_id=$1::uuid`, editor).Scan(&matches); err != nil || !matches {
		t.Fatalf("fresh seat binding=%v err=%v", matches, err)
	}
}

func TestMemberCreditPermissionRechecksTargetAfterAdmissionLock(t *testing.T) {
	f := newCreditPermissionsFixture(t)
	blocker, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if err := credit.Lock(t.Context(), blocker, f.vault); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := f.svc.SetMemberCreditPermission(ctx, f.vault, f.owner, f.members["editor"], "bypass")
		result <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
		 AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock(hashtextextended%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("permission save did not wait for admission")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The save must not have locked the vault before admission: promotion
	// completes while admission is held, then the save observes that role.
	if _, err := f.svc.SetMemberRole(ctx, f.vault, f.owner, f.members["editor"], "manager"); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrCreditPermissionProtected) {
		t.Fatalf("stale target role authorized: %v", err)
	}
	var count int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM vault_member_credit_permissions`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("stale save persisted: %d err=%v", count, err)
	}
}
