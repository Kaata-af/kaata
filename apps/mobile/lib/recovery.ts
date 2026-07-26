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
import * as Crypto from "expo-crypto";

import { checkIn } from "./api";
import { getAppMeta, getLocalSelf, setAppMeta } from "./db";
import { isPlaceholderSelfName, t } from "./i18n";
import {
  ACTIVE_VAULT_META_KEY,
  getAccountIdSync,
  getDb,
  refreshAccountIdCache,
  setActiveVaultIdCache,
  setLocalSelfUserIdCache,
} from "./db-tx";
import { ensureInstallId } from "./install-id";
import { fetchSnapshot, restoreFromSnapshot } from "./restore";
import { parseVaultRole } from "./vault-roles";
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

// Coarse recovery stages, surfaced to the UI so the restore screens can show a
// REAL (not faked) progress bar instead of an indeterminate spinner. The
// per-vault loop is the dominant cost, so the bulk of the 0..1 range is spent
// there; prep/list/finalize bookend it.
export type RecoveryProgressPhase = "preparing" | "listing" | "restoring" | "finalizing" | "done";

export type RecoveryProgress = {
  phase: RecoveryProgressPhase;
  /** Monotonic completion estimate in [0, 1]. Never regresses. */
  fraction: number;
  /** 1-based index of the vault currently restoring (0 outside the loop). */
  vaultIndex: number;
  /** Total live vaults being restored (0 until the listing resolves). */
  vaultTotal: number;
};

export type RecoverOptions = {
  /** Optional progress sink. A throwing sink can never break recovery. */
  onProgress?: (p: RecoveryProgress) => void;
};

// Fraction anchors for the progress model. Prep + listing share the first slice;
// the per-vault loop owns the long middle; finalize closes it out.
const PROGRESS_LOOP_START = 0.16;
const PROGRESS_LOOP_END = 0.92;

/**
 * Recover every vault the signed-in account is a member of. Idempotent: safe to
 * re-run (restore is INSERT OR REPLACE / OR IGNORE; the witnessed bind diffs
 * against the already-chained state). Returns a per-vault outcome; never throws
 * for a single vault's failure (only for a total inability to list).
 */
