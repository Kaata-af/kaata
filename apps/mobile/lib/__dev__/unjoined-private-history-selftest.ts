// Execute shipped read models against synthetic SQLite only. No device,
// account, production database, or network is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import { Mutex } from "../util/mutex";
import { balanceContribution, recordTotals } from "../export/shared-record";
import { currencyBalances } from "../multi-currency-view";
import type { Entry } from "../types";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
let store: Database.Database;
const source = readFileSync(require.resolve("../db"), "utf8");
const sqlite = {
  execAsync: async (sql: string) => {
    store.exec(sql);
  },
  getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
  withTransactionAsync: async (run: () => Promise<void>) => {
    store.exec("BEGIN");
    try {
      await run();
      store.exec("COMMIT");
    } catch (error) {
      store.exec("ROLLBACK");
      throw error;
    }
  },
};
const dbTx = {
  getDb: async () => sqlite,
  getActiveVaultIdSyncMaybe: () => "vault",
  getAccountIdSync: () => "owner",
};
const mutex = new Mutex();
function compile<T>(file: string, resolve: (name: string) => unknown, expose: string[] = []): T {
  const exports = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(
      readFileSync(require.resolve(file), "utf8") +
        (expose.length ? `\nexport { ${expose.join(",")} };` : ""),
      {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText,
  )(resolve, exports);
  return exports as T;
}
const migrationSource = /async function runMigration045[\s\S]*?\n}/.exec(source)?.[0];
assert.ok(migrationSource, "shipped unjoined-invitation migration");
const migrateUnjoinedInvitation = new Function(
  "columnExists",
  "MIGRATION_045",
  ts.transpileModule(migrationSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText + "\nreturn runMigration045;",
)(
  async (_db: unknown, table: string, column: string) =>
    (store.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (row) => row.name === column,
    ),
  "045_unjoined_invitation",
) as (db: typeof sqlite) => Promise<void>;
function dependency(name: string) {
  return require(name.startsWith("../") ? "../" + name.slice(3) : "../tabs/" + name.slice(2));
}
const tabDb = compile<typeof import("../tabs/db")>("../tabs/db", (name) => {
  if (name === "../db-tx") return dbTx;
  if (name === "../projection") return { applyEventMutex: mutex };
  if (name === "../ledger-events") return { emitLedgerApplied() {} };
  if (name === "./events") return { emitTabApplied() {} };
  return dependency(name);
});
const db = compile<
  typeof import("../db") & {
    assertNotTabLinked(db: Pick<typeof sqlite, "getFirstAsync">, entryId: string): Promise<void>;
  }
>(
  "../db",
  (name) => {
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
  },
  ["assertNotTabLinked"],
);
const { TabLinkedEntryError } = require("../tabs/errors") as typeof import("../tabs/errors");
const settleGuardTemplate =
  /export async function appendEntrySettled[\s\S]*?`(SELECT 1 AS one FROM tab_links[\s\S]*?)`/.exec(
    readFileSync(require.resolve("../event-log"), "utf8"),
  )?.[1];
assert.ok(settleGuardTemplate, "shipped local-settlement shared-history guard");
const settleGuardSql = new Function(
  "unjoinedInvitationSql",
  "return `" + settleGuardTemplate + "`;",
)(require("../tabs/history").unjoinedInvitationSql) as string;
const credit = compile<typeof import("../credit-limits")>("../credit-limits", (name) => {
  if (name === "./db-tx") return dbTx;
  if (
    [
      "./currency-scope",
      "./entry-date",
      "./money",
      "./money-sql",
      "./tabs/history",
      "./credit-policy",
      "./credit-policy-cache",
    ].includes(name)
  )
    return require("../" + name.slice(2));
  return {};
});
const data = compile<typeof import("../export/data")>("../export/data", (name) => {
  if (name === "../db") return { ...db, getLocalSelf: async () => null };
  if (name === "../tabs/db") return tabDb;
  if (name === "../projection") return { applyEventMutex: mutex };
  if (name === "../calendar") return { getEffectiveCalendar: () => "gregorian" };
  if (name === "../currency") return { getCurrencySymbol: (code: string) => code };
  if (name === "../jalali") return {};
  if (name === "../money") return require("../money");
  if (name === "./shared-record") return require("../export/shared-record");
  if (name === "../tabs/chapters") return require("../tabs/chapters");
  if (name === "../tabs/history") return require("../tabs/history");
  if (name === "../currency-totals") return require("../currency-totals");
  return {};
});

function reset(
  options: {
    joined?: boolean;
    opening?: "pending" | "accepted" | "voided";
    closed?: boolean;
    unjoined?: 0 | 1 | null;
  } = {},
) {
  store?.close();
  store = new Database(":memory:");
  store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,phone_e164 TEXT,created_at INTEGER);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_a_id TEXT,user_b_id TEXT,created_at INTEGER,archived_at INTEGER);
    CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn NUMERIC,currency TEXT,note TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER,field_hlcs TEXT,proposed_by_user_id TEXT,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER);
    CREATE TABLE settlements(id TEXT,vault_id TEXT,relationship_id TEXT,currency TEXT,settled_at_ms INTEGER);
    CREATE TABLE vault_settings(vault_id TEXT,key TEXT,value TEXT);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
    INSERT INTO vaults VALUES('vault','AFN','AFN','AFN');
    INSERT INTO users VALUES('person','Customer',NULL,1);
    INSERT INTO relationships VALUES('relationship','vault','self','person',1,NULL);
    INSERT INTO entries VALUES
      ('settled-gave','vault','relationship','debt',40,'AFN','Settled rice',100,100,NULL,NULL,NULL,NULL,NULL,NULL,200),
      ('settled-received','vault','relationship','payment',40,'AFN','Received in cash',200,200,NULL,NULL,NULL,NULL,NULL,NULL,200),
      ('private-loan','vault','relationship','debt',120,'AFN','First line\nSecond line',400,450,NULL,'{"recorded_at_ms":{"pms":350,"l":0,"did":"fixture"}}',NULL,NULL,NULL,NULL,NULL),
      ('usd-private','vault','relationship','debt',70,'USD','Other currency',50,50,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO settlements VALUES('private-chapter','vault','relationship','AFN',200);`);
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
    assert.ok(ddl, `shipped schema: ${marker}`);
    store.exec(ddl);
  }
  store
    .prepare(
      `INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,other_joined_at,rev,closed_at,linked_at,last_synced_at,history_order,unjoined_invitation)
    VALUES('invite','vault','relationship','a','AFN',?,2,?,500,500,'1',?)`,
    )
    .run(
      options.joined ? 550 : null,
      options.closed ? 600 : null,
      "unjoined" in options
        ? options.unjoined
        : options.joined || options.opening === "accepted"
          ? 0
          : 1,
    );
  store
    .prepare(
      `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voided_by_entry_id)
    VALUES('opening','invite',1,1,'a','a_to_b',12000,'opening',500,500,?,?)`,
    )
    .run(
      options.opening === "accepted" ? "accepted" : "pending",
      options.opening === "voided" ? "cancellation" : null,
    );
  if (options.opening === "voided")
    store.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voids_entry_id)
      VALUES('cancellation','invite',2,2,'a','b_to_a',12000,'void',650,650,'accepted','opening');`);
}
function snapshot() {
  return ["entries", "settlements", "tab_entries", "tab_outbox"].map((table) => [
    table,
    store.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]);
}
const privateIds = ["private-loan", "settled-received", "settled-gave"];
const privateEntries = (rows: Entry[]) => rows.filter((row) => !row.tab);
let passed = 0;
let failed = 0;
async function test(name: string, run: () => Promise<void>) {
  reset();
  try {
    await run();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`, error);
  }
}
async function expectPrivateBook() {
  const before = snapshot();
  const person = (await db.getPerson("person", "AFN"))!;
  assert.equal(person.balance, 120, "inviting cannot demote recorded private debt to pending");
  assert.equal(
    person.tab_pending_balance,
    0,
    "an opening copied from this private book is not new pending money",
  );
  assert.equal(
    person.tab_pending_count,
    0,
    "the copied opening does not create an unresolved tally count",
  );
  const people = await db.listAllPeople("vault", "AFN");
  assert.equal(people[0].balance, 120, "home and detail show the same existing balance");
  assert.deepEqual(people[0].selection_totals, {
    currency: "AFN",
    debtCount: 2,
    creditCount: 1,
    debtMinor: 16000,
    creditMinor: 4000,
  });
  const rows = await db.listEntries("person", "AFN");
  assert.deepEqual(
    privateEntries(rows).map((row) => row.id),
    privateIds,
    "all dated original tallies stay in the current private book",
  );
  const loan = rows.find((row) => row.id === "private-loan")!;
  assert.equal(loan.note, "First line\nSecond line");
  assert.equal(loan.created_at, 400);
  assert.equal(rows.find((row) => row.id === "settled-gave")!.settled_at, 200);
  assert.equal(
    rows.reduce((sum, row) => sum + balanceContribution(row), 0),
    120,
  );
  assert.equal(
    recordTotals(rows).pending,
    0,
    "the duplicate opening claim adds no pending money to the existing private book",
  );
  const link = (await tabDb.getTabLink("invite"))!;
  const folded = await tabDb.listPreLinkEntries(link);
  assert.ok(
    !folded.some((row) => privateIds.includes(row.id)),
    "active originals cannot also appear as excluded carried history",
  );
  assert.deepEqual(await db.listSettlementBoundaries("person", "AFN"), [200]);
  const statement = (await data.buildPersonStatement("person", "en", "AFN", "AFN", 1000))!;
  assert.equal(statement.balance, 120);
  assert.equal(
    statement.rows.filter((row) => row.kind === "settled" && row.ms === 200).length,
    1,
    "the original settled chapter remains in the current statement",
  );
  assert.deepEqual(
    statement.rows.flatMap((row) => (row.kind === "entry" && !row.entry.tab ? [row.entry.id] : [])),
    [...privateIds].reverse(),
  );
  const journal = await db.listEntriesForExport("vault", "AFN");
  assert.ok(
    journal.every((row) => row.kind !== "opening"),
    "the export journal contains originals without a phantom duplicate opening",
  );
  assert.deepEqual(
    journal.filter((row) => !row.tab).map((row) => row.id),
    [...privateIds].reverse(),
  );
  assert.equal(
    journal.reduce((sum, row) => sum + balanceContribution(row), 0),
    120,
  );
  const report = await data.buildVaultReport("vault", "Fixture book", "AFN", "en", 1000);
  assert.deepEqual(report.totals, { collect: 120, pay: 0, net: 120 });
  assert.equal(
    await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
    12000,
    "cancelled invitations cannot erase credit exposure",
  );
  assert.deepEqual(
    snapshot(),
    before,
    "read-model recovery creates no financial entries and alters no review evidence",
  );
}
async function main() {
  await test(
    "unjoined invitation preserves originals, confirmed balance, chapters, exports and credit",
    expectPrivateBook,
  );
  await test("closing an unjoined invitation preserves the same private book", async () => {
    store.prepare("UPDATE tab_links SET closed_at=600 WHERE tab_id='invite'").run();
    await expectPrivateBook();
  });
  await test("an unsynced opening action cannot demote the existing private book", async () => {
    store
      .prepare("UPDATE tab_entries SET status='accepted',local_action_pending=1 WHERE id='opening'")
      .run();
    await expectPrivateBook();
  });
  await test("already-cancelled unjoined opening recovers from intact original entries without writing", async () => {
    reset({ opening: "voided", closed: true });
    await expectPrivateBook();
  });
  await test("one invited currency never removes or duplicates the person's other currencies", async () => {
    const people = await db.listAllPeopleForSearch("vault", "AFN", { allCurrencies: true });
    assert.deepEqual(
      currencyBalances(people, "AFN").map((row) => [row.currency, row.collect]),
      [
        ["AFN", 120],
        ["USD", 70],
      ],
    );
    const rows = await db.listEntries("person", "AFN", { allCurrencies: true });
    assert.equal(rows.filter((row) => row.id === "usd-private").length, 1);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    assert.equal((await db.listEntriesForExport("vault", "USD"))[0].id, "usd-private");
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "USD"),
      7000,
    );
  });
  await test("repeated unjoined invitations cannot hide or multiply the same original book", async () => {
    reset({ opening: "voided", closed: true });
    store.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,rev,closed_at,linked_at,last_synced_at,history_order,unjoined_invitation)
      VALUES('second-invite','vault','relationship','a','AFN',1,NULL,700,700,'2',1);
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('second-opening','second-invite',1,1,'a','a_to_b',12000,'opening',700,700,'pending');`);
    await expectPrivateBook();
  });
  await test("new pending shared tallies remain separate from the recorded private baseline", async () => {
    store.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('new-shared-claim','invite',2,2,'a','a_to_b',500,'entry',550,550,'pending');`);
    const before = snapshot();
    const person = (await db.getPerson("person", "AFN"))!;
    assert.equal(person.balance, 120);
    assert.equal(person.tab_pending_balance, 5);
    const rows = await db.listEntries("person", "AFN");
    assert.deepEqual(recordTotals(rows), { acknowledged: 0, pending: 5, private: 120 });
    assert.deepEqual(snapshot(), before, "reading does not accept or void the new claim");
  });
  await test("external private corrections retain the unmatched opening claim in either direction", async () => {
    for (const sign of [1, -1]) {
      reset();
      store
        .prepare("UPDATE entries SET amount_afn=80,type=? WHERE id='private-loan'")
        .run(sign === 1 ? "debt" : "payment");
      store
        .prepare("UPDATE tab_entries SET direction=? WHERE id='opening'")
        .run(sign === 1 ? "a_to_b" : "b_to_a");
      const before = snapshot();
      const person = (await db.getPerson("person", "AFN"))!;
      assert.equal(
        person.balance,
        sign * 80,
        "only the surviving private amount remains confirmed",
      );
      assert.equal(
        person.tab_pending_balance,
        sign * 40,
        "the unmatched proposal stays pending rather than disappearing",
      );
      assert.equal(person.tab_pending_count, 1);
      const rows = await db.listEntries("person", "AFN");
      const opening = rows.find((row) => row.id === "opening");
      assert.ok(opening?.tab, "a partial overlap must keep the original opening claim visible");
      assert.equal(opening.amount_afn, 120, "read models preserve the proposal's recorded amount");
      assert.equal(opening.tab.pending_balance_adjustment, -sign * 80);
      assert.deepEqual(recordTotals(rows), {
        acknowledged: 0,
        pending: sign * 40,
        private: sign * 80,
      });
      const journal = await db.listEntriesForExport("vault", "AFN");
      assert.equal(journal.filter((row) => row.id === "opening").length, 1);
      assert.deepEqual(
        recordTotals(journal),
        recordTotals(rows),
        "whole-book export uses the same private overlap adjustment",
      );
      const statement = (await data.buildPersonStatement("person", "en", "AFN", "AFN", 1000))!;
      assert.equal(statement.balance, sign * 80);
      assert.deepEqual(statement.sharedTotals, recordTotals(rows));
      assert.equal(
        await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
        sign * 12000,
      );
      assert.deepEqual(
        snapshot(),
        before,
        "reading cannot recreate the externally corrected private amount",
      );
    }
  });
  await test("deleted private source leaves its full opening claim pending despite zero-net settled history", async () => {
    for (const sign of [1, -1]) {
      reset();
      store
        .prepare("UPDATE entries SET deleted_at=700,type=? WHERE id='private-loan'")
        .run(sign === 1 ? "debt" : "payment");
      store
        .prepare("UPDATE tab_entries SET direction=? WHERE id='opening'")
        .run(sign === 1 ? "a_to_b" : "b_to_a");
      const before = snapshot();
      const person = (await db.getPerson("person", "AFN"))!;
      assert.equal(person.balance, 0);
      assert.equal(person.tab_pending_balance, sign * 120);
      assert.equal(person.tab_pending_count, 1);
      const rows = await db.listEntries("person", "AFN");
      assert.ok(
        !rows.some((row) => row.id === "private-loan"),
        "deleted private money cannot be resurrected as a source",
      );
      const opening = rows.find((row) => row.id === "opening");
      assert.ok(opening?.tab, "zero-net private history cannot hide an unmatched opening");
      assert.equal(Math.abs(opening.tab.pending_balance_adjustment ?? 0), 0);
      assert.deepEqual(recordTotals(rows), { acknowledged: 0, pending: sign * 120, private: 0 });
      const journal = await db.listEntriesForExport("vault", "AFN");
      assert.deepEqual(recordTotals(journal), recordTotals(rows));
      assert.equal(journal.filter((row) => row.id === "opening").length, 1);
      assert.equal(
        (await data.buildPersonStatement("person", "en", "AFN", "AFN", 1000))!.balance,
        0,
      );
      assert.equal(
        await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
        sign * 12000,
      );
      assert.deepEqual(snapshot(), before, "source loss remains source loss after every read");
    }
  });
  await test("private amounts owed in the other direction survive inviting and opening cancellation", async () => {
    store.prepare("UPDATE entries SET type='payment' WHERE id='private-loan'").run();
    store.prepare("UPDATE tab_entries SET direction='b_to_a' WHERE id='opening'").run();
    assert.equal((await db.getPerson("person", "AFN"))!.balance, -120);
    const rows = await db.listEntries("person", "AFN");
    assert.deepEqual(recordTotals(rows), { acknowledged: 0, pending: 0, private: -120 });
    assert.equal(
      (await data.buildPersonStatement("person", "en", "AFN", "AFN", 1000))!.balance,
      -120,
    );
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
      -12000,
    );
    assert.deepEqual(
      (await data.buildVaultReport("vault", "Fixture book", "AFN", "en", 1000)).totals,
      { collect: 0, pay: 120, net: -120 },
    );
    store
      .prepare("UPDATE tab_entries SET voided_by_entry_id='cancelled-opening' WHERE id='opening'")
      .run();
    assert.equal((await db.getPerson("person", "AFN"))!.balance, -120);
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
      -12000,
    );
  });
  await test("an invitation without an opening retains an already settled private chapter", async () => {
    store.prepare("DELETE FROM entries WHERE id='private-loan'").run();
    store.prepare("DELETE FROM tab_entries").run();
    const people = await db.listAllPeople("vault", "AFN");
    assert.equal(people[0].balance, 0);
    assert.equal(people[0].is_settled, 1);
    const statement = (await data.buildPersonStatement("person", "en", "AFN", "AFN", 1000))!;
    assert.equal(statement.balance, 0);
    assert.equal(
      statement.rows.filter((row) => row.kind === "settled" && row.ms === 200).length,
      1,
    );
  });
  await test("credit opening adjustment excludes private rows absent from its exposure", async () => {
    store.prepare("UPDATE entries SET disputed_at=450 WHERE id='private-loan'").run();
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
      12000,
    );
    store
      .prepare("UPDATE tab_entries SET voided_by_entry_id='cancelled-opening' WHERE id='opening'")
      .run();
    assert.equal(await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"), 0);
  });
  await test("an unjoined replacement retains earlier accepted history plus private tallies since that period", async () => {
    reset({ joined: true, opening: "accepted", closed: true });
    store.exec(`INSERT INTO entries VALUES('between-periods','vault','relationship','payment',20,'AFN','Backdated private receipt',300,700,NULL,'{"recorded_at_ms":{"pms":700,"l":0,"did":"fixture"}}',NULL,NULL,NULL,NULL,NULL);
      INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,rev,closed_at,linked_at,last_synced_at,history_order,unjoined_invitation)
      VALUES('second-invite','vault','relationship','a','AFN',1,NULL,800,800,'2',1);
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('second-opening','second-invite',1,1,'a','a_to_b',10000,'opening',800,800,'pending');`);
    const before = snapshot();
    assert.equal((await db.getPerson("person", "AFN"))!.balance, 100);
    const rows = await db.listEntries("person", "AFN");
    assert.deepEqual(
      privateEntries(rows).map((row) => row.id),
      ["between-periods"],
      "a replacement cannot revive originals already carried by an accepted opening",
    );
    assert.equal(
      rows.reduce((sum, row) => sum + balanceContribution(row), 0),
      100,
    );
    assert.equal(recordTotals(rows).pending, 0);
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
      10000,
    );
    store
      .prepare(
        "UPDATE tab_entries SET voided_by_entry_id='later-cancellation' WHERE id='second-opening'",
      )
      .run();
    assert.equal(
      (await db.getPerson("person", "AFN"))!.balance,
      100,
      "withdrawing the replacement cannot discard the private receipt",
    );
    const after = snapshot();
    assert.deepEqual(after[0], before[0], "recovery never rewrites the private receipt");
    assert.deepEqual(after[1], before[1]);
    assert.deepEqual(after[3], before[3]);
  });
  await test("joined pending opening keeps the existing shared review contract", async () => {
    reset({ joined: true });
    const person = (await db.getPerson("person", "AFN"))!;
    assert.equal(person.balance, 0);
    assert.equal(person.tab_pending_balance, 120);
    assert.equal(privateEntries(await db.listEntries("person", "AFN")).length, 0);
    assert.equal(
      (
        store.prepare("SELECT status FROM tab_entries WHERE id='opening'").get() as {
          status: string;
        }
      ).status,
      "pending",
      "reading never accepts another party's claim",
    );
  });
  await test("legacy bound or unknown invitations do not infer private ownership from a missing joined date", async () => {
    for (const unjoined of [0, null] as const) {
      reset({ unjoined });
      const person = (await db.getPerson("person", "AFN"))!;
      assert.equal(person.balance, 0);
      assert.equal(person.tab_pending_balance, 120);
      const rows = await db.listEntries("person", "AFN");
      assert.equal(privateEntries(rows).length, 0);
      assert.equal(recordTotals(rows).pending, 120);
    }
  });
  await test("peer acknowledgements and participation override a stale unused-invitation flag", async () => {
    for (const proof of ["accepted", "disputed", "peer-entry", "joined"] as const) {
      reset();
      if (proof === "accepted" || proof === "disputed")
        store.prepare("UPDATE tab_entries SET status=? WHERE id='opening'").run(proof);
      else if (proof === "joined")
        store.prepare("UPDATE tab_links SET other_joined_at=550 WHERE tab_id='invite'").run();
      else
        store.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
          VALUES('peer-claim','invite',2,2,'b','a_to_b',500,'entry',550,550,'pending');`);
      const before = snapshot();
      assert.equal((await tabDb.getFinancialTabLinkForPerson("person", "AFN"))!.tab_id, "invite");
      const rows = await db.listEntries("person", "AFN");
      assert.equal(
        privateEntries(rows).length,
        0,
        `${proof}: acknowledged shared ownership cannot revive private originals`,
      );
      const person = (await db.getPerson("person", "AFN"))!;
      assert.equal(person.balance, proof === "accepted" ? 120 : 0);
      assert.equal(
        person.tab_pending_balance,
        proof === "joined" ? 120 : proof === "peer-entry" ? 125 : 0,
      );
      const journal = await db.listEntriesForExport("vault", "AFN");
      assert.equal(
        journal.filter((row) => row.kind === "opening").length,
        1,
        "real shared evidence stays in exports",
      );
      assert.deepEqual(snapshot(), before, "read models never accept or cancel peer claims");
    }
  });
  await test("refreshing unknown legacy metadata restores private originals without financial writes", async () => {
    reset({ unjoined: null, closed: true, opening: "voided" });
    store.exec(
      "ALTER TABLE tab_links DROP COLUMN unjoined_invitation; UPDATE tab_links SET rev=9;",
    );
    const before = snapshot();
    await migrateUnjoinedInvitation(sqlite);
    const migrated = (await tabDb.getTabLink("invite"))!;
    assert.equal(
      migrated.unjoined_invitation,
      null,
      "migration does not infer unused status from a missing joined date",
    );
    assert.equal(
      migrated.rev,
      0,
      "closed cached history must be fully refreshed for authoritative status",
    );
    assert.deepEqual(snapshot(), before, "migration touches no financial rows or review evidence");
    assert.equal((await db.getPerson("person", "AFN"))!.balance, 0);
    const current = (await tabDb.getTabLink("invite"))!;
    await tabDb.upsertTabFromWire(current, {
      tab: {
        id: "invite",
        you: "a",
        currency: "AFN",
        rev: 2,
        created_at_ms: 500,
        closed_at_ms: 600,
        closed_by: "a",
        unjoined_invitation: true,
        parties: {
          a: { label: "Owner", joined_at_ms: 500, bound: true, history_order: "1" },
          b: { label: "Customer", joined_at_ms: null, bound: false },
        },
        balance: { a: "0", b: "0" },
        pending_for_you: 0,
      },
      entries: [
        {
          id: "opening",
          seq: 1,
          rev: 1,
          created_by: "a",
          direction: "a_to_b",
          amount: "120",
          kind: "opening",
          note: null,
          occurred_at_ms: 500,
          created_at_ms: 500,
          status: "pending",
          status_at_ms: null,
          dispute_reason: null,
          voids_entry_id: null,
          voided_by_entry_id: "cancellation",
        },
        {
          id: "cancellation",
          seq: 2,
          rev: 2,
          created_by: "a",
          direction: "b_to_a",
          amount: "120",
          kind: "void",
          note: null,
          occurred_at_ms: 650,
          created_at_ms: 650,
          status: "accepted",
          status_at_ms: null,
          dispute_reason: null,
          voids_entry_id: "opening",
          voided_by_entry_id: null,
        },
      ],
      full: true,
    });
    await expectPrivateBook();
    assert.deepEqual(
      snapshot(),
      before,
      "metadata refresh changes no originals, financial rows or review evidence",
    );
  });
  await test("a pending opening without intact private originals remains an unconfirmed shared claim", async () => {
    store.prepare("DELETE FROM entries WHERE currency='AFN'").run();
    const before = snapshot();
    const person = (await db.getPerson("person", "AFN"))!;
    assert.equal(person.balance, 0);
    assert.equal(person.tab_pending_balance, 120);
    assert.equal(person.tab_pending_count, 1);
    const rows = await db.listEntries("person", "AFN");
    assert.equal(privateEntries(rows).length, 0);
    assert.equal(recordTotals(rows).pending, 120);
    assert.deepEqual(snapshot(), before);
  });
  await test("accepted opening replaces the private baseline exactly once, even if joined metadata is absent", async () => {
    reset({ opening: "accepted", closed: true });
    assert.equal((await db.getPerson("person", "AFN"))!.balance, 120);
    const rows = await db.listEntries("person", "AFN");
    assert.equal(privateEntries(rows).length, 0);
    assert.equal(
      rows.reduce((sum, row) => sum + balanceContribution(row), 0),
      120,
    );
    assert.equal((await tabDb.listPreLinkEntries((await tabDb.getTabLink("invite"))!)).length, 3);
    assert.equal(
      await credit.creditBalanceInTx(sqlite as any, "vault", "relationship", "AFN"),
      12000,
    );
  });
  await test("shipped edit guard unlocks only originals of a closed unused invitation", async () => {
    const before = snapshot();
    await assert.rejects(
      db.assertNotTabLinked(sqlite, "private-loan"),
      TabLinkedEntryError,
      "active invitations keep their proposed source locked",
    );
    await db.assertNotTabLinked(sqlite, "usd-private");
    assert.deepEqual(snapshot(), before);
    store.prepare("UPDATE tab_links SET closed_at=600 WHERE tab_id='invite'").run();
    await assert.rejects(
      async () => {
        await db.assertNotTabLinked(sqlite, "private-loan");
        store.prepare("UPDATE entries SET amount_afn=100 WHERE id='private-loan'").run();
      },
      TabLinkedEntryError,
      "a live legacy opening keeps its source locked, preventing an invisible pending difference of 20",
    );
    assert.deepEqual(snapshot(), before, "the refused edit cannot change source money");
    assert.equal((await db.getPerson("person", "AFN"))!.tab_pending_balance, 0);
    store
      .prepare("UPDATE tab_entries SET voided_by_entry_id='withdrawn-opening' WHERE id='opening'")
      .run();
    await db.assertNotTabLinked(sqlite, "private-loan");
    store.exec(`INSERT INTO tab_outbox(id,tab_id,op,payload,created_at)
      VALUES('closing','invite','close','{"withdraw_unjoined_opening":true}',700);`);
    await assert.rejects(
      db.assertNotTabLinked(sqlite, "private-loan"),
      TabLinkedEntryError,
      "a close awaiting the server cannot release private source rows",
    );
    store.prepare("DELETE FROM tab_outbox WHERE id='closing'").run();
    await db.assertNotTabLinked(sqlite, "private-loan");
    await assert.rejects(
      db.assertNotTabLinked(sqlite, "opening"),
      TabLinkedEntryError,
      "shared cache rows remain append-only",
    );
    for (const kind of ["joined", "accepted", "unknown", "bound", "stale-accepted"] as const) {
      reset({
        closed: true,
        joined: kind === "joined",
        opening: kind === "accepted" ? "accepted" : "pending",
        unjoined:
          kind === "unknown"
            ? null
            : kind === "bound"
              ? 0
              : kind === "joined" || kind === "accepted"
                ? 0
                : 1,
      });
      if (kind === "stale-accepted")
        store.prepare("UPDATE tab_entries SET status='accepted' WHERE id='opening'").run();
      const state = snapshot();
      await assert.rejects(
        db.assertNotTabLinked(sqlite, "private-loan"),
        TabLinkedEntryError,
        `${kind}: real or unproven shared ownership remains locked`,
      );
      assert.deepEqual(snapshot(), state, "edit eligibility never changes a financial row");
    }
  });
  await test("shipped edit guard preserves earlier real ownership while releasing private tallies after its cutoff", async () => {
    reset({ joined: true, opening: "accepted", closed: true });
    store.exec(`INSERT INTO entries VALUES('between-periods','vault','relationship','payment',20,'AFN','Backdated private receipt',300,700,NULL,'{"recorded_at_ms":{"pms":700,"l":0,"did":"fixture"}}',NULL,NULL,NULL,NULL,NULL);
      INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,rev,closed_at,linked_at,last_synced_at,history_order,unjoined_invitation)
      VALUES('second-invite','vault','relationship','a','AFN',1,900,800,800,'2',1);
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voided_by_entry_id)
      VALUES('withdrawn-second-opening','second-invite',1,1,'a','a_to_b',10000,'opening',800,800,'pending','second-cancellation');
      INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voids_entry_id)
      VALUES('second-cancellation','second-invite',2,2,'a','b_to_a',10000,'void',900,900,'accepted','withdrawn-second-opening');`);
    const before = snapshot();
    await assert.rejects(db.assertNotTabLinked(sqlite, "private-loan"), TabLinkedEntryError);
    await db.assertNotTabLinked(sqlite, "between-periods");
    assert.deepEqual(snapshot(), before);
  });
  await test("shipped local-settlement guard allows unused invitations and refuses shared participation or live ordinary claims", async () => {
    const linked = () => sqlite.getFirstAsync(settleGuardSql, "relationship", "AFN");
    const before = snapshot();
    assert.equal(
      await linked(),
      null,
      "the copied opening alone does not prevent a private settlement",
    );
    assert.deepEqual(snapshot(), before);
    for (const kind of ["joined", "accepted", "unknown", "ordinary", "peer"] as const) {
      reset({
        closed: true,
        joined: kind === "joined",
        opening: kind === "accepted" ? "accepted" : "pending",
        unjoined: kind === "unknown" ? null : kind === "joined" || kind === "accepted" ? 0 : 1,
      });
      if (kind === "ordinary" || kind === "peer")
        store
          .prepare(
            `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
          VALUES('ordinary-claim','invite',2,2,?,'a_to_b',500,'entry',550,550,'pending')`,
          )
          .run(kind === "peer" ? "b" : "a");
      const state = snapshot();
      assert.deepEqual(
        await linked(),
        { one: 1 },
        `${kind}: local settlement cannot bypass shared history`,
      );
      assert.deepEqual(snapshot(), state);
      if (kind === "ordinary") {
        store
          .prepare(
            "UPDATE tab_entries SET voided_by_entry_id='cancelled-ordinary' WHERE id='ordinary-claim'",
          )
          .run();
        assert.equal(
          await linked(),
          null,
          "a cancelled own ordinary proposal no longer prevents private settlement",
        );
      }
    }
  });
  store.close();
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
void main();
