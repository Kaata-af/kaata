import assert from "node:assert/strict";
import {
  nextReminderOccurrence as next,
  reminderNativeTrigger,
  reminderNativeRequests,
  reminderNotificationRequestCount,
  validReminderSchedule as valid,
} from "../reminder-schedule";

const oldTZ = process.env.TZ;
try {
  process.env.TZ = "America/New_York";
  const civil = (y: number, m: number, d: number, h: number, minute = 0) =>
    new Date(y, m - 1, d, h, minute).getTime();
  assert.equal(new Date(civil(2026, 1, 1, 12)).getTimezoneOffset(), 300, "test timezone is active");
  assert.equal(
    next({ kind: "daily", hour: 9, minute: 15 }, civil(2026, 3, 7, 9, 15)),
    civil(2026, 3, 8, 9, 15),
  );
  assert.equal(
    civil(2026, 3, 8, 9, 15) - civil(2026, 3, 7, 9, 15),
    23 * 3600_000,
    "daily follows civil time through spring DST",
  );
  assert.equal(
    next({ kind: "daily", hour: 9, minute: 15 }, civil(2026, 10, 31, 9, 15)),
    civil(2026, 11, 1, 9, 15),
  );
  assert.equal(
    civil(2026, 11, 1, 9, 15) - civil(2026, 10, 31, 9, 15),
    25 * 3600_000,
    "daily follows civil time through fall DST",
  );
  const gap = next({ kind: "daily", hour: 2, minute: 30 }, civil(2026, 3, 7, 23))!;
  assert.equal(new Date(gap).getHours(), 3, "nonexistent local time uses JS civil normalization");
  assert.equal(new Date(gap).getMinutes(), 30);
  const foldFirst = civil(2026, 11, 1, 1, 30);
  assert.equal(
    next({ kind: "daily", hour: 1, minute: 30 }, foldFirst),
    civil(2026, 11, 2, 1, 30),
    "ambiguous hour runs once that day",
  );
  assert.equal(
    next({ kind: "weekly", weekday: 4, hour: 10, minute: 0 }, civil(2026, 12, 31, 10)),
    civil(2027, 1, 7, 10),
    "Thursday boundary advances a full week",
  );
  assert.equal(
    next({ kind: "weekly", weekday: 0, hour: 9, minute: 0 }, civil(2026, 3, 1, 9)),
    civil(2026, 3, 8, 9),
  );
  assert.equal(
    next({ kind: "daily", hour: 0, minute: 0 }, civil(2026, 12, 31, 23, 59)),
    civil(2027, 1, 1, 0),
  );
  assert.equal(next({ kind: "once", at: 1000 }, 999), 1000);
  assert.equal(next({ kind: "once", at: 1000 }, 1000), null);
  assert.equal(next({ kind: "once", at: 1000 }, 1001), null);
  for (const bad of [
    null,
    {},
    { kind: "once", at: NaN },
    { kind: "once", at: 9e15 },
    { kind: "daily", hour: 24, minute: 0 },
    { kind: "daily", hour: 1, minute: 1.2 },
    { kind: "weekly", weekday: 7, hour: 1, minute: 0 },
  ]) {
    assert.equal(valid(bad as any), false);
    assert.equal(next(bad as any, 0), null);
  }
  assert.equal(next({ kind: "daily", hour: 1, minute: 0 }, 9e15), null);
  assert.deepEqual(
    reminderNativeTrigger({ kind: "weekly", weekday: 0, hour: 9, minute: 5 }, "channel"),
    { type: "weekly", weekday: 1, hour: 9, minute: 5, channelId: "channel" },
  );
  assert.equal(
    reminderNativeTrigger({ kind: "weekly", weekday: 4, hour: 9, minute: 5 }, "channel").weekday,
    5,
  );
  assert.equal(
    reminderNativeTrigger({ kind: "daily", hour: 9, minute: 5 }, "channel").type,
    "daily",
  );
  assert.equal(reminderNativeTrigger({ kind: "once", at: 1000 }, "channel").type, "date");
  const selected = { kind: "weekdays" as const, weekdays: [4, 0, 2], hour: 9, minute: 5 };
  assert.equal(
    next(selected, civil(2026, 10, 11, 9, 5)),
    civil(2026, 10, 13, 9, 5),
    "selected weekdays advance to the next selected civil day",
  );
  assert.equal(next(selected, civil(2026, 10, 15, 9, 5)), civil(2026, 10, 18, 9, 5));
  assert.deepEqual(
    reminderNativeRequests(selected, "channel").map((request) => [
      request.suffix,
      (request.trigger as any).weekday,
    ]),
    [
      [":weekday:0", 1],
      [":weekday:2", 3],
      [":weekday:4", 5],
    ],
  );
  assert.equal(reminderNotificationRequestCount(selected), 3);
  const monthly = {
    kind: "monthly" as const,
    day: 28,
    intervalMonths: 1 as const,
    anchorMonth: 0,
    hour: 9,
    minute: 15,
  };
  assert.equal(
    next(monthly, civil(2026, 1, 28, 9, 15)),
    civil(2026, 2, 28, 9, 15),
    "monthly day28 exists even in a short February",
  );
  assert.equal(
    next(monthly, civil(2028, 1, 31, 10)),
    civil(2028, 2, 28, 9, 15),
    "month arithmetic avoids carrying the caller's day31 into February",
  );
  assert.equal(next(monthly, civil(2026, 12, 28, 9, 15)), civil(2027, 1, 28, 9, 15));
  assert.deepEqual(reminderNativeRequests(monthly, "channel"), [
    {
      suffix: "",
      trigger: {
        type: "monthly",
        day: 28,
        hour: 9,
        minute: 15,
        channelId: "channel",
      },
    },
  ]);
  const alternate = { ...monthly, day: 10, intervalMonths: 2 as const, anchorMonth: 10 };
  assert.equal(next(alternate, civil(2026, 11, 10, 9, 15)), civil(2027, 1, 10, 9, 15));
  assert.equal(next(alternate, civil(2026, 12, 1, 0)), civil(2027, 1, 10, 9, 15));
  assert.equal(next(alternate, civil(2026, 10, 1, 0)), civil(2026, 11, 10, 9, 15));
  assert.deepEqual(
    reminderNativeRequests(alternate, "channel").map((request) => [
      (request.trigger as any).month,
      request.trigger.type,
    ]),
    [
      [0, "yearly"],
      [2, "yearly"],
      [4, "yearly"],
      [6, "yearly"],
      [8, "yearly"],
      [10, "yearly"],
    ],
  );
  assert.equal(
    reminderNotificationRequestCount(alternate),
    6,
    "alternate months are persistent recurring native requests, not a rolling queue",
  );
  assert.deepEqual(
    reminderNativeRequests(monthly, "channel", "ios"),
    [
      {
        suffix: "",
        trigger: {
          type: "calendar",
          repeats: true,
          day: 28,
          hour: 9,
          minute: 15,
          channelId: "channel",
        },
      },
    ],
    "iOS explicitly uses Expo's ISO calendar rather than the phone's chosen system calendar",
  );
  assert.deepEqual(
    reminderNativeRequests(alternate, "channel", "ios").map((request) => [
      (request.trigger as any).month,
      request.trigger.type,
      (request.trigger as any).repeats,
    ]),
    [
      [1, "calendar", true],
      [3, "calendar", true],
      [5, "calendar", true],
      [7, "calendar", true],
      [9, "calendar", true],
      [11, "calendar", true],
    ],
    "Expo's iOS CalendarTriggerRecord consumes native one-based months without conversion",
  );
  for (const intervalMonths of [1, 2, 3, 6, 12] as const) {
    const spec = { ...monthly, intervalMonths, anchorMonth: 11 };
    assert.equal(
      next(spec, civil(2026, 12, 28, 9, 15)),
      civil(2027, intervalMonths, 28, 9, 15),
      "every permitted interval crosses year correctly",
    );
  }
  const dstMonthly = { ...monthly, day: 8, hour: 2, minute: 30 };
  assert.equal(
    next(dstMonthly, civil(2026, 2, 8, 2, 30)),
    civil(2026, 3, 8, 3, 30),
    "monthly clock times retain DST gap normalization",
  );
  for (const bad of [
    { ...selected, weekdays: [] },
    { ...selected, weekdays: [1, 1] },
    { ...selected, weekdays: [-1] },
    { ...selected, weekdays: [7] },
    { ...monthly, day: 0 },
    { ...monthly, day: 29 },
    { ...monthly, intervalMonths: 5 },
    { ...monthly, anchorMonth: 12 },
    { ...monthly, minute: 60 },
  ]) {
    assert.equal(valid(bad as any), false);
    assert.equal(next(bad as any, 0), null);
    assert.throws(() => reminderNativeRequests(bad as any, "channel"), /invalid_reminder_schedule/);
  }
  process.env.TZ = "Asia/Kabul";
  assert.equal(
    next(alternate, civil(2026, 12, 31, 23, 59)),
    civil(2027, 1, 10, 9, 15),
    "same monthly phase follows Kabul's civil clock",
  );
} finally {
  process.env.TZ = oldTZ;
}
console.log(
  "Reminder schedule: civil DST, selected weekdays, monthly phases/year boundaries and native triggers passed.",
);
