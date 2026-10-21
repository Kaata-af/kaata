// From apps/web: bun test ./src/pages/admin/day-comparison.test.tsx
// Bun renders the existing React components directly; no extra test dependency.
import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityInsights } from "./ActivityInsights";
import { AdminTokenContext, type DayComparisonResult } from "./api";
import { DayComparisonPanel } from "./DayComparison";

function data(overrides: Partial<DayComparisonResult> = {}): DayComparisonResult {
  return {
    day: {
      date: "2026-10-21",
      completed_hours: 14,
      activity_available: true,
      points: Array.from({ length: 25 }, (_, hour) => ({ hour, active: hour * 2, installs: hour })),
    },
    compare_day: {
      date: "2026-10-20",
      completed_hours: 24,
      activity_available: true,
      points: Array.from({ length: 25 }, (_, hour) => ({
        hour,
        active: hour * 3,
        installs: hour * 2,
      })),
    },
    generated_at: "2026-10-21T10:07:00Z", // 14:37 Kabul; comparison still ends at 14:00.
    tracking_since: "2026-10-14T00:00:00Z",
    min_date: "2026-07-24",
    max_date: "2026-10-21",
    ...overrides,
  };
}
function render(input = data()) {
  return renderToStaticMarkup(<DayComparisonPanel data={input} onDates={() => {}} />);
}

test("both totals and the difference use the same completed Kabul hour", () => {
  const html = render();
  assert.match(html, /Through 14:00 Kabul · last completed hour/);
  assert.match(html, />28<\/dd>/);
  assert.match(html, />42<\/dd>/);
  assert.match(html, /−14<\/dd>/);
  assert.match(html, /−33\.3% vs comparison day/);
  assert.doesNotMatch(html, />72<\/dd>|14:37|24:00 · complete day/);
  assert.match(html, /minute-by-minute comparison is unavailable/);
});

test("date controls and displayed dates use the response instead of the browser date", () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ["America/Los_Angeles", "Asia/Kabul"]) {
      process.env.TZ = timezone;
      const html = render();
      const inputs = html.match(/<input[^>]*>/g) ?? [];
      for (const [name, value] of [
        ["day", "2026-10-21"],
        ["compare_day", "2026-10-20"],
      ]) {
        const input = inputs.find((input) => input.includes(`name="${name}"`)) ?? "";
        assert.match(input, /min="2026-07-24"/);
        assert.match(input, /max="2026-10-21"/);
        assert.ok(input.includes(`value="${value}"`));
      }
      assert.match(html, /Oct 21, 2026/);
      assert.match(html, /Oct 20, 2026/);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("incomplete activity stays unknown while a tracked zero remains visible", () => {
  const input = data();
  input.day.activity_available = false;
  input.compare_day.points = input.compare_day.points.map((point) => ({ ...point, active: 0 }));
  const html = render(input);
  assert.match(html, /Hourly activity unavailable/);
  assert.match(html, /Those totals stay unknown/);
  assert.match(html, />0<\/dd>/);
  assert.match(html, /Requires both recorded totals/);
  assert.doesNotMatch(html, /No change|vs comparison day/);
});

test("a zero comparison baseline reports the count difference without a percentage", () => {
  const input = data();
  input.compare_day.points = input.compare_day.points.map((point) => ({ ...point, active: 0 }));
  const html = render(input);
  assert.match(html, /\+28<\/dd>/);
  assert.match(html, /Comparison day is zero; percentage unavailable/);
  assert.doesNotMatch(html, /Infinity|NaN|% vs comparison day/);
});

test("before the first completed hour the panel waits instead of showing zero totals", () => {
  const input = data();
  input.day.completed_hours = 0;
  const html = renderToStaticMarkup(
    <DayComparisonPanel data={input} requestedHour={8} onDates={() => {}} />,
  );
  assert.match(html, /No completed hour to compare yet/);
  assert.match(html, /The first comparison is available after 01:00 Kabul/);
  assert.match(html, /Waiting for the first completed hour/);
  assert.match(html, /value="latest" selected="">No completed hour yet/);
  assert.doesNotMatch(html, />0<\/dd>|No change|vs comparison day/);
});

test("the selected metric and earlier cutoff can stay controlled across date pairs", () => {
  for (const date of ["2026-10-21", "2026-10-19"]) {
    const input = data();
    input.day.date = date;
    const html = renderToStaticMarkup(
      <DayComparisonPanel data={input} metric="installs" requestedHour={4} onDates={() => {}} />,
    );
    assert.match(html, /Through 04:00 Kabul · same cutoff for both days/);
    assert.match(html, />4<\/dd>/);
    assert.match(html, />8<\/dd>/);
    assert.match(html, /−4<\/dd>/);
    assert.match(html, /aria-pressed="true"[^>]*>New installs<\/button>/);
  }
});

test("ordinary daily charts render without mounting the comparison query", () => {
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
  assert.match(html, /Activity date range/);
});

test("a missing comparison endpoint has its own retry state independent of ordinary stats", () => {
  const client = new QueryClient();
  client.setQueryData(["admin", "day-comparison", "synthetic", "", ""], null);
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
  assert.match(html, /Day comparison is unavailable until the server update is ready/);
  assert.match(html, />Retry<\/button>/);
  assert.doesNotMatch(html, /The activity chart couldn|Activity date range/);
});
