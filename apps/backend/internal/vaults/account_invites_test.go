package vaults

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/matee/kaata-backend/internal/auth"
)

func accountInviteCreate(t *testing.T, f *graceVaultFixture, sender, recipient, role string) AccountInviteResult {
	t.Helper()
	result, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: sender, TargetAccountID: recipient, Role: role})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func accountInviteExec(t *testing.T, f *graceVaultFixture, sql string, args ...any) {
	t.Helper()
	if _, err := f.pool.Exec(t.Context(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func accountInviteSeed(t *testing.T, f *graceVaultFixture) string {
	t.Helper()
	id := uuid.NewString()
	accountInviteExec(t, f, `INSERT INTO accounts(id,google_sub,email,name) VALUES($1::uuid,$1,$2,'New person')`, id, id+"@test.af")
	return id
}

func TestAccountInviteSelector(t *testing.T) {
	id := uuid.NewString()
	for _, invalid := range []string{"", id, "v_" + uuid.Nil.String(), "v_" + strings.ToUpper(id), "v_" + strings.ReplaceAll(id, "-", ""), "v_" + id + " ", "v_" + strings.Repeat("a", 41)} {
		if _, ok := accountInviteSelector(invalid); ok {
			t.Fatalf("accepted malformed selector %q", invalid)
		}
	}
	if got, ok := accountInviteSelector("v_" + id); !ok || got != id {
		t.Fatal("canonical selector rejected")
	}
}

func TestAccountInviteRecipientLifecycle(t *testing.T) {
	f := newGraceVaultFixture(t)
	r := accountInviteCreate(t, f, f.owner, f.joiner, "clerk")
	if r.Delivery != "in_app" || r.InviteToken != "v_"+r.InviteID {
		t.Fatalf("bad result: %+v", r)
	}
	retry := accountInviteCreate(t, f, f.owner, f.joiner, "clerk")
	if retry.InviteID != r.InviteID || !retry.ExpiresAt.Equal(r.ExpiresAt) {
		t.Fatalf("retry changed request: %+v / %+v", r, retry)
	}
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"}); !errors.Is(err, ErrInviteRoleConflict) {
		t.Fatalf("role conflict: %v", err)
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND account_id IS NULL AND invite_token_hash IS NULL AND invite_email IS NULL`, r.InviteID) != 1 {
		t.Fatal("pending request has access or a bearer secret")
	}
	if books, err := f.svc.List(t.Context(), f.joiner); err != nil || len(books) != 0 {
		t.Fatalf("unaccepted recipient has books: %+v %v", books, err)
	}
	pending, err := f.svc.ListPendingInvites(t.Context(), f.joiner)
	if err != nil || len(pending) != 1 || pending[0].InviteToken != r.InviteToken || pending[0].InviterEmail != "" || pending[0].InviterName == "" {
		t.Fatalf("private inbox: %+v %v", pending, err)
	}
	preview, err := f.svc.AccountInviteInfo(t.Context(), f.joiner, r.InviteID)
	if err != nil || preview.VaultName != "Shop" || preview.Role != "clerk" || !strings.Contains(preview.InviterEmailRedacted, "***") {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	audits := graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`)
	for i := 0; i < 6; i++ {
		if _, err := f.svc.AccountInviteInfo(t.Context(), f.editor, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
			t.Fatalf("foreign preview: %v", err)
		}
		if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.editor}); !errors.Is(err, ErrInviteNotFound) {
			t.Fatalf("forwarded selector accepted: %v", err)
		}
		if err := f.svc.DeclineAccountInvite(t.Context(), f.editor, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
			t.Fatalf("foreign decline: %v", err)
		}
	}
	if _, err := f.svc.InviteInfo(t.Context(), r.InviteToken); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("public selector preview leaked: %v", err)
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`) != audits || graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND invite_attempts=0 AND revoked_at IS NULL`, r.InviteID) != 1 {
		t.Fatal("foreign operations mutated request or audit")
	}
	accountInviteExec(t, f, `UPDATE accounts SET discovery_enabled=FALSE WHERE id=$1::uuid`, f.joiner)
	accountInviteCreate(t, f, f.owner, f.joiner, "clerk") // stable lost-create retry after opt-out
	joined, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner, InstallID: uuid.NewString()})
	if err != nil || joined.Role != "clerk" || joined.VaultID != f.vault {
		t.Fatalf("recipient accept after opt-out: %+v %v", joined, err)
	}
	if _, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.joiner, "viewer"); err != nil {
		t.Fatal(err)
	}
	accountInviteExec(t, f, `UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 day' WHERE invite_request_id=$1::uuid`, r.InviteID)
	joined, err = f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner})
	if err != nil || joined.Role != "viewer" {
		t.Fatalf("retry must return current role after expiry: %+v %v", joined, err)
	}
	if err := f.svc.DeclineAccountInvite(t.Context(), f.joiner, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("decline removed accepted membership: %v", err)
	}
	if _, err := f.svc.RevokeMember(t.Context(), RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.joiner}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("retry resurrected removed membership: %v", err)
	}
}

