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
import { Platform } from "react-native";
import { SAVE_FILE_ERR, saveFileToPhone } from "kaata-save-file";
import { getEffectiveCalendar, type Calendar } from "../calendar";
import { getCurrencySymbol } from "../currency";
import {
  getLocalSelf,
  getPerson,
  listEntries,
  listEntriesForExport,
  listSettlementBoundaries,
  listArchivedSharedPeriodsForExport,
  listLedgerCurrencies,
  type ExportEntryRow,
} from "../db";
import type { LocaleCode } from "../i18n";
import { toJalali, toQamari } from "../jalali";
import type { Entry, PersonWithBalance, Self } from "../types";
import { addAmounts } from "../money";
import { entryRecordedAt } from "../entry-date";
import { balanceContribution, recordTotals, type RecordTotals } from "./shared-record";
import {
  getFinancialTabLinkForPerson,
  getTabLink,
  listPreLinkEntries,
  listTabSettlements,
} from "../tabs/db";
import { afterSharedSettlement } from "../tabs/chapters";
import type { TabSettlement } from "../tabs/types";
import { applyEventMutex } from "../projection";
import { assertSingleCurrency } from "../currency-totals";

export type StatementRow =
  | { kind: "entry"; entry: Entry; balanceAfter: number }
  // balanceAfter is usually 0 (settling requires a zero balance) but NOT
  // guaranteed: a synced device can lawfully perturb a closed chapter
  // (assertNotInSettledChapter is local-only), so the marker carries the real
  // running balance instead of asserting a zero that may be false.
  | {
      kind: "settled";
      ms: number;
      balanceAfter: number;
      shared?: { tabId: string; settlement: TabSettlement };
    };

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
  /** Present only when the statement contains shared records. Pending stays
   * separate from the confirmed headline and running balance. */
  sharedTotals?: RecordTotals;
  /** Private history already carried by the shared opening. These rows never
   * contribute to the current statement's headline or running balance. */
  preLinkRows?: StatementRow[];
  archivedSharedPeriods?: Array<
    Awaited<ReturnType<typeof listArchivedSharedPeriodsForExport>>[number] & {
      rows: StatementRow[];
    }
  >;
};

