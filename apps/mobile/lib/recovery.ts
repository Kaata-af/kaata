// lib/recovery.ts
//
// M5 — multi-vault, provider-agnostic recovery (docs/m5-recovery.md §3.2). The
// "one year of data" promise: a factory-reset phone that signs in (Google now,
// OTP later — both resolve to the same account_id) gets EVERY vault back.
//
// Flow per the recovery model (§4): the new device is a NEW REPLICA of the
// existing member account — fresh device key, pins the ORIGINAL anchor, binds
// as a new DEVICE via the server witness. It does NOT re-anchor as owner.
//
//   1. ensure + register THIS device's fresh key (once; the witness 404s
//      without a device_keys row).
//   2. GET /v1/vaults → every vault the account belongs to (with its anchor).
//   3. per vault: snapshot+tail+membership-chain restore (pins the original
//      anchor) → witnessed vault_device_added (so this device can author+mesh).
//   4. pick ONE active/default vault after the loop (restoreFromSnapshot no
//      longer claims it per-vault).
//
// One vault failing must not abort the others. Server sync works the moment a
// vault row + cursor exist; the witnessed bind + restored membership chain are
// what additionally let the recovered device MESH.

import { Platform } from "react-native";
import Constants from "expo-constants";

import { checkIn } from "./api";
import { getAppMeta, setAppMeta } from "./db";
import {
  ACTIVE_VAULT_META_KEY,
  getAccountIdSync,
  getDb,
  refreshAccountIdCache,
  setActiveVaultIdCache,
} from "./db-tx";
import { ensureInstallId } from "./install-id";
import { fetchSnapshot, restoreFromSnapshot } from "./restore";
import { pullEvents } from "./sync/pull";
import { ensureDeviceKey, registerDeviceKey } from "./mesh/device-key";
import { scheduleSweep } from "./projection/sweep";
import { emitWitnessedSelfAdmission, witnessEmitPendingKey } from "./trust/backfill";
import { persistPinnedServerPubkeys } from "./trust/proof";
import { listVaults, type VaultListing } from "./vault-api";

export type RecoveryResult = {
  /** vault_ids fully restored (or seeded for server-sync). */
  recovered: string[];
  /** vaults that errored — recovery continues past them. */
  failed: Array<{ vaultId: string; error: string }>;
  /** the vault selected active after recovery, or null if nothing recovered. */
  activeVaultId: string | null;
};

/**
 * Recover every vault the signed-in account is a member of. Idempotent: safe to
 * re-run (restore is INSERT OR REPLACE / OR IGNORE; the witnessed bind diffs
 * against the already-chained state). Returns a per-vault outcome; never throws
 * for a single vault's failure (only for a total inability to list).
 */
