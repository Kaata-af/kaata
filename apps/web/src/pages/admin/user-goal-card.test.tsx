import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Stats } from "./api";
import { UserGoalCard } from "./UserGoalCard";

function render(total?: number, generatedAt = "2026-12-17T19:30:00Z") {
  return renderToStaticMarkup(
    <UserGoalCard stats={{ users_total: total, generated_at: generatedAt } as Stats} />,
  );
}

test("year-end vision states the goal, required pace, next step, and audited user definition", () => {
  const html = render(50_000);
  assert.match(html, /Our 2026 goal · by December 31/);
  assert.match(html, /100,000 total users/);
  assert.match(html, /41.43%/);
  assert.match(html, /70,711 total users/);
  assert.match(html, /\+20,711 net new users/);
  assert.match(html, /Next milestone: 75,000 users/);
  assert.match(html, /Signed-in accounts \+ Ninja users/);
  assert.match(html, /operator and test records excluded/);
  assert.match(html, /not our measured activity growth/);
  assert.match(html, /December 31, 2026 in Kabul/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="50000"/);
  assert.match(html, /aria-valuemax="100000"/);
  assert.match(html, /Dec 18, 2026, 00:00 Kabul/);
  assert.doesNotMatch(html, /7% target|on track|behind|Paul Graham/);
});

test("a backend without the user aggregate cannot show a fabricated zero or rate", () => {
  const html = render();
  assert.match(html, /Total-user progress is unavailable/);
  assert.match(html, /Missing data is never treated as zero/);
  assert.doesNotMatch(html, /role="progressbar"|0 users so far|NaN|Infinity/);
});

test("zero users and final-day overflow retain an actionable absolute requirement", () => {
  const zero = render(0);
  assert.match(zero, /A growth percentage needs a starting user/);
  assert.match(zero, /50,000 total users/);
  const lastMoment = render(500, "2026-12-31T23:59:59.999+04:30");
  assert.match(lastMoment, /Less than a day/);
  assert.match(lastMoment, /Needed by December 31/);
  assert.match(lastMoment, /Too little time remains/);
  assert.doesNotMatch(lastMoment, /NaN|Infinity/);
});

test("reaching after year-end does not claim the deadline was met", () => {
  const reached = render(125_000, "2027-01-02T00:00:00Z");
  assert.match(reached, /Current total meets target/);
  assert.match(reached, /not a verified year-end result/);
  assert.match(reached, /125,000/);
  assert.match(reached, /aria-valuenow="100000"/);
  assert.doesNotMatch(reached, /achieved by|met the deadline|Next milestone/);
  const closed = render(50_000, "2027-01-02T00:00:00Z");
  assert.match(closed, /2026 goal closed/);
  assert.match(closed, /not a year-end result/);
  assert.doesNotMatch(closed, /Required weekly growth from here|Needed in the next 7 days/);
});
