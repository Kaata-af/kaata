// apps/mobile/lib/tabs/sync.ts
//
// The tab sync loop: close sharing first when requested, otherwise flush this
// device's financial outbox ops for a tab IN ORDER, then
// pull `after_rev` from the server, apply, repeat on a cadence. It is a
// sibling of lib/sync/scheduler.ts, not a leg of it, for one reason the
// scheduler cannot accommodate: AutoSync mounts the scheduler only when
// app_meta.account_id AND active_vault_id are set, and syncOnce returns early
// without a JWT. This loop is mounted unconditionally (components/TabSync.tsx)
// so restores and mid-session sign-in are picked up without a remount. Every
// shared-account request still requires a JWT through resolveTabAuth; saved
// party tokens are only for signed-in legacy claims.
//
// Shape copied from the scheduler's pushVaultNow: ONE run in flight per tab,
// a second request during the run marks it dirty and gets a single trailing
// run — a burst of K writes costs ~2 round trips and never interleaves two
// flushes of the same outbox. Foreground only (start, AppState → active, every
// 5 s while active): pokes on the live socket (D13, wired by the scheduler
// through requestTabSync) are the fast path, the short poll is the backstop,
// and in the background nothing runs — iOS suspends JS within seconds anyway.
//
// Failure policy for an outbox op, in isRetryableTabError's terms:
//   retryable (transport / 408 / 429 / 5xx) → attempts+1, exponential backoff
//     30 s doubling to a 1 h cap (lib/sync/push.ts rejectBackoffMs), and the
//     flush STOPS for this tab so a later op can never overtake the failed one;
//   a verdict (non-auth 4xx: tab_closed, not_author, already_voided,
//     tab_not_found…) → the op is dropped, an optimistic append is deleted,
//     and the next pull is forced FULL so an optimistic status the server
//     refused is overwritten by the truth (an incremental pull would skip an
//     unchanged row and leave the lie in place).
// syncTab never throws; whatever went wrong lands in tab_links.last_error for
// the App health report and in the returned SyncTabResult for the caller.

import { AppState } from "react-native";
import * as Network from "expo-network";

import {
  applyForCurrentSession,
  captureCurrentSession,
  getSessionJWT,
  SessionChangedError,
  type SessionSnapshot,
} from "../auth";
import { getDb } from "../db-tx";
import { onLedgerApplied } from "../ledger-events";
import {
  acceptTabEntry,
  appendTabEntry,
  bindTab,
  closeTab,
  disputeTabEntry,
  fetchMine,
  fetchTab,
  resolveTabAuth,
  setTabLabel,
  voidTabEntry,
  type TabAuth,
} from "./api";
import {
  completeTabOp,
  rejectTabOp,
  entriesResponse,
  failTabOp,
  getTabLink,
  listDueTabOps,
  listTabIdsWithQueuedOps,
  listTabLinks,
  makeWaitingTabOpsDueNow,
  setTabLinkError,
  upsertTabFromWire,
  upsertTabLink,
} from "./db";
import { otherRole } from "./direction";
import { isRetryableTabError, TabApiError, TabAuthUnavailableError } from "./errors";
import { flushInboxReads } from "./inbox-reads";
import type { AppendRequest, DuplicateHint, TabLink, TabOutboxRow, TabResponse } from "./types";

export { onTabApplied } from "./events";

// Same coalescing window as the scheduler's POKE_DEBOUNCE_MS: the server pokes
// every subscriber including the writer, and a burst of pokes for one tab is
// one pull.
const DEBOUNCE_MS = 300;
// The foreground backstop. Pokes make the common case ~1 RTT; this catches a
// dropped socket or a missed account-channel invalidation. Each tick pulls only
// the tabs where a wait is felt (isHot); every link is pulled once a minute.
// Pulling every link every 5 s spent the server's per-network read budget
// (GET /v1/tabs/{id}: 3000/h per IP) with five shared contacts on one phone,
// and carrier NAT shares that budget between shops.
const LOOP_INTERVAL_MS = 5_000;
const FULL_SWEEP_INTERVAL_MS = 60_000;
// A poke (or the person screen's focus request) keeps a tab on the fast
// cadence this long, for the follow-up review or reply.
const RECENT_POKE_MS = 2 * 60_000;
// Finding new bindings is account-wide and more expensive than pulling a
// cached tab. Do it once a minute, plus sign-in/restore/resume and unknown pokes.
const DISCOVERY_INTERVAL_MS = 60_000;
// A failed discovery waits 15 s, 30 s, … up to 5 min instead of rerunning
// before every 5 s pass (GET /v1/tabs/mine is capped at 600/h per IP).
const DISCOVERY_RETRY_BASE_MS = 15_000;
const DISCOVERY_RETRY_CAP_MS = 5 * 60_000;
// A 429 without Retry-After pauses the loop this long.
const RATE_LIMIT_PAUSE_MS = 60_000;
// One slow tab must not hold every other contact behind its 15 s timeout.
// Keep request fan-out bounded on phones with many shared contacts.
const SYNC_WORKERS = 3;
// Op retry ladder — lib/sync/push.ts rejectBackoffMs, same constants.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/**
 * Backoff before the `failedAttempts`-th consecutive failure is retried:
 * 30 s, 1 m, 2 m, … capped at 1 h. Pure; pinned by the selftest.
 */
