-- Phase 3: sync event log + per-vault snapshots.
--
-- This is the server-side mirror of the mobile event_log table introduced
-- by mobile migration 005. Every mutation to a vault's ledger state
-- (entries, people, shop profile, account binding) flows through here:
--
--   mobile event_log row  -- push -->  events row
--                         <-- pull --  events row  -- apply -->  mobile event_log
--
-- The server is the durable, ordered source of truth ACROSS devices.
-- The mobile event_log is the durable source of truth ON ONE DEVICE.
-- HLC + per-field LWW reconciles the two.
--
-- ---------------------------------------------------------------------------
-- Design notes (per docs/sync-implementation-plan.md Phase 3):
--
-- * server_seq is per-vault, NOT global. It is assigned IN THE PUSH
--   TRANSACTION by Go code:
--
--       SELECT vault_id FROM vaults WHERE vault_id = $1 FOR UPDATE;
--       SELECT COALESCE(MAX(server_seq), 0) + 1 FROM events WHERE vault_id = $1;
--       INSERT INTO events (..., server_seq) VALUES (..., $next);
--
--   This is why server_seq is a plain BIGINT (not BIGSERIAL): a global
--   sequence would couple unrelated vaults' write throughput and waste
--   numbers on rejected events. UNIQUE(vault_id, server_seq) is the
--   correctness guarantee; the SELECT FOR UPDATE on the vaults row is
--   the contention guarantee.
--
-- * event_id is a UUID minted on the MOBILE device (see hlc.ts + uuid-v5.ts
--   on the mobile side). The server treats it as opaque and uses it as the
--   PK so duplicate pushes (offline retry, double-tap) are idempotent: a
--   second INSERT with the same event_id hits the PK and is treated as
--   "already accepted" by push handler logic.
--
-- * hlc_device_id and device_id are intentionally TWO columns holding the
--   same UUID. Per plan A4: hlc_device_id is the canonical HLC tiebreaker;
--   device_id duplicates it as a top-level column purely for join/index
--   readability ("WHERE device_id = $1" reads better than "WHERE
--   hlc_device_id = $1" in audit queries). Storage overhead is 16 bytes
--   per event — acceptable for the clarity gain. They MUST be equal at
--   insert time; the push handler asserts this.
--
-- * NO foreign key from device_id / hlc_device_id to installs(install_id).
--   The event log is append-only and outlives any single install row:
--   reinstalls mint a new install_id but events authored by the old
--   install must survive forever for HLC determinism and audit.
--
-- * account_id is the AUTHORING account at append time on the device.
--   Pre-sign-in events have account_id = NULL (the device was operating
--   in local-only mode). The `account_bound` event retroactively
--   re-attributes prior events for ACL purposes; the server applies that
--   re-attribution by UPDATE-ing this column when an account_bound event
--   lands.
--
-- * payload size cap: 64 KiB (< 65536 bytes). This matches the mobile
--   event payload cap and prevents one bad event from blowing the 1 MiB
--   compressed / 16 MiB decompressed batch limits.
--
-- * redacted_at is the soft-delete / right-to-erasure escape hatch.
--   Once set, the partial index idx_events_redacted hides the row from
--   pull queries while preserving the server_seq slot (gaps would break
--   the COALESCE(MAX,0)+1 contiguity guarantee otherwise — they don't
--   here because pull tolerates gaps, but keeping the row lets us audit
--   redaction).
--
-- * vault_snapshots is the new-device bootstrap fast-path. The snapshot
--   cron (sync/snapshot.go) periodically generates a JSONB blob of the
--   fully-projected vault state up to a known server_seq. A fresh
--   install pulls the snapshot first, then pulls events with
--   server_seq > up_to_server_seq to catch up. The 50 MiB CHECK matches
--   the plan's hard ceiling.
--
-- * vault_snapshots.snapshot is OPAQUE to the server schema — the JSON
--   shape is owned by the Go projection in apps/backend/internal/sync/
--   project.go, which must produce byte-identical output to the TS
--   projection in apps/mobile/lib/projection/. The shared conformance
--   corpus at apps/_shared/projection-corpus/ is the regression net.
--
-- Whole migration runs in a single transaction (see db.Migrate in
-- internal/db/db.go) — either all of it lands, or none of it does.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- events: append-only per-vault event log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id              UUID PRIMARY KEY,
  vault_id              UUID NOT NULL REFERENCES vaults(vault_id),
  hlc_physical_ms       BIGINT NOT NULL,
  hlc_logical           BIGINT NOT NULL,
  hlc_device_id         UUID NOT NULL,
  device_id             UUID NOT NULL,
  account_id            UUID REFERENCES accounts(id),
  -- target_id / relationship_id are envelope fields routed by projection
  -- appliers (entry_amended, entry_deleted, person_renamed, person_archived,
  -- etc. all key off TargetID). The applier reads these from the envelope
  -- rather than re-parsing the payload, so they MUST round-trip through
  -- push -> events row -> pull / snapshot, otherwise the server projection
  -- silently no-ops on every non-create event.
  target_id             UUID,
  relationship_id       UUID,
  event_type            TEXT NOT NULL,
  schema_version        SMALLINT NOT NULL DEFAULT 1,
  payload               JSONB NOT NULL CHECK (pg_column_size(payload) < 65536),
  server_received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  server_seq            BIGINT NOT NULL,
  redacted_at           TIMESTAMPTZ,
  redacted_reason       TEXT,
  -- DEFENSE-IN-DEPTH: per design hlc_device_id and device_id MUST be
  -- equal at insert time (see plan A4 + the comment block above). The
  -- push handler asserts this; the CHECK is a backstop that prevents a
  -- sloppy future code path from silently inserting divergent values
  -- and breaking audit queries.
  CHECK (device_id = hlc_device_id),
  UNIQUE (vault_id, server_seq)
);

