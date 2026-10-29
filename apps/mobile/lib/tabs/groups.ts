import * as Crypto from "expo-crypto";
import { applyForCurrentSession, captureCurrentSession, type SessionSnapshot } from "../auth";
import { applyVaultCurrency, getEnabledCurrencies } from "../currency";
import { effectiveEntryCurrencySql, requireCurrencyCode } from "../currency-scope";
import {
  createPerson,
  getActiveRelationshipIdForPerson,
  getAppMeta,
  getPerson,
  setAppMeta,
} from "../db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb, setActiveVaultId } from "../db-tx";
import { toMinorUnits } from "../money";
import { ENTRY_NOTE_MAX_LENGTH } from "../types";
import {
  createTabGroup,
  fetchTabGroup,
  fetchTabGroupByToken,
  joinTabGroup,
  ensureTabGroupCurrency,
  closeTabGroup,
  regenerateTabGroupLink,
  ensureTabGroupSupport,
} from "./api";
import {
  getTabGroupLinkForPerson,
  getTabLink,
  listOpenTabLinksForPerson,
  upsertTabGroupFromWire,
} from "./db";
import { directionFor } from "./direction";
import {
  TabAlreadyLinkedError,
  TabApiError,
  TabAuthUnavailableError,
  TabClosedError,
  TabCreatePersonError,
  TabInputError,
  TabPermissionError,
} from "./errors";
import {
  assertVaultAction,
  cleanLabel,
  fetchTabPreview,
  joinFailure,
  prepareSharedHistory,
  relationshipInVault,
  resendSelfPhone,
  pushVaultBestEffort,
  askNotifyPermission,
  type JoinTarget,
} from "./link";
import { canWriteSharedTallies, isTabRecordingMode } from "./recording-mode";
import { reconcileTabsFromServer } from "./sync";
import type {
  CreateTabGroupRequest,
  JoinTabGroupRequest,
  GroupCurrencyRequest,
  SharedInvitation,
  TabGroupResponse,
  TabLink,
  WireTabGroup,
} from "./types";
import { minorToWire } from "./wire";

export type LinkedTabGroup = {
  group: WireTabGroup;
  links: TabLink[];
  link: TabLink;
  inviteUrl: string;
};
const creating = new Map<
  string,
  { mode: string; label: string; promise: Promise<LinkedTabGroup> }
>();

function groupError(code: string, message: string, status = 409): never {
  throw new TabApiError(status, code, message);
}

function checkScope(session: SessionSnapshot, vaultId: string) {
  if (getActiveVaultIdSyncMaybe() !== vaultId || getAccountIdSync() !== session.accountId)
    throw new TabAuthUnavailableError();
}

async function atScope<T>(
  session: SessionSnapshot,
  vaultId: string,
  action: () => Promise<T>,
): Promise<T> {
  return applyForCurrentSession(session, async () => {
    checkScope(session, vaultId);
    return action();
  });
}

function randomInvite(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let text = "",
    buffer = 0,
    bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text += alphabet[(buffer >>> bits) & 63];
    }
  }
  if (bits) text += alphabet[(buffer << (6 - bits)) & 63];
  return text;
}

async function candidateCurrencies(vaultId: string, relationshipId: string): Promise<string[]> {
  const recorded = await (
    await getDb()
  ).getAllAsync<{ currency: string }>(
    `SELECT DISTINCT ${effectiveEntryCurrencySql("e")} AS currency FROM entries e
      WHERE e.vault_id=? AND e.relationship_id=? AND e.deleted_at IS NULL
     UNION SELECT currency FROM tab_links WHERE vault_id=? AND relationship_id=?`,
    vaultId,
    relationshipId,
    vaultId,
    relationshipId,
  );
  return [
    ...new Set([...(await getEnabledCurrencies(vaultId)), ...recorded.map((row) => row.currency)]),
  ]
    .map(requireCurrencyCode)
    .sort();
}