export function tabOpBackoffMs(failedAttempts: number): number {
  // 2 ** large is Infinity; Math.min clamps it to the cap.
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failedAttempts - 1));
}

export type SyncTabResult = {
  /** False when the pull itself failed (auth, offline, transport, verdict). */
  ok: boolean;
  /** Ops acked by the server in this run. */
  flushed: number;
  /** Ops that failed (retryable → backed off; verdict → dropped). */
  failed: number;
  /** Entries the pull returned. */
  pulled: number;
  newFromThem: number;
  statusChangedOnMine: number;
  /** Short reason for the last failure, or null. */
  error: string | null;
};

// Tabs whose next pull must be after_rev=0 (a dropped verdict left optimistic
// state the server disagrees with). rejectTabOp ALSO resets the persisted
// cursor to zero, so this correction survives a crash/relaunch while offline.
const needFullPull = new Set<string>();

/** Outcome of an append op for the caller that queued it (lib/tabs/link.ts). */
export type AppendOutcome = {
  hint: DuplicateHint | null;
  /** error_code when the server refused for good (e.g. "tab_closed"); null on ack. */
  rejected: string | null;
};
const appendOutcomes = new Map<string, AppendOutcome>();

/** Collect (once) the server's answer to an append op flushed by syncTab. */
export function takeAppendOutcome(opId: string): AppendOutcome | null {
  const out = appendOutcomes.get(opId) ?? null;
  appendOutcomes.delete(opId);
  return out;
}

async function isOnline(): Promise<boolean> {
  try {
    const net = await Network.getNetworkStateAsync();
    return net.isConnected !== false;
  } catch {
    // A failed probe must not silence sync; the request itself will tell.
    return true;
  }
}

