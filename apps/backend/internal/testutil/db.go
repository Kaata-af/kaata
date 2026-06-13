// Package testutil provides the shared Postgres-backed test harness.
//
// Tests run against a REAL Postgres (no mocks — the schema, partial unique
// indexes, and ON CONFLICT arbiters ARE the behavior under test). The
// database is selected via POSTGRES_TEST_URL, defaulting to the local dev
// cluster's kaata_test database. If the server is unreachable the test is
// skipped with instructions, so `go test ./...` stays runnable on machines
// without Postgres.
package testutil

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/matee/kaata-backend/internal/db"
)

// DefaultTestURL matches the dev bootstrap in scripts/setup-dev-db.sql
// conventions: role `kaata`, dedicated `kaata_test` database on the native
// local cluster. Create it once with:
//
//	psql -h localhost -U postgres -c "CREATE DATABASE kaata_test OWNER kaata"
const DefaultTestURL = "postgres://kaata:kaata@localhost:5432/kaata_test"

// advisoryLockKey serializes schema resets across package test binaries.
// `go test ./...` runs the auth and sync test binaries concurrently against
// the SAME kaata_test database; without this session-level advisory lock,
// one binary's DROP SCHEMA would yank tables out from under the other's
// in-flight test. The lock is held for the duration of each test (acquired
// here, released in Cleanup), making every DB-backed test a critical
// section. Arbitrary constant — just has to be the same everywhere.
const advisoryLockKey int64 = 0x6B61617461 // "kaata"

// ConnectTestDB returns a pool against a freshly-reset kaata_test schema
// with the full migration chain applied (001 → latest), exactly as
// db.Migrate runs it in production. Skips the test if Postgres is
// unreachable. The pool, the advisory lock, and nothing else are cleaned
// up automatically when the test ends.
func ConnectTestDB(tb testing.TB) *pgxpool.Pool {
	tb.Helper()

	url := os.Getenv("POSTGRES_TEST_URL")
	if url == "" {
		url = DefaultTestURL
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		tb.Skipf("skipping: cannot parse/build pool for test Postgres at %s: %v", url, err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	err = pool.Ping(pingCtx)
	cancel()
	if err != nil {
		pool.Close()
		tb.Skipf("skipping: test Postgres unreachable at %s (start a local Postgres and create the kaata_test database, or set POSTGRES_TEST_URL; see apps/backend/scripts/setup-dev-db.sql): %v", url, err)
	}

	// Hold the cross-binary advisory lock on a dedicated session for the
	// whole test.
	lockConn, err := pool.Acquire(ctx)
	if err != nil {
		pool.Close()
		tb.Fatalf("acquire advisory-lock conn: %v", err)
	}
	if _, err := lockConn.Exec(ctx, "SELECT pg_advisory_lock($1)", advisoryLockKey); err != nil {
		lockConn.Release()
		pool.Close()
		tb.Fatalf("pg_advisory_lock: %v", err)
	}
	tb.Cleanup(func() {
		_, _ = lockConn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", advisoryLockKey)
		lockConn.Release()
		pool.Close()
	})

	// Clean slate, then the real migration chain. DROP SCHEMA also drops
	// extensions installed into public (pgcrypto); migration 006 recreates
	// them.
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		tb.Fatalf("reset public schema: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		tb.Fatalf("run migration chain: %v", err)
	}

	return pool
}
