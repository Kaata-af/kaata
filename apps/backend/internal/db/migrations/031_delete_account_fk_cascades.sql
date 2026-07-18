-- Migration 031: unblock DELETE /v1/account — FK actions the schema outgrew.
--
-- DeleteAccount (auth/service.go) hard-deletes the vaults an account OWNS,
-- relying on ON DELETE CASCADE to clear everything under them. Two FKs never
-- got the memo:
--
-- 1. vault_devices.vault_id (migration 016) was created as a plain
--    REFERENCES on the reasoning "the archive purge stamps vaults rows
--    rather than deleting them" — which missed that DeleteAccount DOES
--    delete vaults rows. Prod symptom (2026-07-18): every account deletion
--    by an owner of an anchored vault 500s with
--      update or delete on table "vaults" violates foreign key constraint
--      "vault_devices_vault_id_fkey"
--    and the whole deletion tx rolls back ("check your connection" on
--    mobile). Device rows are the ACL mirror of the membership chain; a
--    deleted vault has no chain, so CASCADE is correct.
--
-- 2. vault_audit_log.actor_id / target_id → accounts default to NO ACTION.
--    Audit rows in vaults the account OWNS cascade away with the vault, but
--    rows in OTHER people's vaults name the account too (invite_accepted /
--    member_left / fold-written member_revoked + role_changed target the
--    member) — so any member of someone else's kaata is blocked from
--    deleting their account at the final DELETE FROM accounts. SET NULL:
--    the audit history must outlive the account (it belongs to the vault
--    owner), with the departed principal anonymised — the same posture
--    DeleteAccount already takes when it nulls vault_members.invited_by /
--    revoked_by. Both columns are nullable and readers already handle NULL
--    actors (writeFoldAudit inserts them; roleAtHLC keys on target_id only
--    for live accounts).

ALTER TABLE vault_devices
  DROP CONSTRAINT IF EXISTS vault_devices_vault_id_fkey;
ALTER TABLE vault_devices
  ADD CONSTRAINT vault_devices_vault_id_fkey
  FOREIGN KEY (vault_id) REFERENCES vaults(vault_id) ON DELETE CASCADE;

ALTER TABLE vault_audit_log
  DROP CONSTRAINT IF EXISTS vault_audit_log_actor_id_fkey;
ALTER TABLE vault_audit_log
  ADD CONSTRAINT vault_audit_log_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE vault_audit_log
  DROP CONSTRAINT IF EXISTS vault_audit_log_target_id_fkey;
ALTER TABLE vault_audit_log
  ADD CONSTRAINT vault_audit_log_target_id_fkey
  FOREIGN KEY (target_id) REFERENCES accounts(id) ON DELETE SET NULL;
