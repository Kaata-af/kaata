import assert from "node:assert/strict";
import { assertSingleCurrency } from "../currency-totals";
import { compileUI } from "./ui-fixture";
import type { Entry } from "../types";
import { formatSettlementDate, toJalali, toQamari } from "../jalali";

const ledger = [
  { id: "afn-gave", currency: "AFN", type: "debt", amount_afn: 5000, created_at: 1000 },
  { id: "usd-received", currency: "USD", type: "payment", amount_afn: 20, created_at: 2000 },
].map((row) => ({
  ...row,
  relationship_id: "r",
  person_id: "p",
  person_name: "Customer",
  person_phone: null,
  note: "Line one\nLine two",
  kind: "entry",
  deleted_at: null,
  disputed_at: null,
  updated_at: row.created_at,
  proposed_by_user_id: null,
  accepted_at: null,
  disputed_reason: null,
  settled_at: null,
}));
const symbols = { AFN: "؋", USD: "$", EUR: "€" };
const calls: [string, string | undefined][] = [];
let calendar: "gregorian" | "qamari" = "gregorian";
let changeCalendarWhileListing = false;
let linked = false;
let invalidPreLinkCurrency = false;
let waitingSharedHistory = false;
const scoped = (code: string) => ledger.filter((entry) => entry.currency === code);
const preLinkHistory = [
  { ...ledger[1], id: "before-gave", type: "debt", amount_afn: 100, created_at: 1500 },
  { ...ledger[1], id: "before-received", type: "payment", amount_afn: 30, created_at: 1600 },
];
const money = require("../money");
const records = require("../export/shared-record");
const exportFiles = new Map<string, string>();
class ExportDirectory {
  constructor(..._parts: unknown[]) {}
  create() {}
}
class ExportFile {
  uri: string;
  constructor(_directory: ExportDirectory, name: string) {
    this.uri = `file:///exports/${name}`;
  }
  get exists() {
    return exportFiles.has(this.uri);
  }
  delete() {
    exportFiles.delete(this.uri);
  }
  writeSync(contents: string, options?: { encoding?: string }) {
    exportFiles.set(
      this.uri,
      options?.encoding === "base64"
        ? Buffer.from(contents, "base64").toString("latin1")
        : contents,
    );
  }
}
const data = compileUI("../export/data", {
  "expo-file-system": {
    Directory: ExportDirectory,
    File: ExportFile,
    Paths: { cache: "file:///cache" },
  },
  "expo-sharing": {},
  "react-native": { Platform: { OS: "android" } },
  "kaata-save-file": {},
  "../calendar": { getEffectiveCalendar: () => calendar },
  "../currency": { getCurrencySymbol: (code: keyof typeof symbols) => symbols[code] },
  "../db": {
    listLedgerCurrencies: async () => {
      if (changeCalendarWhileListing) calendar = "qamari";
      return ["AFN", "USD", "EUR", "AFN"];
    },
    getLocalSelf: async () => null,
    listEntriesForExport: async (_id: string, code: string) => {
      calls.push(["journal", code]);
      return scoped(code);
    },
    getPerson: async (_id: string, code: string) => ({
      id: "p",
      name: "Customer",
      currency: code,
      tab_id: linked && code === "USD" ? "shared-usd" : null,
      tab_unsynced: linked && code === "USD" && waitingSharedHistory ? 1 : 0,
    }),
    listEntries: async (_id: string, code: string) => {
      calls.push(["entries", code]);
      if (linked && code === "USD")
        return [
          ...scoped(code),
          {
            ...ledger[1],
            id: "shared-opening",
            type: "debt",
            amount_afn: 70,
            created_at: 1800,
            tab: {
              tab_id: "shared-usd",
              seq: 1,
              recorded_at: 1800,
              status: "accepted",
              kind: "opening",
              by: "me",
              dispute_reason: null,
              voided: false,
              local_pending: false,
              other_label: "Customer",
            },
          },
        ];
      return scoped(code);
    },
    listSettlementBoundaries: async (_id: string, code: string) => {
      calls.push(["settlements", code]);
      return linked && code === "USD" ? [1550] : [];
    },
    listArchivedSharedPeriodsForExport: async () => [],
  },
  "../jalali": { toJalali, toQamari },
  "../money": money,
  "./shared-record": records,
  "../tabs/db": {
    getFinancialTabLinkForPerson: async (_id: string, code: string) =>
      linked && code === "USD" ? { tab_id: "shared-usd", currency: "USD" } : null,
    getTabLink: async () => ({ tab_id: "shared-usd", currency: "USD" }),
    listPreLinkEntries: async () =>
      [...preLinkHistory]
        .reverse()
        .map((entry) => (invalidPreLinkCurrency ? { ...entry, currency: "AFN" } : entry)),
    listTabSettlements: async () => [],
  },
  "../tabs/chapters": {},
  "../projection": { applyEventMutex: { runExclusive: (work: () => unknown) => work() } },
  "../currency-totals": { assertSingleCurrency },
}) as typeof import("../export/data");
const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const csv = compileUI("../export/csv", {
  "../i18n": language,
  "./data": data,
  "../jalali": { formatSettlementDate },
  "./note": { noteFor: (note: string) => note, clearanceNote: () => "cleared" },
  "./evidence": { EVIDENCE_KEYS: [], evidenceCells: () => [], evidenceTime: String },
  "./shared-record": records,
}) as typeof import("../export/csv");
const pages: string[] = [];
let moves = 0;
let duringPrint = () => {};
let expoGo = false;
let missingPrintedBytes = false;
const samplePdfBytes = "%PDF-1.7\nSynthetic export fixture";
class PrintedFile {
  constructor(public uri: string) {}
  async base64() {
    return "AA==";
  }
  async move(target: { uri: string }) {
    await Promise.resolve();
    this.uri = target.uri;
    moves++;
  }
}
const pdf = compileUI("../export/pdf", {
  "expo-asset": {
    Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "font" }) },
  },
  "expo-file-system": { File: PrintedFile },
  "expo-print": {
    printToFileAsync: async ({ html, base64 }: { html: string; base64?: boolean }) => {
      pages.push(html);
      duringPrint();
      return {
        uri: "printed",
        base64:
          base64 && !missingPrintedBytes
            ? Buffer.from(samplePdfBytes).toString("base64")
            : undefined,
      };
    },
  },
  "@expo-google-fonts/vazirmatn": { Vazirmatn_400Regular: 1, Vazirmatn_700Bold: 2 },
  "../colors": require("../colors"),
  "../expo-go": {
    get IS_EXPO_GO() {
      return expoGo;
    },
  },
  "../format": {
    formatAmount: (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 8 }),
  },
  "../mobile-copy": { tExtraIn: (_locale: string, key: string) => key },
  "../i18n": language,
  "../jalali": require("../jalali"),
  "../money": money,
  "./data": data,
  "./note": { noteFor: (note: string) => note, clearanceNote: () => "cleared" },
  "./evidence": {
    EVIDENCE_KEYS: [],
    evidenceCells: () => [],
    evidenceTime: String,
    recordStatus: () => "pending",
  },
  "./shared-record": records,
}) as typeof import("../export/pdf");

