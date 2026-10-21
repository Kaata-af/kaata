import { LineChart, type Color, type CustomTooltipProps } from "@tremor/react";
import { useEffect, useRef, useState } from "react";
import { useDayComparison, type DayComparisonResult } from "./api";
import { fmtDateTime, fmtExactDateTime } from "./dates";
import {
  advancedComparisonModel,
  comparisonCsv,
  COMPARISON_PRESETS,
  customDateError,
  parseComparisonPreferences,
  supportsAdvancedComparison,
  type ComparisonPreferences,
} from "./day-comparison-model";
import { ErrorCard, fmtInt } from "./ui";

const FIELD =
  "mt-1.5 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-brand-border bg-white px-2.5 py-2 text-sm text-brand-ink outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10";
const BUTTON =
  "min-h-11 rounded-lg border border-brand-border bg-white px-3 py-2 text-xs font-medium text-brand-ink transition hover:bg-brand-ivory focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-not-allowed disabled:opacity-40";
const STORAGE_KEY = "kaata_admin_day_comparison_v1";
const COLORS = ["#2a78d6", "#199e70", "#8b5cf6", "#b45309", "#be185d", "#64748b", "#e34948"];
// Tremor emits these classes dynamically; keep literal scanner entries here.
// bg-[#2a78d6] text-[#2a78d6] fill-[#2a78d6] stroke-[#2a78d6]
// bg-[#199e70] text-[#199e70] fill-[#199e70] stroke-[#199e70]
// bg-[#8b5cf6] text-[#8b5cf6] fill-[#8b5cf6] stroke-[#8b5cf6]
// bg-[#b45309] text-[#b45309] fill-[#b45309] stroke-[#b45309]
// bg-[#be185d] text-[#be185d] fill-[#be185d] stroke-[#be185d]
// bg-[#64748b] text-[#64748b] fill-[#64748b] stroke-[#64748b]
// bg-[#e34948] text-[#e34948] fill-[#e34948] stroke-[#e34948]

function initialPreferences(): ComparisonPreferences {
  try {
    return parseComparisonPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return parseComparisonPreferences(null);
  }
}

export function DayComparison() {
  const [preferences, setPreferences] = useState(initialPreferences);
  const colorRegistry = useRef(new Map<string, string>());
  const query = useDayComparison(
    preferences.preset === "custom"
      ? { days: preferences.customDates }
      : { preset: preferences.preset },
  );
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Display controls still work without storage. */
    }
  }, [preferences]);
  const reset = () =>
    setPreferences((previous) => ({
      ...previous,
      preset: "today-yesterday",
      customDates: [],
      baselineDate: "",
      hiddenDates: [],
    }));
  if (query.isPending)
    return (
      <div role="status" aria-label="Loading day comparison" className="min-h-96 space-y-4">
        <div className="h-20 animate-pulse rounded-lg bg-brand-faint" />
        <div className="h-64 animate-pulse rounded-lg bg-brand-faint" />
      </div>
    );
  if (query.isError || !query.data || !supportsAdvancedComparison(query.data)) {
    const updateRequired =
      !query.isError && (!query.data || !supportsAdvancedComparison(query.data));
    return (
      <div className="space-y-3">
        <ErrorCard
          message={
            updateRequired
              ? "Advanced day comparison requires the server update. Try again after it is ready."
              : "The day comparison couldn't be loaded. Saved dates may be outside the available range."
          }
          onRetry={() => void query.refetch()}
        />
        <button type="button" className={BUTTON} onClick={reset}>
          Reset to today and yesterday
        </button>
      </div>
    );
  }
  return (
    <DayComparisonPanel
      key={query.data.days!.map((day) => day.date).join(",")}
      data={query.data}
      preferences={preferences}
      onPreferences={setPreferences}
      fetching={query.isFetching}
      colorRegistry={colorRegistry.current}
    />
  );
}

