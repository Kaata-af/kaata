import assert from "node:assert/strict";
import {
  scopePersonStatement,
  scopeVaultReport,
  normalizeExportOptions,
  ExportScopeError,
} from "../export/options";
import type { PersonStatement, VaultReport, StatementRow } from "../export/data";
import { compileUI } from "./ui-fixture";
import Database from "better-sqlite3";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
});
const copy = compileUI("../export-copy", { "./i18n": language });
const evidence = compileUI("../export/evidence", { "../i18n": language });
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const csv = compileUI("../export/csv", {
  "../i18n": language,
  "../export-copy": copy,
  "../jalali": { formatSettlementDate: date },
  "./data": { isoDate: date, shamsiDate: date, qamariDate: date },
  "./note": { noteFor: (note: string) => note, clearanceNote: () => "Settled" },
  "./evidence": evidence,
  "./shared-record": require("../export/shared-record"),
});

const entry = (
  id: string,
  ms: number,
  amount: number,
  type: "debt" | "payment" = "debt",
  tab?: object,
) => ({
  kind: "entry" as const,
  entry: {
    id,
    created_at: ms,
    amount_afn: amount,
    type,
    note: `Description ${id}`,
    currency: "AFN",
    tab,
  },
  balanceAfter: 999,
});
const source = {
  person: { id: "person", name: "Customer", phone: "+93700000000" },
  self: null,
  vaultName: "Shop",
  personDescription: "Purpose of account",
  currencyCode: "AFN",
  currencySymbol: "؋",
  locale: "en",
  calendar: "gregorian",
  generatedAtMs: 5000,
  // Source order deliberately differs from the business date. Clearing a
  // chapter must never shuffle a later backdated tally into that chapter.
  rows: [
    entry("old", 100, 100),
    entry("selected", 300, 40),
    { kind: "settled", ms: 350, balanceAfter: 140 },
    entry("backdated", 150, 10, "payment"),
    entry("pending", 310, 600, "debt", {
      status: "pending",
      tab_id: "tab",
      author_account_id: "private-author-id",
    }),
    entry("accepted", 320, 5, "payment", { status: "accepted", tab_id: "tab" }),
    entry("rejected", 330, 900, "debt", { status: "disputed", tab_id: "tab" }),
    entry("end-exclusive", 400, 50),
    entry("future", 900, 500),
  ],
  balance: 675,
  preLinkRows: [entry("prelink", 300, 3000)],
  archivedSharedPeriods: [
    { link: { currency: "AFN", linked_at: 1 }, rows: [entry("archived", 300, 4000)], entries: [] },
  ],
  notes: [
    {
      id: "note",
      note: " =SUM(A1)",
      noteNumber: "5.00",
      createdAt: 300,
      personId: "person",
      personName: "Customer",
      authorName: "Writer",
    },
    {
      id: "old-note",
      note: "Before range",
      noteNumber: null,
      createdAt: 100,
      personId: "person",
      personName: "Customer",
      authorName: null,
    },
  ],
} as unknown as PersonStatement;
const original = JSON.stringify(source);
const opts = { period: { startMs: 200, endMs: 400 } };
const scoped = scopePersonStatement(source, opts);
assert.equal(scoped.openingBalance, 90);
assert.equal(scoped.balance, 125);
assert.deepEqual(scoped.periodTotals, { gave: 40, received: 5 });
assert.deepEqual(
  scoped.rows.map((row) => (row.kind === "entry" ? [row.entry.id, row.balanceAfter] : "settled")),
  [
    ["selected", 130],
    ["pending", 130],
    ["accepted", 125],
    ["rejected", 125],
  ],
);
assert.equal(scoped.sharedTotals?.pending, 600);
assert.equal(scoped.sharedTotals?.acknowledged, -5);
assert.equal(scoped.notes, undefined, "internal notes are opt-in");
assert.equal(scoped.personDescription, undefined, "customer descriptions stay private by default");
assert.equal(scoped.preLinkRows, undefined);
assert.equal(scoped.archivedSharedPeriods, undefined);
assert.equal(scoped.hasEarlierHistory, true, "standard statements disclose omitted earlier books");
assert.equal(
  scopePersonStatement({ ...source, preLinkRows: [], archivedSharedPeriods: [] }).hasEarlierHistory,
  false,
  "ordinary accounts do not acquire an earlier-history notice",
);
assert.equal(JSON.stringify(source), original, "projection never edits receipts or source rows");
const all = scopePersonStatement(source);
assert.equal(all.openingBalance, 0);
assert.equal(all.balance, 675);
assert.equal(all.rows[2].kind, "settled");
const empty = scopePersonStatement(source, { period: { startMs: 600, endMs: 800 } });
assert.equal(empty.rows.length, 0);
assert.equal(empty.balance, 175, "no activity retains the carried balance");
assert.equal(empty.openingBalance, 175);
assert.throws(() => normalizeExportOptions({ period: { startMs: 10, endMs: 10 } }), /after/);
assert.throws(() => normalizeExportOptions({ period: { startMs: NaN } }), /Invalid/);

