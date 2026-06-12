-- Mythos crash-reporter. Append-only stream of client-reported crashes,
-- mesh failures, and boot errors — so we can query "why is the app dying"
-- via psql instead of fighting adb on the user's phone.
--
-- One row per reported event (NOT one-per-install like backups). The
-- mobile side queues into a local SQLite outbox and flushes a batch on the
-- next check-in; each item in the batch becomes one row here.
--
-- PII boundary (matches the check-in precedent): install_id (UUID),
-- app_version, platform, an error name/kind/stage, a TRUNCATED message,
-- and timestamps. NEVER a customer name, phone, balance, or any ledger
-- payload. The `kind` discriminates the source:
--   'boot'   — a boot-pipeline BootError (stage carries which step)
--   'mesh'   — a MeshFailureEvent (name carries the failure kind)
--   'sync'   — a sync-layer error
--   'exit'   — ApplicationExitInfo verdict for a PRIOR process death
--              (reasonName in `name`, RSS-at-death in `rss_kb`)
--   'memsample' — a memory snapshot row flushed alongside an exit report
--                 so we get the slope leading up to a death
--   'js'     — a generic JS error
--   'native' — reserved for a future native sentinel
--
-- message length is capped both client-side (500) and here (4096) so a
-- runaway error string can't bloat the table.

CREATE TABLE IF NOT EXISTS crash_reports (
  id                BIGSERIAL PRIMARY KEY,
  install_id        UUID REFERENCES installs(install_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN
                      ('boot','mesh','sync','exit','memsample','js','native')),
  stage             TEXT,
  name              TEXT,
  message           TEXT NOT NULL DEFAULT '' CHECK (length(message) < 4096),
  app_version       TEXT NOT NULL DEFAULT 'unknown',
  platform          TEXT NOT NULL DEFAULT 'unknown',
  -- Optional numeric telemetry for 'exit' and 'memsample' rows. Null for
  -- error rows. rss_kb = RSS at death (exit) or native_pss (memsample);
  -- aux_kb = pss-at-death (exit) or dalvik_pss (memsample). Kept generic
  -- so we don't add a column per metric.
  rss_kb            BIGINT,
  aux_kb            BIGINT,
  client_created_at TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip                TEXT
);

-- "show me this install's recent deaths" and "show me all LOW_MEMORY exits
-- this week across the fleet" are the two queries we'll actually run.
CREATE INDEX IF NOT EXISTS idx_crash_reports_install_received
  ON crash_reports(install_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_crash_reports_kind_received
  ON crash_reports(kind, received_at DESC);