-- Pull path: client asks "give me events for vault X with server_seq > N
-- ordered ASC". This index is the hot path.
CREATE INDEX IF NOT EXISTS idx_events_vault_seq
  ON events(vault_id, server_seq);

-- Audit / debug path: "what did device D do in vault V around HLC time T?".
-- Composite ordering matches HLC's (physical, logical) tiebreaker.
CREATE INDEX IF NOT EXISTS idx_events_vault_device_hlc
  ON events(vault_id, device_id, hlc_physical_ms, hlc_logical);

-- Recently-received path: monitoring / "what landed in the last hour?".
CREATE INDEX IF NOT EXISTS idx_events_vault_recv_at
  ON events(vault_id, server_received_at DESC);

-- Hot pull path with redaction filter: a partial index that covers the
-- exact pull query "WHERE vault_id=? AND server_seq>? AND redacted_at IS
-- NULL ORDER BY server_seq". The plain idx_events_vault_seq above is the
-- fallback for snapshot/audit queries that DO want redacted rows.
CREATE INDEX IF NOT EXISTS idx_events_vault_seq_active
  ON events(vault_id, server_seq) WHERE redacted_at IS NULL;

-- ---------------------------------------------------------------------------
-- vault_snapshots: cached projection of a vault up to a known server_seq.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault_snapshots (
  vault_id          UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  up_to_server_seq  BIGINT NOT NULL,
  snapshot          JSONB NOT NULL CHECK (pg_column_size(snapshot) < 52428800),
  schema_version    SMALLINT NOT NULL,
  byte_size         INTEGER NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (vault_id, up_to_server_seq)
);

-- "Give me the most recent snapshot for vault V" — used by the
-- /v1/sync/snapshot endpoint on new-device bootstrap.
CREATE INDEX IF NOT EXISTS idx_snapshots_vault_recent
  ON vault_snapshots(vault_id, up_to_server_seq DESC);
