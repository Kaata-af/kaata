import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";
import type { PersonStatement, VaultReport } from "../export/data";
import { scopePersonStatement, scopeVaultReport } from "../export/options";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
});
const html: string[] = [];
const printOptions: Array<{ width: number; height: number; margins?: object; base64?: boolean }> =
  [];
const platform = { OS: "android" };
const environment = { IS_EXPO_GO: false };
const moves: string[] = [];
const writes: string[] = [];
class TestFile {
  constructor(public uri: string) {}
  async base64() {
    return "AA==";
  }
  writeSync(value: string) {
    writes.push(value);
  }
  async move(target: TestFile) {
    await Promise.resolve();
    moves.push(target.uri);
    this.uri = target.uri;
  }
}
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pdf = compileUI("../export/pdf", {
  "react-native": { Platform: platform },
  "expo-asset": {
    Asset: { fromModule: () => ({ downloadAsync: async () => {}, localUri: "font" }) },
  },
  "expo-file-system": { File: TestFile },
  "expo-print": {
    printToFileAsync: async (options: { html: string; width: number; height: number }) => {
      html.push(options.html);
      printOptions.push(options);
      return { uri: "printed.pdf", base64: "PDF_BYTES" };
    },
  },
  "@expo-google-fonts/vazirmatn": { Vazirmatn_400Regular: 1, Vazirmatn_700Bold: 2 },
  "../colors": require("../colors"),
  "../expo-go": environment,
  "../format": { formatAmount: (n: number) => String(Math.abs(n)) },
  "../mobile-copy": { tExtraIn: () => "Powered by Kaata" },
  "../i18n": language,
  "./note": { noteFor: (note: string) => note, clearanceNote: () => "Cleared" },
  "../jalali": { formatSettlementDate: date, faDigits: String },
  "../money": require("../money"),
  "./data": { exportFileTarget: (name: string) => new TestFile(name) },
  "./evidence": compileUI("../export/evidence", { "../i18n": language }),
  "./shared-record": require("../export/shared-record"),
  "./pdf-copy": require("../export/pdf-copy"),
});

