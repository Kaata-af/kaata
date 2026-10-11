export type ReminderSchedule =
  | { kind: "once"; at: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

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
    (value.kind === "daily" || value.kind === "weekly") &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59 &&
    (value.kind !== "weekly" ||
      (Number.isInteger(value.weekday) && value.weekday >= 0 && value.weekday <= 6))
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

export function reminderNativeTrigger(schedule: ReminderSchedule, channelId: string) {
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
