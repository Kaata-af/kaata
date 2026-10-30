// The actual migration, projections, queries, credit cache and snapshot seeding.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import Database from "better-sqlite3";
import { applyCurrencyMigration } from "./currency-fixture";
import * as scope from "../currency-scope";

(globalThis as any).__DEV__ = false;
const store = new Database(":memory:");
store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,currency TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,is_default INTEGER,account_id TEXT,registered_with_server_at INTEGER,vault_epoch INTEGER,hlc_logical INTEGER,hlc_wall_ms INTEGER,vault_trust_anchor_pubkey TEXT);
CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,phone_e164 TEXT,is_local_self INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,google_sub TEXT,account_id TEXT,field_hlcs TEXT);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_a_id TEXT,user_b_id TEXT,context TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,field_hlcs TEXT,group_id TEXT,group_ids TEXT);
CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn NUMERIC,note TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER,proposed_by_user_id TEXT,current_event_id TEXT,is_deleted INTEGER DEFAULT 0,is_settled INTEGER DEFAULT 0,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER,field_hlcs TEXT);
CREATE TABLE settlements(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,settled_at_ms INTEGER,created_at INTEGER);
CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,target_id TEXT,relationship_id TEXT,event_type TEXT,payload_json TEXT,applied_at INTEGER,rejected_at INTEGER,server_acked_at INTEGER,appended_at INTEGER,actor_account_id TEXT,quarantine_reason TEXT,origin TEXT);
CREATE TABLE vault_settings(vault_id TEXT,key TEXT,value TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,PRIMARY KEY(vault_id,key));
CREATE TABLE customer_credit_limits(vault_id TEXT,relationship_id TEXT,max_collect_minor INTEGER,max_pay_minor INTEGER,mode TEXT,sync_pending INTEGER DEFAULT 0,updated_at_ms INTEGER,restrict_editors INTEGER DEFAULT 0,PRIMARY KEY(vault_id,relationship_id));
CREATE TABLE kaata_credit_defaults(vault_id TEXT PRIMARY KEY,max_collect_minor INTEGER,max_pay_minor INTEGER,mode TEXT,updated_at_ms INTEGER,restrict_editors INTEGER DEFAULT 0);
CREATE TABLE credit_admission_intents(event_id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,status TEXT,reason TEXT);
CREATE TABLE vault_member_credit_permissions(vault_id TEXT,account_id TEXT,credit_limit_override TEXT);
CREATE TABLE tab_links(tab_id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,role TEXT,currency TEXT,closed_at INTEGER,linked_at INTEGER,history_order TEXT,other_account_name TEXT,other_joined_at INTEGER,last_synced_at INTEGER,unjoined_invitation INTEGER);
CREATE TABLE tab_entries(id TEXT PRIMARY KEY,tab_id TEXT,direction TEXT,amount_minor INTEGER,note TEXT,kind TEXT,status TEXT,seq INTEGER,rev INTEGER,created_by TEXT,occurred_at INTEGER,created_at INTEGER,voided_by_entry_id TEXT,local_pending INTEGER,local_action_pending INTEGER);
CREATE TABLE tab_outbox(id TEXT PRIMARY KEY,tab_id TEXT,op TEXT);
CREATE TABLE tab_settlements(id TEXT,tab_id TEXT,through_seq INTEGER);
INSERT INTO vaults(id,name,currency,created_at,updated_at,is_default) VALUES('v','Book','AFN',1,1,1);
INSERT INTO users(id,display_name,created_at,is_local_self) VALUES('self','Owner',1,1),('p','Person',1,0);
INSERT INTO relationships(id,vault_id,user_a_id,user_b_id,context,created_at,updated_at) VALUES('r','v','self','p','peer',1,1);
INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,updated_at) VALUES('legacy','v','r','debt',100,100,100);
INSERT INTO customer_credit_limits VALUES('v','r',15000,0,'clerk_block',0,1,0);`);
const tx: any = {
  runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
  getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
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
};
const state = { jwt: null, accountId: null, bindingVersion: 0 };
const dbTx: any = {
  getDb: async () => tx,
  getActiveVaultIdSync: () => "v",
  getActiveVaultIdSyncMaybe: () => "v",
  getAccountIdSync: () => null,
  getInstallIdSync: () => "device",
  getLocalSelfUserIdSync: () => "self",
  getAppMetaInTx: async (_db: any, key: string) =>
    (store.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as any)?.value ?? null,
  setAppMetaInTx: async (_db: any, key: string, value: string) =>
    store.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(key, value),
  setActiveVaultIdCache: () => {},
};
function compile(file: string, required: (name: string) => any): any {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)(required, exports);
  return exports;
}
const fields = compile("../projection/field-hlc", (name) =>
  name === "../db" ? { FIELD_HLC_INIT: { pms: 0, l: 0, did: "" } } : require("../hlc"),
);
const entries = compile("../projection/entries", (name) =>
  name === "./field-hlc"
    ? fields
    : name === "./errors"
      ? require("../projection/errors")
      : name === "../hlc"
        ? require("../hlc")
        : name === "../entry-date"
          ? require("../entry-date")
          : scope,
);
const policyCache = require("../credit-policy-cache");
const credit = compile("../credit-limits", (name) => {
  if (name === "./projection") return { applyEventMutex: new (require("../util/mutex").Mutex)() };
  if (name === "./db-tx") return dbTx;
  if (name === "./auth")
    return {
      captureCurrentSession: async () => state,
      applyForCurrentSession: async (_s: any, work: any) => work(),
      applyForUnchangedLocalSession: async (_s: any, work: any) => work(),
    };
  if (name === "./currency-sync") return { ensureCurrencySyncSupported: async () => {} };
  if (name === "./use-vault-role") return { readVaultRole: async () => "owner" };
  if (name === "./api") return {};
  if (name === "./effective-account") return { resolveAccountIdCandidates: async () => [] };
  if (name.startsWith("./")) return require("../" + name.slice(2));
  throw new Error(name);
});
const admission = compile("../credit-admission", (name) =>
  name === "./projection/entries" ? entries : name === "./currency-scope" ? scope : undefined,
);
const authored: any[] = [];
const eventLog = compile("../event-log", (name) => {
  if (name === "expo-crypto") return { randomUUID };
  if (name === "./db-tx") return dbTx;
  if (name === "./projection")
    return {
      applyEvent: async (event: any, options: any) => {
        if (await options?.preflightAbort?.(tx)) return { applied: false, reason: "preflight" };
        event.hlc = { pms: Date.now(), l: 0, did: "device" };
        authored.push(event);
        if (event.event_type === "entry_settled") await entries.applyEntrySettled(tx, event);
        else if (event.event_type === "entry_created") await entries.applyEntryCreated(tx, event);
        return { applied: true };
      },
    };
  if (
    [
      "./currency-scope",
      "./entry-date",
      "./money",
      "./money-sql",
      "./tabs/errors",
      "./tabs/history",
    ].includes(name)
  )
    return require("../" + name.slice(2));
  return {};
});
const tabDb = {
  getLatestTabLinkForPerson: async () => null,
  getTabLinkForPerson: async () => null,
  getTabGroupLinkForPerson: async () => null,
};
const db = compile("../db", (name) => {
  if (name === "expo-crypto") return { randomUUID };
  if (name === "./db-tx") return dbTx;
  if (name === "./tabs/db") return tabDb;
  if (name === "./projection") return { applyEventMutex: new (require("../util/mutex").Mutex)() };
  if (
    [
      "./currency-scope",
      "./entry-date",
      "./money-sql",
      "./money",
      "./tabs/history",
      "./tabs/direction",
      "./tabs/errors",
    ].includes(name)
  )
    return require("../" + name.slice(2));
  return {};
});
const make = (id: string, currency: string | undefined, type = "debt", amount = 100) => ({
  event_id: id,
  event_type: "entry_created",
  vault_id: "v",
  target_id: id,
  relationship_id: "r",
  hlc: { pms: 1000, l: 0, did: "device" },
  author_user_id_local_only: "self",
  origin: "local",
  payload: {
    entry_id: id,
    relationship_id: "r",
    type,
    amount_afn: amount,
    note: null,
    occurred_at_ms: 1000,
    ...(currency ? { currency } : {}),
  },
});
async function run() {
  await applyCurrencyMigration(store);
  const alertDDL =
    /execAsync\(`([^`]*CREATE TABLE IF NOT EXISTS credit_alert_policies[^`]*)`\)/.exec(
      readFileSync(require.resolve("../db"), "utf8"),
    )?.[1];
  assert.ok(alertDDL, "shipped credit-alert cache migration");
  store.exec(alertDDL);
  assert.equal(
    (store.prepare("SELECT currency FROM entries WHERE id='legacy'").get() as any).currency,
    "AFN",
  );
  store.prepare("UPDATE vaults SET currency='USD',default_entry_currency='USD' WHERE id='v'").run();
  await entries.applyEntryCreated(tx, make("untagged", undefined, "debt", 1));
  assert.equal(
    (await db.getEntry("untagged")).currency,
    "AFN",
    "replay uses frozen currency, not the new default",
  );
  store.prepare("DELETE FROM entries WHERE id='untagged'").run();
  await entries.applyEntryCreated(tx, make("usd", "USD", "payment"));
  assert.equal((await db.getPerson("p", "AFN")).balance, 100);
  assert.equal((await db.getPerson("p", "USD")).balance, -100, "opposite currencies do not cancel");
  await assert.rejects(
    eventLog.appendEntrySettled({ relationshipId: "r", currency: "AFN" }),
    eventLog.SettleNotZeroError,
    "opposite USD cannot settle the AFN debt",
  );
  assert.equal((store.prepare("SELECT COUNT(*) AS n FROM settlements").get() as any).n, 0);
  assert.deepEqual(
    (await db.listEntries("p", "USD")).map((e: any) => e.id),
    ["usd"],
  );
  assert.deepEqual(
    (await db.listEntriesForExport("v", "AFN")).map((e: any) => e.id),
    ["legacy"],
  );
  // Whole-book cards read every denomination explicitly: equal opposite
  // contacts remain two amounts, and selecting another view never filters it.
  store.exec(`
    INSERT INTO users(id,display_name,created_at,is_local_self) VALUES
      ('summary-a','Summary A',1,0),('summary-b','Summary B',1,0);
    INSERT INTO relationships(id,vault_id,user_a_id,user_b_id,context,created_at,updated_at) VALUES
      ('summary-ra','v','self','summary-a','peer',1,1),
      ('summary-rb','v','self','summary-b','peer',1,1);
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,updated_at,currency) VALUES
      ('summary-afn-a','v','summary-ra','debt',0.1,100,100,'AFN'),
      ('summary-afn-b','v','summary-rb','debt',0.2,100,100,'AFN'),
      ('summary-usd','v','summary-ra','debt',100,100,100,'USD');
    INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,last_synced_at,other_account_name)
      VALUES('summary-tab','v','summary-ra','a','EUR',1,'1',NULL,'Other');
    INSERT INTO vault_settings(vault_id,key,value) VALUES('v','default_entry_currency','"GBP"');
  `);
  const originalView = scope.getLedgerCurrencyCode();
  scope.setLedgerCurrencyCode("EUR");
  const summary = Object.fromEntries(
    (await db.listCurrencyBalanceSummaries("v")).map((row: any) => [row.currency, row]),
  );
  assert.deepEqual(summary.AFN, { currency: "AFN", collect: 100.3, pay: 0, pending: false });
  assert.deepEqual(
    summary.USD,
    { currency: "USD", collect: 100, pay: 100, pending: false },
    "a zero net does not hide both nonzero sides of one currency",
  );
  assert.deepEqual(summary.EUR, { currency: "EUR", collect: 0, pay: 0, pending: true });
  assert.deepEqual(
    summary.GBP,
    { currency: "GBP", collect: 0, pay: 0, pending: false },
    "a JSON-encoded new-tally default is discovered without relabelling legacy amounts",
  );
  assert.equal(
    scope.getLedgerCurrencyCode(),
    "EUR",
    "reading cards never changes the write/view currency",
  );
  assert.deepEqual(await db.listCurrencyBalanceSummaries("missing-book"), []);
  store.exec(`
    UPDATE tab_links SET last_synced_at=10 WHERE tab_id='summary-tab';
    INSERT INTO tab_entries(id,tab_id,direction,amount_minor,kind,status,seq,rev,created_by,occurred_at,created_at,local_pending,local_action_pending)
      VALUES('summary-opening','summary-tab','a_to_b',29,'opening','accepted',1,1,'a',1,1,0,0);
  `);
  assert.deepEqual(
    (await db.listCurrencyBalanceSummaries("v")).find((row: any) => row.currency === "EUR"),
    { currency: "EUR", collect: 0.29, pay: 0, pending: false },
    "the first shared sync replaces unknown totals with exact confirmed money",
  );
  store.exec(`DELETE FROM tab_entries WHERE tab_id='summary-tab';
    DELETE FROM tab_links WHERE tab_id='summary-tab';
    DELETE FROM entries WHERE id LIKE 'summary-%';
    DELETE FROM relationships WHERE id LIKE 'summary-%';
    DELETE FROM users WHERE id LIKE 'summary-%';`);
  store
    .prepare("DELETE FROM vault_settings WHERE vault_id='v' AND key='default_entry_currency'")
    .run();
  scope.setLedgerCurrencyCode(originalView);
  assert.equal((await db.listAllPeople("v", "USD"))[0].selection_totals.currency, "USD");
  scope.setLedgerCurrencyCode("USD");
  assert.equal((await db.getPerson("p")).balance, -100);
  assert.equal(await credit.creditBalanceInTx(tx, "v", "r", "AFN"), 10000);
  assert.equal(await credit.creditBalanceInTx(tx, "v", "r", "USD"), -10000);
  assert.equal(await credit.creditWarning("p", "debt", 100, "v", "AFN"), true);
  assert.equal(await credit.creditWarning("p", "debt", 100, "v", "USD"), false);
  assert.equal(await admission.hardLimitApplies(tx, "v", "r", "clerk", null, "AFN"), true);
  assert.equal(await admission.hardLimitApplies(tx, "v", "r", "clerk", null, "USD"), false);
  const afnPolicy = {
    relationship_id: "r",
    currency: "AFN",
    max_collect_minor: 15000,
    max_pay_minor: 0,
    mode: "clerk_block",
    updated_at_ms: 2,
  };
  const usdPolicy = { ...afnPolicy, currency: "USD", max_collect_minor: 20000 };
  await policyCache.cacheCreditPolicies(tx, "v", [afnPolicy, usdPolicy], 2);
  assert.equal((await credit.readCreditPolicy("r", "v", "USD")).max_collect_minor, 20000);
  assert.equal((await credit.readCreditPolicy("r", "v", "AFN")).max_collect_minor, 15000);
  await policyCache.cacheCreditPolicies(
    tx,
    "v",
    [{ ...afnPolicy, currency: undefined, updated_at_ms: 3 }],
    3,
  );
  assert.equal(
    await credit.readCreditPolicy("r", "v", "USD"),
    null,
    "old policies never follow selected currency",
  );
  await entries.applyEntrySettled(tx, {
    ...make("settled", "AFN"),
    event_type: "entry_settled",
    payload: { settled_at_ms: 2000, currency: "AFN" },
  });
  assert.deepEqual(await db.listSettlementBoundaries("p", "AFN"), [2000]);
  assert.deepEqual(await db.listSettlementBoundaries("p", "USD"), []);
  assert.equal((await db.getSettlementSummary("p", "USD")).count, 0);
  const currencies = await db.listLedgerCurrencies("v");
  assert.deepEqual(currencies, ["USD", "AFN"]);
  store.prepare("INSERT INTO vaults(id,name,currency) VALUES('new','New','EUR')").run();
  assert.equal(
    (store.prepare("SELECT legacy_currency FROM vaults WHERE id='new'").get() as any)
      .legacy_currency,
    "EUR",
  );
  await eventLog.appendEntryCreated({
    relationshipId: "r",
    type: "debt",
    amountAfn: 2,
    note: null,
    currency: "EUR",
  });
  assert.equal(
    authored.at(-1).payload.currency,
    "EUR",
    "new signed creation captures currency explicitly",
  );
  const restore = compile("../restore", (name) => {
    if (name === "./credit-alert-observation") return require("../credit-alert-observation");
    if (name === "./projection")
      return { applyEventMutex: { runExclusive: async (work: () => Promise<unknown>) => work() } };
    if (name === "./db-tx") return dbTx;
    if (name === "./hlc") return require("../hlc");
    if (name === "./entry-date") return require("../entry-date");
    if (name === "./currency-metadata") return require("../currency-metadata");
    if (name === "./currency-sync") return require("../currency-sync");
    if (name === "./projection/field-hlc") return fields;
    if (name === "./customer-group-restore")
      return {
        seedSnapshotCustomerGroups: async () => {},
        restoredRelationshipFieldHLCs: (value: string) => value,
        restoredRelationshipGroupIds: () => "[]",
      };
    if (name === "./projection/ingest-row") return { ingestPulledEvents: async () => 0 };
    if (name === "./projection/sweep") return { sweepVaultNow: async () => {} };
    if (name === "./sync/cursor") return { setLastPulledServerSeq: async () => {} };
    return {};
  });
  const snapshotEntry = {
    id: "restored-eur",
    vault_id: "restored",
    relationship_id: "restored-r",
    type: "debt",
    amount_afn: 10,
    note: null,
    currency: "EUR",
    created_at: 10,
    updated_at: 10,
    deleted_at: null,
    proposed_by_user_id: null,
    current_event_id: null,
    is_deleted: 0,
    is_settled: 0,
    accepted_at: null,
    disputed_at: null,
    disputed_reason: null,
    settled_at: null,
  };
  await restore.restoreFromSnapshot(
    {
      vault: {
        id: "restored",
        name: "Restored",
        currency: "AFN",
        legacy_currency: "USD",
        default_entry_currency: "GBP",
        created_at: 1,
        updated_at: 1,
        is_default: 0,
        account_id: null,
      },
      users: [],
      relationships: [
        {
          id: "restored-r",
          vault_id: "restored",
          user_a_id: "",
          user_b_id: "p",
          context: "peer",
          created_at: 1,
          updated_at: 1,
          archived_at: null,
        },
      ],
      entries: [snapshotEntry, { ...snapshotEntry, id: "restored-legacy", currency: undefined }],
      shop_profile: null,
      events: [],
      snapshot_server_seq: 1,
      generated_at_ms: 1,
      hlc_last: { pms: 10, l: 0, did: "d" },
    },
    { localSelfId: "self", setActiveDefault: false },
  );
  assert.equal(
    (store.prepare("SELECT currency FROM entries WHERE id='restored-eur'").get() as any).currency,
    "EUR",
  );
  assert.equal(
    (store.prepare("SELECT currency FROM entries WHERE id='restored-legacy'").get() as any)
      .currency,
    "USD",
    "legacy snapshot uses frozen base rather than display/default",
  );
  assert.equal(
    (store.prepare("SELECT legacy_currency FROM vaults WHERE id='restored'").get() as any)
      .legacy_currency,
    "USD",
  );
  const metadata = require("../currency-metadata") as typeof import("../currency-metadata");
  const beforeMismatch = (store.prepare("SELECT total_changes() AS n").get() as any).n;
  const beforeEntries = store.prepare("SELECT * FROM entries ORDER BY id").all();
  await assert.rejects(
    restore.restoreFromSnapshot(
      { vault: { id: "restored", legacy_currency: "AFN" } },
      { localSelfId: "self", setActiveDefault: false },
    ),
    (error: any) =>
      error instanceof metadata.LegacyCurrencyMismatchError &&
      error.message.includes("USD") &&
      error.message.includes("AFN") &&
      error.message.includes("Review"),
  );
  assert.equal(
    (store.prepare("SELECT total_changes() AS n").get() as any).n,
    beforeMismatch,
    "mismatched metadata performs no writes before failing",
  );
  assert.deepEqual(
    store.prepare("SELECT * FROM entries ORDER BY id").all(),
    beforeEntries,
    "mismatch never relabels or removes history",
  );
  const recovery = compile("../recovery", (name) =>
    name === "./db-tx" ? dbTx : name === "./currency-metadata" ? metadata : {},
  );
  await assert.rejects(
    recovery.pinMissingVaultAnchorFromListing(
      { vault_id: "restored", legacy_currency: "AFN" },
      "account",
    ),
    metadata.LegacyCurrencyMismatchError,
    "listing mismatch fails even before an anchor is available",
  );
  await metadata.assertLegacyCurrencyMatches(tx, "fresh-no-local-row", "EUR");
  console.log(
    "PASS currency migration, immutable legacy replay, independent balances/queries/exports/settlements and credit policies",
  );
}
void run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    scope.setLedgerCurrencyCode("AFN");
    store.close();
  });
