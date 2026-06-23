-- Migration 024: shared ledger snapshots ("see the full ledger on kaata.af").
--
-- When a shopkeeper taps the WhatsApp ping, the mobile app POSTs a small
-- read-only snapshot of one person's ledger (shop name, person name, balance,
-- the list of entries) to POST /v1/shared and gets back a short opaque token.
-- The WhatsApp message links to kaata.af/v/<token>; the web client fetches
-- GET /v1/shared/<token> and renders the full list (the backend only stores +
-- serves the small packet, and SSRs a tiny preview shell for the link).
--
-- The payload is JSONB (validated/size-capped at the handler). Rows expire
-- (expires_at) so the table self-prunes; a viewer can't enumerate tokens
-- (opaque random) and the link is unauthenticated by design (it's a share).
CREATE TABLE IF NOT EXISTS shared_ledgers (
  token       TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Hot path: GET by token (PK already covers it). This index supports the
-- periodic expiry prune (DELETE WHERE expires_at < NOW()).
CREATE INDEX IF NOT EXISTS idx_shared_ledgers_expires
  ON shared_ledgers (expires_at);
