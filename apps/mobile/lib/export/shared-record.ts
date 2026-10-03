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

/** Rejected/cancelled records remain evidence but never contribute money. */
export function balanceContribution(entry: AmountRow): number {
  return isExcludedRecord(entry) ? 0 : recordedAmount(entry);
}

export type RecordTotals = { acknowledged: number; pending: number; private: number };

export function addRecordTotal(totals: RecordTotals, entry: AmountRow): RecordTotals {
  const amount = balanceContribution(entry);
  const key = !entry.tab
    ? "private"
    : entry.tab.status === "accepted" && !entry.tab.local_pending
      ? "acknowledged"
      : "pending";
  return { ...totals, [key]: addAmounts(totals[key], amount) };
}

export function recordTotals(entries: AmountRow[]): RecordTotals {
  return entries.reduce(addRecordTotal, { acknowledged: 0, pending: 0, private: 0 });
}
