import assert from "node:assert/strict";
import { test } from "node:test";
import type { DayComparisonDay, DayComparisonResult } from "./api";
import {
  advancedComparisonModel,
  comparisonCsv,
  customDateError,
  parseComparisonPreferences,
  supportsAdvancedComparison,
  validComparisonDate,
  type ComparisonPreferences,
} from "./day-comparison-model.ts";

function day(date: string, index = 0): DayComparisonDay {
  return {
    date,
    completed_hours: date === "2026-10-21" ? 14 : 24,
    activity_available: true,
    points: Array.from({ length: 25 }, (_, hour) => ({
      hour,
      active: hour * (index + 2),
      installs: hour * (index + 1),
      hourly_active: hour ? 10 + index : null,
      hourly_installs: hour ? index + 1 : null,
    })),
  };
}
function data(count = 7): DayComparisonResult {
  const days = Array.from({ length: count }, (_, index) => day(`2026-10-${21 - index}`, index));
  return {
    days,
    day: days[0],
    compare_day: days[1],
    generated_at: "2026-10-21T10:07:00Z",
    tracking_since: "2026-10-14T00:00:00Z",
    min_date: "2026-07-24",
    max_date: "2026-10-21",
  };
}
function prefs(patch: Partial<ComparisonPreferences> = {}): ComparisonPreferences {
  return { ...parseComparisonPreferences(null), ...patch };
}

