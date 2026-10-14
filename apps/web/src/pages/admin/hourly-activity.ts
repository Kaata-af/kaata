import type { Stats } from "./api";

const HOUR_MS = 3_600_000;
const KABUL_OFFSET_MS = 270 * 60_000;

export type HourlyStats = Pick<Stats, "series" | "bucket" | "generated_at"> & {
  hourly_tracking_since?: string;
};

export type HourlyTimelinePoint = {
  t: string;
  label: string;
  date: string;
  fullHourLabel: string;
  timestamp: number;
  hour: number;
  installs: number;
  active: number | null;
  complete: boolean;
};

export type HourlyProfilePoint = {
  hour: number;
  label: string;
  activeAverage: number | null;
  installAverage: number | null;
  activitySamples: number;
  installSamples: number;
};

export type HourlyPeak = { hours: number[]; average: number };

// Calendar validation is separate from Date.parse, which can normalize an
// impossible February date rather than rejecting it. UTC methods never depend
// on the browser's timezone (including half-hour and quarter-hour offsets).
function validCalendar(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function metadataTime(value: string | undefined, roundUp = false): number | null {
  if (!value) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  if (
    !validCalendar(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  // A migration can start one microsecond after the hour. Date.parse drops
  // sub-millisecond precision; round coverage up so that partial hour still
  // cannot be treated as fully tracked.
  const subMilliseconds = /\.(\d+)/.exec(value)?.[1].slice(3) ?? "";
  return timestamp + (roundUp && /[1-9]/.test(subMilliseconds) ? 1 : 0);
}

function kabulHour(value: string): { timestamp: number; hour: number; date: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour] = match;
  if (!validCalendar(Number(year), Number(month), Number(day)) || Number(hour) > 23) {
    return null;
  }
  return {
    timestamp: Date.parse(`${value}:00+04:30`),
    hour: Number(hour),
    date: value.slice(0, 10),
  };
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// `t` is an offsetless Kabul bucket from the backend, not a browser-local
// timestamp. Activity before the tracking cutoff is unknown, never zero.
export function hourlyTimeline(stats: HourlyStats | null | undefined): HourlyTimelinePoint[] {
  if (!stats || stats.bucket !== "hour") return [];
  const generated = metadataTime(stats.generated_at);
  const trackingSince = metadataTime(stats.hourly_tracking_since, true);
  const points = new Map<number, HourlyTimelinePoint>();
  for (const row of stats.series) {
    const parsed = kabulHour(row.t);
    if (!parsed || !validCount(row.installs)) continue;
    const label = hourLabel(parsed.hour);
    const endHour = hourLabel((parsed.hour + 1) % 24);
    const endDate = new Date(parsed.timestamp + HOUR_MS + KABUL_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
    const rangeEnd = endDate === parsed.date ? endHour : `${endDate} ${endHour}`;
    points.set(parsed.timestamp, {
      t: row.t,
      label,
      date: parsed.date,
      fullHourLabel: `${parsed.date} ${label}–${rangeEnd} (Kabul)`,
      timestamp: parsed.timestamp,
      hour: parsed.hour,
      installs: row.installs,
      active:
        trackingSince !== null && parsed.timestamp >= trackingSince && validCount(row.active)
          ? row.active
          : null,
      complete: generated !== null && parsed.timestamp + HOUR_MS <= generated,
    });
  }
  return [...points.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Average each hour of day over its actual complete observations. Uneven
// coverage cannot make an hour with more tracked days look artificially busy.
export function hourlyProfile(
  input: HourlyStats | readonly HourlyTimelinePoint[] | null | undefined,
): HourlyProfilePoint[] {
  const timeline: readonly HourlyTimelinePoint[] = Array.isArray(input)
    ? input
    : hourlyTimeline(input as HourlyStats | null | undefined);
  const totals = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    active: 0,
    installs: 0,
    activitySamples: 0,
    installSamples: 0,
  }));
  for (const point of timeline) {
    if (!point.complete) continue;
    const total = totals[point.hour];
    total.installs += point.installs;
    total.installSamples += 1;
    if (point.active !== null) {
      total.active += point.active;
      total.activitySamples += 1;
    }
  }
  return totals.map((total) => ({
    hour: total.hour,
    label: hourLabel(total.hour),
    activeAverage: total.activitySamples ? total.active / total.activitySamples : null,
    installAverage: total.installSamples ? total.installs / total.installSamples : null,
    activitySamples: total.activitySamples,
    installSamples: total.installSamples,
  }));
}

// All tied positive peaks are returned, so the UI does not arbitrarily name
// one hour as the busiest. A wholly unknown or zero-only profile has no peak.
export function busiestHours(
  profile: readonly HourlyProfilePoint[],
  metric: "active" | "installs",
): HourlyPeak | null {
  const key = metric === "active" ? "activeAverage" : "installAverage";
  let peak: HourlyPeak | null = null;
  for (const point of profile) {
    const average = point[key];
    if (average === null || !Number.isFinite(average) || average <= 0) continue;
    if (!peak || average > peak.average) peak = { hours: [point.hour], average };
    else if (average === peak.average) peak.hours.push(point.hour);
  }
  return peak;
}
