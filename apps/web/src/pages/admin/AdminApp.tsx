// Admin dashboard shell — admin.kaata.af. Lazy-loaded from pages/Admin.tsx so
// recharts + react-query never ship in the public marketing bundle.
//
// Auth (preserved from the v1 single-file dashboard): the API key is pasted
// once and kept in localStorage under "kaata_admin_token" — NEVER baked into
// the bundle (that would ship the admin secret to every visitor); the
// backend's Bearer check is the security boundary. Any 401 clears the key and
// returns to the prompt.

import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
  useIsFetching,
  useQueryClient,
} from "@tanstack/react-query";
import { formatDistanceToNowStrict, parseISO } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { Acquisition } from "./Acquisition";
import { AdminTokenContext, AuthError, TOKEN_KEY, useStats } from "./api";
import { Campaigns } from "./Campaigns";
import { msUntilReportingMidnight, reportingDay } from "./dates";
import { AdminIcon } from "./icons";
import { Overview } from "./Overview";
import { Retention } from "./Retention";
import { useAdminLive } from "./useAdminLive";
import { Users } from "./Users";

const SECTIONS = [
  { id: "overview", label: "Overview", component: Overview },
  { id: "acquisition", label: "Acquisition", component: Acquisition },
  { id: "campaigns", label: "Campaigns", component: Campaigns },
  { id: "retention", label: "Retention", component: Retention },
  { id: "users", label: "Users", component: Users },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function sectionFromHash(): SectionId {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (SECTIONS.find((s) => s.id === h)?.id ?? "overview") as SectionId;
}

export function AdminApp() {
  const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_KEY) || "");
  const [authError, setAuthError] = useState<string | null>(null);

  // The QueryCache's onError fires for ANY failing query; on a 401 we clear
  // the key and drop back to the prompt (same UX as the old dashboard). A ref
  // keeps the handler stable while the client lives for the app's lifetime.
  const signOutRef = useRef<(msg: string | null) => void>(() => {});
  signOutRef.current = (msg) => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setAuthError(msg);
  };
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: (err) => {
            if (err instanceof AuthError) signOutRef.current(err.message);
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchInterval: 60_000,
            // A wrong key will stay wrong — don't retry 401s.
            retry: (count, err) => !(err instanceof AuthError) && count < 2,
          },
        },
      }),
  );

  if (!token) {
    return (
      <KeyPrompt
        error={authError}
        onSubmit={(key) => {
          localStorage.setItem(TOKEN_KEY, key);
          setAuthError(null);
          // Stale cached results from a previous key must not flash in.
          client.clear();
          setToken(key);
        }}
      />
    );
  }

  return (
    <QueryClientProvider client={client}>
      <AdminTokenContext.Provider value={token}>
        <Shell
          token={token}
          onSignOut={() => signOutRef.current(null)}
          onUnauthorized={() => signOutRef.current("Wrong admin key.")}
        />
      </AdminTokenContext.Provider>
    </QueryClientProvider>
  );
}

function KeyPrompt(props: { error: string | null; onSubmit: (key: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div className="flex min-h-screen min-w-0 items-center justify-center bg-[#f6f7f9] p-3 sm:p-10">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-3xl border border-[#e4e7ec] bg-white shadow-xl shadow-[#101828]/5 md:grid-cols-2">
        <div className="flex min-w-0 flex-col justify-between bg-[#112b24] p-6 text-white sm:p-12">
          <div className="text-3xl font-bold tracking-tight">kaata.</div>
          <div className="my-6 md:my-20">
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.2em] text-[#a1c9b8]">
              Admin workspace
            </p>
            <h1 className="text-3xl font-semibold leading-tight tracking-tight">
              See the people
              <br />
              behind the numbers.
            </h1>
            <p className="mt-5 max-w-xs text-sm leading-7 text-[#c0d3cb]">
              Understand who uses Kaata, how they find it, and what keeps them coming back.
            </p>
          </div>
          <p className="text-xs text-[#a1c9b8]">Kaata · Built for everyday business.</p>
        </div>
        <form
          className="flex min-w-0 flex-col justify-center gap-5 p-6 sm:p-12"
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) props.onSubmit(input.trim());
          }}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eaf4ef] text-[#0c745a]">
            <AdminIcon name="lock" className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">
              Use your admin key to open the workspace.
            </p>
          </div>
          <div>
            <label htmlFor="admin-key" className="mb-2 block text-sm font-medium text-[#344054]">
              Admin key
            </label>
            <input
              id="admin-key"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Enter your key"
              aria-invalid={!!props.error}
              aria-describedby={props.error ? "admin-key-error" : undefined}
              className="min-w-0 w-full rounded-xl border border-[#d0d5dd] bg-white px-3.5 py-3 text-base text-[#101828] outline-none transition focus:border-[#0c745a] focus:ring-4 focus:ring-[#0c745a]/10 sm:text-sm"
            />
          </div>
          <button
            type="submit"
            className="flex items-center justify-center gap-2 rounded-xl bg-[#0c745a] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#095b47] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0c745a] disabled:opacity-40"
            disabled={!input.trim()}
          >
            Open dashboard <AdminIcon name="arrow" className="h-4 w-4" />
          </button>
          {props.error ? (
            <p id="admin-key-error" role="alert" className="text-sm text-red-600">
              {props.error}
            </p>
          ) : null}
          <p className="text-xs leading-5 text-[#98a2b3]">
            For authorized Kaata operators. Your key stays in this browser until you sign out.
          </p>
        </form>
      </div>
    </div>
  );
}

