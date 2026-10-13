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
} from "./weekly-growth.ts";

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

test("missing coverage from an older backend cannot produce a percentage or verdict", () => {
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

test("rounding the displayed rate cannot overturn the server's exact whole-device verdict", () => {
  const below = week({
    active: 21_399,
    previous_active: 20_000,
    target_active: 21_400,
    growth_rate_percent: 6.995,
    target_met: false,
  });
  assert.equal(comparableWeek(below), true);
  assert.equal(weeklyRateLabel(below), "<7.00%");
  assert.equal(below.target_met, false);
  assert.equal(below.target_active! - below.active!, 1);
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
