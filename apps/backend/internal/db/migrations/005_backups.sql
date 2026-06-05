-- Per-install snapshot of the mobile SQLite ledger. ONE row per install
-- (UNIQUE constraint on install_id) — upload UPSERTs, so the column always
-- reflects the latest snapshot only. Earlier snapshots are not kept.
--
-- provider_sub is stamped at upload time from the session JWT. It enables
-- the upcoming cross-device restore flow: when a user signs in on a new
-- phone with the same Google account, the backend can find ALL installs
-- tied to that provider_sub and surface the most recent backup across
-- them (not just this install's).
--
-- snapshot is JSONB so we can:
--   - Query individual fields server-side later (e.g., for analytics on
--     average shop size, churned-user data export, etc.)
--   - Take advantage of Postgres TOAST compression for free.
--
-- Schema versioning: the snapshot JSON itself carries a top-level
-- `version` field. When the mobile schema changes, mobile bumps the
-- version and includes whatever migration data is needed for restore.
-- The backend treats the snapshot as opaque otherwise.

CREATE TABLE IF NOT EXISTS backups (
  install_id UUID PRIMARY KEY REFERENCES installs(install_id) ON DELETE CASCADE,
  provider_sub TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  snapshot_version INTEGER NOT NULL DEFAULT 1,
  app_version TEXT NOT NULL DEFAULT 'unknown',
  byte_size INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cross-install lookup: given a provider_sub, find all this Google user's
-- backups across every install they've ever signed in on. Used by the
-- restore-on-new-phone flow.
CREATE INDEX IF NOT EXISTS idx_backups_provider_sub_updated
  ON backups(provider_sub, updated_at DESC);
