import assert from "node:assert/strict";
import { drainDeletionBackup } from "../account-deletion-backup";
import { compileUI } from "./ui-fixture";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

async function finalCleanupTests() {
  let pending = "",
    missing = false;
  let refusedEvents = [
    { event_id: "old", event_type: "entry_created", payload_json: '{"note":"private draft"}' },
  ];
  let refusedTabs = [{ id: "old-shared", op: "append", payload: '{"note":"other private draft"}' }];
  const helper = compileUI("../account-deletion-backup", {
    "./projection": { applyEventMutex: { runExclusive: (run: () => Promise<unknown>) => run() } },
    "./db-tx": {
      getDb: async () => ({
        getAllAsync: async (sql: string) => {
          if (missing) throw new Error("no such table: interrupted_reset");
          if (sql.includes("SELECT 1 AS pending"))
            return sql.includes(pending) && pending ? [{ pending: 1 }] : [];
          if (sql.includes("FROM event_log")) return refusedEvents;
          if (sql.includes("FROM tab_failed_ops")) return refusedTabs;
          throw new Error(sql);
        },
      }),
    },
    "./events": { isUserLedgerEventType: (kind: string) => kind.startsWith("entry_") },
    "expo-crypto": {
      CryptoDigestAlgorithm: { SHA256: "sha256" },
      digestStringAsync: async (_: string, value: string) =>
        createHash("sha256").update(value).digest("hex"),
    },
  });
  const before = await helper.captureDeletionCleanupBaseline();
  assert.match(before.events, /^[0-9a-f]{64}$/);
  assert.ok(
    !JSON.stringify(before).includes("private"),
    "keychain stores fingerprints, not duplicated financial text",
  );
  await helper.assertAccountDeletionCleanupSafe(before);
  for (const table of ["event_log", "tab_outbox", "customer_credit_limits"]) {
    pending = table;
    await assert.rejects(
      helper.assertAccountDeletionCleanupSafe(before),
      /late_edits/,
      `${table} newly queued during DELETE blocks wipe`,
    );
  }
  pending = "";
  refusedEvents = [
    ...refusedEvents,
    { event_id: "new", event_type: "entry_created", payload_json: "{}" },
  ];
  await assert.rejects(
    helper.assertAccountDeletionCleanupSafe(before),
    /late_edits/,
    "a fresh tally refused during DELETE is still new financial intent",
  );
  refusedEvents.pop();
  refusedTabs = [...refusedTabs, { id: "new-shared", op: "append", payload: "{}" }];
  await assert.rejects(
    helper.assertAccountDeletionCleanupSafe(before),
    /late_edits/,
    "a fresh shared tally moved to failed ops cannot disappear",
  );
  refusedTabs.pop();
  refusedEvents[0].payload_json = '{"note":"changed draft"}';
  await assert.rejects(
    helper.assertAccountDeletionCleanupSafe(before),
    /late_edits/,
    "changed preexisting draft content is not covered by old consent",
  );
  const changed = await helper.captureDeletionCleanupBaseline();
  await helper.assertAccountDeletionCleanupSafe(changed);
  await assert.rejects(
    helper.assertAccountDeletionCleanupSafe(null),
    /late_edits/,
    "legacy proof cannot authorize unknown refused drafts",
  );
  refusedEvents.push({ event_id: "device", event_type: "vault_device_added", payload_json: "{}" });
  await helper.assertAccountDeletionCleanupSafe(changed);
  missing = true;
  await helper.assertAccountDeletionCleanupSafe(before);
  assert.deepEqual(
    await helper.captureDeletionCleanupBaseline(),
    { events: "none", tabs: "none" },
    "interrupted cleanup can finish after already dropped tables",
  );
}

