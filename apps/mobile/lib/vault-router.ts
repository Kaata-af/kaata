// Per-vault local-CA vs server-anchored routing for vault-level operations.
//
// Phase-7 local-CA vaults (vault_trust_anchor_pubkey IS NOT NULL) are
// authoritative on-device: every vault-level mutation lands as an event in
// the local event_log and the applier mirrors the projection to the vaults
// row. The sync worker pushes them to the server opportunistically.
//
// Pre-Phase-7 server-anchored vaults (vault_trust_anchor_pubkey IS NULL)
// keep the legacy "call the backend, mirror locally on 2xx" semantics —
// the server is the source of truth and the device is a cache.
//
// Every vault-op call site (vault/settings.tsx, ProfileSettingsSheet, …)
// uses one of the exported wrappers below instead of calling vault-api.ts
// or event-log.ts directly. The wrappers branch on isLocalCAVault and
// return a discriminated result so the UI can render "saved offline" vs
// "saved" differently if it ever wants to.

import { applyForUnchangedLocalSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";
import { resolveAccountIdCandidates } from "./effective-account";
import {
  appendVaultMemberRemoved,
  appendVaultOwnershipTransfer,
  appendVaultSettingSet,
  appendVaultCurrencySettings,
} from "./event-log";
import {
  archiveVault as apiArchiveVault,
  leaveVault as apiLeaveVault,
  patchVault as apiPatchVault,
  transferOwnership as apiTransferOwnership,
} from "./vault-api";
import type { VaultRole } from "./events";
import {
  ensureOwnershipTransferSignerReady,
  OwnershipSignerNotReadyError,
} from "./ownership-transfer-readiness";

export type VaultOpResult = { kind: "local"; eventId: string } | { kind: "server" };

/**
 * A currency change was refused because the kaata has an OPEN mutual tab.
 * A tab's currency is fixed at creation and must equal its kaata's (D9,
 * docs/mutual-tab-design.md): relabelling the book under it would make the
 * two parties read the same integers in different currencies. Unlink (close)
 * every tab first; vault/settings shows t('tab.currencyLocked').
 */
export class VaultHasOpenTabError extends Error {
  readonly kind = "vault_has_open_tab" as const;
  constructor(readonly vaultId: string) {
    super(`vault_has_open_tab: ${vaultId}`);
    this.name = "VaultHasOpenTabError";
  }
}

// ---------- routing helper ----------

/**
 * True iff this vault was minted with a local trust anchor (Phase 7 onward).
 * Reads vaults.vault_trust_anchor_pubkey; the column is non-null exactly
 * when the device that minted the vault is its own CA. Server-anchored
 * vaults (legacy Phase 5 invites accepted on the server first, then
 * mirrored locally) carry NULL here.
 *
 * Cheap to call — the row is keyed on the PK and we read one column. We
 * deliberately do NOT cache the answer: a future "convert to server-
 * anchored" flow could flip the column to NULL in the same session, and
 * stale-cache bugs in a routing decision would silently desync the UI.
 *
 * Engineering critique #2: throws VaultNotFoundError when the row is
 * missing rather than silently flipping to "server-anchored". Without
 * this branch, a vault-router op invoked against a vault_id that only
 * arrived via mesh-event (no local vaults row yet) would race-call the
 * server PATCH endpoint and 404 — confusing the user and hard to
 * diagnose. Callers can catch VaultNotFoundError and surface a clear
 * "Kaata isn't ready yet" message; UI flows that pre-INSERT the vaults
 * row (vault/new.tsx, local-pair.ts) never hit this branch in practice.
 */
export class VaultNotFoundError extends Error {
  readonly vaultId: string;
  constructor(vaultId: string) {
    super(`vault_not_found: ${vaultId}`);
    this.name = "VaultNotFoundError";
    this.vaultId = vaultId;
  }
}

export async function isLocalCAVault(vaultId: string): Promise<boolean> {
  if (!vaultId) return false;
  const db = await getDb();
  const row = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
    "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?",
    vaultId,
  );
  if (row == null) {
    // Row missing — caller is asking about a vault we don't know about
    // locally. Don't silently route to the server path.
    throw new VaultNotFoundError(vaultId);
  }
  return row.vault_trust_anchor_pubkey != null && row.vault_trust_anchor_pubkey !== "";
}