// Read CSV as cells rather than splitting lines: notes contain real newlines.
function table(contents: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  const text = contents.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      i++;
    } else value += char;
  }
  return rows;
}

async function main() {
  for (const nativeModule of [{}, null]) {
    const runtime = compileUI("../expo-go", {
      "expo-modules-core": {
        requireOptionalNativeModule: (name: string) => {
          assert.equal(name, "ExpoGo");
          return nativeModule;
        },
      },
    });
    assert.equal(
      runtime.IS_EXPO_GO,
      nativeModule !== null,
      "native Go detection works without depending on legacy executionEnvironment metadata",
    );
  }
  // SDK 58 File.write() is asynchronous. A returned export must already have
  // its bytes so the immediate share/save call cannot see an empty file.
  const written = data.writeExportFile("currencies.csv", "currency,amount\nUSD,20");
  assert.equal(exportFiles.get(written.uri), "currency,amount\nUSD,20");
  const replaced = data.writeExportFile("currencies.csv", "currency,amount\nAFN,5000");
  assert.equal(exportFiles.get(replaced.uri), "currency,amount\nAFN,5000");
  const reports = await data.buildVaultReports("vault", "Shop", "AFN", "en", 3000);
  assert.deepEqual(
    reports.map((report) => [report.currencyCode, report.totals]),
    [
      ["AFN", { collect: 5000, pay: 0, net: 5000 }],
      ["USD", { collect: 0, pay: 20, net: -20 }],
    ],
  );
  assert.deepEqual(
    reports.map((report) => report.journal[0].balanceAfter),
    [5000, -20],
  );
  const rows = table(csv.buildVaultCurrenciesCsv(reports));
  const currency = rows[0].indexOf(language.tIn("en", "export.record.currency"));
  const balance = rows[0].indexOf(language.tIn("en", "export.col.balance"));
  assert.ok(currency >= 0 && balance >= 0);
  assert.deepEqual(
    rows.slice(1).map((row) => [row[currency], row[balance], row.at(-1)]),
    [
      ["AFN", "5000", "afn-gave"],
      ["USD", "-20", "usd-received"],
    ],
  );
  assert.ok(rows.every((row) => row.length === rows[0].length));
  const statement = await data.buildPersonStatement("p", "en", "USD", "$", 3000);
  assert.equal(statement?.balance, -20);
  assert.equal(statement?.rows.length, 1);
  assert.equal(statement?.currencyCode, "USD");
  assert.ok(calls.some(([kind, code]) => kind === "settlements" && code === "USD"));
  const statements = await data.buildPersonStatements("p", "vault", "en", 3000);
  assert.deepEqual(
    statements.map((item) => [item.currencyCode, item.balance]),
    [
      ["AFN", 5000],
      ["USD", -20],
    ],
    "the customer statement includes every populated currency and omits empty denominations",
  );
  const personRows = table(csv.buildPersonCurrenciesCsv(statements));
  const personCurrency = personRows[0].indexOf(language.tIn("en", "export.record.currency"));
  const personBalance = personRows[0].indexOf(language.tIn("en", "export.col.balance"));
  assert.deepEqual(
    personRows.slice(1).map((row) => [row[personCurrency], row[personBalance], row.at(-1)]),
    [
      ["AFN", "5000", "afn-gave"],
      ["USD", "-20", "usd-received"],
    ],
  );
  assert.ok(personRows.every((row) => row.length === personRows[0].length));
  assert.equal(
    csv.buildPersonCurrenciesCsv([statements[0]]),
    csv.buildPersonCsv(statements[0]),
    "single-currency CSV keeps its existing file contract",
  );
  changeCalendarWhileListing = true;
  const stableReportDates = await data.buildVaultReports("vault", "Shop", "AFN", "en", 3000);
  assert.deepEqual(
    stableReportDates.map((item) => item.calendar),
    ["gregorian", "gregorian"],
    "one calendar snapshot keeps all Kaata report date columns aligned",
  );
  calendar = "gregorian";
  const stableDates = await data.buildPersonStatements("p", "vault", "fa", 3000);
  assert.deepEqual(
    stableDates.map((item) => item.calendar),
    ["gregorian", "gregorian"],
    "one captured calendar keeps all currency/date columns consistent during a setting change",
  );
  changeCalendarWhileListing = false;
  calendar = "gregorian";
  linked = true;
  const linkedStatements = await data.buildPersonStatements("p", "vault", "en", 3000);
  const linkedUsd = linkedStatements.find((statement) => statement.currencyCode === "USD")!;
  assert.equal(linkedUsd.balance, 50, "the carried opening and current payment count once");
  assert.deepEqual(linkedUsd.sharedTotals, { acknowledged: 70, pending: 0, private: -20 });
  assert.deepEqual(
    linkedUsd.preLinkRows?.map((row) =>
      row.kind === "entry"
        ? [row.entry.id, row.entry.created_at, row.balanceAfter]
        : ["settled", row.ms, row.balanceAfter],
    ),
    [
      ["before-gave", 1500, 100],
      ["settled", 1550, 100],
      ["before-received", 1600, 70],
    ],
    "private history retains its business dates, chapters and independent running balance",
  );
  assert.equal(
    linkedUsd.rows.filter((row) => row.kind === "entry").length,
    2,
    "historical private rows never enter the current ledger",
  );
  invalidPreLinkCurrency = true;
  await assert.rejects(
    data.buildPersonStatements("p", "vault", "en", 3000),
    /different currencies/,
  );
  invalidPreLinkCurrency = false;
  waitingSharedHistory = true;
  await assert.rejects(data.buildPersonStatements("p", "vault", "en", 3000), /still syncing/);
  waitingSharedHistory = false;
  linked = false;
  const usdEntry = statements[1].rows.find((row) => row.kind === "entry")!.entry;
  const pending: (typeof statements)[number] = {
    ...statements[1],
    balance: 0,
    sharedTotals: undefined,
    rows: [
      {
        kind: "entry" as const,
        balanceAfter: 0,
        entry: {
          ...usdEntry,
          tab: {
            status: "pending",
            kind: "entry",
            by: "me",
            dispute_reason: null,
            voided: false,
            local_pending: true,
            other_label: "Customer",
          },
        },
      },
    ],
  };
  const sharedRows = table(csv.buildPersonCurrenciesCsv([statements[0], pending]));
  assert.ok(
    sharedRows.every((row) => row.length === sharedRows[0].length),
    "private and shared currencies use one aligned machine table",
  );
  const column = (key: Parameters<typeof language.tIn>[1]) =>
    sharedRows[0].indexOf(language.tIn("en", key));
  assert.equal(sharedRows[1][column("export.record.privateBalance")], "5000");
  assert.equal(sharedRows[2][column("export.record.currency")], "USD");
  assert.equal(sharedRows[2][column("export.record.pendingBalance")], "-20");
  assert.equal(sharedRows[2][column("export.col.balance")], "0");
  await pdf.renderPersonCurrenciesPdf(statements, "customer.pdf");
  const html = pages.at(-1)!;
  const summaryLabel = language.tIn("en", "export.doc.summarySection");
  assert.ok(html.includes(summaryLabel + " — AFN") && html.includes(summaryLabel + " — USD"));
  assert.ok(html.includes("5,000 ؋") && html.includes("-20 $"));
  assert.ok(!html.includes("4,980"), "no converted or cross-currency total appears");
  assert.equal((html.match(/<article/g) ?? []).length, 2);
  assert.equal(moves, 1, "the PDF exists at its target before it is returned");
  expoGo = true;
  const goPdf = await pdf.renderPersonCurrenciesPdf(linkedStatements, "customer-expo-go.pdf");
  assert.equal(
    exportFiles.get(goPdf.uri),
    samplePdfBytes,
    "Expo Go writes real PDF bytes into its scoped cache before returning",
  );
  assert.equal(moves, 1, "Expo Go never reads or moves the inaccessible native print URI");
  missingPrintedBytes = true;
  await assert.rejects(pdf.renderPersonCurrenciesPdf(statements, "missing-pdf.pdf"), /unavailable/);
  missingPrintedBytes = false;
  expoGo = false;

  let activeVault = "vault";
  const outputs: any[] = [];
  let switchWhileReading = false;
  const api = compileUI("../export/index", {
    "../db-tx": { getAccountIdSync: () => "account", getActiveVaultIdSyncMaybe: () => activeVault },
    "../i18n": { getLocale: () => "en" },
    "./data": {
      ...data,
      buildPersonStatements: async (...args: Parameters<typeof data.buildPersonStatements>) => {
        const result = await data.buildPersonStatements(...args);
        if (switchWhileReading) activeVault = "other-vault";
        return result;
      },
      shareExportFile: async (uri: string, kind: string) => outputs.push({ uri, kind }),
      saveExportFile: async (file: any) => {
        outputs.push(file);
        return { via: "downloads", name: file.fileName };
      },
    },
    "./csv": csv,
    "./pdf": pdf,
  }) as typeof import("../export");
  await api.exportPersonStatement("p", "csv", "share");
  const exported = table(exportFiles.get(outputs.at(-1).uri)!);
  assert.deepEqual(
    exported.slice(1).map((row) => row[personCurrency]),
    ["AFN", "USD"],
    "the unchanged public customer export API exports all currencies",
  );
  await api.exportPersonStatement("p", "pdf", "save");
  assert.equal(outputs.at(-1).kind, "pdf");
  assert.ok(outputs.at(-1).source.uri.endsWith(".pdf"));
  assert.equal(moves, 2);
  switchWhileReading = true;
  const before = outputs.length;
  await assert.rejects(api.exportPersonStatement("p", "csv", "share"), /active Kaata changed/);
  assert.equal(outputs.length, before, "a scope change cannot share another book's data");
  activeVault = "vault";
  switchWhileReading = false;
  duringPrint = () => {
    activeVault = "other-vault";
  };
  await assert.rejects(api.exportPersonStatement("p", "pdf", "share"), /active Kaata changed/);
  assert.equal(
    outputs.length,
    before,
    "a scope change during native PDF rendering cannot share late data",
  );
  assert.throws(() => assertSingleCurrency(ledger), /different currencies/);
  assert.throws(() => assertSingleCurrency([ledger[1]], "AFN"), /different currencies/);
  const { summarizeTallyFlows } = require("../tally-summary") as typeof import("../tally-summary");
  assert.throws(() => summarizeTallyFlows(ledger as Entry[]), /different currencies/);
  console.log(
    "PASS: separate currency reports, complete customer CSV/PDF exports, per-code balances, shared/private alignment, scope guards and synchronous file writes",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
