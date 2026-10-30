// apps/mobile/lib/tabs/api.ts
//
// App-only shared accounts use a session JWT for every server request.
// The invitation token rides in a POST body alongside that JWT on preview,
// join and legacy-party binding. It is not ongoing read/write authority.
//
// Every failure is a TabApiError: transport failures use status 0 with code
// "timeout" / "network", so callers have one type to switch on and
// isRetryableTabError (lib/tabs/errors.ts) one table to consult.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { ensureCurrencySyncSupported } from "../currency-sync";
import { TabApiError, TabAuthUnavailableError } from "./errors";
import { isNotificationOnlyMode, isTabRecordingMode } from "./recording-mode";
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
  SettlementResponse,
  TabRecordingMode,
  TabGroupResponse,
  CreateTabGroupRequest,
  JoinTabGroupRequest,
  GroupCurrencyRequest,
} from "./types";

export { TabApiError, TabAuthUnavailableError } from "./errors";
export { minorToWire, wireToMinor } from "./wire";

// Same budget as lib/vault-api.ts; the sync loop's per-op backoff sits on
// top of it, so this only has to be longer than a slow Afghan 3G round trip.
const TIMEOUT_MS = 15_000;

/** Token→tab resolution for the join flow. See the header note. */
const BY_TOKEN_PATH = "/v1/tabs/by-token";

/** Read/write authority always comes from the signed-in account. */
export type TabAuth = {
  jwt: string;
  groupId?: string;
  role?: TabLink["role"];
  recordingMode?: TabRecordingMode;
  requireRecordingSupport?: boolean;
  recordingKnown?: boolean;
};

// Foreground pulls run every few seconds. Share a short positive read receipt
// across contacts; every mutation still probes the current server separately.
const recordingReadSupport = new Map<string, number>();
const recordingReadProbes = new Map<string, Promise<void>>();
function recordingSupportKey(baseUrl: string, auth: TabAuth | null, oneWay = false): string {
  return `${baseUrl}\n${auth?.jwt ?? ""}\n${oneWay ? "one-way" : "notify"}`;
}
async function requireRecordingSupport(
  baseUrl: string,
  auth: TabAuth | null,
  headers: Record<string, string>,
  signal: AbortSignal,
  fresh: boolean,
  oneWay: boolean,
): Promise<void> {
  const key = recordingSupportKey(baseUrl, auth, oneWay);
  if (!fresh && (recordingReadSupport.get(key) ?? 0) > Date.now()) return;
  const active = !fresh ? recordingReadProbes.get(key) : undefined;
  if (active) return active;
  const probe = (async () => {
    const response = await fetch(`${baseUrl}/v1/sync/capabilities`, { headers, signal });
    const support = response.ok ? await response.json() : null;
    if (
      support?.notification_only_tallies !== true ||
      (oneWay && support?.one_way_tallies !== true)
    ) {
      recordingReadSupport.delete(key);
      throw new TabApiError(
        503,
        oneWay ? "one_way_tallies_unsupported" : "notification_only_unsupported",
        "This tally recording mode requires a server update",
      );
    }
    recordingReadSupport.set(key, Date.now() + 60_000);
    if (recordingReadSupport.size > 8)
      recordingReadSupport.delete(recordingReadSupport.keys().next().value!);
  })();
  if (!fresh) recordingReadProbes.set(key, probe);
  try {
    await probe;
  } finally {
    if (recordingReadProbes.get(key) === probe) recordingReadProbes.delete(key);
  }
}

