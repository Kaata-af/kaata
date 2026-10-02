package auth

import (
	"context"
	"testing"
	"time"

	"github.com/matee/kaata-backend/internal/testutil"
)

func TestIdentityRefreshLocksAccountBeforeIdentity(t *testing.T) {
	pool := testutil.ConnectTestDB(t)
	// Apple often omits email after its first authorization. That path used
	// to skip the hollow-account lock and update the identity before account.
	accountID, _ := resolveInTx(t, pool, ProviderApple, "delete-race-apple", AccountProfile{})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deleting, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deleting.Rollback(context.Background())
	if _, err := deleting.Exec(ctx, `SELECT id FROM accounts WHERE id=$1::uuid FOR UPDATE`, accountID); err != nil {
		t.Fatal(err)
	}
	refreshing, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	pid := refreshing.Conn().PgConn().PID()
	done := make(chan error, 1)
	go func() {
		_, _, err := resolveOrCreateAccount(ctx, refreshing, ProviderApple, "delete-race-apple", AccountProfile{Name: "refreshed"})
		_ = refreshing.Rollback(context.Background())
		done <- err
	}()
	// Wait until resolution is actually blocked by our account lock. This
	// makes the lock-order regression deterministic instead of timing a sleep.
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type='Lock', false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("refresh unexpectedly completed before account lock release: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	if _, err := deleting.Exec(ctx, `SET LOCAL lock_timeout='500ms'`); err != nil {
		t.Fatal(err)
	}
	// Cascading to the identity must not wait for the blocked sign-in. With
	// identity-first locking this times out (or PostgreSQL detects a deadlock).
	if _, err := deleting.Exec(ctx, `DELETE FROM accounts WHERE id=$1::uuid`, accountID); err != nil {
		t.Fatalf("account deletion blocked by identity refresh: %v", err)
	}
	if err := deleting.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("identity refresh failed after serialization: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
