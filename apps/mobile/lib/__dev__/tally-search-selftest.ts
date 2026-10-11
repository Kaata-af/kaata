import assert from "node:assert/strict";
import { filterTallies, filterTalliesByNote, noteSearchTerms } from "../tally-search";
import type { TallySearchOptions } from "../tally-search";

const entries = [
  { id: "new", note: "Rice for home, café delivery", amount: 200 },
  { id: "pending", note: "كرایهٔ دكان ۱۲۳", amount: 100, status: "pending" },
  { id: "old", note: "خرید می‌رود", amount: 50, settled: true },
  { id: "rejected", note: "Rice [returned]", amount: 20, status: "disputed" },
  { id: "blank", note: null, amount: 500 },
];
function ids(query: string) {
  return filterTalliesByNote(entries, noteSearchTerms(query)).map((e) => e.id);
}
assert.deepEqual(
  ids("  "),
  entries.map((e) => e.id),
);
assert.deepEqual(ids("RICE"), ["new", "rejected"]);
assert.deepEqual(ids("delivery cafe"), ["new"]);
assert.deepEqual(ids("rice shop"), []);
assert.deepEqual(ids("[returned]"), ["rejected"]);
assert.deepEqual(ids(".*"), [], "query punctuation must never act as a regex");
assert.deepEqual(ids("کرایه دکان ١٢٣"), ["pending"]);
assert.deepEqual(ids("کرایه 123"), ["pending"]);
assert.deepEqual(ids("میرود"), ["old"], "ZWNJ-free queries match original notes");
assert.deepEqual(ids("می رود"), ["old"]);
assert.deepEqual(ids("delivery\nRICE"), ["new"]);
assert.deepEqual(ids("none"), [], "null-note tallies do not match a real query");
assert.equal(filterTalliesByNote(entries, noteSearchTerms("کرایه"))[0], entries[1]);
assert.equal(entries[2].note, "خرید می‌رود", "search must not rewrite a Dari note");
assert.equal(
  entries.reduce((sum, e) => sum + e.amount, 0),
  870,
);

const at = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12).getTime();
const tallies = [
  { id: "whole", note: "Rice delivery [returned]", amount_afn: 500, created_at: at(2026, 8, 5) },
  { id: "larger", note: "Beans for home", amount_afn: 5000, created_at: at(2026, 9, 7) },
  { id: "decimal", note: "كرایهٔ دكان", amount_afn: 1234.5, created_at: at(2026, 12, 31), settled: true },
  { id: "blank", note: null, amount_afn: 0.5, created_at: at(2026, 11, 17) },
  { id: "pending", note: "Awaiting review", amount_afn: 20, created_at: at(2026, 8, 6), status: "pending" },
  { id: "bad", note: "Failed locally", amount_afn: Number.NaN, created_at: Number.NaN, status: "failed" },
  { id: "historical", note: null, amount_afn: 75, created_at: at(622, 7, 18) },
];
const baseline = tallies.map((entry) => ({ ...entry }));
const gregorian: TallySearchOptions = { locale: "en", calendar: "gregorian" };
const shamsi: TallySearchOptions = { locale: "fa", calendar: "jalali" };
const qamari: TallySearchOptions = { locale: "fa", calendar: "qamari" };
const find = (query: string, options = gregorian) =>
  filterTallies(tallies, noteSearchTerms(query), options).map((entry) => entry.id);

assert.deepEqual(find("  \n"), tallies.map((entry) => entry.id));
assert.deepEqual(find("rice"), ["whole"]);
assert.deepEqual(find("delivery 500"), ["whole"], "terms can span notes and amounts");
assert.deepEqual(find("500"), ["whole"], "exact amount search must not match 5000");
assert.deepEqual(find("500.00"), ["whole"]);
assert.deepEqual(find("۵۰۰٫۰۰"), ["whole"]);
assert.deepEqual(find("٥٠٠"), ["whole"]);
assert.deepEqual(find("5,000"), ["larger"]);
assert.deepEqual(find("۵٬۰۰۰"), ["larger"]);
assert.deepEqual(find("1234.5"), ["decimal"]);
assert.deepEqual(find("1,234.50"), ["decimal"]);
assert.deepEqual(find("۱٬۲۳۴٫۵۰"), ["decimal"]);
assert.deepEqual(find("كرایه ١٢٣٤٫٥٠"), ["decimal"]);
assert.deepEqual(find("0.50"), ["blank"], "null notes still match their amount");
assert.deepEqual(find("۰,۵۰"), ["blank"], "comma decimal keyboards are accepted");
assert.deepEqual(find("12,34.50"), [], "malformed grouping is not stripped into a valid amount");
assert.deepEqual(find("1234.500"), [], "unsupported precision is not silently rounded");
assert.deepEqual(find(".*"), [], "punctuation remains literal, never a regular expression");
assert.deepEqual(find("[returned]"), ["whole"]);
assert.deepEqual(find("failed"), ["bad"], "invalid failed-row fields do not prevent note search");
assert.deepEqual(find("NaN"), [], "invalid numeric fields must not render into searchable text");

