import type { Calendar } from "./calendar";
import { toJalali, toQamari } from "./jalali";

/** Local business dates, [start,end). Never mutate ledger times or totals. */
export type TallyDateRange = { start: number; end: number };
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
