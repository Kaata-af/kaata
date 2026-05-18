-- Captures the full install timeline so the admin dashboard can render
-- "installed N days ago", "last seen N minutes ago", "first opened online
-- N hours after install", and "has set up shop yes/no".
--
-- Why all three timestamps:
--   installed_at     — wall-clock from the DEVICE the moment the APK first
--                       ran. Survives offline installs: the user installs
--                       at the store, opens the app there (creates this
--                       timestamp locally), goes home, only THEN connects.
--                       Without this, first_seen_at is the only signal and
--                       it'd be misattributed to "installed at home today".
--   first_seen_at    — backend's NOW() on the first check-in. Already
--                       exists. Distance from installed_at = how long
--                       they were offline before their first online launch.
--   last_seen_at     — backend's NOW() on every check-in. Already exists.
--   last_activity_at — backend's NOW() on a check-in that carried a non-zero
--                       usage delta. "Has this person ACTUALLY done anything
--                       lately, or are they just opening the app?"
--
-- has_onboarded: mobile reports whether a shop profile (users.is_local_self)
-- exists. Lets us slice "installed but never set up" out of the cohort.

ALTER TABLE installs
  ADD COLUMN IF NOT EXISTS installed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS has_onboarded    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_installs_installed_at
  ON installs(installed_at DESC) WHERE installed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_installs_last_activity
  ON installs(last_activity_at DESC) WHERE last_activity_at IS NOT NULL;