test("the shared cutoff includes all seven selected dates, including hidden days", () => {
  const input = data();
  const model = advancedComparisonModel(input, prefs({ hiddenDates: [input.day.date] }));
  assert.equal(model.cutoff, 14);
  assert.equal(model.totals.length, 7);
  assert.equal(model.totals[0].value, 28);
  assert.equal(model.visibleDates.length, 6);
  assert.ok(
    model.points
      .slice(15)
      .every((point) => Object.values(point.values).every((value) => value === null)),
  );
});
test("earlier cutoffs read cumulative prefixes without summing or differencing", () => {
  const input = data();
  const cumulative = advancedComparisonModel(input, prefs({ requestedHour: 4 }));
  const hourly = advancedComparisonModel(input, prefs({ requestedHour: 4, mode: "hourly" }));
  assert.equal(cumulative.points[4].values[input.day.date], 8);
  assert.equal(hourly.points[4].values[input.day.date], 10);
  assert.equal(hourly.totals[0].value, 8);
  assert.equal(hourly.points[0].values[input.day.date], null);
});
test("a partly tracked day can have known individual hours and unknown cumulative activity", () => {
  const input = data();
  input.days![2].activity_available = false;
  input.days![2].points[5].hourly_active = null;
  const cumulative = advancedComparisonModel(input, prefs());
  const hourly = advancedComparisonModel(input, prefs({ mode: "hourly" }));
  assert.equal(cumulative.totals[2].value, null);
  assert.equal(cumulative.points[6].values[input.days![2].date], null);
  assert.equal(hourly.points[6].values[input.days![2].date], 12);
  assert.equal(hourly.points[5].values[input.days![2].date], null);
  assert.equal(hourly.average, null);
  assert.deepEqual(hourly.bestDates, []);
  assert.equal(advancedComparisonModel(input, prefs({ metric: "installs" })).totals[2].value, 42);
});
test("missing and invalid server values stay unknown instead of becoming zero", () => {
  const input = data();
  input.day.points = input.day.points.filter((point) => point.hour !== 14);
  input.days![1].points[14].active = -1;
  const model = advancedComparisonModel(input, prefs());
  assert.equal(model.totals[0].value, null);
  assert.equal(model.totals[1].value, null);
  assert.equal(model.totals[2].difference, null);
  assert.equal(model.average, null);
});
test("baseline is selectable and stays the baseline even when its line is hidden", () => {
  const input = data();
  const baseline = input.days![6].date;
  const model = advancedComparisonModel(
    input,
    prefs({ baselineDate: baseline, hiddenDates: [baseline] }),
  );
  assert.equal(model.baselineDate, baseline);
  assert.equal(model.totals[0].difference, 28 - 112);
  assert.equal(model.totals[6].difference, 0);
  assert.ok(!model.visibleDates.includes(baseline));
  assert.equal(
    advancedComparisonModel(input, prefs({ baselineDate: "2026-01-01" })).baselineDate,
    input.compare_day.date,
  );
});
test("zero baseline keeps absolute changes and never invents a percentage", () => {
  const input = data();
  input.compare_day.points[14].active = 0;
  const model = advancedComparisonModel(input, prefs());
  assert.equal(model.totals[0].difference, 28);
  assert.equal(model.totals[0].percentChange, null);
  assert.equal(model.totals[1].difference, 0);
  assert.equal(model.totals[1].percentChange, null);
});
test("before 01:00 all summary totals wait, and past pairs permit the full 24 hours", () => {
  const input = data(2);
  input.day.completed_hours = 0;
  assert.ok(
    advancedComparisonModel(input, prefs({ requestedHour: 18 })).totals.every(
      (row) => row.value === null,
    ),
  );
  input.day.completed_hours = 24;
  const complete = advancedComparisonModel(input, prefs());
  assert.equal(complete.cutoff, 24);
  assert.equal(complete.points.length, 25);
  assert.equal(complete.totals[0].value, 48);
});
test("one visible line is retained when remembered visibility would hide every date", () => {
  const input = data();
  const model = advancedComparisonModel(
    input,
    prefs({ hiddenDates: input.days!.map((day) => day.date) }),
  );
  assert.deepEqual(model.visibleDates, [input.day.date]);
  assert.equal(model.cutoff, 14);
});
test("averages and all tied best days require complete cumulative values", () => {
  const input = data(2);
  input.compare_day.points[14].active = 28;
  const model = advancedComparisonModel(input, prefs());
  assert.equal(model.average, 28);
  assert.deepEqual(model.bestDates, [input.day.date, input.compare_day.date]);
});
test("custom dates reject duplicates, impossible calendars, out-of-range and oversized selections", () => {
  assert.ok(validComparisonDate("2024-02-29"));
  assert.ok(!validComparisonDate("2026-02-29"));
  assert.ok(customDateError(["2026-10-21", "2026-10-21"], "2026-07-24", "2026-10-21"));
  assert.ok(customDateError(["2026-10-22", "2026-10-20"], "2026-07-24", "2026-10-21"));
  assert.ok(customDateError(["2026-10-21"], "2026-07-24", "2026-10-21"));
  assert.equal(customDateError(["2026-10-20", "2026-10-21"], "2026-07-24", "2026-10-21"), "");
});
test("preferences whitelist harmless controls and preserve relative preset keys", () => {
  const restored = parseComparisonPreferences({
    preset: "last7",
    customDates: [],
    metric: "installs",
    mode: "hourly",
    requestedHour: 8,
    baselineDate: "2026-10-20",
    hiddenDates: ["2026-10-19"],
    token: "secret",
    arbitrary: true,
  });
  assert.equal(restored.preset, "last7");
  assert.equal(restored.requestedHour, 8);
  assert.equal(restored.mode, "hourly");
  assert.ok(!("token" in restored));
  assert.ok(!("arbitrary" in restored));
  assert.equal(
    parseComparisonPreferences({
      preset: "custom",
      customDates: ["2026-02-30", "2026-10-20"],
      requestedHour: 99,
    }).preset,
    "today-yesterday",
  );
  assert.equal(parseComparisonPreferences({ requestedHour: 0 }).requestedHour, null);
});
test("old pair-only or incomplete contracts require a server update", () => {
  const input = data();
  assert.ok(supportsAdvancedComparison(input));
  assert.ok(!supportsAdvancedComparison({ ...input, days: undefined }));
  delete input.days![0].points[0].hourly_active;
  assert.ok(!supportsAdvancedComparison(input));
});
test("CSV includes all selected days, blanks for unknowns, shared cutoff and reporting metadata", () => {
  const input = data(3);
  input.days![2].activity_available = false;
  const preferences = prefs({ hiddenDates: [input.days![2].date], requestedHour: 2 });
  const csv = comparisonCsv(input, advancedComparisonModel(input, preferences), preferences);
  assert.ok(csv.startsWith("\uFEFFtimezone,Asia/Kabul\r\n"));
  assert.match(csv, /generated_at,2026-10-21T10:07:00Z/);
  assert.match(csv, /cutoff_kabul,02:00/);
  assert.match(csv, /chart_mode,cumulative/);
  assert.match(csv, /tracking_since,/);
  assert.match(csv, /hour_kabul,2026-10-21,2026-10-20,2026-10-19/);
  assert.match(csv, /02:00,4,6,\r\n/);
  assert.doesNotMatch(csv, /03:00,/);
});
test("hourly CSV uses server bucket values and omits the non-hour midnight point", () => {
  const input = data(2);
  const preferences = prefs({ mode: "hourly", requestedHour: 2 });
  const csv = comparisonCsv(input, advancedComparisonModel(input, preferences), preferences);
  assert.match(csv, /chart_mode,hourly/);
  assert.match(csv, /01:00,10,11/);
  assert.doesNotMatch(csv, /\r\n00:00,/);
});