function authorization(auth: TabAuth | null): string | null {
  if (!auth) return null;
  return `Bearer ${auth.jwt}`;
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  auth: TabAuth | null,
  body?: unknown,
): Promise<T> {
  const requestedMode =
    method === "POST" && (path === "/v1/tabs" || path === "/v1/tab-groups")
      ? (body as CreateRequest | undefined)?.recording_mode
      : auth?.recordingMode;
  if (requestedMode != null && !isTabRecordingMode(requestedMode))
    throw new TabApiError(426, "recording_upgrade_required", "Unknown shared tally recording mode");
  if (method === "POST" && auth?.recordingKnown === false)
    throw new TabApiError(
      503,
      "notification_only_unsupported",
      "Refresh the account recording mode before changing it",
    );
  const baseUrl = await getBackendUrl();
  const headers: Record<string, string> = {
    "X-Kaata-Currencies": "1",
    "X-Kaata-Tab-Recording": "1",
    "X-Kaata-Tab-One-Way": "1",
    "X-Kaata-Tab-Group": "1",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const authz = authorization(auth);
  if (authz) headers.Authorization = authz;
  if (auth && "jwt" in auth && auth.role) headers["X-Kaata-Party"] = auth.role;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    if (auth?.groupId) await ensureTabGroupSupport(auth);
    // A previous server accepts this payload but treats every currency as
    // the book's old default. Keep changes queued until support is known.
    if (method === "POST" && auth?.jwt)
      await ensureCurrencySyncSupported(baseUrl, auth.jwt, controller.signal);
    if (
      (method === "POST" && auth?.requireRecordingSupport) ||
      isNotificationOnlyMode(requestedMode)
    ) {
      await requireRecordingSupport(
        baseUrl,
        auth,
        headers,
        controller.signal,
        method === "POST",
        requestedMode === "notify_one_way",
      );
    }
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof TabApiError || err instanceof TabAuthUnavailableError) throw err;
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
    if (
      code === "recording_upgrade_required" ||
      code === "notification_only_unsupported" ||
      code === "one_way_tallies_unsupported"
    ) {
      recordingReadSupport.delete(recordingSupportKey(baseUrl, auth));
      recordingReadSupport.delete(recordingSupportKey(baseUrl, auth, true));
    }
    const retryAfterS = Number(res.headers?.get?.("Retry-After"));
    throw new TabApiError(
      res.status,
      code,
      `${method} ${path}: ${res.status}${serverMsg ? ` — ${serverMsg}` : ""}`,
      res.status === 429 && Number.isFinite(retryAfterS) && retryAfterS > 0
        ? retryAfterS * 1000
        : null,
    );
  }
  const payload = await res.json();
  const tabs = payload?.tab
    ? [payload.tab]
    : (payload?.tabs ?? []).map((item: { tab: WireTab }) => item.tab);
  if (
    auth?.groupId &&
    (tabs.length !== 1 || tabs.some((tab: WireTab) => tab.group_id !== auth.groupId))
  )
    throw new TabApiError(
      503,
      "shared_account_unsupported",
      "The shared account metadata is unavailable",
    );
  if (
    tabs.some(
      (tab: WireTab) => tab.recording_mode != null && !isTabRecordingMode(tab.recording_mode),
    )
  )
    throw new TabApiError(426, "recording_upgrade_required", "Unknown shared tally recording mode");
  if (
    payload?.tab &&
    auth?.recordingKnown !== false &&
    isNotificationOnlyMode(requestedMode) &&
    payload.tab.recording_mode !== requestedMode
  )
    throw new TabApiError(
      503,
      requestedMode === "notify_one_way"
        ? "one_way_tallies_unsupported"
        : "notification_only_unsupported",
      "A response cannot change this shared account's recording mode",
    );
  return payload as T;
}

async function requireJwt(): Promise<TabAuth> {
  const jwt = await getSessionJWT().catch(() => null);
  if (!jwt) throw new TabAuthUnavailableError();
  return { jwt };
}

/**
 * Credential for talking to `link`'s tab. The JWT wins when present because it
 * needs no stored secret and survives reinstall; the party token is
 * retained only for legacy-party claim. Signed out → TabAuthUnavailableError, which
 * sync records on the link and skips.
 */
export async function resolveTabAuth(link: TabLink): Promise<TabAuth> {
  const jwt = await getSessionJWT().catch(() => null);
  if (jwt)
    return {
      jwt,
      ...(link.group_id ? { groupId: link.group_id } : {}),
      role: link.role,
      recordingMode: link.recording_mode ?? "review",
      recordingKnown: link.recording_mode_known !== 0,
    };
  throw new TabAuthUnavailableError();
}

/** POST /v1/tabs — authenticated caller becomes party a. */
export async function createTab(req: CreateRequest, auth?: TabAuth): Promise<CreateResponse> {
  return request<CreateResponse>("POST", "/v1/tabs", auth ?? (await requireJwt()), req);
}

