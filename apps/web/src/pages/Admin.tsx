// Operator analytics dashboard — /admin (Matee: "make a dashboard that I can check
// the analytics in a better way"). Reads GET /v1/admin/stats (guarded by the
// backend's ADMIN_API_KEY shared secret). Lean: no BI deps, Tailwind cards + a
// table + hand-rolled bars. The key comes from the build-time VITE_ADMIN_API_KEY
// or, failing that, a paste-once login stored in localStorage.

import { useCallback, useEffect, useState } from "react";
import { BACKEND_URL, ADMIN_API_KEY } from "../env";

type DayCount = { day: string; count: number };
type SourceRow = { source: string; visits: number; downloads: number; attributed: number };
type Stats = {
  installs_total: number;
  onboarded: number;
  with_entries: number;
  with_shares: number;
  active: number;
  entries_sum: number;
  customers_sum: number;
  shares_sum: number;
  visits: number;
  downloads: number;
  installs_by_day: DayCount[];
  by_source: SourceRow[];
};

const TOKEN_KEY = "kaata_admin_token";

function pct(n: number, d: number): string {
  if (!d) return "—";
  return Math.round((n / d) * 100) + "%";
}

export function Admin() {
  const [token, setToken] = useState<string>(
    () => localStorage.getItem(TOKEN_KEY) || ADMIN_API_KEY || "",
  );
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/admin/stats`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.status === 401) {
        setError("Wrong admin key.");
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
        return;
      }
      if (!res.ok) {
        setError(`Server error (${res.status}).`);
        return;
      }
      setStats((await res.json()) as Stats);
    } catch {
      setError("Couldn't reach the backend.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  if (!token) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold">Kaata admin</h1>
        <p className="text-sm text-neutral-500">Enter the admin key to view analytics.</p>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Admin key"
          className="rounded-lg border border-neutral-300 px-3 py-2"
          onKeyDown={(e) => {
            if (e.key === "Enter" && input) {
              localStorage.setItem(TOKEN_KEY, input);
              setToken(input);
            }
          }}
        />
        <button
          className="rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          disabled={!input}
          onClick={() => {
            localStorage.setItem(TOKEN_KEY, input);
            setToken(input);
          }}
        >
          View dashboard
        </button>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Kaata analytics</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void load(token)}
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken("");
              setStats(null);
            }}
            className="text-sm text-neutral-400 hover:text-neutral-700"
          >
            Sign out
          </button>
        </div>
      </header>

      {error ? <p className="mb-4 text-sm text-red-600">{error}</p> : null}
      {!stats ? (
        <p className="text-neutral-500">Loading…</p>
      ) : (
        <div className="flex flex-col gap-8">
          {/* Headline cards */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label="Installs" value={stats.installs_total} />
            <Card
              label="Onboarded"
              value={stats.onboarded}
              sub={pct(stats.onboarded, stats.installs_total)}
            />
            <Card
              label="Active"
              value={stats.active}
              sub={pct(stats.active, stats.installs_total)}
            />
            <Card label="Web visits" value={stats.visits} sub={`${stats.downloads} downloads`} />
          </section>

          {/* Funnel */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Funnel
            </h2>
            <div className="flex flex-col gap-2">
              <FunnelBar label="Installed" n={stats.installs_total} total={stats.installs_total} />
              <FunnelBar label="Onboarded" n={stats.onboarded} total={stats.installs_total} />
              <FunnelBar
                label="Made an entry"
                n={stats.with_entries}
                total={stats.installs_total}
              />
              <FunnelBar label="Shared" n={stats.with_shares} total={stats.installs_total} />
              <FunnelBar label="Active" n={stats.active} total={stats.installs_total} />
            </div>
          </section>

          {/* Usage totals */}
          <section className="grid grid-cols-3 gap-3">
            <Card label="Entries created" value={stats.entries_sum} />
            <Card label="Customers added" value={stats.customers_sum} />
            <Card label="Shares sent" value={stats.shares_sum} />
          </section>

          {/* Installs per day */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Installs / day (last 30)
            </h2>
            <DayBars data={[...stats.installs_by_day].reverse()} />
          </section>

          {/* Source attribution */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Web visits by source
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-400">
                  <th className="py-2">Source</th>
                  <th className="py-2 text-right">Visits</th>
                  <th className="py-2 text-right">Downloads</th>
                  <th className="py-2 text-right">Installs</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_source.map((r) => (
                  <tr key={r.source} className="border-b border-neutral-100">
                    <td className="py-2 font-medium">{r.source}</td>
                    <td className="py-2 text-right tabular-nums">{r.visits}</td>
                    <td className="py-2 text-right tabular-nums">{r.downloads}</td>
                    <td className="py-2 text-right tabular-nums">{r.attributed}</td>
                  </tr>
                ))}
                {stats.by_source.length === 0 ? (
                  <tr>
                    <td className="py-3 text-neutral-400" colSpan={4}>
                      No web visits yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

function Card(props: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {props.label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{props.value.toLocaleString()}</div>
      {props.sub ? <div className="mt-0.5 text-xs text-neutral-400">{props.sub}</div> : null}
    </div>
  );
}

function FunnelBar(props: { label: string; n: number; total: number }) {
  const w = props.total ? Math.max(2, Math.round((props.n / props.total) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 text-sm text-neutral-600">{props.label}</div>
      <div className="h-6 flex-1 rounded bg-neutral-100">
        <div
          className="flex h-6 items-center justify-end rounded bg-neutral-900 px-2 text-xs font-medium text-white"
          style={{ width: `${w}%` }}
        >
          {props.n}
        </div>
      </div>
    </div>
  );
}

function DayBars(props: { data: DayCount[] }) {
  const max = Math.max(1, ...props.data.map((d) => d.count));
  if (props.data.length === 0) return <p className="text-sm text-neutral-400">No installs yet.</p>;
  return (
    <div className="flex h-32 items-end gap-1">
      {props.data.map((d) => (
        <div
          key={d.day}
          className="flex flex-1 flex-col items-center gap-1"
          title={`${d.day}: ${d.count}`}
        >
          <div
            className="w-full rounded-t bg-neutral-800"
            style={{ height: `${Math.max(2, Math.round((d.count / max) * 100))}%` }}
          />
          <div className="text-[8px] text-neutral-400">{d.day.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}
