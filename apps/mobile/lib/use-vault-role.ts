// React hook surface for vault role + permission checks.
//
// Phase 2: every call resolves to 'owner' — either because (a) there's no
// vault_members_mirror row (local-only or pre-sign-in install), or (b) the
// single row that does exist is the signed-in self as owner. The hook
// nevertheless does the SELECT, because Phase 4 will start producing
// editor / viewer rows via incoming vault_member_* events from sync, and we
// want zero call-site churn at that point.
//
// The hook intentionally does NOT live in vault-roles.ts because that file
// must remain consumable from non-React contexts (the future pre-append
// guard inside event-log.ts is plain TS). Hooks here, pure logic there.

import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getAccountIdSync, getDb } from "./db-tx";
import { resolveAccountIdCandidates } from "./effective-account";
import { useLedgerRefresh } from "./ledger-events";
import { invalidateRoleGateCache } from "./projection/role-gate";
import { canPerformAction, type VaultAction, type VaultRole } from "./vault-roles";

// Process-local cache. Account resets and applied membership/device events
// clear it and refresh any mounted role consumers.
const roleCache = new Map<string, VaultRole>();
const roleInvalidationListeners = new Set<(vaultId?: string) => void>();

export function invalidateVaultRoleCache(vaultId?: string): void {
  if (vaultId) roleCache.delete(vaultId);
  else roleCache.clear();
  // Phase 8 D-ROLE-ENFORCEMENT-MOBILE: chain through to the projection
  // role-gate cache so an in-flight delta-sync batch can't observe a
  // stale role across the mirror update boundary.
  invalidateRoleGateCache(vaultId);
  // Clearing a Map alone does not update a screen that stays focused while a
  // remote role change applies. Notify its role reads before accepting writes.
  for (const listener of roleInvalidationListeners) {
    try {
      listener(vaultId);
    } catch (err) {
      if (__DEV__) console.warn("[vault-role] invalidation listener failed", err);
    }
  }
}

function useLiveRoleRefresh(
  vaultId: string | null,
  reread: (invalidate?: boolean) => () => void,
): void {
  const latestCancel = useRef<(() => void) | null>(null);
  const refresh = useCallback(
    (invalidate = true) => {
      latestCancel.current?.();
      const cancel = reread(invalidate);
      latestCancel.current = cancel;
      return cancel;
    },
    [reread],
  );
  useEffect(() => {
    refresh();
    const invalidated = (changedVaultId?: string) => {
      if (!changedVaultId || changedVaultId === vaultId) refresh();
    };
    roleInvalidationListeners.add(invalidated);
    let previous = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      const resumed = previous !== "active" && next === "active";
      previous = next;
      if (resumed) refresh();
    });
    return () => {
      latestCancel.current?.();
      roleInvalidationListeners.delete(invalidated);
      sub.remove();
    };
  }, [vaultId, refresh]);
  useFocusEffect(refresh);
  // The projection invalidates inside its transaction; re-read after the
  // committed notification as well. Burst applies share one coalesced read.
  useLedgerRefresh(vaultId, () => {
    refresh(false);
  });
}

// Empty-mirror fallback. Returns 'owner' so single-user installs (every
// Phase 2 install) and never-signed-in installs get unrestricted access.
// Phase 4's sync engine is the only thing that will ever produce a non-owner
// row, so until then the fallback path is what every caller actually hits.
const LOCAL_OWNER_DEFAULT: VaultRole = "owner";

