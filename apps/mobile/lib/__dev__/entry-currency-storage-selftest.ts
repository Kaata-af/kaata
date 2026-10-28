// Actual mutation, signing, role, admission and projection code over SQLite.
// No native storage, network, phone data or production database is accessed.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { fixture, declaration, compile } from "./person-currency-selftest";
import { restoredEntryDateHLCs } from "../entry-date";
import { toMinorUnits } from "../money";
import type { EntryAmendedEvent } from "../events";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function mutations(f: Fixture, finish: "pending" | "refused" | "recorded" = "pending") {
  const mocks: Record<string, unknown> = {
    "./db-tx": f.dbTx,
    "./event-log": f.eventLog,
    "./entry-date": require("../entry-date"),
    "./currency-scope": require("../currency-scope"),
    "./tabs/errors": require("../tabs/errors"),
    "./currency-settings": require("../currency-settings"),
    "./currency": f.currency,
    "./auth": f.auth,
    "./credit-admission": f.creditAdmission,
    "./credit-limits": { finishCreditAdmission: async () => finish },
  };
  return compile(
    `import {getDb,getActiveVaultIdSync,getActiveVaultIdSyncMaybe,getAccountIdSync,getInstallIdSync} from './db-tx';
     import {appendEntryAmended} from './event-log';
     import {entryRecordedAtSql,isValidEntryDate} from './entry-date';
     import {effectiveEntryCurrencySql,requireCurrencyCode} from './currency-scope';
     import {TabLinkedEntryError} from './tabs/errors';
     ${["assertMutationScope", "captureMutationScope", "assertNotTabLinked", "assertNotInSettledChapter", "finishEntryMutationAdmission"].map((name) => declaration("../db", name)).join("\n")}
     ${["SettledChapterError", "EntryEditChangedError", "EntryEditCurrencyDisabledError", "updateEntry"].map((name) => `export ${declaration("../db", name)}`).join("\n")}`,
    (name) => {
      assert.ok(name in mocks, `Unexpected mutation dependency ${name}`);
      return mocks[name];
    },
  ) as Pick<typeof import("../db"), "updateEntry">;
}
const saved = (f: Fixture, id = "old-money") =>
  f.sql.prepare("SELECT * FROM entries WHERE id=?").get(id) as any;
const amendments = (f: Fixture) => f.rows().filter((e) => e.event_type === "entry_amended");
const snapshot = async (f: Fixture, id = "old-money") => ({
  session: await f.auth.captureCurrentSession(),
  vaultId: f.dbTx.getActiveVaultIdSync(),
  original: saved(f, id),
  shouldContinue: () => true,
});
async function using(work: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try {
    await work(f);
  } finally {
    f.sql.close();
  }
}