for (const [options, queries] of [
  [gregorian, ["5 Aug 2026", "5 August 2026", "۵ اگست ۲۰۲۶", "2026-08-05", "05/08/2026", "5.8.2026"]],
  [shamsi, ["14 Asad 1405", "۱۴ اسد ۱۴۰۵", "1405/05/14", "۱۴/۵/۱۴۰۵"]],
  [qamari, ["20 Safar 1448", "۲۰ صفر ۱۴۴۸", "1448/02/20", "۲۰/۲/۱۴۴۸"]],
] as const) {
  for (const query of queries) {
    assert.deepEqual(find(query, options), ["whole"], `selected-calendar date ${query}`);
    assert.deepEqual(find(query, { ...options, locale: options.locale === "fa" ? "en" : "fa" }),
      ["whole"], "month aliases work across UI language changes");
  }
}
assert.deepEqual(find("rice 500 Aug"), ["whole"]);
assert.deepEqual(find("rice 500 اسد", shamsi), ["whole"]);
assert.deepEqual(find("rice 500 صفر", qamari), ["whole"]);
assert.deepEqual(find("rice 20 Safar 1448", qamari), ["whole"], "a named date stays one condition within a mixed query");
assert.deepEqual(find("20 Safar 1448", qamari), ["whole"], "amount20 on 21 Safar cannot satisfy a day20 date query");
assert.deepEqual(find("August 2026"), ["whole", "pending"], "month names without a day filter the whole month");
assert.deepEqual(find("Aug 5000"), [], "every term must match the same tally");
assert.deepEqual(find("20"), ["pending"], "20 must not partially match the visible year 2026");
assert.deepEqual(find("2026", shamsi), [], "Gregorian years are not hidden aliases of Shamsi dates");
assert.deepEqual(find("2026", qamari), [], "Gregorian years are not hidden aliases of Qamari dates");
assert.deepEqual(find("Aug", qamari), [], "Gregorian month names do not leak into Qamari search");
assert.deepEqual(find("8/2026"), ["whole", "pending"], "month/year form");
assert.deepEqual(find("2026/8"), ["whole", "pending"], "year/month form");
assert.deepEqual(find("5/8"), ["whole"], "day/month form");
assert.deepEqual(find("2026/2/30"), [], "invalid or unrelated dates cannot match");
assert.deepEqual(find("18/7/622", qamari), ["historical"], "pre-Hijri fallback follows visible Gregorian date");

const farFuture = [{ note: null, amount_afn: 1, created_at: at(9999, 6, 1) }];
assert.equal(filterTallies(farFuture, noteSearchTerms("June 9999"), shamsi).length, 1,
  "out-of-range Shamsi dates use the same Gregorian fallback as the formatter");
const boundaryRows = [
  { id: "before", note: null, amount_afn: 1, created_at: new Date(2026, 7, 5, 23, 59).getTime() },
  { id: "after", note: null, amount_afn: 1, created_at: new Date(2026, 7, 6, 0, 1).getTime() },
];
assert.deepEqual(filterTallies(boundaryRows, noteSearchTerms("05/08/2026"), gregorian).map((e) => e.id),
  ["before"], "search uses viewer local midnight, not UTC midnight");
assert.deepEqual(filterTallies(boundaryRows, noteSearchTerms("06/08/2026"), gregorian).map((e) => e.id),
  ["after"]);
const leapBoundary = [
  { id: "leap-day", note: null, amount_afn: 1, created_at: at(2026, 6, 16) },
  { id: "new-year", note: null, amount_afn: 1, created_at: at(2026, 6, 17) },
];
assert.deepEqual(filterTallies(leapBoundary, noteSearchTerms("30/12/1447"), qamari).map((e) => e.id),
  ["leap-day"]);
assert.deepEqual(filterTallies(leapBoundary, noteSearchTerms("1/1/1448"), qamari).map((e) => e.id),
  ["new-year"]);
assert.deepEqual(filterTallies(leapBoundary, noteSearchTerms("30 Dhu al-Hijjah 1447"), qamari).map((e) => e.id),
  ["leap-day"], "multi-word English month names are bound to their day and year");
const epochRows = [
  { id: "epoch", note: null, amount_afn: 2, created_at: at(622, 7, 19) },
  { id: "after-epoch", note: null, amount_afn: 1, created_at: at(622, 7, 20) },
];
assert.deepEqual(filterTallies(epochRows, noteSearchTerms("1 Muharram 1"), qamari).map((e) => e.id),
  ["epoch"], "small calendar years are dates too; amount1 cannot stand in for day1");
assert.equal(filterTallies(tallies, noteSearchTerms("rice 500"), gregorian)[0], tallies[0]);
assert.deepEqual(tallies, baseline, "search never rewrites stored notes, amounts, dates or status");
assert.equal(tallies.filter((e) => Number.isFinite(e.amount_afn)).reduce((sum, e) => sum + e.amount_afn, 0),
  6830, "search does not change the full ledger total");
console.log("PASS: literal notes, exact localized amounts, all three selected calendars in EN/Dari, local midnight/leap/fallback dates, mixed terms and unchanged ledger data/order");
