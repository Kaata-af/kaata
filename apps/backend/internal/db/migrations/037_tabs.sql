-- 037: mutual tab (Kaata 2.0, 2026-09-21). See docs/mutual-tab-design.md.
--
-- One running account shared by two independent parties — a shopkeeper and a
-- counterparty who may be another Kaata user or a person with only a browser.
-- The SERVER is the source of truth (design D1): two parties plus a server
-- needs no CRDT, so this is a plain append-only model with a per-tab
-- monotonic `seq` (creation order) and `rev` (the client pull cursor, bumped
-- on EVERY change including status flips and voids).
--
-- Named tabs / tab_parties / tab_entries on purpose. The obvious name,
-- shared_ledgers, is poisoned: 021 created a two-party schema under it, 024's
-- CREATE TABLE IF NOT EXISTS silently no-op'd against that table and the
-- following CREATE INDEX aborted the whole boot chain in production, 025
-- renamed the bill store to shared_ledger_snapshots and 029 dropped the
-- orphans. Nothing in 001-036 references any of the three names below.
--
-- FK posture follows 031: a party's account_id / vault_id SET NULL on
-- deletion so the OTHER party keeps a two-party record one side does not own;
-- everything under a tab CASCADEs with it.
--
-- Money is amount_minor BIGINT (integer hundredths) — the wire carries a
-- decimal string in major units and Go does integer arithmetic only (D16).
-- Never floats.

CREATE TABLE tabs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency    TEXT NOT NULL,
  rev         BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ,
  closed_by   TEXT CHECK (closed_by IN ('a','b'))
);

CREATE TABLE tab_parties (
  tab_id          UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('a','b')),
  label           TEXT NOT NULL DEFAULT '',
  token_hash      TEXT NOT NULL UNIQUE,            -- hex(sha256(token)), vaults.hashInviteToken shape
  account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
  vault_id        UUID REFERENCES vaults(vault_id) ON DELETE SET NULL,
  relationship_id UUID,                            -- mobile relationships.id (opaque here)
  install_id      UUID,                            -- last device that acted as this party (push, later)
  joined_at       TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  PRIMARY KEY (tab_id, role)
);
CREATE INDEX idx_tab_parties_account ON tab_parties(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX idx_tab_parties_vault   ON tab_parties(vault_id)   WHERE vault_id IS NOT NULL;

CREATE TABLE tab_entries (
  id                 UUID PRIMARY KEY,             -- client-supplied (idempotency); server mints for 'opening'
  tab_id             UUID NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  seq                BIGINT NOT NULL,
  rev                BIGINT NOT NULL,
  created_by         TEXT NOT NULL CHECK (created_by IN ('a','b')),
  direction          TEXT NOT NULL CHECK (direction IN ('a_to_b','b_to_a')),
  amount_minor       BIGINT NOT NULL CHECK (amount_minor > 0),
  kind               TEXT NOT NULL DEFAULT 'entry' CHECK (kind IN ('entry','opening','void')),
  note               TEXT,
  occurred_at_ms     BIGINT NOT NULL,              -- author's date, epoch ms (render-time calendar only)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','disputed')),
  status_at_ms       BIGINT,
  dispute_reason     TEXT,
  voids_entry_id     UUID REFERENCES tab_entries(id),   -- set on kind='void' rows
  voided_by_entry_id UUID REFERENCES tab_entries(id),   -- set on the voided original
  UNIQUE (tab_id, seq)
);
CREATE INDEX idx_tab_entries_tab_rev ON tab_entries(tab_id, rev);