async function freezeSource<T>(
  session: SessionSnapshot,
  vaultId: string,
  relationshipId: string,
  work: () => Promise<T>,
): Promise<T> {
  const { applyEventMutex } = require("../projection") as typeof import("../projection");
  return atScope(session, vaultId, () =>
    applyEventMutex.runExclusive(async () => {
      const db = await getDb();
      let result!: T;
      await db.withTransactionAsync(async () => {
        // A best-effort push is not evidence that the server knows the source.
        // Applied refusals still affect local history; unapplied terminal intents do not.
        const pending = await db.getFirstAsync<{ one: number }>(
          `SELECT 1 AS one FROM event_log source WHERE source.vault_id=?
          AND source.event_type IN ('entry_created','entry_amended','entry_deleted','entry_settled')
          AND source.server_acked_at IS NULL
          AND (source.applied_at IS NOT NULL OR (source.rejected_at IS NULL AND source.tombstone_reason IS NULL))
          AND (source.relationship_id=? OR source.target_id IN (
            SELECT id FROM entries WHERE vault_id=? AND relationship_id=?)) LIMIT 1`,
          vaultId,
          relationshipId,
          vaultId,
          relationshipId,
        );
        if (pending)
          groupError(
            "shared_account_source_unsynced",
            "Sync this contact's recorded tallies before sharing",
          );
        result = await work();
      });
      return result;
    }),
  );
}

async function clearPendingExact(
  session: SessionSnapshot,
  vaultId: string,
  key: string,
  value: string,
) {
  const { applyEventMutex } = require("../projection") as typeof import("../projection");
  await atScope(session, vaultId, () =>
    applyEventMutex.runExclusive(async () => {
      await (
        await getDb()
      ).runAsync("UPDATE app_meta SET value='' WHERE key=? AND value=?", key, value);
    }),
  );
}

async function cacheGroup(
  response: TabGroupResponse,
  session: SessionSnapshot,
  vaultId: string,
  relationshipId: string,
): Promise<LinkedTabGroup> {
  const { group } = response;
  const binding = group.parties[group.you];
  if (binding.vault_id !== vaultId || binding.relationship_id !== relationshipId)
    groupError("shared_account_conflict", "The shared account is bound to a different contact");
  const links: TabLink[] = [];
  for (const item of response.tabs) {
    const previous = await getTabLink(item.tab.id);
    const tab = item.tab,
      them = group.you === "a" ? "b" : "a";
    const cutover = tab.parties[group.you].linked_at_ms;
    if (typeof cutover !== "number" || !Number.isSafeInteger(cutover) || cutover < 0)
      groupError(
        "shared_account_invalid",
        "The shared currency has no authoritative source boundary",
        503,
      );
    links.push({
      tab_id: tab.id,
      group_id: group.id,
      vault_id: vaultId,
      relationship_id: relationshipId,
      role: group.you,
      currency: tab.currency,
      party_token: null,
      recording_mode: group.recording_mode,
      recording_mode_known: 1,
      my_label: tab.parties[group.you].label,
      other_label: tab.parties[them].label,
      other_joined_at: tab.parties[them].joined_at_ms,
      unjoined_invitation:
        tab.unjoined_invitation === true ? 1 : tab.unjoined_invitation === false ? 0 : null,
      history_order: tab.parties[group.you].history_order ?? null,
      invite_url: group.you === "a" ? (response.invite_url ?? null) : null,
      rev: previous?.rev ?? 0,
      closed_at: tab.closed_at_ms,
      linked_at: cutover,
      last_synced_at: previous?.last_synced_at ?? null,
      last_error: null,
    });
  }
  await atScope(session, vaultId, () =>
    upsertTabGroupFromWire(links, response.tabs, { revision: group.rev }),
  );
  const fresh = await atScope(session, vaultId, async () =>
    Promise.all(links.map(async (link) => (await getTabLink(link.tab_id)) ?? link)),
  );
  return {
    group,
    links: fresh,
    link: fresh[0],
    inviteUrl: fresh[0].invite_url ?? response.invite_url ?? "",
  };
}

async function recoverPendingGroup(
  groupId: string,
  role: "a" | "b",
  mode: import("./types").TabRecordingMode,
  session: SessionSnapshot,
  vaultId: string,
  relationshipId: string,
): Promise<LinkedTabGroup | null> {
  let response: TabGroupResponse;
  try {
    response = await fetchTabGroup(groupId, { jwt: session.jwt!, recordingMode: mode });
  } catch (error) {
    if (error instanceof TabApiError && [403, 404].includes(error.status)) return null;
    throw error;
  }
  if (response.group.id !== groupId || response.group.you !== role)
    groupError("shared_account_conflict", "The recovered invitation belongs to another account");
  return cacheGroup(response, session, vaultId, relationshipId);
}

