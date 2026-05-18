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
  const body = JSON.stringify({
    source: getSource(),
    path: window.location.pathname + window.location.search,
    referrer: document.referrer,
  });
  // sendBeacon is more reliable than fetch — survives page-unload, doesn't
  // race with React unmounts. Fetch is the fallback on the handful of
  // browsers without it.
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

// The tracked APK download URL. Hits the backend's /v1/download which counts
// the click and 302s to the actual APK. Source is appended as a query param;
// the backend reads it from there (single source of truth — not the body).
export function getTrackedDownloadUrl(): string {
  const src = getSource();
  const base = `${BACKEND_URL}/v1/download`;
  return src ? `${base}?s=${encodeURIComponent(src)}` : base;
}
