import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { CookieConsent } from "./components/CookieConsent";
import { ToastProvider } from "./components/Toast";
import { fireVisitOnce, getSource } from "./lib/analytics";
import { CustomerView } from "./pages/CustomerView";
import { Download } from "./pages/Download";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { NotFound } from "./pages/NotFound";
import { Privacy } from "./pages/Privacy";

// Lazy + code-split: the admin dashboard pulls in recharts, which must NOT ship
// in the public marketing bundle. Only loaded when an admin route is hit.
const Admin = lazy(() => import("./pages/Admin"));
const AdminFallback = (
  <div className="p-6 text-sm text-neutral-400">Loading dashboard…</div>
);

// The operator dashboard lives ONLY on its own subdomain (admin.kaata.af):
// cleaner, conventional, and it isolates the admin's localStorage (the API key)
// from the public marketing origin. The same SPA bundle serves both hosts; we
// route the admin host's root straight to the dashboard. The old kaata.af/admin
// path has been retired now that the subdomain is live — on the public host
// /admin is just a 404 like any other unknown path, so the dashboard surface
// (and its recharts chunk) is never reachable from the marketing origin.
const IS_ADMIN_HOST =
  typeof window !== "undefined" && window.location.hostname.split(".")[0] === "admin";

export function App() {
  useEffect(() => {
    // Don't fire the public visit beacon on the admin host — that's operator
    // traffic and would pollute the very analytics the dashboard reports.
    if (IS_ADMIN_HOST) return;
    // Stash the source from ?s= into localStorage before firing the beacon
    // so the recorded visit carries it even if a later page in this session
    // doesn't include the query param.
    getSource();
    fireVisitOnce();
  }, []);

  return (
    <ToastProvider>
      <ScrollManager />
      {IS_ADMIN_HOST ? (
        <Suspense fallback={AdminFallback}>
          <Routes>
            {/* admin.kaata.af — the whole subdomain is the dashboard. */}
            <Route path="/" element={<Admin />} />
            <Route path="*" element={<Admin />} />
          </Routes>
        </Suspense>
      ) : (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/download" element={<Download />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/v/:token" element={<CustomerView />} />
          {/* Phase 4: vault-invite landing. Public, no auth — purely
              informational, mirrors what's behind the token. Actual accept
              happens in the mobile app via POST /v1/vaults/invites/accept. */}
          <Route path="/i/:token" element={<Invite />} />
          {/* No /admin route on the public host — the dashboard lives solely on
              admin.kaata.af (see IS_ADMIN_HOST above). /admin → 404 here. */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      )}
      {IS_ADMIN_HOST ? null : <CookieConsent />}
    </ToastProvider>
  );
}

// react-router-dom v7 doesn't auto-scroll on navigation. Without this:
//   - <Link to="/#product"> would update the URL hash but leave the viewport put
//   - Page transitions would land mid-scroll on the new page
// Hash present → smooth-scroll to the matching element (accounting for the
// sticky header via `scroll-mt-*` on the targets). No hash → top.
function ScrollManager() {
  const { hash, pathname } = useLocation();

  useEffect(() => {
    if (hash) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        // 50ms delay lets the route's components mount before measuring.
        const t = window.setTimeout(
          () => el.scrollIntoView({ behavior: "smooth", block: "start" }),
          50,
        );
        return () => window.clearTimeout(t);
      }
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
  }, [hash, pathname]);

  return null;
}