async function currencyOpening(
  personId: string,
  currency: string,
  role: "a" | "b",
  note?: string | null,
) {
  const person = await getPerson(personId, currency);
  if (!person) throw new TabInputError("no_relationship");
  const minor = toMinorUnits(person.balance);
  if (minor === 0 && toMinorUnits(person.tab_confirmed_balance ?? 0) !== 0)
    groupError("shared_history_opening_required", "A prior confirmed balance needs an opening");
  return minor === 0
    ? null
    : {
        direction: directionFor(role, minor > 0 ? "debt" : "payment"),
        amount: minorToWire(Math.abs(minor)),
        note: note?.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null,
        occurred_at_ms: Date.now(),
      };
}

/** One explicit invitation covers every configured or recorded denomination. */
export async function linkContactGroup(
  personId: string,
  options: {
    myLabel: string;
    recordingMode?: import("./types").TabRecordingMode;
    openingNote?: string | null;
  },
): Promise<LinkedTabGroup> {
  const mode = options.recordingMode ?? "notify_one_way";
  if (!isTabRecordingMode(mode))
    groupError("recording_upgrade_required", "Unknown recording mode", 426);
  const label = cleanLabel(options.myLabel);
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) throw new TabInputError("no_active_vault");
  await assertVaultAction(vaultId, "entry.amend");
  await ensureTabGroupSupport({ jwt: session.jwt });
  const relationshipId = await atScope(session, vaultId, () =>
    getActiveRelationshipIdForPerson(personId),
  );
  if (!relationshipId) throw new TabInputError("no_relationship");
  const key = `tab_group_create:${session.accountId}:${vaultId}:${relationshipId}`;
  const active = creating.get(key);
  if (active) {
    if (active.mode !== mode)
      groupError("shared_account_changed", "Another invitation is being created");
    return active.promise;
  }
  const promise = (async () => {
    const raw = await getAppMeta(key);
    let body: CreateTabGroupRequest | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw) as CreateTabGroupRequest;
      } catch {
        groupError("shared_account_changed", "The saved invitation needs recovery");
      }
      if (
        !body?.request_id ||
        body.vault_id !== vaultId ||
        body.relationship_id !== relationshipId ||
        body.recording_mode !== mode ||
        !/^[\w-]{43}$/.test(body.invite_token)
      )
        groupError(
          "shared_account_changed",
          "Retry the saved invitation with its original settings",
        );
      const recovered = await recoverPendingGroup(
        body.request_id,
        "a",
        mode,
        session,
        vaultId,
        relationshipId,
      );
      if (recovered) {
        await clearPendingExact(session, vaultId, key, raw);
        if (recovered.group.closed_at_ms == null) askNotifyPermission();
        return recovered;
      }
    }
    const existing = await atScope(session, vaultId, () => listOpenTabLinksForPerson(personId));
    if (existing.some((link) => !body || link.group_id !== body.request_id))
      throw new TabAlreadyLinkedError(existing[0].tab_id);
    await pushVaultBestEffort(vaultId, { capMs: 5000 });
    await atScope(session, vaultId, async () => {});
    if (!body) {
      const currencies = await candidateCurrencies(vaultId, relationshipId);
      const receipts = new Map<string, Awaited<ReturnType<typeof prepareSharedHistory>>>();
      for (const currency of currencies) {
        receipts.set(
          currency,
          await prepareSharedHistory(relationshipId, vaultId, currency, session),
        );
      }
      const requestId = Crypto.randomUUID(),
        inviteToken = randomInvite(await Crypto.getRandomBytesAsync(32));
      body = await freezeSource(session, vaultId, relationshipId, async () => {
        if (
          await getAppMeta(
            `tab_group_pending_join:${session.accountId}:${vaultId}:${relationshipId}`,
          )
        )
          groupError(
            "shared_account_pending",
            "Recover the pending join before creating another invitation",
          );
        if (await getAppMeta(key))
          groupError("shared_account_pending", "Another invitation is already being prepared");
        if (
          JSON.stringify(await candidateCurrencies(vaultId, relationshipId)) !==
          JSON.stringify(currencies)
        )
          groupError("shared_account_changed", "The contact's currencies changed; retry sharing");
        const open = await listOpenTabLinksForPerson(personId);
        if (open.length) throw new TabAlreadyLinkedError(open[0].tab_id);
        const linkedAt = Date.now(),
          requests: GroupCurrencyRequest[] = [];
        for (const currency of currencies)
          requests.push({
            currency,
            opening: await currencyOpening(personId, currency, "a", options.openingNote),
            linked_at_ms: linkedAt,
            ...receipts.get(currency),
          });
        const draft: CreateTabGroupRequest = {
          request_id: requestId,
          invite_token: inviteToken,
          label,
          recording_mode: mode,
          vault_id: vaultId,
          relationship_id: relationshipId,
          currencies: requests,
        };
        await setAppMeta(key, JSON.stringify(draft));
        return draft;
      });
    }
    await resendSelfPhone();
    await atScope(session, vaultId, async () => {});
    let response: TabGroupResponse;
    try {
      response = await createTabGroup(body, { jwt: session.jwt!, recordingMode: mode });
    } catch (error) {
      // Definitive validation refusals did not create the requested group.
      // Keep ambiguous requests unchanged so a lost response cannot duplicate it.
      if (
        error instanceof TabApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 429].includes(error.status) &&
        !raw
      )
        await clearPendingExact(session, vaultId, key, JSON.stringify(body));
      if (error instanceof TabApiError && error.code === "already_linked") {
        await reconcileTabsFromServer();
        const linked = await getTabGroupLinkForPerson(personId);
        if (linked) throw new TabAlreadyLinkedError(linked.tab_id);
      }
      throw error;
    }
    if (response.group.id !== body.request_id || response.group.you !== "a")
      groupError(
        "shared_account_invalid",
        "The invitation response belongs to another request",
        503,
      );
    const result = await cacheGroup(response, session, vaultId, relationshipId);
    await clearPendingExact(session, vaultId, key, JSON.stringify(body));
    askNotifyPermission();
    return result;
  })();
  creating.set(key, { mode, label, promise });
  try {
    return await promise;
  } finally {
    if (creating.get(key)?.promise === promise) creating.delete(key);
  }
}

