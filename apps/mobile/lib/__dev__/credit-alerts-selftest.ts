// Real alert rules/cache/migration/storage with isolated SQLite and simulated
// session/network boundaries. No account or device notification is contacted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import { Mutex } from "../util/mutex";
import { KAATA_DEFAULT_CREDIT_ID } from "../credit-policy";
import {
  creditAlertExceeded,
  creditAlertFingerprint,
  evaluateCreditAlertDirections,
  validCreditAlertPolicy,
  type CreditAlertPolicy,
} from "../credit-alert-policy";
import * as cache from "../credit-alert-cache";
import type { SQLiteTx } from "../db-tx";

const groups: CreditAlertPolicy["groups"] = [
  {
    direction: "collect",
    conditions: [
      { currency: "USD", threshold_minor: 500000 },
      { currency: "AFN", threshold_minor: 10000000 },
    ],
  },
  {
    direction: "collect",
    conditions: [
      { currency: "USD", threshold_minor: 800000 },
      { currency: "AFN", threshold_minor: 8000000 },
    ],
  },
];
const policy = (id = "r1", at = 1): CreditAlertPolicy => ({
  relationship_id: id,
  groups: structuredClone(groups),
  updated_at_ms: at,
});

function pureChecks() {
  const p = policy();
  assert.equal(validCreditAlertPolicy(p), true);
  assert.deepEqual(evaluateCreditAlertDirections(p, { USD: 500000, AFN: 10000000 }), {
    collect: "matched",
    pay: "clear",
  });
  assert.equal(evaluateCreditAlertDirections(p, { USD: 800000, AFN: 8000000 }).collect, "matched");
  assert.equal(evaluateCreditAlertDirections(p, { USD: 500000, AFN: 8000000 }).collect, "clear");
  assert.equal(evaluateCreditAlertDirections(p, { USD: 499999, AFN: null }).collect, "clear");
  assert.equal(evaluateCreditAlertDirections(p, { USD: 500000, AFN: null }).collect, "unknown");
  assert.equal(evaluateCreditAlertDirections(p, { USD: 500000 }).collect, "unknown");
  assert.equal(evaluateCreditAlertDirections(p, { USD: -800000, AFN: -10000000 }).collect, "clear");
  const pay = { ...p, groups: p.groups.map((g) => ({ ...g, direction: "pay" as const })) };
  assert.equal(evaluateCreditAlertDirections(pay, { USD: -500000, AFN: -10000000 }).pay, "matched");
  assert.equal(evaluateCreditAlertDirections(pay, { USD: -500000, AFN: 10000000 }).pay, "clear");
  assert.equal(
    creditAlertExceeded(p, { USD: 499999, AFN: 10000000 }, { USD: 500000, AFN: 10000000 }),
    true,
  );
  assert.equal(
    creditAlertExceeded(p, { USD: 600000, AFN: 10000000 }, { USD: 500000, AFN: 10000000 }),
    false,
  );
  assert.equal(
    creditAlertExceeded(p, { USD: null, AFN: 10000000 }, { USD: 500000, AFN: 10000000 }),
    false,
  );
  assert.equal(evaluateCreditAlertDirections({ ...p, groups: [] }, {}).collect, "clear");
  const reversed = {
    ...p,
    updated_at_ms: 999,
    groups: [...p.groups].reverse().map((g) => ({ ...g, conditions: [...g.conditions].reverse() })),
  };
  assert.equal(creditAlertFingerprint(p), creditAlertFingerprint(reversed));
  for (const threshold of [0, -1, 0.5, Number.MAX_SAFE_INTEGER, NaN]) {
    const invalid = policy();
    invalid.groups[0].conditions[0].threshold_minor = threshold;
    assert.equal(validCreditAlertPolicy(invalid), false);
  }
  assert.equal(
    validCreditAlertPolicy({ ...p, groups: [{ direction: "collect", conditions: [] }] }),
    false,
  );
  assert.equal(
    validCreditAlertPolicy({
      ...p,
      groups: [
        {
          direction: "collect",
          conditions: [p.groups[0].conditions[0], p.groups[0].conditions[0]],
        },
      ],
    }),
    false,
  );
  assert.equal(
    validCreditAlertPolicy({ ...p, groups: Array.from({ length: 21 }, () => p.groups[0]) }),
    false,
  );
  assert.equal(
    validCreditAlertPolicy({ ...p, groups: [{ direction: "collect", conditions: [null] }] }),
    false,
  );
  console.log(
    "PASS inclusive OR/AND groups, separate directions/currencies, unknown truth tables, exact thresholds and semantic fingerprints",
  );
}

