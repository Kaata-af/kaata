-- 010_vault_pair_tokens.sql
--
-- Phase 5 mesh follow-up: server-side enforcement of the same-account multi-
-- device QR pairing flow.
--
-- Background. The owner-side `app/vault/pair.tsx` generates a QR encoding
-- {vault_id, vault_name, issuer_account_id, issuer_install_id, issued_at_ms,
-- expires_at_ms, shop_mode_token}. Until this migration the server side of
-- /v1/vaults/:vault_id/credential authorised solely by JWT (account_id), which
-- made the 5-minute expiry purely client-advisory: a captured QR was usable
-- forever, provided the attacker controlled the scanner's clock and held a
-- Google session for the same account. The QR's `shop_mode_token` was an
-- unused field — the security/crypto review flagged this.
--
-- This migration adds a server-side single-use ticket table:
--
--   1. The OWNER's pair.tsx, immediately after generating the QR locally,
--      POSTs (token, vault_id, expires_at_ms) to /v1/vaults/:vault_id/pair-tokens.
--      The server stores the token_hash (SHA-256 of the URL-safe token bytes
--      so the plaintext never sits in the DB), the vault_id, the issuer's
--      install_id (taken from JWT claims), and an expires_at.
--
--   2. The SCANNER's pair-scan.tsx forwards (pair_token, pair_issued_at_ms)
--      in the body of /v1/vaults/:vault_id/credential. The handler:
--        - SELECTs the row WHERE token_hash = sha256(token) AND vault_id =
--          path AND expires_at > NOW() AND consumed_at IS NULL.
--        - UPDATE consumed_at = NOW() RETURNING id (single-use enforcement).
--        - 401 / 403 otherwise.
--
-- The token plaintext never persists on the backend; only its SHA-256 hash
-- does. Plaintext lives on the issuer phone briefly (until consumed), on
-- the scanner phone briefly (until consumed), and on the wire briefly inside
-- TLS — exactly the same trust boundary as invite tokens (migration 008).
--
-- Schema choices.
--   - token_hash BYTEA PRIMARY KEY: cheap to scan by hash; exact-match
--     lookup, no enumeration possible.
--   - vault_id REFERENCES vaults: a pair token for a purged vault is auto-
--     deleted by the existing ON DELETE CASCADE chain in vaults.
--   - consumed_at TIMESTAMPTZ NULL: NULL means "still spendable". A separate
--     state column (vs. DELETE on consume) preserves a forensic trail of
--     which install consumed which token without needing an audit-log row.
--   - expires_at TIMESTAMPTZ NOT NULL: the QR's 5-minute window. A nightly
--     vacuum could DELETE expired rows; we don't need to today (low volume).
--   - issuer_install_id is informational — present in case a future debug
--     UI wants "you issued 3 tokens, 1 consumed".

CREATE TABLE IF NOT EXISTS vault_pair_tokens (
  token_hash         BYTEA PRIMARY KEY,
  vault_id           UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  issuer_account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issuer_install_id  UUID NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  consumed_by_install_id UUID,
  CONSTRAINT vault_pair_tokens_hash_len CHECK (octet_length(token_hash) = 32)
);

-- Sweep stale tokens.
CREATE INDEX IF NOT EXISTS idx_vpt_expires_at
  ON vault_pair_tokens(expires_at)
  WHERE consumed_at IS NULL;

-- Per-issuer view: "tokens I issued for this vault".
CREATE INDEX IF NOT EXISTS idx_vpt_issuer_vault
  ON vault_pair_tokens(issuer_account_id, vault_id);
