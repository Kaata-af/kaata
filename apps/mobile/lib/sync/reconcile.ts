// Vault registration reconcile + all-vault backup sweep.
//
// THE BUG THIS FIXES (data loss on reinstall): a vault reached the server only
// via (a) pending_vault_registration at sign-in — the ACTIVE vault only — or
// (b) a fire-and-forget POST in vault/new.tsx that had no retry and never
// stamped registered_with_server_at. Any vault that wasn't the active one at
// sign-in, or whose create-time POST failed/never fired (created offline, or
// created before sign-in), ended up with registered_with_server_at IS NULL and
// no vault_members row server-side. Consequences: every push 403s forever in
// silent backoff (push.ts), GET /v1/vaults omits it, and on reinstall recovery
// finds nothing — the local SQLite was the only copy. Total silent loss.
//
// reconcileVaultRegistrations() durably registers every such vault (idempotent
// POST /v1/vaults; 409 = already there = success) and stamps the column. The
// scheduler also only ever synced the ACTIVE vault, so fullBackupSweep() pulls
// + pushes EVERY registered vault, not just the active one — otherwise a
// non-active vault's tallies still never leave the device.
//
// SCOPE: we only register vaults THIS DEVICE OWNS — vault_trust_anchor_pubkey
// equals our device pubkey. Self-created vaults (createSelfProfile + vault/new)
// always set our pubkey as the anchor; joined vaults (pair-scan / invite) pin
// the OWNER's foreign anchor and get their server membership through the invite/
// witness flow, NOT through POST /v1/vaults — so registering them here would be
// wrong (it'd 409 against the real owner's vault). Archived own vaults ARE
// included: a user can unarchive, and their data must survive a reinstall.
//
// Everything here is best-effort and idempotent: one vault failing never aborts
// the others, and no local data is ever deleted or overwritten.

import * as Network from "expo-network";

import { getSessionJWT } from "../auth";
import {
  getAccountIdSync,
  getActiveVaultIdSyncMaybe,
  getDb,
  refreshAccountIdCache,
} from "../db-tx";
import { createVaultOnServer } from "../vault-api";
import { pullEvents } from "./pull";
import { pushEvents } from "./push";

type OwnedVault = {
  id: string;
  name: string;
  currency: string | null;
  created_at: number;
  vault_trust_anchor_pubkey: string | null;
  account_id: string | null;
};

// Register every local vault THIS DEVICE OWNS that has no server registration
// yet. Stamps registered_with_server_at on success and back-fills account_id on
// vaults created before sign-in (account_id was NULL then). Idempotent.
export async function reconcileVaultRegistrations(): Promise<void> {
  // Resolve the account id robustly — never proceed with a null id (stamping a
  // vault with a null account_id makes it invisible to account-scoped queries:
  // the mechanism-B data-loss path the audit flagged). Cache can be cold, so
  // fall back to app_meta before giving up.
  let accountId = getAccountIdSync();
  if (!accountId) accountId = await refreshAccountIdCache();
  if (!accountId) return; // not signed in → nothing to register

  const jwt = await getSessionJWT();
  if (!jwt) return;

  // Our device pubkey is the "we own this vault" signal. Ensure the key is
  // loaded first; without it we can't tell our vaults from joined ones, so we
  // skip this pass (the next sweep, after the key loads, picks them up).
  const { ensureDeviceKey, getDevicePubkey } = await import("../mesh/device-key");
  try {
    await ensureDeviceKey();
  } catch {
    return;
  }
  const ourPubkey = getDevicePubkey();
  if (!ourPubkey) return;

  const db = await getDb();
  // NOTE: archived own vaults are intentionally INCLUDED — unarchive is a real
  // flow and their data must survive a reinstall.
  const rows = await db.getAllAsync<OwnedVault>(
    `SELECT id, name, currency, created_at, vault_trust_anchor_pubkey, account_id
       FROM vaults
      WHERE registered_with_server_at IS NULL
        AND vault_trust_anchor_pubkey = ?`,
    ourPubkey,
  );

  for (const v of rows) {
    try {
      await createVaultOnServer({
        vault_id: v.id,
        name: v.name,
        currency: v.currency || "AFN",
        created_at_ms: v.created_at,
        vault_trust_anchor_pubkey: v.vault_trust_anchor_pubkey,
      });
      const now = Date.now();
      // Stamp registered + back-fill account_id (COALESCE leaves an already-set
      // owner account untouched — never nulls a column that was set).
      await db.runAsync(
        `UPDATE vaults
            SET registered_with_server_at = COALESCE(registered_with_server_at, ?),
                account_id                = COALESCE(account_id, ?),
                updated_at                = ?
          WHERE id = ?`,
        now,
        accountId,
        now,
        v.id,
      );
    } catch (err) {
      // Offline / 5xx / transient — leave registered_with_server_at NULL so the
      // next sweep retries. Never fatal.
      console.warn("[reconcile] register failed for", v.id.slice(0, 8), err);
    }
  }
}

// Reconcile registrations, then pull+push every registered vault that still
// needs it — EXCLUDING the active vault (the scheduler's per-tick syncOnce
// already covers it, so syncing it here would just double request volume). A
// vault is swept if it's non-archived OR still has unacked outbox rows (so an
// archived vault with pending tallies drains to the server before any purge,
// without re-syncing fully-acked archived vaults forever). Best-effort and
// self-contained: it swallows per-vault errors so the scheduler can
// fire-and-forget it without touching its backoff state.
export async function fullBackupSweep(): Promise<void> {
  const jwt = await getSessionJWT();
  if (!jwt) return;
  const net = await Network.getNetworkStateAsync();
  if (!net.isConnected) return;

  await reconcileVaultRegistrations();

  const db = await getDb();
  const vaults = await db.getAllAsync<{ id: string }>(
    `SELECT v.id
       FROM vaults v
      WHERE v.registered_with_server_at IS NOT NULL
        AND (
          v.archived_at IS NULL
          OR EXISTS (
            SELECT 1 FROM event_log e
             WHERE e.vault_id = v.id
               AND e.server_acked_at IS NULL
               AND e.rejected_at IS NULL
               AND e.tombstone_reason IS NULL
          )
        )`,
  );

  const activeId = getActiveVaultIdSyncMaybe();
  for (const v of vaults) {
    if (v.id === activeId) continue; // the per-tick syncOnce already covers it
    try {
      // Pull-then-push, the order the scheduler enforces.
      await pullEvents(v.id);
      await pushEvents(v.id);
    } catch (err) {
      console.warn("[sweep] vault sync failed", v.id.slice(0, 8), err);
    }
  }
}
