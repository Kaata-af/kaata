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
import { getEffectiveCalendar, type Calendar } from "../calendar";
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
  /** Calendar for the PROSE dates (doc header, settled lines, PDF date cell).
   *  Snapshotted at build time so a document is a pure function of this
   *  struct. Note the CSV's dedicated Shamsi column is NOT governed by this —
   *  it is a machine column that is always Solar Hijri (see shamsiDate). */
  calendar: Calendar;
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
  /** See PersonStatement.calendar. */
  calendar: Calendar;
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
    // Read from the global rather than threaded in as a parameter (unlike
    // locale, which callers override because an export can be in the MESSAGE
    // language). There is exactly one calendar setting, so a second source of
    // truth here could only ever disagree with the app.
    calendar: getEffectiveCalendar(),
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
    calendar: getEffectiveCalendar(),
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

const MIME: Record<"csv" | "pdf", string> = {
  csv: "text/csv",
  pdf: "application/pdf",
};

function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

// The picker rejects on cancel rather than resolving empty, with a different
// code per platform (verified against the installed native source):
// Android PickerCancelledException → ERR_PICKER_CANCELLED; iOS
// FilePickingCancelledException → ERR_FILE_PICKING_CANCELLED. iOS also routes
// a failed security-scope acquisition through the SAME cancel path, so a
// genuine permission failure is indistinguishable from a user cancel there —
// we treat both as "user backed out" and stay silent. Match on `code`, never
// the message (the bridge decorates it).
//
// ERR_PICKING_IN_PROGRESS is deliberately NOT here: both call sites already
// hold a re-entry ref for the whole picker round-trip, so a second pick can
// only mean a stuck native picker — silence would look like a dead button.
const PICKER_QUIET_CODES = new Set(["ERR_PICKER_CANCELLED", "ERR_FILE_PICKING_CANCELLED"]);

export function isPickerDismissal(err: unknown): boolean {
  const code = errorCode(err);
  return code != null && PICKER_QUIET_CODES.has(code);
}

/** " (2)" before the extension: "kaata-Ahmad-2026-08-07.pdf" → "…-07 (2).pdf". */
function nameWithSuffix(fileName: string, n: number): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return `${fileName} (${n})`;
  return `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}`;
}

/**
 * Write an export into a folder the user picks (Android: SAF / real Downloads;
 * iOS: Files). Returns the file name the OS actually created, or null if the
 * user backed out of the picker.
 *
 * Platform notes, both verified against the installed native source:
 *  - ANDROID (content:// tree): only `Directory.createFile(name, mime)` can
 *    create — `new File(dir, name)`, `File.create()`, `File.copy()` all fail
 *    there — and the mime MUST be right, or the provider appends its own
 *    extension ("report.pdf.txt"). The provider also dedupes collisions
 *    itself ("report (1).pdf"), so the created name is authoritative.
 *  - iOS: createFile ignores the mime argument entirely and defaults to
 *    overwrite:false, so a same-day re-save of the same statement (our file
 *    names are per-person-per-day) THROWS ERR_FILE_ALREADY_EXISTS with no
 *    dedupe. Hence the suffix loop below — never delete-and-replace, because
 *    the folder is the user's own and an older export may be something they
 *    deliberately kept.
 */
export async function saveExportFile(args: {
  fileName: string;
  kind: "csv" | "pdf";
  /** CSV text, when we generated the bytes ourselves. */
  contents?: string;
  /** Source file (the printed PDF) to copy bytes from. */
  source?: File;
}): Promise<string | null> {
  if (args.contents == null && !args.source) {
    throw new Error("saveExportFile: neither contents nor source given");
  }

  await afterSheetTeardown();
  let picked: Directory;
  try {
    // The static is declared on the native BASE class, so its .d.ts return
    // type lacks createFile()/name — but the implementation really does
    // `return new Directory(uri)` with this class (expo-file-system
    // src/FileSystem.ts). Cast rather than reimplement the picker.
    picked = (await Directory.pickDirectoryAsync()) as Directory;
  } catch (err) {
    if (isPickerDismissal(err)) return null;
    throw err;
  }

  let target: File | null = null;
  for (let attempt = 1; attempt <= 20 && target == null; attempt++) {
    const name = attempt === 1 ? args.fileName : nameWithSuffix(args.fileName, attempt);
    try {
      target = picked.createFile(name, MIME[args.kind]);
    } catch (err) {
      // iOS-only path (Android dedupes before we ever see a collision).
      if (errorCode(err) !== "ERR_FILE_ALREADY_EXISTS") throw err;
    }
  }
  if (target == null) throw new Error("saveExportFile: no free file name in the chosen folder");

  try {
    if (args.contents != null) target.write(args.contents);
    else if (args.source) target.write(await args.source.bytes());
  } catch (err) {
    // createFile already materialized the document, so a failed write would
    // leave a 0-byte file sitting in the user's Downloads (and on iOS it
    // would then block that name forever). Best-effort cleanup, then rethrow.
    try {
      target.delete();
    } catch {
      /* nothing better to do */
    }
    throw err;
  }

  // File.name is basename(uri), not the provider's display name — path-like
  // SAF document ids resolve correctly, but an opaque id (Drive, Dropbox)
  // would surface as a meaningless token. Only trust it when it still looks
  // like the file we asked for.
  const created = target.name;
  return created.toLowerCase().endsWith(`.${args.kind}`) ? created : args.fileName;
}

// Callers reach the OS surface ~220ms after a BottomSheet action, but the
// sheet's exit animation is 180ms and its Modal unmount only commits after
// the completion callback crosses the bridge — a few-ms margin. iOS presents
// both the share sheet AND the folder picker on the topmost view controller;
// presenting on the still-dismissing sheet Modal gets it torn down with the
// sheet (same hazard invite.tsx pads for with SHEET_EXIT_MS + 80). Shared by
// both destinations so the two paths can't drift apart again.
async function afterSheetTeardown(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

export async function shareExportFile(uri: string, kind: "csv" | "pdf"): Promise<void> {
  await afterSheetTeardown();
  await Sharing.shareAsync(
    uri,
    kind === "csv"
      ? { mimeType: "text/csv", UTI: "public.comma-separated-values-text" }
      : { mimeType: "application/pdf", UTI: "com.adobe.pdf" },
  );
}