function describe(err: unknown): string {
  if (err instanceof TabApiError) return err.status ? `${err.status} ${err.code}` : err.code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `fn` with `auth`; when the JWT is refused (401, or 404 tab_not_found —
 * the account is not bound to this party, e.g. bind failed at join time) and
 * the link still holds its party token, attempt an authenticated legacy
 * claim and retry with the JWT. Never fall back to anonymous authority.
 */
async function withAuthFallback<T>(
  link: TabLink,
  auth: TabAuth,
  fn: (a: TabAuth) => Promise<T>,
): Promise<{ value: T; auth: TabAuth }> {
  try {
    return { value: await fn(auth), auth };
  } catch (err) {
    const jwtRefused =
      err instanceof TabApiError &&
      "jwt" in auth &&
      (err.status === 401 || (err.status === 404 && err.code === "tab_not_found"));
    if (!jwtRefused || !link.party_token) throw err;
    // Legacy signed-out tabs can be claimed once with a session + token.
    // Never retry a rejected session as an anonymous write capability.
    await bindTab(
      link.party_token,
      link.tab_id,
      {
        vault_id: link.vault_id,
        relationship_id: link.relationship_id,
        linked_at_ms: link.linked_at,
      },
      link.recording_mode,
      link.recording_mode_known !== 0,
    );
    return { value: await fn(auth), auth };
  }
}

type OpResult = { apply: TabResponse | null; hint: DuplicateHint | null };

/** One outbox op → one route. Payload shapes are what lib/tabs/link.ts enqueues. */
async function performOp(auth: TabAuth, link: TabLink, op: TabOutboxRow): Promise<OpResult> {
  const payload = JSON.parse(op.payload) as Record<string, unknown>;
  switch (op.op) {
    case "append": {
      const r = await appendTabEntry(auth, link.tab_id, payload as AppendRequest);
      return { apply: entriesResponse(r.tab, [r.entry]), hint: r.duplicate_hint };
    }
    case "accept": {
      const r = await acceptTabEntry(
        auth,
        link.tab_id,
        String(payload.entry_id),
        typeof payload.expected_rev === "number" ? payload.expected_rev : undefined,
      );
      return { apply: entriesResponse(r.tab, [r.entry]), hint: null };
    }
    case "dispute": {
      const r = await disputeTabEntry(
        auth,
        link.tab_id,
        String(payload.entry_id),
        String(payload.reason ?? ""),
        typeof payload.expected_rev === "number" ? payload.expected_rev : undefined,
      );
      return { apply: entriesResponse(r.tab, [r.entry]), hint: null };
    }
    case "void":
      // VoidResponse carries no tab meta, so nothing is applied here: the
      // pull that follows every flush delivers both rows (rev > cursor) and
      // replaces the optimistic marker with the real void id.
      await voidTabEntry(auth, link.tab_id, String(payload.entry_id));
      return { apply: null, hint: null };
    case "label":
      return {
        apply: await setTabLabel(auth, link.tab_id, String(payload.label ?? "")),
        hint: null,
      };
    case "close":
      return {
        apply: await closeTab(auth, link.tab_id, {
          withdraw_unjoined_opening: payload.withdraw_unjoined_opening === true,
        }),
        hint: null,
      };
  }
}

async function runSyncTab(tabId: string): Promise<SyncTabResult> {
  const result: SyncTabResult = {
    ok: true,
    flushed: 0,
    failed: 0,
    pulled: 0,
    newFromThem: 0,
    statusChangedOnMine: 0,
    error: null,
  };
  let session: SessionSnapshot | null = null;
  try {
    session = await captureCurrentSession();
    const cachedLink = await getTabLink(tabId);
    if (!cachedLink) return { ...result, ok: false, error: "no_link" };
    let link: TabLink = cachedLink;
    // Offline is not an error worth recording — it is the normal state of a
    // shop with patchy data; the outbox waits and nothing is lost.
    if (!(await isOnline())) return { ...result, ok: false, error: "offline" };

    let auth: TabAuth;
    try {
      auth = await resolveTabAuth(link);
      await applyForCurrentSession(session, async () => {});
    } catch (err) {
      if (!(err instanceof TabAuthUnavailableError)) throw err;
      await applyForCurrentSession(session, () => setTabLinkError(tabId, "auth_unavailable")).catch(
        () => {},
      );
      return { ...result, ok: false, error: "auth_unavailable" };
    }

    // A restored old-server binding may be a review book or a new notify
    // book whose mode was omitted. Read explicit metadata before flushing
    // any durable intent; a capability probe alone cannot identify the book.
    if (link.recording_mode_known === 0) {
      await applyForCurrentSession(session, async () => {});
      const response = await fetchTab(auth, tabId, 0);
      await applyForCurrentSession(session, () => upsertTabFromWire(link!, response));
      const refreshed = await getTabLink(tabId);
      if (!refreshed || refreshed.recording_mode_known === 0)
        throw new TabApiError(
          503,
          "notification_only_unsupported",
          "Account recording mode requires a server update",
        );
      link = refreshed;
      auth = await applyForCurrentSession(session, () => resolveTabAuth(refreshed));
    }

    // Stop unwanted incoming activity before waiting out an older append's
    // network backoff. Only close may overtake financial operations; its own
    // backoff still applies. While close is waiting, upload no new tallies.
    const queuedClose = await (
      await getDb()
    ).getFirstAsync<TabOutboxRow>(
      `SELECT * FROM tab_outbox WHERE tab_id = ? AND op = 'close' ORDER BY rowid LIMIT 1`,
      tabId,
    );
    const closeDue =
      queuedClose != null && (queuedClose.next_at == null || queuedClose.next_at <= Date.now());
    const due = queuedClose && !closeDue ? [] : await listDueTabOps(tabId);
    const ops = closeDue ? [queuedClose, ...due.filter((op) => op.id !== queuedClose.id)] : due;

    // ---- flush; financial operations retain their relative order ---------
    let flushError: string | null = null;
    for (const op of ops) {
      try {
        await applyForCurrentSession(session, async () => {});
        const r = await withAuthFallback(link, auth, (a) => performOp(a, link, op));
        auth = r.auth;
        await applyForCurrentSession(session, async () => {
          if (r.value.apply) {
            // The ack is one row, not the range up to its rev — never let it
            // move the cursor, or the pull below skips whatever the other party
            // wrote in between (see upsertTabFromWire).
            const c = await upsertTabFromWire(link, r.value.apply, { advanceCursor: false });
            result.newFromThem += c.newFromThem;
            result.statusChangedOnMine += c.statusChangedOnMine;
          }
          // Keep the operation durable until its acknowledged state is cached.
          await completeTabOp(op.id);
          if (op.op === "append") appendOutcomes.set(op.id, { hint: r.value.hint, rejected: null });
          result.flushed++;
        });
      } catch (err) {
        if (err instanceof SessionChangedError) throw err;
        result.failed++;
        if (err instanceof TabApiError && !isRetryableTabError(err)) {
          // A verdict: the server will say the same thing forever. Drop the
          // op, undo what it promised locally, and let a full pull restate
          // the truth.
          await applyForCurrentSession(session, () => rejectTabOp(op, err.code));
          if (op.op === "append") {
            appendOutcomes.set(op.id, { hint: null, rejected: err.code });
          }
          needFullPull.add(tabId);
          flushError = `${op.op}: ${describe(err)}`;
          if (__DEV__) console.warn("[tabs.sync] op dropped", op.op, err.code);
          // A refused close must first show the server's actual open state.
          // Leave every other intent durable rather than sending new activity
          // in the same run that failed to stop it.
          if (op.op === "close") break;
          continue;
        }
        // Transient (or unexpected — a malformed payload is logged the same
        // way and retried on the ladder rather than crashing the loop).
        await applyForCurrentSession(session, () =>
          failTabOp(op.id, describe(err), tabOpBackoffMs(op.attempts + 1)),
        );
        flushError = `${op.op}: ${describe(err)}`;
        if (__DEV__) console.warn("[tabs.sync] op deferred", op.op, describe(err));
        break;
      }
    }

    // ---- pull ---------------------------------------------------------------
    // Re-read the link: the flush's applies advanced the cursor and may have
    // switched the credential; both must feed the pull.
    const fresh = (await getTabLink(tabId)) ?? link;
    const afterRev = needFullPull.has(tabId) ? 0 : fresh.rev;
    await applyForCurrentSession(session, async () => {});
    const pulled = await withAuthFallback(fresh, auth, (a) => fetchTab(a, tabId, afterRev));
    const c = await applyForCurrentSession(session, () => upsertTabFromWire(fresh, pulled.value));
    needFullPull.delete(tabId);
    result.pulled = pulled.value.entries.length;
    result.newFromThem += c.newFromThem;
    result.statusChangedOnMine += c.statusChangedOnMine;

    // Old clients could close an unused invitation while leaving its copied
    // opening pending. Repair that server-confirmed closed state before the
    // original private entries can be edited. The server rechecks participation
    // atomically and withdraws only the opening, never ordinary pending claims.
    // A queued close retains its own retry order and backoff.
    if (
      !flushError &&
      fresh.role === "a" &&
      pulled.value.tab.you === "a" &&
      pulled.value.tab.closed_at_ms != null &&
      pulled.value.tab.unjoined_invitation === true
    ) {
      const repairable = await applyForCurrentSession(session, async () => {
        const db = await getDb();
        return db.getFirstAsync<{ one: number }>(
          `SELECT 1 AS one FROM tab_entries opening JOIN tab_links l ON l.tab_id=opening.tab_id
            WHERE l.tab_id=? AND l.role='a' AND l.closed_at IS NOT NULL
              AND l.unjoined_invitation=1 AND l.other_joined_at IS NULL
              AND opening.kind='opening' AND opening.created_by='a'
              AND opening.status='pending' AND opening.voided_by_entry_id IS NULL
              AND NOT EXISTS(SELECT 1 FROM tab_outbox o WHERE o.tab_id=l.tab_id AND o.op='close')
            LIMIT 1`,
          tabId,
        );
      });
      if (repairable) {
        try {
          await applyForCurrentSession(session, async () => {});
          const repaired = await withAuthFallback(fresh, auth, (a) =>
            closeTab(a, tabId, { withdraw_unjoined_opening: true }),
          );
          auth = repaired.auth;
          const changes = await applyForCurrentSession(session, () =>
            upsertTabFromWire(fresh, repaired.value, {
              advanceCursor: repaired.value.full === true,
            }),
          );
          result.newFromThem += changes.newFromThem;
          result.statusChangedOnMine += changes.statusChangedOnMine;
        } catch (err) {
          // Viewers and clerks can still refresh history. A permission change
          // must not turn a successful read into a recurring failed sync.
          if (
            !(err instanceof TabApiError && err.status === 403 && err.code === "role_insufficient")
          )
            throw err;
        }
      }
    }

    // The successful pull cleared last_error; a flush failure in the same run
    // is still worth a line in App health until the next clean run.
    if (flushError) {
      result.error = flushError;
      await applyForCurrentSession(session, () => setTabLinkError(tabId, flushError!));
    }
    // The link is up: notices handled offline (lib/tabs/inbox-reads.ts) go
    // out now rather than waiting for the bell to be looked at, so the
    // server can drop a push still queued for them. Never awaited, never
    // throws, and independent of this run's outcome.
    void flushInboxReads();
    return result;
  } catch (err) {
    noteRateLimit(err);
    const msg = describe(err);
    if (__DEV__) console.warn("[tabs.sync] syncTab failed", tabId.slice(0, 8), msg);
    if (session && !(err instanceof SessionChangedError)) {
      await applyForCurrentSession(session, () => setTabLinkError(tabId, msg)).catch(() => {});
    }
    return { ...result, ok: false, error: msg };
  }
}

// Per-tab coalescing: `current` is the run in flight, `trailing` the single
// queued follow-up that every request during the run collapses into.
const current = new Map<string, Promise<SyncTabResult>>();
const trailing = new Map<string, Promise<SyncTabResult>>();

/**
 * Flush this tab's due outbox ops in order, then pull after its cursor.
 * Coalesced per tab (one in flight, one trailing); the returned promise
 * settles when the run that includes the caller's request completes. Never
 * rejects.
 */
export function syncTab(tabId: string): Promise<SyncTabResult> {
  const running = current.get(tabId);
  if (!running) {
    const run = runSyncTab(tabId).finally(() => {
      if (current.get(tabId) === run) current.delete(tabId);
    });
    current.set(tabId, run);
    return run;
  }
  const queued = trailing.get(tabId);
  if (queued) return queued;
  const next: Promise<SyncTabResult> = running
    .then(() => {
      trailing.delete(tabId);
      current.set(tabId, next);
      return runSyncTab(tabId);
    })
    .finally(() => {
      if (current.get(tabId) === next) current.delete(tabId);
    });
  trailing.set(tabId, next);
  return next;
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function syncPokedTab(tabId: string): Promise<void> {
  // A tab linked on another phone does not exist in this phone's SQLite yet.
  // Pulling it directly used to return no_link, throwing away the only live
  // invalidation and leaving the pre-link local book on screen until a sweep.
  if (!(await getTabLink(tabId))) await reconcileTabsFromServer();
  await syncTab(tabId);
}

/** Debounced (300 ms) syncTab — the live-poke and focus-effect entry point. */
export function requestTabSync(tabId: string): void {
  recentPokes.set(tabId, Date.now());
  if (debounceTimers.has(tabId)) return;
  debounceTimers.set(
    tabId,
    setTimeout(() => {
      debounceTimers.delete(tabId);
      void syncPokedTab(tabId).catch(() => {});
    }, DEBOUNCE_MS),
  );
}

/**
 * JWT only: GET /v1/tabs/mine and make sure every tab the server binds to
 * this account has a local link. This is how a reinstalled signed-in phone
 * gets its tabs back (D10) — the vault snapshot never carried them. Missing
 * links are inserted with party_token NULL (the JWT is the credential) and
 * rev 0 and pulled immediately; existing links pull when the server is newer.
 * NEVER deletes a local link: a tab absent from /mine may
 * simply be one this device joined by token without an account. Never throws.
 */
const boundSessions = new Map<string, string>();
let lastDiscoveryJwt: string | null = null;
let lastDiscoveryAt = 0;
let discoveryFailures = 0;
let lastDiscoveryOkAt: number | null = null;
// What the last good discovery could NOT bind: a party with no contact on the
// server, a contact not on this phone yet, an insert the local cache refused.
type DiscoverySkips = { unbound: number; waiting: number; conflicts: number };
let lastDiscoverySkips: DiscoverySkips = { unbound: 0, waiting: 0, conflicts: 0 };

/** For the App health report: a failed or never-run discovery, or a shared
 *  account it skipped, used to leave no trace anywhere (audit #8). Counts
 *  only, never ids or names. */
export function tabDiscoveryStatus(): {
  failures: number;
  lastOkAt: number | null;
  skips: DiscoverySkips;
} {
  return { failures: discoveryFailures, lastOkAt: lastDiscoveryOkAt, skips: lastDiscoverySkips };
}

// Tabs a screen is showing right now (refcounted) and tabs poked recently:
// the 5 s backstop pulls these; the rest wait for the minute sweep.
const watchedTabs = new Map<string, number>();
const recentPokes = new Map<string, number>();
let lastFullSweepAt = 0;
/** Keep `tabId` on the 5 s backstop while a screen shows it. Returns the stop. */
export function watchTab(tabId: string): () => void {
  watchedTabs.set(tabId, (watchedTabs.get(tabId) ?? 0) + 1);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const left = (watchedTabs.get(tabId) ?? 1) - 1;
    if (left > 0) watchedTabs.set(tabId, left);
    else watchedTabs.delete(tabId);
  };
}
function isHot(tabId: string, now: number): boolean {
  const poked = recentPokes.get(tabId);
  if (poked != null && now - poked >= RECENT_POKE_MS) recentPokes.delete(tabId);
  return watchedTabs.has(tabId) || (poked != null && now - poked < RECENT_POKE_MS);
}

// The server said 429: every tab read shares the same per-network budget, so
// the whole loop waits instead of spending it faster.
let rateLimitedUntil = 0;
function noteRateLimit(err: unknown): void {
  if (err instanceof TabApiError && err.status === 429)
    rateLimitedUntil = Date.now() + (err.retryAfterMs ?? RATE_LIMIT_PAUSE_MS);
}

/** Selftests only: forget pacing state (hot tabs, sweep and backoff clocks). */
export function _resetTabSyncPacingForTests(): void {
  watchedTabs.clear();
  recentPokes.clear();
  lastFullSweepAt = 0;
  rateLimitedUntil = 0;
  discoveryFailures = 0;
  lastDiscoveryOkAt = null;
  lastDiscoverySkips = { unbound: 0, waiting: 0, conflicts: 0 };
  lastDiscoveryAt = 0;
  lastDiscoveryJwt = null;
}
// /mine may arrive before the contact's ordinary vault events. Retrying when
// those events land avoids leaving a new shared binding stranded for a minute.
const awaitingRelationships = new Set<string>();

async function syncTabsInParallel(ids: Iterable<string>): Promise<void> {
  const pending = [...new Set(ids)];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SYNC_WORKERS, pending.length) }, async () => {
      while (next < pending.length) await syncTab(pending[next++]);
    }),
  );
}

