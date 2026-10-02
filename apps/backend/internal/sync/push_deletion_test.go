package sync

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/matee/kaata-backend/internal/auth"
)

func TestPushSerializesBeforeAccountDeletion(t *testing.T) {
	for _, relay := range []bool{false, true} {
		name := "caller"
		if relay {
			name = "relayed_author"
		}
		t.Run(name, func(t *testing.T) {
			f := newM2Fixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			departing := f.ownerAcct
			if relay {
				departing = f.seedAccount(t, "relay-author@example.test")
				if _, err := f.pool.Exec(ctx, `INSERT INTO vault_members(vault_id,account_id,role,accepted_at)
					VALUES($1::uuid,$2::uuid,'editor',NOW())`, f.vaultID, departing); err != nil {
					t.Fatal(err)
				}
			}
			// Prime the very cache that must not keep a deleted caller alive.
			if _, err := f.svc.checkMembership(ctx, f.vaultID, departing); err != nil {
				t.Fatal(err)
			}
			ev := f.membershipEvent("entry_created", f.anchorDeviceID, departing, uuid.NewString(), map[string]any{})
			f.signEvent(t, &ev, f.anchorPriv)
			barrier, err := f.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer barrier.Rollback(context.Background())
			if _, err := barrier.Exec(ctx, `SELECT 1 FROM vaults WHERE vault_id=$1::uuid FOR UPDATE`, f.vaultID); err != nil {
				t.Fatal(err)
			}
			type pushResult struct {
				response *PushResponse
				err      error
			}
			pushed := make(chan pushResult, 1)
			go func() {
				res, err := f.svc.PushEvents(ctx, PushInput{AccountID: f.ownerAcct, VaultID: f.vaultID,
					DeviceID: f.anchorDeviceID, Events: []PushEvent{ev}})
				pushed <- pushResult{res, err}
			}()
			pushPID := waitForPushDeletionBlock(t, ctx, barrier, barrier.Conn().PgConn().PID(), "%SELECT 1 FROM vaults%FOR UPDATE%")
			deleted := make(chan error, 1)
			go func() { deleted <- auth.NewService(f.pool, "test", "secret").DeleteAccount(ctx, departing) }()
			// Deletion must wait for the push's account lock, before it reaches
			// vault/event/member rows. Old vault-first push code creates a cycle.
			waitForPushDeletionBlock(t, ctx, barrier, pushPID, "%SELECT id::text FROM accounts%FOR UPDATE%")
			if err := barrier.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case result := <-pushed:
				if result.err != nil {
					t.Fatalf("concurrent push failed: %v", result.err)
				}
				requireAccepted(t, result.response, 1)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case err := <-deleted:
				if err != nil {
					t.Fatalf("concurrent deletion failed: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if relay {
				var live, snapshot *string
				if err := f.pool.QueryRow(ctx, `SELECT account_id::text,signed_actor_account_id::text
					FROM events WHERE event_id=$1::uuid`, ev.EventID).Scan(&live, &snapshot); err != nil {
					t.Fatal(err)
				}
				if live != nil || snapshot == nil || *snapshot != departing {
					t.Fatal("serialized deletion lost signed actor or retained live FK")
				}
			}
			// NULL actors and the account_bound authorization exception cannot
			// let a stale authenticated request recreate data after deletion.
			late := f.membershipEvent("account_bound", f.anchorDeviceID, "", uuid.NewString(), map[string]any{"account_id": departing})
			_, err = f.svc.PushEvents(ctx, PushInput{AccountID: departing, VaultID: f.vaultID,
				DeviceID: f.anchorDeviceID, Events: []PushEvent{late}})
			if !errors.Is(err, ErrNotMember) {
				t.Fatalf("deleted caller with cached membership: %v", err)
			}
		})
	}
}

func waitForPushDeletionBlock(t *testing.T, ctx context.Context, observer pgx.Tx, blockerPID uint32, queryPattern string) uint32 {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		// The observer holds a transaction open as the test barrier; refresh
		// PostgreSQL's transaction-local activity snapshot on each poll.
		if _, err := observer.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		var pid uint32
		err := observer.QueryRow(ctx, `SELECT pid FROM pg_stat_activity
			WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE $2
			LIMIT 1`, blockerPID, queryPattern).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("expected lock dependency did not appear: %v", ctx.Err())
		case <-ticker.C:
		}
	}
}
