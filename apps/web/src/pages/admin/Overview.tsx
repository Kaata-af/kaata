// Overview — the "how is kaata doing this week" page. KPI strip (WAU is the
// headline), growth accounting (new/resurrected/retained above the axis,
// churned below), the daily activity series, and adoption depth.
//
// Charts are Tremor's (wrapping its own recharts@2) — their built-in
// yAxisWidth reserves real space for tick labels, which fixes the clipped
// Y-axis the hand-tuned recharts margins used to cause.

import {
  AreaChart,
  BadgeDelta,
  BarChart,
  Metric,
  ProgressBar,
  Text,
  type Color,
} from "@tremor/react";
import { format, parseISO } from "date-fns";
import { useGrowth, useStats, type Growth, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";

export function Overview() {
  const stats = useStats();
  const growth = useGrowth();

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Weekly health at a glance — engagement, growth accounting, and adoption depth."
      />
      {stats.isPending ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonCard key={i} lines={2} />
          ))}
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load stats." onRetry={() => void stats.refetch()} />
      ) : (
        <KpiStrip stats={stats.data} />
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        {growth.isPending ? (
          <SkeletonCard lines={6} />
        ) : growth.isError ? (
          <ErrorCard
            message="Couldn't load growth accounting."
            onRetry={() => void growth.refetch()}
          />
        ) : (
          <GrowthAccountingCard growth={growth.data} />
        )}

        {stats.isPending ? (
          <SkeletonCard lines={6} />
        ) : stats.isError ? (
          <ErrorCard message="Couldn't load activity." onRetry={() => void stats.refetch()} />
        ) : (
          <ActivityCard stats={stats.data} />
        )}
      </div>

      <div className="mt-4">
        {growth.isPending || stats.isPending ? (
          <SkeletonCard lines={4} />
        ) : growth.isError ? (
          <ErrorCard message="Couldn't load adoption." onRetry={() => void growth.refetch()} />
        ) : (
          <AdoptionCard growth={growth.data ?? null} stats={stats.data ?? null} />
        )}
      </div>
    </div>
  );
}

function KpiStrip(props: { stats: Stats }) {
  const s = props.stats;
  // DAU delta vs the previous day, from the same daily series (events-based) so
  // both sides of the comparison share a source. WAU/MAU deltas are NOT
  // computable from a daily distinct-devices series (distincts don't sum), so
  // per the spec they're omitted rather than faked.
  let dauDelta: number | null = null;
  if (s.bucket === "day" && s.series.length >= 2) {
    dauDelta = s.series[s.series.length - 1].active - s.series[s.series.length - 2].active;
  }
  const collecting = s.wau === 0 && s.mau === 0;
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="WAU" value={fmtInt(s.wau)} sub="active last 7 days" headline />
        <Kpi
          label="DAU"
          value={fmtInt(s.dau)}
          sub="active today"
          delta={dauDelta === null ? undefined : dauDelta}
        />
        <Kpi label="MAU" value={fmtInt(s.mau)} sub="active last 30 days" />
        <Kpi label="Stickiness" value={s.mau ? fmtPct(s.dau, s.mau) : "—"} sub="DAU / MAU" />
        <Kpi label="Entries" value={fmtInt(s.entries_sum)} sub="lifetime, all installs" />
      </div>
      {collecting ? (
        <p className="mt-2 text-xs text-[#98a2b3]">
          Engagement accrues from the day per-day tracking deployed — empty until installs check in
          after that.
        </p>
      ) : null}
    </div>
  );
}

function Kpi(props: {
  label: string;
  value: string;
  sub?: string;
  delta?: number;
  headline?: boolean;
}) {
  return (
    <Card className="p-4">
      <Text className="text-xs font-medium uppercase tracking-wide text-tremor-content-subtle">
        {props.label}
      </Text>
      <Metric className={`mt-1 tabular-nums ${props.headline ? "" : "text-2xl"}`}>
        {props.value}
      </Metric>
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <Text className="text-xs text-tremor-content-subtle">{props.sub}</Text>
        {props.delta !== undefined && props.delta !== 0 ? (
          <BadgeDelta
            size="xs"
            deltaType={props.delta > 0 ? "moderateIncrease" : "moderateDecrease"}
          >
            {`${props.delta > 0 ? "+" : ""}${props.delta} vs prev day`}
          </BadgeDelta>
        ) : null}
      </div>
    </Card>
  );
}

