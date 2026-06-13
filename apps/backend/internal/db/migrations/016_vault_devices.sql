-- M2 membership chain (docs/m2-membership-chain.md §8.2): vault_devices.
--
-- Server-side fold target for the new vault_device_added / vault_device_removed
-- membership events. One row per (vault, device) binding: which Ed25519 device
-- pubkey belongs to which account inside which vault. The push path verifies
-- membership events against the vault trust anchor / bound owner devices /
-- server witnesses, then folds accepted events into this table — making it
-- the server's device registry counterpart of the chain every mobile replica
-- folds locally.
--
-- Design notes:
--   * account_id is a plain UUID with NO foreign key to accounts(id).
--     Server-side pushes always come from JWT-authenticated accounts (real
--     UUIDs), but the chain may name accounts the server has not (yet) seen
--     an accounts row for; an FK would turn a chain-valid event into a
--     500-ing tx abort. Local-only sentinel ids ('local:<...>') never reach
--     the server — they have no JWT to push with — so UUID is the right type.
--   * added_at_ms / removed_at_ms are the HLC physical_ms of the folding
--     events (NOT server wall clock) so the registry's timeline matches the
--     deterministic chain fold on every replica.
--   * Re-adding a removed device is an UPSERT that clears removed_at_ms and
--     refreshes device_pubkey / account_id / added_at_ms — the chain's
--     latest-bind-wins semantics.
--   * No FK CASCADE games on vaults: the archive purge stamps vaults rows
--     rather than deleting them, so plain REFERENCES suffices.

CREATE TABLE IF NOT EXISTS vault_devices (
  vault_id      UUID NOT NULL REFERENCES vaults(vault_id),
  device_id     UUID NOT NULL,
  device_pubkey BYTEA NOT NULL,
  account_id    UUID NOT NULL,
  added_at_ms   BIGINT NOT NULL,
  removed_at_ms BIGINT,
  PRIMARY KEY (vault_id, device_id),
  CONSTRAINT vault_devices_pubkey_len CHECK (octet_length(device_pubkey) = 32)
);

-- Push-side authorization lookup: "is this signer pubkey a bound device of
-- this vault, and whose account is it?" — the hot path of membership-event
-- verification.
CREATE INDEX IF NOT EXISTS idx_vault_devices_vault_pubkey
  ON vault_devices(vault_id, device_pubkey);

-- member_removed fold: "remove every device bound to this account".
CREATE INDEX IF NOT EXISTS idx_vault_devices_vault_account
  ON vault_devices(vault_id, account_id);
