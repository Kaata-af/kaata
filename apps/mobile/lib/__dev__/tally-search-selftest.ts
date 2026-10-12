import assert from "node:assert/strict";
import { filterTallies, filterTalliesByNote, noteSearchTerms } from "../tally-search";
import type { TallySearchOptions } from "../tally-search";
import {
  adjacentCalendarMonth,
  calendarDay,
  calendarMonthDays,
  customDateRange,
  datePresetRange,
  dateRangeDraft,
  dateRangeBetween,
  filterTalliesByDate,
  formatFilterClock,
  localDayStart,
  localMinute,
  shiftLocalDay,
} from "../tally-date-filter";

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
  {
    id: "decimal",
    note: "كرایهٔ دكان",
    amount_afn: 1234.5,
    created_at: at(2026, 12, 31),
    settled: true,
  },
  { id: "blank", note: null, amount_afn: 0.5, created_at: at(2026, 11, 17) },
  {
    id: "pending",
    note: "Awaiting review",
    amount_afn: 20,
    created_at: at(2026, 8, 6),
    status: "pending",
  },
  {
    id: "bad",
    note: "Failed locally",
    amount_afn: Number.NaN,
    created_at: Number.NaN,
    status: "failed",
  },
  { id: "historical", note: null, amount_afn: 75, created_at: at(622, 7, 18) },
];
const baseline = tallies.map((entry) => ({ ...entry }));
const gregorian: TallySearchOptions = { locale: "en", calendar: "gregorian" };
const shamsi: TallySearchOptions = { locale: "fa", calendar: "jalali" };
const qamari: TallySearchOptions = { locale: "fa", calendar: "qamari" };
const find = (query: string, options = gregorian) =>
  filterTallies(tallies, noteSearchTerms(query), options).map((entry) => entry.id);

assert.deepEqual(
  find("  \n"),
  tallies.map((entry) => entry.id),
);
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

