import assert from "node:assert/strict";
import { test } from "node:test";
import type { Growth, GrowthWeek } from "./api";
import {
  comparableWeek,
  comparisonUnavailable,
  excludedDevicesNote,
  weeklyGrowthView,
  weeklyRateLabel,
  weeklyCalendarLabel,
  reportingWeekLabels,
  weeklyActivityPace,
} from "./weekly-growth.ts";
import { userGoal } from "./user-goal.ts";

test("week labels follow the backend calendar through rollout and rollback", () => {
  assert.deepEqual(reportingWeekLabels(6), {
    range: "Saturday–Friday",
    start: "Saturday",
    end: "Friday",
  });
  assert.equal(reportingWeekLabels(undefined).range, "Monday–Sunday");
  assert.equal(reportingWeekLabels(1).end, "Sunday");
  assert.equal(reportingWeekLabels(6).end, "Friday");
});

test("the excluded-device count is stated only when the backend reports it", () => {
  assert.equal(excludedDevicesNote(undefined), "");
  assert.equal(excludedDevicesNote(Number.NaN), "");
  assert.equal(excludedDevicesNote(0), "No devices are excluded as operator or test data.");
  assert.equal(excludedDevicesNote(1), "1 device is excluded as operator or test data.");
  assert.equal(excludedDevicesNote(1234), "1,234 devices are excluded as operator or test data.");
});

function week(overrides: Partial<GrowthWeek> = {}): GrowthWeek {
  return {
    week: "2026-09-19",
    new: 7,
    retained: 100,
    resurrected: 0,
    churned: 0,
    active: 107,
    previous_active: 100,
    change: 7,
    complete: true,
    tracking_complete: true,
    previous_tracking_complete: true,
    calendar_comparable: true,
    growth_rate_percent: 7,
    target_active: 107,
    target_met: true,
    ...overrides,
  };
}
function growth(rows: GrowthWeek[]): Growth {
  return {
    weekly_cohorts: [],
    growth_accounting: rows,
    adoption: null,
    generated_at: "2026-09-29T12:00:00Z",
  };
}

test("unfinished weeks cannot become the completed headline, even when the response arrives unsorted", () => {
  const latest = week();
  const current = week({
    week: "2026-09-26",
    complete: false,
    growth_rate_percent: null,
    target_met: null,
  });
  const earlier = week({ week: "2026-09-12" });
  const input = [current, earlier, latest];
  const view = weeklyGrowthView(growth(input));
  assert.equal(view.latest, latest);
  assert.equal(view.current, current);
  assert.deepEqual(input, [current, earlier, latest]);
  assert.equal(comparableWeek(current), false);
  assert.equal(weeklyRateLabel(current), "—");
});

test("missing coverage from an older backend cannot produce a percentage", () => {
  const legacy: GrowthWeek = {
    week: "2026-09-19",
    new: 7,
    retained: 100,
    resurrected: 0,
    churned: 0,
  };
  assert.equal(weeklyGrowthView(growth([legacy])).available, false);
  assert.equal(comparableWeek(legacy), false);
  assert.equal(weeklyRateLabel(legacy), "—");
  assert.equal(weeklyGrowthView(null).latest, null);
});

test("an untracked latest week stays visible instead of cherry-picking an older comparable week", () => {
  const untracked = week({
    week: "2026-09-26",
    tracking_complete: false,
    growth_rate_percent: null,
    target_met: null,
  });
  const view = weeklyGrowthView(growth([week(), untracked]));
  assert.equal(view.latest, untracked);
  assert.equal(comparableWeek(untracked), false);
  assert.match(comparisonUnavailable(untracked, "2026-09-25T00:00:00Z"), /fully tracked/);
  assert.match(comparisonUnavailable(untracked, ""), /unknown/);
});

test("zero baseline remains undefined while negative and zero growth retain their signs", () => {
  const zero = week({ previous_active: 0, growth_rate_percent: null, target_met: null });
  assert.equal(weeklyRateLabel(zero), "—");
  assert.match(comparisonUnavailable(zero, "2026-01-01T00:00:00Z"), /undefined/);
  assert.equal(weeklyRateLabel(week({ growth_rate_percent: 0, target_met: false })), "0.00%");
  assert.equal(weeklyRateLabel(week({ growth_rate_percent: -10, target_met: false })), "-10.00%");
  assert.equal(weeklyRateLabel(week()), "+7.00%");
});

