-- Analytics tracking for the operator growth dashboard.
--
-- Two additions, both append-only and forward-safe (existing rows untouched):
--
-- 1. installs.app_locale — the resolved IN-APP language the user runs the app in
--    ('en' / 'fa'), distinct from device_locale (the OS locale, which in
--    Afghanistan is frequently English even when the user runs the app in Dari).
--    This is what the "users in English vs Dari" split needs. NULL until the
--    install's next check-in from an app build that sends it.
--
-- 2. install_active_days — one row per (install, UTC day) the app phoned home.
--    Fed by /v1/check-in (every launch), deduped by the PK. last_seen_at alone
--    can't reconstruct history, so this is the substrate for real DAU/WAU/MAU,
--    retention curves, and cohort analysis GOING FORWARD (the past can't be
--    backfilled — data accrues from the moment this deploys).

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS app_locale TEXT;

-- had_usage distinguishes "opened the app that day" (every check-in) from
-- "did something meaningful that day" (created/edited an entry, added a
-- customer, shared). For a debt ledger, opening just to CHECK what someone owes
-- is real engagement, so we keep both signals: DAU(opened) = all rows for a day,
-- DAU(engaged) = rows where had_usage.
CREATE TABLE IF NOT EXISTS install_active_days (
  install_id  UUID NOT NULL REFERENCES installs(install_id) ON DELETE CASCADE,
  active_date DATE NOT NULL,
  had_usage   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (install_id, active_date)
);

-- Hot path for DAU/WAU/MAU + cohort windows: "active installs in [from, to]".
CREATE INDEX IF NOT EXISTS idx_active_days_date ON install_active_days(active_date);
