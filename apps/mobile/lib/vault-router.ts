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

import { getDb } from "./db-tx";
import { appendVaultMemberRemoved, appendVaultSettingSet } from "./event-log";
import {
  archiveVault as apiArchiveVault,
  leaveVault as apiLeaveVault,
  patchVault as apiPatchVault,
} from "./vault-api";

export type VaultOpResult = { kind: "local"; eventId: string } | { kind: "server" };

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

/**
 * Routes a currency change through events for local-CA vaults; for
 * server-anchored vaults we keep the existing "PATCH then emit local
 * event" pattern (the server is authoritative; the event is the local
 * projection record).
 */
export async function changeVaultCurrency(
  vaultId: string,
  newCurrency: string,
): Promise<VaultOpResult> {
  if (await isLocalCAVault(vaultId)) {
    const { event_id } = await appendVaultSettingSet({
      targetVaultId: vaultId,
      key: "currency",
      value: newCurrency,
    });
    return { kind: "local", eventId: event_id };
  }
  // Engineering critique: emit the local event FIRST, PATCH second.
  // Local-first invariant — every user-intent mutation must persist to
  // the event log before we try to round-trip to the server. The
  // previous order (PATCH then append) would leave state diverged when
  // PATCH succeeded but the local append failed (server has new
  // currency, local has no record). With append-first, a PATCH failure
  // still records the user's intent in the log; AutoSync reconciles
  // later. The applier mirrors to vaults.currency so the projection
  // reflects the new value without waiting for the PATCH ack.
  await appendVaultSettingSet({
    targetVaultId: vaultId,
    key: "currency",
    value: newCurrency,
  });
  await apiPatchVault(vaultId, { currency: newCurrency });
  return { kind: "server" };
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
  if (await isLocalCAVault(vaultId)) {
    if (!accountId) return { ok: false, error: { kind: "no_account" } };

    const db = await getDb();
    const me = await db.getFirstAsync<{ role: string; revoked_at: number | null }>(
      `SELECT role, revoked_at FROM vault_members_mirror
        WHERE vault_id = ? AND account_id = ?`,
      vaultId,
      accountId,
    );
    if (!me || me.revoked_at != null) {
      return { ok: false, error: { kind: "not_member" } };
    }
    if (me.role === "owner") {
      const owners = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vault_members_mirror
          WHERE vault_id = ?
            AND role = 'owner'
            AND revoked_at IS NULL`,
        vaultId,
      );
      if ((owners?.n ?? 0) <= 1) {
        return { ok: false, error: { kind: "last_owner" } };
      }
    }
    const { event_id } = await appendVaultMemberRemoved({
      targetVaultId: vaultId,
      accountId,
    });
    return { ok: true, result: { kind: "local", eventId: event_id } };
  }

  await apiLeaveVault(vaultId);
  return { ok: true, result: { kind: "server" } };
}