export async function fetchSharedInvitation(token: string): Promise<SharedInvitation> {
  if (token.startsWith("g_")) return { kind: "group", ...(await fetchTabGroupByToken(token)) };
  return { kind: "tab", ...(await fetchTabPreview(token)) };
}

/** Recover the original policy after a lost response; never replace a pending
 * invitation merely because the profile's display label changed meanwhile. */
export async function getPendingContactGroupSettings(
  personId: string,
): Promise<{ myLabel: string; recordingMode: import("./types").TabRecordingMode } | null> {
  const session = await captureCurrentSession();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return null;
  const relationshipId = await relationshipInVault(personId, vaultId);
  if (!relationshipId) return null;
  const raw = await getAppMeta(
    `tab_group_create:${session.accountId}:${vaultId}:${relationshipId}`,
  );
  checkScope(session, vaultId);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as CreateTabGroupRequest;
    return pending.vault_id === vaultId &&
      pending.relationship_id === relationshipId &&
      isTabRecordingMode(pending.recording_mode) &&
      typeof pending.label === "string"
      ? { myLabel: pending.label, recordingMode: pending.recording_mode }
      : null;
  } catch {
    return null;
  }
}

export async function joinTabGroupAsContact(
  token: string,
  preview: TabGroupResponse,
  target: JoinTarget,
  myLabel: string,
): Promise<LinkedTabGroup> {
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  if (preview.group.closed_at_ms != null) throw new TabClosedError();
  const label = cleanLabel(myLabel);
  await assertVaultAction(target.vaultId, "entry.amend");
  await ensureTabGroupSupport({ jwt: session.jwt });
  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== target.vaultId) {
      await setActiveVaultId(target.vaultId);
      await applyVaultCurrency(target.vaultId);
    }
  });
  const key = `tab_group_join:${session.accountId}:${preview.group.id}:${target.vaultId}`;
  let createdPersonId: string | null = null;
  let personId: string;
  if ("personId" in target) personId = target.personId;
  else {
    const saved = await getAppMeta(key);
    let previous: { personId?: string; input?: string } | null = null;
    try {
      previous = saved ? JSON.parse(saved) : null;
    } catch {
      /* invalid draft is not binding evidence */
    }
    const input = JSON.stringify(target.newPerson);
    if (
      previous?.personId &&
      previous.input === input &&
      (await relationshipInVault(previous.personId, target.vaultId))
    )
      personId = previous.personId;
    else {
      const result = await atScope(session, target.vaultId, () =>
        createPerson(
          target.newPerson.firstName,
          target.newPerson.lastName,
          target.newPerson.phone,
          target.newPerson.countryCode,
        ),
      );
      if (!result.ok) throw new TabCreatePersonError(result);
      personId = result.id;
      createdPersonId = result.id;
      await atScope(session, target.vaultId, () =>
        setAppMeta(key, JSON.stringify({ personId, input })),
      );
    }
  }
  const relationshipId = await relationshipInVault(personId, target.vaultId);
  if (!relationshipId) throw new TabInputError("no_relationship");
  const pendingKey = `tab_group_pending_join:${session.accountId}:${target.vaultId}:${relationshipId}`;
  const savedJoin = await getAppMeta(pendingKey);
  let joinBody: JoinTabGroupRequest | null = null;
  if (savedJoin) {
    try {
      const saved = JSON.parse(savedJoin) as { group_id: string; body: JoinTabGroupRequest };
      if (
        saved.group_id !== preview.group.id ||
        saved.body.vault_id !== target.vaultId ||
        saved.body.relationship_id !== relationshipId
      )
        groupError("shared_account_pending", "Recover this contact's pending invitation first");
      joinBody = saved.body;
    } catch (error) {
      if (error instanceof TabApiError) throw error;
      groupError("shared_account_pending", "The pending invitation needs recovery");
    }
    const recovered = await recoverPendingGroup(
      preview.group.id,
      "b",
      preview.group.recording_mode,
      session,
      target.vaultId,
      relationshipId,
    );
    if (recovered) {
      await clearPendingExact(session, target.vaultId, pendingKey, savedJoin);
      if (recovered.group.closed_at_ms == null) askNotifyPermission();
      return recovered;
    }
  }
  await pushVaultBestEffort(target.vaultId, { capMs: 5000 });
  await atScope(session, target.vaultId, async () => {});
  const existing = await listOpenTabLinksForPerson(personId);
  if (existing.some((link) => link.group_id !== preview.group.id))
    throw new TabAlreadyLinkedError(existing[0].tab_id);
  if (!joinBody) {
    const currencies: JoinTabGroupRequest["currencies"] = [];
    for (const currency of preview.group.currencies) {
      const joined = existing.some(
        (link) => link.group_id === preview.group.id && link.currency === currency,
      );
      currencies.push({
        currency,
        ...(joined
          ? {}
          : await prepareSharedHistory(relationshipId, target.vaultId, currency, session)),
      });
    }
    joinBody = await freezeSource(session, target.vaultId, relationshipId, async () => {
      if (await getAppMeta(pendingKey))
        groupError(
          "shared_account_pending",
          "Another invitation is already being joined for this contact",
        );
      if (
        await getAppMeta(
          `tab_group_create:${session.accountId}:${target.vaultId}:${relationshipId}`,
        )
      )
        groupError(
          "shared_account_pending",
          "Recover the pending invitation before joining another account",
        );
      const open = await listOpenTabLinksForPerson(personId);
      if (open.some((link) => link.group_id !== preview.group.id))
        throw new TabAlreadyLinkedError(open[0].tab_id);
      if (preview.group.recording_mode === "review" && !open.length)
        for (const currency of preview.group.currencies) {
          const source = await getPerson(personId, currency);
          if (!source || source.tab_unsynced === 1 || toMinorUnits(source.balance) !== 0)
            groupError(
              "shared_account_currency_history",
              "Keep the existing recorded account unchanged; review sharing needs an empty recipient balance",
            );
        }
      const linkedAt = Date.now();
      const draft: JoinTabGroupRequest = {
        token: token.replace(/^g_/, ""),
        label,
        vault_id: target.vaultId,
        relationship_id: relationshipId,
        currencies: currencies.map((item) => ({ ...item, linked_at_ms: linkedAt })),
      };
      await setAppMeta(pendingKey, JSON.stringify({ group_id: preview.group.id, body: draft }));
      return draft;
    });
  }
  await resendSelfPhone();
  await atScope(session, target.vaultId, async () => {});
  let response: TabGroupResponse;
  try {
    response = await joinTabGroup(preview.group.id, joinBody, {
      jwt: session.jwt,
      recordingMode: preview.group.recording_mode,
    });
  } catch (error) {
    if (
      error instanceof TabApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![401, 429].includes(error.status) &&
      !savedJoin
    )
      await clearPendingExact(
        session,
        target.vaultId,
        pendingKey,
        JSON.stringify({ group_id: preview.group.id, body: joinBody }),
      );
    if (savedJoin) throw error;
    throw await joinFailure(
      error,
      createdPersonId,
      preview.group.currencies[0],
      { id: preview.group.id, currency: preview.group.currencies[0] },
      false,
      { session, vaultId: target.vaultId },
    );
  }
  if (response.group.id !== preview.group.id)
    groupError("shared_account_invalid", "Invitation changed", 503);
  const result = await cacheGroup(response, session, target.vaultId, relationshipId);
  await atScope(session, target.vaultId, () => setAppMeta(key, ""));
  await clearPendingExact(
    session,
    target.vaultId,
    pendingKey,
    JSON.stringify({ group_id: preview.group.id, body: joinBody }),
  );
  askNotifyPermission();
  return result;
}

