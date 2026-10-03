// Run with npm run selftest:money. Uses installed better-sqlite3 and only
// synthetic ledgers: never opens kaata.db or any device/user backup.
//
// Exercises the production money helpers, SQL aggregate, entry appliers,
// pulled-event mapper, signature canonicalization, and export calculations.
// Native Expo adapters are replaced at the Node module boundary below. The
// backup test uses SQLite's online backup API; it does not claim to test Expo's
// filesystem rotation, native restore UI, or a complete app migration chain.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import type { SQLiteTx } from "../db-tx";
import type {
  EntryAmendedEvent,
  EntryCreatedEvent,
  EntryDeletedEvent,
  LedgerEvent,
} from "../events";
import type { Entry } from "../types";
import {
  addAmounts,
  formatMoneyAmount,
  fromMinorUnits,
  normalizeAmountInput,
  parseAmountInput,
  sumAmounts,
  toMinorUnits,
} from "../money";
import { signedEntryMinorSumSql } from "../money-sql";
import { formatSettlementDate } from "../jalali";

// App code (and expo-modules-core's logger side effect, which lib/i18n.ts
// pulls in through expo-localization) reads the bundler-provided __DEV__;
// Node has none. Group 6 loads the real export builders, so this has to be
// set before the first require of anything Expo.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Loading field-hlc's single DB constant must not initialize Expo SQLite.
// Check the fixture constant against the real declaration so it cannot drift.
const dbSource = readFileSync(require.resolve("../db"), "utf8");
assert.match(dbSource, /FIELD_HLC_INIT\s*=\s*\{\s*pms:\s*0,\s*l:\s*0,\s*did:\s*"init"\s*\}/);

function withModuleStubs<T>(stubs: Record<string, unknown>, load: () => T): T {
  const saved = new Map<string, NodeJS.Module | undefined>();
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = require.resolve(name);
    saved.set(filename, require.cache[filename]);
    require.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeJS.Module;
  }
  try {
    return load();
  } finally {
    for (const [filename, previous] of saved) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  }
}