// Keep the server's chapter boundaries even when a later tally is backdated.
// Unlike the everyday history, exports retain cancelled/rejected originals.
function sharedStatementRows(
  entries: Entry[],
  settlements: TabSettlement[],
  tabId: string,
): StatementRow[] {
  const sequence = (entry: Entry) =>
    !entry.tab?.seq || entry.tab.local_pending ? Number.MAX_SAFE_INTEGER : entry.tab.seq;
  const ordered = [...entries].sort(
    (a, b) => sequence(a) - sequence(b) || a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  const rows: StatementRow[] = [];
  let running = 0;
  let index = 0;
  const appendEntry = (entry: Entry) => {
    running = addAmounts(running, balanceContribution(entry));
    rows.push({ kind: "entry", entry, balanceAfter: running });
  };
  // A pending replacement opening keeps older acknowledged records in the
  // current statement. Their per-tab sequence is unrelated to this tab's
  // clearance boundaries; retain their real receipts ahead of this period.
  const retained = ordered.filter((entry) => entry.tab?.tab_id && entry.tab.tab_id !== tabId);
  for (const entry of retained.sort(
    (a, b) => (a.tab?.recorded_at ?? a.created_at) - (b.tab?.recorded_at ?? b.created_at),
  ))
    appendEntry(entry);
  const current = ordered.filter((entry) => !entry.tab?.tab_id || entry.tab.tab_id === tabId);
  for (const settlement of [...settlements].sort((a, b) => a.through_seq - b.through_seq)) {
    while (
      index < current.length &&
      !afterSharedSettlement(current[index], settlement.through_seq)
    ) {
      appendEntry(current[index++]);
    }
    rows.push({
      kind: "settled",
      ms: settlement.settled_at_ms,
      balanceAfter: running,
      shared: { tabId, settlement },
    });
  }
  while (index < current.length) appendEntry(current[index++]);
  return rows;
}

function privateStatementRows(entries: Entry[], boundaries: number[]): StatementRow[] {
  const asc = [...entries].sort(
    (a, b) => entryRecordedAt(a) - entryRecordedAt(b) || a.id.localeCompare(b.id),
  );
  const rows: StatementRow[] = [];
  let running = 0;
  let index = 0;
  for (const boundary of boundaries) {
    let consumed = 0;
    while (index < asc.length && entryRecordedAt(asc[index]) <= boundary) {
      const entry = asc[index++];
      running = addAmounts(running, balanceContribution(entry));
      rows.push({ kind: "entry", entry, balanceAfter: running });
      consumed++;
    }
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    if (consumed === 0 && last.kind === "settled") {
      // Adjacent empty chapters collapse to their newest boundary.
      last.ms = boundary;
      continue;
    }
    rows.push({ kind: "settled", ms: boundary, balanceAfter: running });
  }
  while (index < asc.length) {
    const entry = asc[index++];
    running = addAmounts(running, balanceContribution(entry));
    rows.push({ kind: "entry", entry, balanceAfter: running });
  }
  return rows;
}

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

export async function buildPersonStatement(
  personId: string,
  locale: LocaleCode,
  currencyCode: string,
  currencySymbol: string,
  generatedAtMs: number,
): Promise<PersonStatement | null> {
  // Entries, link identity and clearance markers must describe one cache
  // state. A concurrent pull must not put a newer boundary over older rows.
  return applyEventMutex.runExclusive(() =>
    buildPersonStatementSnapshot(personId, locale, currencyCode, currencySymbol, generatedAtMs),
  );
}

/** One read snapshot, with each denomination's history and balance separate. */
export async function buildPersonStatements(
  personId: string,
  vaultId: string,
  locale: LocaleCode,
  generatedAtMs: number,
): Promise<PersonStatement[]> {
  return applyEventMutex.runExclusive(async () => {
    const calendar = getEffectiveCalendar();
    const codes = [...new Set(await listLedgerCurrencies(vaultId))];
    const statements = (
      await Promise.all(
        codes.map((code) =>
          buildPersonStatementSnapshot(
            personId,
            locale,
            code,
            getCurrencySymbol(code),
            generatedAtMs,
            calendar,
          ),
        ),
      )
    ).filter((statement): statement is PersonStatement => statement !== null);
    const populated = statements.filter(
      (statement) =>
        statement.rows.length > 0 ||
        !!statement.preLinkRows?.length ||
        !!statement.archivedSharedPeriods?.length ||
        !!statement.person.tab_id ||
        statement.person.tab_unsynced === 1,
    );
    return populated.length ? populated : statements.slice(0, 1);
  });
}

async function buildPersonStatementSnapshot(
  personId: string,
  locale: LocaleCode,
  currencyCode: string,
  currencySymbol: string,
  generatedAtMs: number,
  calendar = getEffectiveCalendar(),
): Promise<PersonStatement | null> {
  const [person, entries, boundaries, self, archivedSharedPeriods, financialTab] =
    await Promise.all([
      getPerson(personId, currencyCode),
      listEntries(personId, currencyCode),
      listSettlementBoundaries(personId, currencyCode),
      getLocalSelf(),
      listArchivedSharedPeriodsForExport(personId, currencyCode, { requireComplete: true }),
      getFinancialTabLinkForPerson(personId, currencyCode),
    ]);
  if (!person) return null;
  if (person.tab_unsynced === 1)
    throw new Error("Shared history is still syncing. Please try exporting again shortly.");
  assertSingleCurrency(entries, currencyCode);

  // Shared clearances follow server sequence; private chapters follow the
  // edited business date. Keep both histories without counting an opening twice.
  const rows: StatementRow[] = financialTab
    ? sharedStatementRows(
        entries,
        await listTabSettlements(financialTab.tab_id),
        financialTab.tab_id,
      )
    : privateStatementRows(entries, boundaries);
  const running = rows.at(-1)?.balanceAfter ?? 0;
  let preLinkRows: StatementRow[] = [];
  if (person.tab_id) {
    const link = await getTabLink(person.tab_id);
    if (!link || link.currency !== currencyCode)
      throw new Error("Shared records changed during export. Please try again.");
    const before = await listPreLinkEntries(link);
    assertSingleCurrency(before, currencyCode);
    preLinkRows = privateStatementRows(before, boundaries);
  }

  const archivedPeriods = await Promise.all(
    archivedSharedPeriods.map(async (period) => {
      const rows = sharedStatementRows(
        period.entries,
        await listTabSettlements(period.link.tab_id),
        period.link.tab_id,
      );
      return {
        ...period,
        rows,
        entries: rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : [])),
      };
    }),
  );

  return {
    person,
    self,
    rows,
    // Derive the headline from exactly the rows printed in this statement.
    balance: running,
    currencyCode,
    currencySymbol,
    locale,
    // One captured app calendar keeps every currency's document columns equal.
    calendar,
    generatedAtMs,
    ...(entries.some((e) => e.tab) ? { sharedTotals: recordTotals(entries) } : {}),
    ...(preLinkRows.length ? { preLinkRows } : {}),
    ...(archivedPeriods.length ? { archivedSharedPeriods: archivedPeriods } : {}),
  };
}

