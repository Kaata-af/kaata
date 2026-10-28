// Production aggregation against an in-memory SQLite ledger; no user DB access.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as money from "../money";
import { compileUI } from "./ui-fixture";
import { applyCurrencyMigration } from "./currency-fixture";

const sql = new Database(":memory:");
sql.exec(`
  CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE vaults(id TEXT PRIMARY KEY, currency TEXT NOT NULL);
  INSERT INTO vaults(id,currency) VALUES('book','AFN'),('other-book','AFN');
  CREATE TABLE vault_settings(vault_id TEXT, key TEXT, value TEXT);
  CREATE TABLE users(id TEXT PRIMARY KEY, display_name TEXT, phone_e164 TEXT, created_at INTEGER);
  CREATE TABLE relationships(id TEXT PRIMARY KEY, vault_id TEXT, user_b_id TEXT, archived_at INTEGER);
  CREATE INDEX relationships_vault ON relationships(vault_id);
  CREATE TABLE entries(id TEXT PRIMARY KEY, relationship_id TEXT, vault_id TEXT, type TEXT, amount_afn REAL, created_at INTEGER, deleted_at INTEGER,
    field_hlcs TEXT NOT NULL DEFAULT '{}');
  CREATE INDEX entries_relationship ON entries(relationship_id, created_at);
  CREATE TABLE settlements(vault_id TEXT, relationship_id TEXT, settled_at_ms INTEGER);
  CREATE TABLE customer_credit_limits(vault_id TEXT,relationship_id TEXT,max_collect_minor INTEGER,
    max_pay_minor INTEGER,mode TEXT,sync_pending INTEGER,updated_at_ms INTEGER,restrict_editors INTEGER);
  CREATE TABLE kaata_credit_defaults(vault_id TEXT,max_collect_minor INTEGER,max_pay_minor INTEGER,
    mode TEXT,updated_at_ms INTEGER,restrict_editors INTEGER);
  CREATE TABLE tab_links(tab_id TEXT PRIMARY KEY, vault_id TEXT, relationship_id TEXT, role TEXT, linked_at INTEGER, closed_at INTEGER, last_synced_at INTEGER,
    other_account_name TEXT DEFAULT '', other_joined_at INTEGER, history_order TEXT, currency TEXT DEFAULT 'AFN', unjoined_invitation INTEGER);
  CREATE INDEX tab_links_relationship ON tab_links(relationship_id);
  CREATE INDEX tab_links_vault ON tab_links(vault_id);
  CREATE INDEX tab_links_scope_order ON tab_links(vault_id,relationship_id,history_order);
  CREATE TABLE tab_entries(id TEXT PRIMARY KEY, tab_id TEXT, direction TEXT, amount_minor INTEGER, kind TEXT, status TEXT, voided_by_entry_id TEXT,
    created_by TEXT DEFAULT 'a', occurred_at INTEGER DEFAULT 100, created_at INTEGER DEFAULT 100,
    seq INTEGER DEFAULT 1, local_pending INTEGER DEFAULT 0, local_action_pending INTEGER DEFAULT 0);
  CREATE INDEX tab_entries_tab ON tab_entries(tab_id);
  CREATE TABLE tab_settlements(tab_id TEXT, through_seq INTEGER);
  CREATE TABLE tab_outbox(tab_id TEXT, op TEXT);
`);
let dbReads = 0;
const { summarizeSelectionEntries, summarizeSelectedPeople } = compileUI("../selection-summary", {
  "./money": money,
  "./currency-totals": require("../currency-totals"),
}) as typeof import("../selection-summary");
// Exercise the real list query, result mapping and pure selection aggregation.
// Unrelated native/write dependencies are unavailable, so a selection that
// regresses to opening storage or starting asynchronous work fails this test.
const { listAllPeopleForSearch, getPerson } = compileUI("../db", {
  "expo-crypto": {},
  "expo-sqlite": {},
  "./db-tx": {
    getActiveVaultIdSyncMaybe: () => "book",
    getDb: async () => ({
      getAllAsync: async (query: string, ...params: unknown[]) => {
        dbReads++;
        return sql.prepare(query).all(...params);
      },
      getFirstAsync: async (query: string, ...params: unknown[]) => {
        dbReads++;
        return sql.prepare(query).get(...params) ?? null;
      },
    }),
  },
  "./event-log": {},
  "./vault-initial-currencies": {},
  "./checkin-trigger": {},
  "./db-health": {},
  "./db-backup": {},
  "./trust/account-id": {},
  "./effective-account": {},
  "./phone": {},
  "./contacts-sync": {},
  "./uuid-v5": {},
  "./hlc": {},
  "./group-memberships": {},
  "./money-sql": require("../money-sql"),
  "./entry-date": require("../entry-date"),
  "./currency-scope": require("../currency-scope"),
  "./tabs/db": {},
  "./tabs/direction": require("../tabs/direction"),
  "./tabs/history": require("../tabs/history"),
  "./tabs/errors": {},
}) as typeof import("../db");
let peopleSnapshot: import("../types").PersonWithBalance[] = [];
async function reload(vault = "book") {
  const before = dbReads;
  peopleSnapshot = await listAllPeopleForSearch(vault);
  assert.equal(dbReads - before, vault ? 1 : 0, "list and totals share one SQL snapshot");
  for (const row of peopleSnapshot) {
    assert.ok(row.selection_totals, "every list contact has preloaded totals");
    if (!row.tab_unsynced) {
      assert.equal(
        money.toMinorUnits(row.balance),
        row.selection_totals.debtMinor - row.selection_totals.creditMinor,
        "selection and displayed balances come from identical live records",
      );
    }
  }
}
function selected(ids: readonly string[]) {
  const byId = new Map(peopleSnapshot.map((row) => [row.id, row]));
  const before = dbReads;
  const result = summarizeSelectedPeople(
    ids.map((id) => byId.get(id) ?? ({ id } as import("../types").PersonWithBalance)),
  );
  assert.equal(dbReads, before, "changing selection never reads SQLite");
  return result;
}

