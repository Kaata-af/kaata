import { LineChart } from "@tremor/react";
import { useState } from "react";
import { useDayComparison, type DayComparisonResult } from "./api";
import { fmtDateTime, fmtExactDateTime } from "./dates";
import { comparisonModel, type ComparisonMetric } from "./day-comparison-model";
import { C, ErrorCard, fmtInt } from "./ui";

const FIELD =
  "mt-1.5 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-brand-border bg-white px-2.5 py-2 text-sm text-brand-ink outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10";

export function DayComparison() {
  const [dates, setDates] = useState({ day: "", compareDay: "" });
  const [metric, setMetric] = useState<ComparisonMetric>("active");
  const [requestedHour, setRequestedHour] = useState<number | null>(null);
  const query = useDayComparison(dates.day, dates.compareDay);
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading day comparison" className="min-h-96 space-y-4">
        <div className="h-20 animate-pulse rounded-lg bg-brand-faint" />
        <div className="h-64 animate-pulse rounded-lg bg-brand-faint" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-3">
        <ErrorCard
          message={
            query.data === null
              ? "Day comparison is unavailable until the server update is ready."
              : "The day comparison couldn't be loaded. Try again to refresh it."
          }
          onRetry={() => void query.refetch()}
        />
        {dates.day || dates.compareDay ? (
          <button
            type="button"
            onClick={() => setDates({ day: "", compareDay: "" })}
            className="min-h-11 rounded-lg border border-brand-border bg-white px-3 py-2 text-xs font-medium text-brand-ink hover:bg-brand-ivory focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
          >
            Reset to today and yesterday
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <DayComparisonPanel
      key={`${query.data.day.date}/${query.data.compare_day.date}`}
      data={query.data}
      fetching={query.isFetching}
      metric={metric}
      requestedHour={requestedHour}
      onMetric={setMetric}
      onHour={setRequestedHour}
      onDates={(day, compareDay) => setDates({ day, compareDay })}
    />
  );
}

// Kept separate from fetching so the date, cutoff and coverage states can be
// checked with synthetic data without opening a real admin session.
export function DayComparisonPanel({
  data,
  fetching = false,
  onDates,
  metric: controlledMetric,
  requestedHour: controlledHour,
  onMetric,
  onHour,
}: {
  data: DayComparisonResult;
  fetching?: boolean;
  onDates(day: string, compareDay: string): void;
  metric?: ComparisonMetric;
  requestedHour?: number | null;
  onMetric?(metric: ComparisonMetric): void;
  onHour?(hour: number | null): void;
}) {
  const [localMetric, setLocalMetric] = useState<ComparisonMetric>("active");
  const [localHour, setLocalHour] = useState<number | null>(null);
  const metric = controlledMetric ?? localMetric;
  const requestedHour = controlledHour === undefined ? localHour : controlledHour;
  const setMetric = onMetric ?? setLocalMetric;
  const setRequestedHour = onHour ?? setLocalHour;
  const model = comparisonModel(data, metric, requestedHour);
  const dayLabel = `Selected · ${fmtDateTime(data.day.date)}`;
  const compareLabel = `Compare · ${fmtDateTime(data.compare_day.date)}`;
  const chart = model.points.map((point) => ({
    time: point.label,
    [dayLabel]: point.day,
    [compareLabel]: point.compareDay,
  }));
  const hasCompletedHour = model.cutoff > 0;
  const hasRecordedValues = model.points.some(
    (point) => point.day !== null || point.compareDay !== null,
  );
  const latest = requestedHour === null;
  const cutoffLabel = `${String(model.cutoff).padStart(2, "0")}:00`;
  const metricLabel = metric === "active" ? "active installs" : "new installs";
  const missingActivity = [data.day, data.compare_day]
    .filter((day) => !day.activity_available)
    .map((day) => fmtDateTime(day.date));

  return (
    <div className="min-w-0 max-w-full">
      <form
        className="grid min-w-0 grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const dates = new FormData(event.currentTarget);
          onDates(String(dates.get("day")), String(dates.get("compare_day")));
        }}
      >
        <label className="min-w-0 text-xs font-medium text-brand-sub">
          Selected day
          <input
            className={FIELD}
            type="date"
            name="day"
            required
            min={data.min_date}
            max={data.max_date}
            defaultValue={data.day.date}
          />
        </label>
        <label className="min-w-0 text-xs font-medium text-brand-sub">
          Comparison day
          <input
            className={FIELD}
            type="date"
            name="compare_day"
            required
            min={data.min_date}
            max={data.max_date}
            defaultValue={data.compare_day.date}
          />
        </label>
        <button
          type="submit"
          className="col-span-2 min-h-11 rounded-lg border border-brand-border bg-white px-4 py-2 text-xs font-medium text-brand-ink transition hover:bg-brand-ivory focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary sm:col-span-1"
        >
          Compare dates
        </button>
      </form>
      <div className="mt-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div
          className="inline-flex max-w-full flex-wrap rounded-lg border border-brand-border p-1"
          role="group"
          aria-label="Comparison metric"
        >
          {(
            [
              ["active", "Active installs"],
              ["installs", "New installs"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
              className={`min-h-10 rounded-md px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary ${metric === value ? "bg-brand-primary text-white shadow-sm" : "text-brand-sub hover:text-brand-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="min-w-0 max-w-full text-xs font-medium text-brand-sub">
          Compare through
          <select
            aria-label="Compare through"
            className={`${FIELD} sm:w-auto`}
            value={requestedHour === null || model.maxCutoff === 0 ? "latest" : model.cutoff}
            disabled={model.maxCutoff === 0}
            onChange={(event) =>
              setRequestedHour(
                event.currentTarget.value === "latest" ? null : Number(event.currentTarget.value),
              )
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
      </div>
      <p className="mt-4 flex min-w-0 items-center gap-2 text-xs font-medium text-brand-sub">
        <span>
          {hasCompletedHour
            ? `Through ${cutoffLabel} Kabul${model.cutoff === 24 ? " · complete days" : latest ? " · last completed hour" : " · same cutoff for both days"}`
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
      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 rounded-xl border border-brand-border p-3 sm:grid-cols-3 sm:gap-5 sm:p-4">
        <ComparisonTotal
          label={fmtDateTime(data.day.date)}
          value={hasCompletedHour ? model.dayValue : null}
          detail={
            metric === "active" && !data.day.activity_available
              ? "Hourly activity unavailable"
              : metricLabel
          }
          color={C.blue}
        />
        <ComparisonTotal
          label={fmtDateTime(data.compare_day.date)}
          value={hasCompletedHour ? model.compareValue : null}
          detail={
            metric === "active" && !data.compare_day.activity_available
              ? "Hourly activity unavailable"
              : metricLabel
          }
          color={C.teal}
        />
        <div className="col-span-2 min-w-0 border-t border-brand-faint pt-3 sm:col-span-1 sm:border-0 sm:pt-0">
          <dt className="text-xs text-brand-sub">Difference</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-brand-ink">
            {!hasCompletedHour || model.difference === null
              ? "—"
              : model.difference === 0
                ? "No change"
                : `${model.difference > 0 ? "+" : "−"}${fmtInt(Math.abs(model.difference))}`}
          </dd>
          <p className="mt-1 text-xs leading-5 text-brand-sub">
            {!hasCompletedHour
              ? "Waiting for the first completed hour"
              : model.difference === null
                ? "Requires both recorded totals"
                : model.difference === 0
                  ? "Same total at this cutoff"
                  : model.percentChange === null
                    ? "Comparison day is zero; percentage unavailable"
                    : `${model.percentChange > 0 ? "+" : "−"}${Math.abs(model.percentChange).toLocaleString("en-US", { maximumFractionDigits: 1 })}% vs comparison day`}
          </p>
        </div>
      </dl>
      {metric === "active" && !model.activityAvailable ? (
        <p className="mt-3 rounded-lg bg-brand-faint px-3 py-2 text-xs leading-5 text-brand-sub">
          Full hourly activity history is unavailable for {missingActivity.join(" and ")}. Those
          totals stay unknown. New installs can still be compared.
        </p>
      ) : null}
      {!hasCompletedHour || !hasRecordedValues ? (
        <div className="mt-3 flex min-h-56 flex-col items-center justify-center gap-2 text-center sm:min-h-64">
          <p className="text-sm font-medium text-brand-sub">
            {!hasCompletedHour
              ? "The first comparison is available after 01:00 Kabul"
              : "Activity comparison is unavailable for these dates"}
          </p>
          <p className="max-w-md text-xs leading-5 text-brand-sub">
            {!hasCompletedHour
              ? "A new Kabul day has started. Wait for its first complete hour, or choose two earlier days."
              : "Choose New installs or select dates with complete hourly tracking."}
          </p>
        </div>
      ) : (
        <LineChart
          className="mt-4 h-56 min-w-0 max-w-full sm:h-64"
          data={chart}
          index="time"
          categories={[dayLabel, compareLabel]}
          colors={[C.blue, C.teal]}
          curveType="linear"
          connectNulls={false}
          allowDecimals={false}
          startEndOnly
          valueFormatter={fmtInt}
          yAxisWidth={40}
          showAnimation={false}
          noDataText="No recorded totals at this cutoff"
        />
      )}
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
        Each line shows the cumulative total since Kabul midnight. Both stop at the selected hour;
        14:00 covers midnight up to 14:00, even if the current time is later. History is stored by
        hour, so minute-by-minute comparison is unavailable.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-brand-sub">
        Active installs count distinct app installations that checked in, including signed-out and
        background check-ins. This is separate from signed-in accounts and the device estimate.
        Operator and test installations are excluded.
        {data.tracking_since
          ? ` Hourly activity tracking began ${fmtExactDateTime(data.tracking_since)} Kabul.`
          : ""}
      </p>
    </div>
  );
}

function ComparisonTotal({
  label,
  value,
  detail,
  color,
}: {
  label: string;
  value: number | null;
  detail: string;
  color: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-brand-sub">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <span>{label}</span>
      </dt>
      <dd className="mt-1 break-words text-2xl font-semibold tabular-nums text-brand-ink">
        {value === null ? "—" : fmtInt(value)}
      </dd>
      <p className="mt-1 text-xs leading-5 text-brand-sub">{detail}</p>
    </div>
  );
}
