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
import { resolveAccountIdCandidates } from "./effective-account";
import {
  appendVaultMemberRemoved,
  appendVaultMemberRoleChanged,
  appendVaultSettingSet,
} from "./event-log";
import {
  archiveVault as apiArchiveVault,
  leaveVault as apiLeaveVault,
  patchVault as apiPatchVault,
  transferOwnership as apiTransferOwnership,
} from "./vault-api";
import type { VaultRole } from "./events";

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
  // We couldn't resolve which owner row in the mirror represents "me" (account-id
  // drift to an id we can't bridge, in a vault with other owners). We ABORT
  // before emitting any event rather than demote the wrong/no row and leave the
  // vault with two owners. The caller surfaces a generic "transfer failed".
  | { kind: "not_owner" }
  // Engineering critique 1.d: the second event (self-demote) threw AFTER
  // the first event (promote target) committed. We compensated by emitting
  // a role-change to roll the target back to its prior role, but the user
  // should still see a specific error rather than a generic "transfer
  // failed" — the vault is now in a known-recovered state, not a partial
  // one. Caller surfaces a specific toast.
  | { kind: "partial_recovered" }
  // Critical: the second event threw AND the compensating roll-back also
  // threw. The vault is in a partial state (target now owner, self still
  // owner). The user can recover by re-opening members and demoting one
  // of them manually. Surfaces a distinct toast directing them there.
  | { kind: "partial_unrecovered"; promotedAccountId: string };

