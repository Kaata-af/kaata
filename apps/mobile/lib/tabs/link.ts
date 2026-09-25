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

import { getSessionJWT } from "../auth";
import { applyVaultCurrency } from "../currency";
import {
  archivePerson,
  bumpUsageCounter,
  createPerson,
  getActiveRelationshipIdForPerson,
  getPerson,
} from "../db";
import { getAccountIdSync, getActiveVaultIdSyncMaybe, getDb, setActiveVaultId } from "../db-tx";
import { parseAmountInput, toMinorUnits } from "../money";
import { ENTRY_NOTE_MAX_LENGTH, type EntryType } from "../types";
import { readVaultRole } from "../use-vault-role";
import { canPerformAction, type VaultAction } from "../vault-roles";
import { createTab, fetchTabByToken, joinTab, regenerateTabLink, resolveTabAuth } from "./api";
import {
  queueTabMutation,
  getTabLink,
  getAnyTabLinkForRelationship,
  getTabLinkForPerson,
  getTabLinkForRelationship,
  setTabInviteUrl,
  upsertTabFromWire,
  upsertTabLink,
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
  TabSameKaataError,
  isRetryableTabError,
} from "./errors";
import { reconcileTabsFromServer, syncTab, takeAppendOutcome } from "./sync";
import type { DuplicateHint, TabLink, TabOutboxRow, WireEntry, WireTab } from "./types";
import { minorToWire } from "./wire";

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

async function vaultCurrency(vaultId: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ currency: string | null }>(
    "SELECT currency FROM vaults WHERE id = ?",
    vaultId,
  );
  return row?.currency && row.currency.length > 0 ? row.currency : null;
}

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

async function newOp(
  link: TabLink,
  op: TabOutboxRow["op"],
  payload: Record<string, unknown>,
  id = Crypto.randomUUID(),
): Promise<string> {
  if (!(await getSessionJWT())) throw new TabAuthUnavailableError();
  await queueTabMutation(link, {
    id,
    tab_id: link.tab_id,
    op,
    payload: JSON.stringify(payload),
    created_at: Date.now(),
    attempts: 0,
    next_at: null,
    last_error: null,
  });
  return id;
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
  opts: { myLabel: string; openingNote?: string | null },
): Promise<{ link: TabLink; inviteUrl: string }> {
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) throw new TabInputError("no_active_vault");
  const label = cleanLabel(opts.myLabel);
  await assertVaultAction(vaultId, "entry.amend");
  const relId = await getActiveRelationshipIdForPerson(personId);
  if (!relId) throw new TabInputError("no_relationship");
  const existing = await getTabLinkForRelationship(relId);
  if (existing) throw new TabAlreadyLinkedError(existing.tab_id);
  const currency = await vaultCurrency(vaultId);
  if (!currency) throw new TabInputError("currency_unknown");

  // The opening entry carries the contact's balance AS THE SHOPKEEPER SEES IT
  // — getPerson's number, not a fresh sum of the local rows. Those differ the
  // moment a contact has been linked before: a closed tab's rows still count
  // and its pre-link rows are still excluded (D8), so re-summing `entries`
  // here would carry a number that has not been on screen for months and
  // would double-count the rows the previous tab's own opening entry already
  // absorbed. D7's promise is that the counterparty sees exactly what was
  // carried over, which means exactly what was displayed.
  const current = await getPerson(personId);
  if (!current) throw new TabInputError("no_relationship");
  const balanceMinor = toMinorUnits(current.balance);
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

  const signedIn = (await getSessionJWT().catch(() => null)) != null;
  if (!signedIn) throw new TabAuthUnavailableError();
  const resp = await createTab({
    linked_at_ms: now,
    currency,
    label,
    vault_id: signedIn ? vaultId : null,
    relationship_id: signedIn ? relId : null,
    opening,
  }).catch(async (err: unknown) => {
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
    invite_url: resp.invite_url,
    rev: 0,
    closed_at: resp.tab.closed_at_ms,
    linked_at: now,
    last_synced_at: null,
    last_error: null,
  };
  await upsertTabLink(link);
  await upsertTabFromWire(
    link,
    { tab: resp.tab, entries: resp.entries, full: true },
    {
      origin: "local",
    },
  );
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

export type JoinTarget = { vaultId: string } & (
  | { personId: string }
  | { newPerson: { firstName: string; lastName: string | null; phone: string | null } }
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
 */
export async function joinTabAsContact(
  token: string,
  tab: WireTab,
  target: JoinTarget,
  myLabel: string,
): Promise<TabLink> {
  if (tab.closed_at_ms != null) throw new TabClosedError();
  const label = cleanLabel(myLabel);
  const currency = await vaultCurrency(target.vaultId);
  if (!currency) throw new TabInputError("currency_unknown");
  if (currency !== tab.currency) throw new TabCurrencyMismatchError(currency, tab.currency);
  await assertVaultAction(target.vaultId, "entry.amend");

  if (getActiveVaultIdSyncMaybe() !== target.vaultId) {
    await setActiveVaultId(target.vaultId);
    await applyVaultCurrency(target.vaultId);
  }

  let relId: string | null;
  // Set only when THIS call minted the contact, so a failed join can undo it.
  let createdPersonId: string | null = null;
  if ("personId" in target) {
    relId = await relationshipInVault(target.personId, target.vaultId);
    if (!relId) throw new TabInputError("no_relationship");
    // ANY tab, not just an open one: see getAnyTabLinkForRelationship. A
    // second tab on a contact that already holds a frozen one would zero its
    // balance without a word, because party b mints no opening entry.
    const existing = await getAnyTabLinkForRelationship(relId);
    if (existing) throw new TabAlreadyLinkedError(existing.tab_id);
  } else {
    const created = await createPerson(
      target.newPerson.firstName,
      target.newPerson.lastName,
      target.newPerson.phone,
    );
    if (!created.ok) throw new TabCreatePersonError(created);
    createdPersonId = created.id;
    relId = await relationshipInVault(created.id, target.vaultId);
    if (!relId) throw new TabInputError("no_relationship");
  }

  const signedIn = (await getSessionJWT().catch(() => null)) != null;
  const now = Date.now();
  let resp;
  try {
    resp = await joinTab({ token }, tab.id, {
      linked_at_ms: now,
      label,
      vault_id: signedIn ? target.vaultId : null,
      relationship_id: signedIn ? relId : null,
    });
  } catch (err) {
    // The contact was minted for a join that did not happen. Leaving it makes
    // the obvious retry — same name, same number — fail with phone_conflict on
    // a contact the person never knowingly created, which is a baffling way to
    // meet the app: this is the counterparty's FIRST screen. Archiving clears
    // the number off the active set, so the retry behaves like a first try.
    // Best effort; the join error is what the caller must see.
    // A timeout is ambiguous: the server may already have attached this
    // exact contact. Keep it so recovery/retry cannot orphan that binding.
    if (createdPersonId && err instanceof TabApiError && !isRetryableTabError(err)) {
      try {
        await archivePerson(createdPersonId);
      } catch (cleanupErr) {
        console.warn("[tabs.link] could not roll back the contact after a failed join", cleanupErr);
      }
    }
    if (err instanceof TabApiError) {
      if (err.code === "same_kaata") throw new TabSameKaataError();
      if (err.code === "tab_closed") throw new TabClosedError();
      if (err.code === "currency_mismatch")
        throw new TabCurrencyMismatchError(currency, tab.currency);
      if (err.code === "already_linked") throw new TabAlreadyLinkedError(tab.id);
    }
    throw err;
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
    invite_url: null,
    rev: 0,
    closed_at: resp.tab.closed_at_ms,
    linked_at: now,
    last_synced_at: null,
    last_error: null,
  };
  await upsertTabLink(link);
  await upsertTabFromWire(link, resp, { origin: "local" });
  askNotifyPermission();
  return (await getTabLink(link.tab_id)) ?? link;
}

// ---------------------------------------------------------------------------
// Tallies

/**
 * Add a tally to a linked contact's tab: optimistic row (counts at once),
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
): Promise<{ entryId: string; duplicateHint: DuplicateHint | null }> {
  const link = await getTabLinkForPerson(personId);
  if (!link) throw new TabInputError("not_linked");
  requireOpen(link);
  if (typeof amount !== "number" || parseAmountInput(String(amount)) !== amount) {
    throw new TabInputError("amount_invalid");
  }
  await assertVaultAction(link.vault_id, "entry.create");
  const cleanNote = note?.trim().slice(0, ENTRY_NOTE_MAX_LENGTH) || null;
  const id = Crypto.randomUUID();
  const occurredAt = Date.now();

  await newOp(
    link,
    "append",
    {
      id,
      direction: directionFor(link.role, type),
      amount: minorToWire(toMinorUnits(amount)),
      note: cleanNote,
      occurred_at_ms: occurredAt,
    },
    id, // the op id IS the entry id: the server's idempotency key
  );

  let online = true;
  try {
    online = (await Network.getNetworkStateAsync()).isConnected !== false;
  } catch {
    /* probe failed — try anyway */
  }
  if (!online) {
    void syncTab(link.tab_id);
    return { entryId: id, duplicateHint: null };
  }
  const flushed = await Promise.race([
    syncTab(link.tab_id).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), FIRST_FLUSH_WAIT_MS)),
  ]);
  if (!flushed) return { entryId: id, duplicateHint: null };
  const outcome = takeAppendOutcome(id);
  if (outcome?.rejected === "tab_closed") throw new TabClosedError();
  if (outcome?.rejected)
    throw new TabApiError(409, outcome.rejected, `append refused: ${outcome.rejected}`);
  return { entryId: id, duplicateHint: outcome?.hint ?? null };
}