// Production owns preferences above so selected metrics and explicit cutoffs
// survive a date selection fetch. Synthetic previews can use the panel alone.
export function DayComparisonPanel({
  data,
  preferences: controlled,
  onPreferences,
  fetching = false,
  colorRegistry,
}: {
  data: DayComparisonResult;
  preferences?: ComparisonPreferences;
  onPreferences?(preferences: ComparisonPreferences): void;
  fetching?: boolean;
  colorRegistry?: Map<string, string>;
}) {
  const [local, setLocal] = useState(() => parseComparisonPreferences(null));
  const preferences = controlled ?? local;
  const update = (patch: Partial<ComparisonPreferences>) =>
    (onPreferences ?? setLocal)({ ...preferences, ...patch });
  const [customOpen, setCustomOpen] = useState(preferences.preset === "custom");
  const [draftDates, setDraftDates] = useState(
    preferences.preset === "custom"
      ? preferences.customDates
      : (data.days?.map((day) => day.date) ?? []),
  );
  const [dateError, setDateError] = useState("");
  const localRegistry = useRef(new Map<string, string>());
  const registry = colorRegistry ?? localRegistry.current;
  const exportUrl = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
    },
    [],
  );
  const model = advancedComparisonModel(data, preferences);
  // Only Latest advances as new hours complete. A requested fixed hour that
  // exceeds the new dates' coverage becomes their actual available cutoff.
  useEffect(() => {
    if (
      preferences.requestedHour !== null &&
      model.maxCutoff > 0 &&
      preferences.requestedHour > model.maxCutoff
    )
      update({ requestedHour: model.maxCutoff });
  }, [model.maxCutoff, preferences.requestedHour]);
  if (!supportsAdvancedComparison(data))
    return (
      <p className="py-5 text-sm text-brand-sub">
        Advanced day comparison requires the server update.
      </p>
    );
  const days = data.days!;
  const dates = days.map((day) => day.date);
  const used = new Set<string>();
  for (const date of dates) {
    const previous = registry.get(date);
    if (previous && !used.has(previous)) used.add(previous);
    else registry.delete(date);
  }
  for (const date of dates)
    if (!registry.has(date)) {
      const color = COLORS.find((color) => !used.has(color))!;
      registry.set(date, color);
      used.add(color);
    }
  const labels = Object.fromEntries(dates.map((date) => [date, fmtDateTime(date)]));
  const chart = model.points.map((point) => ({
    time: point.label,
    hour: point.hour,
    ...Object.fromEntries(dates.map((date) => [labels[date], point.values[date]])),
  }));
  const cutoff = `${String(model.cutoff).padStart(2, "0")}:00`;
  const metricLabel = preferences.metric === "active" ? "active installs" : "new installs";
  const first = model.totals[0];
  const hasData = model.points.some((point) =>
    model.visibleDates.some((date) => point.values[date] !== null),
  );
  const missingTotals = model.totals.filter((day) => day.value === null);
  const toggleDate = (date: string) => {
    const visible = model.visibleDates.includes(date)
      ? model.visibleDates.filter((value) => value !== date)
      : [...model.visibleDates, date];
    if (visible.length) update({ hiddenDates: dates.filter((date) => !visible.includes(date)) });
  };
  const download = () => {
    if (exportUrl.current) URL.revokeObjectURL(exportUrl.current);
    const url = URL.createObjectURL(
      new Blob([comparisonCsv(data, model, preferences)], { type: "text/csv;charset=utf-8" }),
    );
    exportUrl.current = url;
    const link = document.createElement("a");
    link.href = url;
    link.download = `kaata-${preferences.metric}-${preferences.mode}-${data.max_date}-${cutoff.replace(":", "")}.csv`;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (exportUrl.current === url) exportUrl.current = null;
    }, 1000);
  };
  return (
    <div className="min-w-0 max-w-full">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <label className="min-w-0 w-full text-xs font-medium text-brand-sub sm:w-auto sm:min-w-64">
          Dates to compare
          <select
            aria-label="Dates to compare"
            className={FIELD}
            value={customOpen ? "custom" : preferences.preset}
            onChange={(event) => {
              if (event.currentTarget.value === "custom") {
                setCustomOpen(true);
                setDateError("");
              } else {
                setCustomOpen(false);
                update({ preset: event.currentTarget.value as ComparisonPreferences["preset"] });
              }
            }}
          >
            {COMPARISON_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
            <option value="custom">Custom dates · 2 to 7</option>
          </select>
        </label>
        <button type="button" className={BUTTON} disabled={model.cutoff === 0} onClick={download}>
          Download CSV
        </button>
      </div>
      {customOpen ? (
        <form
          className="mt-4 rounded-xl border border-brand-border bg-brand-ivory p-3 sm:p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget).getAll("dates").map(String);
            const error = customDateError(values, data.min_date, data.max_date);
            setDateError(error);
            if (!error) update({ preset: "custom", customDates: values });
          }}
        >
          <p className="text-xs leading-5 text-brand-sub">
            Choose 2–7 distinct Kabul dates. The first date is the headline comparison.
          </p>
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {draftDates.map((date, index) => (
              <div key={`${index}/${draftDates.length}`} className="flex min-w-0 items-end gap-2">
                <label className="min-w-0 flex-1 text-xs font-medium text-brand-sub">
                  Date {index + 1}
                  <input
                    className={FIELD}
                    aria-label={`Date ${index + 1}`}
                    type="date"
                    name="dates"
                    required
                    min={data.min_date}
                    max={data.max_date}
                    defaultValue={date}
                  />
                </label>
                <button
                  type="button"
                  className={`${BUTTON} shrink-0 px-2.5`}
                  aria-label={`Remove date ${index + 1}`}
                  disabled={draftDates.length <= 2}
                  onClick={(event) => {
                    const values = new FormData(event.currentTarget.form!)
                      .getAll("dates")
                      .map(String);
                    setDraftDates(values.filter((_, position) => position !== index));
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {dateError ? (
            <p role="alert" className="mt-3 text-xs text-red-700">
              {dateError}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={draftDates.length >= 7}
              onClick={(event) => {
                const values = new FormData(event.currentTarget.form!).getAll("dates").map(String);
                setDraftDates([...values, ""]);
              }}
            >
              + Add date
            </button>
            <button
              type="submit"
              className={`${BUTTON} border-brand-primary bg-brand-primary text-white hover:bg-brand-ink`}
            >
              Apply dates
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-brand-muted">
            Available {fmtDateTime(data.min_date)}–{fmtDateTime(data.max_date)}. The chart keeps its
            applied dates until you select Apply.
          </p>
        </form>
      ) : null}
      <div className="mt-4 flex min-w-0 flex-wrap items-end gap-3">
        <Toggle
          label="Comparison metric"
          values={[
            ["active", "Active installs"],
            ["installs", "New installs"],
          ]}
          value={preferences.metric}
          onChange={(metric) => update({ metric: metric as ComparisonPreferences["metric"] })}
        />
        <Toggle
          label="Chart mode"
          values={[
            ["cumulative", "Cumulative"],
            ["hourly", "Per hour"],
          ]}
          value={preferences.mode}
          onChange={(mode) => update({ mode: mode as ComparisonPreferences["mode"] })}
        />
        <label className="min-w-0 w-full text-xs font-medium text-brand-sub sm:w-auto sm:flex-1">
          Compare through
          <select
            aria-label="Compare through"
            className={FIELD}
            disabled={model.maxCutoff === 0}
            value={
              preferences.requestedHour === null || model.maxCutoff === 0 ? "latest" : model.cutoff
            }
            onChange={(event) =>
              update({
                requestedHour:
                  event.currentTarget.value === "latest" ? null : Number(event.currentTarget.value),
              })
            }
          >
            <option value="latest">
              {model.maxCutoff === 0
                ? "No completed hour yet"
                : `Latest common · ${String(model.maxCutoff).padStart(2, "0")}:00`}
            </option>
            {Array.from({ length: model.maxCutoff }, (_, index) => index + 1).map((hour) => (
              <option key={hour} value={hour}>
                {String(hour).padStart(2, "0")}:00{hour === 24 ? " · complete day" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 w-full text-xs font-medium text-brand-sub sm:w-auto sm:flex-1">
          Baseline
          <select
            aria-label="Comparison baseline"
            className={FIELD}
            value={model.baselineDate}
            onChange={(event) => update({ baselineDate: event.currentTarget.value })}
          >
            {dates.map((date) => (
              <option key={date} value={date}>
                {labels[date]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-4 flex min-w-0 items-center gap-2 text-xs font-medium text-brand-sub">
        <span>
          {model.cutoff > 0
            ? `Through ${cutoff} Kabul${model.cutoff === 24 ? " · complete days" : preferences.requestedHour === null ? " · last completed hour" : " · fixed cutoff"}`
            : "No completed hour to compare yet"}
        </span>
        <span
          role="status"
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        >
          <span
            aria-hidden="true"
            className={`h-3 w-3 rounded-full border border-brand-border border-t-brand-muted motion-safe:animate-spin ${fetching ? "opacity-100" : "opacity-0"}`}
          />
          <span className="sr-only">{fetching ? "Updating day comparison" : ""}</span>
        </span>
      </p>
      <div className="mt-3 rounded-lg bg-brand-faint p-3 text-xs leading-5 text-brand-sub">
        {first.value === null ? (
          "A complete cumulative comparison is unavailable for the first selected date."
        ) : (
          <p>
            <strong className="font-semibold text-brand-ink">
              {labels[first.date]}: {fmtInt(first.value)} {metricLabel}
            </strong>
            {first.date !== model.baselineDate
              ? ` · ${delta(first.difference)} (${percentage(first.percentChange)}) vs ${labels[model.baselineDate]}`
              : " · baseline day"}
            .
          </p>
        )}
        {model.average !== null ? (
          <p className="mt-1">
            Average across {dates.length} days:{" "}
            {model.average.toLocaleString("en-US", { maximumFractionDigits: 1 })}.{" "}
            {model.bestDates.length === dates.length
              ? "All days are tied."
              : `Highest total: ${model.bestDates.map((date) => labels[date]).join(", ")}.`}
          </p>
        ) : (
          <p className="mt-1">
            Average and highest day require known cumulative totals for every selected date.
          </p>
        )}
      </div>
      {model.cutoff === 0 || !hasData ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-2 py-6 text-center sm:min-h-64">
          <p className="text-sm font-medium text-brand-sub">
            {model.cutoff === 0
              ? "The first comparison is available after 01:00 Kabul"
              : "No recorded values for the visible lines"}
          </p>
          <p className="max-w-md text-xs leading-5 text-brand-sub">
            {model.cutoff === 0
              ? "Wait for the first completed hour, or choose earlier days."
              : "Try another metric, chart mode or date with recorded hourly history."}
          </p>
        </div>
      ) : (
        <LineChart
          className="mt-4 h-60 min-w-0 max-w-full sm:h-72"
          data={chart}
          index="time"
          categories={model.visibleDates.map((date) => labels[date])}
          colors={model.visibleDates.map((date) => registry.get(date)! as Color)}
          curveType="linear"
          connectNulls={false}
          allowDecimals={false}
          valueFormatter={fmtInt}
          yAxisWidth={40}
          showAnimation={false}
          showLegend={false}
          tickGap={36}
          customTooltip={(props) => (
            <ComparisonTooltip {...props} hourly={preferences.mode === "hourly"} />
          )}
        />
      )}
      <div className="mt-4 flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-brand-ink">
          Cumulative totals through {cutoff} Kabul
        </h3>
        <p className="text-[11px] text-brand-muted">
          Table totals stay cumulative in both chart modes
        </p>
      </div>
      <div className="mt-2 max-w-full overflow-x-auto rounded-xl border border-brand-border">
        <table className="w-full text-left text-xs tabular-nums">
          <caption className="sr-only">
            Cumulative {metricLabel} through {cutoff} Kabul; differences versus{" "}
            {labels[model.baselineDate]}
          </caption>
          <thead className="bg-brand-ivory text-[11px] text-brand-sub">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Date / chart line
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Total
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Δ
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Δ %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-faint">
            {model.totals.map((day) => {
              const visible = model.visibleDates.includes(day.date);
              return (
                <tr
                  key={day.date}
                  className={day.date === model.baselineDate ? "bg-brand-ivory/70" : ""}
                >
                  <th scope="row" className="px-3 py-3 font-normal">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        className="mt-0.5 h-4 w-4 shrink-0 accent-brand-primary"
                        type="checkbox"
                        aria-label={`Show ${labels[day.date]} on chart`}
                        checked={visible}
                        disabled={visible && model.visibleDates.length === 1}
                        onChange={() => toggleDate(day.date)}
                      />
                      <span
                        className="mt-1 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: registry.get(day.date) }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 text-brand-ink">
                        {labels[day.date]}
                        {day.date === model.baselineDate ? (
                          <span className="mt-0.5 block text-[10px] font-medium text-brand-muted">
                            Baseline{visible ? "" : " · line hidden"}
                          </span>
                        ) : !visible ? (
                          <span className="mt-0.5 block text-[10px] text-brand-muted">
                            Line hidden
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </th>
                  <td className="px-2 py-3 text-right font-semibold text-brand-ink">
                    {fmtInt(day.value)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right text-brand-sub">
                    {delta(day.difference)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-brand-sub">
                    {percentage(day.percentChange)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-brand-muted">
        All {dates.length} selected days set the shared cutoff, including hidden lines. The table
        and CSV keep every selected date. Percentage change is unavailable when the baseline is
        zero.
      </p>
      {missingTotals.length ? (
        <p className="mt-3 rounded-lg bg-brand-faint p-3 text-xs leading-5 text-brand-sub">
          Cumulative totals are unknown for{" "}
          {missingTotals.map((day) => labels[day.date]).join(", ")}. A partly tracked day may still
          have known individual hours in Per hour mode.
        </p>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
        {preferences.mode === "cumulative"
          ? "Each line counts distinct installations since Kabul midnight through each completed hour."
          : "Each point covers one completed hour: 14:00 means 13:00–14:00 Kabul. Hourly active counts cannot be added into distinct daily activity."}{" "}
        Every line stops at the shared cutoff. History is hourly; minute-by-minute comparisons are
        unavailable.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-brand-sub">
        Active installs include signed-out and background check-ins. These counts are separate from
        accounts and the device estimate. Operator and test installations are excluded.
        {data.tracking_since
          ? ` Hourly activity tracking began ${fmtExactDateTime(data.tracking_since)} Kabul.`
          : ""}
      </p>
    </div>
  );
}

function Toggle({
  label,
  values,
  value,
  onChange,
}: {
  label: string;
  values: [string, string][];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap rounded-lg border border-brand-border p-1"
      role="group"
      aria-label={label}
    >
      {values.map(([key, label]) => (
        <button
          type="button"
          key={key}
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`min-h-10 rounded-md px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary ${value === key ? "bg-brand-primary text-white shadow-sm" : "text-brand-sub hover:text-brand-ink"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
function delta(value: number | null): string {
  return value === null
    ? "—"
    : value === 0
      ? "0"
      : `${value > 0 ? "+" : "−"}${fmtInt(Math.abs(value))}`;
}
function percentage(value: number | null): string {
  return value === null
    ? "—"
    : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function ComparisonTooltip({
  active,
  payload,
  label,
  hourly,
}: CustomTooltipProps & { hourly: boolean }) {
  if (!active || !payload?.length) return null;
  const hour = Number(String(label).slice(0, 2));
  return (
    <div className="max-w-72 rounded-lg border border-brand-border bg-white p-3 text-xs shadow-md">
      <p className="font-medium text-brand-ink">
        {hourly
          ? `${String(hour - 1).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:00 Kabul`
          : `Through ${label} Kabul`}
      </p>
      {payload.map((item) => (
        <div key={String(item.dataKey)} className="mt-2 flex justify-between gap-4">
          <span className="text-brand-sub">
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-full"
              style={{ background: item.color }}
            />
            {String(item.dataKey)}
          </span>
          <span className="font-medium tabular-nums text-brand-ink">
            {typeof item.value === "number" ? fmtInt(item.value) : "Unknown"}
          </span>
        </div>
      ))}
    </div>
  );
}
