// Synthetic in-memory SQLite only. Uses actual migration, appliers, HLC,
// role-gate SQL and group commands; native IO/append scheduling are replaced.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import ts from "typescript";
import {
  DEFAULT_CUSTOMER_LIST,
  selectCustomers,
  isNeverTalliedCustomer,
  selectNeverTalliedCustomers,
  parseCustomerListPreference,
  toggleCustomerGroupFilter,
  availableCustomerGroupFilter,
} from "../customer-list";
import { groupIdsFromPayload, canonicalGroupIds } from "../group-memberships";
import { canPerformAction } from "../vault-roles";
import type { PersonWithBalance } from "../types";
import type { LedgerEvent, VaultRole } from "../events";
import { customerGroupUIChecks } from "./customer-group-ui-selftest";

const fixture = new Database(":memory:");
fixture.pragma("foreign_keys = ON");
fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_trust_anchor_pubkey TEXT);
  CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),user_b_id TEXT,
    created_at INTEGER,updated_at INTEGER,archived_at INTEGER,field_hlcs TEXT);
  CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
  CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,
    payload_json TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,
    applied_at INTEGER,quarantine_reason TEXT);
  INSERT INTO vaults VALUES ('v1',NULL),('v2',NULL);
  INSERT INTO relationships VALUES ('r1','v1','p1',1,1,NULL,NULL),('r2','v2','p1',1,1,NULL,NULL);`);
const sqlite = {
  execAsync: async (sql: string) => fixture.exec(sql),
  getFirstAsync: async (sql: string, ...args: unknown[]) => {
    if (
      sqlPause &&
      sql === "SELECT id FROM relationships WHERE vault_id=? AND id=? AND archived_at IS NULL"
    ) {
      sqlReached?.();
      await sqlPause;
    }
    return fixture.prepare(sql).get(...args) ?? null;
  },
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (fn: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await fn();
      fixture.exec("COMMIT");
    } catch (e) {
      fixture.exec("ROLLBACK");
      throw e;
    }
  },
};
let active = "v1",
  account: string | null = "a",
  clock = 100,
  appendCount = 0;
let deferRead: Promise<void> | null = null;
let sqlPause: Promise<void> | null = null,
  sqlReached: (() => void) | null = null;
let fixtureJwt: string | null = "session-a";
const compile = (source: string, required: (path: string) => unknown) => {
  const exports: Record<string, any> = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(required, exports);
  return exports;
};
function declaration(file: string, name: string) {
  const source = readFileSync(resolve(__dirname, file), "utf8"),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find(
    (s) => (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name,
  );
  assert.ok(node, `actual ${name}`);
  return node.getText(ast);
}
const { RoleGateRejectionError } = compile(
  declaration("../event-log.ts", "RoleGateRejectionError"),
  () => {
    throw Error("unexpected import");
  },
);
// Actual session capture/guard/mutex declarations: only native SecureStore and
// current account cache are synthetic. Session switches use that same mutex.
const sessionAuth = compile(
  `
  const {SecureStore,getAccountIdSync,setAccount,setJwt}=require("fixture-auth");
  let sessionBindingVersion=0;let sessionMutationTail=Promise.resolve();
  ${declaration("../auth.ts", "mutateLocalSession")}
  const SESSION_CLAIMS = ["account_id", "install_id", "provider", "provider_sub", "ep"];
  ${declaration("../auth.ts", "decodeIdTokenClaims")}
  ${declaration("../auth.ts", "sameSessionToken")}
  export ${declaration("../auth.ts", "SessionChangedError")}
  export ${declaration("../auth.ts", "captureCurrentSession")}
  export ${declaration("../auth.ts", "applyForUnchangedLocalSession")}
  const SESSION_KEY="fixture";
  export function switchSession(next:string|null,jwt:string|null){return mutateLocalSession(async()=>{
    sessionBindingVersion++;setAccount(next);setJwt(jwt);
  });}
