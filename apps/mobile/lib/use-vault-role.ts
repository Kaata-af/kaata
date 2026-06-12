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
import { useCallback, useEffect, useState } from "react";
import { getDb } from "./db-tx";
import { invalidateRoleGateCache } from "./projection/role-gate";
import { canPerformAction, type VaultAction, type VaultRole } from "./vault-roles";

// Process-local cache. Cleared on sign-out and on every applied
// vault_member_* event (Phase 4). For now the only invalidation source is
// the sign-in path that seeds the row via auth.ts (which writes to
// vault_members_mirror inside its post-sign-in housekeeping transaction).
const roleCache = new Map<string, VaultRole>();

export function invalidateVaultRoleCache(vaultId?: string): void {
  if (vaultId) roleCache.delete(vaultId);
  else roleCache.clear();
  // Phase 8 D-ROLE-ENFORCEMENT-MOBILE: chain through to the projection
  // role-gate cache so an in-flight delta-sync batch can't observe a
  // stale role across the mirror update boundary.
  invalidateRoleGateCache(vaultId);
}

// Empty-mirror fallback. Returns 'owner' so single-user installs (every
// Phase 2 install) and never-signed-in installs get unrestricted access.
// Phase 4's sync engine is the only thing that will ever produce a non-owner
// row, so until then the fallback path is what every caller actually hits.
const LOCAL_OWNER_DEFAULT: VaultRole = "owner";

async function readRoleFromDb(vaultId: string, accountId: string | null): Promise<VaultRole> {
  // Local-only install (no Google sign-in) → no mirror row to look up.
  if (!accountId) return LOCAL_OWNER_DEFAULT;
  const db = await getDb();
  const row = await db.getFirstAsync<{ role: VaultRole }>(
    `SELECT role FROM vault_members_mirror
     WHERE vault_id = ? AND account_id = ?
       AND revoked_at IS NULL
     LIMIT 1`,
    vaultId,
    accountId,
  );
  return row?.role ?? LOCAL_OWNER_DEFAULT;
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

  // Re-read on focus, not only when args change: an ownership transfer
  // completed on the members screen changes THIS user's role without
  // changing (vaultId, accountId), and the mount-only read left settings
  // screens showing stale owner-only affordances until remount.
  const reread = useCallback(() => {
    let cancelled = false;
    readRoleFromDb(vaultId, accountId)
      .then((r) => {
        if (cancelled) return;
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
    };
  }, [vaultId, accountId]);

  useEffect(() => reread(), [reread]);
  useFocusEffect(reread);

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

// Re-exported for callers that want the pure function without pulling in
// the hook surface (e.g. inside imperative handlers).
export { canPerformAction } from "./vault-roles";
