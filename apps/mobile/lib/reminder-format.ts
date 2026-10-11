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
export function reminderMonthlyDate(at: number): string {
  return new Intl.DateTimeFormat(getLocale() === "fa" ? "fa-AF" : "en", {
    calendar: "gregory",
    month: "long",
    day: "numeric",
  }).format(new Date(at));
}
export function reminderMonthCount(months: number): string {
  return months === 1
    ? t("reminders.oneMonth")
    : t("reminders.monthCount", {
        months: new Intl.NumberFormat(getLocale() === "fa" ? "fa-AF" : "en").format(months),
      });
}
export function formatReminderSchedule(schedule: ReminderSchedule): string {
  if (schedule.kind === "once") return formatTimestamp(schedule.at);
  const time = reminderClock(schedule.hour, schedule.minute);
  if (schedule.kind === "daily") return t("reminders.everyDay", { time });
  if (schedule.kind === "weekly")
    return t("reminders.everyWeekday", { weekday: reminderWeekday(schedule.weekday), time });
  if (schedule.kind === "weekdays") {
    const days = [6, 0, 1, 2, 3, 4, 5]
      .filter((day) => schedule.weekdays.includes(day))
      .map(reminderWeekday)
      .join(getLocale() === "fa" ? "، " : ", ");
    return t("reminders.everyWeekday", { weekday: days, time });
  }
  const day = new Intl.NumberFormat(getLocale() === "fa" ? "fa-AF" : "en").format(schedule.day);
  const months = new Intl.NumberFormat(getLocale() === "fa" ? "fa-AF" : "en").format(
    schedule.intervalMonths,
  );
  return t(schedule.intervalMonths === 1 ? "reminders.onMonthlyDay" : "reminders.onMonthInterval", {
    day,
    months,
    time,
  });
}
