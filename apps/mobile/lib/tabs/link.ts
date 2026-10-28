// apps/mobile/lib/tabs/link.ts
//
// The product flows of a mutual tab, with every rule enforced HERE so the
// screens stay thin: link a contact (party a), join as the counterparty
// (party b), add a tally, accept / dispute / void, unlink (= close), share
// the invite. Each function reads its preconditions from the data layer —
// role, currency, existing link — rather than trusting a screen's state,
// which is the same posture appendEntrySettled takes with its in-tx zero
// check.
//
// No i18n lives in lib/tabs: every user-facing string (the WhatsApp text, the
// opening entry's note) is composed by the caller and passed in. The one
// notification-permission prompt the flows trigger (D14: ask at link/join
// time, not at boot) belongs to the UI wave's lib/tabs/notify.ts, which
// registers itself through setTabNotifyHook; until it does, the hook is a
// no-op and nothing here imports expo-notifications (a static import from a
// boot-reachable module red-screens Expo Go — CLAUDE.md).

import * as Crypto from "expo-crypto";
import * as Network from "expo-network";
import { Linking } from "react-native";

import {
  applyForCurrentSession,
  captureCurrentSession,
  getSessionJWT,
  updateAccountPhone,
  type SessionSnapshot,
} from "../auth";
import { applyVaultCurrency } from "../currency";
import {
  archivePerson,
  bumpUsageCounter,
  createPerson,
  getActiveRelationshipIdForPerson,
  getLocalSelf,
  getPerson,
  listActiveVaults,
} from "../db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb, setActiveVaultId } from "../db-tx";
import { RoleGateRejectionError } from "../event-log";
import {
  getLedgerCurrencyCode,
  setLedgerCurrencyCode,
  requireCurrencyCode,
} from "../currency-scope";
import { isValidEntryDate } from "../entry-date";
import { parseAmountInput, toMinorUnits } from "../money";
import { pushEvents } from "../sync/push";
import { ENTRY_NOTE_MAX_LENGTH, type EntryType } from "../types";
import { readVaultRole } from "../use-vault-role";
import { canPerformAction, type VaultAction } from "../vault-roles";
import {
  createTab,
  fetchTabByToken,
  joinTab,
  regenerateTabLink,
  resolveTabAuth,
  settleTab,
} from "./api";
import {
  queueTabMutation,
  getTabLink,
  getAnyTabLinkForRelationship,
  getSharedHistoryReceiptForRelationship,
  getTabLinkForPerson,
  getTabLinkForRelationship,
  listTabLinks,
  setTabInviteUrl,
  upsertTabFromWire,
  upsertTabLink,
  vaultHasOpenTab,
} from "./db";
import { directionFor } from "./direction";
import {
  TabAlreadyLinkedError,
  TabApiError,
  TabAuthUnavailableError,
  TabClosedError,
  TabCreatePersonError,
  TabCurrencyMismatchError,
  TabInputError,
  TabPermissionError,
  TabSameAccountError,
  TabSameKaataError,
  isRetryableTabError,
} from "./errors";
import { markInboxHandled } from "./inbox-reads";
import type { VaultFacts } from "./join-plan";
import { reconcileTabsFromServer, syncTab, takeAppendOutcome } from "./sync";
import type {
  DuplicateHint,
  TabLink,
  TabOutboxRow,
  TabResponse,
  WireEntry,
  WireTab,
} from "./types";
import { minorToWire } from "./wire";
import { isUnjoinedInvitation } from "./history";

export {
  TabAlreadyLinkedError,
  TabApiError,
  TabAuthUnavailableError,
  TabClosedError,
  TabCreatePersonError,
  TabCurrencyMismatchError,
  TabInputError,
  TabLinkedEntryError,
  TabPermissionError,
  TabSameAccountError,
  TabSameKaataError,
} from "./errors";

// Server bounds (§3.1). Clamped here so the outbox never carries an op the
// server is certain to refuse.
const LABEL_MAX = 80;
const REASON_MAX = 300;
// How long addTabEntry waits for the first flush before answering without
// the duplicate hint. Long enough for one round trip on a slow link, short
// enough that the save button never feels stuck; the op is durable in the
// outbox either way.
const FIRST_FLUSH_WAIT_MS = 3_000;

// ---------------------------------------------------------------------------
// Late-bound notification hook (see the header).

let notifyHook: (() => Promise<void>) | null = null;

/**
 * Register the permission prompt lib/tabs/notify.ts owns
 * (ensureTabNotificationPermission). Called once at module load by that
 * file; link/join call it best-effort and never await its UI.
 */
export function setTabNotifyHook(fn: (() => Promise<void>) | null): void {
  notifyHook = fn;
}

function askNotifyPermission(): void {
  if (!notifyHook) return;
  void notifyHook().catch((err) => {
    if (__DEV__) console.warn("[tabs.link] notify hook failed", err);
  });
}

// ---------------------------------------------------------------------------
// Helpers

