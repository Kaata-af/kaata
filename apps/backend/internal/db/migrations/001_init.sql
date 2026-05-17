CREATE TABLE IF NOT EXISTS installs (
  install_id UUID PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_version TEXT,
  platform TEXT,
  device_locale TEXT,
  check_in_count INTEGER NOT NULL DEFAULT 1,
  -- Telemetry: counts of phones nulled during the v0 -> v1 mobile migration.
  -- See docs/refactor-notes.md.
  migration_001_phones_invalid INTEGER,
  migration_001_phones_conflict INTEGER
);

CREATE INDEX IF NOT EXISTS idx_installs_last_seen ON installs(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS app_releases (
  id SERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  version TEXT NOT NULL,
  min_supported_version TEXT NOT NULL,
  apk_url TEXT,
  play_store_url TEXT,
  release_notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_releases_platform_active
  ON app_releases(platform, is_active, published_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta_label TEXT,
  cta_url TEXT,
  min_app_version TEXT,
  max_app_version TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON announcements(is_active, published_at DESC) WHERE is_active = TRUE;
