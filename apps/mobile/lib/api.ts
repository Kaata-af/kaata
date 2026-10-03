import { BACKEND_URL_FALLBACK } from "../constants/env";
import { getSessionJWT, InstallRetiredError } from "./auth";
import { getAppMeta } from "./db";
import { clearInstallRetired, markInstallRetired } from "./install-id";
import type { CheckInResponse } from "./types";

const TIMEOUT_MS = 5000;
const OVERRIDE_KEY = "backend_url_override";

// Resolves the backend URL at runtime. Override (set by a prior check-in's
// `migrate_to_backend_url`) wins over the build-time fallback. This is how we
// soft-migrate domains without forcing an app reinstall.
export async function getBackendUrl(): Promise<string> {
  const override = await getAppMeta(OVERRIDE_KEY);
  if (override && override.length > 0) return override;
  return BACKEND_URL_FALLBACK;
}

export async function checkIn(payload: {
  install_id: string;
  app_version: string;
  platform: string;
  device_locale: string;
  // The resolved IN-APP language ('en'/'fa') — what the user actually runs the
  // app in (distinct from device_locale, the OS locale). Powers the language
  // split on the admin dashboard. ~6 bytes; optional so old payloads are valid.
  app_locale?: string;
  // Wall-clock device timestamp from the moment ensureInstallId() first ran.
  // Sent on every check-in (cheap, ~13 bytes). Backend stores it once on
  // INSERT, never overwrites. Lets the admin show "installed N days ago"
  // even if the first online check-in was hours/days later.
  installed_at_unix_ms?: number;
  // True once the user has created a shop profile. Lets the admin see
  // "installed but never onboarded" vs. "set up + actively using".
  has_onboarded?: boolean;
  // The shopkeeper's OWN self profile (their name / phone / shop) — NEVER their
  // customers. Lets the admin dashboard show who's using the app even when they
  // never signed in (operator outreach for churn interviews). Sent once
  // onboarded; omitted on a brand-new install with no self user yet.
  self_name?: string;
  self_phone?: string;
  shop_name?: string;
  phones_invalid_count?: number;
  phones_conflict_count?: number;
  // Deltas since the last successful check-in. Omit (or send 0) when there
  // were no events; backend treats missing as zero.
  usage_entries_created?: number;
  usage_customers_added?: number;
  usage_shares_sent?: number;
  // Mesh: per-vault revocation cursor (vault_id -> max revoked_at_ms we've
  // applied). Backend returns deltas only, re-sourced from membership
  // events (M4). Omitted when empty.
  last_revocation_seen_at_ms?: Record<string, number>;
}): Promise<CheckInResponse> {
  const baseUrl = await getBackendUrl();
  // Send the session JWT when available so the backend can opportunistically
  // refresh it (response.session_jwt_refresh) once we cross the
  // RefreshIfOlderThan threshold. Anonymous installs (local-only mode) send
  // no Authorization header and the backend treats the request as anonymous —
  // OptionalMiddleware on /v1/check-in.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const jwt = await getSessionJWT().catch(() => null);
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/v1/check-in`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 410) {
      // Not a failure to retry: this install_id was retired when an account it
      // had been signed in to was deleted (see InstallRetiredError). Record it
      // for Account's reset notice — only while it is still this phone's id —
      // and hand callers the typed error. Nothing is queued as a crash report.
      let detail = "";
      try {
        detail = (await res.json())?.error ?? "";
      } catch {
        // The status is the signal; the body only adds the server's wording.
      }
      try {
        await markInstallRetired(payload.install_id);
      } catch (err) {
        console.warn("[api] could not record the retired install", err);
      }
      throw new InstallRetiredError(detail || undefined);
    }
    if (!res.ok) {
      throw new Error(`check-in failed: ${res.status}`);
    }
    const body = (await res.json()) as CheckInResponse;
    // The server accepted this install_id, so a 410 recorded for it earlier
    // must not keep Account's reset notice up (clearInstallRetired). Every
    // check-in reply carries server_time; a stray 2xx JSON body from anything
    // else clears nothing. Best-effort, like the mark above.
    if (typeof body?.server_time === "string") {
      try {
        await clearInstallRetired(payload.install_id);
      } catch (err) {
        console.warn("[api] could not clear the retired-install flag", err);
      }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
