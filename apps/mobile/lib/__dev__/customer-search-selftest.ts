import assert from "node:assert/strict";
import {
  CUSTOMER_SORTS,
  CUSTOMER_BALANCE_FILTERS,
  DEFAULT_CUSTOMER_LIST,
  DEFAULT_CUSTOMER_SEARCH,
  compareCustomerNames,
  customerSide,
  availableCustomerCurrencyFilter,
  selectedCustomerCurrencyCodes,
  toggleCustomerCurrencyFilter,
  filterCustomerCurrencyRows,
  parseCustomerListPreference,
  parseCustomerSearchPreference,
  parseHomeCustomerListPreference,
  selectCustomers,
  selectNeverTalliedCustomers,
  selectSearchCustomers,
  type CustomerSort,
  type CustomerBalanceFilter,
} from "../customer-list";
import type { PersonWithBalance } from "../types";

function person(
  id: string,
  name: string,
  balance: number,
  last_entry_at: number | null,
  extra: Partial<PersonWithBalance> = {},
): PersonWithBalance {
  return {
    id,
    name,
    balance,
    last_entry_at,
    phone: null,
    created_at: 1,
    archived_at: null,
    tab_id: null,
    tab_closed_at: null,
    tab_pending: 0,
    tab_other_joined: 0,
    ...extra,
  };
}

const people = [
  person("a", "Amir", 100, 20),
  person("b", "Bashir", -20, 30),
  person("c", "Camal", 0, 40, { is_settled: 1, last_entry_type: "payment" }),
  person("d", "Dawood", -200, 15),
  person("e", "Ehsan", 10, 10),
];
const originalPeople = JSON.stringify(people);
const ids = (sort: CustomerSort) =>
  selectSearchCustomers(people, { sort, group: "all" }, {}, "en").map((p) => p.id);

assert.deepEqual(DEFAULT_CUSTOMER_SEARCH, {
  sort: "outstanding_name",
  group: "all",
  direction: "all",
});
assert.deepEqual(DEFAULT_CUSTOMER_LIST, { sort: "recent", group: "all", direction: "all" });
assert.deepEqual(parseHomeCustomerListPreference(null, null), DEFAULT_CUSTOMER_LIST);
assert.deepEqual(
  parseHomeCustomerListPreference(null, '{"sort":"outstanding_name","group":["shop","family"]}'),
  { sort: "recent", group: ["family", "shop"], direction: "all" },
  "the inherited search default cannot keep recent work in alphabetical order",
);
assert.deepEqual(
  parseHomeCustomerListPreference(null, '{"sort":"amount_desc","group":"family"}'),
  { sort: "amount_desc", group: "family", direction: "all" },
  "migration retains other chosen sorts and group filters",
);
assert.deepEqual(
  parseHomeCustomerListPreference(
    '{"sort":"outstanding_name","group":"ungrouped"}',
    '{"sort":"recent","group":"family"}',
  ),
  { sort: "outstanding_name", group: "ungrouped", direction: "all" },
  "an explicit homepage choice wins, including the old search default",
);
assert.deepEqual(
  parseHomeCustomerListPreference("invalid", '{"sort":"name_desc","group":"family"}'),
  DEFAULT_CUSTOMER_LIST,
  "invalid current preferences use the homepage default rather than an old search setting",
);
assert.deepEqual(parseHomeCustomerListPreference(null, "invalid"), DEFAULT_CUSTOMER_LIST);
assert.deepEqual(ids("outstanding_name"), ["a", "b", "d", "e", "c"]);
assert.deepEqual(ids("name_asc"), ["a", "b", "c", "d", "e"]);
assert.deepEqual(ids("name_desc"), ["e", "d", "c", "b", "a"]);
assert.deepEqual(ids("amount_desc"), ["d", "a", "b", "e", "c"]);
assert.deepEqual(ids("amount_asc"), ["e", "b", "a", "d", "c"]);
assert.deepEqual(ids("date_asc"), ["e", "d", "a", "b", "c"]);
assert.deepEqual(ids("recent"), ["b", "a", "d", "e", "c"]);
for (const sort of CUSTOMER_SORTS) assert.equal(new Set(ids(sort)).size, people.length);

