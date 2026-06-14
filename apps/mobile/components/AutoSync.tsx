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
// Why this replaces the old AutoBackup component:
//   - v0.4 fired POST /v1/backup/upload on AppState→background as a
//     full-snapshot upload. That whole backup path is now RETIRED (M5,
//     docs/m5-recovery.md §4): ledger state syncs incrementally via the
//     event log over /v1/sync/{push,pull}, and recovery rebuilds from the
//     per-vault snapshot+tail (lib/recovery.ts), not a mega-snapshot.
//   - The scheduler owns its own AppState listener and its own retry
//     policy, so this component is intentionally minimal.
//
// Phase 3 sibling task lib/sync/scheduler.ts gates the loop on
// Network.getNetworkStateAsync() internally — don't gate from here so
// backoff/retry timing stays in one place.

export function AutoSync() {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<string | null>(null);
  // Cloud backup opt-in. Default ON when the key is unset so existing signed-in
  // installs keep syncing (they synced unconditionally before this gate); only
  // an explicit "0" (toggle off) stops the cloud channel. The mesh channels
  // (BT/LAN) are independent — turning cloud off never affects Nearby sync.
  const [cloudEnabled, setCloudEnabled] = useState(true);

  // Re-read account_id + active_vault_id periodically. The cheap-and-
  // cheerful approach until AppMetaContext exposes them reactively.
  // The scheduler mount/unmount is idempotent, and the polling cost is
  // two app_meta SELECTs every 10s. Phase 4 should wire observers.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const [id, vault, cloud] = await Promise.all([
        getAppMeta("account_id"),
        getAppMeta(ACTIVE_VAULT_META_KEY),
        getAppMeta("cloud_sync_enabled"),
      ]);
      if (cancelled) return;
      setAccountId(id);
      setVaultId(vault);
      setCloudEnabled(cloud == null ? true : cloud === "1");
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
    if (!cloudEnabled) return; // cloud backup turned off — mesh still runs
    const stop = startSyncScheduler({ accountId });
    return stop;
  }, [accountId, vaultId, cloudEnabled]);

  return null;
}
