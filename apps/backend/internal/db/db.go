package db

import (
	"context"
	"embed"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Open creates a pool and waits up to ~15s for Postgres to accept connections.
// This makes the backend tolerant of `docker compose up -d` race conditions
// where the container is reported "started" before Postgres actually accepts
// TCP connections.
func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse pool config: %w", err)
	}
	// Bound the request-path pool so a slow/expensive query (e.g. an admin
	// analytics full-events scan) cannot pin every connection and stall
	// user-facing check-in/sync, and so a hung query cannot hold a connection
	// forever. statement_timeout is generous enough for the heaviest legit
	// query and every DDL migration, but kills a runaway; idle_in_transaction
	// reaps a stuck transaction. MaxConns gives headroom over pgx's default
	// (~4 on a small VPS) while staying well under Postgres max_connections.
	cfg.MaxConns = 15
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	if _, ok := cfg.ConnConfig.RuntimeParams["statement_timeout"]; !ok {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = "30000" // 30s
	}
	if _, ok := cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"]; !ok {
		cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "60000" // 60s
	}

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	deadline := time.Now().Add(15 * time.Second)
	var lastErr error
	for attempt := 1; ; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		err := pool.Ping(pingCtx)
		cancel()
		if err == nil {
			return pool, nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			break
		}
		if attempt == 1 {
			log.Printf("db not ready yet (%v) — retrying for up to 15s...", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	pool.Close()
	return nil, fmt.Errorf("ping db: %w", lastErr)
}

func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations dir: %w", err)
	}

	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, f := range files {
		var exists bool
		if err := pool.QueryRow(ctx,
			"SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)", f,
		).Scan(&exists); err != nil {
			return fmt.Errorf("check migration %s: %w", f, err)
		}
		if exists {
			continue
		}

		body, err := migrationFS.ReadFile("migrations/" + f)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", f, err)
		}

		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin tx for %s: %w", f, err)
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", f, err)
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO schema_migrations(name) VALUES ($1)", f,
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", f, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", f, err)
		}
		fmt.Printf("applied migration: %s\n", f)
	}
	return nil
}