async function readRoleFromDb(vaultId: string, accountId: string | null): Promise<VaultRole> {
  // Resolve EVERY id that represents me — the Google account_id AND the
  // deterministic device-key id. A kaata you were paired into keys your
  // vault_members_mirror row by the DEVICE-KEY id, but once you sign in the
  // passed accountId is the GOOGLE id. Looking up by the Google id alone missed
  // the device-keyed row, fell through to the owner default, and showed/gated a
  // paired EDITOR (or VIEWER) as OWNER. Matching against all of my ids reads my
  // TRUE role. A solo install with no mirror row still falls through to
  // LOCAL_OWNER_DEFAULT (local-only-must-keep-working invariant).
  // (Matee: "kaata settings always say owner ... even when I'm an editor".)
  const candidates = await resolveAccountIdCandidates(accountId);
  if (candidates.length === 0) return LOCAL_OWNER_DEFAULT;
  const db = await getDb();
  const placeholders = candidates.map(() => "?").join(",");
  // Revoked rows are SELECTED (no revoked_at filter) so "removed from this
  // vault" is distinguishable from "no row ever existed" — only the latter may
  // fall through to the owner default (local-only-must-keep-working invariant).
  // Filtering revoked rows out made a member whose vault_member_removed had
  // applied locally (leaveVaultRouted; pull inside the removal window) resolve
  // to zero rows → 'owner', rendering owner affordances for a vault they left.
  const rows = await db.getAllAsync<{
    account_id: string;
    role: VaultRole;
    revoked_at: number | null;
  }>(
    `SELECT account_id, role, revoked_at FROM vault_members_mirror
     WHERE vault_id = ? AND account_id IN (${placeholders})`,
    vaultId,
    ...candidates,
  );
  if (rows.length === 0) return LOCAL_OWNER_DEFAULT;
  const active = rows.filter((r) => r.revoked_at == null);
  if (active.length === 0) {
    // Every row for me is revoked: I was removed. VaultRole has no 'revoked'
    // value (adding one would ripple through every role switch in app/vault/*),
    // so return the most-restricted role instead. This only shapes UI — the
    // pre-append role-gate and the server both refuse a revoked member's
    // writes regardless.
    return "viewer";
  }
  // Usually exactly one row. If a corrupted dual-id state has several, prefer
  // the one for my primary (passed) id, else the first — deterministic, and it
  // reflects my actual granted role rather than over-assuming owner.
  const primary = candidates[0];
  const chosen = active.find((r) => r.account_id === primary) ?? active[0];
  return chosen.role;
}

/**
 * Imperative (non-hook) read of the active user's role on `vaultId` — the
 * same resolution useVaultRole / useActiveVaultWriteCaps render from, for
 * data-layer guards that run inside an async flow rather than a component
 * (lib/tabs/link.ts checks entry.create / entry.amend before touching the
 * tab outbox). Same local-owner default, same full-candidate-set matching.
 */
export async function readVaultRole(vaultId: string, accountId: string | null): Promise<VaultRole> {
  return readRoleFromDb(vaultId, accountId);
}

// Primer for the cache. auth.ts calls this after seeding vault_members_mirror
// so the first render of useVaultRole after sign-in returns 'owner' without
// a SELECT.
export function primeVaultRoleCache(vaultId: string, role: VaultRole): void {
  roleCache.set(vaultId, role);
}

/**
 * Resolves the active user's role within the given vault.
 *
 * Returns 'owner' synchronously on first render if the cache is hot OR if
 * the vault has no mirror row (local-only default). Otherwise returns
 * 'owner' as a safe initial value and re-renders once the SELECT completes.
 *
 * Phase 2 callers should treat the return value as informational only —
 * write affordances are unconditional. Phase 4 will flip UI gates onto
 * useVaultPermission(...).
 */
export function useVaultRole(vaultId: string, accountId: string | null): VaultRole {
  const initial = roleCache.get(vaultId) ?? LOCAL_OWNER_DEFAULT;
  const [role, setRole] = useState<VaultRole>(initial);
  const generation = useRef(0);

  // Re-read on focus, not only when args change: an ownership transfer
  // completed on the members screen changes THIS user's role without
  // changing (vaultId, accountId), and the mount-only read left settings
  // screens showing stale owner-only affordances until remount.
  const reread = useCallback(() => {
    let cancelled = false;
    const run = ++generation.current;
    readRoleFromDb(vaultId, accountId)
      .then((r) => {
        if (cancelled || run !== generation.current) return;
        roleCache.set(vaultId, r);
        setRole(r);
      })
      .catch(() => {
        // Read failure → leave the safe 'owner' default in place. A transient
        // DB hiccup must never silently lock the user out of their own data
        // (local-only-must-keep-working invariant).
      });
    return () => {
      cancelled = true;
      if (run === generation.current) generation.current++;
    };
  }, [vaultId, accountId]);

  useLiveRoleRefresh(vaultId, reread);

  return role;
}