function table(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if (ch === "\r" && input[i + 1] === "\n" && !quoted) {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += ch;
  }
  return rows;
}
for (const detail of ["standard", "detailed"] as const) {
  const optOut = { ...source, exportOptions: { detail, includeNotes: false } };
  assert.ok(
    !csv.buildPersonCsv(optOut).includes("SUM(A1)"),
    "CSV renderer itself honors internal-note opt-out",
  );
  for (const calendar of ["gregorian", "jalali", "qamari"] as const) {
    const selected = scopePersonStatement(
      { ...source, calendar },
      { ...opts, detail, includeNotes: true },
    );
    assert.equal(selected.personDescription, "Purpose of account");
    const rows = table(csv.buildPersonCsv(selected));
    assert.ok(
      rows.every((row) => row.length === rows[0].length),
      `${detail}/${calendar} has rectangular rows`,
    );
    assert.equal(rows[0].at(-1), "Entry ID");
    const note = rows.find((row) => row.at(-1) === "note")!;
    assert.equal(note[rows[0].indexOf(copy.tExportIn("en", "noteNumber"))], "5.00");
    const balance = rows[0].findIndex((label) => /^Balance(?: \(AFN\))?$/.test(label));
    const gave = rows[0].findIndex((label) => /^Gave(?: \(AFN\))?$/.test(label));
    const received = rows[0].findIndex((label) => /^Received(?: \(AFN\))?$/.test(label));
    assert.equal(note[balance], "");
    assert.equal(note[gave], "");
    assert.equal(note[received], "");
    assert.equal(
      note[rows[0].indexOf(copy.tExportIn("en", "customerDetails"))],
      "Purpose of account",
    );
    assert.equal(
      rows.slice(1).reduce((sum, row) => sum + Number(row[gave]) - Number(row[received]), 90),
      125,
    );
    if (detail === "standard") {
      assert.ok(rows[0].length < 20);
      assert.ok(!csv.buildPersonCsv(selected).includes("private-author-id"));
      const pending = rows.find((row) => row.at(-1) === "pending")!;
      assert.equal(pending[gave], "");
      assert.equal(pending[rows[0].indexOf("Recorded amount")], "600");
      assert.ok(
        note.some((cell) => cell.startsWith("\t =")),
        "whitespace-prefixed formulas are protected",
      );
    } else {
      assert.ok(csv.buildPersonCsv(selected).includes("private-author-id"));
      assert.ok(rows.some((row) => row.at(-1) === "prelink"));
      assert.ok(rows.some((row) => row.at(-1) === "archived"));
    }
  }
}