const entries = [
  { id: "earlier", created_at: 10, type: "debt", amount_afn: 100, note: "Before period" },
  {
    id: "sale",
    created_at: 30,
    type: "debt",
    amount_afn: 40,
    note: "Rice <script>unsafe</script>",
  },
  { id: "payment", created_at: 40, type: "payment", amount_afn: 5, note: "Cash received" },
  {
    id: "pending",
    created_at: 50,
    type: "debt",
    amount_afn: 600,
    note: "Pending example",
    tab: { status: "pending", tab_id: "private-tab-id", author_account_id: "private-author-id" },
  },
  {
    id: "disputed",
    created_at: 60,
    type: "debt",
    amount_afn: 900,
    note: "Rejected example",
    tab: { status: "disputed", tab_id: "private-tab-id", author_account_id: "private-author-id" },
  },
  {
    id: "pending-payment",
    created_at: 61,
    type: "payment",
    amount_afn: 30,
    note: "Pending receipt",
    tab: { status: "pending", tab_id: "private-tab-id" },
  },
];
const source = {
  person: { id: "p1", name: "Ahmad", phone: "+93700000000" },
  vaultName: "Example shop",
  self: null,
  currencyCode: "AFN",
  currencySymbol: "؋",
  locale: "en",
  calendar: "gregorian",
  generatedAtMs: 100,
  rows: entries.map((entry) => ({ kind: "entry", entry, balanceAfter: 0 })),
  balance: 135,
  personDescription: "Private customer description",
  notes: [
    {
      id: "n1",
      note: "Internal note text",
      noteNumber: "12.5",
      createdAt: 55,
      personId: "p1",
      personName: "Ahmad",
      authorName: "Writer",
    },
  ],
} as unknown as PersonStatement;
async function main() {
  const options = { period: { startMs: 20, endMs: 70 } };
  await pdf.renderPersonStatementPdf(scopePersonStatement(source, options), "statement.pdf");
  const standard = html.at(-1)!;
  assert.ok(standard.includes("Rice &lt;script&gt;unsafe&lt;/script&gt;"));
  assert.ok(!standard.includes("<script>"));
  assert.ok(!standard.includes("private-author-id"));
  assert.ok(!standard.includes("private-tab-id"));
  assert.ok(!standard.includes("Internal note text"));
  assert.ok(!standard.includes("Private customer description"));
  assert.ok(standard.replace(/<[^>]*>/g, "").includes("Ahmad owes Example shop"));
  assert.ok(standard.includes("135 AFN"));
  assert.ok(standard.includes("Opening balance"));
  for (const note of ["Pending example", "Rejected example", "Pending receipt"]) {
    const row = standard
      .match(new RegExp(`<tr>[^]*?${note}[^]*?</tr>`, "g"))
      ?.at(-1)
      ?.split("<tr>")
      .at(-1)!;
    assert.ok(row, `record ${note} remains visible`);
    assert.match(row, /<td class="n amount[^"]*">—<\/td>\s*<td class="n amount[^"]*">—<\/td>/);
    assert.match(row, /<td class="n bal"><span class="num">135<\/span><\/td>/);
    assert.ok(
      row.includes(note === "Pending receipt" ? "Received" : "Gave"),
      "unconfirmed record retains its direction",
    );
  }
  assert.deepEqual(moves, ["statement.pdf"], "await native file move before returning");

  await pdf.renderPersonStatementPdf(
    scopePersonStatement(source, { ...options, detail: "detailed", includeNotes: true }),
    "detailed.pdf",
  );
  const detailed = html.at(-1)!;
  assert.ok(detailed.includes("private-author-id"));
  assert.ok(detailed.includes("private-tab-id"));
  assert.ok(detailed.includes("Internal note text"));
  assert.ok(detailed.includes("Private customer description"));
  assert.ok(detailed.includes("12.5"));
  assert.ok(detailed.includes("135 AFN"), "notes cannot change headline money");
  assert.ok(detailed.includes("Notes and their optional numbers do not affect balances"));

  const report = {
    vaultName: "Example shop",
    self: null,
    currencyCode: "AFN",
    currencySymbol: "؋",
    locale: "en",
    calendar: "gregorian",
    generatedAtMs: 100,
    people: [
      { id: "p1", name: "Ahmad", phone: null, entryCount: 5, balance: 135, lastEntryAt: 60 },
    ],
    journal: entries.map((entry) => ({
      ...entry,
      person_id: "p1",
      person_name: "Ahmad",
      person_phone: null,
      balanceAfter: 0,
    })),
    totals: { collect: 135, pay: 0, net: 135 },
  } as unknown as VaultReport;
  await pdf.renderVaultReportPdf(
    scopeVaultReport(report, { ...options, detail: "detailed" }),
    "report.pdf",
  );
  assert.ok(
    html.at(-1)!.includes("Cash received"),
    "detailed report actually includes transactions",
  );
  assert.ok(html.at(-1)!.includes("private-author-id"), "detailed report retains shared receipts");

  for (const locale of ["fa", "ps"] as const) {
    await pdf.renderPersonStatementPdf(
      scopePersonStatement({ ...source, locale }, options),
      `${locale}.pdf`,
    );
    assert.ok(html.at(-1)!.includes(`dir="rtl" lang="${locale}"`));
    assert.ok(html.at(-1)!.includes('<span class="num">135</span>'));
    assert.ok(!html.at(-1)!.includes("undefined"));
  }
  assert.equal(printOptions[0].width, 595.28);
  assert.equal(printOptions[0].height, 841.89);
  assert.equal(printOptions[0].margins, undefined);
  platform.OS = "ios";
  environment.IS_EXPO_GO = true;
  await pdf.renderPersonStatementPdf(scopePersonStatement(source), "ios-expo.pdf");
  assert.deepEqual(printOptions.at(-1)!.margins, { top: 40, right: 34, bottom: 45, left: 34 });
  assert.ok(
    !html.at(-1)!.includes("margin:14mm 12mm 16mm"),
    "iOS native margins are not duplicated in CSS",
  );
  assert.equal(printOptions.at(-1)!.base64, true);
  assert.deepEqual(writes, ["PDF_BYTES"], "Expo Go copies PDF bytes into its own accessible cache");
  console.log(
    "PASS export PDFs: correct balances, non-counting records, opt-in evidence/notes, detailed journal, escaping, RTL and awaited files",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