`,
  () => ({
    SecureStore: { getItemAsync: async () => fixtureJwt },
    getAccountIdSync: () => account,
    setAccount: (next: string | null) => {
      account = next;
    },
    setJwt: (next: string | null) => {
      fixtureJwt = next;
    },
  }),
);
const moduleCache = new Map<string, any>();
function load(file: string): any {
  const path = resolve(__dirname, file.endsWith(".ts") ? file : `${file}.ts`);
  if (moduleCache.has(path)) return moduleCache.get(path);
  const exports = compile(readFileSync(path, "utf8"), (name) => {
    if (name === "expo-crypto") return { randomUUID };
    if (name === "./auth") return sessionAuth;
    if (name.endsWith("db-tx"))
      return {
        getDb: async () => {
          if (deferRead) await deferRead;
          return sqlite;
        },
        getAccountIdSync: () => account,
        getActiveVaultIdSyncMaybe: () => active,
        getInstallIdSync: () => "test",
        getLocalSelfUserIdSync: () => "self",
      };
    if (name === "../db") return { FIELD_HLC_INIT: { pms: -1, l: 0, did: "" } };
    if (name.endsWith("event-log")) return { RoleGateRejectionError };
    if (name.endsWith("projection"))
      return {
        applyEvent: async (event: LedgerEvent, opts: any) => {
          await opts.preflightAbort?.(sqlite);
          const stamped = { ...event, hlc: { pms: ++clock, l: 0, did: "test" } };
          const gate = await roleGate.checkRoleForEvent(sqlite, stamped);
          if (!gate.ok) return { applied: false, reason: "role_gate", role_gate: gate };
          await sqlite.withTransactionAsync(() =>
            appliers[
              event.event_type === "person_group_set" ? "applyPersonGroupSet" : "applyCustomerGroup"
            ](sqlite, stamped),
          );
          appendCount++;
          return { applied: true };
        },
      };
    if (name.endsWith("effective-account"))
      return { resolveAccountIdCandidates: async () => (account ? [account] : []) };
    if (name.endsWith("event-sig")) return { verifyEventSignature: async () => false };
    if (name.endsWith("trust/ownership-transfer")) return require("../trust/ownership-transfer");
    if (name.endsWith("trust/chain")) return {};
    if (name.endsWith("trust/crypto-runtime")) return {};
    if (name.endsWith("mesh/device-key"))
      return {
        readOwnDevicePubkeys: async () => ({ current: null, retired: [] }),
        isOwnDevicePubkey: async () => false,
      };
    if (name.startsWith(".")) return load(resolve(dirname(path), name));
    throw new Error(`unexpected runtime import ${name}`);
  });
  moduleCache.set(path, exports);
  return exports;
}
const appliers = load("../projection/customer_groups"),
  roleGate = load("../projection/role-gate"),
  commands = load("../customer-groups");
// The declaration's module constant is supplied without reimplementing SQL.
const migrationSource = declaration("../db.ts", "runMigration035");
const runMigration = compile(
  `const MIGRATION_035="035_customer_groups";export ${migrationSource}`,
  () => ({}),
).runMigration035;
const runMembershipMigration = compile(
  `const MIGRATION_037="037_customer_group_memberships";export ${declaration("../db.ts", "runMigration037")}`,
  () => ({}),
).runMigration037;
const runPayloadMigration = compile(
  `import { groupIdsFromPayload, storedGroupIds } from "../group-memberships";
  const MIGRATION_039="039_customer_groups_from_payloads";
  export ${declaration("../db.ts", "runMigration039")}`,
  (name) => {
    if (name.endsWith("group-memberships")) return load("../group-memberships");
    throw new Error(`unexpected import ${name}`);
  },
).runMigration039;
function setRole(role: VaultRole) {
  fixture.prepare("DELETE FROM event_log").run();
  fixture
    .prepare(
      "INSERT INTO event_log VALUES ('role','vault_member_added','v1','a',?,1,0,'test',1,NULL)",
    )
    .run(JSON.stringify({ role }));
  roleGate.invalidateRoleGateCache();
}
const event = (
  type: string,
  target: string,
  payload: unknown,
  pms: number,
  vault = "v1",
  relationship: string | null = null,
) =>
  ({
    event_id: randomUUID(),
    event_type: type,
    target_id: target,
    vault_id: vault,
    relationship_id: relationship,
    hlc: { pms, l: 0, did: "test" },
    device_id: "test",
    origin: "backfill",
    actor_account_id: "a",
    payload,
  }) as LedgerEvent;
const group = (id: string) =>
  fixture
    .prepare("SELECT name,archived_at,field_hlcs FROM customer_groups WHERE vault_id='v1' AND id=?")
    .get(id) as any;
const assigned = (id = "r1") =>
  fixture
    .prepare("SELECT group_id,group_ids,field_hlcs FROM relationships WHERE id=?")
    .get(id) as any;

async function main() {
  await runMigration(sqlite);
  assert.equal(
    (
      fixture
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name='035_customer_groups'")
        .get() as any
    ).n,
    1,
  );
  assert.equal(
    (fixture.prepare("SELECT group_id FROM relationships WHERE id='r1'").get() as any).group_id,
    null,
    "upgrade preserves existing contacts without a group",
  );
  fixture.prepare("DELETE FROM schema_migrations").run();
  await runMigration(sqlite);
  fixture.prepare("UPDATE relationships SET group_id='legacy' WHERE id='r1'").run();
  await runMembershipMigration(sqlite);
  assert.equal(assigned().group_ids, '["legacy"]', "single group migration preserves assignment");
  assert.equal(assigned("r2").group_ids, "[]", "ungrouped remains empty");
  fixture.prepare("UPDATE relationships SET group_id=NULL,group_ids='[]' WHERE id='r1'").run();
  fixture
    .prepare("DELETE FROM schema_migrations WHERE name='037_customer_group_memberships'")
    .run();
  await runMembershipMigration(sqlite);
  console.log(
    "PASS actual migration upgrades existing relationships and tolerates pre-existing new column",
  );
  await appliers.applyCustomerGroup(
    sqlite,
    event("group_created", "g1", { name: " خانه\u200cگی " }, 10),
  );
  await appliers.applyCustomerGroup(sqlite, event("group_renamed", "g1", { name: "خانواده" }, 30));
  await appliers.applyCustomerGroup(sqlite, event("group_renamed", "g1", { name: "Stale" }, 20));
  assert.equal(group("g1").name, "خانواده");
  await appliers.applyCustomerGroup(
    sqlite,
    event("group_created", "g1", { name: "Duplicate" }, 40),
  );
  assert.equal(group("g1").name, "خانواده", "repeat create cannot reset rename");
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r1", { group_id: "g1" }, 40, "v1", "r1"),
  );
  assert.equal(assigned().group_id, "g1");
  assert.equal(assigned("r2").group_id, null, "same person other kaata independent");
  await assert.rejects(
    appliers.applyPersonGroupSet(
      sqlite,
      event("person_group_set", "r2", { group_id: "g1" }, 50, "v2", "r2"),
    ),
    /missing/,
  );
  await assert.rejects(
    appliers.applyPersonGroupSet(
      sqlite,
      event("person_group_set", "r1", { group_id: "g1" }, 50, "v2", "r1"),
    ),
    /missing/,
  );
  await assert.rejects(
    appliers.applyPersonGroupSet(sqlite, event("person_group_set", "r1", {}, 50, "v1", "r1")),
    /invalid/,
  );
  await assert.rejects(
    appliers.applyPersonGroupSet(
      sqlite,
      event("person_group_set", "r1", { group_id: "later" }, 50, "v1", "r1"),
    ),
    /missing/,
  );
  await appliers.applyCustomerGroup(sqlite, event("group_created", "later", { name: "Later" }, 45));
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r1", { group_id: "later" }, 50, "v1", "r1"),
  );
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r1", { group_id: null }, 60, "v1", "r1"),
  );
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r1", { group_id: "g1" }, 55, "v1", "r1"),
  );
  assert.equal(assigned().group_id, null, "stale arrival does not undo newer removal");
  console.log("PASS group/name/assignment LWW, missing-prerequisite retry, per-kaata isolation");
  // Migration 039: a phone that ran a single-group build (2.2.0 33/53) kept
  // only the first id of a multi-group payload; the winning event restores it.
  fixture
    .prepare(
      `INSERT INTO event_log (event_id,event_type,vault_id,target_id,payload_json,
        hlc_physical_ms,hlc_logical,hlc_device_id,applied_at,quarantine_reason)
      VALUES ('multi','person_group_set','v1','r1',?,65,0,'test',1,NULL)`,
    )
    .run(JSON.stringify({ group_id: "g1", group_ids: ["g1", "later"] }));
  fixture
    .prepare(`UPDATE relationships SET group_id='g1',group_ids='["g1"]',field_hlcs=? WHERE id='r1'`)
    .run(JSON.stringify({ group_id: { pms: 65, l: 0, did: "test" } }));
  fixture
    .prepare(`UPDATE relationships SET group_id='g1',group_ids='["g1"]',field_hlcs=? WHERE id='r2'`)
    .run(JSON.stringify({ group_id: { pms: 99, l: 0, did: "unknown" } }));
  await runPayloadMigration(sqlite);
  assert.equal(assigned().group_ids, '["g1","later"]', "the winning payload's full set returns");
  assert.equal(assigned().group_id, "g1", "the first id still mirrors old clients");
  assert.equal(JSON.parse(assigned().field_hlcs).group_id.pms, 65, "the migration rewrites no HLC");
  assert.equal(assigned("r2").group_ids, '["g1"]', "no winning event found: left as it is");
  fixture.prepare("DELETE FROM event_log WHERE event_id='multi'").run();
  fixture
    .prepare(`UPDATE relationships SET group_id=NULL,group_ids='[]',field_hlcs=NULL WHERE id='r2'`)
    .run();
  console.log("PASS migration 039 restores multi-group sets from the winning stored payload");
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r1", { group_id: "g1" }, 70, "v1", "r1"),
  );
  await appliers.applyCustomerGroup(sqlite, event("group_archived", "g1", {}, 80));
  await appliers.applyCustomerGroup(
    sqlite,
    event("group_renamed", "g1", { name: "Archived rename" }, 90),
  );
  assert.equal(group("g1").archived_at, 80);
  let state = await commands.readCustomerGroups("v1");
  assert.equal(state.groupByPerson.p1, null);
  assert.equal(assigned().group_id, "g1", "archive keeps dormant assignment/history");
  assert.equal(
    state.groups.some((g: any) => g.id === "g1"),
    false,
  );
  assert.deepEqual((await commands.readCustomerGroups("v2")).groups, []);
  console.log(
    "PASS archived group becomes Ungrouped without clearing relationship or touching another kaata",
  );
  for (const role of ["viewer", "clerk", "editor", "manager", "owner"] as const) {
    setRole(role);
    for (const type of ["group_created", "group_renamed", "group_archived", "person_group_set"]) {
      const verdict = await roleGate.checkRoleForEvent(sqlite, event(type, "g1", {}, 200));
      assert.equal(verdict.ok, ["editor", "manager", "owner"].includes(role), `${role} / ${type}`);
    }
    assert.equal(
      canPerformAction(role, "group.manage"),
      ["editor", "manager", "owner"].includes(role),
    );
    assert.equal(
      canPerformAction(role, "person.set_group"),
      ["editor", "manager", "owner"].includes(role),
    );
  }
  setRole("viewer");
  await assert.rejects(
    commands.saveCustomerGroup("v1", null, "No permission"),
    RoleGateRejectionError,
  );
  setRole("editor");
  const newId = await commands.saveCustomerGroup("v1", null, "Customers");
  await commands.assignCustomerGroup("v1", "p1", newId);
  state = await commands.readCustomerGroups("v1");
  assert.equal(state.groupByPerson.p1, newId);
  await commands.assignCustomerGroups("v1", "p1", [newId, "later", newId]);
  state = await commands.readCustomerGroups("v1");
  assert.deepEqual(state.groupsByPerson.p1, [newId, "later"].sort());
  assert.equal(state.groups.find((g: any) => g.id === "later").member_count, 1);
  assert.equal(state.groups.find((g: any) => g.id === newId).member_count, 1);
  const beforeNoop = appendCount;
  await commands.assignCustomerGroups("v1", "p1", ["later", newId]);
  assert.equal(appendCount, beforeNoop, "reordered same set does not append");
  await commands.assignCustomerGroup("v1", "p1", newId);
  assert.deepEqual(
    (await commands.readCustomerGroups("v1")).groupsByPerson.p1,
    [newId],
    "legacy set replaces the whole register",
  );
  await assert.rejects(commands.saveCustomerGroup("v1", null, "customers"), /duplicate_group_name/);
  await assert.rejects(
    commands.saveCustomerGroup("v1", null, "A".repeat(41)),
    /invalid_group_name/,
  );
  let release!: () => void;
  deferRead = new Promise<void>((r) => {
    release = r;
  });
  const before = appendCount,
    pending = commands.assignCustomerGroup("v1", "p1", null);
  account = "b";
  release();
  await assert.rejects(pending, /context changed/);
  assert.equal(appendCount, before);
  deferRead = null;
  account = "a";
  active = "v2";
  await assert.rejects(commands.assignCustomerGroup("v1", "p1", null), /context changed/);
  active = "v1";
  console.log(
    "PASS actual role-gate SQL denies viewer/clerk, commands validate names and bind account/kaata",
  );
  // The current account can return to A before storage resolves. Matching just
  // its ID would miss that the original session lifetime ended.
  deferRead = new Promise<void>((r) => {
    release = r;
  });
  const aba = commands.assignCustomerGroup("v1", "p1", null);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await sessionAuth.switchSession("b", "session-b");
  await sessionAuth.switchSession("a", "session-a-new");
  release();
  await assert.rejects(aba, /session_changed/);
  deferRead = null;
  assert.equal(appendCount, before, "account ABA cannot append the old intent");
  // A real session switch stays queued throughout append's local work. A vault
  // cache switch during prerequisite SQL is still checked after that await.
  let sqlRelease!: () => void, sqlArrived!: () => void;
  sqlPause = new Promise<void>((r) => {
    sqlRelease = r;
  });
  const arrived = new Promise<void>((r) => {
    sqlArrived = r;
  });
  sqlReached = sqlArrived;
  const duringSql = commands.assignCustomerGroup("v1", "p1", null);
  await arrived;
  let switched = false;
  const queuedSwitch = sessionAuth.switchSession("b", "session-b-new").then(() => {
    switched = true;
  });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(switched, false, "session guard serializes local append work");
  active = "v2";
  sqlRelease();
  await assert.rejects(duringSql, /context changed/);
  await queuedSwitch;
  sqlPause = null;
  sqlReached = null;
  active = "v1";
  await sessionAuth.switchSession("a", "session-a-current");
  assert.equal(appendCount, before, "vault change during prerequisite SQL leaves no append");
  console.log(
    "PASS actual session helper blocks account ABA/queued switches and final preflight rejects late vault change",
  );
  const people = [
    { id: "a", name: "Amir", balance: 100, last_entry_at: 20 },
    { id: "b", name: "Bashir", balance: 20, last_entry_at: 30 },
    {
      id: "c",
      name: "Camal",
      balance: 0,
      last_entry_at: 40,
      is_settled: 1,
      last_entry_type: "payment",
    },
    { id: "d", name: "Dawood", balance: -200, last_entry_at: 15 },
    { id: "e", name: "Ehsan", balance: -10, last_entry_at: 10 },
  ] as PersonWithBalance[];
  const newPerson = {
    ...people[0],
    id: "new",
    name: "Zarif New",
    balance: 0,
    last_entry_at: null,
    last_entry_type: null,
    is_settled: 0,
    created_at: 100,
  } as PersonWithBalance;
  const olderEmptyPerson = { ...newPerson, id: "old-empty", name: "Amir Empty", created_at: 50 };
  assert.equal(isNeverTalliedCustomer(newPerson), true);
  for (const financial of [
    ...people,
    { ...newPerson, balance: 5 },
    { ...newPerson, balance: -5 },
    { ...newPerson, is_settled: 1 },
    { ...newPerson, last_entry_type: "debt" as const },
    { ...newPerson, tab_id: "shared" },
    { ...newPerson, tab_unsynced: 1 as const },
  ])
    assert.equal(
      isNeverTalliedCustomer(financial),
      false,
      "financial history, known balances and unknown shared ledgers never become no-tally contacts",
    );
  const completePeople = [...people, olderEmptyPerson, newPerson];
  const originalCompletePeople = JSON.stringify(completePeople);
  for (const direction of ["collect", "pay"] as const)
    assert.ok(
      selectCustomers(completePeople, direction, DEFAULT_CUSTOMER_LIST, {}, "en").every(
        (person) => !isNeverTalliedCustomer(person),
      ),
      "neutral contacts are excluded from both financial lists",
    );
  assert.deepEqual(
    selectNeverTalliedCustomers(completePeople, DEFAULT_CUSTOMER_LIST, {}, "en").map(
      (person) => person.id,
    ),
    ["new", "old-empty"],
    "recent neutral contacts use their creation time",
  );
  assert.deepEqual(
    selectNeverTalliedCustomers(completePeople, { sort: "name_asc", group: "all" }, {}, "en").map(
      (person) => person.id,
    ),
    ["old-empty", "new"],
  );
  assert.deepEqual(
    selectNeverTalliedCustomers(
      completePeople,
      { sort: "recent", group: ["family", "shop"] },
      { new: ["family", "shop"], "old-empty": [] },
      "en",
    ).map((person) => person.id),
    ["new"],
    "neutral selection respects groups and deduplicates membership",
  );
  assert.equal(
    JSON.stringify(completePeople),
    originalCompletePeople,
    "selectors leave balances untouched",
  );
  const ids = (sort: any, direction: any = "collect", filter: string | string[] = "all") =>
    selectCustomers(
      people,
      direction,
      { sort, group: filter },
      { a: ["g", "h"], b: [], c: ["g"] },
      "en",
    ).map((p) => p.id);
  assert.deepEqual(ids("recent"), ["b", "a", "c"]);
  assert.deepEqual(ids("name_asc"), ["a", "b", "c"]);
  assert.deepEqual(ids("name_desc"), ["c", "b", "a"]);
  assert.deepEqual(ids("amount_desc"), ["a", "b", "c"]);
  assert.deepEqual(
    ids("amount_asc"),
    ["b", "a", "c"],
    "smallest first lists open debts before a settled (zero) customer",
  );
  assert.deepEqual(ids("date_asc"), ["a", "b", "c"]);
  assert.equal(
    parseCustomerListPreference('{"sort":"date_desc","group":"all"}').sort,
    "recent",
    "the dropped newest-first sort reads as Recent activity",
  );
  {
    const oldSettled = {
      ...people[2],
      id: "old",
      name: "Old",
      last_entry_at: 1,
    } as PersonWithBalance;
    assert.deepEqual(
      selectCustomers(
        [...people, oldSettled],
        "collect",
        { sort: "date_asc", group: "all" },
        {},
        "en",
      ).map((p) => p.id),
      ["a", "b", "old", "c"],
      "oldest first keeps settled customers after the open ones",
    );
    const named = (names: string[], locale: "en" | "fa") =>
      selectCustomers(
        names.map((name, i) => ({ ...people[0], id: `n${i}`, name })),
        "collect",
        { sort: "name_asc", group: "all" },
        {},
        locale,
      ).map((p) => p.name);
    assert.deepEqual(named(["Ahmad 10", "Ahmad 2", "Ahmad 1"], "en"), [
      "Ahmad 1",
      "Ahmad 2",
      "Ahmad 10",
    ]);
    assert.deepEqual(named(["دکان ۱۰", "دکان ۲"], "fa"), ["دکان ۲", "دکان ۱۰"]);
    assert.deepEqual(named(["Shop 02", "Shop 1"], "en"), ["Shop 1", "Shop 02"]);
  }
  assert.deepEqual(ids("amount_desc", "pay"), ["d", "e"]);
  assert.deepEqual(ids("amount_asc", "pay"), ["e", "d"]);
  assert.deepEqual(ids("recent", "collect", "g"), ["a", "c"]);
  assert.deepEqual(ids("recent", "collect", "ungrouped"), ["b"]);
  assert.deepEqual(
    ids("recent", "collect", ["g", "h"]),
    ["a", "c"],
    "multiple groups are OR without duplicate customers",
  );
  assert.deepEqual(ids("recent", "collect", ["h"]), ["a"]);
  assert.deepEqual(toggleCustomerGroupFilter("all", "g"), ["g"]);
  assert.deepEqual(toggleCustomerGroupFilter(["g"], "h"), ["g", "h"]);
  assert.equal(toggleCustomerGroupFilter(["g"], "g"), "all");
  assert.deepEqual(availableCustomerGroupFilter(["g", "missing"], [{ id: "g" }]), ["g"]);
  assert.equal(availableCustomerGroupFilter(["missing"], [{ id: "g" }]), "all");
  assert.deepEqual(
    parseCustomerListPreference('{"sort":"recent","group":"g"}'),
    { sort: "recent", group: "g", direction: "all" },
    "legacy filter preference accepted",
  );
  assert.deepEqual(parseCustomerListPreference('{"sort":"recent","group":["h","g","h",7]}'), {
    sort: "recent",
    group: ["g", "h"],
    direction: "all",
  });
  assert.deepEqual(groupIdsFromPayload({ group_id: "g", group_ids: ["h", "g", "h"] }), ["g", "h"]);
  assert.throws(() => groupIdsFromPayload({ group_id: "h", group_ids: ["g", "h"] }), /mirror/);
  assert.throws(() => canonicalGroupIds(Array(101).fill("g")), /invalid/);
  assert.deepEqual(
    people.map((p) => p.id),
    ["a", "b", "c", "d", "e"],
    "source ordering untouched",
  );
  assert.equal(
    people.reduce((n, p) => n + p.balance, 0),
    -90,
    "filter did not mutate balances",
  );
  assert.deepEqual(parseCustomerListPreference("invalid"), {
    sort: "recent",
    group: "all",
    direction: "all",
  });
  assert.deepEqual(parseCustomerListPreference('{"sort":"bad","group":4}'), {
    sort: "recent",
    group: "all",
    direction: "all",
  });
  console.log(
    "PASS all sort directions, default settled-last, group filters, stable unmodified ledger totals",
  );
  const corpus = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../_shared/projection-corpus/06_customer_groups.json"),
      "utf8",
    ),
  );
  fixture.prepare("INSERT INTO vaults VALUES ('v',NULL)").run();
  fixture
    .prepare(
      "INSERT INTO relationships(id,vault_id,user_b_id,created_at,updated_at) VALUES ('r','v','u',1,1)",
    )
    .run();
  for (const input of corpus.events as LedgerEvent[]) {
    if (input.event_type === "person_added") continue;
    await appliers[
      input.event_type === "person_group_set" ? "applyPersonGroupSet" : "applyCustomerGroup"
    ](sqlite, input);
  }
  const corpusGroup = fixture
    .prepare("SELECT * FROM customer_groups WHERE vault_id='v' AND id='g'")
    .get() as any;
  corpusGroup.field_hlcs = JSON.parse(corpusGroup.field_hlcs);
  assert.deepEqual(
    corpusGroup,
    corpus.expected_projection.customer_groups.g,
    "same shared corpus as Go",
  );
  const corpusRel = fixture
    .prepare("SELECT group_id,field_hlcs FROM relationships WHERE id='r'")
    .get() as any;
  assert.equal(corpusRel.group_id, corpus.expected_projection.relationships.r.group_id);
  assert.deepEqual(
    JSON.parse(corpusRel.field_hlcs),
    corpus.expected_projection.relationships.r.group_field_hlcs,
  );
  const restore = load("../customer-group-restore");
  assert.equal(
    restore.restoredRelationshipGroupIds({ group_id: "g" }),
    '["g"]',
    "legacy snapshot membership",
  );
  assert.equal(
    restore.restoredRelationshipGroupIds({ group_id: "g", group_ids: ["g", "h"] }),
    '["g","h"]',
    "new snapshot memberships",
  );
  assert.equal(restore.restoredRelationshipGroupIds({}), "[]", "old ungrouped snapshot");
  fixture.prepare("DELETE FROM customer_groups WHERE vault_id='v'").run();
  await restore.seedSnapshotCustomerGroups(sqlite, "v", [
    corpus.expected_projection.customer_groups.g,
  ]);
  const seed = restore.restoredRelationshipFieldHLCs(
    JSON.stringify({ archived_at: { pms: 1, l: 0, did: "" } }),
    corpus.expected_projection.relationships.r.group_field_hlcs,
  );
  fixture
    .prepare("UPDATE relationships SET group_id='g',group_ids='[\"g\"]',field_hlcs=? WHERE id='r'")
    .run(seed);
  await appliers.applyPersonGroupSet(
    sqlite,
    event("person_group_set", "r", { group_id: null }, 39, "v", "r"),
  );
  assert.equal(assigned("r").group_id, "g", "snapshot winner rejects older tail removal");
  const sameTimeNew = event("person_group_set", "r", { group_id: null }, 40, "v", "r");
  sameTimeNew.hlc.l = 1;
  await appliers.applyPersonGroupSet(sqlite, sameTimeNew);
  assert.equal(assigned("r").group_id, null, "logical HLC successor survives snapshot restore");
  assert.equal(
    JSON.parse(assigned("r").field_hlcs).archived_at.pms,
    1,
    "group keeps old archive register unchanged",
  );
  await restore.seedSnapshotCustomerGroups(sqlite, "v", undefined);
  await assert.rejects(
    restore.seedSnapshotCustomerGroups(sqlite, "v2", [
      corpus.expected_projection.customer_groups.g,
    ]),
    /vault mismatch/,
  );
  console.log(
    "PASS shared Go/TS conformance corpus and real snapshot seed SQL preserve exact logical registers/legacy fields",
  );
  fixture.close();
  await customerGroupUIChecks();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
