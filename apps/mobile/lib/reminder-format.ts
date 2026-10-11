import { getLocale, t } from "./i18n";
import { formatTimestamp } from "./format";
import type { ReminderSchedule } from "./reminder-schedule";

export function reminderWeekday(weekday: number): string {
  return new Intl.DateTimeFormat(getLocale() === "fa" ? "fa-AF" : "en", { weekday: "long" }).format(
    new Date(2024, 0, 7 + weekday, 12),
  );
}
export function reminderClock(hour: number, minute: number): string {
  const clock = new Date();
  clock.setHours(hour, minute, 0, 0);
  return new Intl.DateTimeFormat(getLocale() === "fa" ? "fa-AF" : "en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(clock);
}
export function formatReminderSchedule(schedule: ReminderSchedule): string {
  if (schedule.kind === "once") return formatTimestamp(schedule.at);
  const time = reminderClock(schedule.hour, schedule.minute);
  return schedule.kind === "daily"
    ? t("reminders.everyDay", { time })
    : t("reminders.everyWeekday", { weekday: reminderWeekday(schedule.weekday), time });
}
