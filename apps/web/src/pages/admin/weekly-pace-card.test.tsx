import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Growth, GrowthWeek, Stats } from "./api";
import { WeeklyGrowthCard } from "./WeeklyGrowthCard";

const snapshot = "2026-10-20T07:49:00Z";

function stats(total: number | undefined = 1690, asOf = snapshot): Stats {
  return { users_total: total, generated_at: asOf } as Stats;
}

function growth(current: Partial<GrowthWeek> = {}, weekStartsOn = 6): Growth {
  const completed: GrowthWeek = {
    week: "2026-10-10",
    new: 107,
    retained: 400,
    resurrected: 0,
    churned: 0,
    active: 507,
    previous_active: 400,
    change: 107,
    complete: true,
    tracking_complete: true,
    previous_tracking_complete: true,
    calendar_comparable: true,
    growth_rate_percent: 26.75,
    target_active: 428,
    target_met: true,
    recorded_at: "2026-10-17T00:00:00Z",
  };
  return {
    weekly_cohorts: [],
    growth_accounting: [
      completed,
      {
        ...completed,
        week: "2026-10-17",
        active: 595,
        previous_active: 507,
        change: 88,
        complete: false,
        growth_rate_percent: null,
        target_active: 543,
        target_met: false,
        recorded_at: "",
        ...current,
      },
    ],
    adoption: null,
    generated_at: snapshot,
    activity_tracking_since: "2026-09-01T00:00:00Z",
    activity_timezone_since: "2026-09-01",
    week_starts_on: weekStartsOn,
  };
}

function render(data: Growth, userStats?: Stats): string {
  return renderToStaticMarkup(<WeeklyGrowthCard growth={data} stats={userStats} />);
}

test("current activity uses the total-user pace without rewriting recorded history or legacy targets", () => {
  const data = growth();
  const before = JSON.stringify(data);
  const html = render(data, stats());
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="595"/);
  assert.match(html, /aria-valuemax="752"/);
  assert.match(html, /157/);
  assert.match(html, /active devices so far/);
  assert.match(html, /activity benchmark/);
  assert.match(html, /total users separately/);
  assert.match(html, /Friday/);
  assert.match(html, /\+26\.75%/);
  assert.match(html, /400 → 507 active devices/);
  assert.match(html, /Recorded Oct 17, 2026, 04:30/);
  assert.doesNotMatch(html, /7% target|aria-valuemax="543"|on track|met the year-end goal/i);
  assert.equal(JSON.stringify(data), before);
});

test("zero and exceeded activity counts preserve measured counts and bounded progress", () => {
  const zero = render(growth({ active: 0 }), stats());
  assert.match(zero, /aria-valuenow="0"/);
  assert.match(zero, /aria-valuemax="752"/);
  const exceeded = render(growth({ active: 800 }), stats());
  assert.match(exceeded, /aria-valuenow="752"/);
  assert.match(exceeded, /aria-valuemax="752"/);
  assert.match(exceeded, />800 <span/);
  assert.match(exceeded, /in progress/);
  assert.match(exceeded, /Activity pace count reached so far/);
  assert.doesNotMatch(exceeded, /on track|met the year-end goal|NaN|Infinity/i);
});

test("missing goal data and incomparable activity never fall back to the old fixed target", () => {
  const missingCount = { generated_at: snapshot } as Stats;
  for (const userStats of [
    undefined,
    missingCount,
    stats(0),
    stats(100_000),
    stats(1690, "2027-01-01T00:00:00+04:30"),
  ]) {
    const html = render(growth(), userStats);
    assert.doesNotMatch(html, /role="progressbar"|7% target|NaN|Infinity/i);
    assert.match(html, />595 <span/);
  }
  for (const row of [
    { tracking_complete: false },
    { previous_tracking_complete: false },
    { calendar_comparable: false },
    { previous_active: 0 },
    { previous_active: Number.NaN },
    { previous_active: Number.MAX_SAFE_INTEGER },
    { active: -1 },
  ]) {
    assert.doesNotMatch(render(growth(row), stats()), /role="progressbar"/);
  }
});

test("a pace snapshot must belong to the displayed Kabul reporting week", () => {
  for (const asOf of ["2026-10-16T23:59:59.999+04:30", "2026-10-24T00:00:00+04:30"]) {
    assert.doesNotMatch(render(growth(), stats(1690, asOf)), /role="progressbar"/);
  }
  assert.match(render(growth(), stats(1690, "2026-10-17T00:00:00+04:30")), /role="progressbar"/);
  const monday = render(growth({ week: "2026-10-19" }, 1), stats());
  assert.match(monday, /aria-valuemax="752"/);
  assert.match(monday, /Sunday/);
});

test("the last reporting week uses the December 31 cutoff rather than a target in 2027", () => {
  const html = render(growth({ week: "2026-12-26" }), stats(50_000, "2026-12-28T00:00:00+04:30"));
  assert.match(html, /aria-valuemax="1435"/);
  assert.match(html, /Thursday, Dec 31/);
  assert.match(html, /target ends at the year-end deadline/);
  assert.doesNotMatch(html, /NaN|Infinity|by January 1|by Jan 1/i);
  const lastMoment = render(
    growth({ week: "2026-12-26" }),
    stats(1, "2026-12-31T23:59:59.999+04:30"),
  );
  assert.doesNotMatch(lastMoment, /role="progressbar"|NaN|Infinity/);
});
