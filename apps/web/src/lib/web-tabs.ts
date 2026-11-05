import {
  getWebSession,
  isSameWebSession,
  webRequest,
  WebApiError,
  type WebSession,
} from "./web-auth";
import { hasPendingWebWrite, type WebLedger, type WebPerson } from "./web-ledger";

export type WebTabRole = "a" | "b";
export type WebTabRecordingMode = "review" | "notify" | "notify_one_way";
export type WebTabDirection = "a_to_b" | "b_to_a";
export type WebTabAccess = {
  append: boolean;
  review: boolean;
  void: boolean;
  settle: boolean;
  manage: boolean;
};
export type WebTabParty = {
  label: string;
  account_name?: string;
  phone?: string;
  bound: boolean;
  joined_at_ms: number | null;
  linked_at_ms?: number | null;
  history_order?: string | null;
};
export type WebTab = {
  id: string;
  group_id?: string | null;
  recording_mode: WebTabRecordingMode;
  currency: string;
  rev: number;
  created_at_ms: number;
  closed_at_ms: number | null;
  closed_by: WebTabRole | null;
  closed_reason?: string | null;
  you: WebTabRole;
  parties: Record<WebTabRole, WebTabParty>;
  balance: Record<WebTabRole, string>;
  recorded_balance: Record<WebTabRole, string>;
  confirmed_balance: Record<WebTabRole, string>;
  pending_balance?: Record<WebTabRole, string>;
  pending_for_you: number;
  unjoined_invitation: boolean;
  access?: WebTabAccess;
};
export type WebTabEntry = {
  id: string;
  seq: number;
  rev: number;
  created_by: WebTabRole;
  direction: WebTabDirection;
  amount: string;
  kind: "entry" | "opening" | "void";
  note: string | null;
  occurred_at_ms: number;
  created_at_ms: number;
  status: "pending" | "accepted" | "disputed" | "recorded";
  status_at_ms: number | null;
  dispute_reason: string | null;
  voids_entry_id: string | null;
  voided_by_entry_id: string | null;
  author_account_id?: string | null;
  author_name?: string;
  author_member_role?: string | null;
  reviewer_account_id?: string | null;
  reviewer_name?: string;
  reviewer_party?: WebTabRole | null;
  reviewer_member_role?: string | null;
  review_semantics_version?: string | null;
};
export type WebTabSettlement = {
  id: string;
  rev: number;
  through_seq: number;
  settled_at_ms: number;
  created_by: WebTabRole;
  actor_account_id: string | null;
  actor_name: string;
  actor_member_role: string | null;
  semantics_version: string;
};
export type WebTabResponse = {
  tab: WebTab;
  entries: WebTabEntry[];
  settlements?: WebTabSettlement[];
  full: boolean;
};
export type WebTabEntryResponse = {
  tab: WebTab;
  entry: WebTabEntry;
  duplicate_hint?: { entry_id: string; by: WebTabRole; at_ms: number } | null;
};
export type WebTabGroup = {
  id: string;
  recording_mode: WebTabRecordingMode;
  rev: number;
  created_at_ms: number;
  closed_at_ms: number | null;
  closed_by: WebTabRole | null;
  you: WebTabRole;
  currencies: string[];
  parties: Record<
    WebTabRole,
    WebTabParty & { vault_id: string | null; relationship_id: string | null }
  >;
};
export type WebTabGroupResponse = {
  group: WebTabGroup;
  tabs: WebTabResponse[];
  invite_url?: string;
};
export type WebSharedInvitation =
  | ({ kind: "group" } & WebTabGroupResponse)
  | ({ kind: "tab" } & WebTabResponse);
export type WebTabOpening = {
  direction: WebTabDirection;
  amount: string;
  note: string | null;
  occurred_at_ms: number;
};
export type WebSharedCurrency = {
  currency: string;
  opening: WebTabOpening | null;
  linked_at_ms: number;
  expected_previous_tab_id?: string;
  expected_previous_rev?: number;
  expected_history_revisions?: Record<string, number>;
};
export type WebTabAppend = {
  id: string;
  direction: WebTabDirection;
  amount: string;
  note: string | null;
  occurred_at_ms: number;
};
export type WebTabGroupDraft = {
  request_id: string;
  invite_token: string;
  label: string;
  recording_mode: WebTabRecordingMode;
  currencies?: WebSharedCurrency[];
};

