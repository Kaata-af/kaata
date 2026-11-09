import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { compileUI } from "./ui-fixture";

async function main() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE vaults (id TEXT, name TEXT, account_id TEXT, archived_at INTEGER);
    CREATE TABLE vault_members_mirror (vault_id TEXT, account_id TEXT, accepted_at INTEGER, revoked_at INTEGER);
    CREATE TABLE sync_state (vault_id TEXT, last_push_at INTEGER, last_pull_at INTEGER);
    CREATE TABLE event_log (vault_id TEXT, server_acked_at INTEGER, tombstone_reason TEXT);
    CREATE TABLE tab_links (tab_id TEXT, vault_id TEXT, closed_at INTEGER);
    CREATE TABLE tab_outbox (tab_id TEXT);
    CREATE TABLE tab_failed_ops (tab_id TEXT);
    CREATE TABLE customer_credit_limits (vault_id TEXT, sync_pending INTEGER);
    CREATE TABLE credit_alert_policies (vault_id TEXT, sync_pending INTEGER);
    CREATE TABLE customer_credit_limit_notifications (vault_id TEXT, sync_pending INTEGER);
    INSERT INTO vaults VALUES
      ('owned', 'Owned', 'me', NULL), ('joined', 'Joined', 'other', NULL),
      ('removed', 'Removed', 'other', NULL), ('foreign', 'Foreign', 'other', NULL);
    INSERT INTO vault_members_mirror VALUES ('joined', 'me', 1, NULL), ('removed', 'me', 1, 2);
    INSERT INTO sync_state VALUES ('owned', 10, 20), ('joined', NULL, 30);
    INSERT INTO event_log VALUES ('owned', NULL, NULL);
    INSERT INTO tab_links VALUES ('tab', 'joined', NULL);
    INSERT INTO tab_outbox VALUES ('tab');
  `);
  let account: string | null = "me";
  let online = true;
  let uploads = false;
  let calls = 0;
  const status = compileUI("../backup-status", {
    "expo-network": { getNetworkStateAsync: async () => ({ isConnected: online }) },
    "./auth": {
      captureCurrentSession: async () => ({ jwt: account ? "fixture" : null, accountId: account }),
      applyForCurrentSession: async (session: { accountId: string }, work: () => unknown) => {
        assert.equal(session.accountId, account);
        return work();
      },
    },
    "./db-backup": { listLocalBackups: () => [{ modifiedAt: 123 }] },
    "./db-tx": {
      getSessionAccountIdSync: () => account,
      getDb: async () => ({
        getAllAsync: async (sql: string, ...args: (string | null)[]) =>
          db.prepare(sql).all(...args),
      }),
    },
    "./effective-account": { resolveAccountIdCandidates: async () => [account] },
    "./sync": {
      syncOnce: async ({ vaultId }: { vaultId: string }) => {
        calls++;
        if (uploads) {
          db.prepare("UPDATE sync_state SET last_push_at=? WHERE vault_id=?").run(
            Date.now(),
            vaultId,
          );
          db.prepare("DELETE FROM event_log WHERE vault_id=?").run(vaultId);
        }
        return { rejected: 0 };
      },
    },
    "./tabs/sync": {
      syncTab: async () => {
        if (uploads) db.exec("DELETE FROM tab_outbox");
        return { ok: true, failed: 0 };
      },
    },
  });
  assert.deepEqual(await status.readBackupStatus(), {
    signedIn: true,
    cloudUpToDate: false,
    localBackupAt: 123,
    vaults: [
      { id: "joined", name: "Joined", lastPushAt: null, pending: true },
      { id: "owned", name: "Owned", lastPushAt: 10, pending: true },
    ],
  });

  online = false;
  await assert.rejects(status.syncBackupNow(), { code: "offline" });
  assert.equal(calls, 0);
  online = true;
  await assert.rejects(status.syncBackupNow(), { code: "incomplete" });
  assert.equal(calls, 2);

  uploads = true;
  await status.syncBackupNow();
  assert.equal(calls, 4);
  assert.equal((await status.readBackupStatus()).cloudUpToDate, true);
  assert.ok(
    (await status.readBackupStatus()).vaults.every(
      (vault: { pending: boolean; lastPushAt: number }) => !vault.pending && vault.lastPushAt > 30,
    ),
  );
  db.exec("INSERT INTO tab_outbox VALUES ('tab')");
  assert.equal((await status.readBackupStatus()).cloudUpToDate, false);
  account = null;
  assert.deepEqual(await status.readBackupStatus(), {
    signedIn: false,
    cloudUpToDate: false,
    localBackupAt: 123,
    vaults: [],
  });
  db.close();
  console.log(
    "PASS backup status: account scope, confirmed upload dates, pending queues and offline no-op",
  );
}

void main();