func TestAccountInviteEligibilityAndRoleBoundaries(t *testing.T) {
	f := newGraceVaultFixture(t)
	create := func(sender, recipient, role string) error {
		_, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: sender, TargetAccountID: recipient, Role: role})
		return err
	}
	for _, invalid := range []string{"", "not-a-uuid", uuid.Nil.String()} {
		if err := create(f.owner, invalid, "viewer"); !errors.Is(err, ErrInvalidInviteAccount) {
			t.Fatalf("invalid recipient: %v", err)
		}
	}
	if err := create(f.owner, f.owner, "viewer"); !errors.Is(err, ErrInviteSelf) {
		t.Fatalf("self: %v", err)
	}
	if err := create(f.owner, f.editor, "viewer"); !errors.Is(err, ErrInviteAlreadyMember) {
		t.Fatalf("existing member: %v", err)
	}
	for _, role := range []string{"owner", "manager", "admin", ""} {
		if err := create(f.owner, f.joiner, role); !errors.Is(err, ErrInvalidRole) {
			t.Fatalf("grant %q: %v", role, err)
		}
	}
	if err := create(f.editor, f.joiner, "viewer"); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("editor invited: %v", err)
	}
	if err := create(f.owner, uuid.NewString(), "viewer"); !errors.Is(err, ErrInviteRecipientUnavailable) {
		t.Fatalf("unknown: %v", err)
	}
	for _, change := range []string{"discovery_enabled=FALSE", "disabled_at=NOW()", "pending_delete_at=NOW()"} {
		accountInviteExec(t, f, `UPDATE accounts SET `+change+` WHERE id=$1::uuid`, f.joiner)
		if err := create(f.owner, f.joiner, "viewer"); !errors.Is(err, ErrInviteRecipientUnavailable) {
			t.Fatalf("unavailable %s: %v", change, err)
		}
		accountInviteExec(t, f, `UPDATE accounts SET discovery_enabled=TRUE,disabled_at=NULL,pending_delete_at=NULL WHERE id=$1::uuid`, f.joiner)
	}
	accountInviteExec(t, f, `UPDATE vault_members SET revoked_at=NOW() WHERE account_id=$1::uuid AND vault_id=$2::uuid`, f.editor, f.vault)
	if err := create(f.owner, f.editor, "viewer"); !errors.Is(err, ErrMemberReadmissionRequired) {
		t.Fatalf("removed member: %v", err)
	}
	accountInviteExec(t, f, `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, f.owner)
	if err := create(f.owner, f.joiner, "viewer"); !errors.Is(err, ErrNotMember) {
		t.Fatalf("disabled sender: %v", err)
	}
}

func TestAccountInviteRechecksInviterAuthority(t *testing.T) {
	f := newGraceVaultFixture(t)
	if _, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.editor, "manager"); err != nil {
		t.Fatal(err)
	}
	r := accountInviteCreate(t, f, f.editor, f.joiner, "editor")
	if _, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.editor, "editor"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AccountInviteInfo(t.Context(), f.joiner, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("demoted preview: %v", err)
	}
	if pending, err := f.svc.ListPendingInvites(t.Context(), f.joiner); err != nil || len(pending) != 0 {
		t.Fatalf("demoted inbox: %+v %v", pending, err)
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("demoted accept: %v", err)
	}
	replacement := accountInviteCreate(t, f, f.owner, f.joiner, "clerk")
	if replacement.InviteID == r.InviteID {
		t.Fatal("replacement reused invalid grant")
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("stale grant: %v", err)
	}
	if err := f.svc.DeclineAccountInvite(t.Context(), f.joiner, replacement.InviteID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: replacement.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("declined accept: %v", err)
	}
	if _, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.editor, "manager"); err != nil {
		t.Fatal(err)
	}
	r = accountInviteCreate(t, f, f.editor, f.joiner, "viewer")
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); err != nil {
		t.Fatal(err)
	}
	accountInviteExec(t, f, `UPDATE accounts SET disabled_at=NOW() WHERE id=$1::uuid`, f.editor)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); err != nil {
		t.Fatalf("completed retry depends on former inviter: %v", err)
	}
}

func TestAccountInviteExpiryDeletionAndSchemaBinding(t *testing.T) {
	f := newGraceVaultFixture(t)
	r := accountInviteCreate(t, f, f.owner, f.joiner, "viewer")
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET invite_email='anyone@test.af' WHERE invite_request_id=$1::uuid`, r.InviteID); err == nil {
		t.Fatal("targeted row became email invite")
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET account_id=$2::uuid WHERE invite_request_id=$1::uuid`, r.InviteID, f.editor); err == nil {
		t.Fatal("targeted row bound a foreign account")
	}
	accountInviteExec(t, f, `UPDATE vault_members SET invite_expires_at=NOW()-INTERVAL '1 day' WHERE invite_request_id=$1::uuid`, r.InviteID)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("expired accept: %v", err)
	}
	next := accountInviteCreate(t, f, f.owner, f.joiner, "editor")
	if next.InviteID == r.InviteID {
		t.Fatal("expired request reused")
	}
	accountInviteExec(t, f, `DELETE FROM accounts WHERE id=$1::uuid`, f.joiner)
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid`, next.InviteID) != 0 {
		t.Fatal("deleted target left a wildcard invitation")
	}
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: next.InviteToken, AccountID: f.editor}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("deleted target accepted by other: %v", err)
	}
}