async function drainTests() {
  let count = 1250,
    calls = 0;
  await drainDeletionBackup({
    remaining: async () => count,
    sync: async () => {
      calls++;
      count = Math.max(0, count - 500);
    },
  });
  assert.equal(calls, 3, "all upload batches drain before a delete may start");
  assert.equal(count, 0);
  await drainDeletionBackup({
    remaining: async () => 0,
    sync: async () => {
      throw new Error("empty queues must not upload");
    },
  });
  await assert.rejects(
    drainDeletionBackup({ remaining: async () => 3, sync: async () => {} }),
    /backup_incomplete/,
    "an offline/no-op sync is not a backup acknowledgement",
  );
  let growing = 3;
  await assert.rejects(
    drainDeletionBackup({
      remaining: async () => growing,
      sync: async () => {
        growing++;
      },
    }),
    /backup_incomplete/,
  );
  await assert.rejects(
    drainDeletionBackup({
      remaining: async () => 1,
      sync: async () => {
        throw new Error("transport failure");
      },
    }),
    /transport failure/,
  );
  count = 105;
  calls = 0;
  await assert.rejects(
    drainDeletionBackup({
      remaining: async () => count,
      sync: async () => {
        count--;
        calls++;
      },
    }),
    /backup_incomplete/,
    "bounded work cannot claim the remaining edits were saved",
  );
  assert.equal(calls, 100);
  assert.equal(count, 5);
  let clock = 0;
  const timed = compileUI("../account-deletion-backup", {}, { Date: { now: () => clock } });
  count = 3;
  calls = 0;
  await assert.rejects(
    timed.drainDeletionBackup({
      remaining: async () => count,
      sync: async () => {
        calls++;
        count--;
        clock = 120_001;
      },
    }),
    /backup_incomplete/,
  );
  assert.equal(calls, 1, "the elapsed-time deadline stops before another batch");
}

function backupFixture() {
  const counts = new Map([
    ["v1", 1050],
    ["v2", 1],
  ]);
  const events: string[] = [];
  let rejected = 0,
    pendingTabs = 0,
    pendingPolicies = 0,
    syncError: Error | null = null,
    tabsError: Error | null = null,
    registrationError: Error | null = null;
  let beforeTabIds: string[] = [],
    refusedTabIds: string[] = [];
  const db = {
    getAllAsync: async (sql: string) => {
      if (sql.includes("FROM event_log")) {
        assert.ok(sql.includes("server_acked_at IS NULL"));
        assert.ok(sql.includes("rejected_at IS NULL"));
        assert.ok(sql.includes("tombstone_reason IS NULL"));
        return [...counts.keys()].map((id) => ({ id }));
      }
      if (sql.includes("FROM tab_outbox")) return beforeTabIds.map((id) => ({ id }));
      if (sql.includes("FROM tab_failed_ops")) return refusedTabIds.map((id) => ({ id }));
      throw new Error("unexpected backup list: " + sql);
    },
    getFirstAsync: async (sql: string, vaultId?: string) => {
      if (sql.includes("FROM event_log")) return { n: counts.get(vaultId!) ?? 0 };
      if (sql.includes("FROM tab_outbox")) return { n: pendingTabs };
      if (sql.includes("FROM customer_credit_limits")) return { n: pendingPolicies };
      if (sql.includes("FROM tab_failed_ops")) return { n: refusedTabIds.length };
      throw new Error("unexpected backup count: " + sql);
    },
  };
  const module = compileUI("../account-deletion-backup", {
    "./db-tx": { getDb: async () => db },
    "./sync/reconcile": {
      reconcileVaultRegistrations: async () => {
        events.push("register");
        if (registrationError) throw registrationError;
      },
    },
    "./sync": {
      syncOnce: async ({ vaultId }: { vaultId: string }) => {
        events.push("sync:" + vaultId);
        if (syncError) throw syncError;
        counts.set(vaultId, Math.max(0, counts.get(vaultId)! - 500));
        return { rejected };
      },
    },
    "./tabs/sync": {
      syncAllTabs: async () => {
        events.push("tabs");
        if (tabsError) throw tabsError;
      },
    },
  });
  return {
    module,
    counts,
    events,
    reject: (n: number) => {
      rejected = n;
    },
    pendingTabs: (n: number) => {
      pendingTabs = n;
    },
    pendingPolicies: (n: number) => {
      pendingPolicies = n;
    },
    syncError: (e: Error) => {
      syncError = e;
    },
    tabsError: (e: Error) => {
      tabsError = e;
    },
    registrationError: (e: Error) => {
      registrationError = e;
    },
    tabIds: (before: string[], refused: string[]) => {
      beforeTabIds = before;
      refusedTabIds = refused;
    },
  };
}

