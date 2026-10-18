import { AreaChart, BarChart, Metric, ProgressBar, Text, type Color } from "@tremor/react";
import { format, parseISO } from "date-fns";
import { useState } from "react";
import { useGrowth, useStats, type Growth, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";
import { WeeklyGrowthCard } from "./WeeklyGrowthCard";
import { ActivityInsights, RecentInstalls, type ActivityView } from "./ActivityInsights";

export function Overview() {
  const [days, setDays] = useState(30);
  const [hours, setHours] = useState(168);
  const [activityView, setActivityView] = useState<ActivityView>("day");
  const stats = useStats(
    activityView === "day" ? days : hours,
    activityView === "day" ? "day" : "hour",
  );
  const growth = useGrowth();
  return (
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Overview"
        description="Who is using Kaata, how often they return, and what they use."
      />
      {stats.isPending ? (
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} className={i === 0 ? "col-span-2 lg:col-span-1" : ""} />
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
      <div className="mt-4 min-w-0 sm:mt-5">
        {growth.isPending ? (
          <SkeletonCard lines={5} />
        ) : growth.isError ? (
          <ErrorCard
            message="Weekly growth couldn't be loaded."
            onRetry={() => void growth.refetch()}
          />
        ) : (
          <WeeklyGrowthCard growth={growth.data} />
        )}
      </div>
      <div className="mt-4 min-w-0 sm:mt-5">
        <ActivityInsights
          stats={stats.data}
          view={activityView}
          range={activityView === "day" ? days : hours}
          pending={stats.isPending}
          error={stats.isError}
          fetching={stats.isFetching}
          onView={(view) => {
            if (view === "profile" && hours === 24) setHours(168);
            setActivityView(view);
          }}
          onRange={(points) => (activityView === "day" ? setDays(points) : setHours(points))}
          onRetry={() => void stats.refetch()}
          dailyChart={stats.data ? <ActivityChart stats={stats.data} /> : null}
        />
      </div>
      {stats.data ? (
        <div className="mt-4 min-w-0 sm:mt-5">
          <RecentInstalls stats={stats.data} />
        </div>
      ) : null}
      <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:mt-5 sm:gap-5 xl:grid-cols-2">
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
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-5">
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
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
        Activity counts distinct app installs that checked in, including people who only opened the
        app. Each install counts once per period. Operator and test devices are left out.
      </p>
    </div>
  );
}

function Kpi(props: { label: string; value: string; sub: string; headline?: boolean }) {
  return (
    <Card className={`min-w-0 ${props.headline ? "col-span-2 lg:col-span-1" : ""}`}>
      <Text className="text-xs font-medium text-brand-sub">{props.label}</Text>
      <Metric className="mt-1.5 break-words text-2xl tabular-nums text-brand-ink [overflow-wrap:anywhere] sm:mt-2 sm:text-3xl">
        {props.value}
      </Metric>
      <p className="mt-1.5 text-xs leading-5 text-brand-sub sm:mt-2">{props.sub}</p>
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
    <div className="min-w-0 max-w-full">
      {!hasData ? (
        <div className="flex min-h-44 flex-col items-center justify-center gap-2 py-5 text-center sm:min-h-64">
          <p className="text-sm font-medium text-brand-sub">No activity in these {s.points} days</p>
          <p className="text-xs text-brand-sub">
            {s.points < 90
              ? "Choose a longer range to look for earlier activity."
              : "Activity appears here when an install checks in."}
          </p>
        </div>
      ) : (
        <AreaChart
          className="h-56 min-w-0 max-w-full sm:h-64"
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
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
        Today is still in progress. Its active-device count matches Active today above; daily counts
        do not add up to unique weekly or monthly devices.
        {s.activity_timezone_since
          ? ` Dates before ${s.activity_timezone_since} keep their original UTC history; later days use Kabul.`
          : " Earlier date-only history may use UTC boundaries."}
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
        <div className="flex min-h-40 items-center justify-center px-2 py-5 text-center text-sm text-brand-sub sm:min-h-56 sm:px-5">
          {growth === null
            ? "Weekly activity is currently unavailable."
            : "Completed weekly activity will appear here as devices check in."}
        </div>
      ) : (
        <BarChart
          className="h-56 min-w-0 max-w-full"
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
      <p className="mt-3 text-xs leading-relaxed text-brand-sub">
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
        <p className="py-8 text-center text-sm text-brand-sub sm:py-12">
          Feature usage is currently unavailable.
        </p>
      ) : (
        <div className="min-w-0 space-y-4 sm:space-y-5">
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
          <div className="grid min-w-0 grid-cols-2 gap-3 border-t border-brand-border pt-4 sm:gap-5">
            <div className="min-w-0">
              <p className="break-words text-2xl font-semibold tabular-nums text-brand-ink [overflow-wrap:anywhere]">
                {fmtInt(a.multi_member)}
              </p>
              <p className="mt-1 text-xs leading-5 text-brand-sub">Accounts in shared kaatas</p>
            </div>
            <div className="min-w-0">
              <p className="break-words text-2xl font-semibold tabular-nums text-brand-ink [overflow-wrap:anywhere]">
                {fmtInt(a.with_settlements)}
              </p>
              <p className="mt-1 text-xs leading-5 text-brand-sub">Kaatas using settle-up</p>
            </div>
          </div>
          <a
            href="#users?view=onboarding"
            className="inline-flex min-h-11 max-w-full items-center gap-2 text-xs font-medium text-brand-ink hover:underline"
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
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
        <span className="min-w-0 text-brand-sub">{label}</span>
        <span className="min-w-0 break-words font-medium tabular-nums text-brand-ink [overflow-wrap:anywhere]">
          {fmtInt(n)}{" "}
          <span className="ml-1 text-xs font-normal text-brand-sub">
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
