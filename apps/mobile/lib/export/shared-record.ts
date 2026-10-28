import { addAmounts } from "../money";
import type { Entry } from "../types";

export type AmountRow = Pick<Entry, "type" | "amount_afn" | "tab">;

/** Rejected and cancelled shared records stay in exports as evidence but never
 *  count. An explicit predicate rather than `balanceContribution(...) === 0`:
 *  a private tally of 0 still counts, and its CSV row must not change shape. */
export function isExcludedRecord(entry: AmountRow): boolean {
  return (
    !!entry.tab &&
    (entry.tab.voided || entry.tab.status === "disputed" || entry.tab.kind === "void")
  );
}

/** The amount as it was recorded, signed like the balance (gave +, received −),
 *  whether or not it counts. */
export function recordedAmount(entry: AmountRow): number {
  return entry.type === "debt" ? entry.amount_afn : -entry.amount_afn;
}

/** Amount in the recorded ledger, including unconfirmed shared changes. */
export function recordedContribution(entry: AmountRow): number {
  return isExcludedRecord(entry) ? 0 : recordedAmount(entry);
}

/** Saved accepted and notification-only records count, while their evidence
 * stays distinct. Private tallies keep their usual immediate contribution. */
export function countsTowardBalance(entry: AmountRow): boolean {
  return (
    !isExcludedRecord(entry) &&
    (!entry.tab ||
      ((entry.tab.status === "accepted" || entry.tab.status === "recorded") &&
        !entry.tab.local_pending))
  );
}

export function balanceContribution(entry: AmountRow): number {
  return countsTowardBalance(entry) ? recordedAmount(entry) : 0;
}

export type RecordTotals = {
  acknowledged: number;
  pending: number;
  private: number;
  recorded?: number;
};

export function addRecordTotal(totals: RecordTotals, entry: AmountRow): RecordTotals {
  let amount = recordedContribution(entry);
  const key = !entry.tab
    ? "private"
    : !entry.tab.local_pending && entry.tab.status === "recorded"
      ? "recorded"
      : entry.tab.status === "accepted" && !entry.tab.local_pending
        ? "acknowledged"
        : "pending";
  if (key === "pending")
    amount = entry.tab?.pending_balance_excluded
      ? 0
      : addAmounts(amount, entry.tab?.pending_balance_adjustment ?? 0);
  return { ...totals, [key]: addAmounts(totals[key] ?? 0, amount) };
}

export function recordTotals(entries: AmountRow[]): RecordTotals {
  return entries.reduce(addRecordTotal, { acknowledged: 0, pending: 0, private: 0 });
}
