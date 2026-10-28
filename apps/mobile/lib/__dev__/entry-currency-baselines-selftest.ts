// Precision recovery uses the actual baseline helper and projection over SQLite.
// All native/session edges stay inside the isolated signed storage fixture.
import assert from "node:assert/strict";
import { fixture } from "./person-currency-selftest";
import { compileUI } from "./ui-fixture";
import type { EntryCurrencyBaseline } from "../entry-currency-baselines";

async function main() {
  const f = await fixture();
  const fields = compileUI("../projection/field-hlc", {
    "../db": { FIELD_HLC_INIT: { pms: 0, l: 0, did: "init" } },
    "../hlc": require("../hlc"),
  });
  const baselines = compileUI("../entry-currency-baselines", {
    "./currency-scope": require("../currency-scope"),
    "./money": require("../money"),
    "./projection/field-hlc": fields,
  }) as typeof import("../entry-currency-baselines");
  const row = (id: string) => f.sql.prepare("SELECT * FROM entries WHERE id=?").get(id) as any;
  const synthetic = {
    amount_afn: { pms: 900, l: 0, did: "" },
    note: { pms: 900, l: 3, did: "note-device" },
    type: { pms: 20, l: 0, did: "type-device" },
    occurred_at_ms: { pms: 30, l: 0, did: "date-device" },
    recorded_at_ms: { pms: 10, l: 0, did: "" },
  };
  const seed = (id: string, overrides: Record<string, unknown> = {}) => {
    const values = {
      ...row("old-money"),
      id,
      amount_afn: 12.34,
      currency: "AFN",
      original_currency: null,
      note: "keep independent note",
      created_at: 30,
      updated_at: 900,
      current_event_id: "latest-note",
      field_hlcs: JSON.stringify(synthetic),
      is_deleted: 0,
      deleted_at: null,
      ...overrides,
    };
    const names = Object.keys(values);
    f.sql
      .prepare(
        `INSERT OR REPLACE INTO entries(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      )
      .run(...Object.values(values));
  };
  const money = (
    id: string,
    extra: Partial<EntryCurrencyBaseline> = {},
  ): EntryCurrencyBaseline => ({
    id,
    amount_afn: 23.45,
    currency: "USD",
    original_currency: "AFN",
    amount_hlc: { pms: 100, l: 1, did: "server-device" },
    amount_event_id: "accepted-money",
    ...extra,
  });
  const repair = async (rows: EntryCurrencyBaseline[]) => {
    let n = 0;
    await f.projection.applyEventMutex.runExclusive(() =>
      f.tx.withTransactionAsync(async () => {
        n = await baselines.applyEntryCurrencyBaselines(f.tx, "v1", rows);
      }),
    );
    return n;
  };
  const addEvent = (
    id: string,
    eventId: string,
    changes: any,
    overrides: Record<string, unknown> = {},
  ) => {
    const values = {
      event_id: eventId,
      event_type: "entry_amended",
      vault_id: "v1",
      target_id: id,
      relationship_id: "r1",
      author_user_id_local_only: "self",
      payload_json: JSON.stringify({ changes }),
      applied_at: 1000,
      server_acked_at: null,
      rejected_at: null,
      tombstone_reason: null,
      ...overrides,
    };
    const names = Object.keys(values);
    f.sql
      .prepare(
        `INSERT INTO event_log(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      )
      .run(...Object.values(values));
  };
  try {
    assert.equal(
      await baselines.needsEntryCurrencyBaselines(f.tx, "v1"),
      true,
      "missing amount clocks also need precision recovery",
    );
    await f.eventLog.appendEntryAmended({
      entryId: "old-money",
      changes: { note: "a real signed note" },
    });
    const signedHistory = f.rows();
    seed("repair");
    const before = row("repair");
    assert.equal(await repair([money("repair")]), 1);
    const after = row("repair");
    assert.equal(after.amount_afn, 23.45, "server currency corrections repair the number too");
    assert.equal(after.currency, "USD");
    assert.equal(after.original_currency, "AFN");
    const expectedFields = { ...synthetic, amount_afn: money("repair").amount_hlc };
    assert.deepEqual(JSON.parse(after.field_hlcs), expectedFields);
    for (const key of Object.keys(before).filter(
      (key) => !["amount_afn", "currency", "original_currency", "field_hlcs"].includes(key),
    ))
      assert.deepEqual(after[key], before[key], `repair preserves ${key}`);
    assert.deepEqual(f.rows(), signedHistory, "repair never rewrites signed history");
    assert.equal(
      await repair([money("repair", { amount_afn: 99.99 })]),
      0,
      "precise registers are never replaced, including repeat responses",
    );

    seed("zero");
    assert.equal(await repair([money("zero", { amount_afn: 0, original_currency: null })]), 1);
    assert.equal(row("zero").amount_afn, 0, "lawful legacy zero is not rejected or rescaled");
    seed("newer-money");
    await repair([money("newer-money", { amount_hlc: { pms: 1000, l: 0, did: "server-device" } })]);
    assert.equal(row("newer-money").updated_at, 1000);
    assert.equal(
      row("newer-money").current_event_id,
      "accepted-money",
      "a newer monetary event supplies the activity pointer",
    );
    seed("same-time");
    await repair([money("same-time", { amount_hlc: { pms: 900, l: 50, did: "server-device" } })]);
    assert.equal(
      row("same-time").current_event_id,
      "latest-note",
      "equal physical time preserves independent local activity",
    );
    seed("preserve-original", { original_currency: "AFN" });
    await repair([money("preserve-original", { original_currency: undefined })]);
    assert.equal(
      row("preserve-original").original_currency,
      "AFN",
      "an omitted original unit never clears a frozen one",
    );

    for (const [id, changes, event] of [
      ["local-create", {}, { event_type: "entry_created" }],
      ["local-amount", { amount_afn: 34.56 }, {}],
      ["local-type", { type: "payment" }, {}],
      ["mesh-currency", { amount_afn: 34.56, currency: "EUR" }, { origin: "remote" }],
    ] as const) {
      seed(id);
      addEvent(id, `${id}-event`, changes, event);
      const held = row(id);
      assert.equal(
        await repair([money(id)]),
        0,
        "unpublished recorded money must be acknowledged first",
      );
      assert.deepEqual(row(id), held);
      f.sql
        .prepare("UPDATE event_log SET server_acked_at=2000 WHERE event_id=?")
        .run(`${id}-event`);
      assert.equal(
        await repair([money(id)]),
        1,
        "acknowledgement permits the next precision-recovery pass",
      );
    }
    for (const status of ["pending", "refused"] as const) {
      seed(status);
      addEvent(
        status,
        `${status}-event`,
        { amount_afn: 88.99, currency: "EUR" },
        { applied_at: null },
      );
      f.sql
        .prepare("INSERT INTO credit_admission_intents VALUES(?,'v1','r1',?,NULL)")
        .run(`${status}-event`, status);
      const events = f.rows(),
        intents = f.sql.prepare("SELECT * FROM credit_admission_intents").all();
      assert.equal(
        await repair([money(status)]),
        1,
        "unapplied intents do not replace or block accepted server money",
      );
      assert.deepEqual(f.rows(), events);
      assert.deepEqual(f.sql.prepare("SELECT * FROM credit_admission_intents").all(), intents);
    }
    seed("local-note");
    addEvent("local-note", "local-note-event", { note: "local note" });
    assert.equal(
      await repair([money("local-note")]),
      1,
      "unpublished independent notes do not block accepted money",
    );
    seed("rejected");
    addEvent("rejected", "rejected-event", { amount_afn: 88.99 }, { rejected_at: 1001 });
    assert.equal(await repair([money("rejected")]), 1);

    seed("deleted", { is_deleted: 1, deleted_at: 999 });
    seed("foreign", { vault_id: "v2" });
    seed("server-deleted");
    const ignored = ["deleted", "foreign", "server-deleted"].map(row);
    assert.equal(
      await repair([
        money("deleted"),
        money("foreign"),
        money("missing"),
        money("server-deleted", { is_deleted: true }),
      ]),
      0,
    );
    assert.deepEqual(["deleted", "foreign", "server-deleted"].map(row), ignored);

    for (const invalid of [
      null,
      {},
      { ...money("wire"), amount_afn: 0.001 },
      { ...money("wire"), amount_afn: -1 },
      { ...money("wire"), amount_afn: NaN },
      { ...money("wire"), currency: "usd" },
      { ...money("wire"), original_currency: "invalid" },
      { ...money("wire"), amount_event_id: "" },
      { ...money("wire"), amount_hlc: { pms: 0, l: 0, did: "server" } },
      { ...money("wire"), amount_hlc: { pms: 100, l: -1, did: "server" } },
      { ...money("wire"), amount_hlc: { pms: 100, l: 0, did: "" } },
      { ...money("wire"), vault_id: "v2" },
      { ...money("wire"), is_deleted: "false" },
    ]) {
      seed("wire");
      const untouched = row("wire");
      await assert.rejects(repair([money("wire"), invalid as any]));
      assert.deepEqual(
        row("wire"),
        untouched,
        "a malformed list cannot partially repair earlier rows",
      );
    }
    assert.throws(() => baselines.validateEntryCurrencyBaselines("v1", {}));
    assert.throws(() =>
      baselines.validateEntryCurrencyBaselines("v1", [money("wire"), money("wire")]),
    );

    seed("current-guard");
    const run = f.tx.runAsync.bind(f.tx);
    let intervene = true;
    f.tx.runAsync = async (query: string, ...args: any[]) => {
      if (intervene && query.startsWith("UPDATE entries AS x")) {
        intervene = false;
        addEvent("current-guard", "guarded-money", { amount_afn: 77.88 });
      }
      return run(query, ...args);
    };
    const guarded = row("current-guard");
    assert.equal(await repair([money("current-guard")]), 0);
    assert.deepEqual(
      row("current-guard"),
      guarded,
      "the update rechecks unpublished money after its row read",
    );
    f.tx.runAsync = run;

    seed("clock-guard");
    let advanced = false;
    f.tx.runAsync = async (query: string, ...args: any[]) => {
      if (!advanced && query.startsWith("UPDATE entries AS x")) {
        advanced = true;
        f.sql
          .prepare(
            "UPDATE entries SET amount_afn=77.88,currency='EUR',field_hlcs=? WHERE id='clock-guard'",
          )
          .run(
            JSON.stringify({ ...synthetic, amount_afn: { pms: 1000, l: 1, did: "local-device" } }),
          );
      }
      return run(query, ...args);
    };
    assert.equal(await repair([money("clock-guard")]), 0);
    assert.equal(row("clock-guard").amount_afn, 77.88);
    assert.equal(
      row("clock-guard").currency,
      "EUR",
      "a newly precise current row cannot be overwritten by an older response",
    );
    f.tx.runAsync = run;

    seed("atomic-first");
    seed("atomic-second");
    const atomicBefore = [row("atomic-first"), row("atomic-second")];
    let updates = 0;
    f.tx.runAsync = async (query: string, ...args: any[]) => {
      if (query.startsWith("UPDATE entries AS x") && ++updates === 2)
        throw new Error("injected baseline update failure");
      return run(query, ...args);
    };
    await assert.rejects(
      repair([money("atomic-first"), money("atomic-second")]),
      /injected baseline update/,
    );
    assert.deepEqual(
      [row("atomic-first"), row("atomic-second")],
      atomicBefore,
      "caller transaction rolls back a later SQL failure atomically",
    );
    f.tx.runAsync = run;
    await repair([money("atomic-first"), money("atomic-second")]);

    for (const map of [synthetic, {}, { amount_afn: { pms: 0, l: 0, did: "" } }]) {
      seed("guard", { field_hlcs: JSON.stringify(map) });
      for (const hlc of [
        { pms: 800, l: 0, did: "peer" },
        { pms: 900, l: 50, did: "z" },
      ]) {
        const prior = row("guard");
        await assert.rejects(
          f.entries.applyEntryAmended(f.tx, {
            event_id: "wait-for-baseline",
            event_type: "entry_amended",
            vault_id: "v1",
            target_id: "guard",
            origin: "remote",
            hlc,
            payload: { changes: { amount_afn: 45.67, currency: "EUR", note: "also held" } },
          }),
          (error: any) => error.kind === "missing_prereq",
        );
        assert.deepEqual(
          row("guard"),
          prior,
          "uncertain currency edits never silently lose or partially apply fields",
        );
      }
      assert.equal(await repair([money("guard")]), 1);
      await f.entries.applyEntryAmended(f.tx, {
        event_id: "retry-after-baseline",
        event_type: "entry_amended",
        vault_id: "v1",
        target_id: "guard",
        origin: "remote",
        hlc: { pms: 800, l: 0, did: "peer" },
        payload: { changes: { amount_afn: 45.67, currency: "EUR" } },
      });
      assert.equal(row("guard").currency, "EUR");
      assert.equal(row("guard").amount_afn, 45.67, "ordinary retry applies after precision repair");
    }
    // Live rows left with unknown clocks keep the next request enabled; once
    // they are gone, precise rows alone do not trigger another metadata fetch.
    assert.equal(await baselines.needsEntryCurrencyBaselines(f.tx, "v1"), true);
    f.sql.exec(
      "UPDATE entries SET is_deleted=1 WHERE id IN ('old-money','server-deleted','wire','current-guard')",
    );
    assert.equal(await baselines.needsEntryCurrencyBaselines(f.tx, "v1"), false);
    assert.equal(
      await baselines.needsEntryCurrencyBaselines(f.tx, "v2"),
      true,
      "another book's placeholders remain independent",
    );
    console.log(
      "PASS entry currency baselines: exact accepted money, original units, independent clocks/fields, signed history, local/mesh unpublished protection, intent preservation, scoped current-row guards, whole-list validation and retriable uncertain edits",
    );
  } finally {
    f.sql.close();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