export async function buildVaultReport(
  vaultId: string,
  vaultName: string,
  currencyCode: string,
  locale: LocaleCode,
  generatedAtMs: number,
  calendar = getEffectiveCalendar(),
): Promise<VaultReport> {
  const [entries, self] = await Promise.all([
    listEntriesForExport(vaultId, currencyCode),
    getLocalSelf(),
  ]);
  assertSingleCurrency(entries, currencyCode);

  const runningByPerson = new Map<string, number>();
  const peopleById = new Map<string, ReportPerson>();
  const journal: JournalRow[] = entries.map((row) => {
    const prev = runningByPerson.get(row.person_id) ?? 0;
    const next = addAmounts(prev, balanceContribution(row));
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
    if (p.balance > 0) collect = addAmounts(collect, p.balance);
    else pay = addAmounts(pay, -p.balance);
  }

  return {
    vaultName,
    self,
    people,
    journal,
    totals: { collect, pay, net: addAmounts(collect, -pay) },
    currencyCode,
    currencySymbol: getCurrencySymbol(currencyCode),
    locale,
    calendar,
    generatedAtMs,
  };
}

/** A whole Kaata report keeps each currency's people, running balances and
 * totals in its own section. It never produces a combined monetary total. */
export async function buildVaultReports(
  vaultId: string,
  vaultName: string,
  defaultCurrency: string,
  locale: LocaleCode,
  generatedAtMs: number,
): Promise<VaultReport[]> {
  return applyEventMutex.runExclusive(async () => {
    const calendar = getEffectiveCalendar();
    const codes = [...new Set([defaultCurrency, ...(await listLedgerCurrencies(vaultId))])];
    const reports = await Promise.all(
      codes.map((code) =>
        buildVaultReport(vaultId, vaultName, code, locale, generatedAtMs, calendar),
      ),
    );
    const populated = reports.filter((report) => report.journal.length > 0);
    return populated.length ? populated : reports.slice(0, 1);
  });
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

/** Qamari day in ASCII digits (e.g. "1448-02-20"), with the user's Qamari
 *  adjustment like every other Qamari date in the app. Only Qamari exports
 *  carry it (audit #15). Falls back to the Gregorian ISO day before the Hijri
 *  epoch. */
export function qamariDate(ms: number): string {
  try {
    const { hy, hm, hd } = toQamari(ms);
    return `${hy}-${pad2(hm)}-${pad2(hd)}`;
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
  file.writeSync(contents);
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

/** How a save was fulfilled — the caller words its confirmation from this. */
export type SaveOutcome =
  /** Android: it is in the public Downloads folder under `name`. */
  | { via: "downloads"; name: string }
  /** iOS: the user chose the destination themselves; `name` is what they saved. */
  | { via: "files"; name: string }
  /** Old Android (< 10) where Downloads is unreachable without a permission
   *  prompt: the share sheet was opened instead. Nothing to confirm. */
  | { via: "share" };

/**
 * Put an export where the user will find it. Returns null when the user
 * backed out.
 *
 * REWRITTEN 2026-09 around modules/kaata-save-file. The previous version used
 * expo-file-system's directory picker on both platforms and was broken on
 * both: Android 11+ forbids that picker from granting Downloads or the
 * storage root, so users were bounced between folders they could not choose;
 * and on iOS the round-trip crashed the app with an uncaught JS exception
 * during the tap's re-render — reproduced on 1.1.1 from the store. Neither
 * mechanism survives here.
 *
 *   Android  MediaStore.Downloads — public Downloads, no picker, no
 *            permission on 10+. Below 10 the module reports E_UNSUPPORTED and
 *            we open the share sheet instead of adding a permission prompt.
 *   iOS      the system Save-to-Files exporter for ONE file. iOS does the
 *            copy; we never touch the destination.
 *
 * The CSV path first writes the text into the exports cache so both kinds
 * hand the native side a file uri, which is the only shape it takes.
 */
export async function saveExportFile(args: {
  fileName: string;
  kind: "csv" | "pdf";
  /** CSV text, when we generated the bytes ourselves. */
  contents?: string;
  /** Source file (the printed PDF) to copy bytes from. */
  source?: File;
}): Promise<SaveOutcome | null> {
  if (args.contents == null && !args.source) {
    throw new Error("saveExportFile: neither contents nor source given");
  }
  const source = args.source ?? writeExportFile(args.fileName, args.contents!);

  await afterSheetTeardown();
  try {
    const result = await saveFileToPhone(source.uri, args.fileName, MIME[args.kind]);
    if (result == null) return null;
    return Platform.OS === "android"
      ? { via: "downloads", name: result.displayName }
      : { via: "files", name: result.displayName };
  } catch (err) {
    if (errorCode(err) === SAVE_FILE_ERR.UNSUPPORTED) {
      await shareExportFile(source.uri, args.kind);
      return { via: "share" };
    }
    // Recorded durably, with the step, before it surfaces as a toast: this
    // is the path that used to crash on both platforms, and a failure we can
    // read on the next launch is the difference between "it crashed once,
    // idk why" and a fix.
    void recordExportFailure("save", args.kind, err);
    throw err;
  }
}

/** Best-effort, never throws, never blocks the caller. */
async function recordExportFailure(
  stage: "save" | "share",
  kind: string,
  err: unknown,
): Promise<void> {
  try {
    const { queueCrashReport } = await import("../crash-report");
    const e = err as { code?: unknown; message?: unknown; name?: unknown };
    await queueCrashReport({
      kind: "js",
      stage: `export:${stage}:${kind}`,
      name: typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "Error",
      message: typeof e?.message === "string" ? e.message : String(err),
    });
  } catch {
    /* the report must never become a second failure */
  }
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