function Shell(props: { token: string; onSignOut: () => void; onUnauthorized: () => void }) {
  const [section, setSection] = useState<SectionId>(() => sectionFromHash());
  const client = useQueryClient();
  const liveState = useAdminLive(props.token, props.onUnauthorized);
  const isRefreshing = useIsFetching({ queryKey: ["admin"] }) > 0;
  const [refreshError, setRefreshError] = useState(false);

  async function refresh() {
    setRefreshError(false);
    try {
      await client.cancelQueries({ queryKey: ["admin"] });
      await client.invalidateQueries({ queryKey: ["admin"] }, { throwOnError: true });
    } catch {
      setRefreshError(true);
    }
  }

  // Polling keeps counts fresh, but its 60s interval isn't aligned to midnight.
  // Invalidate at the reporting-day boundary, including when a sleeping or
  // hidden tab resumes after the boundary with otherwise-fresh cached data.
  useEffect(() => {
    let day = reportingDay(Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const checkDay = () => {
      const current = reportingDay(Date.now());
      if (current !== day) {
        day = current;
        // Invalidation alone reuses an in-flight FIRST fetch (no cached data),
        // which could otherwise resolve with yesterday after the boundary.
        void client
          .cancelQueries({ queryKey: ["admin"] })
          .then(() => client.invalidateQueries({ queryKey: ["admin"] }))
          .catch(() => {
            // Query errors use the existing error cards and polling retries.
          });
      }
      clearTimeout(timer);
      timer = setTimeout(checkDay, msUntilReportingMidnight() + 25);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") checkDay();
    };
    checkDay();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client]);

  // Hash routing — the admin host renders only this app (no react-router
  // routes), but #retention etc. survive a refresh and are linkable.
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const Active = SECTIONS.find((s) => s.id === section)?.component ?? Overview;
  const activeLabel = SECTIONS.find((s) => s.id === section)?.label ?? "Overview";

  const navigate = (id: SectionId) => {
    window.location.hash = id;
    setSection(id);
  };

  return (
    <div className="min-h-screen min-w-0 w-full bg-[#f6f7f9] text-[#101828] lg:flex">
      <a
        href="#admin-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("admin-main")?.focus();
        }}
        className="sr-only z-50 rounded-lg bg-white p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col bg-[#112b24] px-4 py-7 text-white lg:flex">
        <div className="mb-11 px-3">
          <div className="text-[28px] font-bold tracking-[-0.06em]">kaata.</div>
          <div className="mt-1 text-xs text-[#a1c9b8]">Admin workspace</div>
        </div>
        <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#91b4a5]">
          Workspace
        </div>
        <nav aria-label="Main navigation" className="flex flex-col gap-1.5">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(s.id)}
              aria-current={section === s.id ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
                section === s.id
                  ? "bg-white/10 text-white ring-1 ring-inset ring-white/10"
                  : "text-[#bfd0c9] hover:bg-white/5 hover:text-white"
              }`}
            >
              <AdminIcon
                name={s.id}
                className={`h-[18px] w-[18px] ${section === s.id ? "text-[#94ddbd]" : ""}`}
              />
              {s.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-5 px-3 pt-8">
          <div className="rounded-xl border border-white/10 bg-white/5 p-3.5">
            <div className="flex items-center gap-2 text-xs font-medium text-[#dceae3]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#94ddbd]" />
              Kabul reporting time
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#a1c9b8]">
              Days reset at midnight.
              <br />
              UTC+04:30
            </p>
          </div>
          <button
            onClick={props.onSignOut}
            className="flex items-center gap-2 rounded-lg py-1 text-left text-xs text-[#bfd0c9] transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
          >
            <AdminIcon name="logout" className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 w-full lg:w-0 lg:flex-1">
        <header className="sticky top-0 z-20 border-b border-[#e4e7ec] bg-white/95 backdrop-blur">
          <div className="flex min-h-16 min-w-0 items-center justify-between gap-2 px-3 sm:min-h-[72px] sm:gap-3 sm:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <span className="text-xl font-bold tracking-tight lg:hidden">kaata.</span>
              <span className="hidden text-sm text-[#98a2b3] sm:inline">Workspace</span>
              <span className="hidden text-[#d0d5dd] sm:inline">/</span>
              <span className="hidden truncate text-sm font-medium sm:inline">{activeLabel}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
              <span
                role="status"
                title={
                  liveState === "live"
                    ? "Connected for live updates. Data also refreshes every 60 seconds."
                    : "Data still refreshes every 60 seconds while live updates reconnect."
                }
                className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium ${liveState === "live" ? "text-[#0c745a]" : "text-[#667085]"}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${liveState === "live" ? "bg-[#0c745a]" : "bg-[#98a2b3]"}`}
                />
                {liveState === "live"
                  ? "Live updates"
                  : liveState === "connecting"
                    ? "Connecting"
                    : "Auto-refresh"}
              </span>
              <div className="hidden xl:block">
                <Freshness compact />
              </div>
              <button
                onClick={() => void refresh()}
                disabled={isRefreshing}
                className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-medium text-[#344054] shadow-sm transition hover:bg-[#f9fafb] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0c745a] disabled:opacity-60"
                aria-label="Refresh dashboard"
              >
                <AdminIcon
                  name="refresh"
                  className={`h-4 w-4 ${isRefreshing ? "animate-spin motion-reduce:animate-none" : ""}`}
                />
                <span className="hidden sm:inline">{isRefreshing ? "Updating" : "Refresh"}</span>
              </button>
              <button
                onClick={props.onSignOut}
                aria-label="Sign out"
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-2 text-[#667085] hover:bg-[#f2f4f7] lg:hidden"
              >
                <AdminIcon name="logout" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <nav
            aria-label="Mobile navigation"
            className="grid min-w-0 grid-cols-5 gap-1 px-2 pb-2 lg:hidden"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                aria-label={s.label}
                className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium sm:flex-row sm:gap-2 sm:text-xs ${section === s.id ? "bg-[#eaf4ef] text-[#0c745a]" : "text-[#667085] hover:bg-[#f2f4f7]"}`}
              >
                <AdminIcon name={s.id} className="h-4 w-4" />
                <span className="sm:hidden">{s.id === "acquisition" ? "Acquire" : s.label}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            ))}
          </nav>
        </header>
        <main
          id="admin-main"
          tabIndex={-1}
          className="mx-auto min-w-0 w-full max-w-[1440px] px-3 py-5 outline-none sm:px-8 sm:py-8 xl:px-10"
        >
          {refreshError ? (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              Couldn’t refresh all data. You can retry; any previous results remain visible.
            </div>
          ) : null}
          <Active />
          <footer className="mt-8 border-t border-[#e4e7ec] pt-4">
            <Freshness />
          </footer>
        </main>
      </div>
    </div>
  );
}

// "updated 2m ago" from the stats response's server-side generated_at.
// react-query refetches every 60s; a 30s local tick keeps the label honest
// between refetches without re-rendering the whole app.
function Freshness({ compact = false }: { compact?: boolean }) {
  const stats = useStats();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!stats.data?.generated_at) {
    return (
      <span className="text-xs text-[#98a2b3]">{stats.isError ? "offline" : "updating…"}</span>
    );
  }
  let label: string;
  try {
    label = `updated ${formatDistanceToNowStrict(parseISO(stats.data.generated_at))} ago`;
  } catch {
    label = "updated —";
  }
  return (
    <>
      <span
        className={`text-xs ${stats.isError ? "text-amber-700" : "text-[#667085]"}`}
        title="Refreshes on live updates, every 60s, and at Kabul midnight"
      >
        {stats.isError ? "Connection issue · " : ""}
        {label}
      </span>
      {!compact ? (
        <span className="ml-2 text-xs text-[#98a2b3]">· Kabul time (UTC+04:30)</span>
      ) : null}
      {!compact && stats.data.activity_timezone_since ? (
        <p className="mt-2 text-[11px] leading-5 text-[#98a2b3]">
          Activity and install dates before {stats.data.activity_timezone_since} use UTC day
          boundaries.
        </p>
      ) : null}
    </>
  );
}

export default AdminApp;
