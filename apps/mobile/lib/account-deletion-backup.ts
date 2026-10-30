// A delete request must not erase financial edits which never reached the cloud.
// Use the normal signed sync path; do not manufacture a replacement snapshot.
export type DeletionCleanupBaseline = { events: string; tabs: string };

// Only fingerprints are persisted; never duplicate financial notes in keychain.
// A missing table is possible after an interrupted, confirmed local reset.
async function deletionRows<T>(sql: string): Promise<T[] | null> {
  const { getDb } = await import("./db-tx");
  try {
    return await (await getDb()).getAllAsync<T>(sql);
  } catch (error) {
    if (error instanceof Error && /no such table:/i.test(error.message)) return null;
    throw error;
  }
}

async function refusedFingerprints(): Promise<{ events: string | null; tabs: string | null }> {
  const { isUserLedgerEventType } = await import("./events");
  const events = await deletionRows<{ event_id: string; event_type: string; payload_json: string }>(
    `SELECT event_id,event_type,payload_json FROM event_log
     WHERE server_acked_at IS NULL AND (rejected_at IS NOT NULL OR tombstone_reason IS NOT NULL)
     ORDER BY event_id`,
  );
  const tabs = await deletionRows<{ id: string; op: string; payload: string }>(
    "SELECT id,op,payload FROM tab_failed_ops ORDER BY id",
  );
  async function fingerprint(values: unknown[] | null): Promise<string | null> {
    if (values === null) return null;
    if (!values.length) return "none";
    const Crypto = await import("expo-crypto");
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(values));
  }
  return {
    events: await fingerprint(
      events
        ?.filter((row) => isUserLedgerEventType(row.event_type))
        .map((row) => [row.event_id, row.event_type, row.payload_json]) ?? null,
    ),
    tabs: await fingerprint(tabs?.map((row) => [row.id, row.op, row.payload]) ?? null),
  };
}

/** Kaatas this phone can no longer write to: archived or gone here, or every
 * membership of this phone's accounts there is revoked (left, removed). Their
 * unsent edits can never reach the server, so they must not block deletion
 * forever (audit #27); the confirmation asks the user to export statements
 * first. Any doubt (an error, an unknown state) keeps a kaata reachable. */
export async function unreachableVaults(
  vaultIds: readonly (string | null)[],
): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const [{ getDb, getAccountIdSync }, { resolveAccountIdCandidates }] = await Promise.all([
      import("./db-tx"),
      import("./effective-account"),
    ]);
    const db = await getDb();
    const mine = await resolveAccountIdCandidates(getAccountIdSync());
    for (const vaultId of vaultIds) {
      if (!vaultId) continue;
      const vault = await db.getFirstAsync<{ archived_at: number | null }>(
        "SELECT archived_at FROM vaults WHERE id = ?",
        vaultId,
      );
      if (!vault || vault.archived_at != null) {
        out.add(vaultId);
        continue;
      }
      if (!mine.length) continue;
      const rows = await db.getAllAsync<{ revoked_at: number | null }>(
        `SELECT revoked_at FROM vault_members_mirror
          WHERE vault_id = ? AND account_id IN (SELECT value FROM json_each(?))`,
        vaultId,
        JSON.stringify(mine),
      );
      if (rows.length > 0 && rows.every((row) => row.revoked_at != null)) out.add(vaultId);
    }
  } catch {
    return new Set();
  }
  return out;
}

/** Capture only previously refused intent, covered by the explicit export warning. */
export async function captureDeletionCleanupBaseline(): Promise<DeletionCleanupBaseline> {
  const { applyEventMutex } = await import("./projection");
  const value = await applyEventMutex.runExclusive(refusedFingerprints);
  return { events: value.events ?? "none", tabs: value.tabs ?? "none" };
}

