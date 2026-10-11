import assert from "node:assert/strict";
import {
  nextReminderOccurrence as next,
  reminderNativeTrigger,
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
} finally {
  process.env.TZ = oldTZ;
}
console.log("Reminder schedule: civil DST, weekdays, boundaries and native triggers passed.");