func TestAccountInvitePendingStateChanges(t *testing.T) {
	f := newGraceVaultFixture(t)
	r := accountInviteCreate(t, f, f.owner, f.joiner, "editor")
	for _, check := range []struct {
		name, change, undo string
		account            string
	}{
		{"recipient disabled", "disabled_at=NOW()", "disabled_at=NULL", f.joiner},
		{"recipient deletion", "pending_delete_at=NOW()", "pending_delete_at=NULL", f.joiner},
		{"inviter disabled", "disabled_at=NOW()", "disabled_at=NULL", f.owner},
		{"inviter deletion", "pending_delete_at=NOW()", "pending_delete_at=NULL", f.owner},
	} {
		t.Run(check.name, func(t *testing.T) {
			accountInviteExec(t, f, `UPDATE accounts SET `+check.change+` WHERE id=$1::uuid`, check.account)
			if _, err := f.svc.AccountInviteInfo(t.Context(), f.joiner, r.InviteID); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("preview: %v", err)
			}
			if rows, err := f.svc.ListPendingInvites(t.Context(), f.joiner); err != nil || len(rows) != 0 {
				t.Fatalf("inbox: %+v %v", rows, err)
			}
			if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
				t.Fatalf("accept: %v", err)
			}
			accountInviteExec(t, f, `UPDATE accounts SET `+check.undo+` WHERE id=$1::uuid`, check.account)
		})
	}
	accountInviteExec(t, f, `UPDATE vaults SET archived_at=NOW() WHERE vault_id=$1::uuid`, f.vault)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrInviteNotFound) {
		t.Fatalf("archived accept: %v", err)
	}
	if rows, err := f.svc.ListPendingInvites(t.Context(), f.joiner); err != nil || len(rows) != 0 {
		t.Fatalf("archived inbox: %+v %v", rows, err)
	}
	accountInviteExec(t, f, `UPDATE vaults SET archived_at=NULL WHERE vault_id=$1::uuid`, f.vault)
	// Joining through another legitimate invitation must not let this pending
	// invitation change that active member's current role.
	accountInviteExec(t, f, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'viewer',NOW())`, f.vault, f.joiner)
	if result, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); err != nil || result.Role != "viewer" {
		t.Fatalf("existing role changed: %+v %v", result, err)
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND accepted_at IS NULL AND invite_attempts=0`, r.InviteID) != 1 {
		t.Fatal("unneeded invitation consumed")
	}
	accountInviteExec(t, f, `UPDATE vault_members SET revoked_at=NOW() WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.joiner)
	if _, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: r.InviteToken, AccountID: f.joiner}); !errors.Is(err, ErrMemberReadmissionRequired) {
		t.Fatalf("removed member admitted: %v", err)
	}
}

func TestAccountInviteConcurrentCreateAndAcceptDecline(t *testing.T) {
	f := newGraceVaultFixture(t)
	const workers = 8
	var wg sync.WaitGroup
	results, errs := make(chan AccountInviteResult, workers), make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"})
			results <- r
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var selected AccountInviteResult
	for r := range results {
		if selected.InviteID != "" && selected.InviteID != r.InviteID {
			t.Fatal("concurrent creation duplicated request")
		}
		selected = r
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_account_id=$1::uuid`, f.joiner) != 1 {
		t.Fatal("duplicate pending rows")
	}
	acceptDone, declineDone := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: selected.InviteToken, AccountID: f.joiner})
		acceptDone <- err
	}()
	go func() { declineDone <- f.svc.DeclineAccountInvite(t.Context(), f.joiner, selected.InviteID) }()
	accepted, declined := <-acceptDone, <-declineDone
	if !((accepted == nil && errors.Is(declined, ErrInviteNotFound)) || (declined == nil && errors.Is(accepted, ErrInviteNotFound))) {
		t.Fatalf("accept/decline race: %v / %v", accepted, declined)
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_request_id=$1::uuid AND ((accepted_at IS NOT NULL AND revoked_at IS NULL) OR (accepted_at IS NULL AND revoked_reason='declined'))`, selected.InviteID) != 1 {
		t.Fatal("inconsistent race outcome")
	}
}

func TestAccountInviteRecipientDeletionLockPrecedesVault(t *testing.T) {
	f := newGraceVaultFixture(t)
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.joiner); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"})
		done <- err
	}()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := f.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM accounts WHERE id=ANY%' AND query LIKE '%FOR UPDATE%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("create did not wait on recipient lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := tx.Exec(t.Context(), `SELECT 1 FROM vaults WHERE vault_id=$1::uuid FOR UPDATE NOWAIT`, f.vault); err != nil {
		t.Fatalf("create locked vault before accounts: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, ErrInviteRecipientUnavailable) {
		t.Fatalf("pending-deletion race: %v", err)
	}
}

func TestAccountInvitePendingCaps(t *testing.T) {
	f := newGraceVaultFixture(t)
	for i := 0; i < maxPendingAccountInvites; i++ {
		accountInviteCreate(t, f, f.owner, accountInviteSeed(t, f), "viewer")
	}
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"}); !errors.Is(err, ErrTooManyPendingInvites) {
		t.Fatalf("vault cap: %v", err)
	}
	accountInviteExec(t, f, `UPDATE vault_members SET revoked_at=NOW() WHERE invite_request_id IS NOT NULL`)
	for i := 0; i < maxAccountInviteInbox; i++ {
		book := uuid.NewString()
		accountInviteExec(t, f, `INSERT INTO vaults(vault_id,owner_account_id,name,currency) VALUES($1::uuid,$2::uuid,'Other','AFN')`, book, f.owner)
		accountInviteExec(t, f, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at) VALUES($1::uuid,$2::uuid,'owner',NOW())`, book, f.owner)
		accountInviteExec(t, f, `INSERT INTO vault_members(vault_id,role,invited_by,invite_account_id,invite_request_id,invite_expires_at) VALUES($1::uuid,'viewer',$2::uuid,$3::uuid,$4::uuid,NOW()+INTERVAL '7 days')`, book, f.owner, f.joiner, uuid.NewString())
	}
	if _, err := f.svc.CreateAccountInvite(t.Context(), CreateAccountInviteInput{VaultID: f.vault, InviterAccID: f.owner, TargetAccountID: f.joiner, Role: "viewer"}); !errors.Is(err, ErrTooManyPendingInvites) {
		t.Fatalf("recipient cap: %v", err)
	}
	if pending, err := f.svc.ListPendingInvites(t.Context(), f.joiner); err != nil || len(pending) != maxAccountInviteInbox {
		t.Fatalf("bounded inbox: %d %v", len(pending), err)
	}
}