// ---------- vault renames ----------

/**
 * Routes a rename through events for local-CA vaults; falls back to the
 * legacy PATCH for server-anchored ones. The applier's reserved-key
 * mirror copies the new name onto vaults.name so the picker / settings
 * row re-render the next read.
 */
export async function changeVaultName(vaultId: string, newName: string): Promise<VaultOpResult> {
  if (await isLocalCAVault(vaultId)) {
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "name",
      value: newName,
    });
    return { kind: "local", eventId: event_id };
  }
  await apiPatchVault(vaultId, { name: newName });
  return { kind: "server" };
}

// ---------- currency ----------

/** Save a default for future tallies. Historical/base currency never changes. */
export async function changeVaultCurrency(
  vaultId: string,
  newCurrency: string,
  expected?: { session?: SessionSnapshot; shouldContinue?: () => boolean },
): Promise<VaultOpResult> {
  if (!/^[A-Z]{3}$/.test(newCurrency)) throw new Error("Invalid currency code");
  const session = expected?.session ?? (await captureCurrentSession());
  return applyForUnchangedLocalSession(session, async () => {
    if (expected?.shouldContinue?.() === false) throw new Error("Currency settings changed scope");
    const local = await isLocalCAVault(vaultId);
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "default_entry_currency",
      value: newCurrency,
      preflight: async () => {
        if (expected?.shouldContinue?.() === false)
          throw new Error("Currency settings changed scope");
      },
    });
    return local ? { kind: "local", eventId: event_id } : { kind: "server" };
  });
}

/** Keep one synced chooser list for local-CA and server-backed books alike. */
export class CurrencySettingsChangedError extends Error {
  readonly kind = "currency_settings_changed" as const;
  constructor() {
    super("Currency settings changed while editing");
    this.name = "CurrencySettingsChangedError";
  }
}

export async function changeVaultEnabledCurrencies(
  vaultId: string,
  currencies: readonly string[],
  expected?: {
    session?: SessionSnapshot;
    shouldContinue?: () => boolean;
    previous?: { enabledValue: string | null; defaultCurrency: string };
  },
): Promise<VaultOpResult> {
  const { requireEnabledCurrencies, settingCurrency } =
    require("./currency-settings") as typeof import("./currency-settings");
  const codes = requireEnabledCurrencies(currencies);
  const session = expected?.session ?? (await captureCurrentSession());
  return applyForUnchangedLocalSession(session, async () => {
    if (expected?.shouldContinue?.() === false) throw new Error("Currency settings changed scope");
    const local = await isLocalCAVault(vaultId);
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "enabled_currencies",
      value: JSON.stringify(codes),
      preflight: async (tx) => {
        if (expected?.shouldContinue?.() === false)
          throw new Error("Currency settings changed scope");
        const row = await tx.getFirstAsync<{
          value: string | null;
          default_entry_currency: string | null;
          currency: string | null;
          enabled_value: string | null;
        }>(
          "SELECT currency,default_entry_currency,(SELECT value FROM vault_settings WHERE vault_id=v.id AND key='default_entry_currency') AS value,(SELECT value FROM vault_settings WHERE vault_id=v.id AND key='enabled_currencies') AS enabled_value FROM vaults v WHERE id=?",
          vaultId,
        );
        const defaultCode =
          settingCurrency(row?.value) ??
          settingCurrency(row?.default_entry_currency) ??
          settingCurrency(row?.currency) ??
          "AFN";
        if (
          expected?.previous &&
          ((row?.enabled_value ?? null) !== expected.previous.enabledValue ||
            defaultCode !== expected.previous.defaultCurrency)
        )
          throw new CurrencySettingsChangedError();
        if (!codes.includes(defaultCode)) throw new Error("The default currency must stay enabled");
      },
    });
    return local ? { kind: "local", eventId: event_id } : { kind: "server" };
  });
}

/** Commit the complete currency draft as one local transaction. The original
 * raw enabled list and resolved default are checked before either signed edit. */
