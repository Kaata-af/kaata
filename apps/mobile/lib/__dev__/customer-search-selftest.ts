import assert from "node:assert/strict";
import {
  CUSTOMER_SORTS,
  DEFAULT_CUSTOMER_LIST,
  DEFAULT_CUSTOMER_SEARCH,
  compareCustomerNames,
  parseCustomerListPreference,
  parseCustomerSearchPreference,
  selectCustomers,
  selectSearchCustomers,
  type CustomerSort,
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

assert.deepEqual(DEFAULT_CUSTOMER_SEARCH, { sort: "outstanding_name", group: "all" });
assert.deepEqual(DEFAULT_CUSTOMER_LIST, { sort: "recent", group: "all" });
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
  { sort: "amount_asc", group: ["family", "shop"] },
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
assert.equal(JSON.stringify(people), originalPeople, "search selection never mutates ledger rows");

console.log(
  "PASS combined customer search: outstanding/name default, all alternate sorts, relevance tiers, unknown balances, groups, deduplication, and unchanged home defaults",
);
