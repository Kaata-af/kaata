package checkin

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/testutil"
)

func staleProfileRequest(installID string) Request {
	name, phone, shop := "Deleted Person", "+93700000000", "Deleted Shop"
	usage := 5
	return Request{
		InstallID: installID, AppVersion: "1.0.0", Platform: "android",
		SelfName: &name, SelfPhone: &phone, ShopName: &shop,
		UsageEntriesCreated: &usage,
	}
}

func TestDeletedInstallRejectsStaleIdentityAndAllowsFreshInstall(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	install := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO installs (install_id, account_deleted_at, check_in_count, usage_entries_created)
		VALUES ($1, NOW(), 7, 12)
	`, install); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO web_visits (kind, ip, source) VALUES ('visit', '192.0.2.1', 'campaign')`); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool, "", nil)
	if _, err := svc.Handle(ctx, staleProfileRequest(install), "192.0.2.1"); !errors.Is(err, ErrInstallDeleted) {
		t.Fatalf("stale check-in error = %v, want ErrInstallDeleted", err)
	}
	var intact bool
	if err := pool.QueryRow(ctx, `
		SELECT account_id IS NULL AND self_name IS NULL AND self_phone IS NULL AND shop_name IS NULL
		       AND source IS NULL AND check_in_count = 7 AND usage_entries_created = 12
		       AND NOT EXISTS (SELECT 1 FROM install_active_days WHERE install_id = $1)
		       AND NOT EXISTS (SELECT 1 FROM install_active_hours WHERE install_id = $1)
		       AND NOT EXISTS (SELECT 1 FROM web_visits WHERE claimed_by_install_id = $1)
		FROM installs WHERE install_id = $1
	`, install).Scan(&intact); err != nil || !intact {
		t.Fatalf("deleted install mutated: intact=%v err=%v", intact, err)
	}

	fresh := uuid.NewString()
	if _, err := svc.Handle(ctx, staleProfileRequest(fresh), "192.0.2.1"); err != nil {
		t.Fatalf("new install after reset: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT account_deleted_at IS NULL AND self_name = 'Deleted Person'
		       AND check_in_count = 1 AND usage_entries_created = 5 AND source = 'campaign'
		FROM installs WHERE install_id = $1
	`, fresh).Scan(&intact); err != nil || !intact {
		t.Fatalf("fresh install was not recorded: recorded=%v err=%v", intact, err)
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/v1/check-in", strings.NewReader(
		`{"install_id":"`+install+`","app_version":"1.0.0","platform":"android"}`,
	))
	NewHandler(svc, nil).CheckIn(w, r)
	if w.Code != http.StatusGone {
		t.Fatalf("deleted install status = %d, want 410: %s", w.Code, w.Body.String())
	}
}

func TestCheckInWaitsForAccountDeletionAndDoesNotRestoreIdentity(t *testing.T) {
	for _, authenticated := range []bool{false, true} {
		name := "anonymous"
		if authenticated {
			name = "authenticated"
		}
		t.Run(name, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			ctx := t.Context()
			account := seedCheckInAccount(t, pool)
			install := uuid.NewString()
			if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_id) VALUES ($1, $2)`, install, account); err != nil {
				t.Fatal(err)
			}
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			// Same lock/marker ordering as account deletion, held uncommitted
			// while a stale client attempts its check-in.
			if _, err := tx.Exec(ctx, `SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, account); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `UPDATE installs SET account_deleted_at = NOW(), account_id = NULL WHERE install_id = $1`, install); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, `DELETE FROM accounts WHERE id = $1`, account); err != nil {
				t.Fatal(err)
			}
			checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if authenticated {
				checkCtx = WithActorAccountID(checkCtx, account)
			}
			done := make(chan error, 1)
			go func() {
				_, err := NewService(pool, "", nil).Handle(checkCtx, staleProfileRequest(install), "")
				done <- err
			}()
			select {
			case err := <-done:
				t.Fatalf("check-in bypassed uncommitted deletion: %v", err)
			case <-time.After(30 * time.Millisecond):
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, ErrInstallDeleted) {
				t.Fatalf("concurrent check-in error = %v, want ErrInstallDeleted", err)
			}
			var redacted bool
			if err := pool.QueryRow(ctx, `SELECT account_id IS NULL AND self_name IS NULL AND self_phone IS NULL AND shop_name IS NULL FROM installs WHERE install_id = $1`, install).Scan(&redacted); err != nil || !redacted {
				t.Fatalf("identity restored after deletion: redacted=%v err=%v", redacted, err)
			}
		})
	}
}

func TestCheckInMissingAuthenticatedAccountCannotCreateInstall(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	install := uuid.NewString()
	ctx := WithActorAccountID(t.Context(), uuid.NewString())
	_, err := NewService(pool, "", nil).Handle(ctx, staleProfileRequest(install), "")
	if !errors.Is(err, ErrInstallDeleted) {
		t.Fatalf("missing account error = %v, want ErrInstallDeleted", err)
	}
	var exists bool
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS (SELECT 1 FROM installs WHERE install_id = $1)`, install).Scan(&exists); err != nil || exists {
		t.Fatalf("missing account created install: exists=%v err=%v", exists, err)
	}
}

func seedCheckInAccount(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(t.Context(), `INSERT INTO accounts (email) VALUES ('check-in@example.test') RETURNING id::text`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