const extraPeople = [
  ...people,
  person("empty", "Amina", 0, null, { created_at: 100 }),
  person("zero", "Aziz", 0, 90, { is_settled: 0 }),
  person("pending-zero", "Ali Pending", 0, null, { tab_id: "shared-a", tab_unsynced: 1 }),
  person("pending-stale", "Zarif Pending", 500, 100, {
    tab_id: "shared-b",
    tab_unsynced: 1,
  }),
  // Inconsistent legacy metadata must not put a row displayed as settled first.
  person("settled-stale", "Aman Settled", 25, 110, { is_settled: 1 }),
];
assert.deepEqual(
  selectSearchCustomers(extraPeople, DEFAULT_CUSTOMER_SEARCH, {}, "en").map((p) => p.id),
  ["a", "b", "d", "e", "pending-zero", "pending-stale", "settled-stale", "empty", "zero", "c"],
  "both financial sides interleave by name; unknown balances precede verified zero/settled rows",
);
const changedStaleBalances = extraPeople.map((p) =>
  p.tab_unsynced === 1 ? { ...p, balance: p.balance === 0 ? -9999 : 0 } : p,
);
const pendingGiven = person("pending-given", "Ali Pending", 0, 100, {
  tab_id: "shared-pending",
  tab_pending_count: 1,
  tab_pending_balance: 40,
  last_entry_type: "debt",
});
const amountTierPeople = [...extraPeople, pendingGiven];
const beforeAmountTiers = JSON.stringify(amountTierPeople);
for (const [sort, outstanding] of [
  ["amount_asc", ["e", "b", "a", "d"]],
  ["amount_desc", ["d", "a", "b", "e"]],
] as const) {
  const expected = [
    ...outstanding,
    "pending-zero",
    "pending-stale",
    "pending-given",
    "settled-stale",
    "empty",
    "zero",
    "c",
  ];
  assert.deepEqual(
    selectSearchCustomers(amountTierPeople, { sort, group: "all" }, {}, "en").map((p) => p.id),
    expected,
    `${sort}: known collect/pay magnitudes precede unknown balances, then zero, no-entry and settled contacts`,
  );
  assert.deepEqual(
    selectSearchCustomers(
      [...changedStaleBalances, { ...pendingGiven, tab_pending_balance: -99999 }].map((p) =>
        p.is_settled === 1 ? { ...p, balance: 99999 } : p,
      ),
      { sort, group: "all" },
      {},
      "en",
    ).map((p) => p.id),
    expected,
    `${sort}: cached unknown amounts, stale settled amounts and pending-only deltas have no numeric rank`,
  );
  assert.deepEqual(
    selectSearchCustomers(
      [...amountTierPeople, people[0]],
      { sort, group: ["family", "shop"], direction: "collect" },
      { a: ["family", "shop"], e: "shop", d: "family", zero: "family", "pending-zero": "shop" },
      "en",
    ).map((p) => p.id),
    sort === "amount_asc" ? ["e", "a"] : ["a", "e"],
    `${sort}: group OR and confirmed-direction filters compose without duplicates or zero/unknown leakage`,
  );
}
assert.equal(
  JSON.stringify(amountTierPeople),
  beforeAmountTiers,
  "amount sorting leaves ledger metadata intact",
);
assert.equal(customerSide(pendingGiven), "collect", "an unconfirmed loan stays on its giving side");
assert.equal(
  customerSide({ ...pendingGiven, tab_pending_balance: -40, last_entry_type: "payment" }),
  "pay",
  "an unconfirmed receipt stays on its receiving side",
);
assert.equal(
  customerSide({ ...pendingGiven, balance: -10 }),
  "pay",
  "confirmed debt direction takes precedence over an opposing pending change",
);
assert.deepEqual(
  selectSearchCustomers([people[2], pendingGiven], DEFAULT_CUSTOMER_SEARCH, {}, "en").map(
    (p) => p.id,
  ),
  ["pending-given", "c"],
  "a pending-only shared account is not buried among settled contacts",
);
assert.deepEqual(
  selectSearchCustomers(changedStaleBalances, DEFAULT_CUSTOMER_SEARCH, {}, "en").map((p) => p.id),
  selectSearchCustomers(extraPeople, DEFAULT_CUSTOMER_SEARCH, {}, "en").map((p) => p.id),
  "cached amounts cannot change the default position of an unknown shared ledger",
);
assert.equal(
  selectSearchCustomers(
    [...people, extraPeople.find((p) => p.id === "empty")!],
    { sort: "recent", group: "all" },
    {},
    "en",
  )[0].id,
  "empty",
  "never-tallied contacts use creation time when recent activity is chosen",
);

for (const [locale, names, expected] of [
  ["en", ["Ahmad 10", "Ahmad 2", "Ahmad 1"], ["Ahmad 1", "Ahmad 2", "Ahmad 10"]],
  ["fa", ["دکان ۱۰", "دکان ۲", "دکان ۱"], ["دکان ۱", "دکان ۲", "دکان ۱۰"]],
] as const) {
  assert.deepEqual(
    selectSearchCustomers(
      names.map((name, index) => person(`named-${index}`, name, index % 2 ? -10 : 10, 1)),
      DEFAULT_CUSTOMER_SEARCH,
      {},
      locale,
    ).map((p) => p.name),
    expected,
    "natural name ordering works across both sides in each locale",
  );
}