test("actual weekly rates are independent of legacy target metadata", () => {
  const row = week({
    active: 21_399,
    previous_active: 20_000,
    target_active: 21_400,
    growth_rate_percent: 6.995,
    target_met: false,
  });
  for (const target_met of [true, false, null, undefined]) {
    const input = { ...row, target_met, target_active: undefined };
    assert.equal(comparableWeek(input), true);
    assert.equal(weeklyRateLabel(input), "+7.00%");
  }
  assert.equal(row.target_met, false);
  assert.equal(row.active, 21_399);
  assert.equal(row.growth_rate_percent, 6.995);
});

test("UTC history and the mixed-calendar cutover are labelled without claiming comparable growth", () => {
  assert.equal(weeklyCalendarLabel("2026-08-22", "2026-09-01"), "UTC");
  assert.equal(weeklyCalendarLabel("2026-08-29", "2026-09-01"), "Calendar transition");
  assert.equal(weeklyCalendarLabel("2026-09-05", "2026-09-01"), "Kabul");
  const transition = week({
    calendar_comparable: false,
    growth_rate_percent: null,
    target_met: null,
  });
  assert.equal(comparableWeek(transition), false);
  assert.match(comparisonUnavailable(transition, "2026-01-01T00:00:00Z"), /calendar changed/);
});

test("current activity progress uses the exact year-end pace in matching device units", () => {
  const current = week({ week: "2026-10-17", complete: false, active: 595, previous_active: 507 });
  const goal = userGoal(1690, "2026-10-20T07:49:00Z");
  const pace = weeklyActivityPace(current, goal);
  assert.ok(pace);
  assert.equal(pace.target, 752);
  assert.equal(pace.remaining, 157);
  assert.equal(pace.active, 595);
  assert.equal(pace.progress, (595 / 752) * 100);
  assert.equal(new Date(pace.endsAt).toISOString(), "2026-10-23T19:30:00.000Z");
  assert.equal(pace.shortened, false);
  if (goal.status !== "open") throw new Error("Expected an open goal");
  assert.equal(weeklyActivityPace(current, { ...goal, weeklyRate: 7.001 })?.target, 543);
  const precise = weeklyActivityPace(
    { ...current, previous_active: 10000 },
    { ...goal, weeklyRate: 7.001 },
  );
  assert.equal(precise?.target, 10701); // rounding the rate to 7% would understate this
});

test("final-week activity deadline and compound horizon stop at Kabul year-end", () => {
  const current = week({ week: "2026-12-26", complete: false, active: 140, previous_active: 100 });
  const goal = userGoal(50000, "2026-12-26T00:00:00+04:30");
  const pace = weeklyActivityPace(current, goal);
  assert.ok(pace);
  assert.equal(pace.shortened, true);
  assert.equal(pace.target, 200);
  assert.equal(pace.remaining, 60);
  assert.equal(new Date(pace.endsAt).toISOString(), "2026-12-31T19:30:00.000Z");
});

test("weekly activity targets require matching snapshots and valid comparable counts", () => {
  const current = week({ week: "2026-10-17", complete: false, active: 0, previous_active: 507 });
  const goal = userGoal(1690, "2026-10-20T07:49:00Z");
  assert.equal(weeklyActivityPace(current, goal)?.progress, 0);
  assert.equal(weeklyActivityPace({ ...current, active: 800 }, goal)?.progress, 100);
  for (const change of [
    { complete: true },
    { tracking_complete: false },
    { previous_tracking_complete: false },
    { calendar_comparable: false },
    { previous_active: 0 },
    { previous_active: Number.NaN },
    { active: -1 },
    { active: 1.5 },
    { active: Number.POSITIVE_INFINITY },
    { week: "2026-02-30" },
    { week: "2026-10-24" },
    { week: "2026-10-10" },
  ])
    assert.equal(weeklyActivityPace({ ...current, ...change }, goal), null);
  if (goal.status !== "open") throw new Error("Expected an open goal");
  for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(weeklyActivityPace(current, { ...goal, weeklyRate: rate }), null);
  }
  assert.equal(weeklyActivityPace(current, userGoal(0, goal.asOf)), null);
  assert.equal(weeklyActivityPace(current, userGoal(100000, goal.asOf)), null);
  assert.equal(weeklyActivityPace(current, userGoal(1690, "2027-01-01T00:00:00+04:30")), null);
});
