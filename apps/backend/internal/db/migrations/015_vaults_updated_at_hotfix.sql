-- Hotfix: vaults.updated_at was referenced but never created.
--
-- sync/snapshot.go's LatestSnapshot has always selected
-- COALESCE(updated_at, created_at) from vaults, but no migration in the
-- chain ever added the column — discovered by the M1 test suite, which is
-- the first thing to run /v1/sync/snapshot against a purely chain-built
-- schema. Any database built strictly from migrations 001-014 returns
-- SQLSTATE 42703 on that endpoint.
--
-- Nullable with no default: the COALESCE fallback to created_at is the
-- intended behavior for rows that have never been updated. IF NOT EXISTS
-- keeps this a no-op on any database where the column was added manually.

ALTER TABLE vaults ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
