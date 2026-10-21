import type { DayComparisonResult, DayComparisonPreset } from "./api";

export type ComparisonMetric = "active" | "installs";
export type ComparisonMode = "cumulative" | "hourly";
export const COMPARISON_PRESETS: { value: DayComparisonPreset; label: string }[] = [
  { value: "today-yesterday", label: "Today and yesterday" },
  { value: "last7", label: "Last 7 days · includes today" },
  { value: "last7-complete", label: "Last 7 completed days" },
  { value: "same-weekday", label: "Same weekday · last 5 weeks" },
];
export type ComparisonPreferences = {
  preset: DayComparisonPreset | "custom";
  customDates: string[];
  metric: ComparisonMetric;
  mode: ComparisonMode;
  requestedHour: number | null;
  baselineDate: string;
  hiddenDates: string[];
};
export const DEFAULT_COMPARISON_PREFERENCES: ComparisonPreferences = {
  preset: "today-yesterday",
  customDates: [],
  metric: "active",
  mode: "cumulative",
  requestedHour: null,
  baselineDate: "",
  hiddenDates: [],
};

export function validComparisonDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function customDateError(dates: readonly string[], min: string, max: string): string {
  if (dates.length < 2 || dates.length > 7) return "Choose between 2 and 7 dates.";
  if (dates.some((date) => !validComparisonDate(date)))
    return "Choose a valid date in every field.";
  if (new Set(dates).size !== dates.length) return "Choose each date only once.";
  if (dates.some((date) => date < min || date > max))
    return `Choose dates between ${min} and ${max}.`;
  return "";
}