func accountInvitesRouter(svc *Service) http.Handler {
	r := chi.NewRouter()
	h := NewHandler(svc)
	r.Get("/v1/vaults/invites/{token}/info", h.InviteInfo)
	r.Group(func(p chi.Router) {
		p.Use(auth.RequireSession(creditPermissionTestSecret))
		p.Post("/v1/vaults/{vault_id}/account-invites", h.CreateAccountInvite)
		p.Post("/v1/vaults/invites/accept", h.AcceptInvite)
		p.Get("/v1/vaults/invites/pending", h.PendingInvites)
		p.Get("/v1/vaults/invites/requests/{invite_id}", h.AccountInviteInfo)
		p.Delete("/v1/vaults/invites/requests/{invite_id}", h.DeclineAccountInvite)
	})
	return r
}

func TestAccountInviteHandlerValidation(t *testing.T) {
	router := accountInvitesRouter(NewService(nil))
	actor, book, target := uuid.NewString(), uuid.NewString(), uuid.NewString()
	path := "/v1/vaults/" + book + "/account-invites"
	for _, body := range []string{"", `null`, `{}`, `{"role":"viewer"}`, `{"target_account_id":null,"role":"viewer"}`, `{"target_account_id":"","role":"viewer"}`, `{"target_account_id":"bad","role":"viewer"}`, `{"target_account_id":"` + target + `","role":"viewer","email":"target@test.af"}`, `{"target_account_id":"` + target + `","role":"viewer"} {}`} {
		if w := creditPermissionsRequest(t, router, "POST", path, actor, body); w.Code != 400 {
			t.Fatalf("body %s: %d %s", body, w.Code, w.Body.String())
		}
	}
	for _, method := range []string{"GET", "DELETE"} {
		if w := creditPermissionsRequest(t, router, method, "/v1/vaults/invites/requests/"+target, "", ""); w.Code != 401 {
			t.Fatalf("anonymous %s: %d", method, w.Code)
		}
		if w := creditPermissionsRequest(t, router, method, "/v1/vaults/invites/requests/not-an-id", actor, ""); w.Code != 404 {
			t.Fatalf("bad ID %s: %d", method, w.Code)
		}
	}
	if w := creditPermissionsRequest(t, router, "POST", "/v1/vaults/invites/accept", actor, `{"token":"v_`+target+`","install_id":"`+uuid.NewString()+`"}`); w.Code != 400 {
		t.Fatalf("foreign installation: %d", w.Code)
	}
}

