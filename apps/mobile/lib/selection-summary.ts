import { fromMinorUnits, toMinorUnits } from "./money";
import type { Direction, PersonWithBalance } from "./types";
import { assertSingleCurrency } from "./currency-totals";

/** Amounts use the current book, including its one carried opening balance.
 * Settled chapters still count; removed/rejected/cancelled records do not.
 * Earlier books already folded into an opening are never counted again. */
export type SelectionFinancialSummary = {
  debtCount: number;
  creditCount: number;
  /** Gross value given: the sum of debt entries, before receipts offset it. */
  debt: number;
  /** Gross value received: the sum of payment entries. */
  credit: number;
  /** Remaining positive balances across the selected contacts. */
  collect: number;
  /** Absolute remaining negative balances across the selected contacts. */
  pay: number;
  /** Combined remaining balance: positive to collect, negative to pay. */
  net: number;
  /** A restored shared book has not downloaded yet, or a selected contact
   * disappeared during refresh. Its incomplete amounts must not be shown. */
  pending: boolean;
};

type MinorTotals = {
  debtCount: number;
  creditCount: number;
  debt: number;
  credit: number;
  collect: number;
  pay: number;
  pending: boolean;
};

function addExact(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(result)) {
    throw new RangeError("Selection total exceeds safe cents range");
  }
  return result;
}

function financialSummary(totals: MinorTotals): SelectionFinancialSummary {
  return {
    debtCount: totals.debtCount,
    creditCount: totals.creditCount,
    debt: fromMinorUnits(totals.debt),
    credit: fromMinorUnits(totals.credit),
    collect: fromMinorUnits(totals.collect),
    pay: fromMinorUnits(totals.pay),
    net: fromMinorUnits(addExact(totals.collect, -totals.pay)),
    pending: totals.pending,
  };
}

/** Selected transactions from one account, in the screen's viewing direction.
 * Callers supply only live financial records, with unsigned amounts. A shared
 * opening counts once as a record, as it does in the current ledger itself. */
export function summarizeSelectionEntries(
  rows: readonly { amount: number; direction: Direction; currency?: string }[],
): SelectionFinancialSummary {
  assertSingleCurrency(rows);
  let debt = 0;
  let credit = 0;
  let debtCount = 0;
  let creditCount = 0;
  for (const row of rows) {
    if (row.amount < 0) throw new RangeError("Selection amounts must be unsigned");
    const minor = toMinorUnits(row.amount);
    if (row.direction === "collect") {
      debt = addExact(debt, minor);
      debtCount++;
    } else {
      credit = addExact(credit, minor);
      creditCount++;
    }
  }
  const net = addExact(debt, -credit);
  return financialSummary({
    debtCount,
    creditCount,
    debt,
    credit,
    collect: Math.max(net, 0),
    pay: Math.max(-net, 0),
    pending: false,
  });
}

/** Selected contacts already carry the financial totals from the people-list
 * snapshot. A tap only adds these integer values in memory: it never opens
 * SQLite, starts a request, or replaces a completed summary with loading UI.
 * The current shared book includes one opening plus later local tallies;
 * its older carried history is not counted again. Missing restored shared
 * data remains unavailable until the regular people refresh receives it. */
export function summarizeSelectedPeople(
  people: readonly PersonWithBalance[],
): SelectionFinancialSummary {
  assertSingleCurrency(people);
  const totals: MinorTotals = {
    debtCount: 0,
    creditCount: 0,
    debt: 0,
    credit: 0,
    collect: 0,
    pay: 0,
    pending: false,
  };
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    const row = person.selection_totals;
    if (person.tab_unsynced || !row) {
      totals.pending = true;
      continue;
    }
    totals.debtCount = addExact(totals.debtCount, row.debtCount);
    totals.creditCount = addExact(totals.creditCount, row.creditCount);
    totals.debt = addExact(totals.debt, row.debtMinor);
    totals.credit = addExact(totals.credit, row.creditMinor);
    const net = addExact(row.debtMinor, -row.creditMinor);
    totals.collect = addExact(totals.collect, Math.max(net, 0));
    totals.pay = addExact(totals.pay, Math.max(-net, 0));
  }
  return financialSummary(totals);
}