// Only harmless display controls are restored. Authentication, identities,
// unknown fields and malformed selections never enter saved preferences.
export function parseComparisonPreferences(value: unknown): ComparisonPreferences {
  const defaults = { ...DEFAULT_COMPARISON_PREFERENCES, customDates: [], hiddenDates: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const input = value as Record<string, unknown>;
  const dates =
    Array.isArray(input.customDates) && input.customDates.every(validComparisonDate)
      ? (input.customDates as string[])
      : [];
  const customValid =
    dates.length >= 2 && dates.length <= 7 && new Set(dates).size === dates.length;
  const preset = COMPARISON_PRESETS.some((preset) => preset.value === input.preset)
    ? (input.preset as DayComparisonPreset)
    : input.preset === "custom" && customValid
      ? "custom"
      : defaults.preset;
  return {
    preset,
    customDates: customValid ? [...dates] : [],
    metric: input.metric === "installs" ? "installs" : "active",
    mode: input.mode === "hourly" ? "hourly" : "cumulative",
    requestedHour:
      typeof input.requestedHour === "number" &&
      Number.isInteger(input.requestedHour) &&
      input.requestedHour >= 1 &&
      input.requestedHour <= 24
        ? input.requestedHour
        : null,
    baselineDate: validComparisonDate(input.baselineDate) ? input.baselineDate : "",
    hiddenDates: Array.isArray(input.hiddenDates)
      ? [...new Set(input.hiddenDates.filter(validComparisonDate))].slice(0, 7)
      : [],
  };
}

export function supportsAdvancedComparison(data: DayComparisonResult): boolean {
  return (
    Array.isArray(data.days) &&
    data.days.length >= 2 &&
    data.days.length <= 7 &&
    new Set(data.days.map((day) => day.date)).size === data.days.length &&
    data.days.every(
      (day) =>
        validComparisonDate(day.date) &&
        Array.isArray(day.points) &&
        day.points.length === 25 &&
        day.points.every(
          (point) =>
            Object.hasOwn(point, "hourly_active") && Object.hasOwn(point, "hourly_installs"),
        ),
    )
  );
}

export type AdvancedComparisonModel = {
  cutoff: number;
  maxCutoff: number;
  baselineDate: string;
  visibleDates: string[];
  points: { hour: number; label: string; values: Record<string, number | null> }[];
  totals: {
    date: string;
    value: number | null;
    difference: number | null;
    percentChange: number | null;
  }[];
  average: number | null;
  bestDates: string[];
};

function knownCount(value: number | null | undefined): number | null {
  return value != null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function advancedComparisonModel(
  data: DayComparisonResult,
  preferences: ComparisonPreferences,
): AdvancedComparisonModel {
  const days = data.days ?? [];
  const maxCutoff = days.length
    ? Math.min(...days.map((day) => completedHour(day.completed_hours)))
    : 0;
  const cutoff =
    preferences.requestedHour === null
      ? maxCutoff
      : Math.min(completedHour(preferences.requestedHour), maxCutoff);
  const dates = days.map((day) => day.date);
  const baselineDate = dates.includes(preferences.baselineDate)
    ? preferences.baselineDate
    : (dates[1] ?? dates[0] ?? "");
  const visible = dates.filter((date) => !preferences.hiddenDates.includes(date));
  const visibleDates = visible.length ? visible : dates.slice(0, 1);
  const totals = days.map((day) => ({
    date: day.date,
    value:
      cutoff > 0 && (preferences.metric !== "active" || day.activity_available)
        ? knownCount(day.points.find((point) => point.hour === cutoff)?.[preferences.metric])
        : null,
  }));
  const baseline = totals.find((day) => day.date === baselineDate)?.value ?? null;
  const complete = totals.length > 0 && totals.every((day) => day.value !== null);
  const best = complete ? Math.max(...totals.map((day) => day.value!)) : null;
  const key =
    preferences.mode === "hourly"
      ? preferences.metric === "active"
        ? "hourly_active"
        : "hourly_installs"
      : preferences.metric;
  return {
    cutoff,
    maxCutoff,
    baselineDate,
    visibleDates,
    points: Array.from({ length: 25 }, (_, hour) => ({
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      values: Object.fromEntries(
        days.map((day) => {
          const available =
            hour <= cutoff &&
            (preferences.mode !== "hourly" || hour > 0) &&
            (preferences.mode === "hourly" ||
              preferences.metric !== "active" ||
              day.activity_available);
          return [
            day.date,
            available ? knownCount(day.points.find((point) => point.hour === hour)?.[key]) : null,
          ];
        }),
      ),
    })),
    totals: totals.map((day) => {
      const difference = day.value !== null && baseline !== null ? day.value - baseline : null;
      return {
        ...day,
        difference,
        percentChange:
          difference !== null && baseline !== null && baseline !== 0
            ? (difference / baseline) * 100
            : null,
      };
    }),
    average: complete ? totals.reduce((sum, day) => sum + day.value!, 0) / totals.length : null,
    bestDates:
      best === null ? [] : totals.filter((day) => day.value === best).map((day) => day.date),
  };
}

function csvCell(value: string | number | null): string {
  let cell = value === null ? "" : String(value);
  if (/^[=+@\-\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function comparisonCsv(
  data: DayComparisonResult,
  model: AdvancedComparisonModel,
  preferences: ComparisonPreferences,
): string {
  const dates = data.days?.map((day) => day.date) ?? [];
  const rows: (string | number | null)[][] = [
    ["timezone", "Asia/Kabul"],
    ["generated_at", data.generated_at],
    ["tracking_since", data.tracking_since],
    ["cutoff_kabul", `${String(model.cutoff).padStart(2, "0")}:00`],
    ["chart_mode", preferences.mode],
    ["metric", preferences.metric === "active" ? "active_installs" : "new_installs"],
    ["baseline_date", model.baselineDate],
    ["summary_totals", "cumulative since midnight through shared cutoff"],
    [
      "hourly_points",
      "H:00 covers the preceding hour [H-1,H); hourly activity cannot be summed into distinct daily activity",
    ],
    [],
    ["hour_kabul", ...dates],
    ...model.points
      .filter(
        (point) => point.hour <= model.cutoff && (preferences.mode !== "hourly" || point.hour > 0),
      )
      .map((point) => [point.label, ...dates.map((date) => point.values[date])]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function completedHour(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(24, Math.floor(value))) : 0;
}
