-- Migration 026: waitlist for the "coming soon" app-store channels.
--
-- The download page shows Android (live APK) plus Google Play + App Store as
-- "coming soon". Visitors can leave an email to be notified when those ship.
-- This is the only PII we store here; `platform` records which channel they
-- asked about ('ios' | 'android' | 'stores' = either/both). (email, platform)
-- is UNIQUE so a repeat submit is idempotent (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS waitlist (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT 'stores',
  source          TEXT,
  ip              TEXT,
  user_agent      TEXT,
  accept_language TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, platform)
);

-- Hot path for the operator view: recent signups + counts over a window.
CREATE INDEX IF NOT EXISTS idx_waitlist_created_at ON waitlist(created_at);