export async function changeVaultCurrencySettings(
  vaultId: string,
  changes: { defaultCurrency: string; enabledCurrencies: readonly string[] },
  expected?: {
    session?: SessionSnapshot;
    shouldContinue?: () => boolean;
    previous?: { enabledValue: string | null; defaultCurrency: string };
  },
): Promise<VaultOpResult> {
  const { requireEnabledCurrencies, settingCurrency } =
    require("./currency-settings") as typeof import("./currency-settings");
  const { requireCurrencyCode } = require("./currency-scope") as typeof import("./currency-scope");
  const defaultCurrency = changes.defaultCurrency;
  const previous = expected?.previous ? { ...expected.previous } : undefined;
  requireCurrencyCode(defaultCurrency);
  const codes = requireEnabledCurrencies(changes.enabledCurrencies);
  if (!codes.includes(defaultCurrency)) throw new Error("The default currency must stay enabled");
  const session = expected?.session ?? (await captureCurrentSession());
  return applyForUnchangedLocalSession(session, async () => {
    if (expected?.shouldContinue?.() === false) throw new Error("Currency settings changed scope");
    const local = await isLocalCAVault(vaultId);
    const { event_id } = await appendVaultCurrencySettings({
      targetVaultId: vaultId,
      defaultCurrency,
      enabledCurrencies: codes,
      preflight: async (tx) => {
        if (expected?.shouldContinue?.() === false)
          throw new Error("Currency settings changed scope");
        const row = await tx.getFirstAsync<{
          currency: string | null;
          default_entry_currency: string | null;
          value: string | null;
          enabled_value: string | null;
        }>(
          "SELECT currency,default_entry_currency,(SELECT value FROM vault_settings WHERE vault_id=v.id AND key='default_entry_currency') AS value,(SELECT value FROM vault_settings WHERE vault_id=v.id AND key='enabled_currencies') AS enabled_value FROM vaults v WHERE id=?",
          vaultId,
        );
        if (!row) throw new Error("The Kaata no longer exists");
        const defaultCode =
          settingCurrency(row.value) ??
          settingCurrency(row.default_entry_currency) ??
          settingCurrency(row.currency) ??
          "AFN";
        if (
          previous &&
          ((row.enabled_value ?? null) !== previous.enabledValue ||
            defaultCode !== previous.defaultCurrency)
        )
          throw new CurrencySettingsChangedError();
      },
    });
    return local ? { kind: "local", eventId: event_id } : { kind: "server" };
  });
}

// ---------- archive ----------

/**
 * Routes vault archival. For local-CA: emit vault_setting_set with key
 * 'archived_at' carrying the wall-ms-as-string; the applier's reserved-
 * key mirror writes vaults.archived_at and bumps vault_epoch so cached
 * VMCs at older epochs get rejected by peers at the next handshake.
 *
 * For server-anchored vaults, the existing POST /v1/vaults/:id/archive
 * remains the path.
 */
export async function archiveVaultRouted(vaultId: string): Promise<VaultOpResult> {
  if (await isLocalCAVault(vaultId)) {
    const archivedAtMs = Date.now();
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "archived_at",
      // Reserved-key contract: numeric ms encoded as decimal string. The
      // applier parseInts it back when mirroring to vaults.archived_at.
      value: String(archivedAtMs),
    });
    return { kind: "local", eventId: event_id };
  }
  await apiArchiveVault(vaultId);
  return { kind: "server" };
}

// ---------- unarchive ----------

/**
 * Routes vault un-archival. For local-CA: emit vault_setting_set with
 * key='archived_at' value="" — the applier parses "" as null and clears
 * vaults.archived_at + leaves vault_epoch alone (no trust-boundary
 * rotation needed when restoring; the boundary was rotated at archive
 * time, and old VMCs at the pre-archive epoch will stay rejected which
 * is the correct security posture).
 *
 * For server-anchored vaults (vault_trust_anchor_pubkey IS NULL) the
 * backend does not currently expose POST /v1/vaults/:id/unarchive — the
 * archive endpoint is one-way. Throw a typed error so callers can
 * surface a clear "Restore from cloud" hint instead of silently
 * succeeding (which would lie to the user — the row stays archived on
 * the server).
 */