/** Caller holds applyEventMutex through this check AND dropping/closing the DB. */
export async function assertAccountDeletionCleanupSafe(
  baseline: DeletionCleanupBaseline | null,
): Promise<void> {
  for (const query of [
    `SELECT 1 AS pending FROM event_log WHERE server_acked_at IS NULL
     AND rejected_at IS NULL AND tombstone_reason IS NULL LIMIT 1`,
    "SELECT 1 AS pending FROM tab_outbox LIMIT 1",
    "SELECT 1 AS pending FROM customer_credit_limits WHERE sync_pending<>0 LIMIT 1",
    "SELECT 1 AS pending FROM credit_alert_policies WHERE sync_pending<>0 LIMIT 1",
    "SELECT 1 AS pending FROM customer_credit_limit_notifications WHERE sync_pending<>0 LIMIT 1",
  ]) {
    if (!(await deletionRows(query))?.length) continue;
    // Unsent edits only in kaatas this phone can no longer reach cannot be
    // backed up by anyone; they do not hold the deletion (audit #27).
    if (query.includes("FROM event_log")) {
      const vaults = await deletionRows<{ vault_id: string | null }>(
        `SELECT DISTINCT vault_id FROM event_log WHERE server_acked_at IS NULL
         AND rejected_at IS NULL AND tombstone_reason IS NULL`,
      );
      const ids = (vaults ?? []).map((row) => row.vault_id);
      const unreachable = await unreachableVaults(ids);
      if (ids.length > 0 && ids.every((id) => id != null && unreachable.has(id))) continue;
    }
    throw new Error("account_delete_late_edits");
  }
  const current = await refusedFingerprints();
  if (
    (current.events !== null && current.events !== (baseline?.events ?? "none")) ||
    (current.tabs !== null && current.tabs !== (baseline?.tabs ?? "none"))
  ) {
    throw new Error("account_delete_late_edits");
  }
}

export async function prepareAccountDeletionBackup(): Promise<void> {
  const [{ getDb }, { syncOnce }, { reconcileVaultRegistrations }] = await Promise.all([
    import("./db-tx"),
    import("./sync"),
    import("./sync/reconcile"),
  ]);
  await reconcileVaultRegistrations();
  const db = await getDb();
  const vaults = await db.getAllAsync<{ id: string }>(
    `SELECT DISTINCT vault_id AS id FROM event_log
     WHERE server_acked_at IS NULL AND rejected_at IS NULL AND tombstone_reason IS NULL`,
  );
  const unreachable = await unreachableVaults(vaults.map((vault) => vault.id));
  for (const vault of vaults) {
    // Edits in a kaata left, removed from or archived can never be pushed;
    // waiting on them made deletion fail forever (audit #27).
    if (unreachable.has(vault.id)) continue;
    await drainDeletionBackup({
      remaining: async () => {
        const row = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM event_log WHERE vault_id=?
           AND server_acked_at IS NULL AND rejected_at IS NULL AND tombstone_reason IS NULL`,
          vault.id,
        );
        return row?.n ?? 0;
      },
      sync: async () => {
        const result = await syncOnce({ vaultId: vault.id });
        if (result.rejected > 0) throw new Error("account_delete_backup_incomplete");
      },
    });
  }
  // Shared-account intent has its own server/outbox; vault sync cannot save it.
  const { syncAllTabs } = await import("./tabs/sync");
  const attemptedTabs = new Set(
    (await db.getAllAsync<{ id: string }>("SELECT id FROM tab_outbox")).map((row) => row.id),
  );
  await syncAllTabs();
  const refusedTabs = await db.getAllAsync<{ id: string }>("SELECT id FROM tab_failed_ops");
  if (refusedTabs.some((row) => attemptedTabs.has(row.id))) {
    throw new Error("account_delete_backup_incomplete");
  }
  const pending = await db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM tab_outbox");
  if ((pending?.n ?? 0) > 0) throw new Error("account_delete_backup_incomplete");
  const policies = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_credit_limits WHERE sync_pending<>0",
  );
  if ((policies?.n ?? 0) > 0) throw new Error("account_delete_backup_incomplete");
  const alerts = await deletionRows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM credit_alert_policies WHERE sync_pending<>0",
  );
  if ((alerts?.[0]?.n ?? 0) > 0) throw new Error("account_delete_backup_incomplete");
  const limitNotifications = await deletionRows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM customer_credit_limit_notifications WHERE sync_pending<>0",
  );
  if ((limitNotifications?.[0]?.n ?? 0) > 0) throw new Error("account_delete_backup_incomplete");
}

export async function drainDeletionBackup(deps: {
  remaining: () => Promise<number>;
  sync: () => Promise<unknown>;
}): Promise<void> {
  let remaining = await deps.remaining();
  const deadline = Date.now() + 120_000;
  for (let batch = 0; remaining > 0 && batch < 100; batch++) {
    if (Date.now() > deadline) throw new Error("account_delete_backup_incomplete");
    await deps.sync();
    const next = await deps.remaining();
    // Offline no-op, backoff, refused edits and incomplete registration must
    // never look like a successful backup just because syncOnce resolved.
    if (next >= remaining) throw new Error("account_delete_backup_incomplete");
    remaining = next;
  }
  if (remaining > 0) throw new Error("account_delete_backup_incomplete");
}
