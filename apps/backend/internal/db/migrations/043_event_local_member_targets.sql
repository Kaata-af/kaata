-- Pre-sign-in genesis targets are local:<16 base64url characters>, not UUIDs.
-- Preserve that SIGNED envelope verbatim without changing existing UUID columns,
-- rewriting history, or inventing a server account/ACL seat for the sentinel.
ALTER TABLE events ADD COLUMN local_target_id TEXT;
ALTER TABLE events ADD CONSTRAINT events_local_target_shape CHECK (
  local_target_id IS NULL OR (
    target_id IS NULL
    AND local_target_id ~ '^local:[A-Za-z0-9_-]{16}$'
    AND event_type IN ('vault_member_added', 'vault_member_role_changed', 'vault_member_removed')
    AND payload->>'account_id' IS NOT NULL
    AND local_target_id = payload->>'account_id'
    AND NULLIF(event_sig_b64, '') IS NOT NULL
    AND NULLIF(signer_device_pubkey, '') IS NOT NULL
  )
);