export class UnarchiveNotSupportedError extends Error {
  readonly vaultId: string;
  constructor(vaultId: string) {
    super(`unarchive_not_supported: ${vaultId}`);
    this.name = "UnarchiveNotSupportedError";
    this.vaultId = vaultId;
  }
}

export async function unarchiveVault(vaultId: string): Promise<VaultOpResult> {
  if (await isLocalCAVault(vaultId)) {
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "archived_at",
      // Reserved-key contract: empty string signals null. The applier
      // (lib/projection/vault_settings.ts) parses "" -> archived_at=null.
      value: "",
    });
    return { kind: "local", eventId: event_id };
  }
  throw new UnarchiveNotSupportedError(vaultId);
}

// ---------- leave ----------

export type LeaveVaultError =
  | { kind: "last_owner" }
  | { kind: "no_account" }
  | { kind: "not_member" };

/**
 * Routes leave-vault. For local-CA we emit vault_member_removed targeting
 * the local account_id; the existing applier sets revoked_at on the
 * mirror row, fans out revocations, and bumps vault_epoch.
 *
 * Last-owner protection is enforced LOCALLY for local-CA so the UI can
 * surface an inline error instead of a backend 4xx. The check is:
 * count of active (revoked_at IS NULL) members where role = 'owner' must
 * be > 1 OR the leaver must not be an owner.
 */
