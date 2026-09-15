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
    <div className="min-w-0 max-w-full">
      <PageHeader
        title="Acquisition"
        description="Website reach, install activation, and the languages people use."
      />
      {stats.isPending ? (
        <div className="flex min-w-0 flex-col gap-4">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={2} />
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load acquisition data." onRetry={() => void stats.refetch()} />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
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
    <div className="grid min-w-0 grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <Card title="Website reach" sub="All-time recorded traffic">
        <div className="grid min-w-0 grid-cols-2 gap-3 py-1 sm:gap-5 sm:py-2">
          {[{ label: "Web visits", n: s.visits }, clickStage].map((item) => (
            <div key={item.label} className="min-w-0">
              <p className="break-words text-2xl font-semibold tabular-nums text-[#171717] [overflow-wrap:anywhere] sm:text-3xl">
                {fmtInt(item.n)}
              </p>
              <p className="mt-1 text-sm text-[#737373]">{item.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-5 border-t border-[#e5e5e5] pt-4 text-xs leading-relaxed text-[#737373]">
          Repeat visits from the same browser and network count once per hour. Website traffic and
          app installs are separate totals, not a matched conversion funnel.
        </p>
        <dl className="mt-4 space-y-2 text-xs text-[#737373]">
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="min-w-0">Raw visits</dt>
            <dd className="min-w-0 break-words tabular-nums [overflow-wrap:anywhere]">
              {fmtInt(s.raw_visits)}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="min-w-0">Bot / operator web hits excluded</dt>
            <dd className="min-w-0 break-words tabular-nums [overflow-wrap:anywhere]">
              {fmtInt(s.excluded_visits)}
            </dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
            <dt className="min-w-0">Operator installs excluded</dt>
            <dd className="min-w-0 break-words tabular-nums [overflow-wrap:anywhere]">
              {fmtInt(s.excluded_installs)}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title="Install activation" sub="Count and share of all installs">
        {s.installs_total === 0 ? (
          <p className="py-8 text-center text-sm text-[#737373] sm:py-12">
            Activation will appear after the first app check-in.
          </p>
        ) : (
          <div className="space-y-4">
            {stages.map((st) => (
              <div key={st.label}>
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0 text-[#525252]">{st.label}</span>
                  <span className="min-w-0 break-words font-medium tabular-nums text-[#171717] [overflow-wrap:anywhere]">
                    {fmtInt(st.n)}{" "}
                    <span className="ml-2 text-xs font-normal text-[#737373]">
                      {fmtPct(st.n, s.installs_total)}
                    </span>
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#f5f5f5]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(st.n / max) * 100}%`, background: C.ink }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-[#737373]">
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
        <p className="py-6 text-center text-sm text-[#737373]">
          Language data will appear when devices check in.
        </p>
      ) : (
        <div className="min-w-0">
          {/* Same runtime-vs-typing lag as the charts: CategoryBar accepts any
              CSS color at runtime but types only the named palette. */}
          <CategoryBar
            values={langs.map((l) => l.count)}
            colors={langs.map((l) => (LANG_META[l.locale] ?? LANG_META.unknown).color) as Color[]}
            showLabels={false}
          />
          <div className="mt-3 flex min-w-0 flex-wrap gap-x-5 gap-y-2 text-sm">
            {langs.map((l) => {
              const meta = LANG_META[l.locale] ?? { label: l.locale, color: C.gray };
              return (
                <span
                  key={l.locale}
                  className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: meta.color }}
                  />
                  <span className="min-w-0 break-words font-medium text-[#171717] [overflow-wrap:anywhere]">
                    {meta.label}
                  </span>
                  <span className="min-w-0 break-words tabular-nums text-[#a3a3a3] [overflow-wrap:anywhere]">
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