/** Refuse when the active user's vault role cannot perform `action`. A
 *  token-only (never signed in) install resolves to owner, as everywhere. */
async function assertVaultAction(vaultId: string, action: VaultAction): Promise<void> {
  const role = await readVaultRole(vaultId, getAccountIdSync());
  if (!canPerformAction(role, action)) throw new TabPermissionError();
}

function cleanLabel(label: string): string {
  const trimmed = label.trim().slice(0, LABEL_MAX);
  if (!trimmed) throw new TabInputError("label_required");
  return trimmed;
}

async function relationshipInVault(personId: string, vaultId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM relationships
      WHERE user_b_id = ? AND vault_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    personId,
    vaultId,
  );
  return row?.id ?? null;
}

function requireOpen(link: TabLink): void {
  if (link.closed_at != null) throw new TabClosedError();
}

/** Resolve the previous shared period before copying its balance. The server
 * checks the receipt again under its contact lock, so a concurrent final review
 * cannot silently turn a stale opening into a new acknowledgement. */
async function prepareSharedHistory(
  relationshipId: string,
  vaultId: string,
  currency: string,
  session: SessionSnapshot,
) {
  let previous = await getAnyTabLinkForRelationship(relationshipId, currency);
  if (!previous) return {};
  // Another phone may have restored or closed a period this cache has never
  // seen. Refresh the whole binding set before collecting its revision map.
  await reconcileTabsFromServer();
  previous = await getAnyTabLinkForRelationship(relationshipId, currency);
  if (!previous) throw new TabAuthUnavailableError();
  if (previous.vault_id !== vaultId) throw new TabPermissionError();
  if (previous.closed_at == null) throw new TabAlreadyLinkedError(previous.tab_id);
  const history = (await listTabLinks({ vaultId, includeClosed: true, currency })).filter(
    (link) => link.relationship_id === relationshipId && link.currency === currency,
  );
  for (const link of history) {
    const result = await syncTab(link.tab_id);
    if (!result.ok || result.error) throw new TabAuthUnavailableError();
    // Older clients closed unused invites without withdrawing the duplicate
    // opening. Ask the server to verify participation and retire it before
    // collecting a relink receipt. Genuine unresolved tallies still block it.
    const refreshed = await getTabLink(link.tab_id);
    if (refreshed?.closed_at != null && isUnjoinedInvitation(refreshed)) {
      const db = await getDb();
      const pendingOpening = await db.getFirstAsync<{ one: number }>(
        `SELECT 1 AS one FROM tab_entries WHERE tab_id=? AND kind='opening'
          AND created_by='a' AND status='pending' AND voided_by_entry_id IS NULL LIMIT 1`,
        refreshed.tab_id,
      );
      if (pendingOpening) {
        await newOp(refreshed, "close", { withdraw_unjoined_opening: true }, undefined, {
          session,
        });
        const cleanup = await syncTab(refreshed.tab_id);
        if (!cleanup.ok || cleanup.error) throw new TabAuthUnavailableError();
      }
    }
  }
  const db = await getDb();
  const unresolved = await db.getFirstAsync<{ pending: number }>(
    `SELECT EXISTS (
       SELECT 1 FROM tab_entries e JOIN tab_links l ON l.tab_id=e.tab_id
        WHERE l.vault_id=? AND l.relationship_id=? AND l.currency=? AND e.kind<>'void'
          AND e.voided_by_entry_id IS NULL
          AND (e.status='pending' OR e.local_pending=1 OR e.local_action_pending=1)
     ) OR EXISTS (
       SELECT 1 FROM tab_outbox o JOIN tab_links l ON l.tab_id=o.tab_id
        WHERE l.vault_id=? AND l.relationship_id=? AND l.currency=?
     ) AS pending`,
    vaultId,
    relationshipId,
    currency,
    vaultId,
    relationshipId,
    currency,
  );
  if (unresolved?.pending)
    throw new TabApiError(409, "shared_history_pending", "Review and sync previous shared tallies");
  const receipt = await getSharedHistoryReceiptForRelationship(
    relationshipId,
    vaultId,
    currency,
  ).catch((err: unknown) => {
    if (err instanceof Error && err.message === "shared_history_refresh_required")
      throw new TabApiError(409, "shared_history_changed", "Refresh previous shared history");
    throw err;
  });
  if (!receipt || !receipt.history_order)
    throw new TabApiError(409, "shared_history_changed", "Refresh previous shared history");
  return {
    expected_previous_tab_id: receipt.tab_id,
    expected_previous_rev: receipt.rev,
    expected_history_revisions: receipt.revisions,
  };
}

async function newOp(
  link: TabLink,
  op: TabOutboxRow["op"],
  payload: Record<string, unknown>,
  id = Crypto.randomUUID(),
  opts: { deferAppend?: boolean; deferFinancial?: boolean; session?: SessionSnapshot } = {},
): Promise<string> {
  const session = opts.session ?? (await captureCurrentSession());
  if (!session.jwt) throw new TabAuthUnavailableError();
  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== link.vault_id) throw new TabAuthUnavailableError();
    await queueTabMutation(
      link,
      {
        id,
        tab_id: link.tab_id,
        op,
        payload: JSON.stringify(payload),
        created_at: Date.now(),
        attempts: 0,
        next_at: null,
        last_error: null,
      },
      opts,
    );
  });
  return id;
}

