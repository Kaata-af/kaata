// Acquisition — where installs come from: the web→app funnel, per-source
// attribution, and the language split. Everything derives from /v1/admin/stats
// (honest deduped web numbers; raw + excluded counts footnoted).

import { useStats, type Stats } from "./api";
import { C, Card, ErrorCard, PageHeader, SkeletonCard, fmtInt, fmtPct } from "./ui";

export function Acquisition() {
  const stats = useStats();
  return (
    <div>
      <PageHeader
        title="Acquisition"
        description="From a kaata.af visit to an active install — and which sources drive it."
      />
      {stats.isPending ? (
        <div className="flex flex-col gap-4">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={2} />
        </div>
      ) : stats.isError ? (
        <ErrorCard message="Couldn't load acquisition data." onRetry={() => void stats.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <FunnelCard stats={stats.data} />
          <SourcesCard stats={stats.data} />
          <LanguageCard stats={stats.data} />
        </div>
      )}
    </div>
  );
}

function FunnelCard(props: { stats: Stats }) {
  const s = props.stats;
  const stages = [
    { label: "Web visits", n: s.visits },
    { label: "Downloads", n: s.downloads },
    { label: "Installs", n: s.installs_total },
    { label: "Onboarded", n: s.onboarded },
    { label: "Made an entry", n: s.with_entries },
    { label: "Active (7d)", n: s.active_7d },
  ];
  // Widths scale against the widest stage (usually visits — but installs can
  // legitimately exceed visits when people sideload-share the APK directly).
  const max = Math.max(1, ...stages.map((st) => st.n));
  return (
    <Card title="Funnel" sub="each stage as absolute count + conversion from the previous stage">
      <div className="flex flex-col gap-2">
        {stages.map((st, i) => (
          <div key={st.label} className="flex items-center gap-3">
            <div className="w-32 shrink-0 text-sm text-[#475467]">{st.label}</div>
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

function SourcesCard(props: { stats: Stats }) {
  // Sorted by attributed installs — the number that actually matters.
  const rows = [...props.stats.by_source].sort((a, b) => b.attributed - a.attributed);
  return (
    <Card title="Sources" sub="deduped web traffic and QR/IP-attributed installs per source">
      {rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-[#98a2b3]">No web visits recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#eaecf0] text-left text-xs text-[#98a2b3]">
                <th className="py-2 font-medium">Source</th>
                <th className="py-2 text-right font-medium">Visits</th>
                <th className="py-2 text-right font-medium">Downloads</th>
                <th className="py-2 text-right font-medium">Installs</th>
                <th className="py-2 text-right font-medium">Visit → install</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.source} className="border-b border-[#f2f4f7] last:border-0">
                  <td className="py-2 font-medium text-[#101828]">{r.source}</td>
                  <td className="py-2 text-right tabular-nums text-[#475467]">
                    {fmtInt(r.visits)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-[#475467]">
                    {fmtInt(r.downloads)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-[#101828]">
                    {fmtInt(r.attributed)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-[#98a2b3]">
                    {fmtPct(r.attributed, r.visits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
          {/* Single proportion bar; 2px white gaps separate the segments. */}
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-[#f2f4f7]">
            {langs.map((l) => (
              <div
                key={l.locale}
                style={{
                  width: `${(l.count / total) * 100}%`,
                  background: (LANG_META[l.locale] ?? LANG_META.unknown).color,
                }}
              />
            ))}
          </div>
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
