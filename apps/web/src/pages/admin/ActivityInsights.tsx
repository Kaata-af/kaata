import { AreaChart, BarChart, type CustomTooltipProps } from "@tremor/react";
import type { ReactNode } from "react";
import type { Stats } from "./api";
import { fmtExactDateTime } from "./dates";
import { busiestHours, hourlyProfile, hourlyTimeline, type HourlyPeak } from "./hourly-activity";
import { C, Card, ErrorCard, fmtInt } from "./ui";
import { DayComparison } from "./DayComparison";

export type ActivityView = "hour" | "day" | "profile" | "compare";

function rangeLabel(points: number, view: ActivityView): string {
  return view === "day"
    ? `${points} days`
    : points === 24
      ? "24 hours"
      : `${Math.round(points / 24)} days`;
}

export function ActivityInsights(props: {
  stats: Stats | undefined;
  view: ActivityView;
  range: number;
  pending: boolean;
  error: boolean;
  fetching: boolean;
  onView(view: ActivityView): void;
  onRange(points: number): void;
  onRetry(): void;
  dailyChart: ReactNode;
}) {
  const ranges =
    props.view === "day" ? [7, 30, 90] : props.view === "profile" ? [168, 720] : [24, 168, 720];
  const reportedRange = rangeLabel(props.stats?.points ?? props.range, props.view);
  const refreshing = props.fetching && !props.pending;
  return (
    <Card
      title="Activity & installs"
      sub={
        props.view === "compare"
          ? "Compare two Kabul days through the same completed hour"
          : `Last ${reportedRange} · ${props.view === "day" ? "Kabul reporting calendar" : "Kabul time (UTC+04:30)"}`
      }
      action={
        <div
          className="inline-flex max-w-full flex-wrap rounded-lg border border-brand-border bg-brand-ivory p-1"
          role="group"
          aria-label="Activity view"
        >
          {(
            [
              ["hour", "Hourly"],
              ["day", "Daily"],
              ["profile", "Busy hours"],
              ["compare", "Compare days"],
            ] as const
          ).map(([view, label]) => (
            <Choice key={view} selected={props.view === view} onClick={() => props.onView(view)}>
              {label}
            </Choice>
          ))}
        </div>
      }
    >
      {props.view === "compare" ? (
        <DayComparison />
      ) : (
        <>
          <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-2 text-xs text-brand-sub">
              <span>
                {props.view === "profile"
                  ? "Average devices and installs at each hour of the day"
                  : "Active devices and new installs"}
              </span>
              <span
                role="status"
                className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
              >
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 rounded-full border border-brand-border border-t-brand-muted motion-safe:animate-spin ${refreshing ? "opacity-100" : "opacity-0"}`}
                />
                <span className="sr-only">{refreshing ? "Updating chart" : ""}</span>
              </span>
            </p>
            <div
              className="inline-flex max-w-full rounded-lg border border-brand-border p-1"
              role="group"
              aria-label="Activity date range"
            >
              {ranges.map((points) => (
                <Choice
                  key={points}
                  selected={props.range === points}
                  onClick={() => props.onRange(points)}
                >
                  {rangeLabel(points, props.view)}
                </Choice>
              ))}
            </div>
          </div>
          {props.pending ? (
            <div className="h-56 animate-pulse rounded-lg bg-brand-faint sm:h-64" />
          ) : props.error || !props.stats ? (
            <ErrorCard message="The activity chart couldn't be loaded." onRetry={props.onRetry} />
          ) : props.view === "day" ? (
            props.dailyChart
          ) : (
            <HourlyChart stats={props.stats} profile={props.view === "profile"} />
          )}
        </>
      )}
    </Card>
  );
}

function Choice(props: { selected: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onClick}
      className={`min-h-10 rounded-md px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-primary ${props.selected ? "bg-brand-primary text-white shadow-sm" : "text-brand-sub hover:text-brand-ink"}`}
    >
      {props.children}
    </button>
  );
}

function average(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function hourRange(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00–${String((hour + 1) % 24).padStart(2, "0")}:00`;
}

function HourlyChart({ stats, profile }: { stats: Stats; profile: boolean }) {
  const timeline = hourlyTimeline(stats);
  const byHour = hourlyProfile(timeline);
  const data = profile
    ? byHour.map((point) => ({
        time: point.label,
        hint: `${hourRange(point.hour)} · Kabul`,
        "Active devices": point.activeAverage,
        "New installs": point.installAverage,
        activitySamples: point.activitySamples,
        installSamples: point.installSamples,
        average: true,
      }))
    : timeline.map((point) => ({
        time: timeline.length <= 24 ? point.label : `${point.date.slice(5)} ${point.label}`,
        hint: point.fullHourLabel,
        "Active devices": point.active,
        "New installs": point.installs,
        partial: !point.complete,
        average: false,
      }));
  const hasData = data.some(
    (point) => (point["Active devices"] ?? 0) > 0 || (point["New installs"] ?? 0) > 0,
  );
  return (
    <div className="min-w-0 max-w-full">
      {!hasData ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-2 text-center sm:min-h-64">
          <p className="text-sm font-medium text-brand-sub">
            {profile
              ? "No completed hours with activity yet"
              : "No recorded activity in this range"}
          </p>
          <p className="text-xs text-brand-sub">
            Choose a longer range to look for earlier installs and check-ins.
          </p>
        </div>
      ) : profile ? (
        <BarChart
          className="h-56 min-w-0 max-w-full sm:h-64"
          data={data}
          index="time"
          categories={["Active devices", "New installs"]}
          colors={[C.blue, C.teal]}
          allowDecimals
          valueFormatter={average}
          yAxisWidth={44}
          showAnimation={false}
          tickGap={24}
          customTooltip={HourlyTooltip}
        />
      ) : (
        <AreaChart
          className="h-56 min-w-0 max-w-full sm:h-64"
          data={data}
          index="time"
          categories={["Active devices", "New installs"]}
          colors={[C.blue, C.teal]}
          curveType="linear"
          connectNulls={false}
          allowDecimals={false}
          valueFormatter={fmtInt}
          yAxisWidth={44}
          showAnimation={false}
          tickGap={36}
          customTooltip={HourlyTooltip}
        />
      )}
      {profile ? (
        <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 border-t border-brand-border pt-4 sm:grid-cols-2">
          <Peak
            label="Busiest usage hour"
            peak={busiestHours(byHour, "active")}
            unit="active devices"
          />
          <Peak
            label="Busiest install hour"
            peak={busiestHours(byHour, "installs")}
            unit="new installs"
          />
        </div>
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
        {profile
          ? "Each bar is an average across completed recorded hours, including hours with zero activity. The current hour is excluded."
          : "Each point covers one Kabul clock hour. The current hour is still in progress. An install counts once per hour it checks in, so hourly activity cannot be summed into unique daily users."}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-brand-sub">
        {stats.hourly_tracking_since
          ? `Hourly check-in history starts at ${fmtExactDateTime(stats.hourly_tracking_since)}. Earlier or partly recorded hours have no active-device value.`
          : "The start of hourly tracking is unavailable. Active-device values remain unknown."}{" "}
        Check-ins show when devices reach the server, including background checks; they do not
        measure time spent in the app. Operator and test devices are excluded.
      </p>
    </div>
  );
}

function Peak(props: { label: string; peak: HourlyPeak | null; unit: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-brand-sub">{props.label}</p>
      <p
        className="mt-1 text-base font-semibold tabular-nums text-brand-ink"
        title={props.peak?.hours.map(hourRange).join(", ")}
      >
        {props.peak
          ? props.peak.hours.length === 1
            ? hourRange(props.peak.hours[0])
            : `Tied across ${props.peak.hours.length} hours`
          : "—"}
      </p>
      {props.peak && props.peak.hours.length > 1 ? (
        <p className="mt-1 break-words text-xs tabular-nums text-brand-sub">
          {props.peak.hours.map(hourRange).join(", ")}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-brand-sub">
        {props.peak
          ? `${average(props.peak.average)} ${props.unit} on average · Kabul`
          : "Waiting for completed hours with activity"}
      </p>
    </div>
  );
}

function HourlyTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as {
    hint: string;
    partial?: boolean;
    average: boolean;
    "Active devices": number | null;
    "New installs": number | null;
    activitySamples?: number;
    installSamples?: number;
  };
  return (
    <div className="max-w-72 rounded-lg border border-brand-border bg-white p-3 text-xs shadow-md">
      <p className="font-medium text-brand-ink">{row.hint}</p>
      {row.partial ? <p className="mt-1 text-brand-sub">Hour in progress</p> : null}
      {(
        [
          ["Active devices", C.blue, row.activitySamples],
          ["New installs", C.teal, row.installSamples],
        ] as const
      ).map(([label, color, samples]) => (
        <div key={label} className="mt-2 flex justify-between gap-4">
          <span className="text-brand-sub">
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-full"
              style={{ background: color }}
            />
            {label}
            {row.average ? ` · ${samples ?? 0} recorded hours` : ""}
          </span>
          <span className="font-medium tabular-nums text-brand-ink">
            {row[label] == null
              ? "Unknown"
              : row.average
                ? average(row[label])
                : fmtInt(row[label])}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RecentInstalls({ stats }: { stats: Stats }) {
  return (
    <Card title="Latest installs" sub="Reported install times · Kabul (UTC+04:30)">
      {stats.latest_installs === undefined ? (
        <p className="py-5 text-sm text-brand-sub">
          Exact install history is unavailable right now. Recorded install times are available in
          Users.
        </p>
      ) : stats.latest_installs.length === 0 ? (
        <p className="py-5 text-sm text-brand-sub">No recorded installs yet.</p>
      ) : (
        <ul className="divide-y divide-brand-border">
          {stats.latest_installs.map((install) => (
            <li
              key={install.install_id}
              className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-brand-ink [overflow-wrap:anywhere]">
                  {install.name || "Unidentified install"}
                </p>
                <p className="mt-0.5 text-xs text-brand-sub">
                  {install.platform === "ios"
                    ? "iOS"
                    : install.platform === "android"
                      ? "Android"
                      : "Platform unknown"}
                </p>
              </div>
              <time
                dateTime={install.installed_at}
                title={`First reached the server: ${fmtExactDateTime(install.first_seen_at)} Kabul`}
                className="text-xs tabular-nums text-brand-sub"
              >
                {fmtExactDateTime(install.installed_at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 border-t border-brand-border pt-3 text-xs leading-relaxed text-brand-sub">
        Install time is the earlier of the device's recorded install and its first server contact.
        Offline installs can reach the server later. Operator and test devices are excluded.{" "}
        <a className="font-medium text-brand-ink hover:underline" href="#users">
          See all installs in Users →
        </a>
      </p>
    </Card>
  );
}