/**
 * Best-effort: make sure the server holds MY phone before a tab exists that
 * the other party can read it from (WireParty.phone — the join screen's
 * contact suggestion keys on it, lib/tabs/join-plan.ts). updateAccountPhone is
 * JWT-gated and swallows transport failures, and the PUT is never awaited: a
 * stale or missing server phone only costs the other side a suggestion, never
 * the link.
 */
async function resendSelfPhone(): Promise<void> {
  try {
    const self = await getLocalSelf();
    if (self?.phone) void updateAccountPhone(self.phone).catch(() => undefined);
  } catch {
    /* best-effort */
  }
}

// pushEvents sends ONE batch (MAX_BATCH_SIZE = 500, oldest HLC first), and the
// currency event we want on the server is the NEWEST row, so a kaata that
// signed in after months offline needs several batches before it is there.
// Bounded: 5 × 500 events is more than any shop has queued.
const PUSH_MAX_BATCHES = 5;
// How long the join screen waits for a best-effort push before moving on.
// pushEvents' own timeout is 30 s (lib/sync/push.ts PUSH_TIMEOUT_MS), and a
// stalled connection (captive portal, flaky data) hangs the full 30 s rather
// than failing fast; the local switch is done in milliseconds and only this
// network side effect would be holding the screen. The push keeps running in
// the background past the cap, and the join's own 409 retry covers a push
// that has not landed by the time the user taps.
const SWITCH_PUSH_CAP_MS = 5_000;
// The 409 retry's push must actually land for the retry to succeed, so it is
// given longer — but not the whole 30 s twice over on a dead link; a second
// 409 is reported as "not synced yet" and the user retries once it has.
const RETRY_PUSH_CAP_MS = 10_000;

/**
 * Push a vault's queued events so the server's projection catches up with this
 * device's, draining up to PUSH_MAX_BATCHES batches; never throws (offline, an
 * expired session, an unregistered vault are all "not now", and the caller's
 * own request reports the consequence). Returns how many events the server
 * accepted (duplicates count — the server already had them). With `capMs` the
 * wait is bounded: the drain continues in the background and the result says
 * what had landed by the cap (`timedOut`).
 */
