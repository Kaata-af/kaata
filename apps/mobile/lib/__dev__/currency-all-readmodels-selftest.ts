import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import Database from "better-sqlite3";
import { Mutex } from "../util/mutex";
import * as scope from "../currency-scope";
import {
  currencyBalances,
  mergeCurrencyPeople,
  selectedEntriesByCurrency,
  selectedPeopleByCurrency,
} from "../multi-currency-view";

const store = new Database(":memory:");
store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT);
CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,phone_e164 TEXT,created_at INTEGER);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_a_id TEXT,user_b_id TEXT,created_at INTEGER,archived_at INTEGER);
CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn NUMERIC,currency TEXT,note TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER,field_hlcs TEXT,proposed_by_user_id TEXT,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER);
CREATE TABLE settlements(id TEXT,vault_id TEXT,relationship_id TEXT,currency TEXT,settled_at_ms INTEGER);
CREATE TABLE vault_settings(vault_id TEXT,key TEXT,value TEXT);
CREATE TABLE credit_admission_intents(event_id TEXT,vault_id TEXT,relationship_id TEXT,status TEXT,reason TEXT);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,target_id TEXT,event_type TEXT,payload_json TEXT,appended_at INTEGER,server_acked_at INTEGER);
INSERT INTO vaults VALUES('v','AFN','AFN','AFN');`);
const source = readFileSync(require.resolve("../db"), "utf8");
for (const marker of [
  "CREATE TABLE IF NOT EXISTS tab_links",
  "CREATE TABLE IF NOT EXISTS tab_failed_ops",
  "ALTER TABLE tab_entries ADD COLUMN author_account_id",
  "ALTER TABLE tab_entries ADD COLUMN author_member_role",
  "CREATE TABLE IF NOT EXISTS tab_settlements",
  "ALTER TABLE tab_links ADD COLUMN history_order TEXT;",
]) {
  const ddl = [...source.matchAll(/execAsync\(`([^`]*)`\)/g)].find((match) =>
    match[1].includes(marker),
  )?.[1];
  assert.ok(ddl, `shipped migration block: ${marker}`);
  store.exec(ddl);
}
store.exec(
  `DROP INDEX idx_tab_links_open_rel; CREATE UNIQUE INDEX idx_tab_links_open_rel ON tab_links(relationship_id,currency) WHERE closed_at IS NULL;`,
);
let active: string | null = "v";
const tx: any = {
  getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
};
const dbTx = {
  getDb: async () => tx,
  getActiveVaultIdSyncMaybe: () => active,
  getAccountIdSync: () => "owner",
};
function compile(file: string, resolve: (name: string) => any): any {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)(resolve, exports);
  return exports;
}
const tabDb = compile("../tabs/db", (name) =>
  name === "../db-tx"
    ? dbTx
    : [
          "../currency-scope",
          "../entry-date",
          "../money",
          "./direction",
          "./errors",
          "./wire",
          "./history",
        ].includes(name)
      ? require(name.startsWith("../") ? "../" + name.slice(3) : "../tabs/" + name.slice(2))
      : {},
);
const mutex = new Mutex();
const db = compile("../db", (name) => {
  if (name === "./db-tx") return dbTx;
  if (name === "./tabs/db") return tabDb;
  if (name === "./projection") return { applyEventMutex: mutex };
  if (
    [
      "./money",
      "./money-sql",
      "./entry-date",
      "./currency-scope",
      "./tabs/history",
      "./tabs/direction",
      "./tabs/errors",
      "./multi-currency-view",
    ].includes(name)
  )
    return require("../" + name.slice(2));
  return {};
}) as typeof import("../db");
function person(id: string) {
  store.prepare("INSERT INTO users VALUES(?,?,NULL,1)").run(id, id);
  store.prepare("INSERT INTO relationships VALUES(?, 'v','self',?,1,NULL)").run("r-" + id, id);
}
function entry(id: string, who: string, code: string, type: string, amount: number, at: number) {
  store
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,updated_at) VALUES(?,'v',?,?,?,?,?,?)",
    )
    .run(id, "r-" + who, type, amount, code, at, at);
}
async function main() {
  for (const id of ["usd-only", "mixed", "decimal", "zero", "neutral", "shared"]) person(id);
  entry("usd-only-40", "usd-only", "USD", "debt", 40, 400);
  entry("mixed-afn", "mixed", "AFN", "debt", 100, 200);
  entry("mixed-usd", "mixed", "USD", "payment", 100, 300);
  entry("decimal-a", "decimal", "AFN", "debt", 0.1, 100);
  entry("decimal-b", "decimal", "AFN", "debt", 0.2, 101);
  entry("zero-debt", "zero", "EUR", "debt", 10, 600);
  entry("zero-payment", "zero", "EUR", "payment", 10, 700);
  entry("prelink", "shared", "USD", "debt", 30, 10);
  entry("postlink", "shared", "USD", "payment", 5, 750);
  entry("shared-private", "shared", "AFN", "debt", 1, 800);
  store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,closed_at,last_synced_at) VALUES
    ('old-usd','v','r-shared','a','USD',50,'1',150,100),
    ('new-usd','v','r-shared','a','USD',200,'2',NULL,500),
    ('unknown-eur','v','r-shared','a','EUR',100,'3',NULL,NULL);
    INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending) VALUES
    ('retained-usd','old-usd',1,1,'a','a_to_b',3000,'entry',100,100,'accepted',0),
    ('pending-opening','new-usd',1,1,'a','a_to_b',9000,'opening',500,500,'pending',0);`);
  scope.setLedgerCurrencyCode("AFN");
  const people = await db.listAllPeopleForSearch("v", "AFN", { allCurrencies: true });
  const byId = new Map(people.map((row) => [row.id, row]));
  assert.equal(people.length, 6, "contacts deduplicate across currency reads");
  assert.equal(byId.get("usd-only")!.currency_balances![0].currency, "USD");
  assert.equal(
    byId.get("usd-only")!.last_entry_at,
    400,
    "USD-only contact retains activity in whole-book list",
  );
  assert.deepEqual(
    byId.get("mixed")!.currency_balances!.map((row) => [row.currency, row.balance]),
    [
      ["AFN", 100],
      ["USD", -100],
    ],
    "unlike currencies cannot cancel",
  );
  assert.equal(byId.get("decimal")!.currency_balances![0].balance, 0.3);
  assert.equal(
    byId.get("zero")!.currency_balances![0].currency,
    "EUR",
    "settled/netzero activity is still a real currency row",
  );
  assert.equal(
    byId.get("shared")!.currency_balances!.find((row) => row.currency === "USD")!.balance,
    25,
    "older acknowledged history survives a pending replacement opening",
  );
  assert.equal(
    byId.get("shared")!.currency_balances!.find((row) => row.currency === "EUR")!.tab_unsynced,
    1,
  );
  await assert.rejects(
    db.listEntriesForExport("v", "EUR"),
    /still syncing/,
    "an unrestored shared account must not become a zero-balance export",
  );
  assert.ok(
    (await db.listEntriesForExport("v", "AFN")).length > 0,
    "another currency's missing cache does not corrupt this currency's export",
  );
  store.prepare("UPDATE tab_links SET last_synced_at=NULL WHERE tab_id='new-usd'").run();
  await assert.rejects(db.listEntriesForExport("v", "USD"), /still syncing/);
  store.prepare("UPDATE tab_links SET last_synced_at=500 WHERE tab_id='new-usd'").run();
  assert.ok((await db.listEntriesForExport("v", "USD")).length > 0);
  store.prepare("UPDATE tab_links SET last_synced_at=NULL WHERE tab_id='old-usd'").run();
  await assert.rejects(db.listEntriesForExport("v", "USD"), /still syncing/);
  await assert.rejects(
    db.listArchivedSharedPeriodsForExport("shared", "USD", { requireComplete: true }),
    /still syncing/,
    "a known latest opening cannot make missing older history look complete",
  );
  assert.ok(
    (await db.listArchivedSharedPeriodsForExport("shared", "USD")).some(
      (period) => period.link.tab_id === "old-usd" && period.link.last_synced_at === null,
    ),
    "the ordinary page can still load while retaining the incomplete-history signal",
  );
  store.exec("SAVEPOINT empty_missing_history; DELETE FROM tab_entries WHERE tab_id='old-usd';");
  try {
    const missing = await db.listArchivedSharedPeriodsForExport("shared", "USD");
    assert.ok(
      missing.some((period) => period.link.tab_id === "old-usd" && period.entries.length === 0),
      "an empty unrestored cache must remain visible to the bill completeness guard",
    );
  } finally {
    store.exec("ROLLBACK TO empty_missing_history; RELEASE empty_missing_history;");
  }
  store.prepare("UPDATE tab_links SET last_synced_at=100 WHERE tab_id='old-usd'").run();
  const totals = Object.fromEntries(
    currencyBalances(people, "AFN").map((row) => [row.currency, row]),
  );
  assert.deepEqual(totals.AFN, { currency: "AFN", collect: 101.3, pay: 0, pending: false });
  assert.deepEqual(totals.USD, { currency: "USD", collect: 65, pay: 100, pending: false });
  assert.equal(totals.EUR.pending, true);
  const summaries = Object.fromEntries(
    selectedPeopleByCurrency(people, "AFN").map((row) => [row.currency, row.summary]),
  );
  assert.equal(summaries.AFN.debt, 101.3);
  assert.equal(summaries.USD.collect, 65);
  assert.equal(summaries.USD.pay, 100);
  assert.equal(summaries.EUR.pending, true);
  const mergedTwice = mergeCurrencyPeople(
    [
      people.flatMap((row) => row.currency_balances ?? [row]),
      people.flatMap((row) => row.currency_balances ?? [row]),
    ],
    "AFN",
  );
  assert.equal(mergedTwice.length, 6);
  assert.deepEqual(
    currencyBalances(mergedTwice, "AFN"),
    currencyBalances(people, "AFN"),
    "duplicate per-currency shared contact rows count once",
  );
  const history = await db.listEntries("shared", "AFN", { allCurrencies: true });
  assert.deepEqual(
    history.map((row) => row.id),
    ["shared-private", "postlink", "pending-opening", "retained-usd"],
  );
  assert.equal(new Set(history.map((row) => row.id)).size, history.length);
  assert.equal(
    history.find((row) => row.id === "retained-usd")!.tab!.tab_id,
    "old-usd",
    "retained evidence keeps original shared identity",
  );
  const mixedEntries = [
    ...(await db.listEntries("mixed", "AFN", { allCurrencies: true })),
    ...(await db.listEntries("decimal", "AFN", { allCurrencies: true })),
  ];
  const selected = Object.fromEntries(
    selectedEntriesByCurrency(mixedEntries, "AFN").map((row) => [row.currency, row.summary]),
  );
  assert.equal(selected.AFN.collect, 100.3);
  assert.equal(selected.USD.pay, 100);
  assert.equal(
    scope.getLedgerCurrencyCode(),
    "AFN",
    "reading all currencies never changes the write/view selection",
  );
  const detail = await db.getPerson("usd-only", "AFN", { allCurrencies: true });
  assert.equal(detail!.currency_balances![0].balance, 40);
  assert.equal(
    detail!.last_entry_at,
    400,
    "detail activity spans currencies without changing primary action context",
  );
  // Scalar metadata belongs to the preferred action context; activity should
  // still be inspectable from each explicit currency row.
  assert.equal(detail!.currency_balances![0].last_entry_at, 400);
  const credit = compile("../credit-limits", (name) =>
    name === "./db-tx"
      ? dbTx
      : [
            "./currency-scope",
            "./money",
            "./money-sql",
            "./tabs/history",
            "./credit-policy",
            "./credit-policy-cache",
          ].includes(name)
        ? require("../" + name.slice(2))
        : {},
  ) as typeof import("../credit-limits");
  store.exec(`INSERT INTO event_log VALUES
    ('gbp-intent','v','never-created','entry_created','{"currency":"GBP","type":"debt","amount_afn":9,"occurred_at_ms":900}',900,NULL),
    ('legacy-intent','v','never-created-2','entry_created','{"type":"debt","amount_afn":1,"occurred_at_ms":850}',850,NULL);
    INSERT INTO credit_admission_intents VALUES('gbp-intent','v','r-shared','pending',NULL),('legacy-intent','v','r-shared','refused','credit_limit_exceeded');
    INSERT INTO tab_outbox(id,tab_id,op,payload,created_at) VALUES('usd-intent','new-usd','append','{"direction":"a_to_b","amount":"2.00","occurred_at_ms":875}',875);`);
  assert.ok(
    !(await db.listLedgerCurrencies("v")).includes("GBP"),
    "a deferred tally has no GBP financial history yet",
  );
  const intents = await credit.listCreditIntents("shared", "v", "AFN", { allCurrencies: true });
  assert.deepEqual(
    intents.map((row) => [row.id, row.currency]),
    [
      ["gbp-intent", "GBP"],
      ["usd-intent", "USD"],
      ["legacy-intent", "AFN"],
    ],
    "all intents include disabled foreign choices without converting them into money",
  );
  assert.deepEqual(
    (await credit.listCreditIntents("shared", "v", "AFN")).map((row) => row.id),
    ["legacy-intent"],
    "existing scoped API remains currency-isolated",
  );
  active = null;
  assert.equal(await db.getPerson("usd-only", "AFN", { allCurrencies: true }), null);
  assert.deepEqual(await db.listEntries("usd-only", "AFN", { allCurrencies: true }), []);
  store.close();
  console.log(
    "PASS all-currency read models: real SQLite USD-only contacts, separate opposing balances, exact cents, pending/retained shared history, distinct identities and per-currency selections",
  );
}
void main();
