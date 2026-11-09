import * as Network from "expo-network";
import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "./auth";
import { listLocalBackups } from "./db-backup";
import { getDb, getSessionAccountIdSync } from "./db-tx";
import { resolveAccountIdCandidates } from "./effective-account";
import { syncOnce } from "./sync";
import { syncTab } from "./tabs/sync";

type CloudVault = { id: string; name: string; lastPushAt: number | null; pending: boolean };
type CloudVaultRow = Omit<CloudVault, "pending"> & { pending: number; archived: number };
type BackupStatus = {
  signedIn: boolean;
  vaults: CloudVault[];
  cloudUpToDate: boolean;
  localBackupAt: number | null;
};

export class BackupSyncError extends Error {
  constructor(readonly code: "offline" | "incomplete") {
    super(code);
    this.name = "BackupSyncError";
  }
}

async function cloudVaults(session: SessionSnapshot): Promise<CloudVaultRow[]> {
  const candidates = JSON.stringify(await resolveAccountIdCandidates(session.accountId));
  return applyForCurrentSession(session, async () => {
    const db = await getDb();
    return db.getAllAsync<CloudVaultRow>(
      `WITH mine(account_id) AS (SELECT value FROM json_each(?))
       SELECT v.id, v.name, s.last_push_at AS lastPushAt, v.archived_at IS NOT NULL AS archived,
              (EXISTS (SELECT 1 FROM event_log e WHERE e.vault_id=v.id AND e.server_acked_at IS NULL
                         AND e.tombstone_reason IS NULL)
               OR EXISTS (SELECT 1 FROM tab_links t JOIN tab_outbox o ON o.tab_id=t.tab_id
                           WHERE t.vault_id=v.id)
               OR EXISTS (SELECT 1 FROM tab_links t JOIN tab_failed_ops f ON f.tab_id=t.tab_id
                           WHERE t.vault_id=v.id)
               OR EXISTS (SELECT 1 FROM customer_credit_limits c WHERE c.vault_id=v.id AND c.sync_pending<>0)
               OR EXISTS (SELECT 1 FROM credit_alert_policies p WHERE p.vault_id=v.id AND p.sync_pending<>0)
               OR EXISTS (SELECT 1 FROM customer_credit_limit_notifications n
                           WHERE n.vault_id=v.id AND n.sync_pending<>0)) AS pending
         FROM vaults v LEFT JOIN sync_state s ON s.vault_id=v.id
        WHERE EXISTS (SELECT 1 FROM vault_members_mirror m JOIN mine a ON a.account_id=m.account_id
                       WHERE m.vault_id=v.id AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL)
           OR ((v.account_id=? OR v.account_id IS NULL) AND NOT EXISTS (
                 SELECT 1 FROM vault_members_mirror m WHERE m.vault_id=v.id))
        ORDER BY archived, v.name COLLATE NOCASE, v.id`,
      candidates,
      session.accountId,
    );
  });
}

export async function readBackupStatus(): Promise<BackupStatus> {
  const session = await captureCurrentSession();
  const signedIn =
    !!session.jwt && !!session.accountId && session.accountId === getSessionAccountIdSync();
  const localBackupAt = listLocalBackups()[0]?.modifiedAt ?? null;
  const rows = signedIn ? await cloudVaults(session) : [];
  const current = rows.filter((vault) => !vault.archived || vault.pending);
  return {
    signedIn,
    localBackupAt,
    cloudUpToDate: current.length > 0 && current.every((vault) => Boolean(vault.lastPushAt) && !vault.pending),
    vaults: rows.map(({ id, name, lastPushAt, pending }) => ({
      id,
      name,
      lastPushAt,
      pending: pending !== 0,
    })),
  };
}

export async function syncBackupNow(): Promise<void> {
  const session = await captureCurrentSession();
  if (!session.jwt || !session.accountId || session.accountId !== getSessionAccountIdSync())
    throw new BackupSyncError("incomplete");
  const network = await Network.getNetworkStateAsync();
  if (network.isConnected === false || network.isInternetReachable === false)
    throw new BackupSyncError("offline");
  const rows = (await cloudVaults(session)).filter((vault) => !vault.archived || vault.pending);
  if (rows.length === 0) return;
  const started = Date.now();
  let failed = false;
  for (const vault of rows) {
    await applyForCurrentSession(session, async () => {});
    try {
      const result = await syncOnce({ vaultId: vault.id });
      if (result.rejected > 0) failed = true;
      const tabs = await applyForCurrentSession(session, async () =>
        (await getDb()).getAllAsync<{ tab_id: string }>(
          `SELECT t.tab_id FROM tab_links t
            WHERE t.vault_id=? AND (t.closed_at IS NULL OR EXISTS (
              SELECT 1 FROM tab_outbox o WHERE o.tab_id=t.tab_id))`,
          vault.id,
        ),
      );
      for (const { tab_id } of tabs) {
        await applyForCurrentSession(session, async () => {});
        const tab = await syncTab(tab_id);
        if (!tab.ok || tab.failed > 0) failed = true;
      }
    } catch {
      failed = true;
    }
  }
  const latest = new Map((await cloudVaults(session)).map((vault) => [vault.id, vault]));
  if (
    failed ||
    rows.some(({ id }) => {
      const vault = latest.get(id);
      return !vault || vault.pending !== 0 || (vault.lastPushAt ?? 0) < started;
    })
  )
    throw new BackupSyncError("incomplete");
}