// Collator reuse must preserve the existing base-sensitive natural ordering,
// including mixed digit scripts, equal numeric chunks and locale changes.
const namesToCompare = ["", "Ahmad", "ahmad", "Áhmad", "عبدالله", "غلام", "څانګه", "ښاغلی"];
for (const locale of ["en", "fa", "ps", "fa", "en"] as const) {
  for (const a of namesToCompare) {
    for (const b of namesToCompare) {
      assert.equal(
        Math.sign(compareCustomerNames(a, b, locale)),
        Math.sign(a.localeCompare(b, locale, { sensitivity: "base" })),
        `${locale}: ${a} / ${b}`,
      );
    }
  }
  for (const [earlier, later] of [
    ["Ahmad 2", "Ahmad 10"],
    ["Ahmad 02", "Ahmad 10"],
    ["دکان ٢", "دکان ۱۰"],
    ["دکان ۲", "دکان ۱۰"],
    ["رحمت 99999999999999999999", "رحمت 100000000000000000000"],
  ]) {
    assert.ok(compareCustomerNames(earlier, later, locale) < 0, `${locale}: ${earlier}`);
    assert.ok(compareCustomerNames(later, earlier, locale) > 0, `${locale}: ${later}`);
  }
  for (const [a, b] of [
    ["Ahmad 2", "Ahmad 02"],
    ["دکان ٢", "دکان ۲"],
  ]) {
    assert.equal(
      Math.sign(compareCustomerNames(a, b, locale)),
      Math.sign(a.localeCompare(b, locale, { sensitivity: "base" })),
      "equal numeric values retain the original full-name tie break",
    );
  }
}

const memberships = { a: ["family", "shop"], b: "shop", c: null, d: ["family"] };
assert.deepEqual(
  selectSearchCustomers(
    [...people, people[0]],
    { ...DEFAULT_CUSTOMER_SEARCH, group: ["family", "shop"] },
    memberships,
    "en",
  ).map((p) => p.id),
  ["a", "b", "d"],
  "group OR filters and duplicate input IDs produce one combined row per customer",
);
assert.deepEqual(
  selectSearchCustomers(
    people,
    { ...DEFAULT_CUSTOMER_SEARCH, group: "ungrouped" },
    memberships,
    "en",
  ).map((p) => p.id),
  ["e", "c"],
);
assert.deepEqual(
  selectSearchCustomers(
    people,
    { ...DEFAULT_CUSTOMER_SEARCH, group: "missing" },
    memberships,
    "en",
  ),
  [],
);

for (const sort of CUSTOMER_SORTS) {
  const relevance = new Map([
    ["a", 2],
    ["c", 3],
    ["e", 2],
  ]);
  const result = selectSearchCustomers(people, { sort, group: "all" }, {}, "en", relevance);
  if (sort === "amount_asc" || sort === "amount_desc") {
    assert.deepEqual(
      result.map((p) => p.id),
      ids(sort),
      "explicit amount order wins over relevance, including a literal settled match",
    );
    continue;
  }
  assert.equal(result[0].id, "c", "a literal settled match stays above fuzzy open suggestions");
  assert.deepEqual(
    result.slice(1, 3).map((p) => p.id),
    ids(sort).filter((id) => id === "a" || id === "e"),
    "chosen sort orders customers inside the same relevance tier",
  );
}

for (const raw of [null, "invalid", "{}", '{"sort":"bad","group":4}']) {
  assert.deepEqual(parseCustomerSearchPreference(raw), DEFAULT_CUSTOMER_SEARCH);
  assert.deepEqual(parseCustomerListPreference(raw), DEFAULT_CUSTOMER_LIST);
}
assert.deepEqual(
  parseCustomerSearchPreference('{"sort":"amount_asc","group":["shop","family","shop"]}'),
  { sort: "amount_asc", group: ["family", "shop"], direction: "all" },
  "existing explicit sort choices and group selections remain valid",
);
assert.deepEqual(
  parseCustomerSearchPreference('{"sort":"outstanding_name","group":"all"}'),
  DEFAULT_CUSTOMER_SEARCH,
);
assert.equal(parseCustomerListPreference('{"sort":"date_desc"}').sort, "recent");
assert.deepEqual(
  selectCustomers(people, "collect", DEFAULT_CUSTOMER_LIST, {}, "en").map((p) => p.id),
  ["a", "e", "c"],
  "the home page keeps its existing recent-activity order and financial side",
);
assert.deepEqual(
  selectCustomers(people, "pay", DEFAULT_CUSTOMER_LIST, {}, "en").map((p) => p.id),
  ["b", "d"],
);

