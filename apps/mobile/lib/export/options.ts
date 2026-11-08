import type {
  ExportNote,
  ExportPeriodTotals,
  PersonStatement,
  StatementRow,
  VaultReport,
} from "./data";
import { addAmounts } from "../money";
import type { Entry } from "../types";
import { balanceContribution, countsTowardBalance, recordTotals } from "./shared-record";

export class ExportScopeError extends Error {
  constructor(public readonly code: "beforeSharedOpening") {
    super(
      "Choose dates in the current shared period, or export all history with detailed records.",
    );
    this.name = "ExportScopeError";
  }
}

export type ExportOptions = {
  detail?: "standard" | "detailed";
  /** Business dates in local time. The start is inclusive, the end exclusive. */
  period?: { startMs?: number; endMs?: number };
  includeNotes?: boolean;
};

export type NormalizedExportOptions = {
  detail: "standard" | "detailed";
  period?: { startMs?: number; endMs?: number };
  includeNotes: boolean;
};

export function normalizeExportOptions(options: ExportOptions = {}): NormalizedExportOptions {
  const { startMs, endMs } = options.period ?? {};
  for (const value of [startMs, endMs])
    if (value != null && (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())))
      throw new RangeError("Invalid export date");
  if (startMs != null && endMs != null && startMs >= endMs)
    throw new RangeError("The export end must be after its start");
  return {
    detail: options.detail === "detailed" ? "detailed" : "standard",
    ...(startMs != null || endMs != null ? { period: { startMs, endMs } } : {}),
    includeNotes: options.includeNotes === true,
  };
}

function beforeEnd(ms: number, options: NormalizedExportOptions): boolean {
  return options.period?.endMs == null || ms < options.period.endMs;
}

function within(ms: number, options: NormalizedExportOptions): boolean {
  return (
    beforeEnd(ms, options) && (options.period?.startMs == null || ms >= options.period.startMs)
  );
}

/** A replacement opening folds older books into one number. Filtering that
 * snapshot to an earlier boundary cannot reconstruct that boundary's balance.
 * Reject this particular range instead of exporting a plausible false zero. */
function assertCurrentSharedPeriod(
  entries: readonly Pick<Entry, "created_at" | "type" | "amount_afn" | "tab">[],
  options: NormalizedExportOptions,
): void {
  if (!options.period) return;
  let latestOpening = -Infinity;
  for (const entry of entries)
    if (entry.tab?.kind === "opening" && countsTowardBalance(entry))
      latestOpening = Math.max(latestOpening, entry.created_at);
  if (!Number.isFinite(latestOpening)) return;
  const firstDay = new Date(latestOpening);
  firstDay.setHours(0, 0, 0, 0);
  const boundary = firstDay.getTime();
  if (
    (options.period.startMs != null && options.period.startMs < boundary) ||
    (options.period.endMs != null && options.period.endMs <= boundary)
  )
    throw new ExportScopeError("beforeSharedOpening");
}

function scopedNotes(
  notes: ExportNote[] | undefined,
  options: NormalizedExportOptions,
): ExportNote[] | undefined {
  return options.includeNotes
    ? notes?.filter((note) => within(note.createdAt, options))
    : undefined;
}

function projectRows(source: readonly StatementRow[], options: NormalizedExportOptions) {
  let openingBalance = 0;
  for (const row of source)
    if (
      row.kind === "entry" &&
      options.period?.startMs != null &&
      row.entry.created_at < options.period.startMs
    )
      openingBalance = addAmounts(openingBalance, balanceContribution(row.entry));
  let balance = openingBalance;
  const periodTotals: ExportPeriodTotals = { gave: 0, received: 0 };
  const rows: StatementRow[] = [];
  for (const row of source) {
    if (row.kind === "settled") {
      // A date selection can cut across an immutable chapter (including a
      // backdated tally). Its partial running balance is not a clearance.
      // Full history retains the actual boundaries; selected periods show
      // transactions and the correctly computed opening/closing balances.
      if (!options.period) rows.push({ ...row, balanceAfter: balance });
      continue;
    }
    if (!within(row.entry.created_at, options)) continue;
    const contribution = balanceContribution(row.entry);
    balance = addAmounts(balance, contribution);
    if (contribution > 0) periodTotals.gave = addAmounts(periodTotals.gave, contribution);
    else if (contribution < 0)
      periodTotals.received = addAmounts(periodTotals.received, -contribution);
    rows.push({ ...row, balanceAfter: balance });
  }
  return { rows, openingBalance, balance, periodTotals };
}

