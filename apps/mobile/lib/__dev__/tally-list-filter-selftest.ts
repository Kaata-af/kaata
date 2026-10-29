import assert from "node:assert/strict";
import {
  DEFAULT_TALLY_LIST_FILTER,
  TallyAmountSortCurrencyError,
  filterTallyEntries,
  normalizeTallyCurrencies,
  normalizeTallyListFilter,
  sortTallyEntries,
  swipeTallyDirection,
  tallyAmountSortAvailable,
  toggleTallyCardFilter,
  type TallyListFilter,
} from "../tally-list-filter";
import { filterTallies, noteSearchTerms } from "../tally-search";
import { filterTalliesByDate } from "../tally-date-filter";

const row = (
  id: string,
  type: "debt" | "payment",
  currency: string | undefined,
  amount_afn: number,
  created_at: number,
  status = "recorded",
) => ({
  id,
  type,
  currency,
  amount_afn,
  created_at,
  note: "rice delivery",
  tab: { status, kind: "normal" },
  settled_at: status === "settled" ? 500 : null,
});
const entries = [
  row("afn-gave", "debt", "AFN", 10, 100),
  row("usd-received", "payment", "USD", 20, 200),
  row("aud-gave-pending", "debt", "AUD", 30, 300, "pending"),
  row("afn-received-settled", "payment", "AFN", 40, 400, "settled"),
  row("usd-gave-rejected", "debt", "USD", 50, 500, "rejected"),
  row("legacy-received", "payment", undefined, 60, 600),
  row("unknown-failed", "payment", "bad", Number.NaN, Number.NaN, "failed"),
];
const original = entries.map((entry) => ({ ...entry, tab: { ...entry.tab } }));
const ids = (rows: readonly { id: string }[]) => rows.map((entry) => entry.id);
const all: TallyListFilter = { ...DEFAULT_TALLY_LIST_FILTER, currencies: [] };

assert.deepEqual(normalizeTallyCurrencies([" usd ", "AFN", "usd", "AUD", "ALL", "A$", 5]), [
  "AFN",
  "ALL",
  "AUD",
  "USD",
]);
assert.deepEqual(normalizeTallyCurrencies(undefined), []);
assert.deepEqual(
  normalizeTallyListFilter({ direction: "gave", currencies: ["EUR", "USD"] }, ["AFN", "USD"]),
  {
    direction: "gave",
    currencies: ["USD"],
    sort: "recent",
  },
);
assert.deepEqual(ids(filterTallyEntries(entries, all, "AFN")), ids(entries));
assert.deepEqual(ids(filterTallyEntries(entries, { ...all, direction: "received" }, "AFN")), [
  "usd-received",
  "afn-received-settled",
  "legacy-received",
  "unknown-failed",
]);
assert.deepEqual(
  ids(
    filterTallyEntries(entries, { ...all, direction: "gave", currencies: ["USD", "AUD"] }, "AFN"),
  ),
  ["aud-gave-pending", "usd-gave-rejected"],
);
assert.deepEqual(ids(filterTallyEntries(entries, { ...all, currencies: ["AFN"] }, "AFN")), [
  "afn-gave",
  "afn-received-settled",
  "legacy-received",
]);
assert.deepEqual(ids(filterTallyEntries(entries, { ...all, currencies: ["EUR"] }, "AFN")), []);
const matching = filterTallyEntries(entries, { ...all, currencies: ["USD"] }, "AFN");
assert.equal(matching[0], entries[1]);
assert.equal(
  matching[1].tab,
  entries[4].tab,
  "Filtering preserves pending/rejected evidence by reference",
);
assert.deepEqual(entries, original, "View filters never mutate stored amounts, statuses or notes");

const mixed = sortTallyEntries(entries, "recent", "AFN");
assert.deepEqual(ids(mixed), [
  "legacy-received",
  "usd-gave-rejected",
  "afn-received-settled",
  "aud-gave-pending",
  "usd-received",
  "afn-gave",
  "unknown-failed",
]);
assert.deepEqual(ids(sortTallyEntries(entries, "date_asc", "AFN")), ids(entries));
assert.throws(() => sortTallyEntries(entries, "amount_asc", "AFN"), TallyAmountSortCurrencyError);
assert.throws(
  () => sortTallyEntries([row("untagged", "debt", undefined, 10, 1)], "amount_asc"),
  TallyAmountSortCurrencyError,
);
assert.deepEqual(sortTallyEntries([], "amount_asc"), []);

