-- Ownership invitations are distinct from ordinary member invitations. The
-- recipient must accept with the verified mailbox signed by the current owner.
-- Only token hashes are stored; cancelled/replaced/consumed links never revive.
CREATE TABLE vault_ownership_invites (
  transfer_id UUID PRIMARY KEY,
  vault_id UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  from_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipient_email_normalized TEXT NOT NULL,
  source_member_id BIGINT NOT NULL REFERENCES vault_members(id) ON DELETE CASCADE,
  source_last_change_hlc_ms BIGINT NOT NULL,
  source_updated_at TIMESTAMPTZ NOT NULL,
  authorization_payload JSONB NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES accounts(id) ON DELETE SET NULL,
  event_id UUID UNIQUE REFERENCES events(event_id) ON DELETE SET NULL,
  CHECK (expires_at > created_at - INTERVAL '5 minutes')
);
CREATE UNIQUE INDEX vault_ownership_invites_pending ON vault_ownership_invites(vault_id)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

-- Old local-only genesis IDs could not fit the UUID ACL table. Its direct
-- handover self-demotion therefore reached the signed chain but left the
-- founder's actual seat at Owner. Repair only the exact original anchor's
-- corroborated self-demotion, with a live successor already present.
WITH candidates AS (
 SELECT source.id,source.vault_id,source.account_id,last_alias.hlc_physical_ms
 FROM vaults v JOIN vault_members source ON source.vault_id=v.vault_id
  AND source.account_id=v.owner_account_id AND source.role='owner'
  AND source.accepted_at IS NOT NULL AND source.revoked_at IS NULL
 JOIN LATERAL (
  SELECT payload->>'account_id' AS alias,signer_device_pubkey FROM events
  WHERE vault_id=v.vault_id AND redacted_at IS NULL AND event_type='vault_member_added'
   AND payload->>'role'='owner' AND NULLIF(event_sig_b64,'') IS NOT NULL
  ORDER BY hlc_physical_ms,hlc_logical,hlc_device_id,event_id LIMIT 1
 ) genesis ON genesis.alias ~ '^local:[A-Za-z0-9_-]{16}$'
  AND genesis.signer_device_pubkey=encode(v.vault_trust_anchor_pubkey,'base64')
 JOIN LATERAL (
  SELECT event_type,payload,signer_device_pubkey,event_sig_b64,
   signed_actor_account_id,hlc_physical_ms FROM events
  WHERE vault_id=v.vault_id AND redacted_at IS NULL
   AND COALESCE(local_target_id,target_id::text)=genesis.alias
   AND event_type IN ('vault_member_added','vault_member_role_changed','vault_member_removed')
  ORDER BY hlc_physical_ms DESC,hlc_logical DESC,hlc_device_id DESC,event_id DESC LIMIT 1
 ) last_alias ON last_alias.event_type='vault_member_role_changed'
  AND last_alias.payload->>'role'='editor'
  AND last_alias.signer_device_pubkey=genesis.signer_device_pubkey
  AND NULLIF(last_alias.event_sig_b64,'') IS NOT NULL
  AND (last_alias.signed_actor_account_id IS NULL OR last_alias.signed_actor_account_id=source.account_id)
 WHERE COALESCE(source.last_change_hlc_ms,0)<=last_alias.hlc_physical_ms
 AND EXISTS(SELECT 1 FROM vault_members successor WHERE successor.vault_id=v.vault_id
  AND successor.account_id<>source.account_id AND successor.role='owner'
  AND successor.accepted_at IS NOT NULL AND successor.revoked_at IS NULL)
 AND EXISTS(SELECT 1 FROM device_keys dk JOIN installs i ON i.install_id=dk.install_id
  WHERE dk.ed25519_pubkey=v.vault_trust_anchor_pubkey AND i.account_id=source.account_id
  AND i.account_deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM device_keys dk JOIN installs i ON i.install_id=dk.install_id
  WHERE dk.ed25519_pubkey=v.vault_trust_anchor_pubkey AND i.account_id<>source.account_id
  AND i.account_deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM vault_devices vd WHERE vd.vault_id=v.vault_id
  AND vd.device_pubkey=v.vault_trust_anchor_pubkey AND vd.removed_at_ms IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM events explicit_owner WHERE explicit_owner.vault_id=v.vault_id
  AND explicit_owner.redacted_at IS NULL AND explicit_owner.target_id=source.account_id
  AND explicit_owner.event_type IN ('vault_member_added','vault_member_role_changed')
  AND explicit_owner.payload->>'role'='owner' AND explicit_owner.hlc_physical_ms>=last_alias.hlc_physical_ms)
), repaired AS (
 UPDATE vault_members m SET role='editor',last_change_hlc_ms=c.hlc_physical_ms,updated_at=NOW()
 FROM candidates c WHERE m.id=c.id AND m.role='owner' AND m.revoked_at IS NULL
 AND COALESCE(m.last_change_hlc_ms,0)<=c.hlc_physical_ms
 RETURNING m.vault_id,m.account_id,m.last_change_hlc_ms
)
INSERT INTO vault_audit_log(vault_id,kind,target_id,payload,occurred_at)
SELECT vault_id,'role_changed',account_id,
 '{"from":"owner","to":"editor","source":"legacy_local_owner_repair"}'::jsonb,
 to_timestamp(last_change_hlc_ms::numeric/1000) FROM repaired;

-- Earlier direct chain handovers changed seats but left this pointer at the
-- founder. Repair only pointers whose holder is no longer an active owner;
-- preserve valid co-owner choices and leave ownerless books unchanged.
UPDATE vaults v SET owner_account_id=(
 SELECT account_id FROM vault_members m WHERE m.vault_id=v.vault_id
 AND m.role='owner' AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
 ORDER BY m.last_change_hlc_ms DESC NULLS LAST,m.id DESC LIMIT 1)
WHERE NOT EXISTS(SELECT 1 FROM vault_members m WHERE m.vault_id=v.vault_id
 AND m.account_id=v.owner_account_id AND m.role='owner'
 AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
AND EXISTS(SELECT 1 FROM vault_members m WHERE m.vault_id=v.vault_id
 AND m.role='owner' AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL);