// Short "Jun 2" label for week-start dates; tolerate anything unparseable.
function weekLabel(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

function GrowthAccountingCard(props: { growth: Growth | null }) {
  const ga = props.growth?.growth_accounting ?? [];
  if (props.growth === null || ga.length === 0) {
    return (
      <Card title="Growth accounting" sub="weekly new / retained / resurrected / churned installs">
        <div className="flex h-[248px] items-center justify-center px-6 text-center text-xs text-[#98a2b3]">
          {props.growth === null
            ? "The /v1/admin/growth endpoint isn't deployed yet — this fills in once it ships."
            : "No weekly activity yet."}
        </div>
      </Card>
    );
  }
  // Churned plots as a negative bar below the axis; the shared valueFormatter
  // un-negates it in the tooltip (churn is reported as a positive count).
  const data = ga.map((w) => ({
    week: weekLabel(w.week),
    Retained: w.retained,
    New: w.new,
    Resurrected: w.resurrected,
    Churned: -w.churned,
  }));
  // Quick Ratio for the latest COMPLETE week — the last row is the in-progress
  // week (its churn can't be known yet), so read one back when possible.
  const qr = ga.length >= 2 ? ga[ga.length - 2] : ga[ga.length - 1];
  const quickRatio = qr.churned === 0 ? "∞" : ((qr.new + qr.resurrected) / qr.churned).toFixed(1);
  return (
    <Card title="Growth accounting" sub="weekly new / retained / resurrected / churned installs">
      <BarChart
        className="h-56"
        data={data}
        index="week"
        categories={["Retained", "New", "Resurrected", "Churned"]}
        colors={[C.blue, C.green, C.teal, C.red]}
        stack
        autoMinValue
        allowDecimals={false}
        valueFormatter={(v) => Math.abs(v).toLocaleString()}
        yAxisWidth={44}
        showAnimation={false}
      />
      <div className="mt-2 flex justify-end text-xs">
        <span className="tabular-nums text-[#101828]">
          Quick ratio <span className="font-semibold">{quickRatio}</span>
          <span className="ml-1 text-[#98a2b3]">wk of {weekLabel(qr.week)}</span>
        </span>
      </div>
    </Card>
  );
}

function ActivityCard(props: { stats: Stats }) {
  const s = props.stats;
  const hasData = s.series.some((p) => p.active > 0 || p.installs > 0);
  const data = s.series.map((p) => ({
    date: p.t.slice(5),
    "Active devices": p.active,
    "New installs": p.installs,
  }));
  return (
    <Card title="Activity" sub="daily active devices and new installs, last 30 days">
      {!hasData ? (
        <div className="flex h-[248px] items-center justify-center text-xs text-[#98a2b3]">
          No activity in this window.
        </div>
      ) : (
        <AreaChart
          className="h-56"
          data={data}
          index="date"
          categories={["Active devices", "New installs"]}
          colors={[C.blue, C.teal]}
          curveType="monotone"
          autoMinValue
          allowDecimals={false}
          valueFormatter={(v) => v.toLocaleString()}
          yAxisWidth={44}
          showAnimation={false}
        />
      )}
    </Card>
  );
}

function AdoptionCard(props: { growth: Growth | null; stats: Stats | null }) {
  const total = props.stats?.installs_total ?? 0;
  const a = props.growth?.adoption ?? null;
  return (
    <Card title="Adoption" sub={`feature depth across ${fmtInt(total)} installs`}>
      {a === null ? (
        <p className="py-4 text-center text-xs text-[#98a2b3]">
          Adoption metrics arrive with the /v1/admin/growth endpoint — not deployed yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <AdoptionRow label="Signed in" n={a.signed_in} total={total} color={C.blue} />
          <AdoptionRow
            label="Multi-member kaatas"
            n={a.multi_member}
            total={total}
            color={C.teal}
          />
          <AdoptionRow label="Sent a share" n={a.with_shares} total={total} color={C.green} />
          <AdoptionRow label="Used settle-up" n={a.with_settlements} total={total} color={C.ink} />
        </div>
      )}
    </Card>
  );
}

function AdoptionRow(props: { label: string; n: number; total: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <Text className="text-sm text-tremor-content">{props.label}</Text>
        <p className="text-sm tabular-nums text-tremor-content-strong">
          {fmtInt(props.n)}
          <span className="ml-1 text-xs text-tremor-content-subtle">
            {fmtPct(props.n, props.total)}
          </span>
        </p>
      </div>
      {/* Tremor's ProgressBar typing lags its runtime (any CSS color works,
          like the charts' `(Color | string)[]`) — hence the cast. */}
      <ProgressBar
        value={props.total > 0 ? Math.min(100, (props.n / props.total) * 100) : 0}
        color={props.color as Color}
      />
    </div>
  );
}
