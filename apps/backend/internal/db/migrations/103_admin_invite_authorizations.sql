-- Admin admission needs durable owner-device intent, in addition to the server
-- witness. A lower-role invitation later promoted to Admin has no such proof.
ALTER TABLE vault_members ADD COLUMN admin_authorization JSONB;
ALTER TABLE vault_members ADD COLUMN admin_invite_owner_member_id BIGINT;
ALTER TABLE vault_members ADD COLUMN admin_invite_owner_change_ms BIGINT;
ALTER TABLE vault_members ADD COLUMN admin_invite_owner_updated_at TIMESTAMPTZ;
ALTER TABLE vault_members ADD COLUMN admin_invite_event_id UUID;
CREATE UNIQUE INDEX vault_members_admin_grant_id_unique
 ON vault_members ((admin_authorization->'grant'->>'grant_id'))
 WHERE admin_authorization IS NOT NULL;

ALTER TABLE vault_members ADD CONSTRAINT vault_members_admin_invite_shape CHECK (
 (admin_authorization IS NULL AND admin_invite_owner_member_id IS NULL
  AND admin_invite_owner_change_ms IS NULL AND admin_invite_owner_updated_at IS NULL
  AND admin_invite_event_id IS NULL)
 OR (admin_authorization IS NOT NULL AND admin_invite_owner_member_id IS NOT NULL
  AND admin_invite_owner_change_ms IS NOT NULL AND admin_invite_owner_updated_at IS NOT NULL
  AND admin_authorization#>>'{grant,domain}'='kaata-admin-invite-v1'
  AND admin_authorization#>>'{grant,role}'='manager'
  AND (admin_invite_event_id IS NULL OR (accepted_at IS NOT NULL
    AND admin_invite_event_id::text=admin_authorization#>>'{grant,grant_id}'
    AND account_id::text=admin_authorization#>>'{grant,recipient_account_id}')))
);

-- Returning Admins use the existing recipient-consent plus fresh owner-signed
-- member/device re-admission. A server witness still cannot resurrect them.
ALTER TABLE vault_members DROP CONSTRAINT vault_members_readmission_shape;
ALTER TABLE vault_members ADD CONSTRAINT vault_members_readmission_shape CHECK (
 (readmission_from_id IS NULL AND readmission_owner_member_id IS NULL AND readmission_owner_change_ms IS NULL
  AND readmission_consented_at IS NULL AND readmission_install_id IS NULL
  AND readmission_device_pubkey IS NULL AND readmission_after_ms IS NULL
  AND readmission_member_event_id IS NULL AND readmission_device_event_id IS NULL)
 OR (readmission_from_id IS NOT NULL AND readmission_owner_member_id IS NOT NULL AND readmission_owner_change_ms IS NOT NULL
  AND invite_request_id IS NOT NULL AND invite_account_id IS NOT NULL
  AND (accepted_at IS NOT NULL OR role IN ('manager','editor','clerk','viewer'))
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
