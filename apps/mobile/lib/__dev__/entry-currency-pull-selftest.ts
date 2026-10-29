// Real pull coordination, baseline validation/SQL and entry projection over a
// synthetic in-memory ledger. No phone data, production requests or app builds.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileUI, deferred, settleUI } from "./ui-fixture";
import type { EntryCurrencyBaseline } from "../entry-currency-baselines";
import type { EntryAmendedEvent } from "../events";
import type { SQLiteTx } from "../db-tx";

const VAULT = "baseline-vault";
const fieldHLCs = compileUI("../projection/field-hlc", {
  "../db": { FIELD_HLC_INIT: { pms: 0, l: 0, did: "" } },
  "../hlc": require("../hlc"),
});
const baselines = compileUI("../entry-currency-baselines", {
  "./currency-scope": require("../currency-scope"),
  "./money": require("../money"),
  "./projection/field-hlc": fieldHLCs,
}) as typeof import("../entry-currency-baselines");
const projection = compileUI("../projection/entries", {
  "./errors": require("../projection/errors"),
  "../entry-date": require("../entry-date"),
  "../hlc": require("../hlc"),
  "../currency-scope": require("../currency-scope"),
  "../money": require("../money"),
  "./field-hlc": fieldHLCs,
}) as typeof import("../projection/entries");

