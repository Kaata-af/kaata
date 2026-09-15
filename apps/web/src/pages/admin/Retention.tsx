// Retention — do installs come back? Day-N headline pairs from /v1/admin/stats
// (raw retained/eligible so 0/0 renders "—", never a fake 0%) and the weekly
// cohort grid from /v1/admin/growth.

import { Metric, Text } from "@tremor/react";
import { format, parseISO } from "date-fns";
import { useGrowth, useStats, type Growth, type Stats } from "./api";
import { Card, ErrorCard, PageHeader, SkeletonCard, fmtInt } from "./ui";

export function Retention() {
  const stats = useStats();
  const growth = useGrowth();
  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Retention"
        description="How often people return after their first check-in."
      />
      {stats.isPending ? (
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load retention." onRetry={() => void stats.refetch()} />
      ) : (
        <DayNCards stats={stats.data} />
      )}

      <div className="mt-4 min-w-0">
        {growth.isPending ? (
          <SkeletonCard lines={8} />
        ) : growth.isError ? (
          <ErrorCard message="Couldn't load cohorts." onRetry={() => void growth.refetch()} />
        ) : (
          <CohortGrid growth={growth.data} />
        )}
      </div>
    </div>
  );
}

function DayNCards(props: { stats: Stats }) {
  const s = props.stats;
  const rows = [
    { label: "Day 1 return", day: 1, ret: s.ret_d1_retained, elig: s.ret_d1_eligible },
    { label: "Day 7 return", day: 7, ret: s.ret_d7_retained, elig: s.ret_d7_eligible },
    { label: "Day 30 return", day: 30, ret: s.ret_d30_retained, elig: s.ret_d30_eligible },
  ];
  const any = rows.some((r) => r.elig > 0);
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3">
        {rows.map((r) => (
          <Card
            key={r.label}
            className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-center gap-x-3 sm:block"
          >
            <div className="min-w-0">
              <Text className="text-xs font-medium text-[#737373]">{r.label}</Text>
              <Metric className="mt-1 break-words text-2xl tabular-nums [overflow-wrap:anywhere] sm:text-3xl">
                {r.elig ? `${Math.round((r.ret / r.elig) * 100)}%` : "—"}
              </Metric>
            </div>
            <div className="min-w-0">
              <Text className="break-words text-xs tabular-nums text-tremor-content-subtle [overflow-wrap:anywhere] sm:mt-0.5">
                {r.elig
                  ? `${fmtInt(r.ret)} of ${fmtInt(r.elig)} eligible installs`
                  : "No eligible installs yet"}
              </Text>
              <p className="mt-1 text-xs leading-5 text-[#737373] sm:mt-3">
                Checked in on day {r.day} after first seen.
              </p>
            </div>
          </Card>
        ))}
      </div>
      {!any ? (
        <p className="mt-2 text-xs text-[#a3a3a3]">
          These rates need installs old enough to have reached each return day.
        </p>
      ) : null}
    </div>
  );
}

function weekLabel(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

// Hand-rolled cohort grid (deliberately not a chart-lib heatmap): rows =
// weekly cohorts, columns W0..W11, cell background scales white → brand ink
// with the retention fraction. Small fleet — the % is printed in the cell, no
// tooltips.
function CohortGrid(props: { growth: Growth | null }) {
  const cohorts = props.growth?.weekly_cohorts ?? [];
  if (props.growth === null || cohorts.length === 0 || !cohorts.some((c) => c.size > 0)) {
    return (
      <Card title="Weekly cohorts" sub="retention by install week">
        <p className="py-8 text-center text-sm text-[#737373]">
          {props.growth === null
            ? "Weekly retention is currently unavailable."
            : "No installs were recorded in the last 12 install weeks."}
        </p>
      </Card>
    );
  }
  const maxWeeks = 12;
  return (
    <Card
      title="Weekly cohorts"
      sub="Share of each install cohort that checked in during a later week"
    >
      <p className="mb-2 text-xs text-[#737373] sm:hidden">Scroll across to see all weeks.</p>
      <div
        className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#171717]"
        tabIndex={0}
        role="region"
        aria-label="Weekly retention table; scroll horizontally for later weeks"
      >
        <table
          className="w-full min-w-[720px] border-separate text-xs"
          style={{ borderSpacing: 3 }}
        >
          <thead>
            <tr className="text-[#a3a3a3]">
              <th className="py-2 pr-2 text-left font-medium">Install week</th>
              <th className="py-2 pr-3 text-right font-medium">Installs</th>
              {Array.from({ length: maxWeeks }).map((_, i) => (
                <th key={i} className="w-11 py-1 text-center font-medium">
                  W{i}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {cohorts.map((cRow) => (
              <tr key={cRow.week}>
                <td className="whitespace-nowrap py-2 pr-2 font-sans text-[#525252]">
                  {weekLabel(cRow.week)}
                </td>
                <td className="py-0.5 pr-3 text-right text-[#171717]">{fmtInt(cRow.size)}</td>
                {Array.from({ length: maxWeeks }).map((_, i) => {
                  const retained = cRow.retained?.[i];
                  // Cells beyond the cohort's elapsed weeks are the future —
                  // blank, not 0% (a cohort can't have churned from a week
                  // that hasn't happened).
                  if (retained === undefined) return <td key={i} aria-label="Future week" />;
                  if (cRow.size === 0)
                    return (
                      <td
                        key={i}
                        className="text-center text-[#a3a3a3]"
                        title="No installs in this cohort"
                      >
                        —
                      </td>
                    );
                  const frac = cRow.size > 0 ? retained / cRow.size : 0;
                  return (
                    <td
                      key={i}
                      className="rounded py-2 text-center"
                      title={`${retained} of ${cRow.size} installs checked in during week ${i}`}
                      style={{
                        // White → brand ink; text flips to white past ~45%.
                        background: `rgba(16, 24, 40, ${(frac * 0.92).toFixed(3)})`,
                        color: frac > 0.45 ? "#ffffff" : "#171717",
                      }}
                    >
                      {Math.round(frac * 100)}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[#737373]">
        W0 is the install week; W1 is the following week. Weeks start Monday in the reporting
        calendar. The current week is incomplete. Blank cells are future weeks; a dash means no
        installs in that cohort.
      </p>
    </Card>
  );
}
