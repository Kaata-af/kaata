-- Returning members need recipient consent and fresh owner-signed member AND
-- device events. A pending/consented row deliberately has no account_id or
-- accepted_at, so neither a request nor consent grants access.
ALTER TABLE vault_members
  -- These are snapshots, not lifetime ownership dependencies. Deleting an old
  -- owner/source seat must not cascade-delete an already returned member.
  ADD COLUMN readmission_from_id BIGINT,
  ADD COLUMN readmission_owner_member_id BIGINT,
  ADD COLUMN readmission_owner_change_ms BIGINT,
  ADD COLUMN readmission_consented_at TIMESTAMPTZ,
  ADD COLUMN readmission_install_id UUID,
  ADD COLUMN readmission_device_pubkey BYTEA,
  ADD COLUMN readmission_after_ms BIGINT,
  ADD COLUMN readmission_member_event_id UUID,
  ADD COLUMN readmission_device_event_id UUID,
  ADD CONSTRAINT vault_members_readmission_shape CHECK (
    (readmission_from_id IS NULL AND readmission_owner_member_id IS NULL AND readmission_owner_change_ms IS NULL
      AND readmission_consented_at IS NULL AND readmission_install_id IS NULL
      AND readmission_device_pubkey IS NULL AND readmission_after_ms IS NULL
      AND readmission_member_event_id IS NULL AND readmission_device_event_id IS NULL)
    OR (readmission_from_id IS NOT NULL AND readmission_owner_member_id IS NOT NULL AND readmission_owner_change_ms IS NOT NULL
      AND invite_request_id IS NOT NULL AND invite_account_id IS NOT NULL
      AND (accepted_at IS NOT NULL OR role IN ('editor','clerk','viewer'))
      AND ((readmission_consented_at IS NULL AND readmission_install_id IS NULL
          AND readmission_device_pubkey IS NULL AND readmission_after_ms IS NULL)
        OR (readmission_consented_at IS NOT NULL AND readmission_install_id IS NOT NULL
          AND readmission_device_pubkey IS NOT NULL AND octet_length(readmission_device_pubkey)=32
          AND readmission_after_ms IS NOT NULL AND readmission_after_ms>=0))
      AND ((accepted_at IS NULL AND account_id IS NULL
          AND readmission_member_event_id IS NULL AND readmission_device_event_id IS NULL)
        OR (accepted_at IS NOT NULL AND account_id=invite_account_id
          AND readmission_consented_at IS NOT NULL
          AND ((readmission_member_event_id IS NULL AND readmission_device_event_id IS NULL)
            OR (readmission_member_event_id IS NOT NULL AND readmission_device_event_id IS NOT NULL)))))
  );

CREATE INDEX idx_vault_members_ready_readmission ON vault_members(vault_id,invited_by)
  WHERE readmission_consented_at IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