async function pushVaultBestEffort(
  vaultId: string,
  opts: { capMs?: number } = {},
): Promise<{ pushed: number; timedOut: boolean }> {
  let pushed = 0;
  const drain = (async () => {
    try {
      for (let i = 0; i < PUSH_MAX_BATCHES; i++) {
        const r = await pushEvents(vaultId);
        pushed += r.pushed + r.duplicates;
        if (r.pushed + r.duplicates === 0) break;
      }
    } catch (err) {
      if (__DEV__) console.warn("[tabs.link] vault push before join failed", err);
    }
  })();
  if (opts.capMs == null) {
    await drain;
    return { pushed, timedOut: false };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = await Promise.race([
    drain.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), opts.capMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { pushed, timedOut };
}

/**
 * Map a refused join to its typed error — after undoing the contact THIS call
 * minted. Leaving it makes the obvious retry (same name, same number) fail
 * with phone_conflict on a contact the person never knowingly created, which
 * is a baffling way to meet the app: this is the counterparty's FIRST screen.
 * Archiving clears the number off the active set, so the retry behaves like a
 * first try. Best effort; the join error is what the caller must see. A
 * timeout is ambiguous — the server may already have attached this exact
 * contact — so retryable failures keep it, and recovery/retry cannot orphan
 * that binding. Returns rather than throws so the caller's `throw await`
 * keeps the rollback on the FINAL failure only (the currency retry in
 * joinTabAsContact asks the server twice).
 */
async function joinFailure(
  err: unknown,
  createdPersonId: string | null,
  vaultCurrency: string,
  tab: WireTab,
  afterPush: boolean,
  scope: { session: SessionSnapshot; vaultId: string },
): Promise<unknown> {
  if (createdPersonId && err instanceof TabApiError && !isRetryableTabError(err)) {
    try {
      await applyForCurrentSession(scope.session, async () => {
        if (getActiveVaultIdSyncMaybe() !== scope.vaultId) return;
        await archivePerson(createdPersonId, {
          vaultId: scope.vaultId,
          accountId: scope.session.accountId,
        });
      });
    } catch (cleanupErr) {
      console.warn("[tabs.link] could not roll back the contact after a failed join", cleanupErr);
    }
  }
  if (err instanceof TabApiError) {
    if (err.code === "same_kaata") return new TabSameKaataError();
    if (err.code === "same_account") return new TabSameAccountError();
    if (err.code === "tab_closed") return new TabClosedError();
    if (err.code === "currency_mismatch")
      return new TabCurrencyMismatchError(vaultCurrency, tab.currency, { serverStale: afterPush });
    if (err.code === "already_linked") return new TabAlreadyLinkedError(tab.id);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Link (party a)

/**
 * Turn a contact's account into a mutual tab, with this kaata as party a.
 *
 * Preconditions, checked here: an active vault, `entry.amend` on it, no open
 * link on the contact, a known vault currency (D9 fixes the tab's currency
 * from it). The contact's CURRENT displayed balance becomes ONE visible,
 * disputable opening entry (D7) — null when the account is at zero. With a session, vault_id and
 * relationship_id ride the request so /mine can hand the link back after a
 * reinstall; without one, the response's my_token in tab_links is the only
 * credential. `openingNote` is optional caller-composed copy; callers normally
 * omit it so each side labels the opening entry in its own language.
 */
export async function linkContact(
  personId: string,
  opts: { myLabel: string; openingNote?: string | null; currency?: string },
): Promise<{ link: TabLink; inviteUrl: string }> {
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) throw new TabInputError("no_active_vault");
  const label = cleanLabel(opts.myLabel);
  await assertVaultAction(vaultId, "entry.amend");
  const relId = await getActiveRelationshipIdForPerson(personId);
  if (!relId) throw new TabInputError("no_relationship");
  const currency = requireCurrencyCode(opts.currency ?? getLedgerCurrencyCode());
  const existing = await getTabLinkForRelationship(relId, currency);
  if (existing) throw new TabAlreadyLinkedError(existing.tab_id);
  const historyReceipt = await prepareSharedHistory(relId, vaultId, currency, session);

  // The opening entry carries the contact's balance AS THE SHOPKEEPER SEES IT
  // — getPerson's number, not a fresh sum of the local rows. Those differ the
  // moment a contact has been linked before: a closed tab's rows still count
  // and its pre-link rows are still excluded (D8), so re-summing `entries`
  // here would carry a number that has not been on screen for months and
  // would double-count the rows the previous tab's own opening entry already
  // absorbed. D7's promise is that the counterparty sees exactly what was
  // carried over, which means exactly what was displayed.
  const current = await getPerson(personId, currency);
  if (!current) throw new TabInputError("no_relationship");
  const balanceMinor = toMinorUnits(current.balance);
  if (balanceMinor === 0 && toMinorUnits(current.tab_confirmed_balance ?? 0) !== 0)
    throw new TabApiError(
      409,
      "shared_history_opening_required",
      "A prior confirmed balance needs a reviewable opening before relinking",
    );
  const now = Date.now();
  const opening =
    balanceMinor === 0
      ? null
      : {
          // Positive = they owe me = value I gave: from party a's seat that is
          // a_to_b; negative is what I received, b_to_a.
          direction: directionFor("a", balanceMinor > 0 ? "debt" : "payment"),
          amount: minorToWire(Math.abs(balanceMinor)),
          note: opts.openingNote?.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null,
          occurred_at_ms: now,
        };

  await resendSelfPhone();
  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== vaultId) throw new TabAuthUnavailableError();
  });
  const resp = await createTab(
    {
      ...historyReceipt,
      linked_at_ms: now,
      currency,
      label,
      vault_id: vaultId,
      relationship_id: relId,
      opening,
    },
    { jwt: session.jwt },
  ).catch(async (err: unknown) => {
    await applyForCurrentSession(session, async () => {});
    if (err instanceof TabApiError && err.code === "already_linked") {
      await reconcileTabsFromServer();
      const recovered = await getTabLinkForRelationship(relId);
      if (recovered) {
        await syncTab(recovered.tab_id);
        throw new TabAlreadyLinkedError(recovered.tab_id);
      }
    }
    throw err;
  });

  const link: TabLink = {
    tab_id: resp.tab.id,
    vault_id: vaultId,
    relationship_id: relId,
    role: "a",
    currency: resp.tab.currency,
    party_token: resp.my_token,
    my_label: resp.tab.parties.a.label,
    other_label: resp.tab.parties.b.label,
    other_joined_at: resp.tab.parties.b.joined_at_ms,
    unjoined_invitation:
      typeof resp.tab.unjoined_invitation === "boolean"
        ? resp.tab.unjoined_invitation
          ? 1
          : 0
        : null,
    history_order: resp.tab.parties.a.history_order ?? null,
    invite_url: resp.invite_url,
    rev: 0,
    closed_at: resp.tab.closed_at_ms,
    linked_at: now,
    last_synced_at: null,
    last_error: null,
  };
  await applyForCurrentSession(session, async () => {
    await upsertTabLink(link);
    await upsertTabFromWire(
      link,
      { tab: resp.tab, entries: resp.entries, full: true },
      {
        origin: "local",
      },
    );
  });
  askNotifyPermission();
  return { link: (await getTabLink(link.tab_id)) ?? link, inviteUrl: resp.invite_url };
}

// ---------------------------------------------------------------------------
// Join (party b)