export async function recoverAllVaults(): Promise<RecoveryResult> {
  const recovered: string[] = [];
  const failed: RecoveryResult["failed"] = [];

  // Fresh device key, registered with the server, BEFORE any witness call.
  await ensureDeviceKey();
  try {
    await registerDeviceKey();
  } catch (err) {
    console.warn("[recovery] registerDeviceKey failed (witnessed bind may 404)", err);
  }

  // M5 (review fix — HIGH): PIN the server witness keys BEFORE ingesting any
  // witnessed membership events. A factory-reset device has EMPTY pinned keys;
  // without this, a recovered STAFF member's witnessed vault_member_added (and
  // therefore its own device-bind) quarantines as unknown_actor and can't heal
  // until an incidental later sweep. The launch BackgroundCheckIn that normally
  // pins them RACES this restore — so we do our own awaited check-in here.
  await pinServerWitnessKeys();

  let listings: VaultListing[];
  try {
    listings = await listVaults();
  } catch (err) {
    return {
      recovered,
      failed: [{ vaultId: "*", error: err instanceof Error ? err.message : String(err) }],
      activeVaultId: null,
    };
  }

  const live = listings.filter((v) => v.archived_at_ms == null);

  for (const v of live) {
    try {
      const snapshot = await fetchSnapshot({ defaultVaultId: v.vault_id });
      if (snapshot) {
        await restoreFromSnapshot(snapshot, { setActiveDefault: false });
      } else {
        // No server snapshot yet (cron lag / brand-new / low-activity vault —
        // the snapshot endpoint 404s until the cron or push-threshold builds
        // one). Seed a minimal vault row from the listing, pinning the original
        // anchor, so it's recognized + mesh-eligible.
        await seedVaultFromListing(v);
      }
      // CRITICAL (fixes "kaata restored but contacts + entries missing"): pull
      // the vault's FULL event history to completion now, so the ledger is
      // populated when recovery finishes — not just the vault shell. The
      // no-snapshot path above seeds ONLY the vault row; without this pull the
      // kaata restores EMPTY and only fills in if/when a later sync tick happens
      // to cover it. pullEvents drains to has_more=false; a freshly-seeded vault
      // has cursor 0 so it fetches everything. Idempotent after a snapshot
      // restore (events dedupe by event_id; the cursor skips what's already in).
      // Best-effort: the vault row + cursor exist either way, so a transient
      // pull failure just defers the rest to the scheduler/sweep — don't fail
      // the whole vault over it.
      try {
        await pullEvents(v.vault_id);
      } catch (err) {
        console.warn(`[recovery] initial pull failed for ${v.vault_id.slice(0, 8)}`, err);
      }
      // Bind THIS device into the chain so it can author + mesh. Best-effort:
      // server read/write works via account ACL without it.
      try {
        await emitWitnessedSelfAdmission(v.vault_id);
      } catch (err) {
        // M5 (review fix — MED): leave the pending flag set so ensureChainBackfill
        // (home mount / sync scheduler) retries the bind next session — e.g. if
        // the pin check-in above was offline and the witnessed events quarantined.
        await setAppMeta(witnessEmitPendingKey(v.vault_id), "1").catch(() => {});
        console.warn(`[recovery] witnessed device-bind failed for ${v.vault_id.slice(0, 8)}`, err);
      }
      recovered.push(v.vault_id);
    } catch (err) {
      failed.push({
        vaultId: v.vault_id,
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[recovery] vault ${v.vault_id.slice(0, 8)} failed`, err);
    }
  }

  // Pick ONE active/default after the loop: the original default if it was
  // recovered, else the first recovered vault.
  let activeVaultId: string | null = null;
  if (recovered.length > 0) {
    const originalDefault = await getAppMeta("default_vault_id");
    activeVaultId =
      originalDefault && recovered.includes(originalDefault) ? originalDefault : recovered[0];
    await setAppMeta(ACTIVE_VAULT_META_KEY, activeVaultId);
    await setAppMeta("default_vault_id", activeVaultId);
    setActiveVaultIdCache(activeVaultId);
  }

  // M5 (review fix — MED): sweep each recovered vault so any witnessed
  // membership/device events that quarantined during ingest (e.g. the pin
  // landed mid-flight) re-evaluate against the now-pinned witness keys and
  // apply immediately, rather than waiting for an incidental later pull.
  for (const vaultId of recovered) scheduleSweep(vaultId);

  return { recovered, failed, activeVaultId };
}

/**
 * Do one awaited check-in to fetch + PIN the server witness pubkeys, so
 * witnessed membership events ingested during recovery verify (not quarantine).
 * Best-effort: offline → witnessed events quarantine and heal on the next
 * check-in + sweep (the per-vault retry flag + the end-of-recovery sweep cover
 * that case).
 */
async function pinServerWitnessKeys(): Promise<void> {
  try {
    const installId = await ensureInstallId();
    const resp = await checkIn({
      install_id: installId,
      app_version: Constants.expoConfig?.version ?? "0.0.0",
      platform: Platform.OS === "android" ? "android" : Platform.OS === "ios" ? "ios" : "web",
      device_locale: "en",
    });
    if (resp.mesh_server_pubkeys?.primary) {
      await persistPinnedServerPubkeys(
        resp.mesh_server_pubkeys.primary,
        resp.mesh_server_pubkeys.rotation,
      );
    }
  } catch (err) {
    console.warn(
      "[recovery] witness-key pin check-in failed — witnessed events may quarantine until the next check-in",
      err,
    );
  }
}

/**
 * Seed a minimal vault row from a /v1/vaults listing when no snapshot exists
 * yet — pins the original anchor so the vault is mesh-eligible; no cursor is
 * set, so the next pull fetches every event (incl. the membership chain) from
 * server_seq 0.
 */
async function seedVaultFromListing(v: VaultListing): Promise<void> {
  // NEVER seed with a null account_id — a vault row with account_id NULL is
  // invisible to account-scoped local queries (a real data-loss path). The
  // cache can be cold here if the launch check-in raced this restore, so
  // re-prime from app_meta; if there's STILL no account, skip seeding (we're
  // mid-recovery for a signed-in account, so this is purely defensive — the
  // snapshot path or a later sweep will pick the vault up once primed).
  let accountId = getAccountIdSync();
  if (!accountId) accountId = await refreshAccountIdCache();
  if (!accountId) {
    console.warn("[recovery] skip seed — no account_id resolved", v.vault_id.slice(0, 8));
    return;
  }
  // registered_with_server_at is set (the server already knows this vault — it
  // came back from GET /v1/vaults), so the reconcile loop won't re-POST it.
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO vaults
       (id, name, currency, created_at, updated_at, archived_at,
        is_default, account_id, registered_with_server_at,
        vault_epoch, hlc_logical, hlc_wall_ms, vault_trust_anchor_pubkey)
     VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, 0, 0, ?)`,
    v.vault_id,
    v.name,
    v.currency ?? "AFN",
    v.created_at_ms,
    v.created_at_ms,
    accountId,
    v.created_at_ms,
    v.vault_epoch,
    v.vault_trust_anchor_pubkey ?? null,
  );
}