/** Pure projection: source receipts and their immutable order are never changed. */
export function scopePersonStatement(
  source: PersonStatement,
  input: ExportOptions = {},
): PersonStatement {
  const options = normalizeExportOptions(input);
  assertCurrentSharedPeriod(
    source.rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : [])),
    options,
  );
  const projected = projectRows(source.rows, options);
  const visibleEntries = projected.rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : []));
  const historical = options.detail === "detailed";
  const preLink = historical ? projectRows(source.preLinkRows ?? [], options) : undefined;
  const archives = historical
    ? source.archivedSharedPeriods
        ?.map((period) => {
          const scoped = projectRows(period.rows, options);
          return {
            ...period,
            rows: scoped.rows,
            openingBalance: scoped.openingBalance,
            entries: scoped.rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : [])),
          };
        })
        .filter((period) => period.rows.length > 0 || period.openingBalance !== 0)
    : undefined;
  return {
    ...source,
    ...projected,
    hasEarlierHistory:
      source.hasEarlierHistory === true ||
      !!source.preLinkRows?.length ||
      !!source.archivedSharedPeriods?.length,
    personDescription: options.includeNotes ? source.personDescription : undefined,
    exportOptions: options,
    sharedTotals:
      source.sharedTotals || visibleEntries.some((entry) => entry.tab)
        ? recordTotals(visibleEntries)
        : undefined,
    preLinkRows: preLink?.rows.length ? preLink.rows : undefined,
    preLinkOpeningBalance: preLink?.openingBalance,
    archivedSharedPeriods: archives?.length ? archives : undefined,
    notes: scopedNotes(source.notes, options),
  };
}

export function scopeVaultReport(source: VaultReport, input: ExportOptions = {}): VaultReport {
  const options = normalizeExportOptions(input);
  assertCurrentSharedPeriod(source.journal, options);
  const byPerson = new Map<string, typeof source.journal>();
  for (const row of source.journal) {
    if (!beforeEnd(row.created_at, options)) continue;
    const rows = byPerson.get(row.person_id) ?? [];
    rows.push(row);
    byPerson.set(row.person_id, rows);
  }
  const openingByPerson = new Map<string, number>();
  const periodTotals: ExportPeriodTotals = { gave: 0, received: 0 };
  const people = source.people
    .flatMap((person) => {
      const rows = byPerson.get(person.id);
      if (!rows?.length) return [];
      let openingBalance = 0,
        balance = 0,
        lastEntryAt = 0;
      const totals: ExportPeriodTotals = { gave: 0, received: 0 };
      let entryCount = 0;
      for (const row of rows) {
        lastEntryAt = Math.max(lastEntryAt, row.created_at);
        const amount = balanceContribution(row);
        balance = addAmounts(balance, amount);
        if (!within(row.created_at, options)) openingBalance = addAmounts(openingBalance, amount);
        else {
          entryCount++;
          if (amount > 0) totals.gave = addAmounts(totals.gave, amount);
          else if (amount < 0) totals.received = addAmounts(totals.received, -amount);
        }
      }
      openingByPerson.set(person.id, openingBalance);
      periodTotals.gave = addAmounts(periodTotals.gave, totals.gave);
      periodTotals.received = addAmounts(periodTotals.received, totals.received);
      if (options.detail === "standard" && options.period && balance === 0 && entryCount === 0)
        return [];
      return [
        {
          ...person,
          description: options.includeNotes ? person.description : undefined,
          balance,
          openingBalance,
          periodTotals: totals,
          entryCount,
          lastEntryAt,
        },
      ];
    })
    .sort((a, b) => {
      const group = (balance: number) => (balance > 0 ? 0 : balance < 0 ? 1 : 2);
      return (
        group(a.balance) - group(b.balance) ||
        Math.abs(b.balance) - Math.abs(a.balance) ||
        a.name.localeCompare(b.name)
      );
    });
  const running = new Map(openingByPerson);
  const journal = source.journal
    .filter((row) => within(row.created_at, options))
    .map((row) => {
      const balanceAfter = addAmounts(running.get(row.person_id) ?? 0, balanceContribution(row));
      running.set(row.person_id, balanceAfter);
      return { ...row, balanceAfter };
    });
  const totals = { collect: 0, pay: 0, net: 0 };
  const openingTotals = { collect: 0, pay: 0, net: 0 };
  for (const person of people) {
    if (person.balance > 0) totals.collect = addAmounts(totals.collect, person.balance);
    else totals.pay = addAmounts(totals.pay, -person.balance);
    if (person.openingBalance > 0)
      openingTotals.collect = addAmounts(openingTotals.collect, person.openingBalance);
    else openingTotals.pay = addAmounts(openingTotals.pay, -person.openingBalance);
  }
  totals.net = addAmounts(totals.collect, -totals.pay);
  openingTotals.net = addAmounts(openingTotals.collect, -openingTotals.pay);
  return {
    ...source,
    exportOptions: options,
    people,
    journal,
    totals,
    openingTotals,
    periodTotals,
    notes: scopedNotes(source.notes, options),
  };
}
