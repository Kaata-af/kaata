// Acquisition — where installs come from: the web→app funnel and the language
// split. Everything derives from /v1/admin/stats (honest deduped web numbers;
// raw + excluded counts footnoted). Per-source campaign performance lives in
// the Campaigns section next to the QR generator.

import { CategoryBar, type Color } from "@tremor/react";
import { useStats, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";

export function Acquisition() {
  const stats = useStats();
  return (
    <div>
      <PageHeader
        title="Acquisition"
        description="From a kaata.af visit to an active install — stage by stage."
      />
      {stats.isPending ? (
        <div className="flex flex-col gap-4">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={2} />
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load acquisition data." onRetry={() => void stats.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <FunnelCard stats={stats.data} />
          <LanguageCard stats={stats.data} />
        </div>
      )}
    </div>
  );
}

function FunnelCard(props: { stats: Stats }) {
  const s = props.stats;
  // Store era: the second stage is store clicks (Play/App Store outbound,
  // deduped like downloads). An older backend that doesn't report
  // `store_clicks` yet gets the honest legacy label for the dead APK-download
  // stage instead of a fake zero.
  const clickStage =
    s.store_clicks !== undefined
      ? { label: "Store clicks", n: s.store_clicks }
      : { label: "APK downloads (legacy)", n: s.downloads };
  const stages = [
    { label: "Web visits", n: s.visits },
    clickStage,
    { label: "Installs", n: s.installs_total },
    { label: "Onboarded", n: s.onboarded },
    { label: "Made an entry", n: s.with_entries },
    { label: "Active (7d)", n: s.active_7d },
  ];
  // Widths scale against the widest stage (usually visits — but installs can
  // legitimately exceed visits when people share the app directly).
  const max = Math.max(1, ...stages.map((st) => st.n));
  return (
    <Card title="Funnel" sub="each stage as absolute count + conversion from the previous stage">
      <div className="flex flex-col gap-2">
        {stages.map((st, i) => (
          <div key={st.label} className="flex items-center gap-3">
            <div className="w-40 shrink-0 text-sm text-[#475467]">{st.label}</div>
            <div className="h-6 flex-1 overflow-hidden rounded bg-[#f2f4f7]">
              <div
                className="h-6 rounded"
                style={{
                  width: `${Math.max(st.n > 0 ? 1.5 : 0, (st.n / max) * 100)}%`,
                  background: C.ink,
                }}
              />
            </div>
            <div className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-[#101828]">
              {fmtInt(st.n)}
            </div>
            <div className="w-14 shrink-0 text-right text-xs tabular-nums text-[#98a2b3]">
              {i === 0 ? "" : fmtPct(st.n, stages[i - 1].n)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-[#98a2b3]">
        Visits deduped per (ip, browser, hour). Raw visits: {fmtInt(s.raw_visits)} · filtered out:{" "}
        {fmtInt(s.excluded_visits)} bot/operator web hits, {fmtInt(s.excluded_installs)}{" "}
        operator/test installs.
      </p>
    </Card>
  );
}

const LANG_META: Record<string, { label: string; color: string }> = {
  fa: { label: "Dari", color: C.green },
  en: { label: "English", color: C.blue },
  unknown: { label: "Unknown", color: C.gray },
};

function LanguageCard(props: { stats: Stats }) {
  const langs = props.stats.languages;
  const total = langs.reduce((sum, l) => sum + l.count, 0);
  return (
    <Card title="Language" sub="installs by in-app language">
      {total === 0 ? (
        <p className="py-4 text-center text-xs text-[#98a2b3]">No data yet.</p>
      ) : (
        <div>
          {/* Same runtime-vs-typing lag as the charts: CategoryBar accepts any
              CSS color at runtime but types only the named palette. */}
          <CategoryBar
            values={langs.map((l) => l.count)}
            colors={langs.map((l) => (LANG_META[l.locale] ?? LANG_META.unknown).color) as Color[]}
            showLabels={false}
          />
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {langs.map((l) => {
              const meta = LANG_META[l.locale] ?? { label: l.locale, color: C.gray };
              return (
                <span key={l.locale} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                  <span className="font-medium text-[#101828]">{meta.label}</span>
                  <span className="tabular-nums text-[#98a2b3]">
                    {fmtInt(l.count)} ({fmtPct(l.count, total)})
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
