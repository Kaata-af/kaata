import type { Calendar } from "./calendar";
import {
  adjacentCalendarMonth,
  datePresetRange,
  localDayStart,
  shiftLocalDay,
} from "./tally-date-filter";

export type ExportPeriodChoice = "all" | "month" | "lastMonth" | "custom";

/** Calendar months follow the same preference as the statement's printed dates. */
export function exportPeriod(
  choice: ExportPeriodChoice,
  now: number,
  calendar: Calendar,
  first: number,
  last: number,
): { startMs: number; endMs: number } | undefined {
  if (choice === "all") return undefined;
  if (choice === "custom") {
    if (
      !Number.isFinite(first) ||
      !Number.isFinite(last) ||
      localDayStart(last) < localDayStart(first)
    )
      throw new Error("export: invalid date range");
    return { startMs: localDayStart(first), endMs: shiftLocalDay(last, 1) };
  }
  const range = datePresetRange(
    "month",
    choice === "lastMonth" ? adjacentCalendarMonth(now, -1, calendar) : now,
    calendar,
  );
  return { startMs: range.start, endMs: range.end };
}
