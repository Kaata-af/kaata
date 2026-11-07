-- An account-targeted invitation is not a membership until it is accepted.
-- Keep account_id NULL while pending: existing ACL queries must never treat
-- receiving a request as joining a kaata. The UUID is a locator, not a secret.
ALTER TABLE vault_members
  ADD COLUMN invite_account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN invite_request_id UUID,
  ADD CONSTRAINT vault_members_account_invite_shape CHECK (
    (invite_account_id IS NULL AND invite_request_id IS NULL)
    OR (invite_account_id IS NOT NULL AND invite_request_id IS NOT NULL
      AND invite_email IS NULL AND invite_token_hash IS NULL
      AND invite_expires_at IS NOT NULL
      AND (account_id IS NULL OR account_id = invite_account_id))
  );

CREATE UNIQUE INDEX idx_vault_members_invite_request
  ON vault_members(invite_request_id) WHERE invite_request_id IS NOT NULL;
CREATE UNIQUE INDEX idx_vault_members_pending_account_invite
  ON vault_members(vault_id, invite_account_id)
  WHERE invite_account_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_vault_members_account_invite_inbox
  ON vault_members(invite_account_id, invited_at DESC)
  WHERE invite_account_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
