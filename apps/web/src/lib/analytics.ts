import { BACKEND_URL } from "../env";

const SOURCE_KEY = "kaata_source";
const VISIT_FIRED_KEY = "kaata_visit_fired";

// Source = the QR/marketing-channel slug that brought the user here, passed
// as ?s=foo on the URL. Sticky across pages within a browser, so a visitor
// who lands on /?s=shop_42 and later navigates to /download still attributes
// their download click to shop_42. Cleared on browser data wipe; not a UTM
// override system — first source wins to keep print-QR attribution stable.
export function getSource(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("s");
  if (fromUrl && fromUrl.length > 0 && fromUrl.length <= 64) {
    try {
      // First source wins (per the policy comment above) — the code used
      // to overwrite unconditionally, silently re-attributing a shop-QR
      // visitor to whatever ?s= a later link carried.
      const existing = window.localStorage.getItem(SOURCE_KEY);
      if (existing) return existing;
      window.localStorage.setItem(SOURCE_KEY, fromUrl);
    } catch {
      // localStorage unavailable (private mode, quotas) — fine, just lose stickiness.
    }
    return fromUrl;
  }
  try {
    return window.localStorage.getItem(SOURCE_KEY) ?? "";
  } catch {
    return "";
  }
}

// Redact token-bearing routes before they reach analytics. The invite (/i/:token)
// and shared-ledger (/v/:token) paths carry a secret token that the backend
// deliberately stores only as a SHA-256 hash — beaconing the raw path would rest
// the plaintext token in web_visits next to the visitor's IP, defeating that
// design and letting anyone with DB/backup access redeem the invite. Send the
// route pattern instead, and drop the query string on those routes.
function safeVisitPath(): string {
  const p = window.location.pathname;
  const m = p.match(/^\/(i|v)\/.+/);
  if (m) return `/${m[1]}/:token`;
  return p + window.location.search;
}

// Fire-and-forget visit beacon. Once per browser session (sessionStorage flag)
// so navigating between routes doesn't multiply the count. Server harvests
// IP + Accept-Language from the request itself; body just carries source +
// path + referrer.
export function fireVisitOnce(): void {
  let alreadyFired = false;
  try {
    alreadyFired = window.sessionStorage.getItem(VISIT_FIRED_KEY) === "1";
  } catch {
    // sessionStorage unavailable — fall back to letting it fire (better
    // double-count than silently lose every visit in private mode).
  }
  if (alreadyFired) return;
  try {
    window.sessionStorage.setItem(VISIT_FIRED_KEY, "1");
  } catch {
    // ignore
  }
  postBeacon({
    source: getSource(),
    path: safeVisitPath(),
    referrer: document.referrer,
  });
}

// Store-badge click beacon (download page). Fired from the badge anchors'
// onClick WITHOUT preventDefault — the target=_blank navigation proceeds
// instantly and the beacon rides along (sendBeacon exists precisely for
// this). NOT once-per-session: each click is a distinct funnel event; the
// backend dedupes per (ip, user_agent, hour) on the stats side.
export function fireStoreClick(store: "play" | "appstore"): void {
  postBeacon({
    kind: "store_click",
    detail: store,
    source: getSource(),
    path: safeVisitPath(),
    referrer: document.referrer,
  });
}

// Fire-and-forget POST to /v1/visit. sendBeacon is more reliable than
// fetch — survives page-unload, doesn't race with React unmounts. Fetch
// (keepalive) is the fallback on the handful of browsers without it.
function postBeacon(payload: Record<string, string>): void {
  const body = JSON.stringify(payload);
  try {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon && navigator.sendBeacon(`${BACKEND_URL}/v1/visit`, blob)) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  fetch(`${BACKEND_URL}/v1/visit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Best-effort; analytics must not break the page.
  });
}

// NOTE (2026-07-26, Play launch): the tracked-APK-download helpers
// (getTrackedDownloadUrl / reportDownloadClick) retired with the sideload
// button — the download page is store-badges-only now, and store taps can't
// be beaconed the same way. Web-side funnel attribution is the visit beacon
// above + Play/App Store install analytics; the backend's /v1/download stays
// alive for the in-app update banner of the existing sideload fleet.