// True iff THIS device minted the given local-CA vault (its pubkey is the
// vault's trust anchor). The minting device is the vault's root of trust /
// original owner by construction, so it can resolve "which owner row is me"
// even when account-id binding has drifted away from every id it now presents
// (device-key rotated after a reinstall) — the same reason the role-gate has a
// trust-anchor carve-out. Best-effort; returns false if anything is unreadable.
async function deviceIsVaultTrustAnchor(
  db: Awaited<ReturnType<typeof getDb>>,
  vaultId: string,
): Promise<boolean> {
  try {
    const mod = await import("./mesh/device-key");
    await mod.ensureDeviceKey();
    const myPub = mod.getDevicePubkey();
    if (!myPub) return false;
    const row = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
      "SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?",
      vaultId,
    );
    return row?.vault_trust_anchor_pubkey === myPub;
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
 * Routes ownership transfer. For local-CA vaults we emit TWO
 * vault_member_role_changed events in SEQUENCE:
 *   1. target → "owner"
 *   2. self   → demoteSelfTo (defaults to "editor")
 *
 * Engineering critique 1.d (CRITICAL FIX): we previously wrapped the two
 * emits in `db.withTransactionAsync`, but `appendVaultMemberRoleChanged`
 * already calls `applyEvent` which itself opens a `withTransactionAsync`
 * for per-event atomicity. expo-sqlite uses BEGIN/COMMIT (not SAVEPOINT)
 * so the inner BEGIN throws "cannot start a transaction within a
 * transaction" — meaning every local-CA transfer was failing outright
 * before this fix. Each event now commits in its own transaction; the
 * outer wrapper is removed.
 *
 * Engineering critique 1.c (ORDERING IS LOAD-BEARING): event ordering
 * here is correct AND required. The role-gate's `wouldDropLastOwner`
 * check reads vault_members_mirror, which event 1 mutates BEFORE event 2
 * is gated. Reversing the order (self-demote first) would make event 1's
 * gate see otherOwners=0 and refuse. Don't refactor to "demote then
 * promote" — that path is rejected by design.
 *
 * Engineering critique 1.e (PARTIAL-FAILURE RECOVERY): if event 1
 * commits and event 2 throws (e.g. signing failure, SecureStore wedge),
 * we emit a COMPENSATING event to demote the target back to its
 * pre-transfer role. The vault is then in its starting state and we
 * return `partial_recovered`. If the compensating event ALSO throws,
 * return `partial_unrecovered` so the UI can direct the user back to
 * /members to manually demote one of the now-two owners.
 *
 * The applier mirrors to vault_members_mirror and bumps vault_epoch so
 * cached VMCs at the pre-transfer epoch get rejected by peers at the next
 * handshake — a fresh issuance is required for the new owner to mint VMCs
 * downstream.
 *
 * For server-anchored vaults: existing /transfer-ownership endpoint.
 *
 * Edge cases enforced locally for local-CA so the UI can surface clear
 * inline errors instead of a backend 4xx:
 *   - selfAccountId null            → no_account
 *   - toAccountId === selfAccountId → self_target
 *   - toAccountId not in mirror     → not_member
 *   - demoteSelfTo === "owner"      → noop_demotion (caller bug)
 */
export async function transferVaultOwnership(
  vaultId: string,
  toAccountId: string,
  selfAccountId: string | null,
  demoteSelfTo: Exclude<VaultRole, "owner"> = "editor",
): Promise<{ ok: true; result: VaultOpResult } | { ok: false; error: TransferOwnershipError }> {
  // Universal precondition guards — apply to both routing branches so the
  // UI gets the same error shape regardless of vault kind.
  if (!selfAccountId) return { ok: false, error: { kind: "no_account" } };
  if (toAccountId === selfAccountId) return { ok: false, error: { kind: "self_target" } };
  // Defensive: the type already excludes "owner", but a caller using `as`
  // could slip a runtime "owner" through. Reject explicitly.
  if ((demoteSelfTo as VaultRole) === "owner") {
    return { ok: false, error: { kind: "noop_demotion" } };
  }

  if (await isLocalCAVault(vaultId)) {
    const db = await getDb();

    // Resolve EVERY id that represents me (passed Google id + the deterministic
    // device-key id). The self-demote below MUST target the id ownership is
    // ACTUALLY keyed under — the same account-id-drift class that broke
    // leave/archive/role. Demoting the raw passed id when the owner row sits
    // under a different id of mine leaves the vault with TWO owners (the old
    // row stays owner) and silently corrupts membership.
    const candidates = await resolveAccountIdCandidates(selfAccountId);
    // Self-target guard, candidate-aware: the target must not be ANY of my ids,
    // not just the one the caller happened to pass.
    if (candidates.includes(toAccountId)) {
      return { ok: false, error: { kind: "self_target" } };
    }

    // Membership check: target must already be a non-revoked member of
    // the mirror. The events.ts role-gate would reject the emit on an
    // unknown account anyway, but pre-checking lets us produce a typed
    // error the UI can localize instead of a generic role-gate throw.
    // We also capture the target's CURRENT role so we can roll it back if
    // event 2 fails after event 1 commits (engineering critique 1.e).
    const tgt = await db.getFirstAsync<{ role: VaultRole; revoked_at: number | null }>(
      `SELECT role, revoked_at FROM vault_members_mirror
        WHERE vault_id = ? AND account_id = ?`,
      vaultId,
      toAccountId,
    );
    if (!tgt || tgt.revoked_at != null) {
      return { ok: false, error: { kind: "not_member", accountId: toAccountId } };
    }
    const targetPriorRole = tgt.role;

    // Which of MY ids actually holds ownership? Demote THAT id, not the raw
    // passed one (see candidate comment above). Computed BEFORE the promote so
    // the trust-anchor fallback sees the pre-transfer owner set.
    const demoteAccountId = await resolveSelfDemoteAccountId(
      db,
      vaultId,
      selfAccountId,
      candidates,
      toAccountId,
    );

    // Safety gate: the id we're about to demote MUST currently be a live owner.
    // If resolution fell through (drift we couldn't bridge), demoteAccountId is
    // a non-owner id and demoting it would be a 0-row no-op — promoting the
    // target while the real owner row stays owner = a silent TWO-OWNER state
    // reported as success. Abort BEFORE emitting anything instead.
    const demoteOwns = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vault_members_mirror
        WHERE vault_id = ? AND account_id = ? AND role = 'owner' AND revoked_at IS NULL`,
      vaultId,
      demoteAccountId,
    );
    if ((demoteOwns?.n ?? 0) === 0) {
      return { ok: false, error: { kind: "not_owner" } };
    }

    // 1. Promote target to owner. This must happen FIRST so event 2's
    //    wouldDropLastOwner check sees two owners and passes.
    await appendVaultMemberRoleChanged({
      targetVaultId: vaultId,
      accountId: toAccountId,
      role: "owner",
    });

    // 2. Demote self. If this throws we attempt to undo event 1 with a
    //    compensating role-change so the vault doesn't get stuck with
    //    two owners.
    let secondEventId = "";
    try {
      const e2 = await appendVaultMemberRoleChanged({
        targetVaultId: vaultId,
        accountId: demoteAccountId,
        role: demoteSelfTo,
      });
      secondEventId = e2.event_id;
    } catch (err) {
      // Compensate: try to roll the target back to whatever role they
      // had before. We log the original failure for diagnosis since the
      // user-facing error is downgraded to "partial_recovered".
      // eslint-disable-next-line no-console
      console.warn("[transferVaultOwnership] second emit failed, compensating", err);
      // If the target was already an owner (uncommon edge: caller picked
      // a co-owner — but precondition assumed they were editor/viewer),
      // a compensating role-change to "owner" is a no-op event; we still
      // emit it for an audit trail. If it was editor/viewer, we restore.
      const compensateTo: Exclude<VaultRole, "owner"> | "owner" =
        targetPriorRole === "owner" ? "owner" : (targetPriorRole as Exclude<VaultRole, "owner">);
      try {
        await appendVaultMemberRoleChanged({
          targetVaultId: vaultId,
          accountId: toAccountId,
          role: compensateTo as VaultRole,
        });
        return { ok: false, error: { kind: "partial_recovered" } };
      } catch (compErr) {
        // eslint-disable-next-line no-console
        console.error("[transferVaultOwnership] compensation also failed", compErr);
        return {
          ok: false,
          error: { kind: "partial_unrecovered", promotedAccountId: toAccountId },
        };
      }
    }

    return { ok: true, result: { kind: "local", eventId: secondEventId } };
  }

  // Server-anchored path. Engineering critique: the prior ternary
  // (demoteSelfTo === "viewer" ? "editor" : "editor") was a dead branch
  // — both arms returned "editor", and the type alternative "leave" was
  // unreachable. Until the UI grows a "demote to viewer" or "leave
  // entirely" affordance, only "editor" is wired; map explicitly so the
  // intent is clear at the call site.
  const serverDemote: "editor" | "leave" = "editor";
  await apiTransferOwnership(vaultId, toAccountId, serverDemote);
  return { ok: true, result: { kind: "server" } };
}