/** Accept the other party's tally: optimistic status, outbox, flush. */
export async function acceptEntry(link: TabLink, entryId: string): Promise<void> {
  requireOpen(link);
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "accept", { entry_id: entryId });
  void syncTab(link.tab_id);
}

/** Reject the other party's tally, with an optional reason (≤ 300 chars). */
export async function disputeEntry(link: TabLink, entryId: string, reason: string): Promise<void> {
  requireOpen(link);
  const clean = reason.trim();
  if (clean.length > REASON_MAX) throw new TabInputError("reason_too_long");
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "dispute", { entry_id: entryId, reason: clean });
  void syncTab(link.tab_id);
}

/** Cancel my pending tally. The cache and server both refuse reviewed rows. */
export async function voidEntry(link: TabLink, entryId: string): Promise<void> {
  requireOpen(link);
  await assertVaultAction(link.vault_id, "entry.amend");
  const opId = Crypto.randomUUID();
  await newOp(link, "void", { entry_id: entryId }, opId);
  void syncTab(link.tab_id);
}

/** Rename how I appear to the other party. */
export async function setMyLabel(link: TabLink, label: string): Promise<void> {
  requireOpen(link);
  const clean = cleanLabel(label);
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "label", { label: clean });
  void syncTab(link.tab_id);
}

/**
 * Unlink = close the tab (either party may). Closed locally first so the
 * shared period freezes while remaining in the balance; the server close
 * rides the outbox and is flushed even though the link is no longer open
 * (syncAllTabs sweeps queued ops on closed links too).
 */
export async function unlinkContact(link: TabLink): Promise<void> {
  await assertVaultAction(link.vault_id, "entry.amend");
  await newOp(link, "close", {});
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