/** Resolve a deep link / invite token to the tab it opens, for the join screen. */
export async function fetchTabPreview(
  token: string,
): Promise<{ tab: WireTab; entries: WireEntry[] }> {
  return fetchTabByToken(token);
}

// ---------------------------------------------------------------------------
// Join preflight: which kaata, and in which currency (D9)

/**
 * Every kaata the join screen may attach a tab to, with the facts
 * planCurrency (lib/tabs/join-plan.ts) sorts them by: currency; whether the
 * book is empty (no live tally and never a tab — a switch relabels nothing);
 * whether an OPEN tab pins the currency (changeVaultCurrency's
 * VaultHasOpenTabError); and whether the active user's role may change it —
 * the same `vault.rename` gate vault/settings.tsx uses for its currency row.
 * Lives here rather than lib/tabs/db.ts because it reads listActiveVaults from
 * lib/db.ts, which imports tabs/db (the reverse edge would be a cycle — see
 * that file's header).
 */
export async function listVaultFactsForJoin(): Promise<VaultFacts[]> {
  const vaults = await listActiveVaults();
  const db = await getDb();
  const accountId = getAccountIdSync();
  const out: VaultFacts[] = [];
  for (const v of vaults) {
    // deleted_at IS NULL is the live-row predicate every entries read uses
    // (listEntries, the balance sums); is_deleted mirrors it as a cache.
    const live = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM entries WHERE vault_id = ? AND deleted_at IS NULL`,
      v.id,
    );
    const anyTab = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM tab_links WHERE vault_id = ? LIMIT 1`,
      v.id,
    );
    const role = await readVaultRole(v.id, accountId);
    out.push({
      id: v.id,
      name: v.name,
      currency: v.currency,
      liveEntries: live?.n ?? 0,
      hasAnyTab: anyTab != null,
      hasOpenTab: await vaultHasOpenTab(v.id),
      canChangeCurrency: canPerformAction(role, "vault.rename"),
    });
  }
  return out;
}

/** Select the invitation denomination without changing any stored amount. */
export async function switchVaultCurrencyForTab(_vaultId: string, currency: string): Promise<void> {
  setLedgerCurrencyCode(requireCurrencyCode(currency));
}

export type JoinTarget = { vaultId: string } & (
  | { personId: string }
  | {
      newPerson: {
        firstName: string;
        lastName: string | null;
        phone: string | null;
        /** ISO country for a national-format number (a phone-book contact or
         *  the invitation's own number, lib/tabs/join-plan.ts); omitted = the
         *  install default, as createPerson resolves it. */
        countryCode?: string;
      };
    }
);

/**
 * Join an invited tab as party b, attaching it to a contact in one of MY
 * kaatas. Order matters: the currency check (D9) and the already-linked check
 * run BEFORE any network write, so a refused join leaves nothing behind on
 * the server. A new contact goes through createPerson — the same phone
 * normalization, self-phone and per-vault duplicate rules as person/new —
 * and its structured refusal surfaces as TabCreatePersonError. Because
 * createPerson and the person screen both live in the ACTIVE vault, joining
 * into another kaata switches to it first (the invite-accept flow does the
 * same). With a session the join is followed by /bind so /mine recovers the
 * link after a reinstall; without one the token in tab_links is the credential.
 * My own phone is re-sent to the account first (best-effort) so party a's
 * screens can name me by number; a server currency_mismatch is retried once
 * after pushing the kaata's events (see joinFailure / serverStale).
 */
