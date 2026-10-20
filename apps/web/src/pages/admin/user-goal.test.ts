import assert from "node:assert/strict";
import { test } from "node:test";
import { goalProgressLabel, requiredRateLabel, userGoal, USER_GOAL_DEADLINE } from "./user-goal.ts";

const deadline = Date.parse(USER_GOAL_DEADLINE);
const day = 86_400_000;
const before = (days: number) => new Date(deadline - days * day).toISOString();

test("required weekly growth compounds across exact fractional weeks", () => {
  for (const [days, expected] of [
    [14, (Math.sqrt(2) - 1) * 100],
    [7, 100],
    [3.5, 300],
  ]) {
    const goal = userGoal(50_000, before(days));
    assert.equal(goal.status, "open");
    if (goal.status !== "open") throw new Error("Expected open goal");
    assert.ok(Math.abs(goal.weeklyRate! - expected) < 1e-9);
    const projected = goal.total * (1 + goal.weeklyRate! / 100) ** (days / 7);
    assert.ok(Math.abs(projected - 100_000) < 1e-7);
    assert.equal(goal.dailyAdditions, Math.ceil(50_000 / days));
  }
});

test("Kabul year-end includes all of December 31 and does not roll into next year", () => {
  assert.equal(new Date(deadline).toISOString(), "2026-12-31T19:30:00.000Z");
  assert.equal(userGoal(500, "2026-12-31T23:59:59.999+04:30").status, "open");
  assert.equal(userGoal(500, "2027-01-01T00:00:00+04:30").status, "closed");
  assert.equal(userGoal(500, "2027-10-20T00:00:00Z").status, "closed");
  assert.deepEqual(userGoal(500, "2026-10-20T12:00:00+04:30"), {
    ...userGoal(500, "2026-10-20T07:30:00Z"),
    asOf: "2026-10-20T12:00:00+04:30",
  });
});

test("missing or malformed snapshots never become zero users or an invented pace", () => {
  for (const count of [
    undefined,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    10.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.deepEqual(userGoal(count, before(14)), { status: "unavailable" });
  }
  for (const time of [
    "",
    "yesterday",
    "2026-10-20",
    "2026-10-20T10:00:00",
    "2026-02-30T10:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-10-20T24:00:00Z",
    "2026-10-20T00:00:00+24:00",
  ]) {
    assert.deepEqual(userGoal(500, time), { status: "unavailable" }, time);
  }
  assert.equal(userGoal(500, "2026-10-20T10:00:00.123456789Z").status, "open");
});

test("zero users has no compound percentage but retains actionable net additions", () => {
  const goal = userGoal(0, before(14));
  assert.equal(goal.status, "open");
  if (goal.status !== "open") throw new Error("Expected open goal");
  assert.equal(goal.weeklyRate, null);
  assert.equal(goal.dailyAdditions, 7143);
  assert.equal(goal.nextPeriodTotal, 50_000);
  assert.equal(goal.progress, 0);
  assert.equal(goal.nextMilestone, 1000);
});

test("next-seven-day target uses the same compound path and caps at the deadline", () => {
  const goal = userGoal(25_000, before(14));
  assert.equal(goal.status, "open");
  if (goal.status !== "open") throw new Error("Expected open goal");
  assert.equal(goal.nextPeriodTotal, 50_000);
  assert.equal(goal.nextPeriodIsDeadline, false);
  assert.equal(goal.nextMilestone, 50_000);
  for (const days of [7, 1, 0.5, 1 / day]) {
    const late = userGoal(500, before(days));
    assert.equal(late.status, "open");
    if (late.status !== "open") throw new Error("Expected open goal");
    assert.equal(late.nextPeriodTotal, 100_000);
    assert.equal(late.nextPeriodIsDeadline, true);
    assert.ok(late.weeklyRate === null || Number.isFinite(late.weeklyRate));
  }
});

test("reached and closed states preserve the actual count without claiming a historical result", () => {
  for (const count of [100_000, 125_000]) {
    for (const time of [before(14), "2027-01-02T00:00:00Z"]) {
      const goal = userGoal(count, time);
      assert.equal(goal.status, "reached");
      assert.equal(goal.total, count);
      assert.equal(goal.remaining, 0);
      assert.equal(goal.progress, 100);
      assert.equal(goal.nextMilestone, null);
    }
  }
  const closed = userGoal(99_999, USER_GOAL_DEADLINE);
  assert.equal(closed.status, "closed");
  assert.equal(closed.remaining, 1);
  assert.equal(closed.daysRemaining, 0);
});

test("snapshot time, rather than the browser clock, anchors the requirement", () => {
  const snapshot = before(14);
  const first = userGoal(50_000, snapshot);
  const original = Date.now;
  try {
    Date.now = () => deadline + 365 * day;
    assert.deepEqual(userGoal(50_000, snapshot), first);
  } finally {
    Date.now = original;
  }
});

test("display rounding never understates required pace or rounds unfinished progress to 100", () => {
  assert.equal(requiredRateLabel(7.001), "7.01%");
  assert.equal(requiredRateLabel(7), "7.00%");
  assert.equal(goalProgressLabel(99.999), "99.99%");
  assert.equal(goalProgressLabel(0.001), "<0.01%");
  assert.equal(goalProgressLabel(100), "100%");
});
