// apps/mobile/lib/tabs/sync.ts
//
// The tab sync loop: flush this device's outbox ops for a tab IN ORDER, then
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
// dropped socket or a missed account-channel invalidation.
const LOOP_INTERVAL_MS = 5_000;
// Finding new bindings is account-wide and more expensive than pulling a
// cached tab. Do it once a minute, plus sign-in/restore/resume and unknown pokes.
const DISCOVERY_INTERVAL_MS = 60_000;
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
    await bindTab(link.party_token, link.tab_id, {
      vault_id: link.vault_id,
      relationship_id: link.relationship_id,
      linked_at_ms: link.linked_at,
    });
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
      return { apply: await closeTab(auth, link.tab_id), hint: null };
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
    const link = await getTabLink(tabId);
    if (!link) return { ...result, ok: false, error: "no_link" };
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

    // ---- flush, in order --------------------------------------------------
    let flushError: string | null = null;
    for (const op of await listDueTabOps(tabId)) {
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
  try {
    const session = await captureCurrentSession();
    const jwt = await getSessionJWT().catch(() => null);
    if (!jwt) return;
    // Retry recovery binding for token-held tabs created while signed out.
    for (const link of await listTabLinks()) {
      if (!link.party_token || boundSessions.get(link.tab_id) === jwt) continue;
      try {
        await applyForCurrentSession(session, async () => {});
        await bindTab(link.party_token, link.tab_id, {
          vault_id: link.vault_id,
          relationship_id: link.relationship_id,
          linked_at_ms: link.linked_at,
        });
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
    for (const t of mine.tabs) {
      const needsSync = await applyForCurrentSession(session, async () => {
        const existing = await getTabLink(t.tab.id);
        if (existing) {
          // /mine carries metadata, not entries. It must not advance the cursor
          // or close the cache before all intervening rows have been pulled.
          return (
            existing.last_synced_at == null ||
            t.tab.rev > existing.rev ||
            (t.tab.closed_at_ms != null && existing.closed_at == null)
          );
        }
        // A party bound to the account but to no contact (joined from the web,
        // or bound before the kaata was restored) has nothing to hang off yet.
        if (!t.vault_id || !t.relationship_id) return false;
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
          return false;
        }
        const me = t.role;
        const them = otherRole(me);
        try {
          await upsertTabLink({
            tab_id: t.tab.id,
            vault_id: t.vault_id,
            relationship_id: t.relationship_id,
            role: me,
            currency: t.tab.currency,
            party_token: null,
            my_label: t.tab.parties[me].label,
            other_label: t.tab.parties[them].label,
            other_joined_at: t.tab.parties[them].joined_at_ms,
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
    });
    await syncTabsInParallel(toPull);
  } catch (err) {
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
  const ids = new Set<string>();
  for (const l of await listTabLinks({ includeClosed: true })) {
    // Open links every sweep. A CLOSED one only when it has never been
    // pulled (rev 0) — which is exactly the reinstall case: /mine hands the
    // link back with an empty cache, and a frozen tab's rows still count
    // toward the contact's balance (D8), so without this one pull the
    // contact would read 0 forever. Closing always bumps the server rev, so
    // a populated closed tab is re-pulled by /mine reconciliation only when
    // its revision changes (for example, after an account is deleted).
    if (l.closed_at == null || l.rev === 0) ids.add(l.tab_id);
  }
  // Closed links with an unsent close op still need one flush.
  for (const id of await listTabIdsWithQueuedOps()) ids.add(id);
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
  const networkSub = Network.addNetworkStateListener((state) => {
    if (state.isConnected !== false && state.isInternetReachable !== false) kick(true);
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