export async function joinTabAsContact(
  token: string,
  tab: WireTab,
  target: JoinTarget,
  myLabel: string,
): Promise<TabLink> {
  const session = await captureCurrentSession();
  if (!session.jwt) throw new TabAuthUnavailableError();
  if (tab.closed_at_ms != null) throw new TabClosedError();
  const label = cleanLabel(myLabel);
  const currency = requireCurrencyCode(tab.currency);
  await assertVaultAction(target.vaultId, "entry.amend");

  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== target.vaultId) {
      await setActiveVaultId(target.vaultId);
      await applyVaultCurrency(target.vaultId);
    }
    setLedgerCurrencyCode(currency);
  });

  let relId: string | null;
  // Set only when THIS call minted the contact, so a failed join can undo it.
  let createdPersonId: string | null = null;
  if ("personId" in target) {
    relId = await relationshipInVault(target.personId, target.vaultId);
    if (!relId) throw new TabInputError("no_relationship");
    // An open period already owns this contact. A closed period must finish
    // its pending reviews before a fresh binding can be acknowledged.
    const existing = await getAnyTabLinkForRelationship(relId, currency);
    if (existing && existing.closed_at == null) throw new TabAlreadyLinkedError(existing.tab_id);
  } else {
    const created = await applyForCurrentSession(session, async () => {
      if (getActiveVaultIdSyncMaybe() !== target.vaultId) throw new TabAuthUnavailableError();
      return createPerson(
        target.newPerson.firstName,
        target.newPerson.lastName,
        target.newPerson.phone,
        target.newPerson.countryCode,
      );
    });
    if (!created.ok) throw new TabCreatePersonError(created);
    createdPersonId = created.id;
    relId = await relationshipInVault(created.id, target.vaultId);
    if (!relId) throw new TabInputError("no_relationship");
  }

  const failureScope = { session, vaultId: target.vaultId };
  const historyReceipt = await prepareSharedHistory(relId, target.vaultId, currency, session).catch(
    async (err) => {
      throw await joinFailure(err, createdPersonId, currency, tab, false, failureScope);
    },
  );
  await resendSelfPhone();
  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== target.vaultId) throw new TabAuthUnavailableError();
  });
  const now = Date.now();
  const req = {
    ...historyReceipt,
    linked_at_ms: now,
    label,
    vault_id: target.vaultId,
    relationship_id: relId,
  };
  let resp: TabResponse;
  try {
    resp = await joinTab({ token, jwt: session.jwt }, tab.id, req);
  } catch (err) {
    if (!(err instanceof TabApiError && err.code === "currency_mismatch")) {
      throw await joinFailure(err, createdPersonId, currency, tab, false, failureScope);
    }
    // The local check above passed, so the server's vaults.currency is behind
    // this device's: the vault_setting_set{currency} event that changed it has
    // not been pushed yet (the server mirrors the column from that event, and
    // its join handler compares the tab against the column). Push and ask once
    // more; a second refusal is reported as "not synced yet" (serverStale)
    // rather than the self-contradicting "your kaata is in USD; this account
    // is in USD". The wait is capped: past it the drain runs on in the
    // background and the retry's own answer says whether it landed.
    await pushVaultBestEffort(target.vaultId, { capMs: RETRY_PUSH_CAP_MS });
    try {
      await applyForCurrentSession(session, async () => {
        if (getActiveVaultIdSyncMaybe() !== target.vaultId) throw new TabAuthUnavailableError();
      });
      resp = await joinTab({ token, jwt: session.jwt }, tab.id, req);
    } catch (retryErr) {
      throw await joinFailure(retryErr, createdPersonId, currency, tab, true, failureScope);
    }
  }
  const me = resp.tab.you;
  const them = me === "a" ? "b" : "a";
  const link: TabLink = {
    tab_id: resp.tab.id,
    vault_id: target.vaultId,
    relationship_id: relId,
    role: me,
    currency: resp.tab.currency,
    party_token: token,
    my_label: resp.tab.parties[me].label,
    other_label: resp.tab.parties[them].label,
    other_joined_at: resp.tab.parties[them].joined_at_ms,
    unjoined_invitation:
      typeof resp.tab.unjoined_invitation === "boolean"
        ? resp.tab.unjoined_invitation
          ? 1
          : 0
        : null,
    history_order: resp.tab.parties[me].history_order ?? null,
    invite_url: null,
    rev: 0,
    closed_at: resp.tab.closed_at_ms,
    linked_at: now,
    last_synced_at: null,
    last_error: null,
  };
  await applyForCurrentSession(session, async () => {
    await upsertTabLink(link);
    await upsertTabFromWire(link, resp, { origin: "local" });
  });
  askNotifyPermission();
  return (await getTabLink(link.tab_id)) ?? link;
}

// ---------------------------------------------------------------------------
// Tallies

/**
 * Add a tally to a linked contact's tab: optimistic pending row,
 * durable outbox op, immediate flush. Waits up to FIRST_FLUSH_WAIT_MS for the
 * server's answer so the caller can toast the D17 duplicate hint; offline, or
 * when the flush is slow, answers without it — the op is queued either way.
 * A verdict the server returns within the wait (tab_closed) is thrown as the
 * matching typed error, because the optimistic row has already been removed
 * and the user must know the tally did not land. lib/db.ts createEntry
 * delegates here when the person is linked.
 */
