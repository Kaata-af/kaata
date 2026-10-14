import assert from "node:assert/strict";
import { test } from "node:test";
import {
  busiestHours,
  hourlyProfile,
  hourlyTimeline,
  type HourlyStats,
} from "./hourly-activity.ts";

function stats(overrides: Partial<HourlyStats> = {}): HourlyStats {
  return {
    bucket: "hour",
    series: [{ t: "2026-10-15T00:00", installs: 2, active: 3 }],
    generated_at: "2026-10-15T12:00:00Z",
    hourly_tracking_since: "2026-10-14T00:00:00Z",
    ...overrides,
  };
}

test("offsetless buckets stay Kabul hours in browsers with other timezones", () => {
  const original = process.env.TZ;
  try {
    const input = stats();
    const expected = hourlyTimeline(input);
    for (const zone of ["UTC", "Asia/Kathmandu", "America/Chicago", "Asia/Kabul"]) {
      process.env.TZ = zone;
      assert.deepEqual(hourlyTimeline(input), expected);
      assert.deepEqual(hourlyProfile(input), hourlyProfile(expected));
    }
    assert.equal(expected[0].timestamp, Date.parse("2026-10-14T19:30:00Z"));
    assert.equal(expected[0].date, "2026-10-15");
    assert.equal(expected[0].hour, 0);
    assert.equal(expected[0].label, "00:00");
    assert.equal(expected[0].fullHourLabel, "2026-10-15 00:00–01:00 (Kabul)");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("Kabul midnight crosses UTC's half-hour and labels the following local date", () => {
  const points = hourlyTimeline(
    stats({
      series: [
        { t: "2026-10-15T00:00", installs: 2, active: 3 },
        { t: "2026-10-14T23:00", installs: 1, active: 1 },
      ],
    }),
  );
  assert.equal(points[0].timestamp, Date.parse("2026-10-14T18:30:00Z"));
  assert.equal(points[1].timestamp - points[0].timestamp, 3_600_000);
  assert.equal(points[0].fullHourLabel, "2026-10-14 23:00–2026-10-15 00:00 (Kabul)");
});

test("migration's partial hour has unknown activity but still known historical installs", () => {
  const points = hourlyTimeline(
    stats({
      hourly_tracking_since: "2026-10-15T04:47:00Z", // 09:17 Kabul.
      series: [
        { t: "2026-10-15T08:00", installs: 2, active: 0 },
        { t: "2026-10-15T09:00", installs: 3, active: 8 },
        { t: "2026-10-15T10:00", installs: 4, active: 0 },
      ],
    }),
  );
  assert.deepEqual(
    points.map((point) => point.active),
    [null, null, 0],
  );
  const profile = hourlyProfile(points);
  assert.equal(profile[9].activitySamples, 0);
  assert.equal(profile[9].activeAverage, null);
  assert.equal(profile[9].installAverage, 3);
  assert.equal(profile[10].activitySamples, 1);
  assert.equal(profile[10].activeAverage, 0);
});

test("sub-millisecond migration cutoffs do not claim a fully tracked hour", () => {
  const points = hourlyTimeline(stats({ hourly_tracking_since: "2026-10-14T19:30:00.000001Z" }));
  assert.equal(points[0].active, null);
  assert.equal(
    hourlyTimeline(stats({ hourly_tracking_since: "2026-10-14T19:30:00.000000Z" }))[0].active,
    3,
  );
});

test("current partial hours remain visible but cannot become a ranked busy hour", () => {
  const points = hourlyTimeline(
    stats({
      generated_at: "2026-10-15T05:45:00Z", // 10:15 Kabul.
      series: [
        { t: "2026-10-15T09:00", installs: 2, active: 4 },
        { t: "2026-10-15T10:00", installs: 99, active: 99 },
        { t: "2026-10-15T11:00", installs: 0, active: 0 },
      ],
    }),
  );
  assert.deepEqual(
    points.map((point) => point.complete),
    [true, false, false],
  );
  assert.equal(points[1].active, 99);
  const profile = hourlyProfile(points);
  assert.equal(profile[10].activeAverage, null);
  assert.equal(profile[10].installAverage, null);
  assert.deepEqual(busiestHours(profile, "active"), { hours: [9], average: 4 });
  assert.deepEqual(busiestHours(profile, "installs"), { hours: [9], average: 2 });
});

test("an hour ending exactly at server generation time is complete", () => {
  const points = hourlyTimeline(stats({ generated_at: "2026-10-14T20:30:00Z" }));
  assert.equal(points[0].complete, true);
  assert.equal(hourlyProfile(points)[0].activeAverage, 3);
});

test("missing tracking metadata means unknown activity, rather than historical zeroes", () => {
  const profile = hourlyProfile(stats({ hourly_tracking_since: undefined }));
  assert.equal(profile[0].activeAverage, null);
  assert.equal(profile[0].activitySamples, 0);
  assert.equal(profile[0].installAverage, 2);
  assert.equal(profile[1].installAverage, null);
  assert.equal(profile[1].installSamples, 0);
  assert.equal(busiestHours(profile, "active"), null);
  for (const value of ["not a time", "2026-10-14T00:00:00", "2026-02-30T00:00:00Z"]) {
    assert.equal(hourlyProfile(stats({ hourly_tracking_since: value }))[0].activeAverage, null);
  }
});

test("missing or malformed server generation time cannot invent completed samples", () => {
  for (const value of ["", "2026-10-15T12:00:00", "2026-02-30T12:00:00Z"]) {
    const points = hourlyTimeline(stats({ generated_at: value }));
    assert.equal(points[0].complete, false);
    assert.equal(hourlyProfile(points)[0].installAverage, null);
    assert.equal(hourlyProfile(points)[0].activeAverage, null);
  }
});

test("averages include fully tracked zeroes and compare different sample counts fairly", () => {
  const profile = hourlyProfile(
    stats({
      hourly_tracking_since: "2026-10-01T00:00:00Z",
      series: [
        { t: "2026-10-14T08:00", installs: 0, active: 0 },
        { t: "2026-10-15T08:00", installs: 6, active: 6 },
        { t: "2026-10-15T09:00", installs: 4, active: 4 },
      ],
    }),
  );
  assert.equal(profile[8].activitySamples, 2);
  assert.equal(profile[8].installSamples, 2);
  assert.equal(profile[8].activeAverage, 3);
  assert.equal(profile[8].installAverage, 3);
  assert.equal(profile[9].activitySamples, 1);
  assert.deepEqual(busiestHours(profile, "active"), { hours: [9], average: 4 });
  assert.deepEqual(busiestHours(profile, "installs"), { hours: [9], average: 4 });
});

test("all positive ties remain explicit and zero-only profiles do not name a busiest hour", () => {
  const profile = hourlyProfile(
    stats({
      series: [
        { t: "2026-10-15T08:00", installs: 0, active: 2 },
        { t: "2026-10-15T09:00", installs: 0, active: 2 },
      ],
    }),
  );
  assert.deepEqual(busiestHours(profile, "active"), { hours: [8, 9], average: 2 });
  assert.equal(busiestHours(profile, "installs"), null);
  assert.equal(busiestHours(hourlyProfile(null), "active"), null);
});

test("invalid dates, non-hour buckets and invalid counts cannot enter the timeline", () => {
  const malformed = [
    "2026-02-30T09:00",
    "2026-10-15T24:00",
    "2026-10-15T09:30",
    "2026-10-15T09:00:00",
    "2026-10-15T09:00Z",
    "2026-10-15",
    "2026-13-01T09:00",
    "2026-00-01T09:00",
  ];
  const input = stats({
    series: [
      ...malformed.map((t) => ({ t, installs: 1, active: 1 })),
      { t: "2026-10-15T08:00", installs: -1, active: 1 },
      { t: "2026-10-15T09:00", installs: 1, active: Number.NaN },
      { t: "2028-02-29T10:00", installs: 0, active: 0 },
    ],
  });
  const points = hourlyTimeline(input);
  assert.deepEqual(
    points.map((point) => point.t),
    ["2026-10-15T09:00", "2028-02-29T10:00"],
  );
  assert.equal(points[0].active, null);
  assert.equal(points[1].active, 0);
  assert.deepEqual(hourlyTimeline({ ...input, bucket: "day" }), []);
});
