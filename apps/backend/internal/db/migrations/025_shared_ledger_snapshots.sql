-- Migration 025: rename the shared-ledger SNAPSHOT table to dodge a fatal
-- name collision with migration 021.
--
-- BUG: migration 024 created the WhatsApp "see the full ledger" snapshot store
-- as `CREATE TABLE IF NOT EXISTS shared_ledgers (token, payload, expires_at)`.
-- But migration 021 had ALREADY created a table literally named `shared_ledgers`
-- — a completely different, speculative two-party-tab schema
-- (id/title/currency/party_a_label/...) that no Go code ever referenced. Because
-- 021 sorts before 024, 024's IF NOT EXISTS was a silent no-op: the table kept
-- 021's columns. The snapshot service then ran
--   INSERT INTO shared_ledgers (token, payload, expires_at) ...
-- which errors with `column "token" does not exist`, the handler 500s, and the
-- mobile app falls back to the plain "Sent via Kaata.af" line instead of a link.
-- So the full-ledger link NEVER worked, for anyone, regardless of sign-in.
--
-- FIX: give the snapshot store its own unambiguous name and point the service at
-- it. We leave 021's dead `shared_ledgers`/`shared_ledger_access`/
-- `shared_ledger_entries` tables alone (they have FKs between them and zero code
-- consumers — dropping them is needless risk for this fix).
CREATE TABLE IF NOT EXISTS shared_ledger_snapshots (
  token       TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Hot path: GET by token (PK already covers it). This index supports the
-- periodic expiry prune (DELETE WHERE expires_at < NOW()).
CREATE INDEX IF NOT EXISTS idx_shared_ledger_snapshots_expires
  ON shared_ledger_snapshots (expires_at);
