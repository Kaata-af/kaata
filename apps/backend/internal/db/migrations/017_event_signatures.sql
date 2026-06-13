-- M2 membership chain (docs/m2-membership-chain.md §2): event signature
-- wire + storage.
--
-- Mobile events have carried Ed25519 author signatures since Phase 8
-- (lib/event-sig.ts: canonical-JSON over the envelope+payload, signed by the
-- author's device key), but the push wire never transported them to the
-- server. M2 adds OPTIONAL event_sig_b64 / signer_device_pubkey fields to
-- the push wire event, persists them here, and returns them on pull and on
-- the snapshot tail — so the server replica relays the proof material every
-- other replica needs to verify the membership chain (and, later, ledger
-- events) end-to-end.
--
-- Both columns are NULLable TEXT holding the exact base64 wire form:
--   * event_sig_b64        — std-base64 of the 64-byte Ed25519 signature.
--   * signer_device_pubkey — std-base64 of the signer's 32-byte device
--                            pubkey (same encoding as device_keys, VMCs,
--                            and the mobile wire).
-- Old clients omit both; their rows stay NULL forever (legacy events are
-- ACL'd by the JWT + roleAtHLC path exactly as before M2). Storing the
-- base64 text verbatim keeps pull a pure round-trip — no decode/encode in
-- the hot path; verification decodes once at push time.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS event_sig_b64 TEXT,
  ADD COLUMN IF NOT EXISTS signer_device_pubkey TEXT;
