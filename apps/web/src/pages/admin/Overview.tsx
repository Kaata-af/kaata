import { AreaChart, BarChart, Metric, ProgressBar, Text, type Color } from "@tremor/react";
import { format, parseISO } from "date-fns";
import { useState } from "react";
import { useGrowth, useStats, type Growth, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";

export function Overview() {
  const [days, setDays] = useState(30);
  const stats = useStats(days);
  const growth = useGrowth();
  return (
    <div>
      <PageHeader
        title="Overview"
        description="Who is using Kaata, how often they return, and what they use."
        action={
          <a
            href="#users?view=follow-up"
            className="inline-flex items-center gap-2 rounded-lg border border-[#d0d5dd] bg-white px-3.5 py-2 text-sm font-medium text-[#344054] hover:border-[#0c745a] hover:text-[#0c745a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0c745a]"
          >
            Review follow-ups <span aria-hidden="true">→</span>
          </a>
        }
      />
      {stats.isPending ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : stats.isError ? (
        <ErrorCard
          message="Engagement data couldn't be loaded. Try again to refresh these numbers."
          onRetry={() => void stats.refetch()}
        />
      ) : (
        <KpiStrip stats={stats.data} />
      )}
      <div className="mt-5">
        <Card
          title="Daily activity"
          sub={`Active devices and new installs · last ${stats.data?.points ?? days} days, including today`}
          action={
            <div className="flex items-center gap-3">
              {stats.isFetching && !stats.isPending ? (
                <span role="status" className="text-xs text-[#667085]">
                  Updating…
                </span>
              ) : null}
              <div
                className="inline-flex rounded-lg border border-[#eaecf0] bg-[#f9fafb] p-1"
                role="group"
                aria-label="Activity date range"
              >
                {[7, 30, 90].map((range) => (
                  <button
                    key={range}
                    type="button"
                    aria-pressed={days === range}
                    onClick={() => setDays(range)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#0c745a] ${days === range ? "bg-white text-[#0c745a] shadow-sm" : "text-[#667085] hover:text-[#101828]"}`}
                  >
                    {range} days
                  </button>
                ))}
              </div>
            </div>
          }
        >
          {stats.isPending ? (
            <div className="h-64 animate-pulse rounded-lg bg-[#f2f4f7]" />
          ) : stats.isError ? (
            <ErrorCard
              message="The activity chart couldn't be loaded."
              onRetry={() => void stats.refetch()}
            />
          ) : (
            <ActivityChart stats={stats.data} />
          )}
        </Card>
      </div>
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        {growth.isPending ? (
          <SkeletonCard lines={6} />
        ) : growth.isError ? (
          <ErrorCard
            message="Weekly activity couldn't be loaded."
            onRetry={() => void growth.refetch()}
          />
        ) : (
          <GrowthAccountingCard growth={growth.data} />
        )}
        {growth.isPending || stats.isPending ? (
          <SkeletonCard lines={6} />
        ) : growth.isError || stats.isError ? (
          <ErrorCard
            message="Feature usage couldn't be loaded."
            onRetry={() => {
              void growth.refetch();
              void stats.refetch();
            }}
          />
        ) : (
          <AdoptionCard growth={growth.data} stats={stats.data} />
        )}
      </div>
    </div>
  );
}

function KpiStrip({ stats: s }: { stats: Stats }) {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Active today" value={fmtInt(s.dau)} sub="DAU · since Kabul midnight" headline />
        <Kpi label="Active · 7 days" value={fmtInt(s.wau)} sub="WAU · today + previous 6 days" />
        <Kpi label="Active · 30 days" value={fmtInt(s.mau)} sub="MAU · today + previous 29 days" />
        <Kpi
          label="Daily share of MAU"
          value={fmtPct(s.dau, s.mau)}
          sub="Active today ÷ active in 30 days"
        />
        <Kpi label="Total entries" value={fmtInt(s.entries_sum)} sub="All-time reported entries" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[#667085]">
        Activity counts distinct app installs that checked in, including people who only opened the
        app. Each install counts once per period.
      </p>
    </div>
  );
}

function Kpi(props: { label: string; value: string; sub: string; headline?: boolean }) {
  return (
    <Card className={`p-4 ${props.headline ? "border-[#b7d9cc]" : ""}`}>
      <Text className="text-xs font-medium text-[#667085]">{props.label}</Text>
      <Metric
        className={`mt-2 text-3xl tabular-nums ${props.headline ? "text-[#0c745a]" : "text-[#101828]"}`}
      >
        {props.value}
      </Metric>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{props.sub}</p>
    </Card>
  );
}

function dateLabel(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

function ActivityChart({ stats: s }: { stats: Stats }) {
  const hasData = s.series.some((p) => p.active > 0 || p.installs > 0);
  const data = s.series.map((p) => ({
    date: dateLabel(p.t),
    "Active devices": p.active,
    "New installs": p.installs,
  }));
  return (
    <div>
      {!hasData ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm font-medium text-[#344054]">No activity in these {s.points} days</p>
          <p className="text-xs text-[#667085]">
            {s.points < 90
              ? "Choose a longer range to look for earlier activity."
              : "Activity appears here when an install checks in."}
          </p>
        </div>
      ) : (
        <AreaChart
          className="h-64"
          data={data}
          index="date"
          categories={["Active devices", "New installs"]}
          colors={[C.blue, C.teal]}
          curveType="monotone"
          allowDecimals={false}
          valueFormatter={(v) => v.toLocaleString()}
          yAxisWidth={44}
          showAnimation={false}
        />
      )}
      <p className="mt-3 text-xs leading-relaxed text-[#667085]">
        Today is still in progress. Its active-device count matches Active today above; daily counts
        do not add up to unique weekly or monthly devices.
      </p>
    </div>
  );
}

function GrowthAccountingCard({ growth }: { growth: Growth | null }) {
  // Current-week churn is undecided; compare only completed reporting weeks.
  const weeks = growth?.growth_accounting.slice(0, -1) ?? [];
  const hasData = weeks.some((w) => w.new + w.retained + w.resurrected + w.churned > 0);
  const data = weeks.map((w) => ({
    week: dateLabel(w.week),
    Retained: w.retained,
    New: w.new,
    Reactivated: w.resurrected,
    Churned: -w.churned,
  }));
  return (
    <Card
      title="Weekly activity"
      sub={`New, returning, and inactive installs · ${weeks.length || 11} completed weeks`}
    >
      {!hasData ? (
        <div className="flex h-56 items-center justify-center px-5 text-center text-sm text-[#667085]">
          {growth === null
            ? "Weekly activity is currently unavailable."
            : "Completed weekly activity will appear here as devices check in."}
        </div>
      ) : (
        <BarChart
          className="h-56"
          data={data}
          index="week"
          categories={["Retained", "New", "Reactivated", "Churned"]}
          colors={[C.blue, C.green, C.teal, C.red]}
          stack
          autoMinValue
          allowDecimals={false}
          valueFormatter={(v) => Math.abs(v).toLocaleString()}
          yAxisWidth={44}
          showAnimation={false}
        />
      )}
      <p className="mt-3 text-xs leading-relaxed text-[#667085]">
        Retained: active in consecutive weeks. Reactivated: returned after a gap. Churned: active
        the week before, then absent. The current week is excluded.
      </p>
    </Card>
  );
}

function AdoptionCard({ growth, stats }: { growth: Growth | null; stats: Stats }) {
  const a = growth?.adoption;
  return (
    <Card title="Feature usage" sub={`Reported across ${fmtInt(stats.installs_total)} installs`}>
      {!a ? (
        <p className="py-12 text-center text-sm text-[#667085]">
          Feature usage is currently unavailable.
        </p>
      ) : (
        <div className="space-y-5">
          <AdoptionRow
            label="Signed in"
            n={a.signed_in}
            total={stats.installs_total}
            color={C.blue}
          />
          <AdoptionRow
            label="Sent a share"
            n={a.with_shares}
            total={stats.installs_total}
            color={C.green}
          />
          <div className="grid grid-cols-2 gap-5 border-t border-[#eaecf0] pt-4">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-[#101828]">
                {fmtInt(a.multi_member)}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">Accounts in shared kaatas</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-[#101828]">
                {fmtInt(a.with_settlements)}
              </p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">Kaatas using settle-up</p>
            </div>
          </div>
          <a
            href="#users?view=onboarding"
            className="inline-flex items-center gap-2 text-xs font-medium text-[#0c745a] hover:underline"
          >
            Review unfinished onboarding <span aria-hidden="true">→</span>
          </a>
        </div>
      )}
    </Card>
  );
}

function AdoptionRow({
  label,
  n,
  total,
  color,
}: {
  label: string;
  n: number;
  total: number;
  color: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-sm">
        <span className="text-[#344054]">{label}</span>
        <span className="font-medium tabular-nums text-[#101828]">
          {fmtInt(n)}{" "}
          <span className="ml-1 text-xs font-normal text-[#667085]">
            installs · {fmtPct(n, total)}
          </span>
        </span>
      </div>
      <ProgressBar
        value={total > 0 ? Math.min(100, (n / total) * 100) : 0}
        color={color as Color}
      />
    </div>
  );
}