assert.deepEqual(CUSTOMER_BALANCE_FILTERS, ["all", "collect", "pay"]);
const mixed = person("mixed", "Both currencies", 0, 60, {
  currency: "AFN",
  currency_balances: [
    person("mixed", "Both currencies", 100, 40, { currency: "AFN" }),
    person("mixed", "Both currencies", -100, 60, { currency: "USD" }),
  ],
});
const knownPay = person("known-pay", "Known pay and unknown", 9999, 70, {
  tab_unsynced: 1,
  currency_balances: [
    person("known-pay", "Known pay and unknown", 9999, 70, { currency: "AFN", tab_unsynced: 1 }),
    person("known-pay", "Known pay and unknown", -7, 50, { currency: "USD", tab_unsynced: 0 }),
    person("known-pay", "Known pay and unknown", 20, 40, { currency: "EUR", is_settled: 1 }),
  ],
});
const directionPeople = [
  mixed,
  knownPay,
  person("collect", "Collect only", 25, 20, { currency: "USD" }),
  person("pay", "Pay only", -30, 30, { currency: "AUD" }),
  person("empty-rows-pay", "Empty currency rows", -3, 10, { currency_balances: [] }),
  person("zero", "Zero with history", 0, 40),
  person("empty", "Empty contact", 0, null),
  person("settled", "Settled stale positive", 50, 50, { is_settled: 1 }),
  person("unknown", "Unknown positive", 80, 60, { tab_unsynced: 1 }),
  person("unknown-pay", "Unknown negative", -80, 60, { tab_unsynced: 1 }),
  person("pending-collect", "Pending collection", 0, 70, {
    tab_pending_count: 1,
    tab_pending_balance: 500,
    tab_confirmed_balance: 0,
  }),
  person("pending-pay", "Pending payment", 0, 80, {
    tab_pending_count: 1,
    tab_pending_balance: -500,
    tab_confirmed_balance: 0,
  }),
  person("confirmed-pay", "Confirmed payment", -4, 80, {
    tab_pending_count: 1,
    tab_pending_balance: 500,
    tab_confirmed_balance: -4,
  }),
  person("private-collect", "Private collection", 5, 80, {
    tab_pending_count: 1,
    tab_pending_balance: -500,
    tab_confirmed_balance: 0,
  }),
];
const originalDirections = JSON.stringify(directionPeople);
for (const row of directionPeople) {
  row.currency_balances?.forEach(Object.freeze);
  if (row.currency_balances) Object.freeze(row.currency_balances);
  Object.freeze(row);
}
Object.freeze(directionPeople);
const matches: Record<Exclude<CustomerBalanceFilter, "all">, ReadonlySet<string>> = {
  collect: new Set(["mixed", "collect", "private-collect"]),
  pay: new Set(["mixed", "known-pay", "pay", "empty-rows-pay", "confirmed-pay"]),
};
for (const sort of CUSTOMER_SORTS) {
  const unfiltered = selectSearchCustomers(directionPeople, { sort, group: "all" }, {}, "en");
  assert.deepEqual(
    selectSearchCustomers(directionPeople, { sort, group: "all", direction: "all" }, {}, "en"),
    unfiltered,
    "omitted direction keeps the backward-compatible All view",
  );
  for (const direction of ["collect", "pay"] as const) {
    const selected = selectSearchCustomers(
      directionPeople,
      { sort, group: "all", direction },
      {},
      "en",
    );
    assert.deepEqual(
      selected.map((row) => row.id),
      unfiltered.filter((row) => matches[direction].has(row.id)).map((row) => row.id),
      `${direction}/${sort}: filter preserves sort while every known denomination qualifies independently`,
    );
    assert.equal(
      selected.find((row) => row.id === "mixed"),
      mixed,
    );
    assert.equal(
      selected.find((row) => row.id === "mixed")!.currency_balances,
      mixed.currency_balances,
      "matching a sign keeps both currency rows intact, including the opposite balance",
    );
  }
}
const directionGroups = {
  mixed: ["family", "shop"],
  collect: "shop",
  "known-pay": "family",
  pay: "other",
  unknown: "family",
};
const directionRelevance = new Map([
  ["mixed", 1],
  ["known-pay", 3],
  ["pay", 10],
  ["unknown", 20],
]);
assert.deepEqual(
  selectSearchCustomers(
    [...directionPeople, mixed],
    { sort: "name_asc", group: ["family", "shop"], direction: "pay" },
    directionGroups,
    "en",
    directionRelevance,
  ).map((row) => row.id),
  ["known-pay", "mixed"],
  "group OR, direction and search relevance compose; unknown amounts cannot bypass the filter",
);
assert.deepEqual(
  selectSearchCustomers(
    directionPeople,
    { sort: "name_asc", group: "ungrouped", direction: "collect" },
    directionGroups,
    "en",
  ).map((row) => row.id),
  ["private-collect"],
);
assert.deepEqual(
  selectCustomers(
    people,
    "collect",
    { ...DEFAULT_CUSTOMER_LIST, direction: "collect" },
    {},
    "en",
  ).map((row) => row.id),
  ["a", "e"],
  "legacy side selection also excludes its zero/settled rows under an explicit sign filter",
);
assert.deepEqual(
  selectCustomers(
    [pendingGiven],
    "collect",
    { ...DEFAULT_CUSTOMER_LIST, direction: "collect" },
    {},
    "en",
  ),
  [],
  "legacy pending-side fallback never qualifies an unconfirmed-only balance",
);
assert.deepEqual(
  selectNeverTalliedCustomers(
    directionPeople,
    { ...DEFAULT_CUSTOMER_LIST, direction: "pay" },
    {},
    "en",
  ),
  [],
  "empty contacts have no confirmed balance direction",
);
assert.equal(
  selectNeverTalliedCustomers(directionPeople, DEFAULT_CUSTOMER_LIST, {}, "en").some(
    (row) => row.id === "empty",
  ),
  true,
);
for (const direction of CUSTOMER_BALANCE_FILTERS) {
  const raw = JSON.stringify({ sort: "amount_desc", group: ["shop", "family", "shop"], direction });
  const expected = { sort: "amount_desc", group: ["family", "shop"], direction };
  assert.deepEqual(parseCustomerListPreference(raw), expected);
  assert.deepEqual(parseCustomerSearchPreference(raw), expected);
  assert.deepEqual(
    parseCustomerListPreference(JSON.stringify(parseCustomerListPreference(raw))),
    expected,
  );
}
for (const direction of [null, "both", "to_pay", "", 7, ["pay"], true, {}]) {
  assert.deepEqual(
    parseCustomerListPreference(JSON.stringify({ sort: "name_desc", group: "family", direction })),
    { sort: "name_desc", group: "family", direction: "all" },
    "invalid saved directions fall back without losing sort or groups",
  );
}
assert.deepEqual(
  parseHomeCustomerListPreference(
    null,
    '{"sort":"outstanding_name","group":["shop"],"direction":"pay"}',
  ),
  { sort: "recent", group: ["shop"], direction: "pay" },
  "the inherited-sort migration preserves a valid balance filter",
);
assert.deepEqual(
  parseHomeCustomerListPreference(
    '{"sort":"date_desc","group":"ungrouped","direction":"collect"}',
    '{"sort":"name_desc","direction":"pay"}',
  ),
  { sort: "recent", group: "ungrouped", direction: "collect" },
  "current direction and existing sort migrations take precedence over legacy preferences",
);
assert.equal(
  JSON.stringify(directionPeople),
  originalDirections,
  "filtering never changes financial values, currencies, source order or pending metadata",
);

