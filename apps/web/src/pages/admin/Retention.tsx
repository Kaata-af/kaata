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
    <div>
      <PageHeader
        title="Retention"
        description="How often people return after their first check-in."
        action={
          <a
            href="#users?view=follow-up"
            className="text-sm font-medium text-[#0c745a] hover:underline"
          >
            Review follow-ups →
          </a>
        }
      />
      {stats.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load retention." onRetry={() => void stats.refetch()} />
      ) : (
        <DayNCards stats={stats.data} />
      )}

      <div className="mt-4">
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
    <div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {rows.map((r) => (
          <Card key={r.label} className="p-4">
            <Text className="text-xs font-medium text-[#667085]">{r.label}</Text>
            <Metric className="mt-1 tabular-nums">
              {r.elig ? `${Math.round((r.ret / r.elig) * 100)}%` : "—"}
            </Metric>
            <Text className="mt-0.5 text-xs tabular-nums text-tremor-content-subtle">
              {r.elig
                ? `${fmtInt(r.ret)} of ${fmtInt(r.elig)} eligible installs`
                : "No eligible installs yet"}
            </Text>
            <p className="mt-3 text-xs leading-5 text-[#667085]">
              Checked in on day {r.day} after first seen.
            </p>
          </Card>
        ))}
      </div>
      {!any ? (
        <p className="mt-2 text-xs text-[#98a2b3]">
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
        <p className="py-8 text-center text-sm text-[#667085]">
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
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[720px] border-separate text-xs"
          style={{ borderSpacing: 3 }}
        >
          <thead>
            <tr className="text-[#98a2b3]">
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
                <td className="whitespace-nowrap py-2 pr-2 font-sans text-[#475467]">
                  {weekLabel(cRow.week)}
                </td>
                <td className="py-0.5 pr-3 text-right text-[#101828]">{fmtInt(cRow.size)}</td>
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
                        className="text-center text-[#98a2b3]"
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
                        color: frac > 0.45 ? "#ffffff" : "#101828",
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
      <p className="mt-3 text-xs leading-relaxed text-[#667085]">
        W0 is the install week; W1 is the following week. Weeks start Monday in the reporting
        calendar. The current week is incomplete. Blank cells are future weeks; a dash means no
        installs in that cohort.
      </p>
    </Card>
  );
}
