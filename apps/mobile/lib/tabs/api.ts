// apps/mobile/lib/tabs/api.ts
//
// The /v1/tabs/* client. Deliberately NOT built on lib/vault-api.ts: its
// private `http` calls requireJwt() unconditionally, and a tab party may have
// no account at all — party b on a phone that never signed in talks to the
// server with its capability token alone (D10). So the headers are built here
// the way lib/api.ts checkIn builds them: `Authorization: Bearer <jwt>` when
// the caller resolved a session, `Authorization: Tab <token>` otherwise.
// OptionalMiddleware ignores the non-Bearer prefix and the tabs handler reads
// the header itself (§3.2).
//
// Two contract points the design doc leaves implicit; both are single
// constants below so the backend half can be matched in one edit:
//   - bind (and join-when-signed-in) needs the token AND the JWT. One
//     Authorization header cannot carry both, so the JWT rides the header and
//     the token rides the JSON body as `token` — the shape
//     POST /v1/vaults/invites/accept already uses for a Bearer-authenticated
//     token redemption.
//   - The deep link is kaata://t/<token> (D15) but every §3.3 route is keyed by
//     tab_id. Resolving a token to its tab is BY_TOKEN_PATH (a token-authorised
//     GET returning a full TabResponse); §3.2's "must match the URL's tab_id
//     WHEN PRESENT" is what makes a tab_id-less token route legitimate.
//
// Every failure is a TabApiError: transport failures use status 0 with code
// "timeout" / "network", so callers have one type to switch on and
// isRetryableTabError (lib/tabs/errors.ts) one table to consult.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { TabApiError, TabAuthUnavailableError } from "./errors";
import type {
  AppendRequest,
  CreateRequest,
  CreateResponse,
  EntryResponse,
  JoinRequest,
  MineResponse,
  TabLink,
  TabResponse,
  VoidResponse,
  WireEntry,
  WireTab,
} from "./types";

export { TabApiError, TabAuthUnavailableError } from "./errors";
export { minorToWire, wireToMinor } from "./wire";

// Same budget as lib/vault-api.ts; the sync loop's per-op backoff sits on
// top of it, so this only has to be longer than a slow Afghan 3G round trip.
const TIMEOUT_MS = 15_000;

/** Token→tab resolution for the join flow. See the header note. */
const BY_TOKEN_PATH = "/v1/tabs/by-token";

/** How the caller is identified. JWT when signed in, else the party token. */
export type TabAuth = { jwt: string; role?: TabLink["role"] } | { token: string };

function authorization(auth: TabAuth | null): string | null {
  if (!auth) return null;
  return "jwt" in auth ? `Bearer ${auth.jwt}` : `Tab ${auth.token}`;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  auth: TabAuth | null,
  body?: unknown,
): Promise<T> {
  const baseUrl = await getBackendUrl();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const authz = authorization(auth);
  if (authz) headers.Authorization = authz;
  if (auth && "jwt" in auth && auth.role) headers["X-Kaata-Party"] = auth.role;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new TabApiError(
      0,
      aborted ? "timeout" : "network",
      `${method} ${path}: ${aborted ? "timed out" : "network failure"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Same body-parsing shape as vault-api.ts httpThrowing: the backend's
    // {error, error_code}; a proxy / rate-limiter may answer with plain text.
    let code = "";
    let serverMsg = "";
    try {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; error_code?: string };
          code = parsed.error_code ?? "";
          serverMsg = parsed.error ?? "";
        } catch {
          serverMsg = text.slice(0, 200);
        }
      }
    } catch {
      /* body unreadable — status alone is still a verdict */
    }
    if (!code) code = res.status === 429 ? "rate_limited" : `http_${res.status}`;
    throw new TabApiError(
      res.status,
      code,
      `${method} ${path}: ${res.status}${serverMsg ? ` — ${serverMsg}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

async function optionalJwt(): Promise<TabAuth | null> {
  const jwt = await getSessionJWT().catch(() => null);
  return jwt ? { jwt } : null;
}

async function requireJwt(): Promise<TabAuth> {
  const jwt = await getSessionJWT().catch(() => null);
  if (!jwt) throw new TabAuthUnavailableError();
  return { jwt };
}

/**
 * Credential for talking to `link`'s tab. The JWT wins when present because it
 * needs no stored secret and survives reinstall (D10); the party token is the
 * fallback for signed-out phones. Neither → TabAuthUnavailableError, which
 * sync records on the link and skips.
 */
export async function resolveTabAuth(link: TabLink): Promise<TabAuth> {
  const jwt = await getSessionJWT().catch(() => null);
  if (jwt) return { jwt, role: link.role };
  if (link.party_token) return { token: link.party_token };
  throw new TabAuthUnavailableError();
}

/** POST /v1/tabs — the caller becomes party a. Anonymous when signed out
 *  (the response's my_token is then the only credential; store it). */
export async function createTab(req: CreateRequest): Promise<CreateResponse> {
  return request<CreateResponse>("POST", "/v1/tabs", await optionalJwt(), req);
}

/** GET /v1/tabs/mine — every tab a party of which is bound to this account or
 *  one of its kaatas. JWT only. */
export async function fetchMine(): Promise<MineResponse> {
  return request<MineResponse>("GET", "/v1/tabs/mine", await requireJwt());
}

/** GET /v1/tabs/{id}?after_rev=N — entries with rev > N; full when N is 0. */
export async function fetchTab(
  auth: TabAuth,
  tabId: string,
  afterRev: number,
): Promise<TabResponse> {
  // Always explicit, even for 0: the access log then shows a full pull as
  // `after_rev=0` rather than as a bare GET that looks like a cursorless read.
  const q = `?after_rev=${encodeURIComponent(String(Math.max(0, afterRev)))}`;
  return request<TabResponse>("GET", `/v1/tabs/${encodeURIComponent(tabId)}${q}`, auth);
}

/** Token-only resolution of a deep link / invite URL to its tab, full state. */
export async function fetchTabByToken(
  token: string,
): Promise<{ tab: WireTab; entries: WireEntry[] }> {
  const resp = await request<TabResponse>("GET", BY_TOKEN_PATH, { token });
  return { tab: resp.tab, entries: resp.entries };
}

/** POST /v1/tabs/{id}/join — party b's first contact; idempotent re-join updates the label. */
export async function joinTab(
  auth: TabAuth,
  tabId: string,
  req: JoinRequest,
): Promise<TabResponse> {
  if ("token" in auth) {
    const session = await optionalJwt();
    if (session) {
      return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/join`, session, {
        ...req,
        token: auth.token,
      });
    }
  }
  return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/join`, auth, req);
}

/** POST /v1/tabs/{id}/bind — attach the signed-in account (+ kaata + contact)
 *  to the party the token identifies. JWT in the header, token in the body. */
export async function bindTab(
  token: string,
  tabId: string,
  body: { vault_id: string | null; relationship_id: string | null; linked_at_ms?: number },
): Promise<TabResponse> {
  return request<TabResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/bind`,
    await requireJwt(),
    {
      token,
      ...body,
    },
  );
}