async function migrationChecks() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE entries(id TEXT PRIMARY KEY,amount_afn REAL,currency TEXT,note TEXT,created_at INTEGER,is_deleted INTEGER);
    INSERT INTO entries VALUES('old',12.34,NULL,'saved note',123,0),('deleted',9.87,'EUR',NULL,456,1);
    ALTER TABLE entries ADD COLUMN vault_id TEXT DEFAULT 'v1';
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,payload_json TEXT,event_sig_b64 TEXT,server_acked_at INTEGER,rejected_at INTEGER);
    INSERT INTO event_log VALUES('signed','{"changes":{"amount_afn":12.34}}','immutable-signature',999,NULL);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
    CREATE TABLE sync_state(vault_id TEXT PRIMARY KEY,last_pulled_server_seq INTEGER,last_push_at INTEGER);
    INSERT INTO sync_state VALUES('v1',77,88),('v2',99,111);`);
  const tx = {
    execAsync: async (q: string) => sql.exec(q),
    runAsync: async (q: string, ...args: any[]) => sql.prepare(q).run(...args),
    getAllAsync: async (q: string) => sql.prepare(q).all(),
    withTransactionAsync: async (work: () => Promise<void>) => {
      sql.exec("BEGIN");
      try {
        await work();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const migration = compile(
    `const MIGRATION_044='044_entry_original_currency';${declaration("../db", "columnExists")};export ${declaration("../db", "runMigration044")}`,
    () => ({}),
  ).runMigration044;
  const beforeRows = sql.prepare("SELECT * FROM entries ORDER BY id").all();
  const beforeEvents = sql.prepare("SELECT * FROM event_log").all();
  const beforeSync = sql.prepare("SELECT * FROM sync_state").all();
  try {
    await migration(tx);
    assert.deepEqual(
      sql
        .prepare(
          "SELECT id,amount_afn,currency,note,created_at,is_deleted,vault_id FROM entries ORDER BY id",
        )
        .all(),
      beforeRows,
    );
    assert.deepEqual(sql.prepare("SELECT original_currency FROM entries").all(), [
      { original_currency: null },
      { original_currency: null },
    ]);
    // A recovered database may already have the additive column without its
    // migration marker. Re-running that step must preserve all saved bytes.
    sql.prepare("DELETE FROM schema_migrations").run();
    await migration(tx);
    assert.equal(
      (sql.prepare("PRAGMA table_info(entries)").all() as any[]).filter(
        (c) => c.name === "original_currency",
      ).length,
      1,
    );
    assert.deepEqual(sql.prepare("SELECT * FROM event_log").all(), beforeEvents);
    assert.deepEqual(sql.prepare("SELECT * FROM sync_state").all(), beforeSync);
    assert.equal((sql.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as any).n, 1);
  } finally {
    sql.close();
  }
}

async function signedCorrectionChecks() {
  await using(async (f) => {
    const db = mutations(f);
    const before = saved(f);
    const eventCount = f.rows().length;
    await db.updateEntry("old-money", 12.34, null, undefined, "USD", await snapshot(f));
    const row = saved(f);
    assert.equal(row.id, before.id);
    assert.equal(row.relationship_id, before.relationship_id);
    assert.equal(row.created_at, before.created_at);
    assert.equal(row.is_deleted, 0);
    assert.equal(row.deleted_at, null);
    assert.equal(row.amount_afn, 12.34, "a correction does not convert the number");
    assert.equal(row.currency, "USD");
    assert.equal(row.original_currency, "AFN");
    assert.equal(f.rows().length, eventCount + 1, "one amendment, without delete/create events");
    const event = f.wire(amendments(f)[0]);
    assert.deepEqual(event.payload, { changes: { amount_afn: 12.34, currency: "USD" } });
    assert.equal(
      f.signature.verifyEventSignature(event, event.event_sig_b64, f.pubkey).valid,
      true,
    );
    assert.equal(
      f.signature.verifyEventSignature(
        { ...event, payload: { changes: { amount_afn: 12.34, currency: "EUR" } } },
        event.event_sig_b64,
        f.pubkey,
      ).valid,
      false,
      "the signature binds the currency",
    );
    await db.updateEntry("old-money", 0.29, "exact cents", undefined, "USD", await snapshot(f));
    assert.equal(toMinorUnits(saved(f).amount_afn), 29);
    assert.deepEqual(JSON.parse(amendments(f)[1].payload_json).changes, {
      amount_afn: 0.29,
      currency: "USD",
      note: "exact cents",
    });
    await db.updateEntry("old-money", 0.29, "exact cents", undefined, "USD", await snapshot(f));
    assert.equal(amendments(f).length, 2, "unchanged save is silent");
  });
  await using(async (f) => {
    // A prior version can leave a null currency; the immutable book unit is
    // still the source unit, even when the book's default is later changed.
    f.sql.exec(
      "UPDATE entries SET currency=NULL; UPDATE vaults SET currency='EUR',default_entry_currency='EUR' WHERE id='v1'; UPDATE vault_settings SET value='[\"EUR\",\"USD\"]' WHERE vault_id='v1' AND key='enabled_currencies'",
    );
    const db = mutations(f);
    await db.updateEntry("old-money", 15.67, "old denomination", undefined, "AFN");
    assert.equal(saved(f).amount_afn, 15.67, "editing an existing disabled unit is allowed");
    assert.equal(
      saved(f).original_currency,
      null,
      "an ordinary amount edit does not freeze or change currency",
    );
    const before = saved(f);
    const count = f.rows().length;
    await assert.rejects(
      db.updateEntry("old-money", 15.67, null, undefined, "GBP"),
      /no longer enabled/,
    );
    assert.deepEqual(saved(f), before);
    assert.equal(f.rows().length, count);
    await db.updateEntry("old-money", 15.67, "old denomination", undefined, "USD");
    assert.equal(saved(f).original_currency, "AFN");
  });
  for (const amount of [NaN, Infinity, -1, 0.001, 0.1 + 0.2, Number.MAX_SAFE_INTEGER])
    await using(async (f) => {
      const before = saved(f),
        count = f.rows().length;
      await assert.rejects(
        mutations(f).updateEntry("old-money", amount, null, undefined, "USD"),
        /Invalid entry amount/,
      );
      assert.deepEqual(saved(f), before);
      assert.equal(f.rows().length, count);
    });
}

async function rollbackAndScopeChecks() {
  await using(async (f) => {
    const before = saved(f),
      events = f.rows(),
      frontier = f.sql.prepare("SELECT * FROM app_meta").all();
    f.failNextSignature();
    await assert.rejects(
      mutations(f).updateEntry("old-money", 23.45, "change", undefined, "USD", await snapshot(f)),
      /injected signing failure/,
    );
    assert.deepEqual(saved(f), before);
    assert.deepEqual(f.rows(), events, "failed signing leaves no event or author sequence slot");
    assert.deepEqual(
      f.sql.prepare("SELECT * FROM app_meta").all(),
      frontier,
      "failed signing leaves no clock change",
    );
  });
  for (const change of [
    "vault",
    "dismiss",
    "newer",
    "delete",
    "settlement",
    "tab",
    "target-settlement",
    "target-tab",
    "disabled",
  ])
    await using(async (f) => {
      const expected = await snapshot(f);
      let proceed = true;
      expected.shouldContinue = () => proceed;
      const count = f.rows().length;
      f.afterSigner(() => {
        f.afterSigner(null);
        if (change === "vault") f.active("v2");
        if (change === "dismiss") proceed = false;
        if (change === "newer")
          f.sql.exec("UPDATE entries SET note='another device',updated_at=11 WHERE id='old-money'");
        if (change === "delete")
          f.sql.exec("UPDATE entries SET is_deleted=1,deleted_at=11 WHERE id='old-money'");
        if (change === "settlement")
          f.sql.exec("INSERT INTO settlements VALUES('s','v1','r1','AFN',100)");
        if (change === "tab")
          f.sql.exec("INSERT INTO tab_links VALUES('t','v1','r1','AFN',NULL,100)");
        if (change === "target-settlement")
          f.sql.exec("INSERT INTO settlements VALUES('s','v1','r1','USD',100)");
        if (change === "target-tab")
          f.sql.exec("INSERT INTO tab_links VALUES('t','v1','r1','USD',NULL,1)");
        if (change === "disabled")
          f.sql.exec(
            "UPDATE vault_settings SET value='[\"AFN\"]' WHERE vault_id='v1' AND key='enabled_currencies'",
          );
      });
      await assert.rejects(
        mutations(f).updateEntry("old-money", 45.67, "mine", undefined, "USD", expected),
        change,
      );
      assert.equal(
        f.rows().length,
        count,
        `${change} before the write lock cannot append a stale edit`,
      );
      assert.equal(saved(f).amount_afn, 12.34, change);
      assert.equal(saved(f).currency, "AFN", change);
    });
  await using(async (f) => {
    const expected = await snapshot(f);
    f.sql.exec("UPDATE entries SET note='already newer',updated_at=12");
    await assert.rejects(
      mutations(f).updateEntry("old-money", 23.45, null, undefined, "USD", expected),
      /Reopen/,
    );
    assert.equal(amendments(f).length, 0);
  });
  await using(async (f) => {
    const expected = await snapshot(f),
      before = saved(f),
      events = f.rows();
    await f.auth.switchSession("other", "another-token");
    await assert.rejects(
      mutations(f).updateEntry("old-money", 23.45, null, undefined, "USD", expected),
      /context changed/,
    );
    assert.deepEqual(saved(f), before);
    assert.deepEqual(f.rows(), events);
  });
  await using(async (f) => {
    const expected = await snapshot(f),
      count = f.rows().length;
    const read = f.tx.getFirstAsync.bind(f.tx);
    f.tx.getFirstAsync = async (query: string, ...args: any[]) => {
      const result = await read(query, ...args);
      if (query.includes("AS recorded_at FROM entries"))
        f.sql.exec("UPDATE entries SET is_deleted=1,deleted_at=11 WHERE id='old-money'");
      return result as any;
    };
    await assert.rejects(
      mutations(f).updateEntry("old-money", 23.45, null, undefined, "USD", expected),
      /Reopen/,
      "a deletion during the append pre-read must not report a successful save",
    );
    assert.equal(f.rows().length, count);
    assert.equal(saved(f).is_deleted, 1);
    assert.equal(saved(f).amount_afn, 12.34);
  });
  for (const role of ["viewer", "clerk", "editor", "manager"] as const)
    await using(async (f) => {
      f.seedRole(role);
      f.sql.exec(
        "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,updated_at,is_deleted,is_settled) VALUES('member-money','v2','r2','debt',12.34,'EUR',10,10,0,0)",
      );
      const call = mutations(f).updateEntry(
        "member-money",
        12.34,
        null,
        undefined,
        "USD",
        await snapshot(f, "member-money"),
      );
      if (role === "viewer" || role === "clerk") {
        await assert.rejects(call, /role/i);
        assert.equal(saved(f, "member-money").currency, "EUR");
      } else {
        await call;
        assert.equal(saved(f, "member-money").currency, "USD");
      }
    });
}

function amendment(
  changes: EntryAmendedEvent["payload"]["changes"],
  pms: number,
  did = "a",
): EntryAmendedEvent {
  return {
    event_id: `${pms}-${did}`,
    event_type: "entry_amended",
    vault_id: "v1",
    target_id: "old-money",
    relationship_id: "r1",
    device_id: did,
    author_user_id_local_only: "",
    actor_account_id: null,
    payload_schema: 1,
    appended_at: pms,
    server_acked_at: null,
    rejected_at: null,
    origin: "remote",
    hlc: { pms, l: 0, did },
    payload: { changes },
  };
}
async function projectionAndRestoreChecks() {
  const cases: EntryAmendedEvent[][] = [
    [
      amendment({ amount_afn: 12.34, currency: "USD" }, 20),
      amendment({ amount_afn: 45.67, currency: "EUR" }, 30),
    ],
    [amendment({ amount_afn: 12.34, currency: "USD" }, 20), amendment({ amount_afn: 45.67 }, 30)],
    [
      amendment({ amount_afn: 12.34, currency: "USD" }, 20, "a"),
      amendment({ amount_afn: 45.67 }, 20, "z"),
    ],
  ];
  for (const events of cases) {
    const results: any[] = [];
    for (const ordered of [events, [...events].reverse()])
      await using(async (f) => {
        for (const event of ordered) await f.entries.applyEntryAmended(f.tx, event);
        const row = saved(f);
        assert.equal(row.original_currency, "AFN");
        assert.equal(row.amount_afn, 45.67);
        assert.equal(
          row.currency,
          events[1].payload.changes.currency ?? "AFN",
          "legacy amount edits retain their original unit",
        );
        results.push(row);
      });
    assert.deepEqual(results[0], results[1], "money registers commute in both delivery orders");
  }
  await using(async (f) => {
    await f.entries.applyEntryAmended(f.tx, amendment({ amount_afn: 23.45, currency: "USD" }, 20));
    const restored = restoredEntryDateHLCs(
      JSON.stringify({
        amount_afn: { pms: 900, l: 0, did: "" },
        note: { pms: 900, l: 0, did: "" },
      }),
      {
        created_at: 10,
        recorded_at_ms: 10,
        amount_hlc: { pms: 20, l: 0, did: "a" },
      },
    );
    f.sql.prepare("UPDATE entries SET field_hlcs=?,updated_at=900,note='newer note'").run(restored);
    await f.entries.applyEntryAmended(f.tx, amendment({ amount_afn: 34.56, currency: "EUR" }, 100));
    assert.equal(
      saved(f).amount_afn,
      34.56,
      "a snapshot's newer note does not suppress a legitimate currency/amount edit",
    );
    assert.equal(saved(f).currency, "EUR");
    assert.equal(saved(f).original_currency, "AFN");
    assert.equal(saved(f).note, "newer note");
    assert.equal(saved(f).updated_at, 900);
    await f.entries.applyEntryAmended(f.tx, amendment({ amount_afn: 56.78 }, 101));
    assert.equal(
      saved(f).currency,
      "AFN",
      "the restored original unit remains the legacy amount-only interpretation",
    );
    const before = saved(f);
    for (const changes of [
      { currency: "USD" },
      { currency: "bad", amount_afn: 2 },
      { currency: "USD", amount_afn: 0.001 },
    ])
      await assert.rejects(
        f.entries.applyEntryAmended(f.tx, amendment(changes as any, 1000)),
        /valid currency and exact amount/,
      );
    assert.deepEqual(saved(f), before);
    f.sql.exec("UPDATE entries SET is_deleted=1,deleted_at=1000");
    const deleted = saved(f);
    await f.entries.applyEntryAmended(
      f.tx,
      amendment({ currency: "USD", amount_afn: 45.67 }, 2000),
    );
    assert.deepEqual(saved(f), deleted, "a correction never resurrects a deleted row");
  });
}

async function creditAdmissionChecks() {
  for (const type of ["debt", "payment"] as const)
    for (const restricted of ["EUR", "USD"])
      await using(async (f) => {
        f.seedRole("editor");
        f.sql
          .prepare(
            "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,updated_at,is_deleted,is_settled) VALUES('member-money','v2','r2',?,12.34,'EUR',10,10,0,0)",
          )
          .run(type);
        f.sql
          .prepare("INSERT INTO customer_credit_limits VALUES('v2','r2',?,'clerk_block',1)")
          .run(restricted);
        const before = saved(f, "member-money");
        await assert.rejects(
          mutations(f).updateEntry(
            "member-money",
            23.45,
            "both money fields",
            undefined,
            "USD",
            await snapshot(f, "member-money"),
          ),
          /credit mutation pending/,
        );
        assert.deepEqual(
          saved(f, "member-money"),
          before,
          `${type} must preserve the whole row under a ${restricted} rule`,
        );
        const event = amendments(f)[0];
        assert.ok(event.event_sig_b64, "the durable intent is signed");
        assert.equal(event.applied_at, null);
        assert.equal(
          (
            f.sql
              .prepare("SELECT status FROM credit_admission_intents WHERE event_id=?")
              .get(event.event_id) as any
          ).status,
          "pending",
        );
        const baseline = f.sql
          .prepare("SELECT row_json FROM credit_mutation_baselines WHERE event_id=?")
          .get(event.event_id) as any;
        assert.deepEqual(JSON.parse(baseline.row_json), before);
        await assert.rejects(
          mutations(f).updateEntry(
            "member-money",
            34.56,
            null,
            undefined,
            "USD",
            await snapshot(f, "member-money"),
          ),
          /credit mutation pending/,
        );
        assert.equal(amendments(f).length, 1, "another edit cannot overwrite an unresolved intent");
        f.sql
          .prepare("UPDATE credit_admission_intents SET status='refused' WHERE event_id=?")
          .run(event.event_id);
        f.sql.exec("DELETE FROM customer_credit_limits");
        assert.equal(
          await f.creditAdmission.requiresCreditAdmission(f.tx, f.wire(event), "editor", "member"),
          true,
          "a refused intent stays deferred after a cached policy is removed",
        );
        assert.deepEqual(
          saved(f, "member-money"),
          before,
          "refusal preserves amount, currency, note and timestamps together",
        );
      });
  await using(async (f) => {
    const db = mutations(f);
    const before = saved(f);
    await db.updateEntry("old-money", 23.45, "optimistic correction", undefined, "USD");
    const event = amendments(f)[0];
    await f.creditAdmission.revertRefusedClerkTally(
      f.tx,
      event.event_id,
      "credit_limit_exceeded",
      1000,
    );
    assert.deepEqual(
      saved(f),
      before,
      "server refusal rebuilds an old snapshot's original complete money row",
    );
  });
}

async function main() {
  await migrationChecks();
  await signedCorrectionChecks();
  console.log("PASS saved tally migration, signed corrections, disabled units and exact amounts");
  await rollbackAndScopeChecks();
  console.log("PASS saved tally signing rollback, stale/session/role and lock guards");
  await projectionAndRestoreChecks();
  console.log("PASS saved tally convergent replay and snapshot amount clocks");
  await creditAdmissionChecks();
  console.log(
    "PASS saved tally currency: additive migration, one signed exact-money correction, disabled saved units, rollback, stale/session/role/lock guards, convergent legacy replay, snapshot clocks and whole-row credit admission/refusal",
  );
}
const watchdog = setTimeout(() => {
  console.error("Saved tally storage self-test did not complete");
  process.exitCode = 1;
}, 30_000);
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
