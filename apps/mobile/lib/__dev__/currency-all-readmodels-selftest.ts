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
  assert.deepEqual(totals.AFN, {
    currency: "AFN",
    collect: 101.3,
    pay: 0,
    collectCount: 3,
    payCount: 0,
    pending: false,
  });
  assert.deepEqual(totals.USD, {
    currency: "USD",
    collect: 65,
    pay: 100,
    collectCount: 2,
    payCount: 1,
    pending: false,
  });
  assert.equal(totals.EUR.pending, true);
  assert.equal(
    totals.EUR.collectCount,
    0,
    "zero and unknown balances do not count as customers to collect from",
  );
  assert.equal(totals.EUR.payCount, 0);
  const staleUnknown = currencyBalances(
    people.map((person) => ({
      ...person,
      currency_balances: person.currency_balances?.map((row) =>
        row.tab_unsynced === 1 ? { ...row, balance: 500 } : row,
      ),
    })),
    "AFN",
  ).find((row) => row.currency === "EUR")!;
  assert.equal(
    staleUnknown.collectCount,
    0,
    "an unrestored shared cache cannot invent a customer to collect from",
  );
  assert.equal(staleUnknown.pending, true);
  const repeated = currencyBalances([...people, byId.get("decimal")!], "AFN").find(
    (row) => row.currency === "AFN",
  )!;
  assert.equal(
    repeated.collectCount,
    3,
    "counts use distinct customers even if a source row is repeated",
  );
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
  store.exec("SAVEPOINT shared_currency_settlement");
  try {
    person("multi-settled");
    store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,other_joined_at,unjoined_invitation,last_synced_at) VALUES
      ('unused-afn','v','r-multi-settled','a','AFN',100,'1',100,0,1000),
      ('cleared-usd','v','r-multi-settled','a','USD',100,'1',100,0,1000),
      ('pending-eur','v','r-multi-settled','a','EUR',100,'1',100,0,1000);
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending) VALUES
      ('usd-gave','cleared-usd',1,1,'a','a_to_b',10000,'entry',200,200,'accepted',0),
      ('usd-received','cleared-usd',2,2,'b','b_to_a',10000,'entry',300,300,'accepted',0),
      ('eur-proposal','pending-eur',1,1,'b','b_to_a',5000,'entry',400,400,'pending',0);
      INSERT INTO tab_settlements(id,tab_id,rev,through_seq,settled_at_ms,created_by,actor_name,semantics_version)
      VALUES('usd-cleared','cleared-usd',3,2,500,'a','Owner','tally-zero-settlement-v1');`);
    const read = async (currency: string) =>
      (await db.listAllPeopleForSearch("v", currency)).find((row) => row.id === "multi-settled")!;
    const unused = await read("AFN");
    const cleared = await read("USD");
    const pending = await read("EUR");
    assert.deepEqual(
      [unused.balance, unused.is_settled, unused.last_entry_at],
      [0, 0, null],
      "an unused shared currency is empty, not independently settled",
    );
    assert.deepEqual(
      [cleared.balance, cleared.is_settled, cleared.tab_pending_count],
      [0, 1, 0],
      "a USD clearance remains settled beside an unused AFN leg and pending EUR claim",
    );
    assert.deepEqual(
      [pending.balance, pending.is_settled, pending.tab_pending_count],
      [0, 0, 1],
      "a pending EUR claim cannot borrow the USD settlement marker",
    );
    const clearedMoney = store
      .prepare(
        "SELECT id,seq,status,amount_minor,local_pending,local_action_pending FROM tab_entries WHERE tab_id='cleared-usd' ORDER BY seq",
      )
      .all();
    const clearanceMarker = store
      .prepare("SELECT * FROM tab_settlements WHERE tab_id='cleared-usd'")
      .all();
    for (const resolvedState of ["declined", null]) {
      store.exec("UPDATE tab_entries SET removal_state='pending' WHERE id='usd-gave'");
      const removalPending = await read("USD");
      assert.deepEqual(
        [removalPending.balance, removalPending.is_settled, removalPending.tab_pending_count],
        [0, 0, 0],
        "a synced removal request reopens clearance without inventing a pending financial tally",
      );
      assert.equal((await read("EUR")).tab_pending_count, 1);
      store
        .prepare("UPDATE tab_entries SET removal_state=? WHERE id='usd-gave'")
        .run(resolvedState);
      const resolved = await read("USD");
      assert.deepEqual(
        [resolved.balance, resolved.is_settled, resolved.tab_pending_count],
        [0, 1, 0],
        `a ${resolvedState ?? "cleared"} removal request keeps the original money and clearance intact`,
      );
    }
    assert.deepEqual(
      store
        .prepare(
          "SELECT id,seq,status,amount_minor,local_pending,local_action_pending FROM tab_entries WHERE tab_id='cleared-usd' ORDER BY seq",
        )
        .all(),
      clearedMoney,
    );
    assert.deepEqual(
      store.prepare("SELECT * FROM tab_settlements WHERE tab_id='cleared-usd'").all(),
      clearanceMarker,
      "pending removal classification preserves the existing clearance marker",
    );
    store.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending) VALUES
      ('usd-backdated-gave','cleared-usd',3,4,'a','a_to_b',100,'entry',1,600,'accepted',0),
      ('usd-backdated-received','cleared-usd',4,5,'b','b_to_a',100,'entry',2,700,'accepted',0);`);
    const reopened = await read("USD");
    assert.deepEqual(
      [reopened.balance, reopened.is_settled],
      [0, 0],
      "new zero-net USD records reopen only their own sequence chapter",
    );
    assert.equal((await read("EUR")).tab_pending_count, 1);
    const historyBefore = JSON.stringify(
      store.prepare("SELECT * FROM tab_entries WHERE tab_id='cleared-usd' ORDER BY seq").all(),
    );
    await read("USD");
    assert.equal(
      JSON.stringify(
        store.prepare("SELECT * FROM tab_entries WHERE tab_id='cleared-usd' ORDER BY seq").all(),
      ),
      historyBefore,
      "settlement classification never rewrites shared records",
    );
  } finally {
    store.exec("ROLLBACK TO shared_currency_settlement; RELEASE shared_currency_settlement");
  }
  store.exec("SAVEPOINT relink_settlement");
  try {
    person("relinked-settled");
    store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,other_joined_at,unjoined_invitation,last_synced_at,recording_mode,recording_mode_known) VALUES
      ('old-notify','v','r-relinked-settled','a','USD',100,'1',100,0,1000,'notify',1);
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending) VALUES
      ('notify-gave','old-notify',1,1,'a','a_to_b',10000,'entry',200,200,'recorded',0),
      ('notify-received','old-notify',2,2,'a','b_to_a',10000,'entry',300,300,'recorded',0);
      INSERT INTO tab_settlements(id,tab_id,rev,through_seq,settled_at_ms,created_by,actor_name,semantics_version)
      VALUES('notify-cleared','old-notify',3,2,500,'a','Owner','tally-zero-settlement-v1');`);
    const read = async () =>
      (await db.listAllPeopleForSearch("v", "USD")).find((row) => row.id === "relinked-settled")!;
    assert.equal((await read()).is_settled, 1);
    store.exec("UPDATE tab_links SET closed_at=600 WHERE tab_id='old-notify'");
    assert.equal(
      (await read()).is_settled,
      1,
      "unlinking preserves a deliberately cleared shared period",
    );
    store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,other_joined_at,unjoined_invitation,last_synced_at,recording_mode,recording_mode_known)
      VALUES('new-review','v','r-relinked-settled','a','USD',700,'2',NULL,1,1000,'review',1);`);
    assert.equal(
      (await read()).is_settled,
      1,
      "an unused review invitation preserves the previous notification clearance",
    );
    store.exec(
      "UPDATE tab_links SET other_joined_at=800,unjoined_invitation=0 WHERE tab_id='new-review'",
    );
    const relinked = await read();
    assert.equal(relinked.balance, 0);
    assert.deepEqual(
      (await db.listEntries("relinked-settled", "USD")).map((row) => row.id).sort(),
      ["notify-gave", "notify-received"],
      "a zero-balance relink retains the original shared financial evidence",
    );
    assert.equal(
      (await tabDb.getFinancialTabLinkForPerson("relinked-settled", "USD"))!.tab_id,
      "new-review",
    );
    assert.equal((await tabDb.listTabSettlements("old-notify")).length, 1);
    assert.equal(
      relinked.is_settled,
      1,
      "joining an empty mutual period must not reopen the previous deliberately settled book",
    );
    const scopedMarkers = await tabDb.listScopedTabSettlements("new-review");
    assert.deepEqual(
      scopedMarkers.map((marker: any) => [marker.tab_id, marker.id]),
      [["old-notify", "notify-cleared"]],
    );
    assert.deepEqual(await tabDb.listScopedTabSettlements("missing"), []);
    const snapshot = () => ({
      links: store
        .prepare(
          "SELECT * FROM tab_links WHERE relationship_id='r-relinked-settled' ORDER BY tab_id",
        )
        .all(),
      entries: store
        .prepare(
          "SELECT * FROM tab_entries WHERE tab_id IN ('old-notify','new-review') ORDER BY id",
        )
        .all(),
      markers: store
        .prepare(
          "SELECT * FROM tab_settlements WHERE tab_id IN ('old-notify','new-review') ORDER BY id",
        )
        .all(),
    });
    const unchanged = snapshot();
    const scenario = async (sql: string, settled: number, label: string, balance = 0) => {
      store.exec("SAVEPOINT relink_case");
      try {
        store.exec(sql);
        const before = snapshot();
        const row = await read();
        assert.deepEqual([row.balance, row.is_settled], [balance, settled], label);
        const detail = await db.getPerson("relinked-settled", "USD");
        assert.deepEqual(
          [detail?.balance, detail?.is_settled],
          [row.balance, row.is_settled],
          `${label}: Home and detail use the same per-currency clearance proof`,
        );
        await tabDb.listScopedTabSettlements("new-review");
        assert.deepEqual(
          snapshot(),
          before,
          `${label}: reads never rewrite links, tallies or markers`,
        );
      } finally {
        store.exec("ROLLBACK TO relink_case; RELEASE relink_case");
      }
    };
    for (const [oldMode, newMode, status] of [
      ["notify", "review", "recorded"],
      ["notify_one_way", "review", "recorded"],
      ["review", "notify", "accepted"],
    ]) {
      await scenario(
        `UPDATE tab_links SET recording_mode='${oldMode}' WHERE tab_id='old-notify';
        UPDATE tab_links SET recording_mode='${newMode}' WHERE tab_id='new-review';
        UPDATE tab_entries SET status='${status}' WHERE tab_id='old-notify'`,
        1,
        `${oldMode} to ${newMode} preserves the original explicit clearance`,
      );
    }
    await scenario(
      "UPDATE tab_links SET role='b' WHERE tab_id='new-review'",
      1,
      "relinking as the opposite party preserves original period clearance",
    );
    const opening = (
      amount: number,
      status = "accepted",
    ) => `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending)
      VALUES('new-opening','new-review',1,1,'a','a_to_b',${amount},'opening',900,900,'${status}',0)`;
    for (const status of ["accepted", "recorded"])
      await scenario(opening(0, status), 1, `${status} zero handover preserves cleared history`);
    for (const status of ["pending", "disputed"])
      await scenario(
        opening(0, status),
        0,
        `${status} zero opening remains a current unresolved chapter`,
      );
    await scenario(opening(500), 0, "a new nonzero opening is not cleared by old markers", 5);
    await scenario(
      opening(500, "pending"),
      0,
      "a pending nonzero opening cannot inherit settlement",
    );
    const newPair = `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending) VALUES
      ('new-gave','new-review',1,1,'a','a_to_b',100,'entry',1,1000,'accepted',0),
      ('new-received','new-review',2,2,'b','b_to_a',100,'entry',2,1001,'accepted',0)`;
    await scenario(
      newPair,
      0,
      "a genuine backdated net-zero chapter still needs explicit settlement",
    );
    const newMarker = `INSERT INTO tab_settlements(id,tab_id,rev,through_seq,settled_at_ms,created_by,actor_name,semantics_version)
      VALUES('review-cleared','new-review',3,2,1100,'a','Owner','tally-zero-settlement-v1')`;
    await scenario(
      `DELETE FROM tab_settlements WHERE tab_id='old-notify'; ${newPair}; ${newMarker}`,
      0,
      "a newer source marker cannot clear older unabsorbed zero-net rows",
    );
    await scenario(
      `DELETE FROM tab_settlements WHERE tab_id='old-notify'; ${opening(500)};
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,local_pending)
      VALUES('opening-repaid','new-review',2,2,'b','b_to_a',500,'entry',1000,1000,'accepted',0); ${newMarker}`,
      1,
      "an accepted nonzero handover and its explicit clearance still absorb older history",
    );
    const privatePair = (
      first: number,
    ) => `INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,updated_at) VALUES
      ('private-gave','v','r-relinked-settled','debt',25,'USD',${first},${first}),
      ('private-received','v','r-relinked-settled','payment',25,'USD',${first + 1},${first + 1})`;
    await scenario(
      `${privatePair(650)}; DELETE FROM tab_links WHERE tab_id='new-review'`,
      0,
      "a post-close private zero-net chapter remains open before relinking",
    );
    await scenario(
      privatePair(650),
      0,
      "empty relinking cannot silently clear post-close private zero-net activity",
    );
    await scenario(
      `${privatePair(650)}; ${opening(0)}`,
      0,
      "a zero handover cannot silently clear post-close private zero-net activity",
    );
    await scenario(
      privatePair(50),
      1,
      "private rows absorbed before an explicitly cleared shared binding remain historical",
    );
    await scenario(
      `${privatePair(650)}; ${newPair}; ${newMarker}`,
      1,
      "a new explicit shared marker can clear the current binding's frozen private input",
    );
    await scenario(
      `UPDATE tab_links SET closed_at=1100 WHERE tab_id='new-review';
      INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,other_joined_at,unjoined_invitation,last_synced_at,recording_mode,recording_mode_known)
      VALUES('third-empty','v','r-relinked-settled','a','USD',1200,'3',1200,0,1300,'notify',1)`,
      1,
      "repeated empty mode changes preserve original clearance without moving its marker",
    );
    await scenario(
      "DELETE FROM tab_settlements WHERE tab_id='old-notify'",
      0,
      "old net-zero activity without a marker is not settled",
    );
    await scenario(
      "UPDATE tab_settlements SET through_seq=1 WHERE tab_id='old-notify'",
      0,
      "a stale old marker cannot cover later activity",
    );
    await scenario(
      `UPDATE tab_settlements SET through_seq=1 WHERE tab_id='old-notify'; ${opening(0)}`,
      0,
      "zero handover cannot erase an unmarked part of older zero-net history",
    );
    for (const [sql, balance] of [
      ["UPDATE tab_entries SET removal_state='pending' WHERE id='notify-gave'", 0],
      ["UPDATE tab_entries SET local_action_pending=1 WHERE id='notify-gave'", -100],
      ["UPDATE tab_entries SET seq=0 WHERE id='notify-gave'", 0],
      ["UPDATE tab_links SET last_synced_at=NULL WHERE tab_id='old-notify'", 0],
      ["UPDATE tab_links SET history_order=NULL WHERE tab_id='old-notify'", 0],
      [
        "INSERT INTO tab_outbox(id,tab_id,op,payload,created_at) VALUES('old-outbox','old-notify','close','{}',1000)",
        0,
      ],
      [
        "INSERT INTO tab_outbox(id,tab_id,op,payload,created_at) VALUES('new-outbox','new-review','close','{}',1000)",
        0,
      ],
    ] as const)
      await scenario(sql, 0, "unresolved or unknown work cannot inherit a settled state", balance);
    store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,history_order,last_synced_at,closed_at) VALUES
      ('other-currency','v','r-relinked-settled','a','AFN',100,'1',1000,1000),
      ('other-contact','v','r-elsewhere','a','USD',100,'1',1000,1000),
      ('other-vault','elsewhere','r-relinked-settled','a','USD',100,'1',1000,1000);
      INSERT INTO tab_settlements(id,tab_id,rev,through_seq,settled_at_ms,created_by,actor_name,semantics_version) VALUES
      ('other-currency-marker','other-currency',1,1,1000,'a','Owner','tally-zero-settlement-v1'),
      ('other-contact-marker','other-contact',1,1,1000,'a','Owner','tally-zero-settlement-v1'),
      ('other-vault-marker','other-vault',1,1,1000,'a','Owner','tally-zero-settlement-v1');`);
    assert.deepEqual(
      await tabDb.listScopedTabSettlements("new-review"),
      scopedMarkers,
      "source-marker lookup is isolated by vault, contact and currency",
    );
    assert.deepEqual(snapshot().entries, unchanged.entries);
    assert.deepEqual(snapshot().markers, unchanged.markers);
    person("marker-only");
    store.exec(
      "INSERT INTO settlements(vault_id,relationship_id,currency,settled_at_ms) VALUES('v','r-marker-only','USD',1000)",
    );
    const markerOnly = await db.getPerson("marker-only", "AFN", { allCurrencies: true });
    assert.equal(markerOnly!.currency, "AFN", "detail keeps its preferred write currency");
    assert.equal(
      markerOnly!.is_settled,
      1,
      "aggregate detail state includes a nonpreferred marker-only currency",
    );
    assert.deepEqual(
      markerOnly!.currency_balances!.map((row) => row.currency),
      ["USD"],
    );
    assert.equal((await db.getPerson("mixed", "AFN", { allCurrencies: true }))!.is_settled, 0);
  } finally {
    store.exec("ROLLBACK TO relink_settlement; RELEASE relink_settlement");
  }
  active = null;
  assert.equal(await db.getPerson("usd-only", "AFN", { allCurrencies: true }), null);
  assert.deepEqual(await db.listEntries("usd-only", "AFN", { allCurrencies: true }), []);
  store.close();
  console.log(
    "PASS all-currency read models: real SQLite USD-only contacts, separate opposing balances, exact cents, pending/retained shared history, distinct identities and per-currency selections",
  );
}
void main();
