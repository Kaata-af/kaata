import type { Calendar } from "./calendar";
import { faDigits, toJalali, toQamari } from "./jalali";

/** Local business dates, [start,end). Never mutate ledger times or totals. */
export type TallyDateRange = { start: number; end: number; timePrecision?: "minute" };
export type TallyDatePreset = "today" | "last7" | "last30" | "month";
export type CalendarDay = { year: number; month: number; day: number; calendar: Calendar };

export function localDayStart(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

// setDate, rather than ±86400000, is intentional across daylight saving.
export function shiftLocalDay(ms: number, days: number): number {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  return localDayStart(date.getTime());
}

export function calendarDay(ms: number, calendar: Calendar): CalendarDay {
  try {
    if (calendar === "jalali") {
      const { jy, jm, jd } = toJalali(ms);
      return { year: jy, month: jm, day: jd, calendar };
    }
    if (calendar === "qamari") {
      const { hy, hm, hd } = toQamari(ms);
      return { year: hy, month: hm, day: hd, calendar };
    }
  } catch {
    /* Match the displayed formatter's Gregorian range fallback. */
  }
  const dt = new Date(ms);
  return {
    year: dt.getFullYear(),
    month: dt.getMonth() + 1,
    day: dt.getDate(),
    calendar: "gregorian",
  };
}

export function calendarMonthDays(ms: number, calendar: Calendar): number[] {
  const fields = calendarDay(ms, calendar);
  if (!Number.isFinite(fields.day)) return [];
  const first = shiftLocalDay(ms, 1 - fields.day);
  const days: number[] = [];
  for (let offset = 0; offset < 32; offset++) {
    const value = shiftLocalDay(first, offset);
    const current = calendarDay(value, calendar);
    if (
      current.year !== fields.year ||
      current.month !== fields.month ||
      current.calendar !== fields.calendar
    )
      break;
    days.push(value);
  }
  return days;
}

export function adjacentCalendarMonth(ms: number, direction: -1 | 1, calendar: Calendar): number {
  const days = calendarMonthDays(ms, calendar);
  if (!days.length) return localDayStart(Date.now());
  return direction === -1 ? shiftLocalDay(days[0], -1) : shiftLocalDay(days[days.length - 1], 1);
}

export function dateRangeBetween(first: number, last: number): TallyDateRange {
  return {
    start: localDayStart(Math.min(first, last)),
    end: shiftLocalDay(Math.max(first, last), 1),
  };
}

/** Time fields are minutes after local midnight, independent of calendar labels.
 * setHours follows the device zone; reject clocks in a daylight-saving gap
 * instead of silently changing the requested time. */
export function localMinute(day: number, minute: number): number | null {
  if (!Number.isFinite(day) || !Number.isInteger(minute) || minute < 0 || minute > 1439)
    return null;
  const date = new Date(day);
  const hour = Math.floor(minute / 60),
    withinHour = minute % 60;
  date.setHours(hour, withinHour, 0, 0);
  return date.getHours() === hour &&
    date.getMinutes() === withinHour &&
    localDayStart(date.getTime()) === localDayStart(day)
    ? date.getTime()
    : null;
}

/** Days can be tapped in either order, but the two clocks always belong to the
 * chronological start/end. Equal clocks include one minute; reversed clocks on
 * the same day are invalid. Add elapsed time for the inclusive final minute,
 * avoiding setMinutes jumping across the repeated autumn hour. */
export function customDateRange(
  first: number,
  last: number,
  startMinute: number,
  endMinute: number,
): TallyDateRange | null {
  const start = localMinute(Math.min(first, last), startMinute);
  const finalMinute = localMinute(Math.max(first, last), endMinute);
  if (start == null || finalMinute == null || finalMinute < start) return null;
  return { start, end: finalMinute + 60_000, timePrecision: "minute" };
}

/** Recover the inclusive final date/clock, including an end at next midnight. */
export function dateRangeDraft(range: TallyDateRange | null): {
  first: number | null;
  last: number | null;
  startMinute: number;
  endMinute: number;
} {
  if (!range) return { first: null, last: null, startMinute: 0, endMinute: 1439 };
  const start = new Date(range.start),
    last = new Date(range.end - 60_000);
  return {
    first: localDayStart(range.start),
    last: localDayStart(range.end - 1),
    startMinute: range.timePrecision ? start.getHours() * 60 + start.getMinutes() : 0,
    endMinute: range.timePrecision ? last.getHours() * 60 + last.getMinutes() : 1439,
  };
}

export function formatFilterClock(ms: number, locale: "en" | "fa"): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "";
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return locale === "fa" ? faDigits(clock) : clock;
}

export function datePresetRange(
  preset: TallyDatePreset,
  now: number,
  calendar: Calendar,
): TallyDateRange {
  if (preset === "month") {
    const days = calendarMonthDays(now, calendar);
    return dateRangeBetween(days[0], days[days.length - 1]);
  }
  return dateRangeBetween(
    shiftLocalDay(now, preset === "last7" ? -6 : preset === "last30" ? -29 : 0),
    now,
  );
}

export function filterTalliesByDate<T extends { created_at: number }>(
  entries: readonly T[],
  range: TallyDateRange | null,
): T[] {
  if (!range) return [...entries];
  return entries.filter((entry) => entry.created_at >= range.start && entry.created_at < range.end);
}
