// From apps/web: bun test ./src/pages/admin/day-comparison.test.tsx
import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityInsights } from "./ActivityInsights";
import { AdminTokenContext, type DayComparisonResult } from "./api";
import { DayComparisonPanel } from "./DayComparison";
import { parseComparisonPreferences, type ComparisonPreferences } from "./day-comparison-model";

function data(): DayComparisonResult {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-${21 - index}`,
    completed_hours: index === 0 ? 14 : 24,
    activity_available: true,
    points: Array.from({ length: 25 }, (_, hour) => ({
      hour,
      active: hour * (index + 2),
      installs: hour * (index + 1),
      hourly_active: hour ? 10 + index : null,
      hourly_installs: hour ? index + 1 : null,
    })),
  }));
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
function render(input = data(), patch: Partial<ComparisonPreferences> = {}) {
  return renderToStaticMarkup(
    <DayComparisonPanel
      data={input}
      preferences={{ ...parseComparisonPreferences(null), ...patch }}
    />,
  );
}

test("seven date totals share the last completed hour and default second-day baseline", () => {
  const html = render();
  assert.match(html, /Through 14:00 Kabul · last completed hour/);
  assert.match(html, /Cumulative totals through 14:00 Kabul/);
  assert.match(html, /Oct 21, 2026: 28 active installs/);
  assert.match(html, /−14 \(−33\.3%\) vs Oct 20, 2026/);
  assert.match(html, /Average across 7 days: 70/);
  assert.match(html, /All 7 selected days set the shared cutoff/);
});
test("per-hour mode keeps summary totals explicitly cumulative and reports bucket semantics", () => {
  const html = render(data(), { mode: "hourly" });
  assert.match(html, /aria-pressed="true"[^>]*>Per hour<\/button>/);
  assert.match(html, /Cumulative totals through 14:00 Kabul/);
  assert.match(html, /Table totals stay cumulative in both chart modes/);
  assert.match(html, /14:00 means 13:00–14:00 Kabul/);
  assert.match(html, /cannot be added into distinct daily activity/);
});
test("unknown totals suppress averages and best-day claims without hiding known individual hours", () => {
  const input = data();
  input.days![0].activity_available = false;
  const html = render(input, { mode: "hourly" });
  assert.match(html, /Cumulative totals are unknown for Oct 21, 2026/);
  assert.match(html, /Average and highest day require known cumulative totals/);
  assert.doesNotMatch(html, /Average across/);
});
test("hidden baseline stays marked and the last visible series cannot be removed", () => {
  const input = data();
  const html = render(input, { hiddenDates: input.days!.slice(1).map((day) => day.date) });
  assert.match(html, /Baseline · line hidden/);
  assert.match(html, /aria-label="Show Oct 21, 2026 on chart" disabled="" checked=""/);
});
test("custom editor has bounded dates and stops at seven fields", () => {
  const input = data();
  const html = render(input, { preset: "custom", customDates: input.days!.map((day) => day.date) });
  assert.equal((html.match(/type="date"/g) ?? []).length, 7);
  assert.match(html, /min="2026-07-24" max="2026-10-21"/);
  assert.match(html, />Apply dates<\/button>/);
  assert.match(html, /disabled="">\+ Add date<\/button>/);
});
test("before 01:00 a remembered cutoff has a readable disabled selector and no invented totals", () => {
  const input = data();
  input.day.completed_hours = 0;
  const html = render(input, { requestedHour: 8 });
  assert.match(html, /No completed hour to compare yet/);
  assert.match(html, /value="latest" selected="">No completed hour yet/);
  assert.match(html, /first comparison is available after 01:00 Kabul/);
  assert.doesNotMatch(html, /Average across/);
});
test("old pair-only data never masquerades as a seven-day comparison", () => {
  const input = data();
  delete input.days;
  const html = render(input, { preset: "last7" });
  assert.match(html, /Advanced day comparison requires the server update/);
  assert.doesNotMatch(html, /Cumulative totals/);
});
test("ordinary daily mode does not mount the comparison query", () => {
  const html = renderToStaticMarkup(
    <ActivityInsights
      stats={undefined}
      view="day"
      range={30}
      pending
      error={false}
      fetching
      onView={() => {}}
      onRange={() => {}}
      onRetry={() => {}}
      dailyChart={null}
    />,
  );
  assert.match(html, /aria-pressed="true"[^>]*>Daily<\/button>/);
  assert.match(html, />Compare days<\/button>/);
});
test("an unavailable endpoint has retry and a safe preset reset independently of stats", () => {
  const client = new QueryClient();
  client.setQueryData(["admin", "day-comparison", "synthetic", "today-yesterday", ""], null);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdminTokenContext.Provider value="synthetic">
        <ActivityInsights
          stats={undefined}
          view="compare"
          range={30}
          pending
          error
          fetching
          onView={() => {}}
          onRange={() => {}}
          onRetry={() => {}}
          dailyChart={null}
        />
      </AdminTokenContext.Provider>
    </QueryClientProvider>,
  );
  assert.match(html, /Advanced day comparison requires the server update/);
  assert.match(html, />Retry<\/button>/);
  assert.match(html, /Reset to today and yesterday/);
});