const empty = {
  debtCount: 0,
  creditCount: 0,
  debt: 0,
  credit: 0,
  collect: 0,
  pay: 0,
  net: 0,
  pending: false,
};
function person(personId: string, vault = "book", archived: number | null = null) {
  const relationship = `${vault}-${personId}`;
  sql.prepare("INSERT OR IGNORE INTO users VALUES(?,?,NULL,1)").run(personId, personId);
  sql
    .prepare("INSERT INTO relationships VALUES(?,?,?,?)")
    .run(relationship, vault, personId, archived);
  return relationship;
}
function local(
  id: string,
  relationship: string,
  type: "debt" | "payment",
  amount: number,
  options: { at?: number; deleted?: number; vault?: string } = {},
) {
  sql
    .prepare(
      "INSERT INTO entries(id,relationship_id,vault_id,type,amount_afn,created_at,deleted_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      relationship,
      options.vault ?? "book",
      type,
      amount,
      options.at ?? 1,
      options.deleted ?? null,
    );
}
function tab(
  id: string,
  relationship: string,
  options: {
    role?: "a" | "b";
    linkedAt?: number;
    closedAt?: number;
    unsynced?: boolean;
    vault?: string;
  } = {},
) {
  sql
    .prepare(
      "INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,linked_at,closed_at,last_synced_at,history_order) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      options.vault ?? "book",
      relationship,
      options.role ?? "a",
      options.linkedAt ?? 100,
      options.closedAt ?? null,
      options.unsynced ? null : 101,
      String((sql.prepare("SELECT COUNT(*) AS n FROM tab_links").get() as { n: number }).n + 1),
    );
}
function shared(
  id: string,
  tabId: string,
  direction: "a_to_b" | "b_to_a",
  minor: number,
  options: { kind?: string; status?: string; voidedBy?: string } = {},
) {
  sql
    .prepare(
      "INSERT INTO tab_entries(id,tab_id,direction,amount_minor,kind,status,voided_by_entry_id) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      tabId,
      direction,
      minor,
      options.kind ?? "entry",
      options.status ?? "accepted",
      options.voidedBy ?? null,
    );
}