/**
 * Sugar for the common UI-gate pattern. Phase 2: always returns true
 * (because role resolves to 'owner' and the PERMISSIONS table grants
 * everything to owners). Phase 4: returns false for editor/viewer on
 * restricted actions, and screens can render a "View only" chip instead
 * of a Save button.
 */
export function useVaultPermission(
  vaultId: string,
  accountId: string | null,
  action: VaultAction,
): boolean {
  const role = useVaultRole(vaultId, accountId);
  return useCallback(() => canPerformAction(role, action), [role, action])();
}

/**
 * Write capabilities for the active user on `vaultId`. Roles v2 split
 * (docs/roles-v2-design.md):
 *   canCreate — may APPEND (new entries / new people). False for viewers.
 *   canAmend  — may MUTATE HISTORY (edit/delete entries, rename people).
 *               False for viewers AND clerks (append-only role).
 * The single old boolean gated both create and edit affordances, which
 * cannot express a clerk. Defaults to true (local-only / owner), re-reads on
 * focus. The role-gate + server already REFUSE unauthorized writes; this
 * just stops users seeing buttons that would only fail.
 */
export function useActiveVaultWriteCaps(vaultId: string | null): {
  canCreate: boolean;
  canAmend: boolean;
  /** True only after the role for this exact vault was read successfully.
   * Consumers offering optional write/phone-book flows can wait for it. */
  resolved: boolean;
} {
  const [caps, setCaps] = useState<{
    canCreate: boolean;
    canAmend: boolean;
    resolvedVaultId: string | null | undefined;
    resolvedAccountId?: string | null;
  }>({ canCreate: true, canAmend: true, resolvedVaultId: undefined });
  const generation = useRef(0);
  const reread = useCallback(
    (invalidate = true) => {
      let cancelled = false;
      const run = ++generation.current;
      const accountId = getAccountIdSync();
      // Fail closed for optional write/phone-book flows throughout the new read,
      // including an in-place downgrade while this screen is continuously open.
      if (invalidate) setCaps((previous) => ({ ...previous, resolvedVaultId: undefined }));
      const current = () =>
        !cancelled && run === generation.current && getAccountIdSync() === accountId;
      const cancel = () => {
        cancelled = true;
        if (run === generation.current) generation.current++;
      };
      if (!vaultId) {
        setCaps({
          canCreate: true,
          canAmend: true,
          resolvedVaultId: null,
          resolvedAccountId: accountId,
        });
        return cancel;
      }
      // A background role event still invalidates permission immediately. The
      // resume listener pays the database read before restoring those controls.
      if (AppState.currentState !== "active") return cancel;
      readRoleFromDb(vaultId, accountId)
        .then((role) => {
          if (current()) {
            setCaps({
              canCreate: canPerformAction(role, "entry.create"),
              canAmend: canPerformAction(role, "entry.amend"),
              resolvedVaultId: vaultId,
              resolvedAccountId: accountId,
            });
          }
        })
        .catch(() => {
          // Never lock the user out on a transient DB error (local-only invariant).
          if (current()) setCaps({ canCreate: true, canAmend: true, resolvedVaultId: undefined });
        });
      return cancel;
    },
    [vaultId],
  );
  useLiveRoleRefresh(vaultId, reread);
  return {
    canCreate: caps.canCreate,
    canAmend: caps.canAmend,
    resolved: caps.resolvedVaultId === vaultId && caps.resolvedAccountId === getAccountIdSync(),
  };
}

/** Back-compat sugar: the append capability (hides creation for viewers). */
export function useActiveVaultCanWrite(vaultId: string | null): boolean {
  return useActiveVaultWriteCaps(vaultId).canCreate;
}

// Re-exported for callers that want the pure function without pulling in
// the hook surface (e.g. inside imperative handlers).
export { canPerformAction } from "./vault-roles";