export async function ensureTabGroupSupport(auth?: TabAuth): Promise<void> {
  const credentials = auth ?? (await requireJwt());
  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const probe = await fetch(`${baseUrl}/v1/sync/capabilities`, {
      headers: { Authorization: `Bearer ${credentials.jwt}`, "X-Kaata-Tab-Group": "1" },
      signal: controller.signal,
    });
    if (probe.status === 401) throw new TabAuthUnavailableError();
    const capabilities = probe.ok ? await probe.json() : null;
    if (capabilities?.multi_currency_tabs !== true)
      throw new TabApiError(
        503,
        "shared_account_unsupported",
        "Multi-currency sharing requires a server update",
      );
  } catch (error) {
    if (error instanceof TabApiError || error instanceof TabAuthUnavailableError) throw error;
    throw new TabApiError(0, "network", "Unable to check multi-currency sharing support");
  } finally {
    clearTimeout(timeout);
  }
}

async function requestGroup(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  auth?: TabAuth,
): Promise<TabGroupResponse> {
  const credentials = auth ?? (await requireJwt());
  await ensureTabGroupSupport(credentials);
  const result = await request<TabGroupResponse>(method, path, credentials, body);
  const group = result?.group;
  const requestedMode =
    (body as { recording_mode?: TabRecordingMode } | undefined)?.recording_mode ??
    credentials.recordingMode;
  const privatePreview = path === "/v1/tab-groups/by-token" && result?.tabs?.length === 0;
  if (
    !group?.id ||
    !Number.isSafeInteger(group.rev) ||
    group.rev < 0 ||
    !isTabRecordingMode(group.recording_mode) ||
    !group.parties?.a ||
    !group.parties?.b ||
    (requestedMode != null && group.recording_mode !== requestedMode) ||
    (group.you !== "a" && group.you !== "b") ||
    !Array.isArray(group.currencies) ||
    group.currencies.length === 0 ||
    !Array.isArray(result.tabs) ||
    (!privatePreview && result.tabs.length !== group.currencies.length) ||
    new Set(group.currencies).size !== group.currencies.length ||
    group.currencies.some((currency) => !/^[A-Z]{3}$/.test(currency)) ||
    new Set(result.tabs.map((item) => item.tab?.currency)).size !== result.tabs.length ||
    result.tabs.some(
      (item) =>
        !item.tab ||
        item.tab.group_id !== group.id ||
        item.tab.you !== group.you ||
        item.tab.recording_mode !== group.recording_mode ||
        !group.currencies.includes(item.tab.currency) ||
        item.full !== true ||
        !Array.isArray(item.entries),
    )
  )
    throw new TabApiError(
      503,
      "shared_account_invalid",
      "Incomplete multi-currency account response",
    );
  return result;
}

export const createTabGroup = (body: CreateTabGroupRequest, auth?: TabAuth) =>
  requestGroup("POST", "/v1/tab-groups", body, auth);
export const fetchTabGroupByToken = (token: string) =>
  requestGroup("POST", "/v1/tab-groups/by-token", { token: token.replace(/^g_/, "") });
export const fetchTabGroup = (groupId: string, auth?: TabAuth) =>
  requestGroup("GET", `/v1/tab-groups/${encodeURIComponent(groupId)}`, undefined, auth);
export const joinTabGroup = (groupId: string, body: JoinTabGroupRequest, auth?: TabAuth) =>
  requestGroup("POST", `/v1/tab-groups/${encodeURIComponent(groupId)}/join`, body, auth);
export const ensureTabGroupCurrency = (
  groupId: string,
  body: GroupCurrencyRequest,
  auth?: TabAuth,
) => requestGroup("POST", `/v1/tab-groups/${encodeURIComponent(groupId)}/currencies`, body, auth);
export const closeTabGroup = (groupId: string, auth?: TabAuth) =>
  requestGroup(
    "POST",
    `/v1/tab-groups/${encodeURIComponent(groupId)}/close`,
    { withdraw_unjoined_opening: true },
    auth,
  );
export const regenerateTabGroupLink = (groupId: string, auth?: TabAuth) =>
  requestGroup("POST", `/v1/tab-groups/${encodeURIComponent(groupId)}/regenerate-link`, {}, auth);

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

/** Signed-in preview of an invitation; possession alone is not authority. */
export async function fetchTabByToken(
  token: string,
): Promise<{ tab: WireTab; entries: WireEntry[] }> {
  const resp = await request<TabResponse>("POST", BY_TOKEN_PATH, await requireJwt(), { token });
  return { tab: resp.tab, entries: resp.entries };
}

