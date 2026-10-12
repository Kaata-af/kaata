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
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORTING_TIME_ZONE,
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

// A timestamp's Kabul date ("Oct 11, 2026") and clock time ("12:35") as
// separate tokens, so a narrow column can put them on two lines or wrap
// between them without ever breaking inside a word or a number (2026-10-12).
// Date-only history has no recorded time ("" time); unknown values read "—".
export function fmtDateTimeParts(value: string | number): { date: string; time: string } {
  if (value === "") return { date: "—", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: "—", time: "" };
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (date.toISOString().slice(0, 10) !== value) return { date: "—", time: "" };
    return { date: displayDateFormatter.format(date), time: "" };
  }
  return { date: displayDateFormatter.format(date), time: timeFormatter.format(date) };
}

// Operational timestamps use the same Kabul clock as dashboard reporting,
// including in a browser abroad. Date-only history has no recorded time.
export function fmtDateTime(value: string | number): string {
  const { date, time } = fmtDateTimeParts(value);
  return time ? `${date}, ${time}` : date;
}

export function reportingDay(value: string | number): string {
  if (value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(dayFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function msUntilReportingMidnight(now = Date.now()): number {
  const parts = Object.fromEntries(clockFormatter.formatToParts(now).map((p) => [p.type, p.value]));
  const elapsed =
    ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1_000 +
    new Date(now).getUTCMilliseconds();
  return 86_400_000 - elapsed;
}
