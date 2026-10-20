import { format, parseISO } from "date-fns";
import type { Growth, GrowthWeek } from "./api";
import { Card, fmtDateTime, fmtInt } from "./ui";
import {
  comparableWeek,
  comparisonUnavailable,
  excludedDevicesNote,
  weeklyGrowthView,
  weeklyRateLabel,
  weeklyCalendarLabel,
  reportingWeekLabels,
} from "./weekly-growth";

function weekLabel(week: string): string {
  try {
    return format(parseISO(week), "MMM d, yyyy");
  } catch {
    return week;
  }
}

export function WeeklyGrowthCard({ growth }: { growth: Growth | null }) {
  const reporting = reportingWeekLabels(growth?.week_starts_on);
  const { available, completed, latest, current } = weeklyGrowthView(growth);
  const comparable = latest !== null && comparableWeek(latest);
  return (
    <Card
      title="Weekly activity"
      sub={`Weekly active devices · ${reporting.range} reporting weeks`}
    >
      {!available ? (
        <p className="py-6 text-sm text-brand-sub">
          Weekly activity comparisons are currently unavailable. They will appear when the backend
          reports complete tracking coverage.
        </p>
      ) : (
        <>
          <div className="grid min-w-0 gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-brand-sub">Latest completed week</p>
              <p className="mt-1 text-sm text-brand-ink">
                {latest
                  ? `Week of ${weekLabel(latest.week)} · ${weeklyCalendarLabel(latest.week, growth?.activity_timezone_since)}`
                  : "No completed week yet"}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p className="break-words text-4xl font-semibold tabular-nums text-brand-primary">
                  {latest ? weeklyRateLabel(latest) : "—"}
                </p>
              </div>
              {latest ? (
                <>
                  <p className="mt-3 text-sm tabular-nums text-brand-ink">
                    {fmtInt(latest.previous_active ?? 0)} → {fmtInt(latest.active ?? 0)} active
                    devices
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-brand-sub">
                    {comparable
                      ? `Change: ${latest.change! > 0 ? "+" : ""}${fmtInt(latest.change ?? 0)} active devices from the previous week.`
                      : comparisonUnavailable(latest, growth?.activity_tracking_since)}
                  </p>
                  {latest.recorded_at ? (
                    <p className="mt-1 text-xs text-brand-sub">
                      Recorded {fmtDateTime(latest.recorded_at)} · Kabul
                    </p>
                  ) : null}
                </>
              ) : null}
            </div>
            {current ? <CurrentWeek row={current} weekEndsOn={reporting.end} /> : null}
          </div>
          {completed.length > 0 ? (
            <details className="mt-5 border-t border-brand-border pt-4">
              <summary className="cursor-pointer py-2 text-sm font-medium text-brand-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary">
                Completed weeks ({completed.length})
              </summary>
              <div
                tabIndex={0}
                role="region"
                aria-label="Completed weekly activity history; scroll horizontally for all columns"
                className="mt-2 overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary"
              >
                <table className="w-full text-left text-xs tabular-nums">
                  <caption className="sr-only">
                    Change in weekly active devices, compared with the previous calendar week. Weeks
                    start on {reporting.start}. The reporting calendar is noted for each week.
                  </caption>
                  <thead className="border-b border-brand-border text-brand-sub">
                    <tr>
                      <th scope="col" className="py-3 pr-4 font-medium">
                        Week of
                      </th>
                      <th scope="col" className="px-3 py-3 text-right font-medium">
                        Active devices
                      </th>
                      <th scope="col" className="px-3 py-3 text-right font-medium">
                        Change
                      </th>
                      <th scope="col" className="py-3 pl-3 font-medium">
                        Comparison
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-brand-ink">
                    {completed
                      .slice()
                      .reverse()
                      .map((row) => (
                        <tr key={row.week} className="border-b border-brand-border last:border-0">
                          <th scope="row" className="whitespace-nowrap py-3 pr-4 font-normal">
                            {weekLabel(row.week)}
                            <span className="mt-1 block font-normal text-brand-sub">
                              {weeklyCalendarLabel(row.week, growth?.activity_timezone_since)}
                            </span>
                          </th>
                          <td className="px-3 py-3 text-right">{fmtInt(row.active ?? 0)}</td>
                          <td className="whitespace-nowrap px-3 py-3 text-right font-medium">
                            {weeklyRateLabel(row)}
                          </td>
                          <td className="py-3 pl-3">
                            {comparableWeek(row)
                              ? "Available"
                              : row.calendar_comparable === false
                                ? "Calendar transition"
                                : row.previous_active === 0 &&
                                    row.tracking_complete &&
                                    row.previous_tracking_complete
                                  ? "No baseline"
                                  : "Incomplete tracking"}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      )}
      <details className="mt-5 border-t border-brand-border pt-3 text-xs text-brand-sub">
        <summary className="cursor-pointer py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary">
          What is counted?
        </summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>
            Each app install counts once in a week when it checks in, including signed-out use and
            people who only open the app. Two phones belonging to one person count twice.
          </p>
          <p>
            Test data is left out of every week, the same as in every other dashboard metric:
            devices signed in to an operator account (OPERATOR_ACCOUNT_IDS), and accounts and
            devices you exclude in Users or Outreach. A device stays out after its account is
            deleted. {excludedDevicesNote(growth?.excluded_installs)}
          </p>
          <p>
            Completed weeks are recorded the first time they are reported after {reporting.end} ends
            in Kabul and keep those numbers, so a device later signing in to another account, or an
            account being deleted, cannot change a past week's recorded counts. Excluding or
            including test data, or editing OPERATOR_ACCOUNT_IDS, recalculates the recorded weeks
            once.
          </p>
          {growth?.week_starts_on === 6 ? (
            <p className="mt-2 text-xs leading-relaxed text-brand-muted">
              Working days are Saturday–Thursday; Friday is the weekly holiday. Activity on all
              seven days counts, including Friday. Earlier Monday-week records remain saved; these
              Saturday-week counts are regrouped from the recorded daily activity.
            </p>
          ) : null}
          <p>
            Weekly change = (this week − previous week) ÷ previous week × 100. A zero baseline has
            no percentage. Only completed weeks with full tracking and a comparable calendar for
            both weeks show a rate. The UTC-to-Kabul transition week and its following comparison
            keep their counts without a rate.
          </p>
          <p>
            Tracking began{" "}
            {growth?.activity_tracking_since
              ? fmtDateTime(growth.activity_tracking_since)
              : "at an unknown time"}
            .
            {growth?.activity_timezone_since
              ? ` Earlier date-only activity before ${growth.activity_timezone_since} keeps its original UTC calendar; later weeks use Kabul.`
              : ""}
          </p>
        </div>
      </details>
      {growth?.generated_at ? (
        <p className="mt-3 text-xs text-brand-sub">
          Updated {fmtDateTime(growth.generated_at)} · Kabul
        </p>
      ) : null}
    </Card>
  );
}

function CurrentWeek({ row, weekEndsOn }: { row: GrowthWeek; weekEndsOn: string }) {
  const active = row.active ?? 0;
  const canCompareWhenComplete =
    row.tracking_complete === true &&
    row.previous_tracking_complete === true &&
    row.calendar_comparable === true &&
    typeof row.previous_active === "number" &&
    row.previous_active > 0 &&
    Number.isFinite(row.previous_active);
  return (
    <div className="min-w-0 rounded-xl border border-brand-border bg-brand-ivory p-4">
      <p className="text-xs font-medium text-brand-sub">Current week · in progress</p>
      <p className="mt-1 text-sm text-brand-ink">Week of {weekLabel(row.week)}</p>
      <p className="mt-3 text-2xl font-semibold tabular-nums text-brand-ink">
        {fmtInt(active)} <span className="text-xs font-normal">active devices so far</span>
      </p>
      <p className="mt-2 text-xs leading-relaxed text-brand-sub">
        {fmtInt(row.previous_active ?? 0)} active last week.{" "}
        {canCompareWhenComplete
          ? `This week’s rate appears after ${weekEndsOn} ends in Kabul.`
          : "This week stays provisional; the comparison requirements are not met yet."}
      </p>
    </div>
  );
}