export async function fetchContactTabGroup(link: TabLink): Promise<TabGroupResponse> {
  if (!link.group_id) throw new TabInputError("not_linked");
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  checkScope(session, link.vault_id);
  const response = await fetchTabGroup(link.group_id, {
    jwt: session.jwt,
    recordingMode: link.recording_mode,
  });
  if (response.group.id !== link.group_id || response.group.you !== link.role)
    groupError("shared_account_conflict", "The shared account changed");
  await cacheGroup(response, session, link.vault_id, link.relationship_id);
  return response;
}

/** Never let a missing leg turn a shared-account save into a private tally. */
export async function ensureContactGroupCurrency(
  personId: string,
  currency: string,
  expected?: { session?: SessionSnapshot; vaultId?: string },
): Promise<TabLink | null> {
  requireCurrencyCode(currency);
  const source = await getTabGroupLinkForPerson(personId);
  if (!source) return null;
  const session = expected?.session ?? (await captureCurrentSession());
  const vaultId = expected?.vaultId ?? source.vault_id;
  if (!session.jwt || source.vault_id !== vaultId) throw new TabAuthUnavailableError();
  checkScope(session, vaultId);
  if (!canWriteSharedTallies(source))
    groupError(
      "one_way_read_only",
      "Only the link creator can change tallies in this account",
      403,
    );
  await assertVaultAction(vaultId, "entry.create");
  const current = await fetchTabGroup(source.group_id!, {
    jwt: session.jwt,
    recordingMode: source.recording_mode,
  });
  if (current.group.closed_at_ms != null) {
    await cacheGroup(current, session, vaultId, source.relationship_id);
    throw new TabClosedError();
  }
  if (current.tabs.some((item) => item.tab.currency === currency)) {
    const cached = await cacheGroup(current, session, vaultId, source.relationship_id);
    return cached.links.find((link) => link.currency === currency)!;
  }
  if (await currencyOpening(personId, currency, source.role))
    groupError(
      "shared_account_currency_history",
      "Relink this contact to include a currency with existing history",
    );
  const receipt = await prepareSharedHistory(source.relationship_id, vaultId, currency, session);
  await atScope(session, vaultId, async () => {});
  const response = await ensureTabGroupCurrency(
    source.group_id!,
    { currency, opening: null, linked_at_ms: Date.now(), ...receipt },
    { jwt: session.jwt, recordingMode: source.recording_mode },
  );
  const result = await cacheGroup(response, session, vaultId, source.relationship_id);
  const link = result.links.find((item) => item.currency === currency);
  if (!link) groupError("shared_account_invalid", "The new shared currency was not returned", 503);
  return link;
}

export async function unlinkTabGroup(link: TabLink): Promise<void> {
  if (!link.group_id) throw new TabInputError("not_linked");
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  checkScope(session, link.vault_id);
  await assertVaultAction(link.vault_id, "entry.amend");
  const response = await closeTabGroup(link.group_id, {
    jwt: session.jwt,
    recordingMode: link.recording_mode,
  });
  await cacheGroup(response, session, link.vault_id, link.relationship_id);
}

export async function regenerateTabGroupInvite(link: TabLink): Promise<string> {
  if (!link.group_id || link.role !== "a") throw new TabPermissionError();
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  checkScope(session, link.vault_id);
  await assertVaultAction(link.vault_id, "entry.amend");
  const response = await regenerateTabGroupLink(link.group_id, {
    jwt: session.jwt,
    recordingMode: link.recording_mode,
  });
  const result = await cacheGroup(response, session, link.vault_id, link.relationship_id);
  if (!result.inviteUrl)
    groupError("shared_account_invalid", "The invitation URL was not returned", 503);
  return result.inviteUrl;
}
