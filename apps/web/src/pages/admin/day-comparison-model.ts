import type { DayComparisonResult } from "./api";

export type ComparisonMetric = "active" | "installs";

export type DayComparisonPoint = {
  hour: number;
  label: string;
  day: number | null;
  compareDay: number | null;
};

export type DayComparisonModel = {
  cutoff: number;
  maxCutoff: number;
  points: DayComparisonPoint[];
  dayValue: number | null;
  compareValue: number | null;
  difference: number | null;
  percentChange: number | null;
  activityAvailable: boolean;
};

function completedHour(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(24, Math.floor(value))) : 0;
}

function cumulativeValues(
  day: DayComparisonResult["day"],
  metric: ComparisonMetric,
): Map<number, number | null> {
  const values = new Map<number, number | null>();
  if (metric === "active" && !day.activity_available) return values;
  for (const point of day.points) {
    if (!Number.isInteger(point.hour) || point.hour < 0 || point.hour > 24) continue;
    const value = point[metric];
    values.set(
      point.hour,
      value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null,
    );
  }
  return values;
}

// Each server point already counts the whole day through its hour. Both days
// share one completed cutoff so an unfinished day never competes with a full day.
export function comparisonModel(
  data: DayComparisonResult,
  metric: ComparisonMetric,
  requestedHour: number | null,
): DayComparisonModel {
  const maxCutoff = Math.min(
    completedHour(data.day.completed_hours),
    completedHour(data.compare_day.completed_hours),
  );
  const cutoff =
    requestedHour === null ? maxCutoff : Math.min(completedHour(requestedHour), maxCutoff);
  const day = cumulativeValues(data.day, metric);
  const compareDay = cumulativeValues(data.compare_day, metric);
  const points = Array.from({ length: 25 }, (_, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}:00`,
    day: hour <= cutoff ? (day.get(hour) ?? null) : null,
    compareDay: hour <= cutoff ? (compareDay.get(hour) ?? null) : null,
  }));
  const dayValue = points[cutoff].day;
  const compareValue = points[cutoff].compareDay;
  const difference = dayValue !== null && compareValue !== null ? dayValue - compareValue : null;

  return {
    cutoff,
    maxCutoff,
    points,
    dayValue,
    compareValue,
    difference,
    percentChange:
      difference !== null && compareValue !== null && compareValue !== 0
        ? (difference / compareValue) * 100
        : null,
    activityAvailable: data.day.activity_available && data.compare_day.activity_available,
  };
}
