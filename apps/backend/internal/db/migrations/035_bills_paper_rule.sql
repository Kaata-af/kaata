-- 035: bills follow the paper rule (2026-08-07 product decision) — EXPAND phase.
--
-- A shared bill snapshot is the RECIPIENT'S asset — like a paper bill handed
-- across the counter, it is permanent, frozen, and unrevocable. This reverses
-- the 2026-07-26 revocation hardening (migration 032) and retires the TTL:
-- the Get path no longer filters on expires_at, the daily prune sweep is gone,
-- and the revoke endpoint is a tombstone. Rows whose TTL had lapsed but were
-- not yet swept come back to life — consistent with the new policy (a paper
-- bill doesn't dissolve after 30 days either).
--
-- Expand/contract: this migration only NEUTRALIZES the old columns — it does
-- NOT drop them — so a rollback to the previous backend image keeps working
-- (its Create still INSERTs expires_at explicitly; its Get still filters on
-- it; its Revoke still reads revoke_secret_hash). The DEFAULT 'infinity' on
-- expires_at keeps the NOT NULL satisfied for the new code's column-less
-- INSERT *and* keeps new rows visible to the old binary's expires_at > NOW()
-- filter under rollback. Physically DROP both columns (and this comment's
-- promise) in a later migration once a release has soaked.

DROP INDEX IF EXISTS idx_shared_ledger_snapshots_expires;
ALTER TABLE shared_ledger_snapshots ALTER COLUMN expires_at SET DEFAULT 'infinity';
