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
        description="Website reach, install activation, and the languages people use."
        action={
          <a href="#campaigns" className="text-sm font-medium text-[#0c745a] hover:underline">
            View campaigns →
          </a>
        }
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
    { label: "Installs", n: s.installs_total },
    { label: "Onboarded", n: s.onboarded },
    { label: "Made an entry", n: s.with_entries },
    { label: "Sent a share", n: s.with_shares },
    { label: "Used a feature in 7 days", n: s.active_7d },
  ];
  const max = Math.max(1, ...stages.map((st) => st.n));
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[0.8fr_1.2fr]">
      <Card title="Website reach" sub="All-time recorded traffic">
        <div className="grid grid-cols-2 gap-5 py-2">
          {[{ label: "Web visits", n: s.visits }, clickStage].map((item) => (
            <div key={item.label}>
              <p className="text-3xl font-semibold tabular-nums text-[#101828]">{fmtInt(item.n)}</p>
              <p className="mt-1 text-sm text-[#667085]">{item.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 border-t border-[#eaecf0] pt-4 text-xs leading-relaxed text-[#667085]">
          Repeat visits from the same browser and network count once per hour. Website traffic and
          app installs are separate totals, not a matched conversion funnel.
        </p>
        <dl className="mt-4 space-y-2 text-xs text-[#667085]">
          <div className="flex justify-between gap-3">
            <dt>Raw visits</dt>
            <dd className="tabular-nums">{fmtInt(s.raw_visits)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Bot / operator web hits excluded</dt>
            <dd className="tabular-nums">{fmtInt(s.excluded_visits)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Operator installs excluded</dt>
            <dd className="tabular-nums">{fmtInt(s.excluded_installs)}</dd>
          </div>
        </dl>
      </Card>
      <Card title="Install activation" sub="Count and share of all installs">
        {s.installs_total === 0 ? (
          <p className="py-12 text-center text-sm text-[#667085]">
            Activation will appear after the first app check-in.
          </p>
        ) : (
          <div className="space-y-4">
            {stages.map((st) => (
              <div key={st.label}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#475467]">{st.label}</span>
                  <span className="shrink-0 font-medium tabular-nums text-[#101828]">
                    {fmtInt(st.n)}{" "}
                    <span className="ml-2 text-xs font-normal text-[#667085]">
                      {fmtPct(st.n, s.installs_total)}
                    </span>
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#f2f4f7]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(st.n / max) * 100}%`, background: C.ink }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-[#667085]">
          Feature use means creating an entry, adding a contact, or sharing. The 7-day value is a
          rolling usage window; other values are all-time.
        </p>
      </Card>
    </div>
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
    <Card title="App language" sub="Latest reported language across installs">
      {total === 0 ? (
        <p className="py-6 text-center text-sm text-[#667085]">
          Language data will appear when devices check in.
        </p>
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
