package checkin

import (
	"context"
	"encoding/json"
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

func TestAccountDeletionGracePendingCheckInDoesNotMutateRetainedData(t *testing.T) {
	for _, mode := range []string{"authenticated retained install", "authenticated new install", "anonymous retired install"} {
		t.Run(mode, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			account, install := seedCheckInAccount(t, pool), uuid.NewString()
			if _, err := pool.Exec(t.Context(), `UPDATE accounts SET pending_delete_at=NOW() WHERE id=$1::uuid`, account); err != nil {
				t.Fatal(err)
			}
			newInstall := mode == "authenticated new install"
			if !newInstall {
				if _, err := pool.Exec(t.Context(), `INSERT INTO installs(install_id,account_id,self_name,self_phone,shop_name,check_in_count,usage_entries_created,account_deleted_at)
				 VALUES($1::uuid,$2::uuid,'Preserved Name','+93700123456','Preserved Shop',7,12,CASE WHEN $3 THEN NOW() ELSE NULL END)`, install, account, mode == "anonymous retired install"); err != nil {
					t.Fatal(err)
				}
			}
			ctx := t.Context()
			if mode != "anonymous retired install" {
				ctx = WithActorAccountID(ctx, account)
			}
			if _, err := NewService(pool, "", nil).Handle(ctx, staleProfileRequest(install), "192.0.2.1"); !errors.Is(err, ErrInstallDeleted) {
				t.Fatalf("pending check-in: %v", err)
			}
			var intact bool
			if newInstall {
				if err := pool.QueryRow(t.Context(), `SELECT NOT EXISTS(SELECT 1 FROM installs WHERE install_id=$1::uuid)`, install).Scan(&intact); err != nil || !intact {
					t.Fatalf("pending account created new install: intact=%v err=%v", intact, err)
				}
			} else {
				if err := pool.QueryRow(t.Context(), `SELECT account_id=$2::uuid AND self_name='Preserved Name' AND self_phone='+93700123456'
				 AND shop_name='Preserved Shop' AND check_in_count=7 AND usage_entries_created=12
				 AND NOT EXISTS(SELECT 1 FROM install_active_days WHERE install_id=$1::uuid)
				 AND NOT EXISTS(SELECT 1 FROM install_active_hours WHERE install_id=$1::uuid)
				 FROM installs WHERE install_id=$1::uuid`, install, account).Scan(&intact); err != nil || !intact {
					t.Fatalf("pending check-in changed retained identity/usage: intact=%v err=%v", intact, err)
				}
			}
		})
	}
}

// During the 30-day grace window a retired phone must be told to sign in
// (which cancels the deletion), not to reset itself and erase its ledger.
func TestPendingDeletionCheckInTellsAppToSignInUntilDeadline(t *testing.T) {
	type body struct {
		Error            string `json:"error"`
		ErrorCode        string `json:"error_code"`
		RecoverableUntil string `json:"recoverable_until"`
	}
	checkIn := func(t *testing.T, svc *Service, install string) body {
		t.Helper()
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/v1/check-in", strings.NewReader(
			`{"install_id":"`+install+`","app_version":"1.0.0","platform":"android"}`,
		))
		NewHandler(svc, nil).CheckIn(w, r)
		if w.Code != http.StatusGone {
			t.Fatalf("status = %d, want 410: %s", w.Code, w.Body.String())
		}
		var got body
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	for _, tc := range []struct {
		name        string
		requested   string // SQL interval before NOW(); "" = no pending deletion
		recoverable bool
	}{
		{"pending one day", "1 day", true},
		{"window expired", "31 days", false},
		{"plain retired install", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := testutil.ConnectTestDB(t)
			ctx := t.Context()
			account, install := seedCheckInAccount(t, pool), uuid.NewString()
			if tc.requested != "" {
				if _, err := pool.Exec(ctx, `UPDATE accounts SET pending_delete_at = NOW() - $2::interval WHERE id = $1::uuid`,
					account, tc.requested); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_id, account_deleted_at, deletion_account_id)
				VALUES ($1::uuid, $2::uuid, NOW(), $2::uuid)`, install, account); err != nil {
				t.Fatal(err)
			}
			got := checkIn(t, NewService(pool, "", nil), install)
			if !tc.recoverable {
				if got.RecoverableUntil != "" || got.ErrorCode == "account_deletion_pending" {
					t.Fatalf("unrecoverable install told to sign in: %+v", got)
				}
				return
			}
			if got.ErrorCode != "account_deletion_pending" {
				t.Fatalf("error_code = %q, want account_deletion_pending", got.ErrorCode)
			}
			until, err := time.Parse(time.RFC3339, got.RecoverableUntil)
			if err != nil {
				t.Fatalf("recoverable_until %q: %v", got.RecoverableUntil, err)
			}
			want := time.Now().Add(-24 * time.Hour).Add(30 * 24 * time.Hour)
			if d := until.Sub(want); d < -2*time.Minute || d > 2*time.Minute {
				t.Fatalf("recoverable_until = %s, want about %s", until, want)
			}
		})
	}
}