const fixture = new Database(":memory:");
fixture.pragma("foreign_keys=ON");
fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,account_id TEXT,archived_at INTEGER);
  CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER);
  CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT);
  CREATE TABLE event_log(id TEXT PRIMARY KEY,payload_json TEXT);
  INSERT INTO vaults VALUES('v1',NULL,NULL),('v2',NULL,NULL);
  INSERT INTO relationships VALUES('r1','v1','p1',NULL),('r2','v1','p2',NULL),('r-other','v2','p-other',NULL);
  INSERT INTO event_log VALUES('money','unchanged signed money');`);
const ddl = /execAsync\(`([^`]*CREATE TABLE IF NOT EXISTS credit_alert_policies[^`]*)`\)/.exec(
  readFileSync(require.resolve("../db"), "utf8"),
)?.[1];
assert.ok(ddl, "shipped migration 049");
fixture.exec(ddl);
const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (work: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await work();
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
  },
} as unknown as SQLiteTx;
let session = { jwt: null as string | null, accountId: null as string | null, bindingVersion: 1 };
let role = "owner";
let emits = 0;
const applyEventMutex = new Mutex();
class CreditOnlineSaveRequiredError extends Error {}
const guard = async (before: typeof session, work: () => Promise<unknown>) => {
  if (JSON.stringify(before) !== JSON.stringify(session)) throw new Error("session_changed");
  return work();
};
const exports = {};
new Function(
  "require",
  "exports",
  ts.transpileModule(readFileSync(require.resolve("../credit-alerts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)((name: string) => {
  if (name === "./auth")
    return {
      captureCurrentSession: async () => ({ ...session }),
      applyForCurrentSession: guard,
      applyForUnchangedLocalSession: guard,
    };
  if (name === "./api")
    return { getBackendUrl: async () => "https://credit-alert.fixture.invalid" };
  if (name === "./db-tx") return { getDb: async () => db, getActiveVaultIdSyncMaybe: () => "v1" };
  if (name === "./use-vault-role") return { readVaultRole: async () => role };
  if (name === "./effective-account")
    return { resolveAccountIdCandidates: async () => ["local:owner"] };
  if (name === "./currency-sync")
    return {
      currencyRequestHeaders: async () => ({}),
      ensureCurrencySyncSupported: async () => {},
    };
  if (name === "./credit-policy-events")
    return {
      emitCreditPoliciesChanged: () => {
        assert.equal(fixture.inTransaction, false);
        emits++;
      },
    };
  if (name === "./credit-limits") return { CreditOnlineSaveRequiredError };
  if (name === "./projection") return { applyEventMutex };
  if (name === "./sync/push")
    return {
      pushEvents: async () => {
        assert.equal(fixture.inTransaction, false);
      },
    };
  if (name.startsWith("./")) return require("../" + name.slice(2));
  throw new Error(`Unexpected dependency ${name}`);
}, exports);
const alerts = exports as typeof import("../credit-alerts");
const realFetch = globalThis.fetch;
let server: CreditAlertPolicy[] = [];
let stamp = Date.now() - 10000;
let status = 200;
let gate: Promise<void> | null = null;
let dropGroups = false;
let revisionHeader: "normal" | "missing" | "invalid" = "normal";
globalThis.fetch = async (_url, init) => {
  assert.equal(fixture.inTransaction, false, "network outside SQLite transaction");
  if (status !== 200) return new Response("unsupported", { status });
  const headers = (revision: number): Record<string, string> =>
    revisionHeader === "missing"
      ? {}
      : {
          "X-Kaata-Credit-Updated-At":
            revisionHeader === "invalid" ? "not-a-revision" : String(revision),
        };
  const wait = gate;
  if (init?.method === "PUT") {
    const p = { ...JSON.parse(String(init.body)), updated_at_ms: ++stamp } as CreditAlertPolicy;
    if (dropGroups) p.groups = [];
    server = server.filter((row) => row.relationship_id !== p.relationship_id).concat(p);
    if (wait) await wait;
    return Response.json(p, { headers: headers(p.updated_at_ms) });
  }
  if (init?.method === "DELETE") {
    const revision = ++stamp;
    const relationship = new URL(String(_url)).searchParams.get("relationship_id");
    server = server.filter((p) => p.relationship_id !== relationship);
    if (wait) await wait;
    return new Response(null, { status: 204, headers: headers(revision) });
  }
  const response = structuredClone(server);
  const revision = stamp;
  if (wait) await wait;
  return Response.json(response, { headers: headers(revision) });
};

async function storageChecks() {
  const money = fixture.prepare("SELECT * FROM event_log").all();
  await alerts.saveCreditAlertPolicy("v1", policy());
  assert.equal(
    (
      fixture
        .prepare("SELECT sync_pending FROM credit_alert_policies WHERE relationship_id='r1'")
        .get() as any
    ).sync_pending,
    1,
  );
  await cache.cacheCreditAlerts(db, "v1", [], Date.now() + 1);
  assert.ok(await alerts.readCreditAlertPolicy("r1", "v1"), "pending local policy survives GET []");
  await assert.rejects(
    alerts.saveCreditAlertPolicy("v1", policy(KAATA_DEFAULT_CREDIT_ID)),
    CreditOnlineSaveRequiredError,
  );
  role = "clerk";
  await assert.rejects(alerts.saveCreditAlertPolicy("v1", policy()), /Manager required/);
  role = "owner";
  fixture.prepare("INSERT INTO vault_members_mirror VALUES('v1','someone-else')").run();
  await assert.rejects(alerts.saveCreditAlertPolicy("v1", policy()), /Shared credit alerts/);
  fixture.prepare("DELETE FROM vault_members_mirror").run();
  session = { jwt: "jwt", accountId: "owner", bindingVersion: 2 };
  await alerts.refreshCreditAlerts("v1");
  assert.equal(
    (
      fixture
        .prepare("SELECT sync_pending FROM credit_alert_policies WHERE relationship_id='r1'")
        .get() as any
    ).sync_pending,
    0,
  );
  assert.equal((await alerts.readCreditAlertPolicy("r1", "v1"))?.groups.length, 2);
  await alerts.saveCreditAlertPolicy("v1", policy(KAATA_DEFAULT_CREDIT_ID));
  assert.equal(
    (await alerts.readCreditAlertSettings("r2", "v1")).effective?.relationship_id,
    KAATA_DEFAULT_CREDIT_ID,
  );
  await alerts.saveCreditAlertPolicy("v1", { ...policy("r2"), groups: [] });
  assert.deepEqual((await alerts.readCreditAlertSettings("r2", "v1")).effective?.groups, []);
  const customers = await alerts.listEffectiveCreditAlertCustomers();
  assert.equal(customers.length, 2);
  assert.equal(customers.find((p) => p.person_id === "p1")?.sync_pending, false);
  assert.equal((await alerts.readCreditAlertSettings("r-other", "v2")).effective, null);
  const old = (await alerts.readCreditAlertPolicy("r2", "v1"))!;
  await alerts.deleteCreditAlertPolicy("v1", "r2");
  assert.equal(
    (await alerts.readCreditAlertSettings("r2", "v1")).effective?.relationship_id,
    KAATA_DEFAULT_CREDIT_ID,
  );
  await cache.cacheCreditAlerts(
    db,
    "v1",
    [...server.filter((p) => p.relationship_id !== "r2"), old],
    Date.now() + 5,
  );
  assert.equal(
    await alerts.readCreditAlertPolicy("r2", "v1"),
    null,
    "stale snapshot cannot resurrect reset override",
  );
  status = 404;
  await assert.rejects(alerts.refreshCreditAlerts("v1"), /404/);
  await assert.rejects(alerts.saveCreditAlertPolicy("v1", policy()), /404/);
  await assert.rejects(alerts.deleteCreditAlertPolicy("v1", "r1"), /404/);
  assert.equal((await alerts.readCreditAlertPolicy("r1", "v1"))?.groups.length, 2);
  status = 200;
  dropGroups = true;
  await assert.rejects(
    alerts.saveCreditAlertPolicy("v1", policy()),
    /Invalid credit alert response/,
  );
  dropGroups = false;
  assert.equal((await alerts.readCreditAlertPolicy("r1", "v1"))?.groups.length, 2);
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stale = alerts.refreshCreditAlerts("v1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate = null;
  await alerts.saveCreditAlertPolicy("v1", { ...policy(), groups: [] });
  release();
  await stale;
  assert.deepEqual(
    (await alerts.readCreditAlertPolicy("r1", "v1"))?.groups,
    [],
    "late GET cannot overwrite save",
  );
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const switched = alerts.refreshCreditAlerts("v1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  session = { jwt: "other", accountId: "other", bindingVersion: 3 };
  gate = null;
  release();
  await assert.rejects(switched, /session_changed/);
  session = { jwt: "jwt", accountId: "owner", bindingVersion: 4 };
  server = [];
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const older = alerts.refreshCreditAlerts("v1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate = null;
  const current = policy("r1", (stamp += 50));
  server = [current];
  await alerts.refreshCreditAlerts("v1");
  release();
  await older;
  assert.deepEqual(
    (await alerts.readCreditAlertPolicy("r1", "v1"))?.groups,
    current.groups,
    "an older concurrent GET cannot remove a newer observed policy",
  );
  const noChange = emits;
  await alerts.refreshCreditAlerts("v1");
  assert.equal(emits, noChange, "unchanged GETs cause no writes or configuration events");
  server = [];
  await alerts.refreshCreditAlerts("v1");
  assert.equal(await alerts.readCreditAlertPolicy("r1", "v1"), null);
  await cache.cacheCreditAlerts(db, "v1", [current], Date.now() + 1000);
  assert.equal(
    await alerts.readCreditAlertPolicy("r1", "v1"),
    null,
    "a server removal also survives a stale snapshot",
  );
  assert.deepEqual(
    fixture.prepare("SELECT * FROM event_log").all(),
    money,
    "configuration never mutates financial evidence",
  );
  assert.ok(emits >= 5);
  console.log(
    "PASS actual migration/cache/storage: local pending upload, own/default/off/reset, tombstones, role/vault/account boundaries, unsupported responses and stale GETs",
  );
}

async function skewChecks() {
  const now = Date.now;
  try {
    for (const skew of [365 * 24 * 3600_000, -365 * 24 * 3600_000]) {
      Date.now = () => now() + skew;
      const previous = policy("r1", ++stamp);
      server = [previous];
      await alerts.refreshCreditAlerts("v1");
      await alerts.deleteCreditAlertPolicy("v1", "r1");
      const tombstone = fixture
        .prepare(
          "SELECT updated_at_ms,deleted FROM credit_alert_policies WHERE vault_id='v1' AND relationship_id='r1'",
        )
        .get() as any;
      assert.equal(
        tombstone.updated_at_ms,
        stamp,
        "reset uses the authoritative DELETE revision instead of the device clock",
      );
      await cache.cacheCreditAlerts(db, "v1", [previous], Number.MAX_SAFE_INTEGER);
      assert.equal(
        await alerts.readCreditAlertPolicy("r1", "v1"),
        null,
        "equal-timestamp stale snapshot cannot resurrect reset policy",
      );
      const recreated = policy("r1", ++stamp);
      server = [recreated];
      await alerts.refreshCreditAlerts("v1");
      assert.equal(
        (await alerts.readCreditAlertPolicy("r1", "v1"))?.updated_at_ms,
        recreated.updated_at_ms,
        "new remote policy after reset wins despite ahead/behind device time",
      );
      await cache.cacheCreditAlerts(db, "v1", [], recreated.updated_at_ms - 1);
      assert.ok(
        await alerts.readCreditAlertPolicy("r1", "v1"),
        "older snapshot omission preserves a newer policy",
      );
      server = [];
      await alerts.refreshCreditAlerts("v1");
      assert.equal(
        await alerts.readCreditAlertPolicy("r1", "v1"),
        null,
        "authoritative GET removal never depends on a slow device clock",
      );
      await cache.cacheCreditAlerts(db, "v1", [recreated], Number.MAX_SAFE_INTEGER);
      assert.equal(
        await alerts.readCreditAlertPolicy("r1", "v1"),
        null,
        "stale snapshot cannot reverse an authoritative removal",
      );
      server = [policy("r1", ++stamp)];
      await alerts.refreshCreditAlerts("v1");
      assert.ok(
        await alerts.readCreditAlertPolicy("r1", "v1"),
        "fresh rule after server removal remains available",
      );
    }
    session = { jwt: null, accountId: null, bindingVersion: 5 };
    Date.now = () => now() + 365 * 24 * 3600_000;
    await alerts.saveCreditAlertPolicy("v1", policy());
    await alerts.deleteCreditAlertPolicy("v1", "r1");
    assert.equal(
      (
        fixture
          .prepare("SELECT updated_at_ms FROM credit_alert_policies WHERE relationship_id='r1'")
          .get() as any
      ).updated_at_ms,
      0,
      "unpublished local policy cannot invent an authoritative tombstone clock",
    );
    session = { jwt: "jwt", accountId: "owner", bindingVersion: 6 };
    server = [policy("r1", ++stamp)];
    await alerts.refreshCreditAlerts("v1");
    assert.ok(await alerts.readCreditAlertPolicy("r1", "v1"));
  } finally {
    Date.now = now;
  }
  console.log(
    "PASS ahead/behind device clocks: reset/removal/recreation retain server ordering, stale snapshots stay stale and local-only tombstones start at zero",
  );
}

async function revisionRaceChecks() {
  session = { jwt: "jwt", accountId: "owner", bindingVersion: 7 };
  const before = (await alerts.readCreditAlertPolicy("r1", "v1"))!;
  for (const missing of ["missing", "invalid"] as const) {
    revisionHeader = missing;
    await assert.rejects(alerts.refreshCreditAlerts("v1"), /Invalid credit alert revision/);
    await assert.rejects(
      alerts.saveCreditAlertPolicy("v1", policy()),
      /Invalid credit alert revision/,
    );
    await assert.rejects(
      alerts.deleteCreditAlertPolicy("v1", "r1"),
      /Invalid credit alert revision/,
    );
    assert.deepEqual(
      await alerts.readCreditAlertPolicy("r1", "v1"),
      before,
      "unsupported successful responses cannot replace or erase cached rules",
    );
  }
  revisionHeader = "normal";
  server = [before];
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = alerts.saveCreditAlertPolicy("v1", { ...policy(), groups: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate = null;
  const afterPut = policy("r1", ++stamp);
  server = [afterPut];
  await cache.cacheCreditAlerts(db, "v1", [afterPut], Number.MAX_SAFE_INTEGER);
  release();
  await saving;
  assert.equal(
    (await alerts.readCreditAlertPolicy("r1", "v1"))?.updated_at_ms,
    afterPut.updated_at_ms,
    "delayed PUT acknowledgment cannot replace a newer snapshot policy",
  );
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = alerts.deleteCreditAlertPolicy("v1", "r1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate = null;
  const afterDelete = policy("r1", ++stamp);
  server = [afterDelete];
  await cache.cacheCreditAlerts(db, "v1", [afterDelete], Number.MAX_SAFE_INTEGER);
  release();
  await deleting;
  assert.equal(
    (await alerts.readCreditAlertPolicy("r1", "v1"))?.updated_at_ms,
    afterDelete.updated_at_ms,
    "delayed DELETE acknowledgment cannot erase a newer remotely recreated rule",
  );
  server = [];
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getting = alerts.refreshCreditAlerts("v1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate = null;
  const afterGet = policy("r1", ++stamp);
  server = [afterGet];
  await cache.cacheCreditAlerts(db, "v1", [afterGet], Number.MAX_SAFE_INTEGER);
  release();
  await getting;
  assert.equal(
    (await alerts.readCreditAlertPolicy("r1", "v1"))?.updated_at_ms,
    afterGet.updated_at_ms,
    "authoritative GET cutoff cannot remove a newer snapshot installed during its request",
  );
  server = [];
  stamp += 2;
  await alerts.refreshCreditAlerts("v1");
  stamp += 2;
  await alerts.refreshCreditAlerts("v1");
  assert.equal(
    (
      fixture
        .prepare("SELECT updated_at_ms FROM credit_alert_policies WHERE relationship_id='r1'")
        .get() as any
    ).updated_at_ms,
    stamp,
    "newer authoritative absence advances an existing deletion watermark",
  );
  await cache.cacheCreditAlerts(db, "v1", [policy("r1", stamp - 1)], Number.MAX_SAFE_INTEGER);
  assert.equal(
    await alerts.readCreditAlertPolicy("r1", "v1"),
    null,
    "GET removal tombstone retains full authoritative cutoff against intermediate stale snapshots",
  );
  console.log(
    "PASS required revision headers, authoritative removal cutoffs and delayed PUT/DELETE/GET versus newer snapshots",
  );
}

void (async () => {
  pureChecks();
  await storageChecks();
  await skewChecks();
  await revisionRaceChecks();
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    fixture.close();
  });
