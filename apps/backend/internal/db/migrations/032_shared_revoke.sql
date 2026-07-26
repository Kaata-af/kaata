-- Migration 032: revocable shared-ledger links (security hardening pass,
-- 2026-07-26).
--
-- /v1/shared links carry real customer PII (name, balance, transaction
-- history) behind an unguessable 96-bit token — but once sent, a link could
-- not be killed before its TTL. A shopkeeper who shares the wrong person's
-- ledger, or falls out with a customer, needs an undo.
--
-- revoke_secret_hash: SHA-256 of a second 96-bit crypto/rand secret minted
-- at create time and returned ONLY to the creating device (which stores it
-- locally). POST /v1/shared/{token}/revoke presents the plaintext secret;
-- the server compares hashes in constant time and deletes the row. Storing
-- the hash (not the secret) means a DB leak cannot forge revocations —
-- consistent with invite tokens' hash-at-rest discipline.
--
-- NULL for legacy rows (created before this migration): those cannot be
-- revoked — no proof-of-creator exists for them — and age out via TTL.

ALTER TABLE shared_ledger_snapshots
  ADD COLUMN IF NOT EXISTS revoke_secret_hash BYTEA;