// One account-wide discovery in flight. Sign-in, restore and several unknown
// pokes can arrive together; a single trailing discovery catches their newest
// bindings without stale /mine responses replacing each other's waiting set.
let discoveryRunning: Promise<void> | null = null;
let discoveryDirty = false;
export function reconcileTabsFromServer(): Promise<void> {
  if (discoveryRunning) {
    discoveryDirty = true;
    return discoveryRunning;
  }
  discoveryRunning = (async () => {
    do {
      discoveryDirty = false;
      await runReconcileTabsFromServer();
    } while (discoveryDirty);
  })().finally(() => {
    discoveryRunning = null;
  });
  return discoveryRunning;
}

async function runReconcileTabsFromServer(): Promise<void> {
  let attemptedJwt: string | null = null;
  try {
    const session = await captureCurrentSession();
    const jwt = await getSessionJWT().catch(() => null);
    if (!jwt) return;
    attemptedJwt = jwt;
    // Retry recovery binding for token-held tabs created while signed out.
    for (const link of await listTabLinks()) {
      if (!link.party_token || boundSessions.get(link.tab_id) === jwt) continue;
      try {
        await applyForCurrentSession(session, async () => {});
        await bindTab(
          link.party_token,
          link.tab_id,
          {
            vault_id: link.vault_id,
            relationship_id: link.relationship_id,
            linked_at_ms: link.linked_at,
          },
          link.recording_mode,
          link.recording_mode_known !== 0,
        );
        await applyForCurrentSession(session, async () => {
          boundSessions.set(link.tab_id, jwt);
        });
      } catch (err) {
        if (err instanceof SessionChangedError) throw err;
        /* vault not registered yet / offline; next sweep retries */
      }
    }
    await applyForCurrentSession(session, async () => {});
    const mine = await fetchMine();
    // A re-link is listed newest first. The old period may still be OPEN in
    // this phone's cache, so pull its server-confirmed close before inserting
    // the new binding under the one-open-link-per-contact unique index.
    const closing = await applyForCurrentSession(session, async () => {
      const ids: string[] = [];
      for (const t of mine.tabs) {
        if (t.tab.closed_at_ms == null) continue;
        const existing = await getTabLink(t.tab.id);
        if (existing && (existing.closed_at == null || t.tab.rev > existing.rev))
          ids.push(t.tab.id);
      }
      return ids;
    });
    await syncTabsInParallel(closing);
    const toPull = new Set<string>();
    const waiting = new Set<string>();
    const skips: DiscoverySkips = { unbound: 0, waiting: 0, conflicts: 0 };
    for (const t of mine.tabs) {
      const needsSync = await applyForCurrentSession(session, async () => {
        const existing = await getTabLink(t.tab.id);
        if (existing) {
          // /mine carries metadata, not entries. It must not advance the cursor
          // or close the cache before all intervening rows have been pulled.
          // Binding order was backfilled without a financial revision change.
          // Upgrade caches must pull it even for completed closed periods.
          const order = t.tab.parties[t.role].history_order;
          const orderChanged =
            typeof order === "string" &&
            /^[1-9][0-9]*$/.test(order) &&
            order !== existing.history_order;
          const participationChanged =
            typeof t.tab.unjoined_invitation === "boolean" &&
            (t.tab.unjoined_invitation ? 1 : 0) !== (existing.unjoined_invitation ?? null);
          const modeChanged =
            t.tab.recording_mode != null &&
            (t.tab.recording_mode !== (existing.recording_mode ?? "review") ||
              existing.recording_mode_known === 0);
          return (
            existing.last_synced_at == null ||
            t.tab.rev > existing.rev ||
            orderChanged ||
            participationChanged ||
            modeChanged ||
            (t.tab.closed_at_ms != null && existing.closed_at == null)
          );
        }
        // A party bound to the account but to no contact (joined from the web,
        // or bound before the kaata was restored) has nothing to hang off yet.
        if (!t.vault_id || !t.relationship_id) {
          skips.unbound++;
          return false;
        }
        const db = await getDb();
        // Observe this vault BEFORE the async lookup: ordinary vault sync may
        // create the relationship between the query's read and its reply. Its
        // post-commit wakeup must be visible immediately, not only after the
        // rest of /mine has been staged.
        awaitingRelationships.add(t.vault_id);
        const rel = await db.getFirstAsync<{ one: number }>(
          `SELECT 1 AS one FROM relationships WHERE id = ? AND vault_id = ? LIMIT 1`,
          t.relationship_id,
          t.vault_id,
        );
        if (!rel) {
          waiting.add(t.vault_id);
          skips.waiting++;
          return false;
        }
        const me = t.role;
        const them = otherRole(me);
        try {
          await upsertTabLink({
            tab_id: t.tab.id,
            recording_mode: t.tab.recording_mode ?? "review",
            recording_mode_known: t.tab.recording_mode != null ? 1 : 0,
            vault_id: t.vault_id,
            relationship_id: t.relationship_id,
            role: me,
            history_order: t.tab.parties[me].history_order ?? null,
            currency: t.tab.currency,
            party_token: null,
            my_label: t.tab.parties[me].label,
            other_label: t.tab.parties[them].label,
            other_joined_at: t.tab.parties[them].joined_at_ms,
            unjoined_invitation:
              t.tab.recording_mode != null && typeof t.tab.unjoined_invitation === "boolean"
                ? t.tab.unjoined_invitation
                  ? 1
                  : 0
                : null,
            invite_url: null,
            rev: 0,
            closed_at: t.tab.closed_at_ms,
            linked_at: t.linked_at_ms ?? t.tab.parties[me].joined_at_ms ?? t.tab.created_at_ms,
            last_synced_at: null,
            last_error: null,
          });
        } catch (err) {
          // idx_tab_links_open_rel: the contact already has another open tab
          // locally. Leave the local truth alone; the user unlinks explicitly.
          skips.conflicts++;
          console.warn("[tabs.sync] reconcile could not insert link", t.tab.id.slice(0, 8), err);
        }
        return true;
      });
      // Network work must happen after releasing the session mutation lock.
      if (needsSync) toPull.add(t.tab.id);
    }
    await applyForCurrentSession(session, async () => {
      awaitingRelationships.clear();
      for (const vaultId of waiting) awaitingRelationships.add(vaultId);
      lastDiscoveryJwt = jwt;
      lastDiscoveryAt = Date.now();
      lastDiscoveryOkAt = lastDiscoveryAt;
      lastDiscoverySkips = skips;
      discoveryFailures = 0;
    });
    await syncTabsInParallel(toPull);
  } catch (err) {
    noteRateLimit(err);
    // Retry after 15 s, 30 s, … 5 min, not before every 5 s pass: a failing
    // /mine used to rerun on each tick and hold every linked contact's pull
    // behind its timeout.
    if (attemptedJwt && !(err instanceof SessionChangedError)) {
      discoveryFailures++;
      lastDiscoveryJwt = attemptedJwt;
      lastDiscoveryAt =
        Date.now() -
        DISCOVERY_INTERVAL_MS +
        Math.min(DISCOVERY_RETRY_CAP_MS, DISCOVERY_RETRY_BASE_MS * 2 ** (discoveryFailures - 1));
    }
    if (__DEV__) console.warn("[tabs.sync] reconcile failed", describe(err));
  }
}

