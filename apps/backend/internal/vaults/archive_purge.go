package vaults

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ==========================================================================
// Phase 4.1: 30-day archive grace + hard-purge cron.
//
// Lifecycle of an archived vault:
//
//   t=0   Owner POSTs /v1/vaults/:id/archive
//         → vaults.archived_at = NOW(), vault_epoch++
//         → events table still intact; pull still returns the history.
//
//   0 < t < 30d
//         Owner can POST /v1/vaults/:id/unarchive
//         → vaults.archived_at = NULL, vault_epoch++
//         → no data loss; sync resumes.
//
//   t = 30d
//         This cron's tick catches the vault.
//         → DELETE FROM events WHERE vault_id = $1
//         → DELETE FROM vault_snapshots WHERE vault_id = $1
//         → UPDATE vault_members SET revoked_at = NOW(),
//                                     revoked_reason = 'vault_purged'
//                       WHERE vault_id = $1 AND revoked_at IS NULL
//         → vaults.purged_at = NOW()
//         All within ONE transaction per vault. After commit:
//         unarchive is rejected with ErrVaultPurged, sync push/pull return
//         403 because the caller is no longer an active member.
//
// We deliberately KEEP the vaults row forever — purged_at acts as a
// tombstone so future event_id collisions are impossible and the audit
// log entries (which FK to vault_id) remain valid. Storage cost is one
// row per dead vault; acceptable.
//
// MULTI-REPLICA SAFETY: each tick uses SELECT FOR UPDATE SKIP LOCKED on
// the vaults row, so two replicas ticking simultaneously divide the work
// queue without ever fighting for the same vault. The per-vault tx
// commits the data deletes + sets purged_at atomically; a re-scan after
// commit excludes that vault via the `purged_at IS NULL` filter.
//
// FAILURE MODE: if the per-vault tx fails (e.g., pool exhaustion mid-
// delete), the tx rolls back, purged_at stays NULL, the vault is picked
// up again on the next tick. No partial purge state is observable.
// ==========================================================================

// archivePurgeBatchSize bounds how many candidate vaults we process per
// tick. Even a backlog of 10k archived vaults would purge inside a day.
const archivePurgeBatchSize = 50

// archiveGrace is the soft-delete window during which an owner can
// unarchive. Hard-coded to match the documented user-facing promise; if
// we ever expose this as configurable per-account or per-vault, this
// becomes a column on vaults rather than a constant.
const archiveGrace = 30 * 24 * time.Hour

// StartArchivePurgeCron blocks until ctx is cancelled, ticking every
// interval. Multi-replica safe via SKIP LOCKED.
//
// We deliberately do NOT use a dedicated Postgres pool here (unlike the
// snapshot cron). Archive purges are I/O-light (a few DELETEs per vault,
// O(seconds) at our scale) and run at most every 6 hours — starvation
// of the request pool is implausible. Snapshot generation is the
// opposite shape (CPU + memory heavy, every 5 minutes) and earns its
// own pool.
func StartArchivePurgeCron(ctx context.Context, pool *pgxpool.Pool, interval time.Duration) {
	log.Printf("archive-purge cron running, tick=%s grace=%s", interval, archiveGrace)

	tick := func() {
		if err := runArchivePurgeTick(ctx, pool); err != nil {
			log.Printf("archive-purge cron: tick failed: %v", err)
		}
	}
	tick()

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("archive-purge cron: shutting down")
			return
		case <-t.C:
			tick()
		}
	}
}

// runArchivePurgeTick scans for vaults eligible for purge and processes
// them one transaction at a time. Returns the first scan error; per-vault
// failures are logged but do not abort the tick.
func runArchivePurgeTick(ctx context.Context, pool *pgxpool.Pool) error {
	candidates, err := findPurgeCandidates(ctx, pool)
	if err != nil {
		return fmt.Errorf("find purge candidates: %w", err)
	}
	if len(candidates) == 0 {
		return nil
	}

	purged := 0
	failed := 0
	skipped := 0
	for _, vaultID := range candidates {
		res, err := purgeOneVault(ctx, pool, vaultID)
		if err != nil {
			log.Printf("archive-purge cron: vault=%s purge failed: %v", vaultID, err)
			failed++
			continue
		}
		if res.skipped {
			// Another replica got there first, or owner unarchived in
			// the gap between scan and lock. Either way, not our work.
			skipped++
			continue
		}
		purged++
		log.Printf(
			"archive-purge cron: vault=%s purged events=%d snapshots=%d members_revoked=%d",
			vaultID, res.deletedEvents, res.deletedSnapshots, res.revokedMembers,
		)
	}
	log.Printf("archive-purge cron: tick done — purged=%d skipped=%d failed=%d",
		purged, skipped, failed)
	return nil
}