export async function addTabEntry(
  personId: string,
  type: EntryType,
  amount: number,
  note: string | null,
  expected?: {
    session: import("../auth").SessionSnapshot;
    vaultId: string;
    occurredAtMs?: number;
    currency?: string;
  },
): Promise<{ entryId: string; duplicateHint: DuplicateHint | null; pendingAdmission?: boolean }> {
  const currency = requireCurrencyCode(expected?.currency ?? getLedgerCurrencyCode());
  const link = await getTabLinkForPerson(personId, currency);
  if (!link) throw new TabInputError("not_linked");
  requireOpen(link);
  const session = expected?.session ?? (await captureCurrentSession());
  if (expected && link.vault_id !== expected.vaultId) throw new TabAuthUnavailableError();
  if (typeof amount !== "number" || parseAmountInput(String(amount)) !== amount) {
    throw new TabInputError("amount_invalid");
  }
  await assertVaultAction(link.vault_id, "entry.create");
  const admission = await needsSharedCreditAdmission(link);
  const cleanNote = note?.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null;
  const id = Crypto.randomUUID();
  const recordedAt = Date.now();
  const occurredAt = expected?.occurredAtMs ?? recordedAt;
  if (!isValidEntryDate(occurredAt)) throw new TabInputError("occurred_at_invalid");

  await applyForCurrentSession(session, async () => {
    if (getActiveVaultIdSyncMaybe() !== link.vault_id) throw new TabAuthUnavailableError();
    await queueTabMutation(
      link,
      {
        id,
        tab_id: link.tab_id,
        op: "append",
        payload: JSON.stringify({
          id,
          direction: directionFor(link.role, type),
          amount: minorToWire(toMinorUnits(amount)),
          note: cleanNote,
          occurred_at_ms: occurredAt,
        }),
        // Queue ordering and recorded-at evidence describe this save, even
        // when the transfer happened on an earlier day.
        created_at: recordedAt,
        attempts: 0,
        next_at: null,
        last_error: null,
      },
      { deferAppend: admission },
    );
  });

  let online = true;
  try {
    online = (await Network.getNetworkStateAsync()).isConnected !== false;
  } catch {
    /* probe failed — try anyway */
  }
  if (!online) {
    void syncTab(link.tab_id);
    return { entryId: id, duplicateHint: null, pendingAdmission: admission };
  }
  const flushed = await Promise.race([
    syncTab(link.tab_id).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), FIRST_FLUSH_WAIT_MS)),
  ]);
  if (!flushed) return { entryId: id, duplicateHint: null, pendingAdmission: admission };
  const outcome = takeAppendOutcome(id);
  if (outcome?.rejected === "tab_closed") throw new TabClosedError();
  if (outcome?.rejected)
    throw new TabApiError(409, outcome.rejected, `append refused: ${outcome.rejected}`);
  return {
    entryId: id,
    duplicateHint: outcome?.hint ?? null,
    pendingAdmission: admission && outcome == null,
  };
}

/**
 * Reviewing a tally handles its notice: the bell entry flips, the OS tray
 * clears and the read reaches the server through lib/tabs/inbox-reads.ts's
 * durable queue (the server also writes the reviewer's own read row inside
 * the review transaction, which covers a second phone on the same account).
 * The notice about a pending tally is the one at the tally's own rev — a
 * row's rev only moves with its status, and the optimistic status write
 * leaves it alone — so the mark is that exact (tab, rev) and the entry id is
 * a tray hint; only when the row is somehow not cached does the unbounded
 * entry form stand in. Fired after the op is durable and never awaited: a
 * mark can never fail or delay the review itself.
 */
function markReviewed(link: TabLink, entryId: string, session: SessionSnapshot): void {
  void (async () => {
    let rev: number | null = null;
    try {
      const db = await getDb();
      const row = await db.getFirstAsync<{ rev: number }>(
        "SELECT rev FROM tab_entries WHERE id = ? AND tab_id = ?",
        entryId,
        link.tab_id,
      );
      if (row && Number.isSafeInteger(row.rev) && row.rev > 0) rev = row.rev;
    } catch {
      /* the entry form below still names the notice */
    }
    await applyForCurrentSession(session, () =>
      markInboxHandled(
        rev != null
          ? { tab_id: link.tab_id, rev, entry_id: entryId }
          : { tab_id: link.tab_id, entry_id: entryId },
      ),
    );
  })().catch(() => undefined);
}

async function needsSharedCreditAdmission(link: TabLink): Promise<boolean> {
  const { hardLimitApplies } = await import("../credit-admission");
  const role = await readVaultRole(link.vault_id, getAccountIdSync());
  return hardLimitApplies(
    await getDb(),
    link.vault_id,
    link.relationship_id,
    role,
    getAccountIdSync(),
    link.currency,
  );
}

async function finishSharedCreditMutation(link: TabLink, opId: string): Promise<void> {
  await Promise.race([
    syncTab(link.tab_id),
    new Promise((resolve) => setTimeout(resolve, FIRST_FLUSH_WAIT_MS)),
  ]);
  const db = await getDb();
  const failed = await db.getFirstAsync<{ reason: string }>(
    "SELECT reason FROM tab_failed_ops WHERE id=?",
    opId,
  );
  if (failed) throw new TabApiError(409, failed.reason, "The change was not recorded");
  if (await db.getFirstAsync("SELECT id FROM tab_outbox WHERE id=?", opId))
    throw new TabApiError(409, "credit_confirmation_pending", "Waiting for server confirmation");
}

/** Accept the other party's tally: optimistic unless a hard limit requires confirmation. */
export async function acceptEntry(link: TabLink, entryId: string): Promise<void> {
  const session = await captureCurrentSession();
  await assertVaultAction(link.vault_id, "entry.amend");
  const deferred = await needsSharedCreditAdmission(link);
  const opId = await newOp(link, "accept", { entry_id: entryId }, undefined, {
    deferFinancial: deferred,
    session,
  });
  markReviewed(link, entryId, session);
  if (deferred) return finishSharedCreditMutation(link, opId);
  void syncTab(link.tab_id);
}

