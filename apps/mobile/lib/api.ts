import { BACKEND_URL_FALLBACK } from "../constants/env";
import { getSessionJWT } from "./auth";
import { getAppMeta } from "./db";
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
  // Wall-clock device timestamp from the moment ensureInstallId() first ran.
  // Sent on every check-in (cheap, ~13 bytes). Backend stores it once on
  // INSERT, never overwrites. Lets the admin show "installed N days ago"
  // even if the first online check-in was hours/days later.
  installed_at_unix_ms?: number;
  // True once the user has created a shop profile. Lets the admin see
  // "installed but never onboarded" vs. "set up + actively using".
  has_onboarded?: boolean;
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
    if (!res.ok) {
      throw new Error(`check-in failed: ${res.status}`);
    }
    return (await res.json()) as CheckInResponse;
  } finally {
    clearTimeout(timer);
  }
}