async function main() {
  await applyCurrencyMigration(sql);
  assert.deepEqual(summarizeSelectionEntries([]), empty);
  assert.deepEqual(selected([]), empty);
  assert.equal(dbReads, 0, "empty selections do not open SQLite");
  await reload("");
  assert.equal(peopleSnapshot.length, 0);
  assert.equal(dbReads, 0, "an unbound vault cannot read another book");

  assert.deepEqual(
    summarizeSelectionEntries([
      { amount: 0.1, direction: "collect" },
      { amount: 0.2, direction: "collect" },
      { amount: 0.3, direction: "pay" },
    ]),
    { ...empty, debtCount: 2, creditCount: 1, debt: 0.3, credit: 0.3 },
    "fractional totals cancel exactly",
  );
  assert.deepEqual(summarizeSelectionEntries([{ amount: 1.29, direction: "pay" }]), {
    ...empty,
    creditCount: 1,
    credit: 1.29,
    pay: 1.29,
    net: -1.29,
  });
  assert.throws(
    () => summarizeSelectionEntries([{ amount: -1, direction: "collect" }]),
    /unsigned/,
  );
  assert.throws(
    () => summarizeSelectionEntries([{ amount: 0.001, direction: "collect" }]),
    /two decimal/,
  );
  assert.deepEqual(
    summarizeSelectionEntries([
      { amount: 50_000_000_000_000, direction: "collect" },
      { amount: 50_000_000_000_000, direction: "pay" },
    ]),
    {
      ...empty,
      debtCount: 1,
      creditCount: 1,
      debt: 50_000_000_000_000,
      credit: 50_000_000_000_000,
    },
    "separate directional totals do not calculate an unused combined gross amount",
  );
  assert.throws(
    () =>
      summarizeSelectionEntries([
        { amount: 50_000_000_000_000, direction: "collect" },
        { amount: 50_000_000_000_000, direction: "collect" },
      ]),
    /safe cents/,
    "each directional total still protects exact cents",
  );

  const alice = person("alice");
  const bob = person("bob");
  const settled = person("settled");
  person("empty");
  const archived = person("archived", "book", 99);
  local("a-debt", alice, "debt", 100.29);
  local("a-receipt", alice, "payment", 20.19);
  local("a-deleted", alice, "debt", 1000, { deleted: 5 });
  local("a-corrupt-vault", alice, "debt", 5000, { vault: "other-book" });
  local("b-debt", bob, "debt", 10);
  local("b-receipt", bob, "payment", 60.1);
  local("s-debt", settled, "debt", 5.25);
  local("s-receipt", settled, "payment", 5.25);
  local("archived-record", archived, "debt", 9000);
  const otherAlice = person("alice", "other-book");
  local("other-book-alice", otherAlice, "debt", 1234, { vault: "other-book" });
  // A mismatched cached link cannot move this book's local amounts into a
  // different vault's shared history, even when its relationship id matches.
  tab("wrong-vault-alice", alice, { vault: "other-book" });
  shared("wrong-vault-amount", "wrong-vault-alice", "a_to_b", 999999);

  sql
    .prepare(
      "INSERT INTO settlements(vault_id,relationship_id,settled_at_ms,currency) VALUES('book',?,?,'AFN')",
    )
    .run(settled, 10);
  await reload();
  assert.equal(peopleSnapshot.find((row) => row.id === "settled")?.is_settled, 1);
  assert.equal(
    peopleSnapshot.some((row) => row.id === "archived"),
    false,
  );
  const singlePerson = await getPerson("alice");
  assert.equal(singlePerson?.selection_totals, undefined, "single-person read remains compatible");

  assert.deepEqual(selected(["alice", "bob", "settled", "empty"]), {
    debtCount: 3,
    creditCount: 3,
    debt: 115.54,
    credit: 85.54,
    collect: 80.1,
    pay: 50.1,
    net: 30,
    pending: false,
  });
  assert.deepEqual(selected(["alice", "alice"]), {
    debtCount: 1,
    creditCount: 1,
    debt: 100.29,
    credit: 20.19,
    collect: 80.1,
    pay: 0,
    net: 80.1,
    pending: false,
  });
  assert.deepEqual(selected(["settled"]), {
    ...empty,
    debtCount: 1,
    creditCount: 1,
    debt: 5.25,
    credit: 5.25,
  });
  for (const id of ["missing", "archived"]) {
    assert.deepEqual(selected([id]), { ...empty, pending: true });
  }
  assert.throws(
    () =>
      summarizeSelectedPeople([
        {
          ...singlePerson!,
          selection_totals: {
            debtCount: 1,
            creditCount: 0,
            debtMinor: Number.MAX_SAFE_INTEGER + 1,
            creditMinor: 0,
          },
        },
      ]),
    /safe cents/,
    "preloaded totals retain overflow protection",
  );

  const linked = person("linked");
  local("prelink-debt", linked, "debt", 1000, { at: 5 });
  local("prelink-payment", linked, "payment", 500, { at: 6 });
  local("boundary", linked, "debt", 9000, { at: 100 });
  local("postlink-debt", linked, "debt", 0.29, { at: 101 });
  tab("old-closed", linked, { linkedAt: 20, closedAt: 30 });
  shared("old-closed-debt", "old-closed", "a_to_b", 80000);
  // The active link wins even if another older period has a newer timestamp.
  tab("newer-closed", linked, { linkedAt: 200, closedAt: 250 });
  shared("newer-closed-debt", "newer-closed", "a_to_b", 70000);
  tab("active", linked);
  shared("opening", "active", "a_to_b", 50000, { kind: "opening" });
  shared("receipt", "active", "b_to_a", 20000);
  shared("pending-debt", "active", "a_to_b", 1000, { status: "pending" });
  shared("rejected-debt", "active", "a_to_b", 100000, { status: "disputed" });
  shared("cancelled-debt", "active", "a_to_b", 100000, { voidedBy: "void-row" });
  shared("void-row", "active", "b_to_a", 100000, { kind: "void" });
  await reload();
  assert.deepEqual(selected(["linked"]), {
    debtCount: 2,
    creditCount: 1,
    debt: 500.29,
    credit: 200,
    collect: 300.29,
    pay: 0,
    net: 300.29,
    pending: false,
  });

  const closed = person("closed");
  tab("closed-tab", closed, { role: "b", closedAt: 150 });
  shared("closed-opening", "closed-tab", "a_to_b", 5000, { kind: "opening" });
  shared("closed-repayment", "closed-tab", "b_to_a", 1500);
  local("after-close", closed, "debt", 10, { at: 151 });
  await reload();
  assert.deepEqual(selected(["closed"]), {
    debtCount: 2,
    creditCount: 1,
    debt: 25,
    credit: 50,
    collect: 0,
    pay: 25,
    net: -25,
    pending: false,
  });
  const sharedSettled = person("shared-settled");
  tab("shared-settled-tab", sharedSettled);
  shared("shared-settled-opening", "shared-settled-tab", "a_to_b", 1000, {
    kind: "opening",
  });
  shared("shared-settled-credit", "shared-settled-tab", "b_to_a", 1000);
  sql.prepare("INSERT INTO tab_settlements VALUES(?,?)").run("shared-settled-tab", 1);
  await reload();
  assert.equal(peopleSnapshot.find((row) => row.id === "shared-settled")?.is_settled, 1);
  assert.deepEqual(selected(["shared-settled"]), {
    ...empty,
    debtCount: 1,
    creditCount: 1,
    debt: 10,
    credit: 10,
  });
  const restored = person("restored");
  tab("restored-tab", restored, { unsynced: true });
  local("stale-after-link", restored, "debt", 999, { at: 120 });
  await reload();
  assert.deepEqual(selected(["restored"]), {
    ...empty,
    pending: true,
  });
  assert.equal(selected(["restored", "alice"]).pending, true);

  // A new ordinary refresh replaces values together, without a later totals
  // query racing behind it. Keep a previous snapshot to prove it is immutable.
  const beforeEdit = peopleSnapshot;
  const aliceBefore = selected(["alice"]);
  local("new-a-debt", alice, "debt", 9.9, { at: 300 });
  assert.deepEqual(selected(["alice"]), aliceBefore);
  await reload();
  assert.equal(selected(["alice"]).debt, 110.19);
  assert.equal(
    summarizeSelectedPeople(beforeEdit.filter((row) => row.id === "alice")).debt,
    100.29,
  );
  await reload("other-book");
  assert.equal(selected(["alice"]).debt, 1234);

  // Thousands of rows exceed the bind limit of a per-selection IN query.
  const many = Array.from({ length: 5000 }, (_, i) => `many-${i}`);
  sql.transaction(() => {
    for (const id of many) {
      const rel = person(id);
      local(`${id}-debt`, rel, "debt", 0.29);
      local(`${id}-credit`, rel, "payment", 0.19);
    }
  })();
  await reload();
  const readsBefore = dbReads;
  const manyRows = peopleSnapshot.filter((row) => row.id.startsWith("many-"));
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(summarizeSelectedPeople(manyRows), {
      ...empty,
      debtCount: 5000,
      creditCount: 5000,
      debt: 1450,
      credit: 950,
      collect: 500,
      net: 500,
    });
  }
  const elapsed = performance.now() - start;
  assert.equal(dbReads, readsBefore, "large selection changes use zero further storage reads");
  console.log(`5000-contact pure summary: ${(elapsed / 100).toFixed(2)} ms/run on test host`);

  // Exercise the real correlated people SQL with substantial shared history,
  // not just the in-memory selection reducer above.
  sql.transaction(() => {
    for (let i = 0; i < 500; i++) {
      const rel = person(`shared-many-${i}`);
      const tabId = `shared-many-tab-${i}`;
      tab(tabId, rel);
      for (let j = 0; j < 20; j++) shared(`${tabId}-${j}`, tabId, j % 2 ? "b_to_a" : "a_to_b", 100);
    }
  })();
  const sharedQueryStarted = performance.now();
  await reload();
  console.log(
    `People SQL with 5000 private contacts + 500 shared books/10000 shared rows: ${(performance.now() - sharedQueryStarted).toFixed(0)} ms on test host`,
  );

  sql.close();
  console.log(
    "selection-summary selftest passed (exact money, mixed balances, shared history, vault scope)",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
