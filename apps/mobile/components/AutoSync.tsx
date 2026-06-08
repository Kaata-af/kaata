import { useEffect, useState } from "react";

import { getAppMeta } from "../lib/db";
import { ACTIVE_VAULT_META_KEY } from "../lib/db-tx";
import { startSyncScheduler } from "../lib/sync";

// Auto-sync host. Mounts once at the app root and starts the sync
// scheduler (5s foreground / 30s background polling, mandatory
// pull-then-push, exponential backoff). Renders nothing.
//
// Reactive to (account_id, active_vault_id):
//   - Signed out (account_id == null) → noop. Local-only installs
//     must keep working with zero network traffic.
//   - Signed in but no active vault yet → wait. A sign-in that
//     completes before the active vault is cached would otherwise
//     race the scheduler's first tick and cause syncOnce to no-op
//     until the next 10s poll.
//   - Both set → start the scheduler. If either changes (sign-out then
//     sign-in as someone else, or default vault switched), the effect
//     tears the old scheduler down and starts a fresh one.
//
// Why this replaces the v0.4 AutoBackup component:
//   - v0.4 fired POST /v1/backup/upload on AppState→background as a
//     full-snapshot upload. Phase 3 retires that path: ledger state is
//     synced incrementally via the event log over /v1/sync/{push,pull}.
//   - The scheduler owns its own AppState listener and its own retry
//     policy, so this component is intentionally minimal.
//
// Phase 3 sibling task lib/sync/scheduler.ts gates the loop on
// Network.getNetworkStateAsync() internally — don't gate from here so
// backoff/retry timing stays in one place.

export function AutoSync() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);

  // Re-read account_id + active_vault_id periodically. The cheap-and-
  // cheerful approach until AppMetaContext exposes them reactively.
  // The scheduler mount/unmount is idempotent, and the polling cost is
  // two app_meta SELECTs every 10s. Phase 4 should wire observers.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const [id, vault] = await Promise.all([
        getAppMeta("account_id"),
        getAppMeta(ACTIVE_VAULT_META_KEY),
      ]);
      if (cancelled) return;
      setAccountId(id);
      setVaultId(vault);
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!accountId) return; // local-only mode — sync stays dormant
    if (!vaultId) return; // no active vault yet — wait
    const stop = startSyncScheduler({ accountId });
    return stop;
  }, [accountId, vaultId]);

  return null;
}