const journal = source.rows.flatMap((row) =>
  row.kind === "entry"
    ? [
        {
          ...row.entry,
          person_id: "person",
          person_name: "Customer",
          person_phone: "+93700000000",
          kind: "entry",
          balanceAfter: 999,
        },
      ]
    : [],
);
const vault = {
  vaultName: "Shop",
  self: null,
  currencyCode: "AFN",
  currencySymbol: "؋",
  locale: "en",
  calendar: "gregorian",
  generatedAtMs: 5000,
  people: [
    {
      id: "person",
      name: "Customer",
      phone: "+93700000000",
      balance: 675,
      entryCount: journal.length,
      lastEntryAt: 900,
    },
  ],
  journal,
  totals: { collect: 675, pay: 0, net: 675 },
  notes: source.notes,
} as VaultReport;
for (const detail of ["standard", "detailed"] as const) {
  const scopedReport = scopeVaultReport(vault, { ...opts, detail, includeNotes: true });
  assert.equal(scopedReport.people[0].openingBalance, 90);
  assert.equal(scopedReport.people[0].balance, 125);
  assert.deepEqual(scopedReport.totals, { collect: 125, pay: 0, net: 125 });
  assert.deepEqual(scopedReport.periodTotals, { gave: 40, received: 5 });
  assert.equal(scopedReport.notes?.length, 1);
  const rows = table(csv.buildVaultCsv(scopedReport));
  assert.ok(
    rows.every((row) => row.length === rows[0].length),
    `${detail} vault table is rectangular`,
  );
}
const noActivity = scopeVaultReport(vault, { period: { startMs: 600, endMs: 800 } });
assert.equal(noActivity.journal.length, 0);
assert.equal(noActivity.people[0].balance, 175);
assert.equal(noActivity.people[0].lastEntryAt, 400, "future activity never enters an as-of report");
const secondCurrency = scopePersonStatement(
  { ...source, currencyCode: "USD", currencySymbol: "$" },
  { ...opts, includeNotes: true },
);
const multi = table(
  csv.buildPersonCurrenciesCsv([scopePersonStatement(source, opts), secondCurrency]),
);
assert.ok(multi.every((row) => row.length === multi[0].length));
assert.ok(multi.some((row) => row.includes("USD")) && multi.some((row) => row.includes("AFN")));
const openingDay = new Date(2026, 10, 10).getTime();
const sharedOpening = {
  ...source,
  rows: [
    entry("shared-opening", openingDay + 1000, 500, "debt", {
      kind: "opening",
      status: "accepted",
    }),
  ] as StatementRow[],
};
assert.throws(
  () => scopePersonStatement(sharedOpening, { period: { startMs: openingDay - 86400000 } }),
  (error: unknown) => error instanceof ExportScopeError && error.code === "beforeSharedOpening",
  "a prior-book cutoff cannot masquerade as a zero opening balance",
);
assert.throws(
  () => scopePersonStatement(sharedOpening, { period: { endMs: openingDay } }),
  ExportScopeError,
);
assert.equal(scopePersonStatement(sharedOpening).balance, 500, "all history remains available");
assert.equal(
  scopePersonStatement(sharedOpening, { period: { startMs: openingDay } }).balance,
  500,
  "the opening day's complete current book remains available",
);
const pendingOpening = {
  ...sharedOpening,
  rows: [
    entry("pending-opening", openingDay + 1000, 500, "debt", {
      kind: "opening",
      status: "pending",
    }),
  ] as StatementRow[],
};
assert.equal(
  scopePersonStatement(pendingOpening, { period: { startMs: openingDay - 86400000 } }).balance,
  0,
  "pending replacements do not make an established history inaccessible",
);
async function verifySnapshotAndHandoff() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE relationships(id TEXT,vault_id TEXT,user_b_id TEXT,note TEXT,created_at INTEGER,archived_at INTEGER);
    CREATE TABLE users(id TEXT,display_name TEXT);
    CREATE TABLE tally_notes(id TEXT,vault_id TEXT,relationship_id TEXT,note TEXT,number_text TEXT,created_at INTEGER,author_account_id TEXT,author_device_id TEXT,removed_at INTEGER);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,display_name TEXT);
    CREATE TABLE vault_device_registry(vault_id TEXT,device_id TEXT,account_id TEXT,removed_at_ms INTEGER,added_at_ms INTEGER);
    INSERT INTO users VALUES('person','Customer');
    INSERT INTO relationships VALUES('r','vault','person','Current description',2,NULL);
    INSERT INTO relationships VALUES('other','other-vault','person','Never share another book',1,NULL);
    INSERT INTO tally_notes VALUES('n','vault','r','Please check','12.50',300,'writer',NULL,NULL);
    INSERT INTO tally_notes VALUES('deleted','vault','r','Deleted note',NULL,300,'writer',NULL,400);
    INSERT INTO tally_notes VALUES('wrong-vault','other-vault','other','Other book note',NULL,300,'writer',NULL,NULL);
    INSERT INTO vault_members_mirror VALUES('vault','writer','Note author');
  `);
  let shares = 0;
  const data = compileUI("../export/data", {
    "expo-file-system": {},
    "expo-sharing": {
      shareAsync: async () => {
        shares++;
      },
    },
    "react-native": { Platform: { OS: "android" } },
    "kaata-save-file": {},
    "../calendar": { getEffectiveCalendar: () => "gregorian" },
    "../currency": { getCurrencySymbol: () => "؋" },
    "../db": {
      getDb: async () => ({
        getAllAsync: async (sql: string, ...params: any[]) => db.prepare(sql).all(...params),
      }),
      getLocalSelf: async () => ({ name: "Staff member", shop_name: "Actual Kaata" }),
      getPerson: async () => source.person,
      listEntries: async () => [],
      listEntriesForExport: async () => journal,
      listSettlementBoundaries: async () => [],
      listArchivedSharedPeriodsForExport: async () => [],
      listLedgerCurrencies: async () => ["AFN"],
    },
    "../jalali": {},
    "../money": require("../money"),
    "../entry-date": require("../entry-date"),
    "./shared-record": require("../export/shared-record"),
    "../tabs/db": { getFinancialTabLinkForPerson: async () => null },
    "../tabs/chapters": {},
    "../projection": { applyEventMutex: { runExclusive: (fn: () => unknown) => fn() } },
    "../currency-totals": require("../currency-totals"),
  });
  try {
    const statements = await data.buildPersonStatements("person", "vault", "en", 5000, {
      includeNotes: true,
    });
    assert.equal(statements[0].vaultName, "Actual Kaata");
    assert.equal(statements[0].personDescription, "Current description");
    assert.deepEqual(statements[0].notes, [
      {
        id: "n",
        note: "Please check",
        noteNumber: "12.50",
        createdAt: 300,
        personId: "person",
        personName: "Customer",
        authorName: "Note author",
      },
    ]);
    const reports = await data.buildVaultReports("vault", "Requested Kaata", "AFN", "en", 5000, {
      includeNotes: true,
    });
    assert.equal(reports[0].people[0].description, "Current description");
    assert.equal(reports[0].notes.length, 1);
    db.prepare("UPDATE relationships SET note='' WHERE id='r'").run();
    const cleared = await data.buildPersonStatements("person", "vault", "en", 5000, {
      includeNotes: true,
    });
    assert.equal(cleared[0].personDescription, undefined, "cleared descriptions stay absent");
    const normal = await data.buildPersonStatements("person", "vault", "en", 5000);
    assert.equal(normal[0].notes, undefined);
    assert.equal(normal[0].personDescription, undefined);
    await assert.rejects(
      data.shareExportFile("file:///statement.pdf", "pdf", () => {
        throw new Error("account changed");
      }),
      /account changed/,
    );
    assert.equal(shares, 0, "session guard runs after sheet teardown and before native disclosure");
  } finally {
    db.close();
  }
  console.log(
    "PASS export scopes: opening/closing arithmetic, immutable receipts, shared cutovers, notes privacy, scoped snapshots, CSV currencies and share guards",
  );
}
void verifySnapshotAndHandoff();
