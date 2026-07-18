// Operator analytics dashboard — admin.kaata.af (Matee: a proper growth
// dashboard). Reads GET /v1/admin/stats?days=N and /v1/admin/users (guarded by
// the backend's ADMIN_API_KEY). Charts via recharts; this whole page is
// lazy-loaded (App.tsx) so recharts never ships in the public marketing bundle.
// The key is entered via a paste-once login and kept in localStorage — it is
// NEVER baked into the bundle (that would ship the admin secret to every
// visitor); the backend Bearer check is the security boundary.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BACKEND_URL } from "../env";

type SourceRow = { source: string; visits: number; downloads: number; attributed: number };
type LocaleCount = { locale: string; count: number };
type SeriesPoint = { t: string; installs: number; active: number };
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
  dau: number;
  wau: number;
  mau: number;
  ret_d1_eligible: number;
  ret_d1_retained: number;
  ret_d7_eligible: number;
  ret_d7_retained: number;
  ret_d30_eligible: number;
  ret_d30_retained: number;
  languages: LocaleCount[];
  series: SeriesPoint[];
  bucket: string;
  points: number;
  by_source: SourceRow[];
  generated_at: string;
};

// Granularity presets — let the operator inspect usage by hour/day/week/month.
// Each picks a sensible window (points × bucket).
const GRANULARITY = [
  { label: "Hourly", bucket: "hour", points: 48 },
  { label: "Daily", bucket: "day", points: 30 },
  { label: "Weekly", bucket: "week", points: 26 },
  { label: "Monthly", bucket: "month", points: 12 },
];

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
  last_seen: string;
  ledger_name: string;
  ledger_phone: string;
  shop_name: string;
  platform: string;
  app_version: string;
  installed_at: string;
  last_activity_at: string;
  has_onboarded: boolean;
  source: string;
  install_count: number;
  kaatas: UserKaata[];
};
// An install — signed in or not. As of the migration-028 build it reports the
// shopkeeper's OWN profile (self_name / self_phone / shop_name) on check-in, so
// the dashboard shows who's using the app regardless of sign-in. Still never
// customer data — the ledger itself stays on the device.
type InstallRow = {
  install_id: string;
  self_name: string;
  self_phone: string;
  shop_name: string;
  platform: string;
  app_version: string;
  locale: string;
  installed_at: string;
  first_seen: string;
  last_seen: string;
  last_activity_at: string;
  has_onboarded: boolean;
  source: string;
  attribution_method: string;
  usage_entries: number;
  usage_customers: number;
  usage_shares: number;
  check_in_count: number;
};
type UsersResult = {
  users: UserRow[];
  anonymous_installs: InstallRow[];
  signed_in_count: number;
  anonymous_count: number;
  total_installs: number;
  generated_at: string;
};

const TOKEN_KEY = "kaata_admin_token";

function pct(n: number, d: number): string {
  if (!d) return "—";
  return Math.round((n / d) * 100) + "%";
}

// Short absolute date for timeline fields (installed / last active). "—" when
// the field is empty (older installs predate the column).
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// "last seen" relative label + whether the user is effectively online now
// (checked in within 10 min — the app re-checks-in on foreground).
function lastSeenInfo(iso: string): { label: string; online: boolean } {
  if (!iso) return { label: "never", online: false };
  const ms = Date.now() - new Date(iso).getTime();
  const online = ms >= 0 && ms < 10 * 60_000;
  let label: string;
  if (ms < 60_000) label = "just now";
  else if (ms < 3_600_000) label = `${Math.floor(ms / 60_000)}m ago`;
  else if (ms < 86_400_000) label = `${Math.floor(ms / 3_600_000)}h ago`;
  else label = `${Math.floor(ms / 86_400_000)}d ago`;
  return { label, online };
}