const soleCurrency = (id: string, balance: number, rowExtra: Partial<PersonWithBalance> = {}) =>
  person(id, id, 0, 10, {
    currency: "AFN",
    currency_balances: [person(id, id, balance, 10, { currency: "USD", ...rowExtra })],
  });
const amountPeople = [
  soleCurrency("usd-100", 100),
  soleCurrency("usd-5", 5),
  soleCurrency("usd-minus-200", -200),
  person("multi-scalar", "Multiple currencies", 10, 10, {
    currency: "AFN",
    currency_balances: [
      person("multi-scalar", "Multiple currencies", 9999, 10, { currency: "AFN" }),
      person("multi-scalar", "Multiple currencies", -9999, 10, { currency: "USD" }),
    ],
  }),
];
const beforeAmountSort = JSON.stringify(amountPeople);
assert.deepEqual(
  selectSearchCustomers(amountPeople, { sort: "amount_desc", group: "all" }, {}, "en").map(
    (row) => row.id,
  ),
  ["usd-minus-200", "usd-100", "multi-scalar", "usd-5"],
  "one active denomination sorts by its actual signed amount rather than an empty base-currency wrapper",
);
assert.deepEqual(
  selectSearchCustomers(amountPeople, { sort: "amount_asc", group: "all" }, {}, "en").map(
    (row) => row.id,
  ),
  ["usd-5", "multi-scalar", "usd-100", "usd-minus-200"],
  "ascending sorts use absolute sole-currency amounts; legacy multi-currency comparison never sums denominations",
);
assert.equal(JSON.stringify(amountPeople), beforeAmountSort);
const soleCurrencyStates = [
  { ...soleCurrency("known-child", -3), tab_unsynced: 1 as const, is_settled: 1 as const },
  soleCurrency("unknown-child", 99999, { tab_unsynced: 1 }),
  soleCurrency("settled-child", -99999, { is_settled: 1 }),
  soleCurrency("zero-child", 0),
];
const amountRelevancePeople = [
  person("exact-zero", "Exact Zero", 0, 10),
  person("fuzzy-small", "Z Small", -5, 10),
  person("exact-large", "A Large", 100, 10),
  person("equal-low", "A Equal", 5, 10),
  person("exact-unknown", "Exact Unknown", 99999, 10, { tab_unsynced: 1 }),
];
const amountRelevance = new Map([
  ["exact-zero", 10],
  ["exact-unknown", 10],
  ["exact-large", 9],
  ["fuzzy-small", 1],
]);
for (const sort of ["amount_asc", "amount_desc"] as const) {
  assert.deepEqual(
    selectSearchCustomers(soleCurrencyStates, { sort, group: "all" }, {}, "en").map((p) => p.id),
    ["known-child", "unknown-child", "settled-child", "zero-child"],
    `${sort}: sole-currency status overrides stale base-wrapper flags without mixing denominations`,
  );
  assert.deepEqual(
    selectSearchCustomers(
      amountRelevancePeople,
      { sort, group: "all" },
      {},
      "en",
      amountRelevance,
    ).map((p) => p.id),
    sort === "amount_asc"
      ? ["fuzzy-small", "equal-low", "exact-large", "exact-unknown", "exact-zero"]
      : ["exact-large", "fuzzy-small", "equal-low", "exact-unknown", "exact-zero"],
    `${sort}: magnitude and status win over search relevance; equal magnitudes use relevance`,
  );
  for (const locale of ["en", "fa", "ps"] as const) {
    assert.deepEqual(
      selectSearchCustomers(
        [person("tie-b", "Same", -12, 10), person("tie-a", "Same", 12, 10)],
        { sort, group: "all" },
        {},
        locale,
      ).map((p) => p.id),
      ["tie-a", "tie-b"],
      `${locale}/${sort}: equal opposite magnitudes retain deterministic name/ID ties`,
    );
  }
}
assert.equal(JSON.stringify(people), originalPeople, "search selection never mutates ledger rows");

