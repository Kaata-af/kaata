// Real SQLite projections and the shared server conformance fixture; no native IO.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import Database from "better-sqlite3";
import { entryRecordedAtSql, isValidEntryDate, restoredEntryDateHLCs } from "../entry-date";
import type { SQLiteTx } from "../db-tx";
import type { EntryCreatedEvent, EntryAmendedEvent } from "../events";

function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  const output = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", output)(required, exports);
  return exports as T;
}
const fields = compile<typeof import("../projection/field-hlc")>(
  "../projection/field-hlc",
  (name) => {
    if (name === "../db") return { FIELD_HLC_INIT: { pms: 0, l: 0, did: "" } };
    if (name === "../hlc") return require("../hlc");
    throw new Error(`Unexpected date field dependency ${name}`);
  },
);
const appliers = compile<typeof import("../projection/entries")>(
  "../projection/entries",
  (name) => {
    if (name === "./field-hlc") return fields;
    if (name === "./errors") return require("../projection/errors");
    if (name === "../entry-date") return require("../entry-date");
    if (name === "../currency-scope") return require("../currency-scope");
    if (name === "../hlc") return require("../hlc");
    if (name === "../money") return require("../money");
    throw new Error(`Unexpected date projection dependency ${name}`);
  },
);
const store = new Database(":memory:");
store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,currency TEXT,legacy_currency TEXT);
  INSERT INTO vaults VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','AFN','AFN');
  CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,currency TEXT,
  amount_afn NUMERIC,note TEXT,created_at INTEGER NOT NULL,updated_at INTEGER,
  proposed_by_user_id TEXT,current_event_id TEXT,is_deleted INTEGER,is_settled INTEGER,
  accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER,
  deleted_at INTEGER,field_hlcs TEXT);`);
const tx = {
  runAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).run(...args),
  getFirstAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).get(...args) ?? null,
} as unknown as SQLiteTx;
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../_shared/projection-corpus/07_entry_business_date.json"),
    "utf8",
  ),
);
const entryEvents = fixture.events.filter((e: { event_type: string }) =>
  e.event_type.startsWith("entry_"),
);
const create = entryEvents[0] as EntryCreatedEvent;
const recordedAt = create.payload.recorded_at_ms ?? create.payload.occurred_at_ms;
const id = create.target_id;
const row = () => store.prepare("SELECT * FROM entries WHERE id=?").get(id) as any;
const apply = async (event: any) => {
  if (event.event_type === "entry_created") await appliers.applyEntryCreated(tx, event);
  else if (event.event_type === "entry_amended") await appliers.applyEntryAmended(tx, event);
  else if (event.event_type === "entry_deleted") await appliers.applyEntryDeleted(tx, event);
};
async function run() {
  for (const ms of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])
    assert.equal(isValidEntryDate(ms), false);
  assert.equal(isValidEntryDate(create.payload.occurred_at_ms), true);
  for (const event of entryEvents) await apply(event);
  const expected = fixture.expected_projection.entries[id];
  for (const key of ["created_at", "updated_at", "note", "amount_afn", "current_event_id"])
    assert.equal(row()[key], expected[key], key);
  assert.deepEqual(
    JSON.parse(row().field_hlcs).amount_afn,
    expected.amount_hlc,
    "mobile and server snapshots preserve the same amount/currency register clock",
  );
  assert.equal(JSON.parse(row().field_hlcs).recorded_at_ms.pms, recordedAt);
  assert.equal(
    (
      store.prepare(`SELECT ${entryRecordedAtSql("e")} AS ms FROM entries e`).get() as {
        ms: number;
      }
    ).ms,
    recordedAt,
    "backdating never moves a row across a shared-link boundary",
  );
  const afterLinkCount = () =>
    (
      store
        .prepare(`SELECT COUNT(*) AS n FROM entries e WHERE ${entryRecordedAtSql("e")} > 700`)
        .get() as { n: number }
    ).n;
  assert.equal(
    afterLinkCount(),
    0,
    "an advanced causal clock does not double-count pre-link money",
  );
  await apply({
    ...create,
    target_id: "legacy-skew",
    hlc: { pms: 60_000, l: 0, did: "a" },
    payload: {
      ...create.payload,
      entry_id: "legacy-skew",
      occurred_at_ms: 500,
      recorded_at_ms: undefined,
    },
  });
  assert.equal(afterLinkCount(), 0, "old events fall back to their original wall date");
  await apply({
    ...create,
    target_id: "post-link",
    hlc: { pms: 60_000, l: 0, did: "a" },
    payload: { ...create.payload, entry_id: "post-link", occurred_at_ms: 100, recorded_at_ms: 900 },
  });
  assert.equal(afterLinkCount(), 1, "a newly recorded backdated tally counts after the link");

  // Independent fields commute even when the newer note arrives first.
  store.prepare("DELETE FROM entries").run();
  await apply(create);
  for (const event of [...entryEvents.slice(1)].reverse()) await apply(event);
  assert.equal(row().created_at, expected.created_at);
  assert.equal(row().note, expected.note);
  assert.equal(row().updated_at, expected.updated_at);
  assert.equal(row().current_event_id, expected.current_event_id);

  const dateWinner = entryEvents.find(
    (e: EntryAmendedEvent) => e.payload.changes?.occurred_at_ms === expected.created_at,
  ) as EntryAmendedEvent;
  for (const invalid of ["2000", 1.5, -1, 0, Infinity])
    await assert.rejects(
      apply({
        ...dateWinner,
        hlc: { pms: 7000, l: 0, did: "a" },
        payload: { changes: { occurred_at_ms: invalid } },
      }),
      /Invalid entry date/,
    );
  // Restore only the snapshot projection: no creator event is present locally.
  const restored = restoredEntryDateHLCs(
    JSON.stringify({
      amount_afn: { pms: 9000, l: 0, did: "" },
      note: { pms: 9000, l: 0, did: "" },
      occurred_at_ms: { pms: 9000, l: 0, did: "" },
    }),
    {
      created_at: expected.created_at,
      recorded_at_ms: recordedAt,
      occurred_at_hlc: dateWinner.hlc,
    },
  );
  store.prepare("UPDATE entries SET field_hlcs=?").run(restored);
  await apply({
    ...dateWinner,
    event_id: "after-restore",
    hlc: { pms: 8000, l: 0, did: "a" },
    payload: { changes: { occurred_at_ms: 450 } },
  });
  assert.equal(row().created_at, 450, "newer date survives a higher independent note floor");
  assert.equal(JSON.parse(row().field_hlcs).recorded_at_ms.pms, recordedAt);

  // Legacy rows acquire an immutable marker before their original date changes.
  store.prepare("UPDATE entries SET field_hlcs=NULL,created_at=1234").run();
  await apply({
    ...dateWinner,
    event_id: "legacy-date",
    hlc: { pms: 10000, l: 0, did: "a" },
    payload: { changes: { occurred_at_ms: 300 } },
  });
  assert.equal(JSON.parse(row().field_hlcs).recorded_at_ms.pms, 1234);
  await apply({
    ...dateWinner,
    event_id: "null-date",
    hlc: { pms: 11000, l: 0, did: "a" },
    payload: { changes: { occurred_at_ms: null } },
  });
  assert.equal(row().created_at, 300, "null occurrence matches Go's omitted pointer semantics");
  await appliers.applyEntryDeleted(tx, {
    ...create,
    event_type: "entry_deleted",
    payload: {},
    event_id: "deleted",
    hlc: { pms: 12000, l: 0, did: "a" },
  });
  await apply({ ...dateWinner, hlc: { pms: 13000, l: 0, did: "a" } });
  assert.equal(row().created_at, 300, "date edits cannot mutate tombstones");
  assert.equal(row().current_event_id, "deleted");
  console.log(
    "PASS tally date projection, concurrent field winners, restore, immutable recording time and tombstones",
  );
}
void run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => store.close());
