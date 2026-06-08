-- Phase 7: vault_trust_anchor_pubkey — local-CA mesh trust anchor.
--
-- Mirror of mobile migration 012. The server stores this purely as a
-- pass-through field served on GET /v1/vaults so a freshly-restored
-- device (which has no mesh state yet but does have a server session)
-- learns the trust anchor before its first mesh handshake.
--
-- The server does NOT verify VMCs against this column — VMC verification
-- is peer-to-peer in the mesh handshake. The column is informational
-- from the server's standpoint: a directory entry so new devices learn
-- which pubkey to trust.
--
-- Semantics:
--   NULL    — server-anchored vault (Phase 5 back-compat). Peers fall
--             back to the pinned server pubkey.
--   non-NULL — local-anchored vault (Phase 7+). 32 raw bytes of an
--             Ed25519 public key. The mobile client base64-encodes
--             before writing to its own vaults.vault_trust_anchor_pubkey
--             column and before publishing in the pair QR.
--
-- Storage choice: BYTEA over TEXT. Ed25519 pubkeys are 32 raw bytes;
-- BYTEA is the natural fit and saves the base64 round-trip on every
-- query. The handler accepts base64 on the wire (consistent with the
-- mobile-side TEXT encoding) and decodes on write / encodes on read.
--
-- CHECK octet_length = 32 prevents accidental writes of garbage or
-- of a base64-encoded value into a BYTEA column.

ALTER TABLE vaults
  ADD COLUMN vault_trust_anchor_pubkey BYTEA
    CHECK (vault_trust_anchor_pubkey IS NULL OR octet_length(vault_trust_anchor_pubkey) = 32);

COMMENT ON COLUMN vaults.vault_trust_anchor_pubkey IS
  'Phase 7 local-CA Ed25519 pubkey (32 raw bytes). NULL = server-anchored vault (Phase 5 back-compat). Set at vault creation by the owner device; immutable thereafter. Published in GET /v1/vaults and in mesh pair QR so peers learn which pubkey to verify VMCs against.';