export function Admin() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || "");
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  // Granularity (index into GRANULARITY) driving the activity series. Changing
  // it re-keys `load`, which re-runs the fetch effect with the new bucket/points.
  const [granIdx, setGranIdx] = useState(1); // Daily
  // Abort the prior in-flight request before issuing a new one so an auto-
  // refresh tick (or a manual Refresh) can't race a slow previous fetch.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (tok: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const g = GRANULARITY[granIdx];
        const res = await fetch(
          `${BACKEND_URL}/v1/admin/stats?bucket=${g.bucket}&points=${g.points}`,
          { headers: { Authorization: `Bearer ${tok}` }, signal: ctrl.signal },
        );
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
    },
    [granIdx],
  );

  // Users drill-down. Fetched on load + manual refresh only (NOT on the 20s
  // poll) — it's a heavier query (joins + snapshot parse) and the user list is
  // browsed, not watched live. Expandable per row.
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [anon, setAnon] = useState<InstallRow[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const loadUsers = useCallback(async (tok: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/v1/admin/users`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as UsersResult;
      setUsers(data.users);
      setAnon(data.anonymous_installs ?? []);
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
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Kaata analytics</h1>
        <div className="flex items-center gap-3">
          {/* Granularity control — inspect usage by hour/day/week/month. */}
          <div className="flex items-center rounded-lg border border-neutral-200 p-0.5 text-xs">
            {GRANULARITY.map((o, i) => (
              <button
                key={o.bucket}
                onClick={() => setGranIdx(i)}
                className={`rounded-md px-2.5 py-1 font-medium ${
                  granIdx === i
                    ? "bg-neutral-900 text-white"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {lastUpdated ? (
            <span
              className="text-xs text-neutral-400"
              title="Auto-refreshes every 20s while this tab is open"
            >
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

          {/* Engagement — from per-day activity. Fills in from the day the
              per-day tracking deployed (0 before that). */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label="DAU" value={stats.dau} sub="active today" />
            <Card label="WAU" value={stats.wau} sub="last 7 days" />
            <Card label="MAU" value={stats.mau} sub="last 30 days" />
            <Card
              label="Stickiness"
              valueText={stats.mau ? Math.round((stats.dau / stats.mau) * 100) + "%" : "—"}
              sub="DAU / MAU"
            />
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
              <FunnelBar label="Active (7d)" n={stats.active_7d} total={stats.installs_total} />
            </div>
          </section>

          {/* Usage totals */}
          <section className="grid grid-cols-3 gap-3">
            <Card label="Entries created" value={stats.entries_sum} />
            <Card label="Customers added" value={stats.customers_sum} />
            <Card label="Shares sent" value={stats.shares_sum} />
          </section>

          {/* Trends — bucketed by the selected granularity (hour/day/week/month) */}
          <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Trend
              title={`New installs · ${GRANULARITY[granIdx].label}`}
              data={stats.series}
              dataKey="installs"
              color="#171717"
              kind="area"
              empty="No installs in this window."
            />
            <Trend
              title={`Active users · ${GRANULARITY[granIdx].label}`}
              data={stats.series}
              dataKey="active"
              color="#2563eb"
              kind="line"
              empty="No ledger activity in this window."
            />
          </section>

          {/* Language split + retention */}
          <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <LanguageSplit languages={stats.languages} />
            <RetentionCard stats={stats} />
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
                No signed-in users yet. Devices that never signed in are listed under “Not signed
                in” below.
              </p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-neutral-200">
                {users.map((u, i) => {
                  const open = !!expanded[u.account_id];
                  const totalTallies = u.kaatas.reduce((s, k) => s + k.tally_count, 0);
                  const seen = lastSeenInfo(u.last_seen);
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
                            {u.shop_name ? ` · ${u.shop_name}` : ""}
                          </div>
                        </div>
                        <div className="shrink-0 text-right text-xs text-neutral-400">
                          <div className="flex items-center justify-end gap-1.5">
                            <span
                              className={`h-2 w-2 rounded-full ${
                                seen.online ? "bg-green-500" : "bg-neutral-300"
                              }`}
                            />
                            <span className={seen.online ? "font-medium text-green-600" : ""}>
                              {seen.online ? "online" : seen.label}
                            </span>
                          </div>
                          <div className="mt-0.5">
                            {u.kaatas.length} kaata{u.kaatas.length === 1 ? "" : "s"} ·{" "}
                            {totalTallies} tallies
                          </div>
                        </div>
                      </button>
                      {open ? (
                        <div className="bg-neutral-50 px-4 pb-3 pl-10">
                          {/* Device / install telemetry folded in from the
                              account's installs. */}
                          <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-neutral-100 py-2 text-xs text-neutral-500">
                            <span>
                              {u.platform || "—"}
                              {u.app_version ? ` · v${u.app_version}` : ""}
                            </span>
                            <span>installed {fmtDate(u.installed_at)}</span>
                            <span>last active {fmtDate(u.last_activity_at)}</span>
                            {u.source ? <span>via {u.source}</span> : null}
                            <span>
                              {u.install_count} device{u.install_count === 1 ? "" : "s"}
                            </span>
                            {!u.has_onboarded ? (
                              <span className="text-amber-600">not onboarded</span>
                            ) : null}
                          </div>
                          {u.kaatas.length === 0 ? (
                            <p className="py-2 text-xs text-neutral-400">
                              No kaatas backed up yet.
                            </p>
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
                                      k.members
                                        .map((m) => `${m.name || m.email} (${m.role})`)
                                        .join(", ")
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

          {/* ===== NOT SIGNED IN — anonymous installs (telemetry only) ===== */}
          <section>
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-400">
              Not signed in {anon ? `(${anon.length})` : ""}
            </h2>
            <p className="mb-3 text-xs text-neutral-400">
              Devices using the app without signing in. Each reports the shopkeeper&apos;s own name,
              phone, and shop on check-in (their customer ledger never leaves the phone), so you can
              reach the people actually using kaata.
            </p>
            {anon === null ? (
              <p className="text-sm text-neutral-400">Loading…</p>
            ) : anon.length === 0 ? (
              <p className="text-sm text-neutral-400">No anonymous installs.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-neutral-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 text-left text-xs text-neutral-400">
                      <th className="px-4 py-2 font-medium">Name / Shop</th>
                      <th className="px-4 py-2 font-medium">Phone</th>
                      <th className="px-4 py-2 font-medium">Device</th>
                      <th className="px-4 py-2 font-medium">App</th>
                      <th className="px-4 py-2 font-medium">Lang</th>
                      <th className="px-4 py-2 font-medium">Installed</th>
                      <th className="px-4 py-2 font-medium">Last seen</th>
                      <th className="px-4 py-2 text-right font-medium">Entries</th>
                      <th className="px-4 py-2 text-right font-medium">Customers</th>
                      <th className="px-4 py-2 text-right font-medium">Shares</th>
                      <th className="px-4 py-2 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {anon.map((d) => {
                      const seen = lastSeenInfo(d.last_seen);
                      return (
                        <tr
                          key={d.install_id}
                          className="border-b border-neutral-100 last:border-0"
                        >
                          <td className="px-4 py-2">
                            <div className="text-sm font-medium text-neutral-700">
                              {d.self_name || <span className="text-neutral-300">(no name)</span>}
                            </div>
                            {d.shop_name ? (
                              <div className="text-xs text-neutral-400">{d.shop_name}</div>
                            ) : null}
                          </td>
                          <td className="px-4 py-2 text-xs text-neutral-600" dir="ltr">
                            {d.self_phone || <span className="text-neutral-300">—</span>}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs text-neutral-500">
                            {d.install_id.slice(0, 8)}
                            {!d.has_onboarded ? (
                              <span className="ml-2 text-[10px] font-semibold uppercase text-amber-600">
                                no onboard
                              </span>
                            ) : null}
                          </td>
                          <td className="px-4 py-2 text-xs text-neutral-500">
                            {d.platform || "—"}
                            {d.app_version ? ` · v${d.app_version}` : ""}
                          </td>
                          <td className="px-4 py-2">
                            {d.locale ? (
                              <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-neutral-500">
                                {d.locale}
                              </span>
                            ) : (
                              <span className="text-neutral-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-xs text-neutral-500">
                            {fmtDate(d.installed_at)}
                          </td>
                          <td className="px-4 py-2 text-xs">
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`h-2 w-2 rounded-full ${
                                  seen.online ? "bg-green-500" : "bg-neutral-300"
                                }`}
                              />
                              <span
                                className={
                                  seen.online ? "font-medium text-green-600" : "text-neutral-500"
                                }
                              >
                                {seen.online ? "online" : seen.label}
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                            {d.usage_entries}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                            {d.usage_customers}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-neutral-600">
                            {d.usage_shares}
                          </td>
                          <td className="px-4 py-2 text-xs text-neutral-500">{d.source || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  );
}

function Card(props: { label: string; value?: number; valueText?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {props.label}
      </div>
      <div className="mt-1 text-2xl font-bold tabular-nums">
        {props.valueText ?? (props.value ?? 0).toLocaleString()}
      </div>
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

const LANG_COLORS: Record<string, string> = { fa: "#16a34a", en: "#2563eb", unknown: "#d4d4d4" };
const LANG_LABEL: Record<string, string> = { fa: "Dari", en: "English", unknown: "Unknown" };

// fmtTick shortens a bucket label for the x-axis. Labels are
// "YYYY-MM-DD\"T\"HH:00" (hour), "YYYY-MM-DD" (day/week) or "YYYY-MM" (month).
function fmtTick(t: string): string {
  if (t.includes("T")) {
    const [date, time] = t.split("T");
    return `${date.slice(5)} ${time}`; // "MM-DD HH:00"
  }
  if (t.length === 7) return t; // "YYYY-MM" (month)
  return t.slice(5); // "MM-DD"
}

// Trend renders the bucketed series as a recharts area or line chart for one
// metric (dataKey). Shows the empty-state message when every point is zero.
function Trend(props: {
  title: string;
  data: SeriesPoint[];
  dataKey: "installs" | "active";
  color: string;
  kind: "area" | "line";
  empty?: string;
}) {
  const hasData = props.data.some((d) => d[props.dataKey] > 0);
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {props.title}
      </div>
      {!hasData && props.empty ? (
        <div className="flex h-[180px] items-center justify-center px-6 text-center text-xs text-neutral-400">
          {props.empty}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          {props.kind === "area" ? (
            <AreaChart data={props.data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f5" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={fmtTick}
                tick={{ fontSize: 10, fill: "#a3a3a3" }}
                minTickGap={28}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#a3a3a3" }} width={28} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Area
                type="monotone"
                dataKey={props.dataKey}
                stroke={props.color}
                fill={props.color}
                fillOpacity={0.1}
                strokeWidth={2}
              />
            </AreaChart>
          ) : (
            <LineChart data={props.data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f5f5f5" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={fmtTick}
                tick={{ fontSize: 10, fill: "#a3a3a3" }}
                minTickGap={28}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#a3a3a3" }} width={28} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey={props.dataKey}
                stroke={props.color}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}

function LanguageSplit(props: { languages: LocaleCount[] }) {
  const total = props.languages.reduce((s, l) => s + l.count, 0);
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Language
      </div>
      {total === 0 ? (
        <div className="flex h-[180px] items-center justify-center text-xs text-neutral-400">
          No data yet.
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="50%" height={180}>
            <PieChart>
              <Pie
                data={props.languages}
                dataKey="count"
                nameKey="locale"
                innerRadius={45}
                outerRadius={70}
                paddingAngle={2}
              >
                {props.languages.map((l) => (
                  <Cell key={l.locale} fill={LANG_COLORS[l.locale] ?? "#d4d4d4"} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-col gap-1.5 text-sm">
            {props.languages.map((l) => (
              <div key={l.locale} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: LANG_COLORS[l.locale] ?? "#d4d4d4" }}
                />
                <span className="font-medium">{LANG_LABEL[l.locale] ?? l.locale}</span>
                <span className="text-neutral-400">
                  {l.count} ({pct(l.count, total)})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RetentionCard(props: { stats: Stats }) {
  const s = props.stats;
  const rows = [
    { label: "D1", ret: s.ret_d1_retained, elig: s.ret_d1_eligible },
    { label: "D7", ret: s.ret_d7_retained, elig: s.ret_d7_eligible },
    { label: "D30", ret: s.ret_d30_retained, elig: s.ret_d30_eligible },
  ];
  const any = rows.some((r) => r.elig > 0);
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
        Retention
      </div>
      {!any ? (
        <div className="flex h-[160px] items-center justify-center px-6 text-center text-xs text-neutral-400">
          Builds from the day per-day tracking deployed — needs installs old enough to measure.
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {rows.map((r) => (
            <div key={r.label} className="rounded-lg bg-neutral-50 p-3 text-center">
              <div className="text-xs text-neutral-400">{r.label}</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">
                {r.elig ? Math.round((r.ret / r.elig) * 100) + "%" : "—"}
              </div>
              <div className="text-[10px] text-neutral-400">
                {r.ret}/{r.elig}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Admin;
