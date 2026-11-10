import assert from "node:assert/strict";
import { isSettledCustomer } from "../settled-customers";
import { mergeCurrencyPeople } from "../multi-currency-view";
import { filterCustomerCurrencyRows } from "../customer-list";
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
const unused = {
  ...settled,
  is_settled: 0,
  last_entry_at: null,
} as PersonWithBalance;
for (const link of [
  {},
  { tab_id: "unused-afn", tab_closed_at: null, tab_other_joined: 1 as const },
]) {
  const afn = { ...unused, ...link };
  const sources = [[afn], [usd]];
  const snapshot = structuredClone(sources);
  const [merged] = mergeCurrencyPeople(sources, "AFN");
  assert.equal(
    isSettledCustomer(merged),
    true,
    "An unused private or shared AFN currency does not undo deliberately settled USD",
  );
  if (afn.tab_id) {
    assert.equal(merged.tab_id, afn.tab_id);
    assert.equal(
      merged.currency_balances?.find((row) => row.currency === "AFN"),
      afn,
      "An empty shared link remains available to sync and invitation actions",
    );
  }
  filterCustomerCurrencyRows([merged], "USD");
  assert.deepEqual(sources, snapshot, "Merging and filtering never rewrite source currencies");
}
for (const rows of [
  [unused],
  [{ ...unused, tab_id: "fresh-shared", tab_other_joined: 1 as const }],
  [unused, { ...unused, currency: "USD" }],
  [
    { ...settled, is_settled: 0 },
    { ...usd, is_settled: 0 },
  ],
]) {
  const [merged] = mergeCurrencyPeople(
    rows.map((row) => [row]),
    "AFN",
  );
  assert.equal(isSettledCustomer(merged), false, "A zero alone never means deliberately settled");
}
for (const patch of [
  { is_settled: 0, balance: 0 },
  { balance: 50, is_settled: 0 },
  { tab_pending_count: 1, tab_pending_balance: 0 },
  { tab_unsynced: 1 as const },
]) {
  const [mixed] = mergeCurrencyPeople([[settled], [{ ...usd, ...patch }]], "AFN");
  assert.equal(isSettledCustomer(mixed), false, "Every recorded currency must be cleared");
}
for (const patch of [
  { tab_pending: 1 },
  { tab_pending_count: 1, tab_pending_balance: 0 },
  { tab_pending_balance: -1 },
  { tab_close_pending: 1 },
  { tab_unsynced: 1 as const },
  { balance: Number.NaN },
]) {
  const [merged] = mergeCurrencyPeople([[{ ...unused, ...patch }], [usd]], "AFN");
  assert.equal(
    isSettledCustomer(merged),
    false,
    "Unresolved work in an otherwise unused currency blocks settlement",
  );
  const projected = filterCustomerCurrencyRows([merged], "USD")[0];
  assert.equal(
    isSettledCustomer(projected),
    false,
    "Filtering unresolved work out does not settle the whole contact",
  );
}
const [partlySettled] = mergeCurrencyPeople([[settled], [{ ...usd, balance: -25 }]], "AFN");
const clearedProjection = filterCustomerCurrencyRows([partlySettled], "AFN")[0];
assert.equal(clearedProjection.balance, 0);
assert.equal(clearedProjection.is_settled, 1, "The original AFN period marker remains intact");
assert.equal(clearedProjection.customer_is_settled, false);
assert.equal(
  isSettledCustomer(clearedProjection),
  false,
  "A currency filter cannot hide outstanding USD behind a checkmark",
);
assert.equal(isSettledCustomer(filterCustomerCurrencyRows([bothSettled], "AFN")[0]), true);
const before = JSON.stringify(bothSettled);
isSettledCustomer(bothSettled);
assert.equal(
  JSON.stringify(bothSettled),
  before,
  "Disclosure classification never changes records",
);
console.log(
  "PASS settled customers: aggregate clearance, unused shared links, zero/unknown/pending states, currency filters and immutable source records",
);