/** POST /v1/tabs/{id}/join — party b's first contact; idempotent re-join updates the label. */
export async function joinTab(
  auth:
    | TabAuth
    | {
        token: string;
        jwt?: string;
        recordingMode?: TabRecordingMode;
        requireRecordingSupport?: boolean;
      },
  tabId: string,
  req: JoinRequest,
): Promise<TabResponse> {
  if ("token" in auth) {
    const session = {
      ...(auth.jwt ? { jwt: auth.jwt } : await requireJwt()),
      recordingMode: auth.recordingMode,
      requireRecordingSupport: auth.requireRecordingSupport,
    };
    return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/join`, session, {
      ...req,
      token: auth.token,
    });
  }
  return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/join`, auth, req);
}

/** POST /v1/tabs/{id}/bind — attach the signed-in account (+ kaata + contact)
 *  to the party the token identifies. JWT in the header, token in the body. */
export async function bindTab(
  token: string,
  tabId: string,
  body: {
    vault_id: string | null;
    relationship_id: string | null;
    linked_at_ms?: number;
    expected_previous_tab_id?: string | null;
    expected_previous_rev?: number;
    expected_history_revisions?: Record<string, number>;
  },
  recordingMode?: TabRecordingMode,
  recordingKnown = true,
): Promise<TabResponse> {
  return request<TabResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/bind`,
    { ...(await requireJwt()), recordingMode, recordingKnown },
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
  expectedRev?: number,
): Promise<EntryResponse> {
  return request<EntryResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/entries/${encodeURIComponent(entryId)}/accept`,
    auth,
    { expected_rev: expectedRev },
  );
}

/** POST /v1/tabs/{id}/entries/{entryId}/dispute — optional reason ≤ 300 chars. */
export async function disputeTabEntry(
  auth: TabAuth,
  tabId: string,
  entryId: string,
  reason: string,
  expectedRev?: number,
): Promise<EntryResponse> {
  return request<EntryResponse>(
    "POST",
    `/v1/tabs/${encodeURIComponent(tabId)}/entries/${encodeURIComponent(entryId)}/dispute`,
    auth,
    { reason, expected_rev: expectedRev },
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
export async function closeTab(
  auth: TabAuth,
  tabId: string,
  options: { withdraw_unjoined_opening?: boolean } = {},
): Promise<TabResponse> {
  return request<TabResponse>("POST", `/v1/tabs/${encodeURIComponent(tabId)}/close`, auth, options);
}

export async function settleTab(
  auth: TabAuth,
  tabId: string,
  id: string,
  expectedRev: number,
): Promise<SettlementResponse> {
  return request("POST", `/v1/tabs/${encodeURIComponent(tabId)}/settlements`, auth, {
    id,
    expected_rev: expectedRev,
  });
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
  body: {
    install_id: string;
    token: string;
    locale: string;
    preferences?: import("../notification-policy").NotificationPolicy;
  },
): Promise<{ enabled: boolean }> {
  // Credit alerts have their own delivery subscription. Older tab endpoints
  // reject unknown preference keys, so keep their existing wire contract.
  const preferences = body.preferences ? { ...body.preferences } : undefined;
  if (preferences) delete (preferences as Partial<typeof preferences>).credit_alerts;
  return request("POST", `/v1/tabs/${encodeURIComponent(tabId)}/notifications`, auth, {
    ...body,
    ...(preferences ? { preferences } : {}),
  });
}

export type InboxItem = {
  id: string;
  tab_id: string;
  role: TabLink["role"];
  rev: number;
  kind: string;
  entry_id: string;
  body: string;
  created_at_ms: number;
  read: boolean;
};
export type InboxPage = {
  items: InboxItem[];
  unread: number;
  latest_id: string;
  next_before: string;
};

export async function fetchInbox(locale: string, before = ""): Promise<InboxPage> {
  return request(
    "GET",
    `/v1/tabs/inbox?locale=${encodeURIComponent(locale)}&before=${encodeURIComponent(before)}`,
    await requireJwt(),
  );
}
/**
 * POST /v1/tabs/inbox/read — one notice by inbox id, everything up to an id
 * ("mark all"), or by what the client actually knows about the notice it
 * handled: the tally (every notice of that entry), one tab revision, or
 * every revision of a tab up to the one it has applied. The server answers
 * {ok, marked} and refuses nothing it cannot find (idempotent INSERT).
 */
export type InboxReadBody =
  | { id: string }
  | { through: string }
  | { tab_id: string; entry_id: string }
  | { tab_id: string; rev: number }
  | { tab_id: string; through_rev: number };

export async function markInboxRead(body: InboxReadBody): Promise<void> {
  await request("POST", "/v1/tabs/inbox/read", await requireJwt(), body);
}
