import { fromMinorUnits, toMinorUnits } from "./money";
import type { Entry } from "./types";
import { countsTowardBalance } from "./export/shared-record";

export type TallyFlowSummary = {
  gave: { count: number; amount: number };
  received: { count: number; amount: number };
};

/** Known handovers across the available history, independent of search/chapter
 * folding. Opening balances carry a net amount, not a new give/receive; exclude
 * them while retaining actual pre-link handovers when this device has them. */
export function summarizeTallyFlows(entries: readonly Entry[]): TallyFlowSummary {
  const totals = { debt: { count: 0, minor: 0 }, payment: { count: 0, minor: 0 } };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (
      entry.deleted_at != null ||
      entry.disputed_at != null ||
      entry.tab?.kind === "opening" ||
      !countsTowardBalance(entry)
    )
      continue;
    const bucket = totals[entry.type];
    bucket.count++;
    bucket.minor += toMinorUnits(entry.amount_afn);
    if (!Number.isSafeInteger(bucket.minor)) throw new RangeError("Total exceeds safe cents range");
  }
  return {
    gave: { count: totals.debt.count, amount: fromMinorUnits(totals.debt.minor) },
    received: { count: totals.payment.count, amount: fromMinorUnits(totals.payment.minor) },
  };
}
