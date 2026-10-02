import { addAmounts } from "../money";
import type { Entry } from "../types";

type AmountRow = Pick<Entry, "type" | "amount_afn" | "tab">;

/** Rejected/cancelled records remain evidence but never contribute money. */
export function balanceContribution(entry: AmountRow): number {
  if (
    entry.tab &&
    (entry.tab.voided || entry.tab.status === "disputed" || entry.tab.kind === "void")
  ) {
    return 0;
  }
  return entry.type === "debt" ? entry.amount_afn : -entry.amount_afn;
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
