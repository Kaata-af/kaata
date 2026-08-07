// Shapes ledger data into export-ready models shared by the CSV and PDF
// builders. Read-only: nothing here writes to the db or the event log.
//
// Two models:
//   - PersonStatement — one person's full history, oldest-first, with the
//     settlement ruled lines interleaved exactly like a paper khata and a
//     running balance per entry. Always the ACTIVE vault (person screens
//     only exist there).
//   - VaultReport — the whole kaata: a date-sorted journal across all people
//     (per-person running balances) plus a per-person summary with totals.
//     Takes an EXPLICIT vault id/name/currency because vault settings can be
//     open for a non-active vault (?id= param) — never read the active-vault
//     currency/name for this one.
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { getCurrencySymbol } from "../currency";
import {
  getLocalSelf,
  getPerson,
  listEntries,
  listEntriesForExport,
  listSettlementBoundaries,
  type ExportEntryRow,
} from "../db";
import type { LocaleCode } from "../i18n";
import { toJalali } from "../jalali";
import type { Entry, PersonWithBalance, Self } from "../types";

export type StatementRow =
  | { kind: "entry"; entry: Entry; balanceAfter: number }
  // balanceAfter is usually 0 (settling requires a zero balance) but NOT
  // guaranteed: a synced device can lawfully perturb a closed chapter
  // (assertNotInSettledChapter is local-only), so the marker carries the real
  // running balance instead of asserting a zero that may be false.
  | { kind: "settled"; ms: number; balanceAfter: number };

export type PersonStatement = {
  person: PersonWithBalance;
  self: Self | null;
  /** Oldest-first, settlement markers interleaved after each closed chapter. */
  rows: StatementRow[];
  balance: number;
  currencyCode: string;
  currencySymbol: string;
  locale: LocaleCode;
  generatedAtMs: number;
};

export type JournalRow = ExportEntryRow & { balanceAfter: number };

export type ReportPerson = {
  id: string;
  name: string;
  phone: string | null;
  entryCount: number;
  balance: number;
  lastEntryAt: number;
};

export type VaultReport = {
  vaultName: string;
  self: Self | null;
  /** Sorted: to-collect (largest first), then to-pay, then settled-to-zero. */
  people: ReportPerson[];
  /** Oldest-first across the whole kaata; balanceAfter is per-person. */
  journal: JournalRow[];
  totals: { collect: number; pay: number; net: number };
  currencyCode: string;
  currencySymbol: string;
  locale: LocaleCode;
  generatedAtMs: number;
};

function signedAmount(e: { type: "debt" | "payment"; amount_afn: number }): number {
  return e.type === "debt" ? e.amount_afn : -e.amount_afn;
}

export async function buildPersonStatement(
  personId: string,
  locale: LocaleCode,
  currencyCode: string,
  currencySymbol: string,
  generatedAtMs: number,
): Promise<PersonStatement | null> {
  const [person, entries, boundaries, self] = await Promise.all([
    getPerson(personId),
    listEntries(personId),
    listSettlementBoundaries(personId),
    getLocalSelf(),
  ]);
  if (!person) return null;

  // listEntries is newest-first with no tie-break; re-sort ascending with an
  // id tie-break so re-exporting the same book orders identically.
  const asc = [...entries].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const rows: StatementRow[] = [];
  let running = 0;
  let i = 0;
  for (const boundary of boundaries) {
    let consumed = 0;
    while (i < asc.length && asc[i].created_at <= boundary) {
      const entry = asc[i++];
      running += signedAmount(entry);
      rows.push({ kind: "entry", entry, balanceAfter: running });
      consumed++;
    }
    // A ruled line above an empty page is meaningless (all of the chapter's
    // entries were later deleted), and a double-settle draws no second line —
    // same adjacent-marker collapse as the person screen's history view.
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    if (consumed === 0 && last.kind === "settled") {
      // Keep the NEWEST boundary of an adjacent run — it is the one that
      // governs chapter membership (MAX-based getSettlementSummary, and the
      // person screen's DESC walk keeps the newest too).
      last.ms = boundary;
      continue;
    }
    rows.push({ kind: "settled", ms: boundary, balanceAfter: running });
  }
  while (i < asc.length) {
    const entry = asc[i++];
    running += signedAmount(entry);
    rows.push({ kind: "entry", entry, balanceAfter: running });
  }

  return {
    person,
    self,
    rows,
    // The headline must equal the table's last running value BY CONSTRUCTION —
    // getPerson's aggregate is a second, non-atomic read that a concurrent
    // sync-applier write could shift between the two queries.
    balance: running,
    currencyCode,
    currencySymbol,
    locale,
    generatedAtMs,
  };
}

