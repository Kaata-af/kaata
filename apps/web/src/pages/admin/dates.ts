// Admin calendar days match the backend's reporting timezone, regardless of
// the operator's browser timezone. Kabul does not observe daylight saving.
export const REPORTING_TIME_ZONE = "Asia/Kabul";

const dayFormatter = new Intl.DateTimeFormat("en", {
  timeZone: REPORTING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const clockFormatter = new Intl.DateTimeFormat("en", {
  timeZone: REPORTING_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const displayDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORTING_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
});
const timestampFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORTING_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

// Operational timestamps use the same Kabul clock as dashboard reporting,
// including in a browser abroad. Date-only history has no recorded time.
export function fmtDateTime(value: string | number): string {
  if (value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (date.toISOString().slice(0, 10) !== value) return "—";
    return displayDateFormatter.format(date);
  }
  return timestampFormatter.format(date);
}

export function reportingDay(value: string | number): string {
  if (value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Match admin_install_dates: historical install cohorts retain UTC dates,
// while installs on/after the activity cutover use the Kabul calendar.
export function reportingInstallDay(value: string | number, cutover?: string): string {
  const day = reportingDay(value);
  if (!day) return "";
  return cutover && day < cutover ? new Date(value).toISOString().slice(0, 10) : day;
}

export function msUntilReportingMidnight(now = Date.now()): number {
  const parts = Object.fromEntries(clockFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  const elapsed =
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1_000 +
    new Date(now).getUTCMilliseconds();
  return 86_400_000 - elapsed;
}