export async function leaveVaultRouted(
  vaultId: string,
  accountId: string | null,
): Promise<{ ok: true; result: VaultOpResult } | { ok: false; error: LeaveVaultError }> {
  // Resolve EVERY account id that represents me — the passed Google account id
  // AND the deterministic local device-key id. A local-CA vault created before
  // sign-in keys its owner row by the device-key id, while the passed id is the
  // Google one; matching only one of them was why a solo owner got
  // "not_member" → "Failed to leave". Match membership against all of them.
  const candidates = await resolveAccountIdCandidates(accountId);

  if (await isLocalCAVault(vaultId)) {
    if (candidates.length === 0) return { ok: false, error: { kind: "no_account" } };

    const db = await getDb();
    const placeholders = candidates.map(() => "?").join(",");
    // Prefer a non-revoked row, but fetch my account_id so the removal targets
    // exactly the row that exists.
    const me = await db.getFirstAsync<{
      account_id: string;
      role: string;
      revoked_at: number | null;
    }>(
      `SELECT account_id, role, revoked_at FROM vault_members_mirror
        WHERE vault_id = ? AND account_id IN (${placeholders})
        ORDER BY (revoked_at IS NULL) DESC
        LIMIT 1`,
      vaultId,
      ...candidates,
    );
    if (!me || me.revoked_at != null) {
      return { ok: false, error: { kind: "not_member" } };
    }
    if (me.role === "owner") {
      // Last-owner gate counts OTHER owners (not any of my ids), so a corrupted
      // dual-id solo store doesn't look co-owned.
      const otherOwners = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vault_members_mirror
          WHERE vault_id = ?
            AND role = 'owner'
            AND revoked_at IS NULL
            AND account_id NOT IN (${placeholders})`,
        vaultId,
        ...candidates,
      );
      if ((otherOwners?.n ?? 0) === 0) {
        return { ok: false, error: { kind: "last_owner" } };
      }
    }
    const { event_id } = await appendVaultMemberRemoved({
      targetVaultId: vaultId,
      accountId: me.account_id,
    });
    return { ok: true, result: { kind: "local", eventId: event_id } };
  }

  // Server-anchored vault: try the server endpoint when we can, but DON'T hard-fail
  // when offline or signed-out (apiLeaveVault throws "not signed in" → the old
  // "Failed to leave"). Fall back to the local-first removal event so the user
  // leaves on-device immediately; it reconciles to the server on the next sync.
  // (Matee: "Leave kaata should work + do eventual consistency if offline.")
  try {
    await apiLeaveVault(vaultId);
    return { ok: true, result: { kind: "server" } };
  } catch (serverErr) {
    if (__DEV__) console.warn("[vault-router] server leave failed; leaving locally", serverErr);
    const fallbackAccountId = candidates[0];
    if (!fallbackAccountId) return { ok: false, error: { kind: "no_account" } };
    try {
      const { event_id } = await appendVaultMemberRemoved({
        targetVaultId: vaultId,
        accountId: fallbackAccountId,
      });
      return { ok: true, result: { kind: "local", eventId: event_id } };
    } catch (localErr) {
      if (__DEV__) console.warn("[vault-router] local leave fallback failed", localErr);
      return { ok: false, error: { kind: "not_member" } };
    }
  }
}

// ---------- transfer ownership ----------

export type TransferOwnershipError =
  | { kind: "no_account" }
  | { kind: "self_target" }
  | { kind: "not_member"; accountId: string }
  | { kind: "noop_demotion" }
  | { kind: "not_owner" }
  | { kind: "sync_required" }
  | { kind: "context_changed" };

export type TransferOwnershipOptions = {
  expectedSession?: SessionSnapshot;
  shouldContinue?: () => boolean;
};

class TransferPreconditionError extends Error {
  constructor(readonly detail: TransferOwnershipError) {
    super(detail.kind);
    this.name = "TransferPreconditionError";
  }
}

// True iff THIS device minted the given local-CA vault (its pubkey is the
// vault's trust anchor). The minting device is the vault's root of trust /
// original owner by construction, so it can resolve "which owner row is me"
// even when account-id binding has drifted away from every id it now presents
// (device-key rotated after a reinstall) — the same reason the role-gate has a
// trust-anchor carve-out. A key this device rotated away from (retired list in
// lib/mesh/device-key.ts) still counts: the anchor never changes, the minting
// device is still this one. Best-effort; returns false if anything is
// unreadable.
async function deviceIsVaultTrustAnchor(
  db: Awaited<ReturnType<typeof getDb>>,
  vaultId: string,
): Promise<boolean> {
  try {
    const mod = await import("./mesh/device-key");
    // Out of any transaction here, so a needed repair may run; a typed
    // failure just means "compare against whatever the mirror says".
    await mod.ensureDeviceKey().catch(() => undefined);
    const row = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
      "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?",
      vaultId,
    );
    return await mod.isOwnDevicePubkey(row?.vault_trust_anchor_pubkey);
  } catch {
    return false;
  }
}

// Resolve which account_id the CURRENT owner ("me") is keyed under, so a
// transfer demotes the real owner row instead of writing a spurious editor row
// under a drifted id (which would leave the vault with two owners).
//   1. Prefer the candidate id (Google / device-key) that holds a live owner row.
//   2. Fully-drifted "Main"-style vault — none of my ids is an owner, but I
//      minted it (trust anchor) and the vault is genuinely SOLO: exactly one
//      non-revoked owner and NO other non-revoked members besides the transfer
//      target. That lone owner is me under a rotated-away id, so demote it. The
//      solo guard (members.length === 1) ensures we never demote a legitimate
//      co-owner we can't positively identify in a shared vault.
//   3. No drift bridged → return the passed id. The caller verifies the result
//      is actually a live owner and ABORTS the transfer if not (never emits a
//      demote against a non-owner row, which would create a two-owner state).
async function resolveSelfDemoteAccountId(
  db: Awaited<ReturnType<typeof getDb>>,
  vaultId: string,
  selfAccountId: string,
  candidates: string[],
  excludeAccountId: string,
): Promise<string> {
  if (candidates.length > 0) {
    const ph = candidates.map(() => "?").join(",");
    const owned = await db.getFirstAsync<{ account_id: string }>(
      `SELECT account_id FROM vault_members_mirror
        WHERE vault_id = ? AND role = 'owner' AND revoked_at IS NULL
          AND account_id IN (${ph})
        LIMIT 1`,
      vaultId,
      ...candidates,
    );
    if (owned) return owned.account_id;
  }
  if (await deviceIsVaultTrustAnchor(db, vaultId)) {
    const members = await db.getAllAsync<{ account_id: string; role: VaultRole }>(
      `SELECT account_id, role FROM vault_members_mirror
        WHERE vault_id = ? AND revoked_at IS NULL AND account_id != ?`,
      vaultId,
      excludeAccountId,
    );
    const owners = members.filter((m) => m.role === "owner");
    // Genuinely solo: the lone owner is the only remaining member (besides the
    // target). In a shared vault (extra members or co-owners) we can't be sure
    // the lone owner is me, so we don't guess.
    if (owners.length === 1 && members.length === 1) return owners[0].account_id;
  }
  return selfAccountId;
}

/**
 * Local handovers save both signed role events in one transaction. Promotion
 * still precedes self-demotion so the last-owner gate sees the successor, but
 * neither event is visible to sync or survives an interruption on its own.
 * Server-anchored vaults use the server's transactional transfer endpoint.
 */
export async function transferVaultOwnership(
  vaultId: string,
  toAccountId: string,
  selfAccountId: string | null,
  demoteSelfTo: Exclude<VaultRole, "owner"> = "editor",
  opts: TransferOwnershipOptions = {},
): Promise<{ ok: true; result: VaultOpResult } | { ok: false; error: TransferOwnershipError }> {
  if (!selfAccountId) return { ok: false, error: { kind: "no_account" } };
  if (toAccountId === selfAccountId) return { ok: false, error: { kind: "self_target" } };
  if ((demoteSelfTo as VaultRole) === "owner") {
    return { ok: false, error: { kind: "noop_demotion" } };
  }

  const session = opts.expectedSession ?? (await captureCurrentSession());
  const ensureContext = () => {
    if (getActiveVaultIdSyncMaybe() !== vaultId || opts.shouldContinue?.() === false)
      throw new TransferPreconditionError({ kind: "context_changed" });
  };
  try {
    ensureContext();
    if (await isLocalCAVault(vaultId)) {
      const db = await getDb();
      const candidates = await resolveAccountIdCandidates(selfAccountId);
      ensureContext();
      if (candidates.includes(toAccountId)) {
        return { ok: false, error: { kind: "self_target" } };
      }
      // A restored phone's new signing key may not be admitted yet. Prove
      // this exact key before authoring privileged events the server would
      // otherwise reject after the UI had already reported success.
      const expectedSignerPubkey = await ensureOwnershipTransferSignerReady(vaultId, toAccountId);
      ensureContext();
      // Resolve the actual owner seat before the transaction; the fallback may
      // warm a device key. The live seat is rechecked under the event mutex.
      const demoteAccountId = await resolveSelfDemoteAccountId(
        db,
        vaultId,
        selfAccountId,
        candidates,
        toAccountId,
      );
      ensureContext();
      const result = await applyForUnchangedLocalSession(session, () =>
        appendVaultOwnershipTransfer({
          targetVaultId: vaultId,
          toAccountId,
          selfAccountId: demoteAccountId,
          demoteSelfTo,
          expectedSignerPubkey,
          preflight: async (tx) => {
            ensureContext();
            const target = await tx.getFirstAsync<{ revoked_at: number | null }>(
              "SELECT revoked_at FROM vault_members_mirror WHERE vault_id = ? AND account_id = ?",
              vaultId,
              toAccountId,
            );
            if (!target || target.revoked_at != null)
              throw new TransferPreconditionError({ kind: "not_member", accountId: toAccountId });
            const owner = await tx.getFirstAsync<{ role: VaultRole; revoked_at: number | null }>(
              "SELECT role, revoked_at FROM vault_members_mirror WHERE vault_id = ? AND account_id = ?",
              vaultId,
              demoteAccountId,
            );
            if (!owner || owner.role !== "owner" || owner.revoked_at != null)
              throw new TransferPreconditionError({ kind: "not_owner" });
            ensureContext();
          },
        }),
      );
      return { ok: true, result: { kind: "local", eventId: result.event_id } };
    }

    // Bind the request to the account that confirmed, including after async
    // setup. The UI ignores completion if it no longer owns this screen.
    await apiTransferOwnership(vaultId, toAccountId, "editor", session, ensureContext);
    return { ok: true, result: { kind: "server" } };
  } catch (error) {
    if (error instanceof TransferPreconditionError) return { ok: false, error: error.detail };
    if (error instanceof OwnershipSignerNotReadyError)
      return { ok: false, error: { kind: "sync_required" } };
    throw error;
  }
}
