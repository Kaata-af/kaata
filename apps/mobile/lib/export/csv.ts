// CSV builders. Pure table — no title/metadata rows above the header, so any
// spreadsheet or future importer parses it without heuristics. Machine-clean
// cells: ISO + Shamsi dates in ASCII digits, ungrouped decimal amounts, and a
// stable entry id as the last column (the future import contract — dedupe key
// once bulk import exists). Human-facing labels (headers, the settled ruled
// line) render via tIn in the export's locale.
import { tIn } from "../i18n";
import { noteFor } from "./note";
import { formatSettlementDate } from "../jalali";
import { isoDate, shamsiDate, type PersonStatement, type VaultReport } from "./data";
import { EVIDENCE_KEYS, evidenceCells } from "./evidence";
import { addRecordTotal, balanceContribution, type RecordTotals } from "./shared-record";
import { addAmounts } from "../money";

// Excel needs the BOM to detect UTF-8 (otherwise Dari text opens as mojibake)
// and CRLF is the least-surprising row separator across spreadsheet apps.
const BOM = "\uFEFF";
const CRLF = "\r\n";

function csvField(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// Free-text and phone cells get a leading TAB when spreadsheets would
// otherwise coerce or execute them: Excel parses "+9377…" into 9.377E+10
// (destroying the phone column, and re-saving bakes it in), and a cell
// starting with = + - @ runs as a formula (classic CSV injection — these
// files are designed to be handed onward to third parties). The tab renders
// invisibly in Excel/Sheets and forces text; a future importer just trims
// leading whitespace on text columns. Ids/amounts/dates never pass through
// here — the machine contract stays untouched. Returns the RAW guarded
// string; csvLine's csvField does the quoting.
function guardText(v: string | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `\t${s}` : s;
}

function csvLine(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvField).join(",");
}

export function buildPersonCsv(st: PersonStatement): string {
  const { locale, calendar, currencyCode: code } = st;
  const shared =
    st.rows.some((r) => r.kind === "entry" && r.entry.tab) || !!st.archivedSharedPeriods?.length;
  let totals: RecordTotals = { acknowledged: 0, pending: 0, private: 0 };
  const lines: string[] = [
    csvLine([
      tIn(locale, "export.col.date"),
      tIn(locale, "export.col.dateShamsi"),
      shared ? tIn(locale, "export.col.gave") : `${tIn(locale, "export.col.gave")} (${code})`,
      shared
        ? tIn(locale, "export.col.received")
        : `${tIn(locale, "export.col.received")} (${code})`,
      `${tIn(locale, "export.col.balance")} (${code})`,
      tIn(locale, "export.col.note"),
      ...(shared
        ? [
            tIn(locale, "export.record.scope"),
            tIn(locale, "export.record.currency"),
            tIn(locale, "export.record.periodBalance"),
            tIn(locale, "export.record.contribution"),
            tIn(locale, "export.record.acknowledgedBalance"),
            tIn(locale, "export.record.pendingBalance"),
            tIn(locale, "export.record.privateBalance"),
            ...EVIDENCE_KEYS.map((k) => tIn(locale, k)),
          ]
        : []),
      tIn(locale, "export.col.id"),
    ]),
  ];
  for (const row of st.rows) {
    if (row.kind === "settled") {
      lines.push(
        csvLine([
          isoDate(row.ms),
          shamsiDate(row.ms),
          "",
          "",
          row.balanceAfter,
          tIn(locale, "person.history.settledOn", {
            date: formatSettlementDate(row.ms, locale, calendar),
          }),
          ...(shared
            ? [
                tIn(locale, "export.record.current"),
                code,
                "",
                "",
                totals.acknowledged,
                totals.pending,
                totals.private,
                ...EVIDENCE_KEYS.map(() => ""),
              ]
            : []),
          "",
        ]),
      );
      continue;
    }
    const e = row.entry;
    totals = addRecordTotal(totals, e);
    lines.push(
      csvLine([
        isoDate(e.created_at),
        shamsiDate(e.created_at),
        e.type === "debt" ? e.amount_afn : "",
        e.type === "payment" ? e.amount_afn : "",
        row.balanceAfter,
        guardText(noteFor(e.note, e.tab?.kind, locale)),
        ...(shared
          ? [
              tIn(locale, "export.record.current"),
              code,
              "",
              balanceContribution(e),
              totals.acknowledged,
              totals.pending,
              totals.private,
              ...evidenceCells(e.tab, locale).map(guardText),
            ]
          : []),
        e.id,
      ]),
    );
  }
  for (const period of st.archivedSharedPeriods ?? []) {
    let balance = 0;
    for (const entry of period.entries) {
      balance = addAmounts(balance, balanceContribution(entry));
      lines.push(
        csvLine([
          isoDate(entry.created_at),
          shamsiDate(entry.created_at),
          entry.type === "debt" ? entry.amount_afn : "",
          entry.type === "payment" ? entry.amount_afn : "",
          "",
          guardText(noteFor(entry.note, entry.tab?.kind, locale)),
          tIn(locale, "export.record.archived"),
          period.link.currency,
          balance,
          0,
          "",
          "",
          "",
          ...evidenceCells(entry.tab, locale).map(guardText),
          entry.id,
        ]),
      );
    }
  }
  return BOM + lines.join(CRLF) + CRLF;
}

export function buildVaultCsv(report: VaultReport): string {
  const { locale, currencyCode: code } = report;
  const shared = report.journal.some((r) => r.tab);
  const totalsByPerson = new Map<string, RecordTotals>();
  const lines: string[] = [
    csvLine([
      tIn(locale, "export.col.date"),
      tIn(locale, "export.col.dateShamsi"),
      tIn(locale, "export.col.person"),
      tIn(locale, "export.col.phone"),
      `${tIn(locale, "export.col.gave")} (${code})`,
      `${tIn(locale, "export.col.received")} (${code})`,
      `${tIn(locale, "export.col.balance")} (${code})`,
      tIn(locale, "export.col.note"),
      ...(shared
        ? [
            tIn(locale, "export.record.contribution"),
            tIn(locale, "export.record.acknowledgedBalance"),
            tIn(locale, "export.record.pendingBalance"),
            tIn(locale, "export.record.privateBalance"),
            ...EVIDENCE_KEYS.map((k) => tIn(locale, k)),
          ]
        : []),
      tIn(locale, "export.col.id"),
    ]),
  ];
  for (const row of report.journal) {
    const totals = addRecordTotal(
      totalsByPerson.get(row.person_id) ?? { acknowledged: 0, pending: 0, private: 0 },
      row,
    );
    totalsByPerson.set(row.person_id, totals);
    lines.push(
      csvLine([
        isoDate(row.created_at),
        shamsiDate(row.created_at),
        guardText(row.person_name),
        guardText(row.person_phone),
        row.type === "debt" ? row.amount_afn : "",
        row.type === "payment" ? row.amount_afn : "",
        row.balanceAfter,
        guardText(noteFor(row.note, row.kind, locale)),
        ...(shared
          ? [
              balanceContribution(row),
              totals.acknowledged,
              totals.pending,
              totals.private,
              ...evidenceCells(row.tab, locale).map(guardText),
            ]
          : []),
        row.id,
      ]),
    );
  }
  return BOM + lines.join(CRLF) + CRLF;
}
