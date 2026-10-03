// CSV builders. Pure table — no title/metadata rows above the header, so any
// spreadsheet or future importer parses it without heuristics. Machine-clean
// cells: ISO + Shamsi dates in ASCII digits, ungrouped decimal amounts, and a
// stable entry id as the last column (the future import contract — dedupe key
// once bulk import exists). Human-facing labels (headers, the settled ruled
// line) render via tIn in the export's locale.
//
// The 2.0.0 leading columns are a contract, shared or not: Gave (CODE) and
// Received (CODE) carry only amounts that COUNT toward the Balance column, so
// SUM(Gave) − SUM(Received) is the balance. A shared contact or kaata appends
// its record columns between Note and the entry id, which stays last. Rows that
// do not count — a rejected or cancelled shared tally, and every row of an
// earlier shared period (a later opening tally carries its total) — leave Gave
// and Received EMPTY. Their amount lives in "Recorded amount", which every
// tally row of a shared-shape file fills, signed like Balance contribution
// (gave +, received −) so the direction survives. Unshared contacts and
// kaatas export byte-for-byte what 2.0.0 did.
import { tIn } from "../i18n";
import { clearanceNote, noteFor } from "./note";
import { formatSettlementDate } from "../jalali";
import { isoDate, shamsiDate, type PersonStatement, type VaultReport } from "./data";
import { EVIDENCE_KEYS, evidenceCells, evidenceTime } from "./evidence";
import {
  addRecordTotal,
  balanceContribution,
  isExcludedRecord,
  recordedAmount,
  type AmountRow,
  type RecordTotals,
} from "./shared-record";

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

/** Gave and Received: only an amount that counts toward the Balance column.
 *  A private row is never excluded, so its cells are exactly 2.0.0's. */
function countedCells(e: AmountRow): [number | "", number | ""] {
  if (isExcludedRecord(e)) return ["", ""];
  return [e.type === "debt" ? e.amount_afn : "", e.type === "payment" ? e.amount_afn : ""];
}

/** A clearance marker's evidence: its shared account and the server's
 *  clearance time in UTC, which the note no longer carries. */
function clearanceEvidence(tabId: string, ms: number): string[] {
  return EVIDENCE_KEYS.map((key) =>
    key === "export.record.tabId"
      ? tabId
      : key === "export.record.recordedAt"
        ? evidenceTime(ms)
        : "",
  );
}

export function buildPersonCsv(st: PersonStatement): string {
  const { locale, calendar, currencyCode: code } = st;
  const shared =
    st.rows.some((r) => (r.kind === "entry" ? r.entry.tab : r.shared)) ||
    !!st.archivedSharedPeriods?.length;
  let totals: RecordTotals = { acknowledged: 0, pending: 0, private: 0 };
  const lines: string[] = [
    csvLine([
      tIn(locale, "export.col.date"),
      tIn(locale, "export.col.dateShamsi"),
      `${tIn(locale, "export.col.gave")} (${code})`,
      `${tIn(locale, "export.col.received")} (${code})`,
      `${tIn(locale, "export.col.balance")} (${code})`,
      tIn(locale, "export.col.note"),
      ...(shared
        ? [
            tIn(locale, "export.record.scope"),
            tIn(locale, "export.record.currency"),
            // No (CODE) here, unlike the vault CSV: an earlier shared period
            // keeps its own currency (it can differ after a re-link), and the
            // Currency column beside this one says which.
            tIn(locale, "export.record.recordedAmount"),
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
      const date = formatSettlementDate(row.ms, locale, calendar);
      lines.push(
        csvLine([
          isoDate(row.ms),
          shamsiDate(row.ms),
          "",
          "",
          row.balanceAfter,
          guardText(
            row.shared
              ? clearanceNote(row.shared.settlement.actor_name, date, locale)
              : tIn(locale, "person.history.settledOn", { date }),
          ),
          ...(shared
            ? [
                tIn(locale, "export.record.current"),
                code,
                "",
                "",
                "",
                totals.acknowledged,
                totals.pending,
                totals.private,
                ...(row.shared
                  ? clearanceEvidence(row.shared.tabId, row.ms)
                  : EVIDENCE_KEYS.map(() => "")),
              ]
            : []),
          row.shared?.settlement.id ?? "",
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
        ...countedCells(e),
        row.balanceAfter,
        guardText(noteFor(e.note, e.tab?.kind, locale)),
        ...(shared
          ? [
              tIn(locale, "export.record.current"),
              code,
              recordedAmount(e),
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
    for (const row of period.rows) {
      if (row.kind === "settled") {
        lines.push(
          csvLine([
            isoDate(row.ms),
            shamsiDate(row.ms),
            "",
            "",
            "",
            guardText(
              clearanceNote(
                row.shared?.settlement.actor_name,
                formatSettlementDate(row.ms, locale, calendar),
                locale,
              ),
            ),
            tIn(locale, "export.record.archived"),
            period.link.currency,
            "",
            row.balanceAfter,
            0,
            "",
            "",
            "",
            ...clearanceEvidence(period.link.tab_id, row.ms),
            row.shared?.settlement.id ?? "",
          ]),
        );
        continue;
      }
      // An earlier period never counts toward today's Balance: its total is
      // inside the later opening tally. So Gave/Received stay empty and the
      // amount is recorded in the period's own currency.
      const entry = row.entry;
      lines.push(
        csvLine([
          isoDate(entry.created_at),
          shamsiDate(entry.created_at),
          "",
          "",
          "",
          guardText(noteFor(entry.note, entry.tab?.kind, locale)),
          tIn(locale, "export.record.archived"),
          period.link.currency,
          recordedAmount(entry),
          row.balanceAfter,
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
            // One currency per kaata journal (no Currency column), so the
            // code is stated here like the leading amount columns.
            `${tIn(locale, "export.record.recordedAmount")} (${code})`,
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
        ...countedCells(row),
        row.balanceAfter,
        guardText(noteFor(row.note, row.kind, locale)),
        ...(shared
          ? [
              recordedAmount(row),
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