/** POST /v1/tabs/{id}/label — rename how this party appears to the other side. */
export async function setTabLabel(
  auth: TabAuth,
  tabId: string,
  label: string,
): Promise<TabResponse> {
  return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/label`, auth, {
    label,
  });
}

/** POST /v1/tabs/{id}/entries — 201, or 200 when the id was already appended
 *  by this party (idempotent replay after a lost ack). */
export async function appendTabEntry(
  auth: TabAuth,
  tabId: string,
  req: AppendRequest,
): Promise<EntryResponse> {
  return request<EntryResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/entries`, auth, req);
}

/** POST /v1/tabs/{id}/entries/{entryId}/accept — only the OTHER party may. */
export async function acceptTabEntry(
  auth: TabAuth,
  tabId: string,
  entryId: string,
): Promise<EntryResponse> {
  return request<EntryResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/entries/${encodeURIComponent(entryId)}/accept`,
    auth,
    {},
  );
}

/** POST /v1/tabs/{id}/entries/{entryId}/dispute — reason ≤ 300 chars, required. */
export async function disputeTabEntry(
  auth: TabAuth,
  tabId: string,
  entryId: string,
  reason: string,
): Promise<EntryResponse> {
  return request<EntryResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/entries/${encodeURIComponent(entryId)}/dispute`,
    auth,
    { reason },
  );
}

/** POST /v1/tabs/{id}/entries/{entryId}/void — author only; returns the
 *  struck original AND the new void row. */
export async function voidTabEntry(
  auth: TabAuth,
  tabId: string,
  entryId: string,
): Promise<VoidResponse> {
  return request<VoidResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/entries/${encodeURIComponent(entryId)}/void`,
    auth,
    {},
  );
}

/** POST /v1/tabs/{id}/close — either party; every later write is 409 tab_closed. */
export async function closeTab(auth: TabAuth, tabId: string): Promise<TabResponse> {
  return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/close`, auth, {});
}

/** POST /v1/tabs/{id}/regenerate-link — party a only; B's old link dies. */
export async function regenerateTabLink(
  auth: TabAuth,
  tabId: string,
): Promise<{ invite_url: string }> {
  return request<{ invite_url: string }>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/regenerate-link`,
    auth,
    {},
  );
}

export async function registerTabNotifications(
  auth: TabAuth,
  tabId: string,
  body: { install_id: string; token: string; locale: string },
): Promise<{ enabled: boolean }> {
  return request("POST", `/v1/tabs/${encodeURIComponent(tabId)}/notifications`, auth, body);
}
