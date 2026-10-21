import assert from "node:assert/strict";
import { test } from "node:test";
import type { DayComparisonResult } from "./api";
import { comparisonModel } from "./day-comparison-model.ts";

type Day = DayComparisonResult["day"];

function day(overrides: Partial<Day> = {}): Day {
  return {
    date: "2026-10-21",
    completed_hours: 24,
    activity_available: true,
    points: Array.from({ length: 25 }, (_, hour) => ({
      hour,
      active: hour * 3,
      installs: hour * 2,
    })),
    ...overrides,
  };
}

function result(current: Partial<Day> = {}, comparison: Partial<Day> = {}): DayComparisonResult {
  return {
    day: day(current),
    compare_day: day({ date: "2026-10-20", ...comparison }),
    generated_at: "2026-10-21T12:00:00Z",
    tracking_since: "2026-10-14T00:00:00Z",
    min_date: "2026-09-01",
    max_date: "2026-10-21",
  };
}

test("unavailable activity remains unknown while tracked zero is a real zero", () => {
  const input = result(
    { activity_available: false },
    { points: [{ hour: 24, active: 0, installs: 0 }] },
  );
  const model = comparisonModel(input, "active", null);
  assert.equal(model.activityAvailable, false);
  assert.ok(model.points.every((point) => point.day === null));
  assert.equal(model.compareValue, 0);
  assert.equal(model.dayValue, null);
  assert.equal(model.difference, null);
  assert.equal(model.percentChange, null);

  const installs = comparisonModel(input, "installs", null);
  assert.equal(installs.dayValue, 48);
  assert.equal(installs.compareValue, 0);
  assert.equal(installs.activityAvailable, false);
});

test("the latest selection clips both curves at the lesser completed hour", () => {
  const model = comparisonModel(
    result({ completed_hours: 8 }, { completed_hours: 12 }),
    "active",
    null,
  );
  assert.equal(model.cutoff, 8);
  assert.equal(model.maxCutoff, 8);
  assert.equal(model.points[8].day, 24);
  assert.equal(model.points[8].compareDay, 24);
  assert.ok(
    model.points.slice(9).every((point) => point.day === null && point.compareDay === null),
  );
  assert.equal(model.dayValue, 24);
  assert.equal(model.compareValue, 24);
});

test("a lower selected hour uses cumulative server values without adding earlier hours", () => {
  const model = comparisonModel(
    result({ completed_hours: 18 }, { completed_hours: 14 }),
    "installs",
    5,
  );
  assert.equal(model.cutoff, 5);
  assert.equal(model.maxCutoff, 14);
  assert.equal(model.dayValue, 10);
  assert.equal(model.compareValue, 10);
  assert.equal(model.points[4].day, 8);
  assert.equal(model.points[5].day, 10);
  assert.equal(model.points[6].day, null);
  assert.equal(model.points[6].compareDay, null);
});

test("requesting a future hour cannot leak values from either day", () => {
  const model = comparisonModel(result({ completed_hours: 3 }), "installs", 24);
  assert.equal(model.cutoff, 3);
  assert.equal(model.dayValue, 6);
  assert.equal(model.compareValue, 6);
  assert.ok(
    model.points.slice(4).every((point) => point.day === null && point.compareDay === null),
  );
});

test("completed past days include their 24:00 totals and always produce 25 points", () => {
  const model = comparisonModel(result(), "active", null);
  assert.equal(model.cutoff, 24);
  assert.equal(model.maxCutoff, 24);
  assert.equal(model.points.length, 25);
  assert.deepEqual(model.points[0], { hour: 0, label: "00:00", day: 0, compareDay: 0 });
  assert.deepEqual(model.points[24], { hour: 24, label: "24:00", day: 72, compareDay: 72 });
  assert.equal(model.activityAvailable, true);
  assert.equal(model.dayValue, 72);
});

test("before 01:00 no uncompleted hour is shown or invented", () => {
  const model = comparisonModel(result({ completed_hours: 0 }), "active", null);
  assert.equal(model.maxCutoff, 0);
  assert.equal(model.cutoff, 0);
  assert.equal(model.dayValue, 0);
  assert.equal(model.compareValue, 0);
  assert.equal(model.difference, 0);
  assert.equal(model.percentChange, null);
  assert.ok(
    model.points.slice(1).every((point) => point.day === null && point.compareDay === null),
  );
});

test("missing points stay unknown and do not borrow an earlier cumulative total", () => {
  const model = comparisonModel(
    result({ points: [{ hour: 2, active: 7, installs: 2 }] }),
    "active",
    3,
  );
  assert.equal(model.points[1].day, null);
  assert.equal(model.points[2].day, 7);
  assert.equal(model.points[3].day, null);
  assert.equal(model.dayValue, null);
  assert.equal(model.compareValue, 9);
  assert.equal(model.difference, null);
  assert.equal(model.percentChange, null);
});

test("unknown comparison totals do not produce a difference or percentage", () => {
  const model = comparisonModel(
    result({}, { points: [{ hour: 24, active: null, installs: null }] }),
    "installs",
    null,
  );
  assert.equal(model.dayValue, 48);
  assert.equal(model.compareValue, null);
  assert.equal(model.difference, null);
  assert.equal(model.percentChange, null);
});

test("percentage change uses the comparison total as its baseline", () => {
  for (const [current, previous, difference, percentage] of [
    [15, 10, 5, 50],
    [6, 10, -4, -40],
    [10, 10, 0, 0],
    [0, 10, -10, -100],
  ]) {
    const model = comparisonModel(
      result(
        { points: [{ hour: 24, active: current, installs: current }] },
        { points: [{ hour: 24, active: previous, installs: previous }] },
      ),
      "active",
      null,
    );
    assert.equal(model.difference, difference);
    assert.equal(model.percentChange, percentage);
  }
});

test("a zero baseline never invents a percentage, including zero against zero", () => {
  for (const current of [0, 10]) {
    const model = comparisonModel(
      result(
        { points: [{ hour: 24, active: current, installs: current }] },
        { points: [{ hour: 24, active: 0, installs: 0 }] },
      ),
      "active",
      null,
    );
    assert.equal(model.difference, current);
    assert.equal(model.percentChange, null);
  }
});

test("completed and requested hours are clamped to integer boundaries", () => {
  assert.equal(comparisonModel(result({ completed_hours: 30 }), "active", null).maxCutoff, 24);
  assert.equal(comparisonModel(result({ completed_hours: 5.9 }), "active", null).maxCutoff, 5);
  assert.equal(comparisonModel(result({ completed_hours: -1 }), "active", null).maxCutoff, 0);
  assert.equal(comparisonModel(result(), "active", 8.9).cutoff, 8);
  assert.equal(comparisonModel(result(), "active", -5).cutoff, 0);
  assert.equal(comparisonModel(result(), "active", Number.NaN).cutoff, 0);
});
