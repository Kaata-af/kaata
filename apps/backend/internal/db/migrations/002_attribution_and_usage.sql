-- Per-install source attribution + cumulative usage counters.
--
-- `source` is the QR/marketing-channel slug that brought the install in
-- (e.g. "shop_42"). Populated on the install's first check-in by matching
-- the request's client IP against a recent web_visits row from the same
-- IP. Once set, never overwritten.
--
-- The usage_* columns are cumulative-since-install lifetime counts.
-- Mobile sends DELTAS since its last successful check-in; backend adds.

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS attribution_method TEXT,
  ADD COLUMN IF NOT EXISTS usage_entries_created BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_customers_added BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usage_shares_sent BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_installs_source
  ON installs(source) WHERE source IS NOT NULL;

-- Every web hit we want to count: landing-page views ('visit') and APK
-- download-link clicks ('download'). Source comes from the `?s=` query
-- param the QR encodes. Fingerprint (ip + accept_language + user_agent)
-- is harvested server-side from the request — we don't trust the body.
--
-- `claimed_by_install_id` is set when a later /v1/check-in attributes
-- this visit to a brand-new install. A visit can only be claimed once,
-- so two devices hitting the page from the same IP within an hour will
-- only attribute the first install (good enough for store-by-store).
CREATE TABLE IF NOT EXISTS web_visits (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('visit', 'download')),
  source TEXT,
  path TEXT,
  referrer TEXT,
  ip TEXT,
  user_agent TEXT,
  accept_language TEXT,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_by_install_id UUID
);

-- Hot path: "find the most recent unclaimed visit from this IP".
CREATE INDEX IF NOT EXISTS idx_web_visits_ip_unclaimed
  ON web_visits(ip, visited_at DESC)
  WHERE claimed_by_install_id IS NULL;

-- Reporting: "how many visits/downloads per source over time".
CREATE INDEX IF NOT EXISTS idx_web_visits_source_time
  ON web_visits(source, visited_at DESC) WHERE source IS NOT NULL;
