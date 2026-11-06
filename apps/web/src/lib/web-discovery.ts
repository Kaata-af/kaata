import {
  getWebSession,
  isSameWebSession,
  WebApiError,
  webRequest,
  type WebSession,
} from "./web-auth";

function requireSession(session: WebSession) {
  if (!isSameWebSession(getWebSession(), session))
    throw new WebApiError("Your session has changed. Sign in again.", 401, "session_changed");
}

export function parseWebDiscovery(value: unknown): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).discovery_enabled !== "boolean"
  )
    throw new WebApiError("Search visibility could not be confirmed.", 502, "invalid_response");
  return (value as { discovery_enabled: boolean }).discovery_enabled;
}

export async function getWebDiscovery(session: WebSession, signal?: AbortSignal): Promise<boolean> {
  requireSession(session);
  const value = await webRequest("/v1/account/me", { signal });
  requireSession(session);
  return parseWebDiscovery(value);
}

/** One request per explicit choice. A lost response must be reconciled with GET. */
export async function setWebDiscovery(
  session: WebSession,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  requireSession(session);
  const value = await webRequest("/v1/account/discovery", {
    method: "PUT",
    body: JSON.stringify({ enabled }),
    signal,
  });
  requireSession(session);
  const saved = parseWebDiscovery(value);
  if (saved !== enabled)
    throw new WebApiError("Search visibility could not be confirmed.", 502, "invalid_response");
  return saved;
}