export async function recoverAllVaults(opts: RecoverOptions = {}): Promise<RecoveryResult> {
  const recovered: string[] = [];
  const failed: RecoveryResult["failed"] = [];

  // Progress emitter. `vaultTotal` is captured by reference and filled in once
  // the listing resolves. `lastFraction` enforces monotonicity so a later,
  // smaller estimate can never visibly rewind the bar.
  const onProgress = opts.onProgress;
  let vaultTotal = 0;
  let lastFraction = 0;
  const emit = (phase: RecoveryProgressPhase, fraction: number, vaultIndex = 0) => {
    if (!onProgress) return;
    const f = Math.max(lastFraction, Math.min(1, fraction));
    lastFraction = f;
    try {
      onProgress({ phase, fraction: f, vaultIndex, vaultTotal });
    } catch (err) {
      // A misbehaving sink must never abort recovery.
      if (__DEV__) console.warn("[recovery] onProgress threw", err);
    }
  };

  emit("preparing", 0.02);

  // Fresh device key, registered with the server, BEFORE any witness call.
  await ensureDeviceKey();
  try {
    await registerDeviceKey();
  } catch (err) {
    console.warn("[recovery] registerDeviceKey failed (witnessed bind may 404)", err);
  }
  emit("preparing", 0.05);

  // M5 (review fix — HIGH): PIN the server witness keys BEFORE ingesting any
  // witnessed membership events. A factory-reset device has EMPTY pinned keys;
  // without this, a recovered STAFF member's witnessed vault_member_added (and
  // therefore its own device-bind) quarantines as unknown_actor and can't heal
  // until an incidental later sweep. The launch BackgroundCheckIn that normally
  // pins them RACES this restore — so we do our own awaited check-in here.
  await pinServerWitnessKeys();
  emit("listing", 0.1);

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
  vaultTotal = live.length;
  // Per-vault width of the loop's slice of the bar (0 when nothing to restore).
  const slice = live.length > 0 ? (PROGRESS_LOOP_END - PROGRESS_LOOP_START) / live.length : 0;
  emit("listing", 0.14);

  // Ensure the local-self identity row exists BEFORE any vault's events apply.
  // The self user is never event-sourced, so the server stores every
  // relationship with user_a_id="" (and every entry with proposed_by_user_id="");
  // relationships.user_a_id is NOT NULL REFERENCES users(id) with foreign_keys=ON,
  // so applying a person_added/snapshot relationship while no self row exists
  // violates the FK and the contact is DROPPED. That is exactly why a fresh-install
  // restore (no self yet) comes back with empty contacts/tallies, while a home
  // sign-in (self already exists) restores fine. We mint a fresh-UUID self up front
  // and remap the empty server reference to it (restoreFromSnapshot for the
  // snapshot path; applyPersonAdded resolves the existing self row for the pull
  // path). Returns null when there's nothing to restore.
  const localSelf = live.length > 0 ? await ensureLocalSelfForRestore() : null;
  const localSelfId = localSelf?.id ?? null;

  let vaultIdx = 0;
  for (const v of live) {
    // Base fraction for this vault's slice; sub-steps below advance within it.
    const base = PROGRESS_LOOP_START + vaultIdx * slice;
    emit("restoring", base, vaultIdx + 1);
    try {
      const snapshot = await fetchSnapshot({ defaultVaultId: v.vault_id });
      if (snapshot) {
        await restoreFromSnapshot(snapshot, { setActiveDefault: false, localSelfId });
      } else {
        // No server snapshot yet (cron lag / brand-new / low-activity vault —
        // the snapshot endpoint 404s until the cron or push-threshold builds
        // one). Seed a minimal vault row from the listing, pinning the original
        // anchor, so it's recognized + mesh-eligible.
        await seedVaultFromListing(v);
      }
      // Snapshot base is in; the pull below brings the tail. ~half the slice.
      emit("restoring", base + slice * 0.45, vaultIdx + 1);
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
      // Heal OUR OWN membership mirror row against the authoritative server
      // listing. This vault being IN the listing means the server holds an
      // ACTIVE membership for this account — so a locally-revoked self row is
      // a stale client-side wipe (the old blanket sign-in revoke, or a
      // pre-vault_archived not_member 403 that self-revoked on an archive)
      // and must be lifted or the kaata stays hidden forever even though
      // we're still a member. Chain events can't fix it: they were applied
      // long ago and dedupe. A genuinely-removed member never reaches here —
      // the server excludes revoked memberships from GET /v1/vaults.
      try {
        await healSelfMembershipFromListing(v);
      } catch (err) {
        console.warn(`[recovery] membership heal failed for ${v.vault_id.slice(0, 8)}`, err);
      }
      // Ledger pulled; only the (best-effort) membership binds remain.
      emit("restoring", base + slice * 0.8, vaultIdx + 1);
      // Re-key ownership to the recovered account FIRST. A pre-sign-in local-CA
      // vault's chain owner is keyed by a device-key sentinel (the original
      // anchor), which is gone after a reinstall — so the role-gate doesn't
      // recognize the recovered Google account as owner, the device self-admission
      // barrier rejects ("Your role changed" toast), and the chain/server diverge.
      // When the SERVER confirms THIS account owns the vault (v.role === 'owner'),
      // emit a real owner admission so the chain + gate agree and the subsequent
      // self-admission binds. Strictly gated to server-confirmed-owner → it can
      // never be a self-promotion. Best-effort; runs before emitWitnessedSelfAdmission.
      try {
        await reestablishOwnerIfConfirmed(v);
      } catch (err) {
        console.warn(`[recovery] owner re-key failed for ${v.vault_id.slice(0, 8)}`, err);
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
    // Close this vault's slice regardless of outcome so a single failure
    // doesn't strand the bar; the next vault picks up from here.
    vaultIdx++;
    emit("restoring", PROGRESS_LOOP_START + vaultIdx * slice, Math.min(vaultIdx + 1, vaultTotal));
  }

  emit("finalizing", PROGRESS_LOOP_END);

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
    // Refine the JUST-MINTED self's display name from the restored, event-sourced
    // shop_profile.owner_name (the self row was minted pre-loop with only the
    // Google name available). Gated on `minted` so we NEVER clobber the name on an
    // already-onboarded device (the home sign-in path, where the self pre-existed
    // and the user may have set a name different from their shop owner_name).
    if (localSelf?.minted) await refineLocalSelfName(localSelf.id);
  }

  // M5 (review fix — MED): sweep each recovered vault so any witnessed
  // membership/device events that quarantined during ingest (e.g. the pin
  // landed mid-flight) re-evaluate against the now-pinned witness keys and
  // apply immediately, rather than waiting for an incidental later pull.
  for (const vaultId of recovered) scheduleSweep(vaultId);

  emit("done", 1);
  return { recovered, failed, activeVaultId };
}

/**
 * Materialize a freshly-JOINED vault (via online invite-accept) into local state
 * so it is visible and syncable.
 *
 * The /v1/vaults/invites/accept response carries only {vault_id, vault_name,
 * role}; nothing in the accept path creates the local `vaults` row. The home
 * screen builds its vault list from that table, so without a row it can't see
 * the joined vault and silently reverts the active pointer — the member can
 * neither view nor sync the shared ledger. This seeds the row from the
 * authoritative GET /v1/vaults listing (or a snapshot when one already exists)
 * and pulls the event history (membership chain + ledger), exactly like the
 * no-snapshot branch of recoverAllVaults for a single vault.
 *
 * Idempotent (INSERT OR IGNORE + event dedupe), so re-accepting / re-launching
 * is safe. Best-effort: returns false if the vault couldn't be seeded (e.g. a
 * brief read-after-write lag where the accept committed but the listing hasn't
 * caught up). The caller should still set the active pointer in that case — the
 * next launch's reconcile/recovery seeds the row later.
 */
/**
 * Instant, OFFLINE-PROOF seed of a just-joined vault from the accept
 * response itself ({vault_id, vault_name, role} — no server round-trip that
 * can fail). This is what kills the "joined kaata flashes then vanishes"
 * bug: recoverJoinedVault's full materialization (listing + snapshot + pull)
 * can fail on a network blip right after the accept, and the vault row it
 * would have created is what the switcher/heal logic needs — without it the
 * kaata showed for a second (the active pointer was set), then
 * healActiveVaultId saw a MISSING row and moved the pointer away, and no
 * in-session path recreated it. Seeding the bare row + our own membership
 * mirror synchronously means the kaata is visible and switchable from the
 * first frame; recoverJoinedVault then enriches it (anchor, history, other
 * members) — and if THAT fails, the retry flag heals the enrichment later
 * while the kaata stays visible throughout.
 *
 * Details:
 *   - registered_with_server_at is stamped so reconcileVaultRegistrations
 *     never tries to POST-register someone else's vault as ours.
 *   - Our own vault_members_mirror row (role from the accept response —
 *     invites only mint editor/viewer, never owner) doubles as the
 *     joined-vault marker the reconcile ownership guard checks.
 *   - INSERT OR IGNORE everywhere: re-running after a successful full
 *     materialization is a no-op.
 */
export async function seedJoinedVaultMinimal(
  vaultId: string,
  vaultName: string,
  role: string,
): Promise<void> {
  let accountId = getAccountIdSync();
  if (!accountId) accountId = await refreshAccountIdCache();
  if (!accountId) return; // accept requires sign-in; purely defensive
  const now = Date.now();
  const db = await getDb();
  await db.runAsync(
    `INSERT OR IGNORE INTO vaults
       (id, name, currency, created_at, updated_at, archived_at,
        is_default, account_id, registered_with_server_at,
        vault_epoch, hlc_logical, hlc_wall_ms, vault_trust_anchor_pubkey)
     VALUES (?, ?, 'AFN', ?, ?, NULL, 0, ?, ?, 0, 0, 0, NULL)`,
    vaultId,
    vaultName,
    now,
    now,
    accountId,
    now,
  );
  // Roles v2: accept any of the five known roles; an UNKNOWN literal clamps
  // DOWN to viewer (never up to editor — a restricted role must degrade to
  // read-only). Server-validated accept responses only send invite-grantable
  // roles today (editor/viewer/clerk).
  const safeRole = parseVaultRole(role) ?? "viewer";
  // Self display name, so the joiner's own Members row shows their name from
  // the first frame. Guarded: a restore-minted placeholder ("You") must not
  // masquerade as a real name. NULL is fine — the server listing heal
  // (healMemberNamesFromListing) fills it as soon as a reconcile runs.
  const selfName = (await getLocalSelf().catch(() => null))?.name?.trim() || null;
  await db.runAsync(
    `INSERT OR IGNORE INTO vault_members_mirror
       (vault_id, account_id, role, accepted_at, revoked_at, display_name)
     VALUES (?, ?, ?, ?, NULL, ?)`,
    vaultId,
    accountId,
    safeRole,
    now,
    selfName && !isPlaceholderSelfName(selfName) ? selfName : null,
  );
}

export async function recoverJoinedVault(vaultId: string): Promise<boolean> {
  // The accepting user is already signed-in + onboarded, so a local-self row
  // exists; call defensively (no-op when present) so a pulled relationship/entry
  // can never violate the users FK mid-apply (see ensureLocalSelfForRestore).
  const { id: localSelfId } = await ensureLocalSelfForRestore();

  let listings: VaultListing[];
  try {
    listings = await listVaults();
  } catch (err) {
    console.warn("[recovery] joined-vault listing failed", err);
    return false;
  }

  const v = listings.find((x) => x.vault_id === vaultId && x.archived_at_ms == null);
  if (!v) {
    // Accept committed server-side but the listing doesn't reflect it yet (rare
    // read-after-write lag). The caller still sets the pointer; the next launch
    // recovery/reconcile will seed the row.
    console.warn("[recovery] joined vault absent from listing", vaultId.slice(0, 8));
    return false;
  }

  try {
    const snapshot = await fetchSnapshot({ defaultVaultId: v.vault_id });
    if (snapshot) {
      await restoreFromSnapshot(snapshot, { setActiveDefault: false, localSelfId });
    } else {
      await seedVaultFromListing(v);
    }
  } catch (err) {
    // Even if the snapshot restore failed, fall back to a bare seed so the row
    // exists and the vault is at least visible + sync-targeted.
    console.warn("[recovery] joined vault seed failed; falling back to bare seed", err);
    try {
      await seedVaultFromListing(v);
    } catch (seedErr) {
      console.warn("[recovery] joined vault bare seed failed", seedErr);
      return false;
    }
  }

  // Pull the full history now: a freshly-seeded vault has cursor 0, so this
  // fetches the membership chain + ledger and projects them (pullEvents sweeps
  // internally). Best-effort — the row + cursor exist either way, so a transient
  // pull failure just defers the tail to the scheduler/sweep.
  try {
    await pullEvents(v.vault_id);
  } catch (err) {
    console.warn("[recovery] joined vault initial pull failed", err);
  }

  // Same self-row + member-name reconcile the full-recovery loop does — the
  // join path was skipping it, which left the joiner's Members tab rendering
  // role labels ("Owner") until some later full recovery ran.
  try {
    await healSelfMembershipFromListing(v);
  } catch (err) {
    console.warn("[recovery] joined vault membership heal failed", err);
  }

  return true;
}

/**
 * Reconcile OUR OWN vault_members_mirror row with the server listing — the
 * server's authoritative "you are an active member with role R" answer. Writes
 * ONLY the signed-in account's row (never other members', never other
 * accounts'): upserts it active with the listing's role, preserving an
 * existing accepted_at/display_name. Follows the same non-chain-writer
 * precedent as pair-scan's self row and auth.ts's owner seeding; role-gate
 * decisions read the event chain, not the mirror, so this affects visibility
 * and UI role display only — it can never grant chain authority.
 */
async function healSelfMembershipFromListing(v: VaultListing): Promise<void> {
  let accountId = getAccountIdSync();
  if (!accountId) accountId = await refreshAccountIdCache();
  if (!accountId) return;
  // Roles v2: unknown role literals clamp DOWN to viewer, never up.
  const role = parseVaultRole(v.role) ?? "viewer";
  const db = await getDb();
  const result = await db.runAsync(
    `INSERT INTO vault_members_mirror (vault_id, account_id, role, accepted_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(vault_id, account_id) DO UPDATE SET
       role        = excluded.role,
       revoked_at  = NULL,
       accepted_at = COALESCE(vault_members_mirror.accepted_at, excluded.accepted_at)`,
    v.vault_id,
    accountId,
    role,
    Date.now(),
  );
  if (result.changes > 0) {
    // Flip role-gated UI (useVaultRole / vault switcher) on next render in
    // case this lifted a stale local revocation.
    const { invalidateVaultRoleCache } = await import("./use-vault-role");
    invalidateVaultRoleCache(v.vault_id);
  }
  await healMemberNamesFromListing(v);
}

/**
 * Fold the listing's member display names into the mirror. NAMES ONLY for
 * other members — roles and revocation state of OTHER accounts stay driven
 * by the event chain (and healSelfMembershipFromListing for self), so this
 * can never move authority; it only fixes the members screen showing role
 * labels ("Owner"/"Editor") where a person's name belongs. FILL-BLANKS-ONLY:
 * a name already in the mirror (QR pair, admission-event payload — both
 * user-chosen, often Dari) always beats the server's accounts.name (often
 * a latinized Google profile name); the listing only names rows that would
 * otherwise render as role labels. Placeholder-guarded: the server can echo
 * a restore-minted "You" back via the installs.self_name fallback, and
 * stamping it would both regress the row and risk genesis backfill signing
 * it into an immutable event. Old backends omit `members` entirely → no-op.
 */
export async function healMemberNamesFromListing(v: VaultListing): Promise<void> {
  if (!v.members || v.members.length === 0) return;
  const db = await getDb();
  for (const m of v.members) {
    const name = m.name?.trim();
    if (!m.account_id || !name || isPlaceholderSelfName(name)) continue;
    await db.runAsync(
      `UPDATE vault_members_mirror SET display_name = ?
        WHERE vault_id = ? AND account_id = ? AND display_name IS NULL`,
      name,
      v.vault_id,
      m.account_id,
    );
  }
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

/**
 * Ensure the local-self (is_local_self=1) user row exists BEFORE recovery applies
 * any vault's events, and return its id. The self user is never event-sourced, so
 * it is absent from every server snapshot AND the server stores every relationship
 * with user_a_id="" / every entry with proposed_by_user_id="" (the original self
 * id never round-trips). relationships.user_a_id is NOT NULL REFERENCES users(id)
 * with foreign_keys=ON, so a relationship can only be inserted once a self row
 * exists to point at. We mint a FRESH-UUID self (the original id is unrecoverable)
 * and the restore paths remap the empty server reference to it: the snapshot path
 * via restoreFromSnapshot(localSelfId), the pull path via applyPersonAdded's
 * existing-self-row lookup. No-op (returns the existing id) when a self row is
 * already present — the home-screen sign-in path, where the user onboarded first.
 *
 * Phone is left NULL (the caller's adoptAccountPhoneToSelf fills it post-restore
 * under its own UNIQUE-collision guard). The display name is seeded from the
 * Google name stashed at sign-in; refineLocalSelfName upgrades it to the restored
 * shop_profile.owner_name after the loop.
 */
async function ensureLocalSelfForRestore(): Promise<{ id: string; minted: boolean }> {
  const db = await getDb();
  const existing = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  if (existing) {
    setLocalSelfUserIdCache(existing.id);
    return { id: existing.id, minted: false };
  }

  // No self row → mint one. Resolve account_id robustly (cache may be cold) so the
  // self row binds to the account; it self-heals on the next sign-in regardless.
  let accountId = getAccountIdSync();
  if (!accountId) accountId = await refreshAccountIdCache();
  const pendingName = (await getAppMeta("onboarding_pending_name"))?.trim() || null;
  const googleSub = (await getAppMeta("account_google_sub")) || null;
  const selfId = Crypto.randomUUID();
  const now = Date.now();

  // Placeholder display_name: the Google name if we have it, else the user's own
  // localized "you" label (refined to owner_name post-restore). NOT NULL column,
  // so never empty. Phone NULL → the UNIQUE(phone_e164) constraint can't abort this.
  const displayName = pendingName || t("recovery.selfPlaceholderName");
  await db.runAsync(
    `INSERT INTO users (
       id, phone_e164, display_name, is_local_self, google_sub, account_id,
       created_at, updated_at, archived_at
     ) VALUES (?, NULL, ?, 1, ?, ?, ?, ?, NULL)`,
    selfId,
    displayName,
    googleSub,
    accountId,
    now,
    now,
  );
  setLocalSelfUserIdCache(selfId);
  console.warn(`[recovery] minted local-self ${selfId.slice(0, 8)} for restore`);
  return { id: selfId, minted: true };
}

/**
 * Upgrade the freshly-minted self's display_name to the restored, event-sourced
 * shop_profile.owner_name (the user's real in-app name) now that vaults are in.
 * Only touches a self row whose name is still the Google/placeholder seed; never
 * clobbers a name the user already had. Best-effort.
 */
async function refineLocalSelfName(selfId: string): Promise<void> {
  const db = await getDb();
  const ownerRow = await db.getFirstAsync<{ owner_name: string | null }>(
    `SELECT owner_name FROM shop_profile
      WHERE owner_name IS NOT NULL AND TRIM(owner_name) <> '' LIMIT 1`,
  );
  const ownerName = ownerRow?.owner_name?.trim();
  if (!ownerName) return;
  await db.runAsync(
    "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ? AND is_local_self = 1",
    ownerName,
    Date.now(),
    selfId,
  );
}

/**
 * Re-establish the recovered account as a chain OWNER of a vault the server
 * confirms it owns. A pre-sign-in local-CA vault's owner is keyed in the chain by
 * a device-key sentinel (buildLocalAccountId of the original anchor); after a
 * reinstall that sentinel + its device key are gone, so the role-gate no longer
 * resolves the recovered Google account to owner, the vault_device_added
 * self-admission barrier rejects it ("Your role changed" toast), and the mesh
 * chain has no owner row for this account. Emitting a real owner
 * vault_member_added{accountId, owner} reconciles the local chain with the
 * server's confirmed ownership so the device binds + authors cleanly.
 *
 * SECURITY: gated STRICTLY to v.role === 'owner' — the SERVER's authoritative
 * answer from GET /v1/vaults. This is never a self-elevation: the server already
 * considers this account the owner; we only mirror that into the local chain.
 * Idempotent: skipped when this account is already an active (non-removed) chain
 * member. The local role-gate accepts the emission on its cold-start null-role
 * path; when it pushes, the server accepts it because the account IS the
 * already-registered owner.
 */
async function reestablishOwnerIfConfirmed(v: VaultListing): Promise<void> {
  if (v.role !== "owner") return;
  const accountId = getAccountIdSync();
  if (!accountId) return;
  const db = await getDb();
  // CRASH HEAL for the append→ack gap below: the append helper commits in its
  // own transaction, so a crash between it and the server-acked stamp leaves
  // the synthetic owner-add in the push outbox — the server would reject it
  // (membership_unverified) and permanently exile it via rejected_at. Stamp
  // any such orphan before the added/removed early-return can skip it. The
  // predicate (self-targeted + origin local + backfill_synthetic + no witness)
  // matches ONLY this function's emission: genesis self-admission carries no
  // backfill_synthetic, and the chain-backfill admissions skip the owner's own
  // account. Rejected rows are past saving — leave them for conflict review.
  await db.runAsync(
    `UPDATE event_log SET server_acked_at = ?
      WHERE vault_id = ? AND event_type = 'vault_member_added' AND target_id = ?
        AND origin = 'local' AND server_acked_at IS NULL AND rejected_at IS NULL
        AND json_extract(payload_json, '$.backfill_synthetic') = 1
        AND json_extract(payload_json, '$.witness') IS NULL`,
    Date.now(),
    v.vault_id,
    accountId,
  );
  const added = await db.getFirstAsync<{ event_id: string }>(
    `SELECT event_id FROM event_log
       WHERE vault_id = ? AND event_type = 'vault_member_added' AND target_id = ?
         AND applied_at IS NOT NULL AND quarantine_reason IS NULL
       LIMIT 1`,
    v.vault_id,
    accountId,
  );
  const removed = await db.getFirstAsync<{ event_id: string }>(
    `SELECT event_id FROM event_log
       WHERE vault_id = ? AND event_type = 'vault_member_removed' AND target_id = ?
         AND applied_at IS NOT NULL AND quarantine_reason IS NULL
       LIMIT 1`,
    v.vault_id,
    accountId,
  );
  // Already an active owner in the chain (added, not later removed) → nothing to do.
  if (added && !removed) return;
  const { appendVaultMemberAdded } = await import("./event-log");
  const { event_id } = await appendVaultMemberAdded({
    targetVaultId: v.vault_id,
    accountId,
    role: "owner",
    backfillSynthetic: true,
  });
  // LOCAL-ONLY: this admission exists purely to reconcile the LOCAL chain (so the
  // device self-admission barrier + role-gate resolve this account to owner). The
  // server already holds the canonical owner membership from registration, and a
  // PUSH of this synthetic, non-witnessed owner-add would be rejected
  // (membership_unverified) — exiling it via rejected_at and littering conflicts.
  // Mark it server-acked so it never enters the push outbox; its job is done once
  // it applies locally. NOT atomic with the append (the helper commits in its own
  // transaction) — a crash landing between the two is repaired by the crash-heal
  // UPDATE at the top of this function on the next recovery run.
  await db.runAsync(
    "UPDATE event_log SET server_acked_at = ? WHERE event_id = ?",
    Date.now(),
    event_id,
  );
  console.warn(`[recovery] re-keyed owner to recovered account for ${v.vault_id.slice(0, 8)}`);
}