// Reads what the export CSV builders emit: a BOM, CRLF rows, and quoted
// fields with doubled quotes. Cells are addressed by their header text, and
// a row by its entry id, which the contract keeps in the last column.
function csvTable(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && s[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return {
    header,
    rows: body,
    row(id: string): string[] {
      const found = body.find((r) => r.at(-1) === id);
      assert.ok(found, `the CSV has a row whose last column is ${id}`);
      return found;
    },
    cell(r: string[], column: string): string | undefined {
      const i = header.indexOf(column);
      return i < 0 ? undefined : r[i];
    },
    /** SUM(Gave) − SUM(Received), exact in cents. */
    net(code: string): number {
      const gave = header.indexOf(`Gave (${code})`);
      const received = header.indexOf(`Received (${code})`);
      assert.ok(gave >= 0 && received >= 0, `the CSV has Gave (${code}) and Received (${code})`);
      return sumAmounts(
        body.map((r) => addAmounts(Number(r[gave] || 0), -Number(r[received] || 0))),
      );
    },
  };
}

const entries = withModuleStubs(
  { "../db": { FIELD_HLC_INIT: { pms: 0, l: 0, did: "init" } } },
  () => require("../projection/entries") as typeof import("../projection/entries"),
);
const signatures = withModuleStubs(
  { "expo-crypto": { getRandomBytes: (n: number) => randomBytes(n) } },
  () => require("../event-sig") as typeof import("../event-sig"),
);
const { mapPulledWireToEvent } = withModuleStubs(
  { "../db-tx": {}, "../projection/index": {} },
  () => require("../projection/ingest-row") as typeof import("../projection/ingest-row"),
);

// Minimal fixture schema retains the shipped INTEGER amount affinity. It is
// deliberately not a copied migration or a replacement migration runner.
function openFixture(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE vaults (id TEXT PRIMARY KEY);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE relationships (id TEXT PRIMARY KEY, vault_id TEXT REFERENCES vaults(id));
    CREATE TABLE entries (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id),
      relationship_id TEXT NOT NULL REFERENCES relationships(id),
      type TEXT NOT NULL CHECK(type IN ('debt', 'payment')), amount_afn INTEGER NOT NULL,
      note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      proposed_by_user_id TEXT REFERENCES users(id), current_event_id TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0, is_settled INTEGER NOT NULL DEFAULT 0,
      accepted_at INTEGER, disputed_at INTEGER, disputed_reason TEXT, settled_at INTEGER,
      deleted_at INTEGER, field_hlcs TEXT CHECK(field_hlcs IS NULL OR json_valid(field_hlcs))
    );
    CREATE TABLE event_log (
      event_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      payload_schema INTEGER NOT NULL, event_sig_b64 TEXT, signer_device_pubkey TEXT
    );
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
    INSERT INTO schema_migrations VALUES ('027');
    INSERT INTO vaults VALUES ('vault');
    INSERT INTO users VALUES ('self');
    INSERT INTO relationships VALUES ('relationship', 'vault');
  `);
  return db;
}

function asTx(db: Database.Database): SQLiteTx {
  return {
    runAsync: async (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args),
  } as unknown as SQLiteTx;
}

function created(
  id: string,
  amount: number,
  type: "debt" | "payment" = "debt",
  pms = 1000,
): EntryCreatedEvent {
  return {
    event_id: `create-${id}`,
    event_type: "entry_created",
    vault_id: "vault",
    target_id: id,
    relationship_id: "relationship",
    hlc: { pms, l: 0, did: "device" },
    device_id: "device",
    author_user_id_local_only: "self",
    actor_account_id: null,
    payload_schema: 1,
    appended_at: pms,
    server_acked_at: null,
    rejected_at: null,
    origin: "local",
    payload: {
      entry_id: id,
      relationship_id: "relationship",
      type,
      amount_afn: amount,
      note: null,
      occurred_at_ms: pms,
    },
  };
}

function amended(base: EntryCreatedEvent, amount: number, pms: number): EntryAmendedEvent {
  return {
    ...base,
    event_id: `amend-${base.target_id}-${pms}`,
    event_type: "entry_amended",
    hlc: { ...base.hlc, pms },
    payload: { changes: { amount_afn: amount } },
  };
}

async function apply(db: Database.Database, event: LedgerEvent): Promise<void> {
  switch (event.event_type) {
    case "entry_created":
      return entries.applyEntryCreated(asTx(db), event);
    case "entry_amended":
      return entries.applyEntryAmended(asTx(db), event);
    case "entry_deleted":
      return entries.applyEntryDeleted(asTx(db), event);
    default:
      throw new Error(`Unexpected fixture event: ${event.event_type}`);
  }
}

function balanceMinor(db: Database.Database, alias = ""): number {
  const row = db
    .prepare(`SELECT ${signedEntryMinorSumSql(alias)} AS balance FROM entries ${alias}`)
    .get() as { balance: number };
  return row.balance;
}

function snapshot(db: Database.Database): unknown {
  return {
    entries: db
      .prepare("SELECT *, typeof(amount_afn) AS amount_storage FROM entries ORDER BY id")
      .all(),
    events: db.prepare("SELECT * FROM event_log ORDER BY event_id").all(),
    migrations: db.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
  };
}

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  console.log(`PASS ${++passed}: ${name}`);
}

async function main(): Promise<void> {
  await test("decimal input is strict, localized, and preserves legacy whole units", () => {
    for (const [input, expected] of [
      ["100", 100],
      [".5", 0.5],
      ["12.", 12],
      ["12.50", 12.5],
      ["۱۲٫۵۰", 12.5],
      ["١٢٫٥٠", 12.5],
      ["1,50", 1.5],
      [" 0.01 ", 0.01],
      ["9999999999.99", 9_999_999_999.99],
    ] as const) {
      assert.equal(parseAmountInput(input), expected, input);
    }
    for (const input of [
      "",
      "0",
      "0.00",
      "-1",
      "+1",
      "1e2",
      "1,234",
      "1,234.50",
      "12.345",
      "1..2",
      "1.2.3",
      "1 2",
      "abc12",
      "NaN",
      "Infinity",
      "10000000000",
    ]) {
      assert.equal(parseAmountInput(input), null, input);
    }
    assert.equal(normalizeAmountInput("۱۲٫۵۰"), "12.50");
    assert.equal(normalizeAmountInput("1,234"), "1,234");
  });

  await test("integer hundredths make fractional cancellation and formatting exact", () => {
    assert.equal(toMinorUnits(100), 10_000);
    assert.equal(fromMinorUnits(10_000), 100);
    assert.equal(toMinorUnits(0.29), 29);
    assert.equal(toMinorUnits(-0.29), -29);
    assert.equal(toMinorUnits(9_999_999_999.99), 999_999_999_999);
    assert.equal(addAmounts(0.1, 0.2), 0.3);
    assert.equal(sumAmounts([0.1, 0.2, -0.3]), 0);
    assert.equal(sumAmounts(new Set([0.1, 0.2, -0.3])), 0);
    assert.equal(sumAmounts([]), 0);
    assert.equal(formatMoneyAmount(100), "100");
    assert.equal(formatMoneyAmount(100.5), "100.50");
    assert.equal(formatMoneyAmount(-1234.56), "1,234.56");
    for (const value of [NaN, Infinity, -Infinity, 0.001, 1.005, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => toMinorUnits(value), RangeError, String(value));
    }
    assert.throws(() => fromMinorUnits(0.1), RangeError);
    assert.throws(() => fromMinorUnits(Number.MAX_SAFE_INTEGER + 1), RangeError);
  });

  await test("production SQL sums cents before aggregation, ignores deletes, and never changes stored values", async () => {
    const db = openFixture();
    try {
      assert.equal(balanceMinor(db), 0);
      const events = [
        created("legacy", 100),
        created("a", 0.1),
        created("b", 0.2),
        created("c", 0.3, "payment"),
        created("deleted", 999.99),
      ];
      for (const event of events) await apply(db, event);
      await entries.applyEntryDeleted(asTx(db), {
        ...events[4],
        event_type: "entry_deleted",
        event_id: "delete",
        hlc: { pms: 2000, l: 0, did: "device" },
        payload: {},
      } as EntryDeletedEvent);
      const before = snapshot(db);
      assert.equal(balanceMinor(db), 10_000);
      assert.equal(balanceMinor(db, "e"), 10_000);
      assert.equal(fromMinorUnits(balanceMinor(db)), 100);
      assert.deepEqual(snapshot(db), before);
      assert.deepEqual(
        db
          .prepare(
            "SELECT amount_afn, typeof(amount_afn) AS storage FROM entries WHERE id = 'legacy'",
          )
          .get(),
        { amount_afn: 100, storage: "integer" },
      );
      assert.deepEqual(
        db
          .prepare("SELECT amount_afn, typeof(amount_afn) AS storage FROM entries WHERE id = 'a'")
          .get(),
        { amount_afn: 0.1, storage: "real" },
      );
      db.prepare("DELETE FROM entries WHERE id = 'legacy'").run();
      assert.equal(balanceMinor(db), 0, "same zero predicate used by settlement preflight");
      await apply(db, created("cent", 0.01));
      assert.equal(balanceMinor(db), 1, "one unpaid cent must prevent settling");
      assert.throws(() => signedEntryMinorSumSql("entries; DROP TABLE entries"));
    } finally {
      db.close();
    }
  });

  await test("real entry appliers preserve decimal LWW edits, replay, and sticky deletes", async () => {
    const db = openFixture();
    try {
      const base = created("entry", 100);
      const newer = amended(base, 12.34, 3000);
      const older = amended(base, 7.89, 2000);
      await apply(db, base);
      await apply(db, newer);
      await apply(db, older);
      assert.equal(
        (db.prepare("SELECT amount_afn FROM entries").get() as { amount_afn: number }).amount_afn,
        12.34,
      );
      const beforeReplay = snapshot(db);
      db.prepare("DELETE FROM entries").run();
      for (const event of [base, older, newer])
        await apply(db, JSON.parse(JSON.stringify(event)) as LedgerEvent);
      assert.deepEqual(snapshot(db), beforeReplay);
      await entries.applyEntryDeleted(asTx(db), {
        ...base,
        event_type: "entry_deleted",
        event_id: "delete",
        hlc: { pms: 4000, l: 0, did: "device" },
        payload: {},
      } as EntryDeletedEvent);
      const tombstone = snapshot(db);
      await apply(db, amended(base, 0.01, 5000));
      assert.deepEqual(snapshot(db), tombstone);
    } finally {
      db.close();
    }
  });

  await test("signed legacy and decimal payloads survive wire mapping, replay, and SQLite online backup", async () => {
    const db = openFixture();
    const directory = mkdtempSync(join(tmpdir(), "kaata-money-selftest-"));
    const backupPath = join(directory, "fixture.backup.db");
    let backedUp = false;
    try {
      const privateKey = new Uint8Array(32).fill(7); // Public synthetic test key, never an app key.
      const publicKey = Buffer.from(ed.getPublicKey(privateKey)).toString("base64");
      for (const event of [created("legacy", 100), created("fractional", 12.34)]) {
        const sig = await signatures.signEvent(event, async (bytes) => ed.sign(bytes, privateKey));
        const payloadJson = JSON.stringify(event.payload);
        db.prepare("INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?)").run(
          event.event_id,
          JSON.stringify(event),
          payloadJson,
          event.payload_schema,
          sig,
          publicKey,
        );
        const wire = {
          event_id: event.event_id,
          event_type: event.event_type,
          hlc: event.hlc,
          device_id: event.device_id,
          account_id: event.actor_account_id,
          target_id: event.target_id,
          relationship_id: event.relationship_id,
          schema_version: event.payload_schema,
          payload: JSON.parse(payloadJson),
          event_sig_b64: sig,
          signer_device_pubkey: publicKey,
        };
        const pulled = mapPulledWireToEvent(JSON.parse(JSON.stringify(wire)), "vault");
        assert.deepEqual(signatures.canonicalizeEvent(pulled), signatures.canonicalizeEvent(event));
        assert.deepEqual(signatures.verifyEventSignature(pulled, sig, publicKey), { valid: true });
        await apply(db, pulled);
      }
      // A restored snapshot may contain base entries with no local create
      // event. The no-migration design must retain this row too.
      await apply(db, created("snapshot-base-without-log", 7.89));
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM event_log").get() &&
          (db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number }).n,
        2,
      );
      const before = snapshot(db);
      await db.backup(backupPath);
      backedUp = true;
      const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        assert.equal(restored.pragma("quick_check", { simple: true }), "ok");
        assert.deepEqual(snapshot(restored), before);
        const rows = restored.prepare("SELECT * FROM event_log ORDER BY event_id").all() as Array<{
          envelope_json: string;
          payload_json: string;
          event_sig_b64: string;
          signer_device_pubkey: string;
        }>;
        for (const row of rows) {
          const event = JSON.parse(row.envelope_json) as LedgerEvent;
          event.payload = JSON.parse(row.payload_json);
          assert.deepEqual(
            signatures.verifyEventSignature(event, row.event_sig_b64, row.signer_device_pubkey),
            { valid: true },
          );
          const altered = { ...event, payload: { ...event.payload, amount_afn: 1 } };
          assert.equal(
            signatures.verifyEventSignature(altered, row.event_sig_b64, row.signer_device_pubkey)
              .valid,
            false,
          );
        }
      } finally {
        restored.close();
      }
      assert.deepEqual(snapshot(db), before, "online backup is read-only on its source");
    } finally {
      db.close();
      if (backedUp) unlinkSync(backupPath);
      rmdirSync(directory);
    }
  });

  await test("actual statements, reports, CSV and PDF HTML keep cents and settlement markers", async () => {
    let archives: Array<{ link: import("../tabs/types").TabLink; entries: Entry[] }> = [];
    let personTabId: string | null = null;
    const sharedMarkers = new Map<string, import("../tabs/types").TabSettlement[]>();
    const { Mutex } = require("../util/mutex") as typeof import("../util/mutex");
    const exportMutex = new Mutex();
    const fixture = [
      created("a", 0.1, "debt", 1000),
      created("b", 0.2, "debt", 2000),
      created("c", 0.3, "payment", 3000),
    ].map((e) => ({
      id: e.target_id,
      type: e.payload.type,
      amount_afn: e.payload.amount_afn,
      note: null,
      created_at: e.payload.occurred_at_ms,
      updated_at: e.payload.occurred_at_ms,
    })) as Entry[];
    const { buildPersonStatement, buildVaultReport, isoDate, shamsiDate } = withModuleStubs(
      {
        "expo-file-system": {},
        "expo-sharing": {},
        // data.ts now reaches react-native (Platform) and the kaata-save-file
        // native facade for save-to-phone; neither loads under Node (Flow
        // syntax / no native module). Nothing here exercises the save path.
        "react-native": { Platform: { OS: "android" } },
        "kaata-save-file": {
          SAVE_FILE_ERR: { UNSUPPORTED: "E_UNSUPPORTED" },
          saveFileToPhone: async () => null,
        },
        "../calendar": { getEffectiveCalendar: () => "gregorian" },
        "../currency": { getCurrencySymbol: () => "$" },
        "../projection": { applyEventMutex: exportMutex },
        "../tabs/db": {
          listTabSettlements: async (tabId: string) => sharedMarkers.get(tabId) ?? [],
        },
        "../db": {
          getPerson: async () => ({
            id: "person",
            name: "Fixture",
            balance: 0,
            tab_id: personTabId,
          }),
          listEntries: async () => [...fixture].reverse(),
          listSettlementBoundaries: async () => [3000],
          getLocalSelf: async () => null,
          listArchivedSharedPeriodsForExport: async () => archives,
          listEntriesForExport: async () =>
            fixture.map((e) => ({
              ...e,
              person_id: "person",
              person_name: "Fixture",
              person_phone: null,
            })),
        },
      },
      () => require("../export/data") as typeof import("../export/data"),
    );
    const statement = await buildPersonStatement("person", "en", "USD", "$", 4000);
    assert.ok(statement);
    assert.equal(statement.balance, 0);
    assert.deepEqual(
      statement.rows.map((r) => r.balanceAfter),
      [0.1, 0.3, 0, 0],
    );
    assert.equal(statement.rows.at(-1)?.kind, "settled");
    const report = await buildVaultReport("vault", "Fixture", "USD", "en", 4000);
    assert.deepEqual(
      report.journal.map((r) => r.balanceAfter),
      [0.1, 0.3, 0],
    );
    assert.deepEqual(report.totals, { collect: 0, pay: 0, net: 0 });
    assert.equal(report.people[0].balance, 0);

    // Exercise the real CSV and PDF HTML builders. Replace only native
    // filesystem/font/print adapters; this does not render a device PDF.
    const html: string[] = [];
    class PrintFile {
      constructor(public uri: string) {}
      async base64() {
        return "AA==";
      }
      async move(target: PrintFile) {
        this.uri = target.uri;
      }
    }
    const nativeStubs = {
      "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
      "../db": { getAppMeta: async () => null },
      "../calendar": { getEffectiveCalendar: () => "gregorian" },
      "../currency": { getCurrentCurrencySymbol: () => "$" },
      "expo-file-system": { File: PrintFile },
      "expo-asset": {
        Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "fixture-font" }) },
      },
      "@expo-google-fonts/vazirmatn": { Vazirmatn_400Regular: 1, Vazirmatn_700Bold: 2 },
      "expo-print": {
        printToFileAsync: async ({ html: page }: { html: string }) => {
          html.push(page);
          return { uri: "fixture-printed" };
        },
      },
      "../export/data": {
        ...require("../export/data"),
        exportFileTarget: (name: string) => new PrintFile(name),
      },
    };
    const csv = withModuleStubs(
      nativeStubs,
      () => require("../export/csv") as typeof import("../export/csv"),
    );
    const pdf = withModuleStubs(
      nativeStubs,
      () => require("../export/pdf") as typeof import("../export/pdf"),
    );
    for (const output of [csv.buildPersonCsv(statement), csv.buildVaultCsv(report)]) {
      assert.ok(output.includes("(USD)"));
      assert.ok(output.includes(",0.1,,0.1,"), "CSV preserves the first ten cents");
      assert.ok(output.includes(",0.2,,0.3,"), "CSV running balance is exactly thirty cents");
      assert.ok(output.includes(",,0.3,0,"), "CSV payment settles to zero");
      assert.ok(!output.includes("0.30000000000000004"));
    }
    // Unshared contacts and kaatas export byte-for-byte what 2.0.0 did. The
    // shared-record work may only change a SHARED file's shape, never this.
    const day = (ms: number) => formatSettlementDate(ms, "en", "gregorian");
    const dated = (ms: number, rest: string) => `${isoDate(ms)},${shamsiDate(ms)},${rest}\r\n`;
    assert.equal(
      csv.buildPersonCsv(statement),
      "\uFEFFDate,Date (Shamsi),Gave (USD),Received (USD),Balance (USD),Note,Entry ID\r\n" +
        dated(1000, "0.1,,0.1,,a") +
        dated(2000, "0.2,,0.3,,b") +
        dated(3000, ",0.3,0,,c") +
        dated(3000, `,,0,Settled · ${day(3000)},`),
      "an unshared statement CSV is exactly the 2.0.0 file",
    );
    assert.equal(
      csv.buildVaultCsv(report),
      "\uFEFFDate,Date (Shamsi),Name,Phone,Gave (USD),Received (USD),Balance (USD),Note,Entry ID\r\n" +
        dated(1000, "Fixture,,0.1,,0.1,,a") +
        dated(2000, "Fixture,,0.2,,0.3,,b") +
        dated(3000, "Fixture,,,0.3,0,,c"),
      "an unshared kaata CSV is exactly the 2.0.0 file",
    );
    // Only a shared record's status can empty Gave/Received, never its
    // amount: a private tally of 0 still prints its counted 0.
    const zeroRow = { kind: "entry" as const, entry: { ...fixture[0], id: "zero", amount_afn: 0 } };
    assert.ok(
      csv
        .buildPersonCsv({ ...statement, rows: [{ ...zeroRow, balanceAfter: 0 }] })
        .endsWith(",0,,0,,zero\r\n"),
      "a private 0 is still a counted Gave cell",
    );
    await pdf.renderPersonStatementPdf(statement, "fixture-person.pdf");
    await pdf.renderVaultReportPdf(
      {
        ...report,
        people: [{ ...report.people[0], balance: 0.3 }],
        totals: { collect: 0.3, pay: 0, net: 0.3 },
      },
      "fixture-vault.pdf",
    );
    assert.equal(html.length, 2);
    // The statement's running-balance COLUMN is gone (2026-09 redesign), so
    // the cents are pinned where they now live: each row's amount cell, which
    // carries the currency symbol, and the summary cards above the table.
    assert.ok(html[0].includes('class="num">0.10 $</span>'), "row amount keeps ten cents");
    assert.ok(html[0].includes('class="num">0.20 $</span>'), "row amount keeps twenty cents");
    // 0.1 + 0.2 summed through sumAmounts (integer cents) for the summary
    // cards. This is the assertion that would catch a naive float add.
    assert.ok(html[0].includes("0.30 $</div>"), "summary card totals exactly thirty cents");
    assert.ok(html[1].includes("0.30"));
    assert.ok(html.every((page) => !page.includes("0.30000000000000004")));

    // A shared statement retains rejected/cancelled records but gives them
    // zero contribution. The account's pending-inclusive total is unchanged.
    const reviewed: Entry = {
      ...fixture[0],
      id: "reviewed",
      amount_afn: 100,
      created_at: 5000,
      tab: {
        by: "them",
        // They wrote it as party b, so the exporter is party a.
        created_by: "b",
        status: "disputed",
        kind: "entry",
        dispute_reason: null,
        voided: false,
        local_pending: false,
        other_label: "Other shop",
      },
    };
    fixture.push(reviewed, {
      ...reviewed,
      id: "voided",
      tab: { ...reviewed.tab!, status: "accepted", voided: true },
    });
    const rejectedStatement = await buildPersonStatement("person", "en", "USD", "$", 6000);
    assert.ok(rejectedStatement);
    assert.equal(rejectedStatement.balance, 0);
    assert.equal(
      rejectedStatement.rows.filter(
        (r) => r.kind === "entry" && ["reviewed", "voided"].includes(r.entry.id),
      ).length,
      2,
    );
    assert.deepEqual(rejectedStatement.sharedTotals, { acknowledged: 0, pending: 0, private: 0 });
    reviewed.tab!.status = "accepted";
    const acceptedStatement = await buildPersonStatement("person", "en", "USD", "$", 6000);
    assert.equal(acceptedStatement?.balance, 100, "re-accepting restores exactly one amount");
    assert.deepEqual(acceptedStatement?.sharedTotals, {
      acknowledged: 100,
      pending: 0,
      private: 0,
    });
    Object.assign(reviewed.tab!, {
      author_name: "<Original writer>",
      author_account_id: "deleted-author",
      author_member_role: "clerk",
      reviewer_name: "=Reviewer",
      reviewer_account_id: "deleted-reviewer",
      reviewer_party: "a",
      reviewer_member_role: "manager",
      review_semantics_version: "tally-review-v1",
      recorded_at: 5000,
      status_at: 6000,
      seq: 1,
      rev: 2,
      tab_id: "shared-record",
    });
    fixture.push({
      ...reviewed,
      id: "pending-payment",
      type: "payment",
      amount_afn: 25,
      tab: { ...reviewed.tab!, status: "pending", reviewer_name: "", reviewer_account_id: null },
    });
    fixture.push({
      ...reviewed,
      id: "unsynced-accept",
      amount_afn: 7,
      tab: { ...reviewed.tab!, local_pending: true },
    });
    fixture.push({
      ...reviewed,
      id: "rejected-history",
      amount_afn: 2000,
      tab: { ...reviewed.tab!, status: "disputed", dispute_reason: "Wrong amount" },
    });
    const sharedStatement = (await buildPersonStatement("person", "en", "USD", "$", 7000))!;
    assert.equal(sharedStatement.balance, 82);
    assert.deepEqual(sharedStatement.sharedTotals, { acknowledged: 100, pending: -18, private: 0 });
    const sharedCsv = csv.buildPersonCsv(sharedStatement);
    assert.ok(sharedCsv.includes("Acknowledged net balance"));
    assert.ok(sharedCsv.includes("Pending net balance"));
    assert.ok(sharedCsv.includes("\t=Reviewer"), "new reviewer free text is formula-guarded");
    assert.ok(sharedCsv.includes("deleted-reviewer"));
    assert.ok(sharedCsv.includes("1970-01-01T00:00:06.000Z"));
    assert.ok(sharedCsv.includes("Cancelled"));
    assert.ok(sharedCsv.includes("Rejected"));
    const unsyncedCsvRow = sharedCsv
      .split("\r\n")
      .find((line) => line.endsWith(",unsynced-accept"))!;
    assert.ok(unsyncedCsvRow.includes("Awaiting sync"));
    assert.ok(unsyncedCsvRow.includes("Acceptance awaiting sync"));
    assert.ok(
      !unsyncedCsvRow.includes(",Accepted,"),
      "queued acceptance is not a recorded verdict",
    );
    assert.ok(
      !unsyncedCsvRow.includes("deleted-reviewer"),
      "unsynced intent is never recorded review evidence",
    );
    // A shared file keeps the 2.0.0 leading columns and their meaning: Gave and
    // Received in the kaata currency, holding only what counts, so their
    // difference is the balance. A rejected or cancelled tally keeps its amount
    // in Recorded amount, signed like Balance contribution.
    const sharedTable = csvTable(sharedCsv);
    assert.deepEqual(
      sharedTable.header.slice(0, 10),
      [
        "Date",
        "Date (Shamsi)",
        "Gave (USD)",
        "Received (USD)",
        "Balance (USD)",
        "Note",
        "Balance scope",
        "Currency",
        "Recorded amount",
        "Earlier period balance",
      ],
      "a shared statement keeps the 2.0.0 leading columns, currency suffix included",
    );
    assert.equal(sharedTable.header.at(-1), "Entry ID", "the entry id stays the last column");
    assert.ok(
      sharedTable.rows.every((r) => r.length === sharedTable.header.length),
      "every shared row fills every column",
    );
    assert.equal(sharedTable.net("USD"), 82, "SUM(Gave) - SUM(Received) is the statement balance");
    for (const [id, recorded] of [
      ["rejected-history", "2000"],
      ["voided", "100"],
    ] as const) {
      const r = sharedTable.row(id);
      assert.deepEqual(
        [r[2], r[3], sharedTable.cell(r, "Recorded amount")],
        ["", "", recorded],
        `${id} counts in neither Gave nor Received but keeps its recorded amount`,
      );
      assert.equal(sharedTable.cell(r, "Balance contribution"), "0", `${id} contributes zero`);
    }
    const pendingPayment = sharedTable.row("pending-payment");
    assert.deepEqual(
      [pendingPayment[3], sharedTable.cell(pendingPayment, "Recorded amount")],
      ["25", "-25"],
      "a counted payment stays in Received; its recorded amount is signed like the balance",
    );
    const reviewedRow = sharedTable.row("reviewed");
    assert.deepEqual(
      [
        "Author role at the time",
        "Reviewer side",
        "Reviewer role at the time",
        "Review action version",
      ].map((column) => sharedTable.cell(reviewedRow, column)),
      ["clerk", "a", "manager", "tally-review-v1"],
      "the CSV keeps the machine values the PDF localizes",
    );
    await pdf.renderPersonStatementPdf(sharedStatement, "fixture-shared.pdf");
    assert.ok(html[2].includes("&lt;Original writer&gt;"));
    assert.ok(!html[2].includes("<Original writer>"));
    assert.ok(html[2].includes("tally-review-v1"));
    assert.ok(html[2].includes("Wrong amount"));
    assert.ok(html[2].includes("Cancelled"));
    assert.ok(html[2].includes("100 $</div>"), "acknowledged net remains separate");
    assert.ok(html[2].includes("-18 $</div>"), "pending net includes unsynced reviews");
    // On paper a machine value is either localized or printed as an
    // LTR-isolated code, never as bare prose.
    const codeSpan = (value: string) => `<span class="code" dir="ltr">${value}</span>`;
    for (const value of [
      "tally-review-v1",
      "deleted-reviewer",
      "shared-record",
      "1970-01-01T00:00:06.000Z",
      "reviewed",
    ]) {
      assert.ok(html[2].includes(codeSpan(value)), `${value} prints as an LTR-isolated code`);
    }
    for (const [raw, shown] of [
      ["clerk", "Clerk"],
      ["manager", "Manager"],
      ["a", "This side"],
    ] as const) {
      assert.ok(html[2].includes(`<span dir="auto">${shown}</span>`), `${raw} prints as ${shown}`);
      assert.ok(!html[2].includes(`<span dir="auto">${raw}</span>`), `the raw ${raw} never prints`);
    }
    const sharedReport = await buildVaultReport("vault", "Fixture", "USD", "en", 7000);
    assert.equal(sharedReport.totals.net, 82);
    assert.ok(csv.buildVaultCsv(sharedReport).includes("deleted-reviewer"));
    const vaultTable = csvTable(csv.buildVaultCsv(sharedReport));
    assert.deepEqual(
      vaultTable.header.slice(4, 9),
      ["Gave (USD)", "Received (USD)", "Balance (USD)", "Note", "Recorded amount (USD)"],
      "a shared kaata CSV keeps its leading columns; the recorded amount comes first after them",
    );
    assert.equal(vaultTable.header.at(-1), "Entry ID", "the entry id stays the last column");
    assert.equal(vaultTable.net("USD"), 82, "SUM(Gave) - SUM(Received) is the kaata's net");
    const vaultRejected = vaultTable.row("rejected-history");
    assert.deepEqual(
      [vaultRejected[4], vaultRejected[5], vaultTable.cell(vaultRejected, "Recorded amount (USD)")],
      ["", "", "2000"],
      "a rejected tally counts in neither Gave nor Received but keeps its recorded amount",
    );
    // Re-linking carries the old amount into a new opening. Full history must
    // retain the old accepted evidence without counting that money twice.
    const oldRecord: Entry = {
      ...reviewed,
      id: "old-period-evidence",
      amount_afn: 50,
      tab: { ...reviewed.tab!, tab_id: "old-period", local_pending: false, status: "accepted" },
    };
    archives = [
      {
        link: {
          tab_id: "old-period",
          currency: "AFN",
          linked_at: 1000,
          closed_at: 3000,
          my_label: "Shop",
          other_label: "Customer",
        } as import("../tabs/types").TabLink,
        entries: [oldRecord],
      },
    ];
    fixture.splice(
      0,
      fixture.length,
      {
        ...oldRecord,
        id: "new-opening",
        tab: { ...oldRecord.tab!, tab_id: "new-period", kind: "opening" },
      },
      {
        ...oldRecord,
        id: "new-pending",
        amount_afn: 10,
        tab: { ...oldRecord.tab!, tab_id: "new-period", status: "pending" },
      },
    );
    const relinked = (await buildPersonStatement("person", "en", "USD", "$", 9000))!;
    assert.equal(relinked.balance, 60, "old 50 is counted only via the new opening");
    assert.deepEqual(relinked.sharedTotals, { acknowledged: 50, pending: 10, private: 0 });
    assert.equal(relinked.archivedSharedPeriods?.[0].entries[0].id, "old-period-evidence");
    const archivedTable = csvTable(csv.buildPersonCsv(relinked));
    const archivedRow = archivedTable.row("old-period-evidence");
    assert.deepEqual(
      [
        "Balance scope",
        "Currency",
        "Recorded amount",
        "Earlier period balance",
        "Balance contribution",
      ].map((column) => archivedTable.cell(archivedRow, column)),
      ["Earlier shared period — excluded from current balance", "AFN", "50", "50", "0"],
      "an earlier period is recorded in its own currency and contributes nothing today",
    );
    assert.deepEqual(
      [archivedRow[2], archivedRow[3], archivedRow[4]],
      ["", "", ""],
      "an earlier period never enters today's Gave, Received or Balance",
    );
    assert.equal(
      archivedTable.net("USD"),
      60,
      "the carried-over 50 is counted once, via the opening",
    );
    assert.ok(archivedRow.includes("deleted-reviewer"));
    await pdf.renderPersonStatementPdf(relinked, "fixture-archive.pdf");
    assert.ok(html[3].includes("Earlier shared period"));
    assert.ok(html[3].includes("old-period-evidence"));
    assert.ok(html[3].includes("60 $</div>"));
    // The earlier period's table reads like the main one: direction colours,
    // a centred Type column, and a meta line whose items are each isolated.
    const archivedSection = html[3].slice(html[3].indexOf(">Earlier shared period — "));
    assert.ok(
      archivedSection.includes('<th class="c">Type</th>'),
      "archived Type header is centred",
    );
    assert.ok(
      archivedSection.includes('<span class="type gave" dir="auto">Gave</span>') &&
        archivedSection.includes('<td class="n amount gave">'),
      "archived rows are coloured by direction like the main table",
    );
    assert.ok(
      archivedSection.includes(
        '<p class="recordNotes metaLine"><span dir="auto">Shop</span><span class="sep">·</span>' +
          '<span dir="auto">Customer</span><span class="sep">·</span><span dir="ltr">AFN</span></p>',
      ),
      "each item of the archived meta line is isolated, separators apart",
    );

    // Shared chapter membership follows the recorded sequence. Dates entered
    // by the shopkeeper (including a later backdated tally) cannot move a row
    // across a server-confirmed clearance, and cancelled evidence stays saved.
    personTabId = "new-period";
    const sharedEntry = (
      id: string,
      seq: number,
      amount: number,
      type: "debt" | "payment",
      date: number,
    ): Entry => ({
      ...oldRecord,
      id,
      amount_afn: amount,
      type,
      created_at: date,
      tab: {
        ...oldRecord.tab!,
        tab_id: "new-period",
        seq,
        status: "accepted",
        local_pending: false,
      },
    });
    const cancelled = sharedEntry("chapter-cancelled", 3, 99, "debt", 2000);
    cancelled.tab!.voided = true;
    const rejected = sharedEntry("chapter-rejected", 4, 88, "debt", 1000);
    rejected.tab!.status = "disputed";
    const unsent = sharedEntry("chapter-unsent", 0, 0.3, "debt", 0);
    unsent.tab!.local_pending = true;
    fixture.splice(
      0,
      fixture.length,
      sharedEntry("chapter-gave", 1, 0.1, "debt", 4000),
      sharedEntry("chapter-received", 2, 0.1, "payment", 3000),
      cancelled,
      rejected,
      sharedEntry("new-backdated", 5, 0.2, "debt", 1),
      unsent,
    );
    const marker: import("../tabs/types").TabSettlement = {
      id: "current-clearance",
      rev: 7,
      through_seq: 4,
      settled_at_ms: 10_000,
      created_by: "a",
      actor_account_id: "actor-id",
      actor_name: "<Clearer>",
      actor_member_role: "manager",
      semantics_version: "tally-settlement-v1",
    };
    sharedMarkers.set("new-period", [marker]);
    sharedMarkers.set("old-period", [
      {
        ...marker,
        id: "archived-clearance",
        through_seq: 2,
        actor_name: "Archived clearer",
        settled_at_ms: 20_000,
      },
    ]);
    archives[0].entries.push({
      ...oldRecord,
      id: "old-period-repayment",
      type: "payment",
      tab: { ...oldRecord.tab!, seq: 2 },
    });
    const chapterStatement = (await buildPersonStatement("person", "en", "USD", "$", 30_000))!;
    assert.deepEqual(
      chapterStatement.rows.map((row) =>
        row.kind === "entry" ? row.entry.id : row.shared?.settlement.id,
      ),
      [
        "chapter-gave",
        "chapter-received",
        "chapter-cancelled",
        "chapter-rejected",
        "current-clearance",
        "new-backdated",
        "chapter-unsent",
      ],
    );
    assert.equal(
      chapterStatement.balance,
      0.5,
      "boundaries never change the pending-inclusive amount",
    );
    assert.deepEqual(chapterStatement.sharedTotals, {
      acknowledged: 0.2,
      pending: 0.3,
      private: 0,
    });
    assert.equal(chapterStatement.rows[4].balanceAfter, 0);
    assert.equal(chapterStatement.archivedSharedPeriods?.[0].rows.at(-1)?.kind, "settled");
    const chapterCsv = csv.buildPersonCsv(chapterStatement);
    const chapterTable = csvTable(chapterCsv);
    // The note is the document's sentence with the statement's own date; the
    // exact UTC time is evidence and sits in its own column.
    const currentMarker = chapterTable.row("current-clearance");
    assert.deepEqual(
      ["Note", "Recorded at (UTC)", "Shared account ID"].map((column) =>
        chapterTable.cell(currentMarker, column),
      ),
      [`Cleared by <Clearer> on ${day(10_000)}`, "1970-01-01T00:00:10.000Z", "new-period"],
      "a CSV clearance uses the document wording, its time in the evidence columns",
    );
    assert.ok(
      chapterCsv.indexOf(",chapter-cancelled\r\n") < chapterCsv.indexOf(",current-clearance\r\n"),
    );
    assert.ok(
      chapterCsv.indexOf(",current-clearance\r\n") < chapterCsv.indexOf(",new-backdated\r\n"),
    );
    const archivedMarker = chapterTable.row("archived-clearance");
    assert.deepEqual(
      ["Note", "Recorded at (UTC)", "Balance (USD)"].map((column) =>
        chapterTable.cell(archivedMarker, column),
      ),
      [`Cleared by Archived clearer on ${day(20_000)}`, "1970-01-01T00:00:20.000Z", ""],
      "an earlier clearance reads the same and never enters today's balance",
    );
    assert.equal(chapterTable.net("USD"), 0.5, "SUM(Gave) - SUM(Received) is the balance");
    await pdf.renderPersonStatementPdf(chapterStatement, "fixture-shared-chapters.pdf");
    // Each value in the sentence is its own isolate; the UTC time is a
    // separate LTR number; no rule-off row carries the UI chip's dot.
    const isolate = (text: string) =>
      `<span style="unicode-bidi:isolate" dir="auto">${text}</span>`;
    const settledRows = (page: string) => page.match(/<tr class="settled">.*?<\/tr>/g) ?? [];
    const clearedLine = `Cleared by ${isolate("&lt;Clearer&gt;")} on ${isolate(day(10_000))}`;
    assert.ok(html[4].includes(clearedLine), "the clearer and the date are each isolated");
    assert.ok(
      html[4].includes('<span class="num">1970-01-01T00:00:10.000Z</span>'),
      "the exact UTC time is its own LTR-isolated number",
    );
    assert.ok(
      html[4].includes(`Cleared by ${isolate("Archived clearer")} on ${isolate(day(20_000))}`),
      "an earlier period's clearance reads the same",
    );
    assert.equal(
      settledRows(html[4]).length,
      2,
      "one rule-off row per clearance, current and earlier",
    );
    assert.ok(
      settledRows(html[4]).every((row) => !row.includes("·")),
      "no clearance row reuses the dotted UI chip",
    );
    assert.ok(html[4].includes("chapter-cancelled"));
    assert.ok(html[4].indexOf(clearedLine) < html[4].indexOf("new-backdated"));
    const archivedChapters = html[4].slice(html[4].indexOf(">Earlier shared period — "));
    assert.ok(
      archivedChapters.includes('<td class="n amount received">'),
      "an earlier period's payment is coloured as received",
    );

    // The clearer's name is a Google/Apple display name, so Dari script and an
    // EMPTY name are both normal. Both read as a sentence in both languages.
    marker.actor_name = "عبدالله احمدزی";
    sharedMarkers.get("old-period")![0].actor_name = "";
    const namedStatement = (await buildPersonStatement("person", "en", "USD", "$", 30_000))!;
    const faStatement = { ...namedStatement, locale: "fa" as const, calendar: "jalali" as const };
    const faDay = (ms: number) => formatSettlementDate(ms, "fa", "jalali");
    await pdf.renderPersonStatementPdf(namedStatement, "fixture-clearance-en.pdf");
    const enPage = html.at(-1)!;
    await pdf.renderPersonStatementPdf(faStatement, "fixture-clearance-fa.pdf");
    const faPage = html.at(-1)!;
    for (const [page, expected, why] of [
      [
        enPage,
        `Cleared by ${isolate("عبدالله احمدزی")} on ${isolate(day(10_000))}`,
        "en, Dari name",
      ],
      [enPage, `Cleared on ${isolate(day(20_000))} (name not recorded)`, "en, empty name"],
      [
        faPage,
        `صاف‌شده توسط ${isolate("عبدالله احمدزی")} در ${isolate(faDay(10_000))}`,
        "fa, Dari name",
      ],
      [faPage, `صاف‌شده در ${isolate(faDay(20_000))} (نام ثبت نشده)`, "fa, empty name"],
    ] as const) {
      assert.ok(page.includes(expected), `clearance sentence (${why})`);
    }
    for (const row of [...settledRows(enPage), ...settledRows(faPage)]) {
      assert.ok(!row.includes("·"), "no dotted chip in either language");
      assert.ok(!row.includes(isolate("")), "an empty name never leaves an empty slot");
      assert.equal(
        row.split("1970-01-01T").length - 1,
        row.split('<span class="num">1970-01-01T').length - 1,
        "the UTC time appears only as its own LTR number, never inside the sentence",
      );
    }
    const enClearCsv = csvTable(csv.buildPersonCsv(namedStatement));
    const faClearCsv = csvTable(csv.buildPersonCsv(faStatement));
    assert.deepEqual(
      [
        enClearCsv.row("current-clearance")[5],
        enClearCsv.row("archived-clearance")[5],
        faClearCsv.row("current-clearance")[5],
        faClearCsv.row("archived-clearance")[5],
      ],
      [
        `Cleared by عبدالله احمدزی on ${day(10_000)}`,
        `Cleared on ${day(20_000)} (name not recorded)`,
        `صاف‌شده توسط عبدالله احمدزی در ${faDay(10_000)}`,
        `صاف‌شده در ${faDay(20_000)} (نام ثبت نشده)`,
      ],
      "the CSV note uses the same document sentences",
    );

    // Dari evidence: localized roles and side, and the Afghan register (نمبر,
    // as the Entry ID column) for every reference label, never شناسه.
    await pdf.renderPersonStatementPdf(
      { ...sharedStatement, locale: "fa", calendar: "jalali" },
      "fixture-shared-fa.pdf",
    );
    const faEvidence = html.at(-1)!;
    for (const shown of ["ثبت‌کننده", "مدیر", "این طرف"]) {
      assert.ok(faEvidence.includes(`<span dir="auto">${shown}</span>`), `Dari value ${shown}`);
    }
    assert.ok(faEvidence.includes("نمبر حساب بررسی‌کننده: "), "reference labels use نمبر");
    assert.ok(!faEvidence.includes("شناسه"), "no Iranian-register شناسه in a Dari document");
  });

  console.log(`\n${passed} money regression groups passed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
