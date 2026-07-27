// Overview — the "how is kaata doing this week" page. KPI strip (WAU is the
// headline), growth accounting (new/resurrected/retained above the axis,
// churned below), the daily activity series, and adoption depth.

import { format, parseISO } from "date-fns";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useGrowth, useStats, type Growth, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, ProportionRow, SkeletonCard, fmtInt, fmtPct } from "./ui";

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
    <div className="rounded-xl border border-[#eaecf0] bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-[#98a2b3]">
        {props.label}
      </div>
      <div
        className={`mt-1 font-semibold tabular-nums text-[#101828] ${
          props.headline ? "text-3xl" : "text-2xl"
        }`}
      >
        {props.value}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-[#98a2b3]">
        {props.sub}
        {props.delta !== undefined && props.delta !== 0 ? (
          <span
            className="tabular-nums font-medium"
            style={{ color: props.delta > 0 ? "#006300" : C.red }}
          >
            {props.delta > 0 ? "+" : ""}
            {props.delta} vs prev day
          </span>
        ) : null}
      </div>
    </div>
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

const GA_SERIES = [
  { key: "retained", label: "Retained", color: C.blue },
  { key: "new", label: "New", color: C.green },
  { key: "resurrected", label: "Resurrected", color: C.teal },
  { key: "churned", label: "Churned", color: C.red },
] as const;

function GrowthAccountingCard(props: { growth: Growth | null }) {
  const ga = props.growth?.growth_accounting ?? [];
  if (props.growth === null || ga.length === 0) {
    return (
      <Card title="Growth accounting" sub="weekly new / retained / resurrected / churned installs">
        <div className="flex h-[220px] items-center justify-center px-6 text-center text-xs text-[#98a2b3]">
          {props.growth === null
            ? "The /v1/admin/growth endpoint isn't deployed yet — this fills in once it ships."
            : "No weekly activity yet."}
        </div>
      </Card>
    );
  }
  // Churned plots as a negative bar below the axis; the tooltip un-negates it.
  const data = ga.map((w) => ({
    week: weekLabel(w.week),
    retained: w.retained,
    new: w.new,
    resurrected: w.resurrected,
    churned: -w.churned,
  }));
  // Quick Ratio for the latest COMPLETE week — the last row is the in-progress
  // week (its churn can't be known yet), so read one back when possible.
  const qr = ga.length >= 2 ? ga[ga.length - 2] : ga[ga.length - 1];
  const quickRatio = qr.churned === 0 ? "∞" : ((qr.new + qr.resurrected) / qr.churned).toFixed(1);
  return (
    <Card title="Growth accounting" sub="weekly new / retained / resurrected / churned installs">
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart
          data={data}
          margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
          barCategoryGap="25%"
        >
          <CartesianGrid strokeDasharray="3 3" stroke={C.hair} vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 10, fill: C.mut }} minTickGap={16} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: C.mut }} width={28} />
          <ReferenceLine y={0} stroke={C.mut} />
          <Tooltip
            contentStyle={{ fontSize: 12, borderColor: C.line, borderRadius: 8 }}
            formatter={(value, name) => [
              // Show churn as the positive count it is; the sign is the chart's.
              Math.abs(Number(value)).toLocaleString(),
              String(name),
            ]}
          />
          {GA_SERIES.map((sSpec) => (
            <Bar
              key={sSpec.key}
              dataKey={sSpec.key}
              name={sSpec.label}
              stackId="a"
              fill={sSpec.color}
              // White hairline = the 2px spacer between stacked segments.
              stroke="#ffffff"
              strokeWidth={1}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#475467]">
        {GA_SERIES.map((sSpec) => (
          <span key={sSpec.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: sSpec.color }} />
            {sSpec.label}
          </span>
        ))}
        <span className="ml-auto tabular-nums text-[#101828]">
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
  return (
    <Card title="Activity" sub="daily active devices (area) and new installs (bars), last 30 days">
      {!hasData ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-[#98a2b3]">
          No activity in this window.
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={s.series} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.hair} vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={(t: string) => t.slice(5)}
                tick={{ fontSize: 10, fill: C.mut }}
                minTickGap={28}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: C.mut }} width={28} />
              <Tooltip contentStyle={{ fontSize: 12, borderColor: C.line, borderRadius: 8 }} />
              <Bar dataKey="installs" name="Installs" fill={C.gray} />
              <Area
                type="monotone"
                dataKey="active"
                name="Active"
                stroke={C.blue}
                strokeWidth={2}
                fill={C.blue}
                fillOpacity={0.1}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <div className="mt-3 flex items-center gap-4 text-xs text-[#475467]">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.blue }} />
              Active devices
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.gray }} />
              New installs
            </span>
          </div>
        </>
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
        <div>
          <ProportionRow label="Signed in" n={a.signed_in} total={total} color={C.blue} />
          <ProportionRow
            label="Multi-member kaatas"
            n={a.multi_member}
            total={total}
            color={C.teal}
          />
          <ProportionRow label="Sent a share" n={a.with_shares} total={total} color={C.green} />
          <ProportionRow
            label="Used settle-up"
            n={a.with_settlements}
            total={total}
            color={C.ink}
          />
        </div>
      )}
    </Card>
  );
}