export async function buildVaultReport(
  vaultId: string,
  vaultName: string,
  currencyCode: string,
  locale: LocaleCode,
  generatedAtMs: number,
): Promise<VaultReport> {
  const [entries, self] = await Promise.all([listEntriesForExport(vaultId), getLocalSelf()]);

  const runningByPerson = new Map<string, number>();
  const peopleById = new Map<string, ReportPerson>();
  const journal: JournalRow[] = entries.map((row) => {
    const prev = runningByPerson.get(row.person_id) ?? 0;
    const next = prev + signedAmount(row);
    runningByPerson.set(row.person_id, next);
    const p = peopleById.get(row.person_id);
    if (p) {
      p.entryCount++;
      p.balance = next;
      p.lastEntryAt = Math.max(p.lastEntryAt, row.created_at);
    } else {
      peopleById.set(row.person_id, {
        id: row.person_id,
        name: row.person_name,
        phone: row.person_phone,
        entryCount: 1,
        balance: next,
        lastEntryAt: row.created_at,
      });
    }
    return { ...row, balanceAfter: next };
  });

  // Accountant ordering: money owed to the shop first (largest debts on top),
  // then what the shop owes, settled-to-zero accounts last.
  const people = [...peopleById.values()].sort((a, b) => {
    const groupOf = (p: ReportPerson) => (p.balance > 0 ? 0 : p.balance < 0 ? 1 : 2);
    return (
      groupOf(a) - groupOf(b) ||
      Math.abs(b.balance) - Math.abs(a.balance) ||
      a.name.localeCompare(b.name)
    );
  });

  let collect = 0;
  let pay = 0;
  for (const p of people) {
    if (p.balance > 0) collect += p.balance;
    else pay += -p.balance;
  }

  return {
    vaultName,
    self,
    people,
    journal,
    totals: { collect, pay, net: collect - pay },
    currencyCode,
    currencySymbol: getCurrencySymbol(currencyCode),
    locale,
    generatedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Dates + filenames + file plumbing shared by both builders.

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local-timezone ISO day (YYYY-MM-DD) — entries carry a business date, and
 *  the shopkeeper's wall clock is what that date meant. UTC would shift
 *  late-evening entries to the next day (Afghanistan is UTC+4:30). */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Solar Hijri day in ASCII digits (e.g. "1405-04-15") for CSV cells — the
 *  fa table policy is Western digits in commerce; pretty Persian-digit dates
 *  are for the PDF only. Falls back to the Gregorian ISO day outside the
 *  jalali algorithm's supported range. */
export function shamsiDate(ms: number): string {
  try {
    const { jy, jm, jd } = toJalali(ms);
    return `${jy}-${pad2(jm)}-${pad2(jd)}`;
  } catch {
    return isoDate(ms);
  }
}

/** Filesystem-safe file name: keeps Unicode letters (Dari names are fine on
 *  Android/iOS and in WhatsApp), strips path/reserved characters. */
export function exportFileName(base: string, ms: number, ext: "csv" | "pdf"): string {
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `kaata-${cleaned || "export"}-${isoDate(ms)}.${ext}`;
}

const EXPORTS_DIR = "exports";

export function writeExportFile(fileName: string, contents: string): File {
  const dir = new Directory(Paths.cache, EXPORTS_DIR);
  dir.create({ idempotent: true });
  const file = new File(dir, fileName);
  if (file.exists) file.delete();
  file.write(contents);
  return file;
}

/** Claim a stable path for a generated file (PDF lands wherever expo-print
 *  puts it; we move it here so the shared attachment has a real name). */
export function exportFileTarget(fileName: string): File {
  const dir = new Directory(Paths.cache, EXPORTS_DIR);
  dir.create({ idempotent: true });
  const file = new File(dir, fileName);
  if (file.exists) file.delete();
  return file;
}

export async function shareExportFile(uri: string, kind: "csv" | "pdf"): Promise<void> {
  // Callers reach here ~220ms after a BottomSheet action, but the sheet's exit
  // animation is 180ms and its Modal unmount only commits after the completion
  // callback crosses the bridge — a few-ms margin. iOS presents share UI on
  // the topmost VC; presenting on the still-dismissing sheet Modal gets the
  // share sheet torn down with it (same hazard invite.tsx pads for with
  // SHEET_EXIT_MS + 80). CSV generation is near-instant, so cushion here.
  await new Promise((resolve) => setTimeout(resolve, 120));
  await Sharing.shareAsync(
    uri,
    kind === "csv"
      ? { mimeType: "text/csv", UTI: "public.comma-separated-values-text" }
      : { mimeType: "application/pdf", UTI: "com.adobe.pdf" },
  );
}