const baseline: EntryCurrencyBaseline = {
  id: "restored",
  amount_afn: 25,
  currency: "USD",
  original_currency: "AFN",
  amount_hlc: { pms: 100, l: 1, did: "money-author" },
  amount_event_id: "accepted-money-event",
};
function page(extra: Record<string, unknown> = {}) {
  return {
    vault_id: VAULT,
    events: [],
    has_more: false,
    next_after_server_seq: 0,
    server_time: "2026-10-28T00:00:00Z",
    ...extra,
  };
}

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE entries (id TEXT PRIMARY KEY,vault_id TEXT,amount_afn REAL,currency TEXT,
      original_currency TEXT,field_hlcs TEXT,is_deleted INTEGER DEFAULT 0,deleted_at INTEGER,
      note TEXT,type TEXT,created_at INTEGER,updated_at INTEGER,current_event_id TEXT);
    CREATE TABLE event_log (event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,
      payload_json TEXT,applied_at INTEGER,server_acked_at INTEGER,rejected_at INTEGER,tombstone_reason TEXT);
    CREATE TABLE vaults (id TEXT PRIMARY KEY,legacy_currency TEXT,currency TEXT,archived_at INTEGER);
    CREATE TABLE app_meta (key TEXT PRIMARY KEY,value TEXT);
  `);
  sql.prepare("INSERT INTO vaults VALUES(?,?,?,NULL)").run(VAULT, "AFN", "AFN");
  const trace: string[] = [],
    requests: { url: URL; headers: Record<string, string> }[] = [];
  const notifications: any[] = [];
  let sessionVersion = 0,
    sessionHeld = false,
    applyHeld = false,
    transaction = false;
  let cursor = 0,
    responseIndex = 0;
  let responses: (Record<string, unknown> | Promise<Record<string, unknown>>)[] = [];
  let sweepWork: (() => Promise<void>) | undefined;
  class SessionChangedError extends Error {}
  const session = () => ({
    accountId: "account",
    jwt: "synthetic-jwt",
    bindingVersion: sessionVersion,
  });
  const requireSession = () => assert.ok(sessionHeld, "local baseline work is session-serialized");
  const applyMutex = {
    runExclusive: async <T>(work: () => Promise<T>) => {
      requireSession();
      assert.equal(applyHeld, false, "apply mutex is never nested");
      applyHeld = true;
      try {
        return await work();
      } finally {
        applyHeld = false;
      }
    },
  };
  const db = {
    getFirstAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).get(...args) ?? null,
    getAllAsync: async (q: string, ...args: unknown[]) => sql.prepare(q).all(...args),
    runAsync: async (q: string, ...args: unknown[]) => {
      requireSession();
      assert.ok(applyHeld && transaction, "financial writes hold the apply mutex and transaction");
      return sql.prepare(q).run(...args);
    },
    withTransactionAsync: async (work: () => Promise<void>) => {
      requireSession();
      assert.ok(applyHeld);
      assert.equal(transaction, false);
      transaction = true;
      sql.exec("BEGIN");
      trace.push("begin");
      try {
        await work();
        sql.exec("COMMIT");
        trace.push("commit");
      } catch (error) {
        sql.exec("ROLLBACK");
        trace.push("rollback");
        throw error;
      } finally {
        transaction = false;
      }
    },
  } as unknown as SQLiteTx;
  const row = (id = "restored") => sql.prepare("SELECT * FROM entries WHERE id=?").get(id) as any;
  const pull = compileUI(
    "../sync/pull",
    {
      "../api": { getBackendUrl: async () => "https://synthetic.invalid" },
      "../person-note-sync": { syncPersonNotesHistory: async () => false },
      "../auth": {
        getSessionJWT: async () => "synthetic-jwt",
        applyForCurrentSession: async (
          snapshot: { bindingVersion: number },
          work: () => Promise<unknown>,
        ) => {
          assert.equal(sessionHeld, false);
          if (snapshot.bindingVersion !== sessionVersion) throw new SessionChangedError();
          sessionHeld = true;
          try {
            return await work();
          } finally {
            sessionHeld = false;
          }
        },
      },
      "../db": { healActiveVaultId: async () => {} },
      "../db-tx": { getDb: async () => db, getAccountIdSync: () => "account" },
      "../currency-sync": require("../currency-sync"),
      "../entry-currency-baselines": {
        ...baselines,
        needsEntryCurrencyBaselines: async (tx: SQLiteTx, vaultId: string) => {
          requireSession();
          assert.ok(applyHeld);
          trace.push("needs");
          return baselines.needsEntryCurrencyBaselines(tx, vaultId);
        },
        applyEntryCurrencyBaselines: async (
          tx: SQLiteTx,
          vaultId: string,
          rows: EntryCurrencyBaseline[],
        ) => {
          requireSession();
          assert.ok(applyHeld && transaction);
          trace.push("baseline");
          return baselines.applyEntryCurrencyBaselines(tx, vaultId, rows);
        },
      },
      "../projection": { applyEventMutex: applyMutex },
      "../ledger-events": {
        emitLedgerApplied: (vaultId: string, origin: string) => {
          requireSession();
          assert.equal(transaction, false);
          assert.equal(applyHeld, false);
          trace.push("notify");
          notifications.push({ vaultId, origin, row: row() });
        },
      },
      "../effective-account": { resolveAccountIdCandidates: async () => ["account"] },
      "../projection/ingest-row": {
        mapPulledWireToEvent: (event: unknown) => event,
        ingestPulledEvents: async (events: { event_id: string }[]) =>
          applyMutex.runExclusive(async () => {
            trace.push("ingest");
            await db.withTransactionAsync(async () => {
              for (const event of events) {
                // Existing local duplicates gain their server acknowledgement here,
                // just as the actual durable-ingest boundary does before repair.
                await db.runAsync(
                  "UPDATE event_log SET server_acked_at=1 WHERE event_id=?",
                  event.event_id,
                );
              }
            });
            return events.length;
          }),
      },
      "../projection/sweep": {
        sweepVaultNow: async () => {
          requireSession();
          assert.equal(applyHeld, false);
          assert.equal(transaction, false);
          trace.push("sweep");
          await sweepWork?.();
        },
      },
      "../use-vault-role": { invalidateVaultRoleCache: () => {} },
      "./cursor": {
        getLastPulledServerSeq: async () => cursor,
        setLastPulledServerSeq: async (_vaultId: string, next: number) => {
          requireSession();
          assert.equal(transaction, false);
          trace.push("cursor");
          cursor = next;
        },
      },
      "./errors": require("../sync/errors"),
    },
    {
      __DEV__: false,
      fetch: async (url: string, options: RequestInit) => {
        assert.equal(sessionHeld, false, "requests never hold the session mutex");
        assert.equal(applyHeld, false, "requests never hold the apply mutex");
        requests.push({ url: new URL(url), headers: options.headers as Record<string, string> });
        trace.push("fetch");
        const body = await responses[responseIndex++];
        assert.ok(body, "fixture must provide each response page");
        return { ok: true, status: 200, headers: new Headers(), json: async () => body };
      },
    },
  ) as typeof import("../sync/pull");
  return {
    sql,
    db,
    trace,
    requests,
    notifications,
    row,
    session,
    SessionChangedError,
    applyMutex,
    cursor: () => cursor,
    respond: (...pages: typeof responses) => {
      responses = pages;
      responseIndex = 0;
    },
    setSweep: (work: () => Promise<void>) => {
      sweepWork = work;
    },
    switchSession: () => {
      assert.equal(sessionHeld, false);
      sessionVersion++;
    },
    seed: (clock: unknown = { pms: 900, l: 0, did: "" }, id = "restored") => {
      sql
        .prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,0,NULL,?,?,?,?,?)")
        .run(
          id,
          VAULT,
          12.34,
          "AFN",
          null,
          JSON.stringify({ amount_afn: clock, note: { pms: 900, l: 0, did: "note-author" } }),
          "newer note remains",
          "gave",
          10,
          900,
          "note-event",
        );
    },
    pull: () => pull.pullEvents(VAULT, session()),
  };
}
type Fixture = ReturnType<typeof fixture>;
async function using(work: (f: Fixture) => Promise<void>) {
  const f = fixture();
  try {
    await work(f);
  } finally {
    f.sql.close();
  }
}
const requestsBaselines = (request: Fixture["requests"][number]) =>
  request.url.searchParams.get("entry_currency_baselines");

async function main() {
  await using(async (f) => {
    f.seed({ pms: 100, l: 0, did: "precise-author" });
    f.respond(page());
    await f.pull();
    assert.equal(
      requestsBaselines(f.requests[0]),
      null,
      "ordinary precise rows use the unchanged pull query",
    );
    assert.equal(f.notifications.length, 0);
  });

  await using(async (f) => {
    f.seed();
    f.sql
      .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,1,NULL,NULL,NULL)")
      .run("local-money", "entry_amended", VAULT, "restored", '{"changes":{"amount_afn":25}}');
    f.respond(
      page({
        events: [{ event_id: "local-money" }],
        entry_currency_baselines: [baseline],
        has_more: true,
        next_after_server_seq: 1,
      }),
      page({ next_after_server_seq: 2 }),
    );
    assert.deepEqual(await f.pull(), { pulled: 1 });
    assert.deepEqual(
      f.requests.map(requestsBaselines),
      ["1", null],
      "one defined baseline response per drain",
    );
    assert.equal(f.requests[0].headers["X-Kaata-Entry-Currency-Edit"], "1");
    assert.equal(f.trace.filter((step) => step === "needs").length, 1);
    assert.ok(
      f.trace.indexOf("ingest") < f.trace.indexOf("baseline"),
      "ingest acknowledges local events first",
    );
    assert.ok(f.trace.indexOf("baseline") < f.trace.indexOf("cursor"));
    assert.ok(f.trace.indexOf("cursor") < f.trace.indexOf("sweep"));
    assert.equal(f.row().amount_afn, 25);
    assert.equal(f.row().currency, "USD");
    assert.equal(f.row().note, "newer note remains");
    assert.equal(f.row().current_event_id, "note-event", "newer note activity stays authoritative");
    assert.equal(f.notifications.length, 1);
    assert.equal(
      f.notifications[0].row.currency,
      "USD",
      "UI refresh observes committed corrected money",
    );
    assert.equal(f.notifications[0].origin, "remote");
    f.respond(page());
    await f.pull();
    assert.equal(
      requestsBaselines(f.requests.at(-1)!),
      null,
      "repaired money no longer requests baselines",
    );
  });

  await using(async (f) => {
    f.seed();
    f.respond(page({ entry_currency_baselines: [], has_more: true }), page());
    await f.pull();
    assert.deepEqual(
      f.requests.map(requestsBaselines),
      ["1", null],
      "an explicit empty response is complete for this drain",
    );
    assert.equal(f.notifications.length, 0);
    f.respond(page());
    await f.pull();
    assert.equal(
      requestsBaselines(f.requests.at(-1)!),
      "1",
      "an unrepaired placeholder retries next drain",
    );
  });

  await using(async (f) => {
    f.seed();
    f.respond(page({ entry_currency_baselines: [baseline] }));
    const correction = {
      event_id: "quarantined-correction",
      target_id: "restored",
      vault_id: VAULT,
      hlc: { pms: 150, l: 0, did: "offline-author" },
      origin: "remote",
      payload: { changes: { amount_afn: 30, currency: "EUR" } },
    } as EntryAmendedEvent;
    await assert.rejects(
      projection.applyEntryAmended(f.db, correction),
      /precise amount baseline required/,
    );
    f.setSweep(() =>
      f.applyMutex.runExclusive(() =>
        f.db.withTransactionAsync(async () => {
          await projection.applyEntryAmended(f.db, correction);
        }),
      ),
    );
    assert.deepEqual(await f.pull(), { pulled: 0 });
    assert.ok(
      f.trace.includes("sweep"),
      "a repair sweeps previous quarantine even with an empty event page",
    );
    assert.equal(f.row().amount_afn, 30);
    assert.equal(f.row().currency, "EUR");
    assert.equal(f.row().note, "newer note remains");
  });

  await using(async (f) => {
    f.seed();
    f.sql
      .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,1,NULL,NULL,NULL)")
      .run(
        "unpublished",
        "entry_amended",
        VAULT,
        "restored",
        '{"changes":{"currency":"EUR","amount_afn":50}}',
      );
    f.respond(page({ entry_currency_baselines: [baseline], has_more: true }), page());
    await f.pull();
    assert.equal(f.row().amount_afn, 12.34, "unacknowledged local money stays intact");
    assert.equal(f.notifications.length, 0, "no notification for a blocked/no-op repair");
    assert.equal(f.trace.includes("sweep"), false);
    assert.deepEqual(f.requests.map(requestsBaselines), ["1", null]);
    f.respond(page({ entry_currency_baselines: [baseline] }));
    await f.pull();
    assert.equal(
      requestsBaselines(f.requests.at(-1)!),
      "1",
      "blocked rows retry during the next pull drain",
    );
  });

  await using(async (f) => {
    f.seed();
    f.respond(page({ events: [{ event_id: "ordinary" }], next_after_server_seq: 3 }));
    const before = f.row();
    assert.deepEqual(await f.pull(), { pulled: 1 });
    assert.equal(f.cursor(), 3);
    assert.deepEqual(
      f.row(),
      before,
      "an old server omitting optional metadata keeps ordinary pulls working",
    );
    assert.ok(f.trace.includes("ingest") && f.trace.includes("sweep"));
    f.respond(page());
    await f.pull();
    assert.equal(
      requestsBaselines(f.requests.at(-1)!),
      "1",
      "old servers retry metadata in a later drain",
    );
  });

  await using(async (f) => {
    f.seed();
    const response = deferred<Record<string, unknown>>();
    f.respond(response.promise);
    const before = f.row(),
      work = f.pull();
    for (let pass = 0; pass < 10 && !f.requests.length; pass++) await settleUI();
    assert.equal(f.requests.length, 1);
    f.switchSession();
    response.resolve(
      page({
        events: [{ event_id: "late" }],
        entry_currency_baselines: [baseline],
        next_after_server_seq: 9,
      }),
    );
    await assert.rejects(work, f.SessionChangedError);
    assert.deepEqual(f.row(), before);
    assert.equal(f.cursor(), 0);
    assert.equal(
      f.notifications.length,
      0,
      "late financial responses never refresh a different session's UI",
    );
    assert.equal(f.trace.includes("ingest"), false);
  });

  for (const invalid of [
    { vault_id: "another-vault", entry_currency_baselines: [baseline] },
    { entry_currency_baselines: null },
    { entry_currency_baselines: [baseline, { ...baseline, id: "second", amount_afn: 1.001 }] },
    { entry_currency_baselines: [{ ...baseline, vault_id: "another-vault" }] },
    { entry_currency_baselines: [{ ...baseline, amount_hlc: { pms: 0, l: 0, did: "" } }] },
  ]) {
    await using(async (f) => {
      f.seed();
      const before = f.row();
      f.respond(
        page({ events: [{ event_id: "must-not-ack" }], next_after_server_seq: 9, ...invalid }),
      );
      await assert.rejects(f.pull(), /baseline|money|minor|amount/i);
      assert.deepEqual(f.row(), before);
      assert.equal(f.cursor(), 0);
      assert.equal(
        f.trace.includes("ingest"),
        false,
        "malformed metadata is rejected before durable ingestion",
      );
      assert.equal(f.notifications.length, 0);
    });
  }
  console.log(
    "PASS: pull currency baseline repair, pagination, committed UI refresh, stale-session and malformed-response guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