let allRunning: Promise<void> | null = null;
let allDirty = false;
let allDiscover = false;
let pushRefresh: (() => Promise<void>) | null = null;
export function setTabPushRefreshHook(fn: () => Promise<void>): void {
  pushRefresh = fn;
}

async function runSyncAll(discover: boolean): Promise<void> {
  if (Date.now() < rateLimitedUntil) return;
  if (!(await isOnline())) return;
  const jwt = await getSessionJWT().catch(() => null);
  if (!jwt) return;
  if (
    discover ||
    jwt !== lastDiscoveryJwt ||
    Date.now() - lastDiscoveryAt >= DISCOVERY_INTERVAL_MS
  ) {
    await reconcileTabsFromServer();
  }
  const now = Date.now();
  const full = discover || now - lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS;
  // Closing stops new activity, but existing pending tallies may still receive
  // their one final review/cancellation. Keep those periods current without
  // polling every completed historical period on every minute sweep.
  const pendingClosed = new Set(
    full
      ? (
          await (
            await getDb()
          ).getAllAsync<{ tab_id: string }>(
            `SELECT tl.tab_id FROM tab_links tl
             WHERE tl.closed_at IS NOT NULL AND EXISTS (
               SELECT 1 FROM tab_entries te WHERE te.tab_id = tl.tab_id
                 AND te.status = 'pending' AND te.kind <> 'void'
                 AND te.voided_by_entry_id IS NULL)`,
          )
        ).map((row) => row.tab_id)
      : [],
  );
  const ids = new Set<string>();
  for (const l of await listTabLinks({ includeClosed: true })) {
    const hot = isHot(l.tab_id, now);
    // Screens and live pokes need the same 5 s backstop after unlinking.
    // /mine remains the safety net for completed periods whose metadata
    // changes; rev 0 still needs a first full pull after restore.
    if (!(l.closed_at == null || l.rev === 0 || hot || pendingClosed.has(l.tab_id))) continue;
    // Between full sweeps, only links where a wait is felt (see isHot); a
    // never-synced link (restore) is always due. rev 0 is not that test: an
    // empty tab stays at rev 0 after it has been pulled.
    if (full || l.last_synced_at == null || hot) ids.add(l.tab_id);
  }
  // Unsent ops (closes included) are due every tick.
  for (const id of await listTabIdsWithQueuedOps()) ids.add(id);
  if (full) lastFullSweepAt = now;
  await syncTabsInParallel(ids);
  // Notification availability must never determine whether ledger sync works.
  if (pushRefresh) void pushRefresh().catch(() => {});
}

