-- 021_shared_ledger.sql
--
-- Schema for the web-first, server-backed SHARED LEDGER (docs/shared-ledger-spec.md
-- §4) — a single mutual two-party tab (e.g. shop ⇄ dairy) that both sides see and
-- agree on, rendered on the website. This is independent of the mobile local-first
-- ledger and the existing vault/event-sync machinery: a plain append-only model
-- with a per-ledger monotonic sequence is enough for two online parties + a server.
--
-- Adding this migration makes the backend schema READY for the shared-ledger
-- feature (Matee: "is the schema ready for ledger sharing online?"). The API +
-- web page (spec §6-§8) build on top of these tables; no code references them yet,
-- so this is a clean, additive, no-data-migration change. gen_random_uuid() is
-- built into Postgres 13+.

CREATE TABLE IF NOT EXISTS shared_ledgers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,                       -- "Rent ⇄ Dairy"
  currency      TEXT NOT NULL DEFAULT 'AFN',
  party_a_label TEXT NOT NULL,                       -- creator's name for themselves
  party_b_label TEXT,                                -- set when B claims the invite
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ
);

-- One row per side. Access = possession of the capability token whose SHA-256 hash
-- is stored here; the raw token lives only in the URL + the holder's localStorage
-- (mirrors the existing vault-invite token pattern). account_id is reserved for the
-- Phase-2 identity binding (Google JWT / phone OTP) — null for the capability-link MVP.
CREATE TABLE IF NOT EXISTS shared_ledger_access (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    UUID NOT NULL REFERENCES shared_ledgers(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('a', 'b')),
  token_hash   BYTEA NOT NULL UNIQUE,
  account_id   TEXT,
  claimed_at   TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  UNIQUE (ledger_id, role)
);

-- Append-only entries. `direction` is ABSOLUTE (who gave value to whom) so each
-- side renders its own signed balance with no "relative to me" ambiguity. A
-- correction is a NEW entry that references the one it voids — never a silent
-- edit/delete (dispute-proof audit trail). Money is integer minor units; AFN has
-- no commonly-used minor unit so v1 stores whole AFN. Never floats.
CREATE TABLE IF NOT EXISTS shared_ledger_entries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id    UUID NOT NULL REFERENCES shared_ledgers(id) ON DELETE CASCADE,
  seq          BIGINT NOT NULL,                       -- per-ledger monotonic; ordering + sync cursor
  created_by   TEXT NOT NULL CHECK (created_by IN ('a', 'b')),
  direction    TEXT NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  kind         TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'cash', 'adjustment')),
  note         TEXT,
  voids_entry  UUID REFERENCES shared_ledger_entries(id),  -- correction = append, never delete
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ledger_id, seq)
);

-- Tail-by-seq is the "sync" (spec §8): the live page polls/streams entries after a
-- cursor; this index serves both the ordered read and the next-seq computation.
CREATE INDEX IF NOT EXISTS idx_shared_ledger_entries_ledger_seq
  ON shared_ledger_entries (ledger_id, seq);
