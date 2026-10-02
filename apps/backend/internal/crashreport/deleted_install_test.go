package crashreport

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

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestRetiredInstallDiscardsDiagnosticsButFreshInstallWorks(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	retired, fresh := uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id, account_deleted_at)
		VALUES ($1::uuid, NOW()), ($2::uuid, NULL)`, retired, fresh); err != nil {
		t.Fatal(err)
	}
	svc := NewService(pool)
	queued := Request{InstallID: retired, Reports: []Item{{Kind: "js", Message: "queued before deletion"}}}
	if err := svc.Handle(ctx, queued, "192.0.2.1"); !errors.Is(err, ErrInstallRetired) {
		t.Fatalf("retired install error = %v, want ErrInstallRetired", err)
	}
	body, err := json.Marshal(queued)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	NewHandler(svc).Report(w, httptest.NewRequest(http.MethodPost, "/v1/crash-reports", strings.NewReader(string(body))))
	var response struct {
		Accepted int `json:"accepted"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != http.StatusOK || response.Accepted != 0 {
		t.Fatalf("discard response status=%d body=%s error=%v", w.Code, w.Body.String(), err)
	}
	queued.InstallID = fresh
	if err := svc.Handle(ctx, queued, "192.0.2.1"); err != nil {
		t.Fatalf("new installation diagnostic: %v", err)
	}
	var retiredCount, freshCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE install_id = $1::uuid),
		count(*) FILTER (WHERE install_id = $2::uuid) FROM crash_reports`, retired, fresh).Scan(&retiredCount, &freshCount); err != nil {
		t.Fatal(err)
	}
	if retiredCount != 0 || freshCount != 1 {
		t.Fatalf("diagnostic counts retired=%d fresh=%d, want 0/1", retiredCount, freshCount)
	}
}

func TestDiagnosticFlushWaitsForDeletionAndCannotRecreateReports(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	ctx := t.Context()
	install := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO installs (install_id) VALUES ($1::uuid)`, install); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// The account deletion transaction holds this marker update before it
	// erases existing reports. Ingest must conflict with a NON-key update.
	if _, err := tx.Exec(ctx, `UPDATE installs SET account_deleted_at = NOW() WHERE install_id = $1`, install); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM crash_reports WHERE install_id = $1`, install); err != nil {
		t.Fatal(err)
	}
	flushCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- NewService(pool).Handle(flushCtx, Request{
			InstallID: install, Reports: []Item{{Kind: "js", Message: "stale queued report"}},
		}, "192.0.2.1")
	}()
	select {
	case err := <-done:
		t.Fatalf("flush bypassed pending deletion: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, ErrInstallRetired) {
		t.Fatalf("racing flush error = %v, want ErrInstallRetired", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM crash_reports WHERE install_id = $1`, install).Scan(&count); err != nil || count != 0 {
		t.Fatalf("diagnostics recreated: count=%d error=%v", count, err)
	}
}

func TestUnknownInstallStillReturnsBadRequest(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	w := httptest.NewRecorder()
	NewHandler(NewService(pool)).Report(w, httptest.NewRequest(http.MethodPost, "/v1/crash-reports", strings.NewReader(
		`{"install_id":"`+uuid.NewString()+`","reports":[{"kind":"js","message":"before first check-in"}]}`,
	)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown install status=%d, want 400: %s", w.Code, w.Body.String())
	}
}