export function findWebSharedInvitationContact(
  ledger: WebLedger,
  invitation: WebSharedInvitation | null,
): WebPerson | undefined {
  if (!invitation) return undefined;
  const metadata = invitation.kind === "group" ? invitation.group : invitation.tab;
  return ledger.people.find((person) =>
    person.shared?.tabs.some(
      (binding) =>
        binding.role === metadata.you &&
        (invitation.kind === "group"
          ? binding.group_id === metadata.id
          : binding.id === metadata.id),
    ),
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const WEB_TAB_HEADERS = {
  "X-Kaata-Currencies": "1",
  "X-Kaata-Tab-Recording": "1",
  "X-Kaata-Tab-One-Way": "1",
  "X-Kaata-Tab-Group": "1",
} as const;

function fail(code = "invalid_shared_response"): never {
  throw new WebApiError("Refresh this shared account and try again.", 503, code);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function id(value: string): string {
  if (!UUID.test(value)) fail("invalid_shared_id");
  return encodeURIComponent(value);
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function mode(value: unknown): value is WebTabRecordingMode {
  return value === "review" || value === "notify" || value === "notify_one_way";
}
function role(value: unknown): value is WebTabRole {
  return value === "a" || value === "b";
}
export function webSharedMinor(value: string): bigint {
  const parts = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!parts) fail("invalid_shared_amount");
  const minor = BigInt(parts[2]) * 100n + BigInt((parts[3] ?? "").padEnd(2, "0"));
  return parts[1] ? -minor : minor;
}
export function webSharedAmount(minor: bigint): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
function moneyPair(value: unknown) {
  const pair = object(value);
  for (const side of ["a", "b"]) {
    if (typeof pair[side] !== "string") fail();
    webSharedMinor(pair[side] as string);
  }
}
export function parseWebTab(raw: unknown): WebTab {
  const tab = object(raw);
  if (
    typeof tab.id !== "string" ||
    !UUID.test(tab.id) ||
    !mode(tab.recording_mode) ||
    !role(tab.you) ||
    typeof tab.currency !== "string" ||
    !/^[A-Z]{3}$/.test(tab.currency) ||
    !revision(tab.rev) ||
    !revision(tab.created_at_ms) ||
    !(tab.closed_at_ms === null || revision(tab.closed_at_ms)) ||
    !(tab.group_id == null || (typeof tab.group_id === "string" && UUID.test(tab.group_id))) ||
    !revision(tab.pending_for_you) ||
    typeof tab.unjoined_invitation !== "boolean"
  )
    fail();
  const parties = object(tab.parties);
  for (const side of ["a", "b"]) {
    const party = object(parties[side]);
    if (
      typeof party.label !== "string" ||
      typeof party.bound !== "boolean" ||
      !(party.joined_at_ms === null || revision(party.joined_at_ms)) ||
      !(party.linked_at_ms == null || revision(party.linked_at_ms)) ||
      !(
        party.history_order == null ||
        (typeof party.history_order === "string" && /^[1-9]\d*$/.test(party.history_order))
      )
    )
      fail();
  }
  moneyPair(tab.balance);
  moneyPair(tab.recorded_balance);
  moneyPair(tab.confirmed_balance);
  if (tab.pending_balance != null) moneyPair(tab.pending_balance);
  if (tab.access != null) {
    const access = object(tab.access);
    if (
      ["append", "review", "void", "settle", "manage"].some(
        (key) => typeof access[key] !== "boolean",
      )
    )
      fail();
  }
  return tab as WebTab;
}
export function parseWebTabEntry(raw: unknown): WebTabEntry {
  const entry = object(raw);
  if (
    typeof entry.id !== "string" ||
    !UUID.test(entry.id) ||
    !revision(entry.seq) ||
    !revision(entry.rev) ||
    !role(entry.created_by) ||
    !["a_to_b", "b_to_a"].includes(String(entry.direction)) ||
    !["entry", "opening", "void"].includes(String(entry.kind)) ||
    !["pending", "accepted", "disputed", "recorded"].includes(String(entry.status)) ||
    typeof entry.amount !== "string" ||
    webSharedMinor(entry.amount) <= 0n ||
    !revision(entry.occurred_at_ms) ||
    !revision(entry.created_at_ms) ||
    !(entry.note === null || typeof entry.note === "string") ||
    !(
      entry.voided_by_entry_id === null ||
      (typeof entry.voided_by_entry_id === "string" && UUID.test(entry.voided_by_entry_id))
    )
  )
    fail();
  return entry as WebTabEntry;
}
export function parseWebTabResponse(raw: unknown): WebTabResponse {
  const response = object(raw);
  const tab = parseWebTab(response.tab);
  if (response.full !== true || !Array.isArray(response.entries))
    fail("shared_history_refresh_required");
  const entries = response.entries.map(parseWebTabEntry);
  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    entries.some((entry) => entry.rev > tab.rev)
  )
    fail();
  if (response.settlements != null && !Array.isArray(response.settlements)) fail();
  const settlements = (response.settlements ?? []) as unknown[];
  for (const raw of settlements) {
    const marker = object(raw);
    if (
      typeof marker.id !== "string" ||
      !UUID.test(marker.id) ||
      !revision(marker.rev) ||
      marker.rev > tab.rev ||
      !revision(marker.through_seq) ||
      !revision(marker.settled_at_ms) ||
      !role(marker.created_by) ||
      typeof marker.actor_name !== "string" ||
      typeof marker.semantics_version !== "string"
    )
      fail();
  }
  return { tab, entries, settlements: settlements as WebTabSettlement[], full: true };
}

function capture(): WebSession {
  const current = getWebSession();
  if (!current) throw new WebApiError("Sign in again.", 401, "session_expired");
  return current;
}
function assertCurrent(session: WebSession, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!isSameWebSession(getWebSession(), session))
    throw new WebApiError("The account changed.", 401, "session_changed");
}
async function request<T>(
  path: string,
  options: {
    session: WebSession;
    signal?: AbortSignal;
    body?: unknown;
    tab?: WebTab;
    group?: boolean;
    mutation?: boolean;
    recordingMode?: WebTabRecordingMode;
  },
): Promise<T> {
  const { session, signal, tab } = options;
  assertCurrent(session, signal);
  const headers = { ...WEB_TAB_HEADERS, ...(tab ? { "X-Kaata-Party": tab.you } : {}) };
  const recordingMode = options.recordingMode ?? tab?.recording_mode;
  if (recordingMode != null && !mode(recordingMode)) fail("recording_upgrade_required");
  if (options.mutation) {
    const capabilities = object(await webRequest("/v1/sync/capabilities", { headers, signal }));
    assertCurrent(session, signal);
    if (capabilities.multi_currency !== true) fail("currency_upgrade_required");
    if ((options.group || tab?.group_id) && capabilities.multi_currency_tabs !== true)
      fail("shared_account_unsupported");
    if (recordingMode !== "review" && capabilities.notification_only_tallies !== true)
      fail("notification_only_unsupported");
    if (recordingMode === "notify_one_way" && capabilities.one_way_tallies !== true)
      fail("one_way_tallies_unsupported");
  }
  const result = await webRequest<T>(path, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    signal,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  assertCurrent(session, signal);
  return result;
}
function assertTabMatch(tab: WebTab, expected: Pick<WebTab, "id" | "you"> & Partial<WebTab>) {
  if (
    tab.id !== expected.id ||
    tab.you !== expected.you ||
    (expected.group_id && tab.group_id !== expected.group_id) ||
    (expected.recording_mode && tab.recording_mode !== expected.recording_mode) ||
    (expected.currency && tab.currency !== expected.currency)
  )
    fail();
}
export async function fetchWebTab(
  tabID: string,
  party: WebTabRole,
  signal?: AbortSignal,
): Promise<WebTabResponse> {
  if (!role(party)) fail();
  const session = capture();
  const result = parseWebTabResponse(
    await request(`/v1/tabs/${id(tabID)}?after_rev=0`, {
      session,
      signal,
      tab: { you: party } as WebTab,
    }),
  );
  assertTabMatch(result.tab, { id: tabID, you: party });
  return result;
}
export async function loadWebSharedTabs(
  ledger: WebLedger,
  person: WebPerson,
  signal?: AbortSignal,
): Promise<WebTabResponse[]> {
  const session = capture();
  const bindings = person.shared?.tabs ?? [];
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length) fail();
  const results = await Promise.all(
    bindings.map(async (binding) => {
      const result = await fetchWebTab(binding.id, binding.role, signal);
      assertTabMatch(result.tab, { ...binding, you: binding.role });
      return result;
    }),
  );
  assertCurrent(session, signal);
  if (!ledger.people.some((item) => item.relationship_id === person.relationship_id)) fail();
  return results.sort((left, right) => {
    const currency = left.tab.currency.localeCompare(right.tab.currency);
    if (currency) return currency;
    const a = BigInt(left.tab.parties[left.tab.you].history_order ?? "0");
    const b = BigInt(right.tab.parties[right.tab.you].history_order ?? "0");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
function writeAllowed(tab: WebTab, action: keyof WebTabAccess) {
  parseWebTab(tab);
  if (tab.access?.[action] !== true)
    throw new WebApiError("This action is unavailable.", 403, "role_insufficient");
}
async function entryAction(
  tab: WebTab,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<WebTabEntryResponse> {
  const result = object(
    await request(`/v1/tabs/${id(tab.id)}/${path}`, {
      session: capture(),
      signal,
      body,
      tab,
      mutation: true,
    }),
  );
  const fresh = parseWebTab(result.tab);
  assertTabMatch(fresh, tab);
  return { ...result, tab: fresh, entry: parseWebTabEntry(result.entry) } as WebTabEntryResponse;
}
export async function appendWebTabEntry(tab: WebTab, input: WebTabAppend, signal?: AbortSignal) {
  writeAllowed(tab, "append");
  id(input.id);
  if (
    webSharedMinor(input.amount) <= 0n ||
    webSharedMinor(input.amount) > 999999999999n ||
    !revision(input.occurred_at_ms) ||
    !["a_to_b", "b_to_a"].includes(input.direction) ||
    (input.note != null && Array.from(input.note.trim()).length > 500)
  )
    fail("invalid_shared_entry");
  const result = await entryAction(tab, "entries", input, signal);
  if (result.entry.id !== input.id) fail();
  return result;
}
export function acceptWebTabEntry(
  tab: WebTab,
  entryID: string,
  expectedRev: number,
  signal?: AbortSignal,
) {
  writeAllowed(tab, "review");
  if (!revision(expectedRev) || expectedRev === 0) fail("invalid_shared_revision");
  return entryAction(tab, `entries/${id(entryID)}/accept`, { expected_rev: expectedRev }, signal);
}
export function disputeWebTabEntry(
  tab: WebTab,
  entryID: string,
  reason: string,
  expectedRev: number,
  signal?: AbortSignal,
) {
  writeAllowed(tab, "review");
  const trimmed = reason.trim();
  if (!revision(expectedRev) || expectedRev === 0 || Array.from(trimmed).length > 300)
    fail("invalid_shared_revision");
  return entryAction(
    tab,
    `entries/${id(entryID)}/dispute`,
    { expected_rev: expectedRev, reason: trimmed },
    signal,
  );
}
export async function voidWebTabEntry(
  tab: WebTab,
  entryID: string,
  signal?: AbortSignal,
): Promise<{ voided: WebTabEntry; void: WebTabEntry }> {
  writeAllowed(tab, "void");
  const result = object(
    await request(`/v1/tabs/${id(tab.id)}/entries/${id(entryID)}/void`, {
      session: capture(),
      signal,
      body: {},
      tab,
      mutation: true,
    }),
  );
  const voided = parseWebTabEntry(result.voided),
    cancellation = parseWebTabEntry(result.void);
  if (
    voided.id !== entryID ||
    cancellation.voids_entry_id !== entryID ||
    voided.voided_by_entry_id !== cancellation.id
  )
    fail();
  return { voided, void: cancellation };
}
export async function settleWebTab(tab: WebTab, actionID: string, signal?: AbortSignal) {
  writeAllowed(tab, "settle");
  id(actionID);
  const result = object(
    await request(`/v1/tabs/${id(tab.id)}/settlements`, {
      session: capture(),
      signal,
      body: { id: actionID, expected_rev: tab.rev },
      tab,
      mutation: true,
    }),
  );
  const fresh = parseWebTab(result.tab);
  assertTabMatch(fresh, tab);
  const marker = object(result.settlement);
  if (
    marker.id !== actionID ||
    !revision(marker.rev) ||
    !revision(marker.through_seq) ||
    !revision(marker.settled_at_ms)
  )
    fail();
  return { tab: fresh, settlement: marker as WebTabSettlement };
}

export async function prepareWebSharedCurrencies(
  ledger: WebLedger,
  person: WebPerson,
  signal?: AbortSignal,
): Promise<WebSharedCurrency[]> {
  const session = capture();
  if (
    ledger.archived_at_ms != null ||
    person.archived_at != null ||
    !["owner", "manager"].includes(ledger.role)
  )
    throw new WebApiError("Only a kaata manager can share this account.", 403, "role_insufficient");
  if (hasPendingWebWrite()) fail("shared_account_source_unsynced");
  let periods = await loadWebSharedTabs(ledger, person, signal);
  if (periods.some(({ tab }) => tab.closed_at_ms == null)) fail("shared_account_already_linked");
  // Older clients could close an unused invitation while leaving its copied
  // opening pending. The server rechecks participation before withdrawing it.
  const cleanedGroups = new Set<string>();
  for (const period of periods) {
    if (
      period.tab.you !== "a" ||
      !period.tab.unjoined_invitation ||
      !period.entries.some(
        (entry) =>
          entry.kind === "opening" &&
          entry.status === "pending" &&
          entry.voided_by_entry_id == null,
      )
    )
      continue;
    const key = period.tab.group_id ?? period.tab.id;
    if (cleanedGroups.has(key)) continue;
    await withdrawClosedInvitation(period, session, signal);
    cleanedGroups.add(key);
  }
  if (cleanedGroups.size) periods = await loadWebSharedTabs(ledger, person, signal);
  if (
    periods.some(({ entries }) =>
      entries.some(
        (entry) =>
          entry.kind !== "void" && entry.voided_by_entry_id == null && entry.status === "pending",
      ),
    )
  )
    fail("shared_history_pending");
  const privateRows = ledger.entries.filter(
    (entry) =>
      entry.relationship_id === person.relationship_id &&
      !entry.is_deleted &&
      entry.disputed_at == null,
  );
  const currencies = [
    ...new Set([
      ...ledger.enabled_currencies,
      ...privateRows.map((entry) => entry.currency),
      ...(person.shared?.tabs.map((tab) => tab.currency) ?? []),
    ]),
  ].sort();
  const linkedAt = Date.now();
  return currencies.map((currency) => {
    const history = periods.filter(({ tab }) => tab.currency === currency);
    const orders = history.map(({ tab }) => tab.parties[tab.you].history_order);
    if (
      history.length > 0 &&
      (orders.some((order) => !order) || new Set(orders).size !== orders.length)
    )
      fail("shared_history_refresh_required");
    const previous = history.at(-1)?.tab;
    let balance = 0n;
    if (person.shared) {
      const summary = person.shared.balances.find((row) => row.currency === currency);
      if (!summary && history.length) fail("shared_history_refresh_required");
      if (summary) balance = webSharedMinor(summary.recorded);
      else
        balance = privateRows
          .filter((row) => row.currency === currency)
          .reduce(
            (sum, row) => sum + webSharedMinor(row.amount_afn) * (row.type === "debt" ? 1n : -1n),
            0n,
          );
    } else
      balance = privateRows
        .filter((row) => row.currency === currency)
        .reduce(
          (sum, row) => sum + webSharedMinor(row.amount_afn) * (row.type === "debt" ? 1n : -1n),
          0n,
        );
    return {
      currency,
      linked_at_ms: linkedAt,
      opening:
        balance === 0n
          ? null
          : {
              direction: balance > 0n ? "a_to_b" : "b_to_a",
              amount: webSharedAmount(balance < 0n ? -balance : balance),
              note: null,
              occurred_at_ms: linkedAt,
            },
      ...(previous
        ? {
            expected_previous_tab_id: previous.id,
            expected_previous_rev: previous.rev,
            expected_history_revisions: Object.fromEntries(
              history.map(({ tab }) => [tab.id, tab.rev]),
            ),
          }
        : {}),
    };
  });
}

async function withdrawClosedInvitation(
  period: WebTabResponse,
  session: WebSession,
  signal?: AbortSignal,
): Promise<void> {
  const tab = parseWebTab(period.tab);
  if (
    tab.you !== "a" ||
    tab.closed_at_ms == null ||
    !tab.unjoined_invitation ||
    !period.entries.some(
      (entry) =>
        entry.kind === "opening" && entry.status === "pending" && entry.voided_by_entry_id == null,
    )
  )
    fail("shared_history_pending");
  // Closed views intentionally expose no manage actions. This narrow repair
  // only withdraws a copied opening after the server rechecks participation.
  const path = tab.group_id
    ? `/v1/tab-groups/${id(tab.group_id)}/close`
    : `/v1/tabs/${id(tab.id)}/close`;
  const result = await request(path, {
    session,
    signal,
    tab,
    mutation: true,
    body: { withdraw_unjoined_opening: true },
  });
  if (tab.group_id) {
    const repaired = parseGroup(result);
    if (repaired.group.id !== tab.group_id || repaired.group.you !== tab.you) fail();
  } else assertTabMatch(parseWebTabResponse(result).tab, tab);
}
export function newWebTabGroupDraft(
  label: string,
  recordingMode: WebTabRecordingMode,
): WebTabGroupDraft {
  if (!mode(recordingMode)) fail("recording_upgrade_required");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return {
    request_id: crypto.randomUUID(),
    invite_token: token,
    label: label.trim(),
    recording_mode: recordingMode,
  };
}
function parseGroup(raw: unknown, preview = false): WebTabGroupResponse {
  const result = object(raw),
    group = object(result.group);
  if (
    typeof group.id !== "string" ||
    !UUID.test(group.id) ||
    !mode(group.recording_mode) ||
    !role(group.you) ||
    !revision(group.rev) ||
    !Array.isArray(group.currencies) ||
    !group.currencies.length ||
    group.currencies.some(
      (currency) => typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency),
    ) ||
    new Set(group.currencies).size !== group.currencies.length ||
    !Array.isArray(result.tabs)
  )
    fail();
  const tabs = result.tabs.map(parseWebTabResponse);
  if (
    !(preview && tabs.length === 0) &&
    (tabs.length !== group.currencies.length ||
      new Set(tabs.map(({ tab }) => tab.currency)).size !== tabs.length)
  )
    fail();
  const currencies = group.currencies as string[];
  if (
    tabs.some(
      ({ tab }) =>
        tab.group_id !== group.id ||
        tab.you !== group.you ||
        tab.recording_mode !== group.recording_mode ||
        !currencies.includes(tab.currency),
    )
  )
    fail();
  return {
    group: group as WebTabGroup,
    tabs,
    ...(typeof result.invite_url === "string" ? { invite_url: result.invite_url } : {}),
  };
}
export async function createWebTabGroup(
  ledger: WebLedger,
  person: WebPerson,
  draft: WebTabGroupDraft,
  signal?: AbortSignal,
): Promise<WebTabGroupResponse> {
  const session = capture();
  id(draft.request_id);
  // Preserve the entire creation payload, including the source boundary, for
  // retries after a lost response. The server hashes it under request_id.
  const currencies = draft.currencies ?? (await prepareWebSharedCurrencies(ledger, person, signal));
  assertCurrent(session, signal);
  draft.currencies = currencies;
  const response = parseGroup(
    await request("/v1/tab-groups", {
      session,
      signal,
      group: true,
      mutation: true,
      recordingMode: draft.recording_mode,
      body: {
        ...draft,
        vault_id: ledger.vault_id,
        relationship_id: person.relationship_id,
        currencies,
      },
    }),
  );
  const binding = response.group.parties?.[response.group.you];
  if (
    response.group.id !== draft.request_id ||
    response.group.recording_mode !== draft.recording_mode ||
    binding?.vault_id !== ledger.vault_id ||
    binding.relationship_id !== person.relationship_id
  )
    fail();
  return response;
}
export async function previewWebSharedInvitation(
  token: string,
  signal?: AbortSignal,
): Promise<WebSharedInvitation> {
  const session = capture();
  if (token.startsWith("g_"))
    return {
      kind: "group",
      ...parseGroup(
        await request("/v1/tab-groups/by-token", { session, signal, body: { token } }),
        true,
      ),
    };
  return {
    kind: "tab",
    ...parseWebTabResponse(
      await request("/v1/tabs/by-token", { session, signal, body: { token } }),
    ),
  };
}
export async function joinWebSharedInvitation(
  invitation: WebSharedInvitation,
  token: string,
  ledger: WebLedger,
  person: WebPerson,
  label: string,
  signal?: AbortSignal,
) {
  const session = capture();
  const metadata = invitation.kind === "group" ? invitation.group : invitation.tab;
  if (metadata.closed_at_ms != null)
    throw new WebApiError("This shared account is closed.", 409, "tab_closed");
  const expectedID = invitation.kind === "group" ? invitation.group.id : invitation.tab.id;
  const expectedRole = invitation.kind === "group" ? invitation.group.you : invitation.tab.you;
  const existing = person.shared?.tabs.find(
    (binding) =>
      (invitation.kind === "group" ? binding.group_id === expectedID : binding.id === expectedID) &&
      binding.role === expectedRole,
  );
  // A committed join with a lost reply is recovered from its proven local
  // binding, without treating that same live account as a conflicting link.
  if (existing) {
    if (invitation.kind === "tab") return fetchWebTab(existing.id, existing.role, signal);
    return parseGroup(
      await request(`/v1/tab-groups/${id(expectedID)}`, {
        session,
        signal,
        tab: { you: existing.role } as WebTab,
      }),
    );
  }
  const all = await prepareWebSharedCurrencies(ledger, person, signal);
  const group = invitation.kind === "group";
  const currencies = group ? invitation.group.currencies : [invitation.tab.currency];
  if (
    metadata.recording_mode === "review" &&
    all.some((item) => currencies.includes(item.currency) && item.opening != null)
  )
    throw new WebApiError(
      "Review sharing needs an empty recipient balance.",
      409,
      "shared_account_currency_history",
    );
  const prepared = currencies.map((currency) => {
    const prior = all.find((item) => item.currency === currency);
    return prior ? { ...prior, opening: undefined } : { currency, linked_at_ms: Date.now() };
  });
  const mode = group ? invitation.group.recording_mode : invitation.tab.recording_mode;
  const body = {
    token,
    label: label.trim(),
    vault_id: ledger.vault_id,
    relationship_id: person.relationship_id,
  };
  if (group)
    return parseGroup(
      await request(`/v1/tab-groups/${id(invitation.group.id)}/join`, {
        session,
        signal,
        group: true,
        mutation: true,
        recordingMode: mode,
        body: { ...body, currencies: prepared },
      }),
    );
  return parseWebTabResponse(
    await request(`/v1/tabs/${id(invitation.tab.id)}/join`, {
      session,
      signal,
      mutation: true,
      recordingMode: mode,
      body: { ...body, ...prepared[0] },
    }),
  );
}
export async function closeWebSharedAccount(
  tab: WebTab,
  signal?: AbortSignal,
): Promise<WebTabGroupResponse | WebTabResponse> {
  writeAllowed(tab, "manage");
  const path = tab.group_id
    ? `/v1/tab-groups/${id(tab.group_id)}/close`
    : `/v1/tabs/${id(tab.id)}/close`;
  const response = await request(path, {
    session: capture(),
    signal,
    tab,
    mutation: true,
    body: { withdraw_unjoined_opening: true },
  });
  return tab.group_id ? parseGroup(response) : parseWebTabResponse(response);
}
export async function regenerateWebSharedLink(
  tab: WebTab,
  signal?: AbortSignal,
): Promise<{ invite_url: string }> {
  writeAllowed(tab, "manage");
  const path = tab.group_id
    ? `/v1/tab-groups/${id(tab.group_id)}/regenerate-link`
    : `/v1/tabs/${id(tab.id)}/regenerate-link`;
  const result = object(
    await request(path, { session: capture(), signal, tab, mutation: true, body: {} }),
  );
  if (typeof result.invite_url !== "string") fail();
  return { invite_url: result.invite_url };
}
export async function ensureWebTabCurrency(
  tab: WebTab,
  ledger: WebLedger,
  person: WebPerson,
  currency: string,
  signal?: AbortSignal,
): Promise<WebTabGroupResponse> {
  const session = capture();
  writeAllowed(tab, "manage");
  if (!tab.group_id || !/^[A-Z]{3}$/.test(currency)) fail("shared_account_invalid");
  const history = person.shared?.tabs.filter((binding) => binding.currency === currency) ?? [];
  const target = { ...person, shared: person.shared ? { ...person.shared, tabs: history } : null };
  const currencies = await prepareWebSharedCurrencies(ledger, target, signal);
  assertCurrent(session, signal);
  const input = currencies.find((item) => item.currency === currency) ?? {
    currency,
    opening: null,
    linked_at_ms: Date.now(),
  };
  return parseGroup(
    await request(`/v1/tab-groups/${id(tab.group_id)}/currencies`, {
      session,
      signal,
      tab,
      mutation: true,
      body: input,
    }),
  );
}
