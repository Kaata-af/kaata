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
    const { buildPersonStatement, buildVaultReport } = withModuleStubs(
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
        "../db": {
          getPerson: async () => ({ id: "person", name: "Fixture", balance: 0 }),
          listEntries: async () => [...fixture].reverse(),
          listSettlementBoundaries: async () => [3000],
          getLocalSelf: async () => null,
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

    // A linked contact keeps rejected/voided rows on screen, but a statement
    // must omit them and calculate its running balance from counted rows only.
    const reviewed: Entry = {
      ...fixture[0], id: "reviewed", amount_afn: 100, created_at: 5000,
      tab: { by: "them", status: "disputed", kind: "entry", dispute_reason: null,
        voided: false, local_pending: false, other_label: "Other shop" },
    };
    fixture.push(reviewed, { ...reviewed, id: "voided", tab: { ...reviewed.tab!, status: "accepted", voided: true } });
    const rejectedStatement = await buildPersonStatement("person", "en", "USD", "$", 6000);
    assert.ok(rejectedStatement);
    assert.equal(rejectedStatement.balance, 0);
    assert.ok(rejectedStatement.rows.every((r) => r.kind !== "entry" || !["reviewed", "voided"].includes(r.entry.id)));
    reviewed.tab!.status = "accepted";
    const acceptedStatement = await buildPersonStatement("person", "en", "USD", "$", 6000);
    assert.equal(acceptedStatement?.balance, 100, "re-accepting restores exactly one amount");
  });

  console.log(`\n${passed} money regression groups passed.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
