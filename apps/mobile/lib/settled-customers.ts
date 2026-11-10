import type { PersonWithBalance } from "./types";

/** Unknown balances and unresolved shared work can never mean settled. */
export function hasUnresolvedCustomerBalance(row: PersonWithBalance): boolean {
  return (
    !Number.isFinite(row.balance) ||
    row.balance !== 0 ||
    row.tab_unsynced === 1 ||
    (row.tab_pending ?? 0) !== 0 ||
    (row.tab_pending_count ?? 0) !== 0 ||
    (row.tab_pending_balance ?? 0) !== 0 ||
    (row.tab_close_pending ?? 0) !== 0
  );
}

/** An empty shared link is scaffolding, not a financial chapter to clear.
 * Keep it available for syncing and invitations, but not as another zero. */
export function hasCustomerCurrencyActivity(row: PersonWithBalance): boolean {
  return (
    hasUnresolvedCustomerBalance(row) ||
    row.is_settled === 1 ||
    row.last_entry_at != null ||
    row.last_entry_type != null ||
    (row.selection_totals?.debtCount ?? 0) > 0 ||
    (row.selection_totals?.creditCount ?? 0) > 0
  );
}

/** Classify the complete contact before applying currency filters. A zero
 * balance alone is not a deliberately cleared account. */
export function isSettledCustomer(person: PersonWithBalance): boolean {
  const rows = person.currency_balances?.length ? person.currency_balances : [person];
  if (hasUnresolvedCustomerBalance(person) || rows.some(hasUnresolvedCustomerBalance)) return false;
  // Currency filtering must not turn a partially settled customer into a
  // settled one just because the outstanding denomination is now hidden.
  if (person.customer_is_settled !== undefined) return person.customer_is_settled;
  const active = rows.filter(hasCustomerCurrencyActivity);
  return active.length > 0 && active.every((row) => row.is_settled === 1);
}
