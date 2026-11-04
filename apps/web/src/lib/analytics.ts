import {
  APP_STORE_CAMPAIGN_PROVIDER_TOKEN,
  APP_STORE_URL,
  BACKEND_URL,
  PLAY_STORE_URL,
} from "../env";

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

const SOURCE_SLUG = /^[a-z0-9._~-]{1,64}$/i;
const ACQUISITION_SOURCES = new Set(["facebook_ads", "organic_posts", "bill_share"]);
type Store = "play" | "appstore";

function canTrack(pathname: string): boolean {
  return !/^\/(?:app|admin|i|v|v2|v3|t|v1\/(?:shared|tabs))(?:\/|$)/i.test(pathname);
}

function explicitSource(search: string): string {
  const params = new URLSearchParams(search);
  const source = params.get("s")?.trim() ?? "";
  if (SOURCE_SLUG.test(source))
    return ACQUISITION_SOURCES.has(source.toLowerCase()) ? source.toLowerCase() : source;

  const utmSource = params.get("utm_source")?.trim().toLowerCase() ?? "";
  if (ACQUISITION_SOURCES.has(utmSource)) return utmSource;
  const medium = params.get("utm_medium")?.trim().toLowerCase() ?? "";
  if (
    ["facebook", "fb", "meta"].includes(utmSource) &&
    /^(?:cpc|cpm|ppc|paid|paid[_-]?social|ads)$/.test(medium)
  )
    return "facebook_ads";
  if (
    ["facebook", "fb", "instagram", "tiktok", "youtube", "social"].includes(utmSource) &&
    /^(?:social|organic|organic[_-]social)$/.test(medium)
  )
    return "organic_posts";
  return "";
}

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
    return SOURCE_SLUG.test(raw) ? { source: raw, ts: Date.now() } : null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as SourcePin).source === "string" &&
      SOURCE_SLUG.test((parsed as SourcePin).source) &&
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

// Named acquisition links are deliberate new touches. Ordinary campaign QR
// slugs still use the existing 30-day first-touch window.
function resolveSource(search: string): SourcePin | null {
  const fromUrl = explicitSource(search);
  const pin = readPin();
  const current = pin && Date.now() - pin.ts < SOURCE_TTL_MS;
  if (!fromUrl) {
    // Expired acquisition tags must not credit a later untagged download.
    // Keep the established carry-forward behavior for generic flyer slugs.
    return pin && (current || !ACQUISITION_SOURCES.has(pin.source)) ? pin : null;
  }
  if (current && (pin.source === fromUrl || !ACQUISITION_SOURCES.has(fromUrl))) return pin;
  return { source: fromUrl, ts: Date.now() };
}

export function getSource(): string {
  if (typeof window === "undefined" || !canTrack(window.location.pathname)) return "";
  return resolveSource(window.location.search)?.source ?? "";
}

export function campaignDownloadPath(): string {
  const source = getSource();
  return source ? `/download?${new URLSearchParams({ s: source })}` : "/download";
}

export function campaignStoreHref(store: Store): string {
  const source = getSource();
  if (store === "appstore") {
    if (!ACQUISITION_SOURCES.has(source) || !/^\d{1,20}$/.test(APP_STORE_CAMPAIGN_PROVIDER_TOKEN))
      return APP_STORE_URL;
    const url = new URL(APP_STORE_URL);
    url.searchParams.set("pt", APP_STORE_CAMPAIGN_PROVIDER_TOKEN);
    url.searchParams.set("ct", source);
    url.searchParams.set("mt", "8");
    return url.href;
  }
  if (!ACQUISITION_SOURCES.has(source)) return PLAY_STORE_URL;
  const url = new URL(PLAY_STORE_URL);
  url.searchParams.set("referrer", new URLSearchParams({ kaata_source: source }).toString());
  return url.href;
}

function acquisitionContext() {
  const { pathname, search } = window.location;
  if (!canTrack(pathname)) return null;
  const explicit = explicitSource(search);
  const pin = resolveSource(search);
  if (pin) writePin(pin);
  const path = explicit ? `${pathname}?${new URLSearchParams({ s: explicit })}` : pathname;
  let referrer = "";
  try {
    const url = new URL(document.referrer);
    if (url.protocol === "http:" || url.protocol === "https:") referrer = url.origin;
  } catch {
    // Direct navigation or a browser that hides the referrer.
  }
  return { explicit, source: pin?.source ?? "", path, referrer };
}

// Fire-and-forget visit beacon. Once per browser session (sessionStorage flag)
// so navigating between routes doesn't multiply the count. Server harvests
// IP + Accept-Language from the request itself; body just carries source +
// path + referrer.
export function fireVisitOnce(): void {
  const context = acquisitionContext();
  if (!context) return;
  const visitKey = ACQUISITION_SOURCES.has(context.explicit)
    ? `${VISIT_FIRED_KEY}:${context.explicit}`
    : VISIT_FIRED_KEY;
  let alreadyFired = false;
  try {
    alreadyFired = window.sessionStorage.getItem(visitKey) === "1";
  } catch {
    // sessionStorage unavailable — fall back to letting it fire (better
    // double-count than silently lose every visit in private mode).
  }
  if (alreadyFired) return;
  try {
    window.sessionStorage.setItem(VISIT_FIRED_KEY, "1");
    window.sessionStorage.setItem(visitKey, "1");
  } catch {
    // ignore
  }
  postBeacon({
    source: context.source,
    path: context.path,
    referrer: context.referrer,
  });
}

// Store-badge click beacon (download page). Fired from the badge anchors'
// onClick WITHOUT preventDefault — the target=_blank navigation proceeds
// instantly and the beacon rides along (sendBeacon exists precisely for
// this). NOT once-per-session: each click is a distinct funnel event; the
// backend dedupes per (ip, user_agent, hour) on the stats side.
export function fireStoreClick(store: Store): void {
  const context = acquisitionContext();
  if (!context) return;
  postBeacon({
    kind: "store_click",
    detail: store,
    source: context.source,
    path: context.path,
    referrer: context.referrer,
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

// Funnel attribution uses visit and store-click beacons plus store install analytics.
