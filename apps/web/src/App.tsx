import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { CookieConsent } from "./components/CookieConsent";
import { ToastProvider } from "./components/Toast";
import { fireVisitOnce, getSource } from "./lib/analytics";
import { CustomerView } from "./pages/CustomerView";
import { Download } from "./pages/Download";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";

export function App() {
  useEffect(() => {
    // Stash the source from ?s= into localStorage before firing the beacon
    // so the recorded visit carries it even if a later page in this session
    // doesn't include the query param.
    getSource();
    fireVisitOnce();
  }, []);

  return (
    <ToastProvider>
      <ScrollManager />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/download" element={<Download />} />
        <Route path="/v/:token" element={<CustomerView />} />
        {/* Phase 4: vault-invite landing. Public, no auth — purely
            informational, mirrors what's behind the token. Actual accept
            happens in the mobile app via POST /v1/vaults/invites/accept. */}
        <Route path="/i/:token" element={<Invite />} />
      </Routes>
      <CookieConsent />
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
