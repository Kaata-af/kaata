import assert from "node:assert/strict";
import { isSettledCustomer } from "../settled-customers";
import { mergeCurrencyPeople } from "../multi-currency-view";
import type { PersonWithBalance } from "../types";

const settled = {
  id: "settled",
  name: "Settled account",
  currency: "AFN",
  balance: 0,
  is_settled: 1,
  last_entry_at: 100,
  tab_pending: 0,
} as PersonWithBalance;
assert.equal(isSettledCustomer(settled), true);
for (const patch of [
  { is_settled: 0 },
  { is_settled: undefined, last_entry_at: null },
  { balance: 1 },
  { balance: -1 },
  { balance: Number.NaN },
  { balance: Number.POSITIVE_INFINITY },
  { tab_unsynced: 1 as const },
  { tab_pending: 1 },
  { tab_pending_count: 2, tab_pending_balance: 0 },
  { tab_pending_balance: 1 },
  { tab_close_pending: 1 },
])
  assert.equal(isSettledCustomer({ ...settled, ...patch }), false);
const usd = { ...settled, currency: "USD" };
const [bothSettled] = mergeCurrencyPeople([[settled], [usd]], "AFN");
assert.equal(isSettledCustomer(bothSettled), true);
for (const patch of [
  { is_settled: 0, balance: 0 },
  { balance: 50, is_settled: 0 },
  { tab_pending_count: 1, tab_pending_balance: 0 },
  { tab_unsynced: 1 as const },
]) {
  const [mixed] = mergeCurrencyPeople([[settled], [{ ...usd, ...patch }]], "AFN");
  assert.equal(isSettledCustomer(mixed), false, "Every recorded currency must be cleared");
}
const before = JSON.stringify(bothSettled);
isSettledCustomer(bothSettled);
assert.equal(
  JSON.stringify(bothSettled),
  before,
  "Disclosure classification never changes records",
);
console.log(
  "PASS settled customers: deliberate clearance across all currencies, reopened/zero/unknown/pending accounts stay visible, source records unchanged",
);