func findPurgeCandidates(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	limit := archivePurgeBatchSize
	if raw := os.Getenv("ARCHIVE_PURGE_BATCH_SIZE"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 && v <= 1000 {
			limit = v
		}
	}
	rows, err := pool.Query(ctx, `
		SELECT vault_id::text
		  FROM vaults
		 WHERE archived_at IS NOT NULL
		   AND purged_at   IS NULL
		   AND archived_at < NOW() - INTERVAL '30 days'
		 ORDER BY archived_at ASC
		 LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("scan candidates: %w", err)
	}
	defer rows.Close()

	out := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows err: %w", err)
	}
	return out, nil
}

type purgeResult struct {
	deletedEvents    int64
	deletedSnapshots int64
	revokedMembers   int64
	skipped          bool
}

// purgeOneVault hard-deletes a single vault's content in one transaction.
// Returns skipped=true if another replica or an unarchive raced us.
func purgeOneVault(ctx context.Context, pool *pgxpool.Pool, vaultID string) (purgeResult, error) {
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return purgeResult{}, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lock the vault row with SKIP LOCKED. If another replica holds the
	// lock, we skip this vault on this tick and try again on the next.
	// Re-check the predicates under lock: an unarchive between scan and
	// lock would have set archived_at = NULL, and we must not purge.
	var archivedAt *time.Time
	var purgedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT archived_at, purged_at
		  FROM vaults
		 WHERE vault_id = $1::uuid
		   AND archived_at IS NOT NULL
		   AND purged_at   IS NULL
		   AND archived_at < NOW() - INTERVAL '30 days'
		 FOR UPDATE SKIP LOCKED
	`, vaultID).Scan(&archivedAt, &purgedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Locked by another replica, or owner unarchived, or already
		// purged. All three are "not our work" — quiet skip.
		return purgeResult{skipped: true}, nil
	}
	if err != nil {
		return purgeResult{}, fmt.Errorf("lock vault: %w", err)
	}

	// 1. Drop the event log. This is what makes the data unrecoverable.
	delEvents, err := tx.Exec(ctx, `
		DELETE FROM events WHERE vault_id = $1::uuid
	`, vaultID)
	if err != nil {
		return purgeResult{}, fmt.Errorf("delete events: %w", err)
	}

	// 2. Drop snapshots — they're a cache of the (now-deleted) events.
	delSnaps, err := tx.Exec(ctx, `
		DELETE FROM vault_snapshots WHERE vault_id = $1::uuid
	`, vaultID)
	if err != nil {
		return purgeResult{}, fmt.Errorf("delete snapshots: %w", err)
	}

	// 3. Revoke every still-active membership. We do NOT delete
	//    vault_members rows: the audit_log FKs and "who was a member
	//    when" history is intentionally preserved.
	//    revoked_reason = 'vault_purged' is the grep-able marker.
	revMembers, err := tx.Exec(ctx, `
		UPDATE vault_members
		   SET revoked_at     = NOW(),
		       revoked_reason = 'vault_purged',
		       updated_at     = NOW()
		 WHERE vault_id   = $1::uuid
		   AND revoked_at IS NULL
	`, vaultID)
	if err != nil {
		return purgeResult{}, fmt.Errorf("revoke members: %w", err)
	}

	// 4. Stamp purged_at. The vaults row stays — see file-level comment.
	//    vault_epoch is intentionally NOT bumped: there is nobody left
	//    to observe an epoch bump (every member was just revoked) and
	//    the next sync attempt by any ex-member returns 403 directly.
	if _, err := tx.Exec(ctx, `
		UPDATE vaults
		   SET purged_at = NOW()
		 WHERE vault_id = $1::uuid
	`, vaultID); err != nil {
		return purgeResult{}, fmt.Errorf("stamp purged_at: %w", err)
	}

	// 5. Audit. actor_id = NULL signals "the system" (the cron, not a
	//    human). The vault is dead; nobody can read this row via the
	//    AuditLog endpoint, but it survives in the table for forensics.
	if _, err := writeAudit(ctx, tx, vaultID, nil, "vault_purged", nil, map[string]any{
		"deleted_events":    delEvents.RowsAffected(),
		"deleted_snapshots": delSnaps.RowsAffected(),
		"revoked_members":   revMembers.RowsAffected(),
	}); err != nil {
		return purgeResult{}, fmt.Errorf("write audit: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return purgeResult{}, fmt.Errorf("commit tx: %w", err)
	}
	return purgeResult{
		deletedEvents:    delEvents.RowsAffected(),
		deletedSnapshots: delSnaps.RowsAffected(),
		revokedMembers:   revMembers.RowsAffected(),
	}, nil
}