func TestAccountInviteHTTPContract(t *testing.T) {
	f := newGraceVaultFixture(t)
	router := accountInvitesRouter(f.svc)
	// An older client may already hold an email invitation for this same
	// vault under a different role. Default pending replies must stay exactly
	// unchanged after a direct request is created, including inviter metadata.
	var targetEmail string
	if err := f.pool.QueryRow(t.Context(), `SELECT email FROM accounts WHERE id=$1::uuid`, f.joiner).Scan(&targetEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.CreateInvite(t.Context(), CreateInviteInput{VaultID: f.vault, InviterAccID: f.owner, Email: targetEmail, Role: "clerk"}); err != nil {
		t.Fatal(err)
	}
	legacy := creditPermissionsRequest(t, router, "GET", "/v1/vaults/invites/pending", f.joiner, "")
	if legacy.Code != 200 || !strings.Contains(legacy.Body.String(), `"role":"clerk"`) || strings.Contains(legacy.Body.String(), `"inviter_email":""`) {
		t.Fatalf("legacy fixture: %d %s", legacy.Code, legacy.Body.String())
	}
	w := creditPermissionsRequest(t, router, "POST", "/v1/vaults/"+f.vault+"/account-invites", f.owner, `{"target_account_id":"`+f.joiner+`","role":"viewer"}`)
	var r AccountInviteResult
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &r) != nil || r.InviteID == "" {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	previewPath := "/v1/vaults/invites/requests/" + r.InviteID
	for _, actor := range []string{f.owner, f.editor} {
		if w := creditPermissionsRequest(t, router, "GET", previewPath, actor, ""); w.Code != 404 {
			t.Fatalf("wrong account: %d %s", w.Code, w.Body.String())
		}
	}
	if w := creditPermissionsRequest(t, router, "GET", previewPath, f.joiner, ""); w.Code != 200 || strings.Contains(w.Body.String(), `"inviter_email":`) {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	}
	if w := creditPermissionsRequest(t, router, "GET", previewPath, f.joiner, ""); w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private preview may be cached")
	}
	if w := creditPermissionsRequest(t, router, "GET", "/v1/vaults/invites/"+r.InviteToken+"/info", "", ""); w.Code != 404 {
		t.Fatalf("public preview: %d", w.Code)
	}
	for _, suffix := range []string{"", "?include_account_invites=0", "?include_account_invites=true"} {
		if w := creditPermissionsRequest(t, router, "GET", "/v1/vaults/invites/pending"+suffix, f.joiner, ""); w.Code != 200 || w.Body.String() != legacy.Body.String() {
			t.Fatalf("legacy pending changed %q: %d %s", suffix, w.Code, w.Body.String())
		}
	}
	if w := creditPermissionsRequest(t, router, "GET", "/v1/vaults/invites/pending?include_account_invites=1", f.joiner, ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"invite_token":"`+r.InviteToken+`"`) || !strings.Contains(w.Body.String(), `"inviter_email":""`) || !strings.Contains(w.Body.String(), `"role":"clerk"`) || !strings.Contains(w.Body.String(), `"role":"viewer"`) {
		t.Fatalf("pending: %d %s", w.Code, w.Body.String())
	}
	if w := creditPermissionsRequest(t, router, "DELETE", previewPath, f.joiner, ""); w.Code != 204 {
		t.Fatalf("decline: %d %s", w.Code, w.Body.String())
	}
	if w := creditPermissionsRequest(t, router, "DELETE", previewPath, f.joiner, ""); w.Code != 404 {
		t.Fatalf("decline retry: %d", w.Code)
	}
}
