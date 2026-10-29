import { personCurrencyRows } from "./multi-currency-view";
import type { PersonWithBalance } from "./types";

/** Classify the complete contact before applying currency filters. A zero
 * balance alone is not a deliberately cleared account. */
export function isSettledCustomer(person: PersonWithBalance): boolean {
  const cleared = (row: PersonWithBalance) =>
    row.is_settled === 1 &&
    Number.isFinite(row.balance) &&
    row.balance === 0 &&
    row.tab_unsynced !== 1 &&
    (row.tab_pending ?? 0) === 0 &&
    (row.tab_pending_count ?? 0) === 0 &&
    (row.tab_pending_balance ?? 0) === 0 &&
    (row.tab_close_pending ?? 0) === 0;
  return cleared(person) && personCurrencyRows(person).every(cleared);
}
