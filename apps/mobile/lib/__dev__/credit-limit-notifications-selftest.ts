// Real shipped schema/cache and guarded API writes, using isolated SQLite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { compileUI, deferred } from "./ui-fixture";
import { Mutex } from "../util/mutex";
import { KAATA_DEFAULT_CREDIT_ID } from "../credit-policy";
import * as cache from "../credit-limit-notification-cache";
import {
  validCreditLimitNotificationPolicy,
  type CreditLimitNotificationPolicy,
} from "../credit-limit-notification-policy";
import type { SQLiteTx } from "../db-tx";
import type { SQLiteBindValue } from "expo-sqlite";

const p = (id = "r1", enabled = true, at = 1): CreditLimitNotificationPolicy => ({
  relationship_id: id,
  enabled,
  updated_at_ms: at,
});
const store = new Database(":memory:");
store.pragma("foreign_keys=ON");
store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,account_id TEXT,archived_at INTEGER);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER);
CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT);
CREATE TABLE event_log(id TEXT PRIMARY KEY,payload_json TEXT);
INSERT INTO vaults VALUES('v1',NULL,NULL),('v2',NULL,NULL);
INSERT INTO relationships VALUES('r1','v1','p1',NULL),('r2','v1','p2',NULL),('other','v2','p3',NULL);
INSERT INTO event_log VALUES('money','unchanged signed money');`);
const ddl =
  /execAsync\(`([^`]*CREATE TABLE IF NOT EXISTS customer_credit_limit_notifications[^`]*)`\)/.exec(
    readFileSync(require.resolve("../db"), "utf8"),
  )?.[1];
assert.ok(ddl, "Shipped migration 050 owns the new cache");
store.exec(ddl);
const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).run(...args),
  withTransactionAsync: async (work: () => Promise<void>) => {
    store.exec("BEGIN");
    try {
      await work();
      store.exec("COMMIT");
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  },
} as unknown as SQLiteTx;
let session = { jwt: null as string | null, accountId: null as string | null, bindingVersion: 1 };
let role = "owner",
  emits = 0;
const guard = async (before: typeof session, work: () => Promise<unknown>) => {
  if (JSON.stringify(before) !== JSON.stringify(session)) throw Error("session_changed");
  return work();
};
class CreditOnlineSaveRequiredError extends Error {}
const service = compileUI("../credit-limit-notifications", {
  "./auth": {
    captureCurrentSession: async () => ({ ...session }),
    applyForCurrentSession: guard,
    applyForUnchangedLocalSession: guard,
  },
  "./api": { getBackendUrl: async () => "https://limit-notifications.fixture.invalid" },
  "./db-tx": { getDb: async () => db, getActiveVaultIdSyncMaybe: () => "v1" },
  "./use-vault-role": { readVaultRole: async () => role },
  "./effective-account": { resolveAccountIdCandidates: async () => ["local:owner"] },
  "./currency-sync": {
    currencyRequestHeaders: async () => ({}),
    ensureCurrencySyncSupported: async () => {},
  },
  "./credit-policy": require("../credit-policy"),
  "./credit-policy-events": {
    emitCreditPoliciesChanged: () => {
      assert.equal(store.inTransaction, false);
      emits++;
    },
  },
  "./util/mutex": { Mutex },
  "./credit-limit-notification-policy": require("../credit-limit-notification-policy"),
  "./credit-limit-notification-cache": cache,
  "./credit-limits": { CreditOnlineSaveRequiredError },
  "./projection": { applyEventMutex: new Mutex() },
  "./sync/push": {
    pushEvents: async () => {
      assert.equal(store.inTransaction, false);
    },
  },
}) as typeof import("../credit-limit-notifications");
const realFetch = globalThis.fetch;
let server: CreditLimitNotificationPolicy[] = [],
  stamp = Date.now() - 10_000,
  httpStatus = 200,
  capability = true;
let wait: ReturnType<typeof deferred<void>> | null = null;
let dropped = false;
globalThis.fetch = async (url, init) => {
  assert.equal(store.inTransaction, false, "Network never holds the SQLite writer");
  if (httpStatus !== 200) return new Response(null, { status: httpStatus });
  const headers = () => ({
    "X-Kaata-Credit-Updated-At": String(stamp),
    ...(capability ? { "X-Kaata-Credit-Limit-Notifications": "1" } : {}),
  });
  if (init?.method === "PUT") {
    const row = { ...JSON.parse(String(init.body)), updated_at_ms: ++stamp };
    assert.deepEqual(Object.keys(row).sort(), ["enabled", "relationship_id", "updated_at_ms"]);
    if (dropped) row.enabled = !row.enabled;
    server = server.filter((s) => s.relationship_id !== row.relationship_id).concat(row);
    if (wait) await wait.promise;
    return Response.json(row, { headers: headers() });
  }
  if (init?.method === "DELETE") {
    stamp++;
    server = server.filter(
      (s) => s.relationship_id !== new URL(String(url)).searchParams.get("relationship_id"),
    );
    if (wait) await wait.promise;
    return new Response(null, { status: 204, headers: headers() });
  }
  const rows = structuredClone(server),
    revision = stamp;
  if (wait) await wait.promise;
  return Response.json(rows, {
    headers: { ...headers(), "X-Kaata-Credit-Updated-At": String(revision) },
  });
};

async function missingSchemaChecks() {
  const old = new Database(":memory:");
  const tx = {
    getFirstAsync: async (sql: string, ...args: any[]) => old.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string) => old.prepare(sql).all(),
  } as unknown as SQLiteTx;
  assert.equal(await cache.readCreditLimitNotificationSettingInTx(tx, "v1", "r1"), null);
  await assert.rejects(cache.cacheCreditLimitNotifications(tx, "v1", [p()], 1), /no such table/);
  const failure = new Error("database disk image is malformed");
  await assert.rejects(
    cache.readCreditLimitNotificationPolicyInTx(
      {
        getFirstAsync: async () => {
          throw failure;
        },
      } as unknown as SQLiteTx,
      "v1",
      "r1",
    ),
    (e) => e === failure,
  );
  old.close();
}

async function snapshotChecks() {
  const observation = require("../credit-alert-observation");
  const restoreDb = {
    ...db,
    getFirstAsync: async (sql: string, ...args: SQLiteBindValue[]) => {
      if (sql.includes("FROM event_log")) return { n: 1 };
      return db.getFirstAsync(sql, ...args);
    },
    runAsync: async (sql: string, ...args: SQLiteBindValue[]) => {
      assert.equal(observation.creditAlertObservationPaused(), true);
      return sql.includes("customer_credit_limit_notifications")
        ? db.runAsync(sql, ...args)
        : { changes: 0 };
    },
  };
  const restore = compileUI("../restore", {
    "./credit-policy-cache": {},
    "./credit-alert-observation": observation,
    "./credit-limit-notification-cache": cache,
    "./api": {},
    "./currency-sync": {},
    "./auth": {},
    "./db-tx": {
      getDb: async () => restoreDb,
      getAppMetaInTx: async () => null,
      setAppMetaInTx: async () => {},
    },
    "./hlc": require("../hlc"),
    "./projection/field-hlc": {},
    "./entry-date": {},
    "./currency-metadata": { assertLegacyCurrencyMatches: async () => {} },
    "./currency-scope": {},
    "./customer-group-restore": {},
    "./projection": { applyEventMutex: new Mutex() },
    "./projection/ingest-row": { ingestPulledEvents: async () => 0 },
    "./projection/sweep": { sweepVaultNow: async () => {} },
    "./sync/cursor": {},
  }) as typeof import("../restore");
  const snapshot = {
    vault: { id: "v2", vault_trust_anchor_pubkey: "existing-anchor" },
    relationships: [],
    users: [],
    entries: [],
    events: [],
    snapshot_server_seq: 1,
    generated_at_ms: Date.now(),
    hlc_last: "",
    credit_limit_notifications: [p("other", true, ++stamp)],
  } as unknown as import("../restore").Snapshot;
  await restore.restoreFromSnapshot(snapshot, { localSelfId: "self", setActiveDefault: false });
  assert.equal(
    (await cache.readCreditLimitNotificationSettingInTx(db, "v2", "other"))?.enabled,
    true,
    "A real snapshot restore preserves the shared notification configuration",
  );
  assert.equal(observation.creditAlertObservationPaused(), false);
  store
    .prepare(
      "UPDATE customer_credit_limit_notifications SET enabled=0,sync_pending=1 WHERE vault_id='v2'",
    )
    .run();
  await restore.restoreFromSnapshot(snapshot, { localSelfId: "self", setActiveDefault: false });
  assert.equal(
    (await cache.readCreditLimitNotificationSettingInTx(db, "v2", "other"))?.enabled,
    false,
    "Restore preserves an unsent local switch edit",
  );
}

async function checks() {
  await missingSchemaChecks();
  assert.equal(validCreditLimitNotificationPolicy(p()), true);
  for (const bad of [
    { ...p(), enabled: 1 },
    { ...p(), updated_at_ms: -1 },
    { ...p(), relationship_id: "" },
  ])
    assert.equal(validCreditLimitNotificationPolicy(bad), false);
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r1")).effective,
    null,
    "Existing customers do not silently opt in",
  );
  await service.saveCreditLimitNotifications("v1", p());
  assert.equal(
    (await cache.readCreditLimitNotificationSettingInTx(db, "v1", "r1"))?.sync_pending,
    true,
  );
  await cache.cacheCreditLimitNotifications(db, "v1", [], Date.now() + 1, true);
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r1")).effective?.enabled,
    true,
    "Pending intent survives empty snapshots",
  );
  await assert.rejects(
    service.saveCreditLimitNotifications("v1", p(KAATA_DEFAULT_CREDIT_ID)),
    CreditOnlineSaveRequiredError,
  );
  role = "clerk";
  await assert.rejects(service.saveCreditLimitNotifications("v1", p()), /Manager required/);
  role = "owner";
  store.prepare("INSERT INTO vault_members_mirror VALUES('v1','someone-else')").run();
  await assert.rejects(
    service.saveCreditLimitNotifications("v1", p()),
    /Shared credit notifications/,
  );
  store.prepare("DELETE FROM vault_members_mirror").run();
  session = { jwt: "jwt", accountId: "owner", bindingVersion: 2 };
  await service.refreshCreditLimitNotifications("v1");
  assert.equal(
    (await cache.readCreditLimitNotificationSettingInTx(db, "v1", "r1"))?.sync_pending,
    false,
  );
  await service.saveCreditLimitNotifications("v1", p(KAATA_DEFAULT_CREDIT_ID));
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r2")).effective?.enabled,
    true,
  );
  await service.saveCreditLimitNotifications("v1", p("r2", false));
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r2")).effective?.enabled,
    false,
    "Explicit customer OFF overrides default ON",
  );
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v2", "other")).effective,
    null,
    "Defaults cannot leak between Kaatas",
  );
  const stale = (await service.loadCreditLimitNotificationSettings("v1", "r2")).policy!;
  await service.deleteCreditLimitNotifications("v1", "r2");
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r2")).effective?.enabled,
    true,
  );
  await cache.cacheCreditLimitNotifications(db, "v1", [...server, stale], Date.now() + 1000);
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r2")).policy,
    null,
    "An old snapshot cannot resurrect a reset override",
  );
  await cache.cacheCreditLimitNotifications(db, "v1", [p("other", true, ++stamp)], stamp, true);
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "other")).policy,
    null,
    "Snapshot rows must belong to this Kaata",
  );
  await service.saveCreditLimitNotifications("v1", p("r1", true));
  const beforeUnsupported = (await service.loadCreditLimitNotificationSettings("v1", "r1")).policy;
  httpStatus = 404;
  await service.refreshCreditLimitNotifications("v1");
  await assert.rejects(
    service.saveCreditLimitNotifications("v1", p("r1", false)),
    service.CreditLimitNotificationsUnsupportedError,
  );
  assert.deepEqual(
    (await service.loadCreditLimitNotificationSettings("v1", "r1")).policy,
    beforeUnsupported,
  );
  httpStatus = 200;
  capability = false;
  await assert.rejects(
    service.saveCreditLimitNotifications("v1", p("r1", false)),
    service.CreditLimitNotificationsUnsupportedError,
  );
  capability = true;
  dropped = true;
  await assert.rejects(
    service.saveCreditLimitNotifications("v1", p("r1", false)),
    /Invalid credit limit notification response/,
  );
  dropped = false;
  const latch = deferred<void>();
  wait = latch;
  const saving = service.saveCreditLimitNotifications("v1", p("r1", false));
  await new Promise((r) => setTimeout(r, 0));
  session = { ...session, accountId: "another", bindingVersion: 3 };
  latch.resolve();
  await assert.rejects(saving, /session_changed/);
  wait = null;
  assert.deepEqual(
    (await service.loadCreditLimitNotificationSettings("v1", "r1")).policy,
    beforeUnsupported,
    "A late response cannot land in a changed session",
  );
  session = { jwt: null, accountId: null, bindingVersion: 4 };
  await service.saveCreditLimitNotifications("v1", p("r1"));
  await service.deleteCreditLimitNotifications("v1", "r1");
  assert.equal((await service.loadCreditLimitNotificationSettings("v1", "r1")).policy, null);
  await cache.cacheCreditLimitNotifications(
    db,
    "v1",
    [p("r1", true, ++stamp)],
    Date.now() + 5000,
    true,
  );
  assert.equal(
    (await service.loadCreditLimitNotificationSettings("v1", "r1")).policy,
    null,
    "An unsent reset survives a server observation",
  );
  session = { jwt: "jwt", accountId: "owner", bindingVersion: 5 };
  await service.uploadPendingCreditLimitNotifications("v1");
  assert.deepEqual(
    store
      .prepare(
        "SELECT deleted,sync_pending FROM customer_credit_limit_notifications WHERE vault_id='v1' AND relationship_id='r1'",
      )
      .get(),
    { deleted: 1, sync_pending: 0 },
    "A private reset is uploaded rather than lost at enrollment",
  );
  assert.deepEqual(store.prepare("SELECT * FROM event_log").all(), [
    { id: "money", payload_json: "unchanged signed money" },
  ]);
  assert.ok(emits > 0);
  await snapshotChecks();
  console.log(
    "PASS credit limit notification data: shipped schema, inherited defaults/explicit OFF, private pending writes, roles/session isolation, stale snapshot/reset protection, capability validation and unchanged financial records",
  );
}
checks()
  .finally(() => {
    globalThis.fetch = realFetch;
    store.close();
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