for (const options of [gregorian, shamsi, qamari]) {
  assert.deepEqual(find("2026", options), [], "a year is not an implicit date query");
  assert.deepEqual(find("Aug", options), [], "month names no longer match hidden date fields");
  assert.deepEqual(find("20", options), ["pending"], "numbers match money, not days of month");
}
const boundaryRows = [
  { id: "outside-before", created_at: new Date(2026, 7, 4, 23, 59).getTime() },
  { id: "start", created_at: new Date(2026, 7, 5, 0, 0).getTime() },
  { id: "late", created_at: new Date(2026, 7, 5, 23, 59).getTime() },
  { id: "end", created_at: new Date(2026, 7, 6, 0, 0).getTime() },
  { id: "invalid", created_at: Number.NaN },
];
const range = dateRangeBetween(at(2026, 8, 5), at(2026, 8, 5));
assert.deepEqual(
  filterTalliesByDate(boundaryRows, range).map((e) => e.id),
  ["start", "late"],
  "inclusive local dates with exclusive next midnight",
);
assert.deepEqual(
  filterTalliesByDate(boundaryRows, null),
  boundaryRows,
  "clearing restores all rows, including invalid failed-row dates",
);
assert.deepEqual(
  dateRangeBetween(at(2026, 8, 6), at(2026, 8, 5)),
  dateRangeBetween(at(2026, 8, 5), at(2026, 8, 6)),
  "reverse selection is normalized",
);
const minuteRange = customDateRange(at(2026, 8, 5), at(2026, 8, 5), 10 * 60 + 15, 11 * 60 + 30)!;
assert.deepEqual(
  filterTalliesByDate(
    [
      { id: "before", created_at: minuteRange.start - 1 },
      { id: "start", created_at: minuteRange.start },
      { id: "final-second", created_at: minuteRange.end - 1 },
      { id: "next-minute", created_at: minuteRange.end },
    ],
    minuteRange,
  ).map((row) => row.id),
  ["start", "final-second"],
  "custom clocks include every second of the end minute and exclude the next minute",
);
assert.deepEqual(dateRangeDraft(minuteRange), {
  first: localDayStart(at(2026, 8, 5)),
  last: localDayStart(at(2026, 8, 5)),
  startMinute: 615,
  endMinute: 690,
});
assert.equal(
  customDateRange(at(2026, 8, 5), at(2026, 8, 5), 615, 614),
  null,
  "same-day reversed clocks must remain invalid",
);
assert.equal(
  customDateRange(at(2026, 8, 5), at(2026, 8, 5), 615, 615)!.end -
    customDateRange(at(2026, 8, 5), at(2026, 8, 5), 615, 615)!.start,
  60_000,
);
assert.deepEqual(
  customDateRange(at(2026, 8, 6), at(2026, 8, 5), 615, 614),
  customDateRange(at(2026, 8, 5), at(2026, 8, 6), 615, 614),
  "reversed days are normalized while clocks stay on their chronological endpoints",
);
assert.deepEqual(
  dateRangeDraft(customDateRange(at(2026, 8, 5), at(2026, 8, 6), 0, 1439)),
  {
    first: localDayStart(at(2026, 8, 5)),
    last: localDayStart(at(2026, 8, 6)),
    startMinute: 0,
    endMinute: 1439,
  },
  "exclusive next-midnight end reopens on the inclusive selected day",
);
assert.deepEqual(
  dateRangeDraft(range),
  {
    first: range.start,
    last: range.start,
    startMinute: 0,
    endMinute: 1439,
  },
  "whole-day presets have whole-day custom defaults",
);
assert.deepEqual(dateRangeDraft(null), {
  first: null,
  last: null,
  startMinute: 0,
  endMinute: 1439,
});
assert.equal(formatFilterClock(minuteRange.start, "en"), "10:15");
assert.equal(formatFilterClock(minuteRange.start, "fa"), "۱۰:۱۵");
assert.equal(formatFilterClock(Number.NaN, "en"), "");
for (const badMinute of [-1, 1440, 0.5, Number.NaN]) {
  assert.equal(localMinute(at(2026, 8, 5), badMinute), null);
  assert.equal(customDateRange(at(2026, 8, 5), at(2026, 8, 5), badMinute, 1439), null);
}
assert.equal(localMinute(Number.NaN, 0), null);
for (const options of [gregorian, shamsi, qamari]) {
  const month = calendarMonthDays(at(2026, 8, 5), options.calendar);
  assert.ok(month.length >= 29 && month.length <= 31);
  assert.equal(calendarDay(month[0], options.calendar).day, 1);
  month.forEach((day, index) => assert.equal(calendarDay(day, options.calendar).day, index + 1));
  assert.equal(
    calendarDay(adjacentCalendarMonth(month[0], 1, options.calendar), options.calendar).day,
    1,
  );
  assert.equal(shiftLocalDay(adjacentCalendarMonth(month[0], -1, options.calendar), 1), month[0]);
  assert.deepEqual(
    datePresetRange("month", at(2026, 8, 5), options.calendar),
    dateRangeBetween(month[0], month.at(-1)!),
  );
  assert.deepEqual(
    filterTalliesByDate(tallies, datePresetRange("today", at(2026, 8, 5), options.calendar)).map(
      (e) => e.id,
    ),
    ["whole"],
  );
}
assert.equal(calendarMonthDays(at(2026, 2, 10), "gregorian").length, 28);
assert.equal(calendarMonthDays(at(2024, 2, 10), "gregorian").length, 29);
assert.equal(calendarMonthDays(at(2025, 3, 20), "jalali").length, 30, "Solar leap Esfand");
assert.equal(calendarMonthDays(at(2026, 3, 20), "jalali").length, 29, "ordinary Esfand");
assert.equal(calendarMonthDays(at(2026, 6, 16), "qamari").length, 30, "lunar leap Dhu al-Hijjah");
assert.deepEqual(calendarDay(at(2026, 6, 17), "qamari"), {
  year: 1448,
  month: 1,
  day: 1,
  calendar: "qamari",
});
assert.equal(
  calendarDay(at(622, 7, 18), "qamari").calendar,
  "gregorian",
  "pre-epoch fallback follows visible dates",
);
assert.equal(
  calendarDay(at(9999, 6, 1), "jalali").calendar,
  "gregorian",
  "out-of-range Solar fallback",
);
assert.deepEqual(
  datePresetRange("last7", at(2026, 8, 5), "qamari"),
  dateRangeBetween(at(2026, 7, 30), at(2026, 8, 5)),
);
assert.deepEqual(
  datePresetRange("last30", at(2026, 8, 5), "jalali"),
  dateRangeBetween(at(2026, 7, 7), at(2026, 8, 5)),
);
const oldTZ = process.env.TZ;
try {
  process.env.TZ = "America/New_York";
  const spring = dateRangeBetween(at(2026, 3, 8), at(2026, 3, 8));
  const autumn = dateRangeBetween(at(2026, 11, 1), at(2026, 11, 1));
  assert.equal(spring.end - spring.start, 23 * 3600000, "DST-short day is still one business date");
  assert.equal(autumn.end - autumn.start, 25 * 3600000, "DST-long day includes its final hour");
  assert.equal(localDayStart(spring.end), spring.end);
  const customSpring = customDateRange(at(2026, 3, 8), at(2026, 3, 8), 0, 1439)!;
  const customAutumn = customDateRange(at(2026, 11, 1), at(2026, 11, 1), 0, 1439)!;
  assert.deepEqual(
    { start: customSpring.start, end: customSpring.end },
    spring,
    "00:00–23:59 covers the 23-hour daylight-saving day",
  );
  assert.deepEqual(
    { start: customAutumn.start, end: customAutumn.end },
    autumn,
    "00:00–23:59 covers both occurrences of the repeated autumn hour",
  );
  assert.equal(
    localMinute(at(2026, 3, 8), 150),
    null,
    "nonexistent 02:30 is not silently moved to 03:30",
  );
  assert.equal(customDateRange(at(2026, 3, 8), at(2026, 3, 8), 150, 1439), null);
  const repeatedMinute = customDateRange(at(2026, 11, 1), at(2026, 11, 1), 119, 119)!;
  assert.equal(
    repeatedMinute.end - repeatedMinute.start,
    60_000,
    "inclusive final minute uses elapsed time across the repeated hour, not a local-clock jump",
  );
  assert.deepEqual(dateRangeDraft(customAutumn), {
    first: autumn.start,
    last: autumn.start,
    startMinute: 0,
    endMinute: 1439,
  });
} finally {
  if (oldTZ === undefined) delete process.env.TZ;
  else process.env.TZ = oldTZ;
}
assert.equal(filterTallies(tallies, noteSearchTerms("rice 500"), gregorian)[0], tallies[0]);
assert.deepEqual(tallies, baseline, "search never rewrites stored notes, amounts, dates or status");
assert.equal(
  tallies.filter((e) => Number.isFinite(e.amount_afn)).reduce((sum, e) => sum + e.amount_afn, 0),
  6830,
  "search does not change the full ledger total",
);
console.log(
  "PASS: notes/exact localized amounts; local date/minute ranges, inclusive boundaries/reopen, all three calendar months/leaps/fallbacks, DST gaps/repeated minutes and unchanged ledger data/order",
);