async function serviceTests() {
  const normal = backupFixture();
  await normal.module.prepareAccountDeletionBackup();
  assert.deepEqual(normal.events, ["register", "sync:v1", "sync:v1", "sync:v1", "sync:v2", "tabs"]);
  assert.equal(
    [...normal.counts.values()].reduce((sum, count) => sum + count, 0),
    0,
  );
  const refused = backupFixture();
  refused.reject(1);
  await assert.rejects(
    refused.module.prepareAccountDeletionBackup(),
    /backup_incomplete/,
    "a refused upload cannot be reported as a saved backup",
  );
  assert.ok(!refused.events.includes("tabs"));
  const tabs = backupFixture();
  tabs.pendingTabs(1);
  await assert.rejects(tabs.module.prepareAccountDeletionBackup(), /backup_incomplete/);
  const policy = backupFixture();
  policy.pendingPolicies(1);
  await assert.rejects(
    policy.module.prepareAccountDeletionBackup(),
    /backup_incomplete/,
    "queued private policy changes must be saved too",
  );
  const newlyRefusedTab = backupFixture();
  newlyRefusedTab.tabIds(["new-shared-tally"], ["old-draft", "new-shared-tally"]);
  await assert.rejects(
    newlyRefusedTab.module.prepareAccountDeletionBackup(),
    /backup_incomplete/,
    "moving an attempted shared tally from outbox to failed ops is not a saved backup",
  );
  for (const boundary of ["registrationError", "syncError", "tabsError"] as const) {
    const failure = backupFixture();
    failure[boundary](new Error(boundary));
    await assert.rejects(failure.module.prepareAccountDeletionBackup(), new RegExp(boundary));
  }
  // The prepare helper has no local reset/database mutation boundary. Every
  // failed proof leaves financial data intact for an explicit later retry.
}

// Audit #27: unsent edits in a kaata this phone can no longer reach (archived,
// gone, or every membership revoked) cannot hold the deletion forever.
async function unreachableTests() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY, archived_at INTEGER);
    CREATE TABLE vault_members_mirror(vault_id TEXT, account_id TEXT, revoked_at INTEGER);
    INSERT INTO vaults VALUES ('live', NULL), ('archived', 1), ('left', NULL), ('mixed', NULL);
    INSERT INTO vault_members_mirror VALUES ('live', 'me', NULL), ('left', 'me', 5),
      ('left', 'local:old', 6), ('mixed', 'me', 5), ('mixed', 'local:old', NULL);`);
  const db = {
    getFirstAsync: async (sql: string, ...args: unknown[]) =>
      sqlite.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...args),
  };
  const module = compileUI("../account-deletion-backup", {
    "./db-tx": { getDb: async () => db, getAccountIdSync: () => "me" },
    "./effective-account": { resolveAccountIdCandidates: async () => ["me", "local:old"] },
  });
  const unreachable = await module.unreachableVaults([
    "live",
    "archived",
    "left",
    "mixed",
    "gone",
    null,
  ]);
  assert.deepEqual(
    [...unreachable].sort(),
    ["archived", "gone", "left"],
    "archived, missing and fully revoked kaatas are unreachable; any live membership keeps one",
  );
  const broken = compileUI("../account-deletion-backup", {
    "./db-tx": {
      getDb: async () => {
        throw new Error("db down");
      },
      getAccountIdSync: () => "me",
    },
    "./effective-account": { resolveAccountIdCandidates: async () => ["me"] },
  });
  assert.equal(
    (await broken.unreachableVaults(["archived"])).size,
    0,
    "doubt keeps a kaata reachable",
  );
}

async function main() {
  await drainTests();
  await serviceTests();
  await finalCleanupTests();
  await unreachableTests();
  console.log(
    "Account deletion backup: upload batches, time/work bounds, refusals and pending queues passed.",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
