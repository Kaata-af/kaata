import type { Growth, GrowthWeek } from "./api";

// Follow backend metadata during rollout/rollback. A new frontend must never
// label the previous backend's Monday aggregates as Saturday reporting weeks.
export function reportingWeekLabels(weekStartsOn?: number) {
  return weekStartsOn === 6
    ? { range: "Saturday–Friday", start: "Saturday", end: "Friday" }
    : { range: "Monday–Sunday", start: "Monday", end: "Sunday" };
}

// Use the server's reporting calendar/coverage rather than the browser clock.
// An older backend can still render accounting charts, but cannot claim that
// its historical tracking covered two full weeks.
export function weeklyGrowthView(growth: Growth | null) {
  const rows = (growth?.growth_accounting ?? [])
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.week))
    .slice()
    .sort((a, b) => a.week.localeCompare(b.week));
  const available = rows.some((row) => typeof row.complete === "boolean");
  const completed = rows.filter((row) => row.complete === true);
  return {
    available,
    completed,
    latest: completed.at(-1) ?? null,
    current: rows.filter((row) => row.complete === false).at(-1) ?? null,
  };
}

export function comparableWeek(row: GrowthWeek): boolean {
  return (
    row.complete === true &&
    row.tracking_complete === true &&
    row.previous_tracking_complete === true &&
    row.calendar_comparable === true &&
    typeof row.previous_active === "number" &&
    row.previous_active > 0 &&
    typeof row.growth_rate_percent === "number" &&
    Number.isFinite(row.growth_rate_percent)
  );
}

export function weeklyRateLabel(row: GrowthWeek): string {
  if (!comparableWeek(row)) return "—";
  const rate = row.growth_rate_percent!;
  return `${rate > 0 ? "+" : ""}${rate.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

export function comparisonUnavailable(row: GrowthWeek, trackingSince?: string): string {
  if (!trackingSince) return "Tracking coverage is unknown.";
  if (row.tracking_complete !== true || row.previous_tracking_complete !== true) {
    return "Two fully tracked weeks are needed for a comparison.";
  }
  if (row.calendar_comparable === false) {
    return "The reporting calendar changed in this week or its baseline; a clean comparison is unavailable.";
  }
  if (row.previous_active === 0)
    return "The previous week had no active devices; a percentage is undefined.";
  return "A comparable weekly rate is currently unavailable.";
}

// How many devices every install metric leaves out as operator or test data
// (2026-10-12). "" when the backend predates the count, so nothing is
// claimed about exclusions it did not report.
export function excludedDevicesNote(count?: number): string {
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return "";
  if (count === 0) return "No devices are excluded as operator or test data.";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "device is" : "devices are"} excluded as operator or test data.`;
}

export function weeklyCalendarLabel(week: string, cutover?: string): string {
  if (!cutover) return "Reporting calendar";
  if (week >= cutover) return "Kabul";
  const start = Date.parse(`${week}T00:00:00Z`);
  if (!Number.isFinite(start)) return "Reporting calendar";
  const end = new Date(start + 6 * 86_400_000).toISOString().slice(0, 10);
  return end >= cutover ? "Calendar transition" : "UTC";
}