/**
 * Every open link, with bounded concurrent pulls. Explicit calls discover
 * bindings first; the foreground timer reuses cached bindings between discovery
 * sweeps. Explicit requests during a sweep coalesce into one trailing pass.
 * Timer ticks join the current pass, so a slow connection cannot keep the
 * promise running forever by dirtying it every five seconds. Never rejects.
 */
export function syncAllTabs(opts: { discover?: boolean } = {}): Promise<void> {
  allDiscover ||= opts.discover !== false;
  if (allRunning) {
    if (opts.discover !== false) allDirty = true;
    return allRunning;
  }
  allRunning = (async () => {
    do {
      allDirty = false;
      const discover = allDiscover;
      allDiscover = false;
      try {
        await runSyncAll(discover);
      } catch (err) {
        if (__DEV__) console.warn("[tabs.sync] sweep failed", describe(err));
      }
    } while (allDirty);
  })().finally(() => {
    allRunning = null;
  });
  return allRunning;
}

/**
 * Foreground loop: syncAllTabs now, on every AppState → active, and every
 * 5 s while active; new binding discovery every minute. Also catches network
 * recovery and missing contacts arriving from vault sync. Nothing in the
 * background. Independent of sign-in.
 * Returns the stop function (components/TabSync.tsx calls it on unmount).
 */
