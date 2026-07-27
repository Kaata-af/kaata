// Retention — do installs come back? Day-N headline pairs from /v1/admin/stats
// (raw retained/eligible so 0/0 renders "—", never a fake 0%) and the weekly
// cohort grid from /v1/admin/growth.

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
        description="Whether installs come back — day-N pairs and weekly cohorts."
      />
      {stats.isPending ? (
        <div className="grid grid-cols-3 gap-3">
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
    { label: "D1", ret: s.ret_d1_retained, elig: s.ret_d1_eligible },
    { label: "D7", ret: s.ret_d7_retained, elig: s.ret_d7_eligible },
    { label: "D30", ret: s.ret_d30_retained, elig: s.ret_d30_eligible },
  ];
  const any = rows.some((r) => r.elig > 0);
  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded-xl border border-[#eaecf0] bg-white p-4 text-center"
          >
            <div className="text-xs font-medium uppercase tracking-wide text-[#98a2b3]">
              {r.label}
            </div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-[#101828]">
              {r.elig ? `${Math.round((r.ret / r.elig) * 100)}%` : "—"}
            </div>
            <div className="mt-0.5 text-xs tabular-nums text-[#98a2b3]">
              {r.elig ? `${fmtInt(r.ret)} of ${fmtInt(r.elig)}` : "no eligible installs yet"}
            </div>
          </div>
        ))}
      </div>
      {!any ? (
        <p className="mt-2 text-xs text-[#98a2b3]">
          Builds from the day per-day tracking deployed — needs installs old enough to measure.
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

// Hand-rolled cohort grid (no chart lib): rows = weekly cohorts, columns
// W0..W11, cell background scales white → brand ink with the retention
// fraction. Small fleet — the % is printed in the cell, no tooltips.
function CohortGrid(props: { growth: Growth | null }) {
  const cohorts = props.growth?.weekly_cohorts ?? [];
  if (props.growth === null || cohorts.length === 0) {
    return (
      <Card title="Weekly cohorts" sub="retention by install week">
        <p className="py-6 text-center text-xs text-[#98a2b3]">
          {props.growth === null
            ? "The /v1/admin/growth endpoint isn't deployed yet — cohorts fill in once it ships."
            : "No cohorts yet."}
        </p>
      </Card>
    );
  }
  const maxWeeks = 12;
  return (
    <Card
      title="Weekly cohorts"
      sub="% of each install week active again N weeks later (W0 = install week)"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate text-xs" style={{ borderSpacing: 2 }}>
          <thead>
            <tr className="text-[#98a2b3]">
              <th className="py-1 pr-2 text-left font-medium">Cohort</th>
              <th className="py-1 pr-3 text-right font-medium">Size</th>
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
                <td className="whitespace-nowrap py-0.5 pr-2 font-sans text-[#475467]">
                  {weekLabel(cRow.week)}
                </td>
                <td className="py-0.5 pr-3 text-right text-[#101828]">{fmtInt(cRow.size)}</td>
                {Array.from({ length: maxWeeks }).map((_, i) => {
                  const retained = cRow.retained?.[i];
                  // Cells beyond the cohort's elapsed weeks are the future —
                  // blank, not 0% (a cohort can't have churned from a week
                  // that hasn't happened).
                  if (retained === undefined) return <td key={i} />;
                  const frac = cRow.size > 0 ? retained / cRow.size : 0;
                  return (
                    <td
                      key={i}
                      className="rounded py-1 text-center"
                      style={{
                        // White → brand ink; text flips to white past ~45%.
                        background: `rgba(16, 24, 40, ${(frac * 0.92).toFixed(3)})`,
                        color: frac > 0.45 ? "#ffffff" : "#101828",
                      }}
                    >
                      {Math.round(frac * 100)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-[#98a2b3]">
        Cell = % of the cohort with any active day in that week. Last 12 install weeks, oldest
        first.
      </p>
    </Card>
  );
}
