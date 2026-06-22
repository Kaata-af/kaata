// Operator analytics dashboard — /admin (Matee: "make a dashboard that I can check
// the analytics in a better way"). Reads GET /v1/admin/stats (guarded by the
// backend's ADMIN_API_KEY shared secret). Lean: no BI deps, Tailwind cards + a
// table + hand-rolled bars. The key comes from the build-time VITE_ADMIN_API_KEY
// or, failing that, a paste-once login stored in localStorage.

import { useCallback, useEffect, useRef, useState } from "react";
import { BACKEND_URL, ADMIN_API_KEY } from "../env";

type DayCount = { day: string; count: number };
type SourceRow = { source: string; visits: number; downloads: number; attributed: number };
type Stats = {
  installs_total: number;
  onboarded: number;
  with_entries: number;
  with_shares: number;
  active_7d: number;
  active_30d: number;
  ever_active: number;
  distinct_accounts: number;
  entries_sum: number;
  customers_sum: number;
  shares_sum: number;
  visits: number;
  downloads: number;
  raw_visits: number;
  excluded_installs: number;
  excluded_visits: number;
  installs_by_day: DayCount[];
  by_source: SourceRow[];
  generated_at: string;
};

const REFRESH_MS = 20000;

type KaataMember = { name: string; email: string; role: string };
type UserKaata = {
  vault_id: string;
  name: string;
  role: string;
  archived: boolean;
  member_count: number;
  tally_count: number;
  customer_count: number;
  members: KaataMember[];
};
type UserRow = {
  account_id: string;
  name: string;
  email: string;
  locale: string;
  created_at: string;
  last_login_at: string;
  ledger_name: string;
  ledger_phone: string;
  kaatas: UserKaata[];
};
type UsersResult = { users: UserRow[]; generated_at: string };

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
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // Abort the prior in-flight request before issuing a new one so an auto-
  // refresh tick (or a manual Refresh) can't race a slow previous fetch.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (tok: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/v1/admin/stats`, {
        headers: { Authorization: `Bearer ${tok}` },
        signal: ctrl.signal,
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
      setLastUpdated(Date.now());
    } catch (e) {
      // A superseded request aborts — that's expected, not an error.
      if ((e as Error)?.name === "AbortError") return;
      setError("Couldn't reach the backend.");
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  // Users drill-down. Fetched on load + manual refresh only (NOT on the 20s
  // poll) — it's a heavier query (joins + snapshot parse) and the user list is
  // browsed, not watched live. Expandable per row.
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const loadUsers = useCallback(async (tok: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/v1/admin/users`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) return;
      setUsers(((await res.json()) as UsersResult).users);
    } catch {
      // Non-fatal: the stats dashboard still renders without the user list.
    }
  }, []);

  // Auto-refresh: poll every REFRESH_MS while the tab is visible (pause in
  // background tabs so we don't hammer the DB), and refresh immediately when the
  // operator returns to the tab. Manual Refresh + the interval share load().
  useEffect(() => {
    if (!token) return;
    void load(token);
    void loadUsers(token);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load(token);
    }, REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void load(token);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      abortRef.current?.abort();
    };
  }, [token, load, loadUsers]);

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
          {lastUpdated ? (
            <span className="text-xs text-neutral-400" title="Auto-refreshes every 20s while this tab is open">
              updated {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          ) : null}
          <button
            onClick={() => {
              void load(token);
              void loadUsers(token);
            }}
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
          {/* Headline cards — honest numbers: "active" is now last-7-days, and
              "signed-in" collapses one person's many installs to a real human. */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card
              label="Active (7d)"
              value={stats.active_7d}
              sub={`${pct(stats.active_7d, stats.installs_total)} · 30d: ${stats.active_30d}`}
            />
            <Card label="Signed-in" value={stats.distinct_accounts} sub="unique accounts" />
            <Card
              label="Installs"
              value={stats.installs_total}
              sub={`${stats.onboarded} onboarded`}
            />
            <Card label="Web visits" value={stats.visits} sub={`${stats.downloads} downloads`} />
          </section>

          {/* Signal-quality line: how much was filtered as operator/bot noise so
              the operator can trust what's left. */}
          {stats.excluded_installs > 0 || stats.excluded_visits > 0 ? (
            <p className="-mt-6 text-xs text-neutral-400">
              Filtered out: {stats.excluded_installs} operator/test installs ·{" "}
              {stats.excluded_visits} bot/operator web hits
              {stats.raw_visits > stats.visits
                ? ` · ${stats.raw_visits} raw visits → ${stats.visits} after de-duping refreshes`
                : ""}
            </p>
          ) : (
            <p className="-mt-6 text-xs text-amber-600">
              No operator exclusions active — set OPERATOR_ACCOUNT_IDS on the backend to remove your
              own test devices from these numbers.
            </p>
          )}

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
              <FunnelBar label="Active (7d)" n={stats.active_7d} total={stats.installs_total} />
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
            <DayBars data={stats.installs_by_day} />
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

          {/* ===== USERS DRILL-DOWN — who's actually using the app ===== */}
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Users {users ? `(${users.length})` : ""}
            </h2>
            {users === null ? (
              <p className="text-sm text-neutral-400">Loading users…</p>
            ) : users.length === 0 ? (
              <p className="text-sm text-neutral-400">
                No signed-in users yet. Local-only installs (never signed in) don't appear here —
                their ledger never reaches the server.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-neutral-200">
                {users.map((u, i) => {
                  const open = !!expanded[u.account_id];
                  const totalTallies = u.kaatas.reduce((s, k) => s + k.tally_count, 0);
                  return (
                    <div key={u.account_id} className={i > 0 ? "border-t border-neutral-100" : ""}>
                      <button
                        onClick={() =>
                          setExpanded((e) => ({ ...e, [u.account_id]: !e[u.account_id] }))
                        }
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50"
                      >
                        <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 truncate text-sm font-medium">
                            {u.ledger_name || u.name || "(no name)"}
                            {u.locale ? (
                              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500">
                                {u.locale}
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-neutral-400">
                            {u.email}
                            {u.ledger_phone ? ` · ${u.ledger_phone}` : ""}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-neutral-400">
                          {u.kaatas.length} kaata{u.kaatas.length === 1 ? "" : "s"} · {totalTallies}{" "}
                          tallies
                        </div>
                      </button>
                      {open ? (
                        <div className="bg-neutral-50 px-4 pb-3 pl-10">
                          {u.kaatas.length === 0 ? (
                            <p className="py-2 text-xs text-neutral-400">No kaatas backed up yet.</p>
                          ) : (
                            u.kaatas.map((k) => (
                              <div
                                key={k.vault_id}
                                className="border-b border-neutral-100 py-2 last:border-0"
                              >
                                <div className="flex items-center gap-2 text-sm">
                                  <span className="font-medium">{k.name}</span>
                                  <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-600">
                                    {k.role}
                                  </span>
                                  {k.archived ? (
                                    <span className="text-[10px] font-semibold uppercase text-amber-600">
                                      archived
                                    </span>
                                  ) : null}
                                  <span className="ml-auto text-xs tabular-nums text-neutral-500">
                                    {k.tally_count} tallies · {k.customer_count} customers
                                  </span>
                                </div>
                                <div className="mt-1 text-xs text-neutral-400">
                                  {k.member_count} member{k.member_count === 1 ? "" : "s"}
                                  {k.members.length > 0
                                    ? ": " +
                                      k.members.map((m) => `${m.name || m.email} (${m.role})`).join(", ")
                                    : ""}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
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
