import { getLocale, t } from "./i18n";
import { formatTimestamp } from "./format";
import { faDigits, formatCalendarDate } from "./jalali";
import type { ReminderSchedule } from "./reminder-schedule";

export function reminderWeekday(weekday: number): string {
  return new Intl.DateTimeFormat(
    getLocale() === "ps" ? "ps-AF" : getLocale() === "fa" ? "fa-AF" : "en",
    { weekday: "long" },
  ).format(new Date(2024, 0, 7 + weekday, 12));
}
// The app's own 12-hour clock with ق.ظ/ب.ظ, like every other time it shows.
// ICU's fa-AF clock is 24-hour, so Dari reminders read 15:05 (audit #25).
export function reminderClock(hour: number, minute: number): string {
  const hours12 = hour % 12 === 0 ? 12 : hour % 12;
  const clock = `${hours12}:${String(minute).padStart(2, "0")}`;
  const marker = t(hour < 12 ? "format.am" : "format.pm");
  return `${getLocale() !== "en" ? faDigits(clock) : clock} ${marker}`;
}
// Day-first like every app date ("12 Oct", "۱۲ اکتوبر"), not ICU's
// month-first "October 12" (audit #29). Monthly repeats are Gregorian.
export function reminderMonthlyDate(at: number): string {
  return formatCalendarDate(at, getLocale(), "gregorian").split(" ").slice(0, 2).join(" ");
}
export function reminderMonthCount(months: number): string {
  return months === 1
    ? t("reminders.oneMonth")
    : t("reminders.monthCount", {
        months: new Intl.NumberFormat(
          getLocale() === "ps" ? "ps-AF" : getLocale() === "fa" ? "fa-AF" : "en",
        ).format(months),
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
      .join(getLocale() !== "en" ? "، " : ", ");
    return t("reminders.everyWeekday", { weekday: days, time });
  }
  const day = new Intl.NumberFormat(
    getLocale() === "ps" ? "ps-AF" : getLocale() === "fa" ? "fa-AF" : "en",
  ).format(schedule.day);
  const months = new Intl.NumberFormat(
    getLocale() === "ps" ? "ps-AF" : getLocale() === "fa" ? "fa-AF" : "en",
  ).format(schedule.intervalMonths);
  return t(schedule.intervalMonths === 1 ? "reminders.onMonthlyDay" : "reminders.onMonthInterval", {
    day,
    months,
    time,
  });
}