const usdMixedRow = person("mixed-currency", "Old child name", -100, 10, {
  currency: "USD",
  tab_id: "usd-tab",
  tab_closed_at: null,
  tab_pending: 2,
  tab_other_joined: 1,
  tab_pending_count: 3,
  tab_pending_balance: 7,
  selection_totals: {
    currency: "USD",
    debtCount: 1,
    creditCount: 2,
    debtMinor: 2000,
    creditMinor: 12000,
  },
});
const mixedCurrency = person("mixed-currency", "Mixed customer", 100, 999, {
  currency: "AFN",
  phone: "+93700000000",
  tab_id: "afn-tab",
  tab_unsynced: 1,
  tab_close_pending: 1,
  is_settled: 1,
  tab_account_name: "AFN account",
  currency_balances: [
    person("mixed-currency", "Mixed customer", 100, 900, { currency: "AFN" }),
    usdMixedRow,
  ],
});
const currencyPeople = [
  mixedCurrency,
  person("usd-small", "Small", 5, 50, { currency: "USD" }),
  person("afn-only", "AFN only", -8, 700, { currency: "AFN" }),
  person("zero-history", "Zero history", 0, 20, { currency: "USD", is_settled: 0 }),
  person("usd-settled", "Settled", 0, 30, { currency: "USD", is_settled: 1 }),
  person("usd-pending", "Pending", 0, 40, {
    currency: "USD",
    tab_id: "pending-tab",
    tab_pending_count: 1,
    tab_pending_balance: 500,
  }),
  person("usd-unknown", "Unknown", 99999, 60, { currency: "USD", tab_unsynced: 1 }),
  person("empty-usd", "Empty USD", 0, null, { currency: "USD" }),
  person("empty-afn", "Empty AFN", 0, null, { currency: "AFN" }),
  person("empty-authoritative", "No currency rows", 500, 80, {
    currency: "USD",
    currency_balances: [],
  }),
];
const originalCurrencyPeople = JSON.stringify(currencyPeople);
for (const row of currencyPeople) {
  row.currency_balances?.forEach(Object.freeze);
  if (row.currency_balances) Object.freeze(row.currency_balances);
  Object.freeze(row);
}
Object.freeze(currencyPeople);
const usdPeople = filterCustomerCurrencyRows(currencyPeople, " usd ");
assert.deepEqual(
  usdPeople.map((row) => row.id),
  [
    "mixed-currency",
    "usd-small",
    "zero-history",
    "usd-settled",
    "usd-pending",
    "usd-unknown",
    "empty-usd",
  ],
  "specific currency retains matching zero/history/pending/unknown rows and only matching-base empty contacts",
);
const projectedMixed = usdPeople[0];
assert.notEqual(projectedMixed, mixedCurrency);
assert.equal(projectedMixed.id, mixedCurrency.id);
assert.equal(projectedMixed.name, mixedCurrency.name);
assert.equal(projectedMixed.phone, mixedCurrency.phone);
assert.equal(
  projectedMixed.balance,
  -100,
  "opposite equal AFN/USD balances never cancel or convert",
);
assert.equal(projectedMixed.last_entry_at, 10, "currency recency replaces the merged maximum date");
assert.equal(projectedMixed.currency, "USD");
assert.deepEqual(projectedMixed.currency_balances, [usdMixedRow]);
assert.equal(projectedMixed.selection_totals, usdMixedRow.selection_totals);
assert.equal(projectedMixed.tab_id, "usd-tab");
assert.equal(projectedMixed.tab_pending, 2);
assert.equal(projectedMixed.tab_pending_count, 3);
assert.equal(projectedMixed.tab_pending_balance, 7);
assert.equal(projectedMixed.tab_other_joined, 1);
for (const field of [
  "tab_unsynced",
  "tab_close_pending",
  "tab_account_name",
  "is_settled",
] as const)
  assert.equal(
    projectedMixed[field],
    undefined,
    `${field}: absent currency metadata cannot inherit a foreign value`,
  );