/** Reject the other party's tally, with an optional reason (≤ 300 chars). */
export async function disputeEntry(link: TabLink, entryId: string, reason: string): Promise<void> {
  const session = await captureCurrentSession();
  const clean = reason.trim();
  if (clean.length > REASON_MAX) throw new TabInputError("reason_too_long");
  await assertVaultAction(link.vault_id, "entry.amend");
  const deferred = await needsSharedCreditAdmission(link);
  const opId = await newOp(link, "dispute", { entry_id: entryId, reason: clean }, undefined, {
    deferFinancial: deferred,
    session,
  });
  markReviewed(link, entryId, session);
  if (deferred) return finishSharedCreditMutation(link, opId);
  void syncTab(link.tab_id);
}

/** Cancel my pending tally. The cache and server both refuse reviewed rows. */
export async function voidEntry(link: TabLink, entryId: string): Promise<void> {
  const session = await captureCurrentSession();
  await assertVaultAction(link.vault_id, "entry.amend");
  const opId = Crypto.randomUUID();
  const deferred = await needsSharedCreditAdmission(link);
  await newOp(link, "void", { entry_id: entryId }, opId, { deferFinancial: deferred, session });
  // No markReviewed: a party gets no notice about its OWN pending tally (the
  // creation notice went to the other side), so there is nothing to read
  // here — the server's void path marks nothing for the same reason, and the
  // counterparty's entry_voided notice is theirs to handle.
  if (deferred) return finishSharedCreditMutation(link, opId);
  void syncTab(link.tab_id);
}

/** Settlement is server-confirmed only: no offline optimistic fold can hide money. */
export async function settleSharedTab(link: TabLink, requestId: string): Promise<void> {
  requireOpen(link);
  const session = await captureCurrentSession();
  await assertVaultAction(link.vault_id, "entry.amend");
  const synced = await syncTab(link.tab_id);
  if (!synced.ok || synced.error) throw new TabAuthUnavailableError();
  const fresh = await getTabLink(link.tab_id);
  if (!fresh) throw new TabClosedError();
  requireOpen(fresh);
  if (fresh.rev !== link.rev)
    throw new TabApiError(
      409,
      "stale_settlement",
      "Shared history changed; review before clearing",
    );
  const db = await getDb();
  const pending = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tab_outbox WHERE tab_id = ?`,
    link.tab_id,
  );
  if (pending?.n)
    throw new TabApiError(409, "settlement_pending", "Pending changes must sync before clearing");
  const auth = await applyForCurrentSession(session, () => resolveTabAuth(fresh));
  const response = await settleTab(auth, fresh.tab_id, requestId, fresh.rev);
  await applyForCurrentSession(session, () =>
    upsertTabFromWire(
      fresh,
      { tab: response.tab, entries: [], settlements: [response.settlement], full: false },
      { advanceCursor: false },
    ),
  );
  void syncTab(fresh.tab_id);
}

/** Rename how I appear to the other party. */
export async function setMyLabel(link: TabLink, label: string): Promise<void> {
  const session = await captureCurrentSession();
  requireOpen(link);
  const clean = cleanLabel(label);
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "label", { label: clean }, undefined, { session });
  void syncTab(link.tab_id);
}

/**
 * Unlink stops new sharing (either party may), without settling the balance
 * or preventing final review/withdrawal of existing pending tallies. The server close
 * rides the outbox and is flushed even though the link is no longer open
 * (syncAllTabs sweeps queued ops on closed links too).
 */
export async function unlinkContact(link: TabLink): Promise<void> {
  const session = await captureCurrentSession();
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "close", { withdraw_unjoined_opening: true }, undefined, { session });
  void syncTab(link.tab_id);
}

/**
 * Party a only: rotate B's link (D11 — the old link stops working for
 * everyone who has it). Network-synchronous, since the new URL is what the
 * caller shares next. Returns the new invite URL and stores it on the link.
 */
export async function regenerateInviteLink(link: TabLink): Promise<string> {
  requireOpen(link);
  if (link.role !== "a") throw new TabPermissionError();
  await assertVaultAction(link.vault_id, "entry.amend");
  const auth = await resolveTabAuth(link);
  const { invite_url } = await regenerateTabLink(auth, link.tab_id);
  await setTabInviteUrl(link.tab_id, invite_url);
  return invite_url;
}

/**
 * Open WhatsApp with the caller-composed invite `text` (the message already
 * contains the link), addressed to the contact's number when we have one —
 * the lib/share.ts shape. Counts a share only after the open succeeded.
 * Returns true when WhatsApp opened.
 */
export async function shareTabLinkOnWhatsApp(
  link: TabLink,
  person: { phone: string | null },
  text: string,
): Promise<boolean> {
  if (!link.invite_url) return false;
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  try {
    await Linking.openURL(url);
  } catch (err) {
    console.warn("[tabs.link] WhatsApp open failed", err);
    return false;
  }
  await bumpUsageCounter("shares_sent").catch(() => undefined);
  return true;
}
