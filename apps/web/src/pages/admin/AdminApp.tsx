// Admin dashboard shell — admin.kaata.af. Lazy-loaded from pages/Admin.tsx so
// recharts + react-query never ship in the public marketing bundle.
//
// Auth (preserved from the v1 single-file dashboard): the API key is pasted
// once and kept in localStorage under "kaata_admin_token" — NEVER baked into
// the bundle (that would ship the admin secret to every visitor); the
// backend's Bearer check is the security boundary. Any 401 clears the key and
// returns to the prompt.
//
// Chrome follows the public site (components/SiteChrome.tsx): Tailwind neutral
// palette, one accent (neutral-900), hairline neutral-200 borders, Inter with
// tight tracking. The sidebar is white with a hairline, the page is
// neutral-50, and nothing decorative carries colour — colour is reserved for
// data (charts, status pills). Data is live over the admin WebSocket, with
// 60-second polling and a Kabul-midnight invalidation as the authoritative
// fallbacks, so there is no manual refresh control; the footer says when the
// numbers were generated.

import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
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

// Same interaction vocabulary as the marketing header's CTA: black button,
// ring on hover (dub.co's signature), neutral focus ring.
const PRIMARY_BUTTON =
  "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 text-sm font-medium text-white ring-0 ring-neutral-200 transition-[box-shadow,opacity] hover:ring-4 focus-visible:outline-none focus-visible:ring-4 disabled:opacity-40 disabled:hover:ring-0";

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
          onSignOut={() => signOutRef.current(null)}
          onUnauthorized={() => signOutRef.current("Wrong admin key.")}
          token={token}
        />
      </AdminTokenContext.Provider>
    </QueryClientProvider>
  );
}

function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <img src="/logo.png" alt="" className={large ? "h-7 w-7" : "h-6 w-6"} />
      <span
        className={`font-bold tracking-tight text-neutral-900 ${large ? "text-lg" : "text-base"}`}
      >
        kaata.
      </span>
    </span>
  );
}

function KeyPrompt(props: { error: string | null; onSubmit: (key: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div className="flex min-h-screen min-w-0 items-center justify-center bg-neutral-50 px-4 py-10">
      <form
        className="flex w-full min-w-0 max-w-sm flex-col gap-6 rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) props.onSubmit(input.trim());
        }}
      >
        <Wordmark large />
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Admin</h1>
          <p className="mt-1.5 text-sm leading-6 text-neutral-500">
            Enter your admin key to open the dashboard.
          </p>
        </div>
        <div>
          <label htmlFor="admin-key" className="mb-1.5 block text-sm font-medium text-neutral-700">
            Admin key
          </label>
          <input
            id="admin-key"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste your key"
            aria-invalid={!!props.error}
            aria-describedby={props.error ? "admin-key-error" : undefined}
            className="h-10 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-4 focus:ring-neutral-100"
          />
          {props.error ? (
            <p id="admin-key-error" role="alert" className="mt-2 text-sm text-red-600">
              {props.error}
            </p>
          ) : null}
        </div>
        <button type="submit" className={PRIMARY_BUTTON} disabled={!input.trim()}>
          Open dashboard
        </button>
        <p className="text-xs leading-5 text-neutral-500">
          For Kaata operators. The key stays in this browser until you sign out.
        </p>
      </form>
    </div>
  );
}