for (const currency of [undefined, "all", "ALL", "invalid", "US$"])
  assert.deepEqual(filterCustomerCurrencyRows(currencyPeople, currency), currencyPeople);
assert.deepEqual(
  filterCustomerCurrencyRows(currencyPeople, "EUR"),
  [],
  "foreign zeros are never manufactured",
);
for (const [currency, direction, expected] of [
  ["USD", "pay", ["mixed-currency"]],
  ["USD", "collect", ["usd-small"]],
  ["AFN", "collect", ["mixed-currency"]],
] as const) {
  assert.deepEqual(
    selectSearchCustomers(
      currencyPeople,
      { sort: "amount_asc", group: "all", currency, direction },
      {},
      "en",
    ).map((row) => row.id),
    expected,
    `${currency}/${direction}: only the selected currency's known confirmed sign qualifies`,
  );
}
for (const [sort, outstanding] of [
  ["amount_asc", ["usd-small", "mixed-currency"]],
  ["amount_desc", ["mixed-currency", "usd-small"]],
] as const) {
  assert.deepEqual(
    selectSearchCustomers(currencyPeople, { sort, group: "all", currency: "USD" }, {}, "en").map(
      (row) => row.id,
    ),
    [...outstanding, "usd-unknown", "empty-usd", "usd-pending", "usd-settled", "zero-history"],
    `${sort}: a selected denomination safely sorts known magnitudes before unknown and zero rows`,
  );
}
assert.deepEqual(
  selectSearchCustomers(
    [mixedCurrency, currencyPeople[1]],
    { sort: "recent", group: "all", currency: "USD" },
    {},
    "en",
  ).map((row) => row.id),
  ["usd-small", "mixed-currency"],
  "recent sorting uses selected-currency activity rather than the newest foreign tally",
);
assert.deepEqual(
  selectSearchCustomers(
    [...currencyPeople, mixedCurrency],
    { sort: "name_asc", group: ["family", "shop"], currency: "USD", direction: "pay" },
    { "mixed-currency": ["family", "shop"], "usd-small": "shop", "usd-unknown": "family" },
    "en",
    new Map([
      ["usd-unknown", 20],
      ["mixed-currency", 1],
    ]),
  ).map((row) => row.id),
  ["mixed-currency"],
  "currency, group OR, direction, relevance and deduplication compose on the same projected rows",
);
assert.deepEqual(
  selectCustomers(
    currencyPeople,
    "pay",
    { sort: "amount_asc", group: "all", currency: "USD" },
    {},
    "en",
  ).map((row) => row.id),
  ["mixed-currency"],
  "legacy financial-side matching also runs after currency projection",
);
assert.deepEqual(
  selectNeverTalliedCustomers(
    currencyPeople,
    { sort: "recent", group: "all", currency: "USD" },
    {},
    "en",
  ).map((row) => row.id),
  ["empty-usd"],
  "neutral contacts remain available only in their actual matching base currency",
);
const currencyPreference = {
  sort: "amount_asc",
  group: ["family", "shop"],
  direction: "pay",
  currency: "USD",
};
for (const parser of [parseCustomerListPreference, parseCustomerSearchPreference]) {
  assert.deepEqual(
    parser('{"sort":"amount_asc","group":["shop","family"],"direction":"pay","currency":" usd "}'),
    currencyPreference,
  );
  assert.deepEqual(parser(JSON.stringify(currencyPreference)), currencyPreference);
  for (const currency of [null, "all", "ALL", "", 7, [], true, {}, "US", "USDX", "US$"])
    assert.deepEqual(
      parser(JSON.stringify({ ...currencyPreference, currency })),
      {
        sort: "amount_asc",
        group: ["family", "shop"],
        direction: "pay",
      },
      "missing/invalid/all currency stays omitted without changing existing preference shapes",
    );
}
assert.deepEqual(
  parseHomeCustomerListPreference(
    null,
    '{"sort":"outstanding_name","currency":"usd","direction":"pay"}',
  ),
  { sort: "recent", group: "all", direction: "pay", currency: "USD" },
  "the existing inherited-sort migration preserves an explicit currency filter",
);
assert.equal(availableCustomerCurrencyFilter(" usd ", ["AFN", "USD"]), "USD");
assert.equal(availableCustomerCurrencyFilter("USD", ["afn", "usd"]), "USD");
assert.equal(
  availableCustomerCurrencyFilter("EUR", ["AFN", "USD"]),
  undefined,
  "stale saved currency resets to All",
);
assert.equal(availableCustomerCurrencyFilter("USD", []), undefined);
assert.equal(availableCustomerCurrencyFilter("all", ["AFN", "USD"]), undefined);
assert.equal(availableCustomerCurrencyFilter("US$", ["US$"]), undefined);
assert.deepEqual(selectedCustomerCurrencyCodes(["usd", " afn ", "USD", "invalid", null]), [
  "AFN",
  "USD",
]);
assert.deepEqual(availableCustomerCurrencyFilter(["USD", "AFN", "EUR"], ["AFN", "USD"]), [
  "AFN",
  "USD",
]);
assert.equal(availableCustomerCurrencyFilter(["USD", "EUR"], ["USD"]), "USD");
assert.equal(availableCustomerCurrencyFilter(["USD"], ["AFN"]), undefined);
assert.equal(toggleCustomerCurrencyFilter(undefined, "USD"), "USD");
assert.deepEqual(toggleCustomerCurrencyFilter("USD", "AFN"), ["AFN", "USD"]);
assert.equal(toggleCustomerCurrencyFilter(["AFN", "USD"], "USD"), "AFN");
assert.equal(toggleCustomerCurrencyFilter("AFN", "AFN"), undefined);
assert.deepEqual(parseCustomerListPreference('{"currency":["usd","AFN","USD","US$"]}'), {
  ...DEFAULT_CUSTOMER_LIST,
  currency: ["AFN", "USD"],
});
const selectedCurrencies = filterCustomerCurrencyRows(currencyPeople, ["AFN", "USD"]);
const selectedMixed = selectedCurrencies.find((row) => row.id === "mixed-currency")!;
assert.deepEqual(
  selectedMixed.currency_balances!.map((row) => row.currency),
  ["AFN", "USD"],
);
assert.equal(selectedMixed.currency_balances![0].balance, 100);
assert.equal(
  selectedMixed.currency_balances![1].balance,
  -100,
  "unlike currencies never net to zero",
);
assert.equal(
  selectedMixed.last_entry_at,
  900,
  "latest selected-currency activity replaces wrapper date",
);
assert.equal(new Set(selectedCurrencies.map((row) => row.id)).size, selectedCurrencies.length);
assert.deepEqual(
  selectSearchCustomers(
    [mixedCurrency, currencyPeople[1]],
    { sort: "amount_asc", group: "all", currency: ["AFN", "USD"] },
    {},
    "en",
  ).map((row) => row.id),
  ["mixed-currency", "usd-small"],
  "multi-currency amount order safely falls back to recent activity",
);
assert.deepEqual(
  selectSearchCustomers(
    [mixedCurrency],
    { sort: "recent", group: "all", direction: "pay", currency: ["AFN", "USD"] },
    {},
    "en",
  ).map((row) => row.id),
  ["mixed-currency"],
  "any selected known currency can satisfy a balance direction",
);
for (const direction of ["collect", "pay"] as const) {
  assert.deepEqual(
    selectCustomers(
      [mixedCurrency],
      direction,
      { sort: "recent", group: "all", currency: ["AFN", "USD"] },
      {},
      "en",
    ).map((row) => row.id),
    ["mixed-currency"],
    "financial-side lists match any selected denomination independently",
  );
}
assert.equal(
  JSON.stringify(currencyPeople),
  originalCurrencyPeople,
  "projection/filter/sort never mutates source money or metadata",
);

console.log(
  "PASS combined customer search: independent currency directions, confirmed/unknown/pending/settled filtering, preference migrations, all sorts, relevance/groups, deduplication and immutable balances",
);
