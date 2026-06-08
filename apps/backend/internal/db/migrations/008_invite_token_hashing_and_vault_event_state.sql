-- Phase 4.1: invite token hashing + server-side HLC emitter state +
--            archive purge tombstone.
--
-- This migration bundles three independent, additive schema changes that
-- ship together in Phase 4.1. None of them touch existing data semantics
-- of migrations 001-007; the column additions are all NULL-safe, and the
-- one column drop (vault_members.invite_token plaintext) is gated on a
-- prior backfill into the new hash column.
--
-- 1. INVITE TOKEN HASHING
--    Pre-this-migration, vault_members.invite_token held the *plaintext*
--    token. Anybody who could read the column (a leaked DB dump, a
--    read-only analytics replica, a stray pg_dump in CI logs) could
--    walk straight up to /v1/vaults/invites/<token>/info and then
--    /v1/vaults/invites/accept and pose as the legitimate invitee.
--
--    Post-migration, only encode(sha256(token), 'hex') survives in the
--    DB. The plaintext only ever lives:
--      - In the response to CreateInvite (one-time, to the inviter).
--      - On the invitee's device after they receive the URL.
--      - In the AcceptInvite/InviteInfo HTTP request body.
--    The server hashes on the way in and compares hashes only.
--
--    Production has no outstanding invites at the time of this migration
--    (per the Phase 4.1 plan note), so the UPDATE is a no-op in prod.
--    We still run it defensively to cover dev / staging environments
--    that may have test invites lying around. sha256() is available in
--    core PG via the bytea-shorthand since PG 11.
--
-- 2. SERVER-SIDE HLC EMITTER STATE
--    The backend now emits vault_member_* events into the events table on
--    AcceptInvite / SetMemberRole / RevokeMember / Leave / TransferOwnership.
--    Per design D-SERVER-EMIT-VAULT-EVENTS we use a per-vault
--    Lamport-pessimistic HLC: physical_ms = max(wall_clock, last_emitted),
--    logical advances when physical_ms == last_emitted.
--
--    The two columns below hold the last (physical_ms, logical) emitted
--    by the backend for this vault. They are read+written inside the same
--    tx that already holds the vault row's FOR UPDATE lock from the
--    membership mutation, so no extra serialisation is needed.
--
--    Default 0/0 means "backend has never emitted on this vault" — the
--    first emit computes physical_ms = wall_clock (overwhelmingly > 0)
--    and logical = 0.
--
-- 3. ARCHIVE PURGE TOMBSTONE
--    archived_at = soft-delete; owner can unarchive within 30 days.
--    purged_at   = hard-delete; events + snapshots dropped, members
--                  revoked. Once stamped, unarchive is refused (data is
--                  gone). The vaults row STAYS forever as a tombstone so
--                  event_id collisions remain impossible and audit-log
--                  FKs stay valid.
--
-- Whole migration runs in a single transaction (see db.Migrate in
-- internal/db/db.go) — either all of it lands, or none of it does.
-- ---------------------------------------------------------------------------

-- 1. Invite token hashing -----------------------------------------------------

ALTER TABLE vault_members
  ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;

-- Backfill: hash any existing rows that still carry a cleartext token.
-- WHERE clause is fully guarded so re-runs are safe AT THE ROW LEVEL.
-- MIG #1: also wrap in a column-existence DO block so a dev who wipes
-- schema_migrations and re-runs after the cleartext column was dropped
-- below sees a no-op instead of "column invite_token does not exist".
-- Production never hits this branch (filename tracker keeps 008 from
-- re-running), but dev DB resets do.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'vault_members'
       AND column_name = 'invite_token'
  ) THEN
    EXECUTE $sql$
      UPDATE vault_members
         SET invite_token_hash = encode(sha256(invite_token::bytea), 'hex')
       WHERE invite_token IS NOT NULL
         AND invite_token_hash IS NULL
    $sql$;
  END IF;
END $$;

-- Unique index on the hash. Same shape as the old plaintext index:
-- partial so revoked / accepted / never-invited rows (hash IS NULL)
-- don't trip the uniqueness constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_members_token_hash
  ON vault_members(invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

-- Retire the old plaintext path.
DROP INDEX IF EXISTS idx_vault_members_token;
ALTER TABLE vault_members DROP COLUMN IF EXISTS invite_token;

-- 2. Server-side HLC emitter state -------------------------------------------

ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS last_server_emit_hlc_physical_ms BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_server_emit_hlc_logical     BIGINT NOT NULL DEFAULT 0;

-- 3. Archive purge tombstone --------------------------------------------------

ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- Targets the cron's "needs purge" scan: vaults soft-archived for >30d
-- that have not yet been hard-purged. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_vaults_archive_purge_queue
  ON vaults(archived_at)
  WHERE archived_at IS NOT NULL AND purged_at IS NULL;
