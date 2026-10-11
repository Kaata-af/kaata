package vaults

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matee/kaata-backend/internal/testutil"
)

type graceVaultFixture struct {
	pool                  *pgxpool.Pool
	svc                   *Service
	owner, editor, joiner string
	vault, token          string
}

func newGraceVaultFixture(t *testing.T) *graceVaultFixture {
	t.Helper()
	f := &graceVaultFixture{pool: testutil.ConnectTestDB(t), vault: uuid.NewString()}
	f.svc = NewService(f.pool)
	seed := func() string {
		var id string
		if err := f.pool.QueryRow(t.Context(), `INSERT INTO accounts
		 (google_sub,email,email_verified,name) VALUES ($1,$2,TRUE,'Grace fixture')
		 RETURNING id::text`, uuid.NewString(), uuid.NewString()+"@shop.af").Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	f.owner, f.editor, f.joiner = seed(), seed(), seed()
	if _, err := f.svc.Create(t.Context(), CreateInput{AccountID: f.owner, VaultID: f.vault, Name: "Shop", Currency: "AFN"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO vault_members
	 (vault_id,account_id,role,invited_at,accepted_at,invited_by)
	 VALUES ($1::uuid,$2::uuid,'editor',NOW(),NOW(),$3::uuid)`, f.vault, f.editor, f.owner); err != nil {
		t.Fatal(err)
	}
	invite, err := f.svc.CreateInvite(t.Context(), CreateInviteInput{VaultID: f.vault, InviterAccID: f.owner, Role: "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	f.token = strings.TrimPrefix(invite.InviteURL, "https://kaata.af/i/")
	return f
}

func graceVaultCount(t *testing.T, f *graceVaultFixture, sql string, args ...any) int {
	t.Helper()
	var count int
	if err := f.pool.QueryRow(t.Context(), sql, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// Auth middleware can admit a request immediately before deletion commits.
// Retained membership rows must not let such a request mutate during the grace.
func TestAccountDeletionGraceBlocksEveryVaultMutation(t *testing.T) {
	f := newGraceVaultFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW()
	 WHERE id=ANY($1::uuid[])`, []string{f.owner, f.editor, f.joiner}); err != nil {
		t.Fatal(err)
	}
	name := "Changed"
	newVault := uuid.NewString()
	checks := []struct {
		name string
		call func() error
	}{
		{"create", func() error {
			_, err := f.svc.Create(t.Context(), CreateInput{AccountID: f.owner, VaultID: newVault, Name: name})
			return err
		}},
		{"update", func() error {
			_, err := f.svc.Update(t.Context(), UpdateInput{AccountID: f.owner, VaultID: f.vault, Name: &name})
			return err
		}},
		{"archive", func() error { _, err := f.svc.Archive(t.Context(), f.vault, f.owner); return err }},
		{"unarchive", func() error { _, err := f.svc.Unarchive(t.Context(), f.vault, f.owner); return err }},
		{"leave", func() error { _, err := f.svc.Leave(t.Context(), f.vault, f.editor); return err }},
		{"transfer", func() error {
			_, err := f.svc.TransferOwnership(t.Context(), TransferInput{VaultID: f.vault, AccountID: f.owner, ToAccountID: f.editor, DemoteSelfTo: "editor"})
			return err
		}},
		{"member role", func() error {
			_, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.editor, "viewer")
			return err
		}},
		{"revoke member", func() error {
			_, err := f.svc.RevokeMember(t.Context(), RevokeInput{VaultID: f.vault, CallerID: f.owner, TargetID: f.editor})
			return err
		}},
		{"create invite", func() error {
			_, err := f.svc.CreateInvite(t.Context(), CreateInviteInput{VaultID: f.vault, InviterAccID: f.owner, Role: "clerk"})
			return err
		}},
		{"accept invite", func() error {
			_, err := f.svc.AcceptInvite(t.Context(), AcceptInviteInput{Token: f.token, AccountID: f.joiner, InstallID: uuid.NewString()})
			return err
		}},
	}
	audits := graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`)
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.call(); !errors.Is(err, ErrNotMember) {
				t.Fatalf("pending account write=%v, want ErrNotMember", err)
			}
		})
	}
	if graceVaultCount(t, f, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid`, newVault) != 0 ||
		graceVaultCount(t, f, `SELECT COUNT(*) FROM vaults WHERE vault_id=$1::uuid AND name='Shop' AND archived_at IS NULL AND vault_epoch=1`, f.vault) != 1 ||
		graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE vault_id=$1::uuid AND revoked_at IS NULL AND accepted_at IS NOT NULL`, f.vault) != 2 ||
		graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members WHERE invite_token_hash=$1 AND accepted_at IS NULL AND invite_attempts=0`, hashInviteToken(f.token)) != 1 ||
		graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_audit_log`) != audits {
		t.Fatal("pending account mutation changed preserved data")
	}
	// A proved sign-in clears pending_delete_at; service-level authorization
	// must then use the same retained membership instead of a stale denial.
	if _, err := f.pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NULL WHERE id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Update(t.Context(), UpdateInput{AccountID: f.owner, VaultID: f.vault, Name: &name}); err != nil {
		t.Fatalf("restored account write: %v", err)
	}
}

func waitGraceVaultAccountLock(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
		 WHERE datname=current_database() AND wait_event_type='Lock'
		 AND query LIKE '%FROM accounts WHERE id=ANY%' AND query LIKE '%FOR KEY SHARE%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("mutation did not wait on the deleting account")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestAccountDeletionGraceVaultWriteWaitsBeforeLockingVault(t *testing.T) {
	f := newGraceVaultFixture(t)
	deleting, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = deleting.Rollback(context.Background()) }()
	var account string
	if err := deleting.QueryRow(t.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.owner).Scan(&account); err != nil {
		t.Fatal(err)
	}
	if _, err := deleting.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, f.owner); err != nil {
		t.Fatal(err)
	}
	name := "Must not save"
	result := make(chan error, 1)
	go func() {
		_, err := f.svc.Update(t.Context(), UpdateInput{AccountID: f.owner, VaultID: f.vault, Name: &name})
		result <- err
	}()
	waitGraceVaultAccountLock(t, f.pool)
	// The waiting request has not taken any vault lock ahead of the account.
	probe, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = probe.Rollback(context.Background()) }()
	var vault string
	if err := probe.QueryRow(t.Context(), `SELECT vault_id::text FROM vaults WHERE vault_id=$1::uuid FOR UPDATE NOWAIT`, f.vault).Scan(&vault); err != nil {
		t.Fatalf("vault locked before account: %v", err)
	}
	if err := probe.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := deleting.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, ErrNotMember) {
			t.Fatalf("write after scheduled deletion: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("vault mutation did not finish after account lock released")
	}
}

func TestAccountDeletionGraceTargetAccountLockedBeforeMemberRows(t *testing.T) {
	f := newGraceVaultFixture(t)
	deletingTarget, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = deletingTarget.Rollback(context.Background()) }()
	var account string
	if err := deletingTarget.QueryRow(t.Context(), `SELECT id::text FROM accounts WHERE id=$1::uuid FOR UPDATE`, f.editor).Scan(&account); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := f.svc.SetMemberRole(t.Context(), f.vault, f.owner, f.editor, "viewer")
		result <- err
	}()
	waitGraceVaultAccountLock(t, f.pool)
	// A purge of the referenced account can safely lock its membership while
	// the live caller waits for the account FK lock, instead of a lock cycle.
	var member int64
	if err := deletingTarget.QueryRow(t.Context(), `SELECT id FROM vault_members
	 WHERE vault_id=$1::uuid AND account_id=$2::uuid FOR UPDATE NOWAIT`, f.vault, f.editor).Scan(&member); err != nil {
		t.Fatalf("target membership locked before account: %v", err)
	}
	if err := deletingTarget.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("role update after target lock released: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("target-account write did not finish")
	}
}

func TestAccountDeletionGraceConcurrentOwnersCannotBothLeave(t *testing.T) {
	f := newGraceVaultFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE vault_members SET role='owner'
	 WHERE vault_id=$1::uuid AND account_id=$2::uuid`, f.vault, f.editor); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	start, result := make(chan struct{}), make(chan error, 2)
	for _, id := range []string{f.owner, f.editor} {
		go func(account string) { <-start; _, err := f.svc.Leave(ctx, f.vault, account); result <- err }(id)
	}
	close(start)
	success, lastOwner := 0, 0
	for i := 0; i < 2; i++ {
		err := <-result
		if err == nil {
			success++
		} else if errors.Is(err, ErrLastOwner) {
			lastOwner++
		} else {
			t.Fatalf("concurrent leave: %v", err)
		}
	}
	if success != 1 || lastOwner != 1 || graceVaultCount(t, f, `SELECT COUNT(*) FROM vault_members
	 WHERE vault_id=$1::uuid AND role='owner' AND revoked_at IS NULL`, f.vault) != 1 {
		t.Fatalf("concurrent owners: success=%d last-owner=%d", success, lastOwner)
	}
}
