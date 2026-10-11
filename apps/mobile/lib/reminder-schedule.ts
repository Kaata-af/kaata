export type ReminderSchedule =
  | { kind: "once"; at: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "weekdays"; weekdays: number[]; hour: number; minute: number }
  | {
      kind: "monthly";
      day: number;
      intervalMonths: 1 | 2 | 3 | 6 | 12;
      /** JS Gregorian month, 0–11. It fixes the interval's repeating phase. */
      anchorMonth: number;
      hour: number;
      minute: number;
    };

export const REMINDER_MONTH_INTERVALS = [1, 2, 3, 6, 12] as const;
/** Leave eight slots for other features below iOS's 64 pending requests. */
export const MAX_REMINDER_NOTIFICATION_REQUESTS = 56;

/** Weekday follows JS: Sunday 0, Thursday 4. Native Expo uses Sunday 1. */
export function validReminderSchedule(value: ReminderSchedule): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "once")
    return (
      Number.isSafeInteger(value.at) &&
      value.at > 0 &&
      Number.isFinite(new Date(value.at).getTime())
    );
  return (
    (value.kind === "daily" ||
      value.kind === "weekly" ||
      value.kind === "weekdays" ||
      value.kind === "monthly") &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59 &&
    (value.kind !== "weekly" ||
      (Number.isInteger(value.weekday) && value.weekday >= 0 && value.weekday <= 6)) &&
    (value.kind !== "weekdays" ||
      (Array.isArray(value.weekdays) &&
        value.weekdays.length > 0 &&
        value.weekdays.length <= 7 &&
        new Set(value.weekdays).size === value.weekdays.length &&
        value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))) &&
    (value.kind !== "monthly" ||
      (Number.isInteger(value.day) &&
        value.day >= 1 &&
        value.day <= 28 &&
        REMINDER_MONTH_INTERVALS.includes(value.intervalMonths) &&
        Number.isInteger(value.anchorMonth) &&
        value.anchorMonth >= 0 &&
        value.anchorMonth <= 11))
  );
}

/** Next strictly-future occurrence in the device's civil timezone. Calendar
 * component arithmetic retains the picked clock time across daylight saving;
 * never model a daily reminder as a fixed 24-hour duration. */
export function nextReminderOccurrence(schedule: ReminderSchedule, after: number): number | null {
  if (
    !validReminderSchedule(schedule) ||
    !Number.isFinite(after) ||
    !Number.isFinite(new Date(after).getTime())
  )
    return null;
  if (schedule.kind === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.kind === "weekdays") {
    return Math.min(
      ...schedule.weekdays.map(
        (weekday) =>
          nextReminderOccurrence(
            { kind: "weekly", weekday, hour: schedule.hour, minute: schedule.minute },
            after,
          )!,
      ),
    );
  }
  if (schedule.kind === "monthly") {
    const current = new Date(after);
    // Intervals divide a calendar year, so the picked month fixes the phase
    // forever. Start from day 1 to prevent JS month-overflow on dates 29–31.
    const offset = (schedule.anchorMonth - current.getMonth() + 12) % schedule.intervalMonths;
    const next = new Date(
      current.getFullYear(),
      current.getMonth() + offset,
      schedule.day,
      schedule.hour,
      schedule.minute,
      0,
      0,
    );
    if (next.getTime() <= after) {
      next.setDate(1);
      next.setMonth(next.getMonth() + schedule.intervalMonths);
      next.setDate(schedule.day);
      next.setHours(schedule.hour, schedule.minute, 0, 0);
    }
    return next.getTime();
  }
  const next = new Date(after);
  next.setHours(12, 0, 0, 0);
  if (schedule.kind === "weekly") {
    next.setDate(next.getDate() + ((schedule.weekday - next.getDay() + 7) % 7));
  }
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= after) {
    next.setHours(12, 0, 0, 0);
    next.setDate(next.getDate() + (schedule.kind === "weekly" ? 7 : 1));
    next.setHours(schedule.hour, schedule.minute, 0, 0);
  }
  return next.getTime();
}

export function reminderNativeTrigger(
  schedule: Extract<ReminderSchedule, { kind: "once" | "daily" | "weekly" }>,
  channelId: string,
) {
  if (!validReminderSchedule(schedule)) throw new Error("invalid_reminder_schedule");
  if (schedule.kind === "once") return { type: "date" as const, date: schedule.at, channelId };
  if (schedule.kind === "daily")
    return { type: "daily" as const, hour: schedule.hour, minute: schedule.minute, channelId };
  return {
    type: "weekly" as const,
    weekday: schedule.weekday + 1,
    hour: schedule.hour,
    minute: schedule.minute,
    channelId,
  };
}

/** Recurring native requests work without needing Kaata to refill a queue.
 * Monthly days 1–28 exist in every Gregorian month on both platforms. */
export function reminderNativeRequests(
  schedule: ReminderSchedule,
  channelId: string,
  platform: "ios" | "android" = "android",
) {
  if (!validReminderSchedule(schedule)) throw new Error("invalid_reminder_schedule");
  if (schedule.kind === "weekdays") {
    return [...schedule.weekdays]
      .sort((a, b) => a - b)
      .map((weekday) => ({
        suffix: `:weekday:${weekday}`,
        trigger: reminderNativeTrigger(
          { kind: "weekly", weekday, hour: schedule.hour, minute: schedule.minute },
          channelId,
        ),
      }));
  }
  if (schedule.kind === "monthly") {
    const { day, hour, minute } = schedule;
    if (schedule.intervalMonths === 1)
      return [
        {
          suffix: "",
          trigger:
            platform === "ios"
              ? // Expo57 CALENDAR explicitly supplies ISO8601. Its convenience
                // MONTHLY/YEARLY iOS triggers omit the calendar and can use a phone's
                // non-Gregorian system preference. Calendar components use months1–12.
                { type: "calendar" as const, repeats: true, day, hour, minute, channelId }
              : { type: "monthly" as const, day, hour, minute, channelId },
        },
      ];
    return Array.from(
      { length: 12 / schedule.intervalMonths },
      (_, index) => (schedule.anchorMonth + index * schedule.intervalMonths) % 12,
    )
      .sort((a, b) => a - b)
      .map((month) => ({
        suffix: `:month:${month}`,
        trigger:
          platform === "ios"
            ? {
                type: "calendar" as const,
                repeats: true,
                month: month + 1,
                day,
                hour,
                minute,
                channelId,
              }
            : { type: "yearly" as const, month, day, hour, minute, channelId },
      }));
  }
  return [{ suffix: "", trigger: reminderNativeTrigger(schedule, channelId) }];
}

export function reminderNotificationRequestCount(schedule: ReminderSchedule): number {
  return reminderNativeRequests(schedule, "").length;
}