const amounts = [
  row("zero-new", "debt", "USD", 0, 500),
  row("large", "payment", "USD", 100, 200),
  row("small-old", "debt", "USD", 1.01, 100),
  row("small-tie-a", "payment", "USD", 1.01, 300),
  row("small-tie-b", "debt", "USD", 1.01, 300),
  row("zero-old", "payment", "USD", 0, 50),
  row("failed-invalid", "debt", "USD", Number.NaN, 1000, "failed"),
];
assert.deepEqual(ids(sortTallyEntries(amounts, "amount_asc")), [
  "small-tie-a",
  "small-tie-b",
  "small-old",
  "large",
  "zero-new",
  "zero-old",
  "failed-invalid",
]);
assert.deepEqual(ids(sortTallyEntries(amounts, "amount_desc")), [
  "large",
  "small-tie-a",
  "small-tie-b",
  "small-old",
  "zero-new",
  "zero-old",
  "failed-invalid",
]);
assert.deepEqual(ids(amounts), [
  "zero-new",
  "large",
  "small-old",
  "small-tie-a",
  "small-tie-b",
  "zero-old",
  "failed-invalid",
]);
assert.equal(sortTallyEntries(amounts, "amount_asc")[0], amounts[3]);
assert.deepEqual(
  ids(
    sortTallyEntries(
      [row("legacy", "debt", undefined, 20, 2), row("explicit", "debt", "AFN", 10, 1)],
      "amount_asc",
      "AFN",
    ),
  ),
  ["explicit", "legacy"],
);

const codes = ["AFN", "USD", "AUD"];
assert.equal(tallyAmountSortAvailable(all, codes), false);
assert.equal(tallyAmountSortAvailable({ currencies: ["USD"] }, codes), true);
assert.equal(tallyAmountSortAvailable({ currencies: ["USD", "AUD"] }, codes), false);
assert.equal(tallyAmountSortAvailable(all, ["AFN"]), true);
assert.equal(tallyAmountSortAvailable({ currencies: ["EUR"] }, codes), false);
assert.deepEqual(normalizeTallyListFilter({ ...all, sort: "amount_asc" }, codes), all);
let filter = toggleTallyCardFilter(all, "received", "USD", codes);
assert.deepEqual(filter, { direction: "received", currencies: ["USD"], sort: "recent" });
assert.deepEqual(toggleTallyCardFilter(filter, "received", "USD", codes), all);
assert.deepEqual(toggleTallyCardFilter(filter, "gave", "AUD", codes), {
  direction: "gave",
  currencies: ["AUD"],
  sort: "recent",
});
assert.deepEqual(
  toggleTallyCardFilter({ ...filter, currencies: [] }, "received", "USD", codes),
  filter,
  "A card scopes an existing all-currency side instead of toggling it off",
);
assert.deepEqual(
  toggleTallyCardFilter({ ...filter, currencies: ["AUD", "USD"] }, "received", "USD", codes),
  filter,
);
assert.deepEqual(toggleTallyCardFilter(filter, "gave", "EUR", codes), filter);
filter = { ...filter, sort: "amount_desc" };
assert.deepEqual(swipeTallyDirection(filter, "received", codes), {
  direction: "received",
  currencies: [],
  sort: "recent",
});
assert.deepEqual(
  swipeTallyDirection({ ...all, direction: "received" }, "received", codes),
  { ...all, direction: "received" },
  "Repeated same-side swipes retain that side",
);
assert.deepEqual(
  toggleTallyCardFilter(filter, "received", "USD", codes),
  all,
  "Clearing the only currency also clears ambiguous amount ordering",
);
assert.deepEqual(toggleTallyCardFilter(all, "gave", "AFN", ["AFN"]), { ...all, direction: "gave" });
assert.deepEqual(toggleTallyCardFilter({ ...all, direction: "gave" }, "gave", "AFN", ["AFN"]), all);
assert.deepEqual(swipeTallyDirection({ ...all, sort: "amount_asc" }, "gave", ["AFN"]), {
  ...all,
  direction: "gave",
  sort: "amount_asc",
});

const viewed = filterTalliesByDate(
  filterTallies(
    filterTallyEntries(entries, { ...all, direction: "gave", currencies: ["USD"] }, "AFN"),
    noteSearchTerms("rice"),
  ),
  { start: 400, end: 600 },
);
assert.deepEqual(
  ids(viewed),
  ["usd-gave-rejected"],
  "Direction/currency compose with existing note and date filtering",
);
assert.deepEqual(entries, original);
assert.deepEqual(DEFAULT_TALLY_LIST_FILTER, all);
console.log(
  "PASS tally view filters: received/gave, currency-scoped cards, all-currency swipes, stable comparable amount/date sorting, zero-last ordering and intact record metadata",
);