function Shell(props: { token: string; onSignOut: () => void; onUnauthorized: () => void }) {
  const [section, setSection] = useState<SectionId>(() => sectionFromHash());
  const client = useQueryClient();
  const liveState = useAdminLive(props.token, props.onUnauthorized);

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

  const navigate = (id: SectionId) => {
    window.location.hash = id;
    setSection(id);
  };

  return (
    <div className="min-h-screen min-w-0 w-full bg-neutral-50 text-neutral-900 lg:flex">
      <a
        href="#admin-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("admin-main")?.focus();
        }}
        className="sr-only z-50 rounded-lg border border-neutral-200 bg-white p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      {/* Desktop sidebar: white, hairline, neutral — the same surface as a
          card. The active item is a filled neutral-100 pill; nothing else is
          lit. */}
      <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 flex-col border-r border-neutral-200 bg-white px-4 py-5 lg:flex">
        <div className="px-2 py-1.5">
          <Wordmark />
        </div>
        <nav aria-label="Main navigation" className="mt-8 flex flex-col gap-0.5">
          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => navigate(s.id)}
                aria-current={active ? "page" : undefined}
                className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 ${
                  active
                    ? "bg-neutral-100 font-medium text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                }`}
              >
                <AdminIcon
                  name={s.id}
                  className={`h-4 w-4 ${active ? "text-neutral-900" : "text-neutral-500"}`}
                />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t border-neutral-200 px-2.5 pt-4">
          <LiveStatus state={liveState} />
          <p className="text-xs leading-5 text-neutral-500">Kabul time · days reset at midnight</p>
          <button
            onClick={props.onSignOut}
            className="flex h-8 items-center gap-2 rounded-md text-left text-[13px] font-medium text-neutral-600 transition-colors hover:text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300"
          >
            <AdminIcon name="logout" className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0 w-full lg:w-0 lg:flex-1">
        {/* Mobile chrome only. On desktop the page header carries the title
            and the sidebar carries status, so no second bar competes. */}
        <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white/80 backdrop-blur-xl lg:hidden">
          <div className="flex h-14 min-w-0 items-center justify-between gap-3 px-4">
            <Wordmark />
            <div className="flex items-center gap-3">
              <LiveStatus state={liveState} />
              <button
                onClick={props.onSignOut}
                aria-label="Sign out"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                <AdminIcon name="logout" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <nav aria-label="Mobile navigation" className="flex gap-1 overflow-x-auto px-2 pb-2">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => navigate(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={`flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors ${section === s.id ? "bg-neutral-100 text-neutral-900" : "text-neutral-600 hover:bg-neutral-50"}`}
              >
                <AdminIcon name={s.id} className="h-4 w-4" />
                {s.label}
              </button>
            ))}
          </nav>
        </header>

        <main
          id="admin-main"
          tabIndex={-1}
          className="mx-auto min-w-0 w-full max-w-[1200px] px-4 py-6 outline-none sm:px-8 sm:py-10"
        >
          <Active />
          <footer className="mt-10 border-t border-neutral-200 pt-4">
            <Freshness />
          </footer>
        </main>
      </div>
    </div>
  );
}

function LiveStatus({ state }: { state: ReturnType<typeof useAdminLive> }) {
  const live = state === "live";
  return (
    <span
      role="status"
      title={
        live
          ? "Connected for live updates. Data also refreshes every 60 seconds."
          : "Data refreshes every 60 seconds while live updates reconnect."
      }
      className="inline-flex items-center gap-2 whitespace-nowrap text-xs font-medium text-neutral-600"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-neutral-300"}`} />
      {live ? "Live" : state === "connecting" ? "Connecting" : "Polling"}
    </span>
  );
}

// "Updated 2m ago" from the stats response's server-side generated_at.
// react-query refetches every 60s; a 30s local tick keeps the label honest
// between refetches without re-rendering the whole app.
function Freshness() {
  const stats = useStats();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!stats.data?.generated_at) {
    return (
      <span className="text-xs text-neutral-500">{stats.isError ? "Offline" : "Updating…"}</span>
    );
  }
  let label: string;
  try {
    label = `Updated ${formatDistanceToNowStrict(parseISO(stats.data.generated_at))} ago`;
  } catch {
    label = "Updated —";
  }
  return (
    <>
      <span
        className={`text-xs ${stats.isError ? "text-amber-700" : "text-neutral-500"}`}
        title="Refreshes on live updates, every 60s, and at Kabul midnight"
      >
        {stats.isError ? "Connection issue · " : ""}
        {label}
      </span>
      <span className="ml-2 text-xs text-neutral-400">· Kabul time (UTC+04:30)</span>
      {stats.data.activity_timezone_since ? (
        <p className="mt-2 text-xs leading-5 text-neutral-400">
          Activity and install dates before {stats.data.activity_timezone_since} use UTC day
          boundaries.
        </p>
      ) : null}
    </>
  );
}

export default AdminApp;
