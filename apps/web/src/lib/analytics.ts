import { BACKEND_URL } from "../env";

const SOURCE_KEY = "kaata_source";
const VISIT_FIRED_KEY = "kaata_visit_fired";

// How long a first-touch source stays pinned to this browser.
//
// It used to be forever, and that was a real bug (2026-08-11): a phone that had
// ever landed on kaata.af with any ?s= was welded to that first slug for life,
// so scanning a NEW campaign QR reported the OLD source. The new slug never
// reached the database at all, and the operator's campaign table simply never
// grew a row — a working QR indistinguishable from a broken one.
//
// 30 days is ordinary first-touch attribution: long enough that a customer who
// scans a shop's QR and comes back next week is still that shop's, short enough
// that a genuinely new flyer months later counts as a new touch.
const SOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type SourcePin = { source: string; ts: number };

function writePin(pin: SourcePin): void {
  try {
    window.localStorage.setItem(SOURCE_KEY, JSON.stringify(pin));
  } catch {
    // localStorage unavailable (private mode, quotas) — just lose stickiness.
  }
}

function readPin(): SourcePin | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SOURCE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  // Legacy format: a bare slug, written before pins carried a timestamp. Its
  // real age is unknowable, so it is migrated with the clock starting NOW
  // rather than guessed at. Stamping it "already expired" would have been the
  // other option, but that silently re-attributes real returning visitors on
  // their next ?s= link — precisely what first-source-wins exists to prevent.
  // Consequence, accepted: a device pinned under the old code keeps its source
  // for 30 more days. Verify a fresh QR in a private window, not on a phone
  // that has scanned one before.
  if (raw[0] !== "{") {
    const migrated: SourcePin = { source: raw, ts: Date.now() };
    writePin(migrated);
    return migrated;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SourcePin).source === "string" &&
      (parsed as SourcePin).source.length > 0 &&
      typeof (parsed as SourcePin).ts === "number" &&
      Number.isFinite((parsed as SourcePin).ts)
    ) {
      return { source: (parsed as SourcePin).source, ts: (parsed as SourcePin).ts };
    }
  } catch {
    // Corrupt entry — treat as absent so the next ?s= can re-pin cleanly.
  }
  return null;
}

// Source = the QR/marketing-channel slug that brought the user here, passed as
// ?s=foo on the URL. Sticky across pages so a visitor who lands on /?s=shop_42
// and later navigates to /download still attributes their download click to
// shop_42. Not a UTM override system: within the TTL the FIRST source wins, so
// a later generic link can't steal a shop QR's credit.
export function getSource(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("s");
  const pin = readPin();
  if (fromUrl && fromUrl.length > 0 && fromUrl.length <= 64) {
    // The window is ABSOLUTE from the first touch, not sliding — repeat visits
    // must not keep renewing a pin and recreate the forever-stickiness.
    // A future-dated ts (device clock skew) yields a negative age and simply
    // keeps the pin, which is the safe direction.
    if (pin && Date.now() - pin.ts < SOURCE_TTL_MS) return pin.source;
    writePin({ source: fromUrl, ts: Date.now() });
    return fromUrl;
  }
  // No ?s= on this URL — carry the existing pin even if it has aged out, so an
  // expired pin still labels the session it belongs to until a new campaign
  // link actually replaces it. Expiry decides who WINS a conflict; it is not a
  // reason to drop attribution on the floor.
  return pin?.source ?? "";
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
