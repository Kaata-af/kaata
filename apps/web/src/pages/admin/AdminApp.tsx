// Admin dashboard shell — admin.kaata.af. Lazy-loaded from pages/Admin.tsx so
// recharts + react-query never ship in the public marketing bundle.
//
// Auth (preserved from the v1 single-file dashboard): the API key is pasted
// once and kept in localStorage under "kaata_admin_token" — NEVER baked into
// the bundle (that would ship the admin secret to every visitor); the
// backend's Bearer check is the security boundary. Any 401 clears the key and
// returns to the prompt.

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { formatDistanceToNowStrict, parseISO } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { Acquisition } from "./Acquisition";
import { AdminTokenContext, AuthError, TOKEN_KEY, useStats } from "./api";
import { Campaigns } from "./Campaigns";
import { Overview } from "./Overview";
import { Retention } from "./Retention";
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
  const h = window.location.hash.replace(/^#\/?/, "");
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
        <Shell onSignOut={() => signOutRef.current(null)} />
      </AdminTokenContext.Provider>
    </QueryClientProvider>
  );
}

function KeyPrompt(props: { error: string | null; onSubmit: (key: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold text-[#101828]">
        kaata.<span className="ml-1 text-sm font-normal text-[#98a2b3]">growth</span>
      </h1>
      <p className="text-sm text-[#475467]">Enter the admin key to view the dashboard.</p>
      <input
        type="password"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Admin key"
        className="rounded-lg border border-[#eaecf0] px-3 py-2 text-[#101828] focus:border-[#98a2b3] focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "Enter" && input) props.onSubmit(input);
        }}
      />
      <button
        className="rounded-lg bg-[#101828] px-4 py-2 font-medium text-white disabled:opacity-50"
        disabled={!input}
        onClick={() => input && props.onSubmit(input)}
      >
        View dashboard
      </button>
      {props.error ? <p className="text-sm text-red-600">{props.error}</p> : null}
    </div>
  );
}

function Shell(props: { onSignOut: () => void }) {
  const [section, setSection] = useState<SectionId>(() => sectionFromHash());

  // Hash routing — the admin host renders only this app (no react-router
  // routes), but #retention etc. survive a refresh and are linkable.
  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const Active = SECTIONS.find((s) => s.id === section)?.component ?? Overview;

  return (
    <div className="flex min-h-screen bg-[#f9fafb] text-[#101828]">
      <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-[#eaecf0] bg-white px-4 py-6">
        <div className="mb-8 px-2">
          <div className="text-lg font-bold tracking-tight">kaata.</div>
          <div className="text-xs text-[#98a2b3]">growth</div>
        </div>
        <nav className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                window.location.hash = s.id;
                setSection(s.id);
              }}
              className={`rounded-lg px-3 py-2 text-left text-sm font-medium ${
                section === s.id
                  ? "bg-[#f2f4f7] text-[#101828]"
                  : "text-[#475467] hover:bg-[#f9fafb] hover:text-[#101828]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2">
          <Freshness />
          <button
            onClick={props.onSignOut}
            className="text-left text-xs text-[#98a2b3] hover:text-[#475467]"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <Active />
        </div>
      </main>
    </div>
  );
}

// "updated 2m ago" from the stats response's server-side generated_at.
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
    <span className="text-xs text-[#98a2b3]" title="Auto-refreshes every 60s">
      {label}
    </span>
  );
}

export default AdminApp;