export function startTabSyncLoop(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const kick = (discover = false): void => {
    if (!stopped && AppState.currentState === "active") void syncAllTabs({ discover });
  };
  const arm = (): void => {
    if (timer || stopped) return;
    timer = setInterval(() => kick(), LOOP_INTERVAL_MS);
  };
  const disarm = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const sub = AppState.addEventListener("change", (s) => {
    if (s === "active") {
      kick(true);
      arm();
    } else {
      disarm();
    }
  });
  // Only a return from offline forces discovery and a full sweep. Android
  // reports capability changes while connected too, and each one used to
  // re-run discovery and pull every link back to back. Unknown (null) until
  // the first state read, and treated as offline, so starting offline and then
  // connecting still kicks.
  let reachable: boolean | null = null;
  const isReachable = (state: {
    isConnected?: boolean | null;
    isInternetReachable?: boolean | null;
  }) => state.isConnected !== false && state.isInternetReachable !== false;
  void Network.getNetworkStateAsync()
    .then((state) => {
      if (reachable === null) reachable = isReachable(state);
    })
    .catch(() => {});
  const networkSub = Network.addNetworkStateListener((state) => {
    const now = isReachable(state);
    // A tally sent while the signal was gone waited out a 30 s+ backoff even
    // after it came back; make those sends due first.
    if (now && reachable !== true)
      void makeWaitingTabOpsDueNow()
        .catch(() => {})
        .finally(() => kick(true));
    reachable = now;
  });
  const unsubLedger = onLedgerApplied((vaultId) => {
    if (awaitingRelationships.has(vaultId)) kick(true);
  });
  kick(true);
  if (AppState.currentState === "active") arm();
  return () => {
    stopped = true;
    disarm();
    sub.remove();
    networkSub.remove();
    unsubLedger();
  };
}
