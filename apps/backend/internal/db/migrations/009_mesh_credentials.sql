-- 009_mesh_credentials.sql
--
-- Phase 5: peer-to-peer mesh sync infrastructure.
--
-- device_keys
--   Per-install Ed25519 public key, registered via POST /v1/devices/register-key.
--   The matching private key lives in expo-secure-store on the device and never
--   leaves it. Used by the server to BIND a VMC (Vault Membership Credential)
--   to a specific install — a leaked VMC blob is unusable by any other device
--   because mesh peers verify the embedded device_pubkey against the peer's
--   actual signing key during handshake.
--
--   Idempotent UPSERT keyed on install_id. No FK to installs(install_id) is
--   strictly required (registration may arrive before the first check-in row
--   in some race orderings), but we add ON DELETE CASCADE so a future GDPR
--   "delete this install" sweep tears down the key alongside the install row.
--
-- vault_credentials_issued
--   Append-only ledger of every VMC the server has signed. Used for:
--     a) revocation: vaults/service.go (ChangeRole, Revoke, Leave,
--        TransferOwnership) stamps revoked_at on each active row for the
--        affected (vault, account/install); /v1/check-in returns the
--        revocations[] delta on the next ping.
--     b) renewal: re-IssueVMC appends a NEW row rather than mutating older
--        ones, so the full issuance history is reconstructible for audit.
--        Mesh peers cache only the latest blob locally.
--
-- vaults.vault_epoch already exists from 006; no ALTER needed here.

CREATE TABLE IF NOT EXISTS device_keys (
  install_id     UUID PRIMARY KEY REFERENCES installs(install_id) ON DELETE CASCADE,
  ed25519_pubkey BYTEA NOT NULL,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT device_keys_pubkey_len CHECK (octet_length(ed25519_pubkey) = 32)
);

CREATE TABLE IF NOT EXISTS vault_credentials_issued (
  id          BIGSERIAL PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(vault_id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  install_id  UUID NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  vault_epoch BIGINT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);

-- Revocation sweep by (vault, install) when role changes or member is revoked.
CREATE INDEX IF NOT EXISTS idx_vci_vault_install
  ON vault_credentials_issued(vault_id, install_id);

-- /v1/check-in revocations[] delta: "show me revoked-since-T for this vault".
CREATE INDEX IF NOT EXISTS idx_vci_vault_revoked_at
  ON vault_credentials_issued(vault_id, revoked_at)
  WHERE revoked_at IS NOT NULL;

-- Active-credential lookup: renewal path's "do we have a live VMC?" query.
CREATE INDEX IF NOT EXISTS idx_vci_active
  ON vault_credentials_issued(vault_id, install_id)
  WHERE revoked_at IS NULL;

-- Per-account sweep (e.g. account-wide unlink): revoke every active credential
-- this account holds across all vaults.
CREATE INDEX IF NOT EXISTS idx_vci_account_active
  ON vault_credentials_issued(account_id, vault_id)
  WHERE revoked_at IS NULL;
