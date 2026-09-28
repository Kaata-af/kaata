// apps/mobile/lib/tabs/inbox-reads.ts
//
// "Handled means read." A shared-account notice is read the moment the user
// deals with it by ANY path: tapping it in the bell or the full inbox,
// tapping the OS notification and landing on the tally, accepting /
// rejecting / cancelling that tally (person screen, dispute screen, the
// notification's own buttons), or opening the contact's screen (every notice
// of that tab up to the locally applied rev). This module is the one funnel
// those paths go through; screens and lib/tabs/notify.ts only ever call
// markInboxHandled / markTabNoticesSeen.
//
// Why a QUEUE rather than a fire-and-forget POST. Reviews and taps happen
// offline all the time — a tally accepted on the road, a lock-screen notice
// tapped in a dead spot — and the review itself is durable (tab_outbox), so
// the read must be too. A request that simply failed would leave the notice
// unread in the bell after the review landed, and the very push it answered
// would still go out, because the server suppresses a queued push only once
// it holds the read row (tab_notification_reads). So a mark is
//   (1) announced synchronously through onInboxReadsApplied — the cached page
//       flips and the OS tray is cleared at once, badge included;
//   (2) appended to app_meta "inbox_read_queue" (deduplicated, capped, aged);
//   (3) flushed best-effort right away, and again on every inbox refresh and
//       after every tab pull (lib/tabs/sync.ts).
// Re-sending a mark is harmless: the server's insert is ON CONFLICT DO
// NOTHING, and marking what is already read answers {marked: 0}.
//
// Reads belong to the ACCOUNT (the server table is keyed by it), so each
// queued entry remembers who marked it: a flush sends only the signed-in
// account's entries and leaves another account's alone until it returns.
// Signed out, a mark is announced but never queued — there is no account to
// charge it to, and an invitation token is not read authority.
//
// Dependency-free by design (no react-native / expo): lib/tabs/link.ts,
// lib/tabs/notify.ts, lib/tabs/sync.ts and lib/tabs/use-inbox.ts import it,
// and the selftest drives it under Node with a Map standing in for app_meta.

import { getAppMeta, setAppMeta } from "../db";
import { getAccountIdSync, getDb } from "../db-tx";
import { markInboxRead, type InboxReadBody } from "./api";
import { TabApiError, isRetryableTabError } from "./errors";

/**
 * What a caller knows about the notice it handled. The canonical half is an
 * InboxReadBody (what the server accepts); the rest are HINTS so the OS tray
 * can be matched (lib/tabs/notify.ts): an {id} may carry tab_id / rev /
 * entry_id, a {tab_id, rev} may carry the entry_id. Hints are never sent —
 * toReadBody strips them.
 */
export type InboxReadSpec = InboxReadBody & { tab_id?: string; rev?: number; entry_id?: string };

/**
 * Where an announcement came from: "handled" is this phone's own act (queued
 * for the server, flips the cached page); "server" is a read state LEARNED
 * from a fetched page — another phone on the account reviewed the tally, or
 * the server auto-read it — which only has to leave the OS tray.
 */
export type InboxReadSource = "handled" | "server";

const QUEUE_KEY = "inbox_read_queue";
/** Newest entries kept; the oldest go first. 200 is months of shop use. */
const QUEUE_MAX = 200;
/** A mark older than this is moot on both ends: the push job it would have
 *  suppressed died at 24 h, and the notice is long off the first page. */
const QUEUE_MAX_AGE_MS = 30 * 24 * 3600_000;

type QueuedRead = { spec: InboxReadSpec; account: string; at: number };

// ---------------------------------------------------------------------------
// Pure half: canonical body + matching

/**
 * The canonical body for `spec`, hints stripped. Precedence when a spec
 * carries more than one target (an {id} with hints, an entry with a rev):
 * id > through > through_rev > rev > entry_id — the exact notice first, then
 * the widest server-side match. An exact rev beats the entry on purpose: a
 * notice IS a (tab, rev), while "every notice about this tally" is unbounded
 * in time, so a deferred flush of an entry-form mark would read a notice
 * about the same tally created AFTER the tap (the other party cancelling it
 * while this phone was offline). The entry form is only for a caller that
 * knows no rev. Throws on a spec with no target, which the types make
 * impossible from app code and the queue reader tolerates.
 */
export function toReadBody(spec: InboxReadSpec): InboxReadBody {
  const s = spec as Record<string, unknown>;
  if (typeof s.id === "string") return { id: s.id };
  if (typeof s.through === "string") return { through: s.through };
  if (typeof s.tab_id === "string") {
    if (typeof s.through_rev === "number") return { tab_id: s.tab_id, through_rev: s.through_rev };
    if (typeof s.rev === "number") return { tab_id: s.tab_id, rev: s.rev };
    if (typeof s.entry_id === "string") return { tab_id: s.tab_id, entry_id: s.entry_id };
  }
  throw new TypeError("inbox read spec names no notice");
}

/** Inbox ids are Postgres BIGSERIAL values as decimal strings — past 2^53 as
 *  far as JS numbers care, so they are compared as BigInt, never as Number.
 *  A malformed id compares as NaN, i.e. never ≤ anything. */
function compareIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  } catch {
    return NaN;
  }
}

/** Whether a cached inbox row is covered by `spec`. Pure: the hook flips the
 *  page with it, and the selftest pins the table. */
export function inboxItemMatches(
  item: { id: string; tab_id: string; rev: number; entry_id: string },
  spec: InboxReadSpec,
): boolean {
  let body: InboxReadBody;
  try {
    body = toReadBody(spec);
  } catch {
    return false;
  }
  if ("id" in body) return item.id === body.id;
  if ("through" in body) return compareIds(item.id, body.through) <= 0;
  if (item.tab_id !== body.tab_id) return false;
  if ("through_rev" in body) return item.rev <= body.through_rev;
  if ("rev" in body) return item.rev === body.rev;
  return item.entry_id === body.entry_id;
}

/**
 * Whether `spec` is a "mark all" that reaches past the newest notice a page
 * knows of — then nothing in the whole history is unread any more, cached
 * first page or not, and the hook can zero the badge instead of subtracting
 * only the flips it can see.
 */
export function coversWholeInbox(page: { latest_id: string }, spec: InboxReadSpec): boolean {
  let body: InboxReadBody;
  try {
    body = toReadBody(spec);
  } catch {
    return false;
  }
  return "through" in body && compareIds(page.latest_id, body.through) <= 0;
}

// ---------------------------------------------------------------------------
// Listeners (lib/tabs/events.ts idiom)

type Listener = (specs: InboxReadSpec[], source: InboxReadSource) => void;
const listeners = new Set<Listener>();

/** Subscribe to "notices were read"; returns an unsubscribe fn. Fired
 *  synchronously from markInboxHandled BEFORE anything is persisted or sent,
 *  so the page and the OS tray react before the network is even tried, and
 *  from announceServerReads after a fetch. One call carries a batch. */
export function onInboxReadsApplied(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(specs: InboxReadSpec[], source: InboxReadSource): void {
  if (!specs.length) return;
  // Snapshot: a listener that unsubscribes mid-walk must not mutate the set.
  for (const fn of [...listeners]) {
    try {
      fn(specs, source);
    } catch (err) {
      console.warn("[tabs] onInboxReadsApplied listener threw", err);
    }
  }
}

/**
 * A fetched page says which notices the ACCOUNT has read — including reads
 * this phone never made: a review on the other phone (the server reads the
 * reviewer's notice inside the decision), a mark-all there. Announce them as
 * exact (tab, rev) notices so a push still sitting in THIS phone's tray
 * leaves it. Nothing is queued or sent: the server is where this came from.
 */
export function announceServerReads(
  items: ReadonlyArray<{ tab_id: string; rev: number; read: boolean }>,
): void {
  const specs: InboxReadSpec[] = [];
  for (const item of items) {
    if (item.read && typeof item.tab_id === "string" && item.rev > 0)
      specs.push({ tab_id: item.tab_id, rev: item.rev });
  }
  emit(specs, "server");
}

// ---------------------------------------------------------------------------
// The durable queue

// One app_meta row, read-modify-written; every mutation goes through this
// chain so two marks landing in the same tick cannot lose each other, and
// every READ of it too, so a reader is ordered after any append already
// chained (markInboxHandled chains its append in the same tick it announces).
let chain: Promise<unknown> = Promise.resolve();
function withQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** `account` + canonical body: the dedupe / removal identity. Null for an
 *  entry whose spec names nothing (a corrupt row), which is then dropped. */
function identity(entry: QueuedRead): string | null {
  try {
    return entry.account + " " + JSON.stringify(toReadBody(entry.spec));
  } catch {
    return null;
  }
}

function isQueuedRead(value: unknown): value is QueuedRead {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<QueuedRead>;
  return (
    typeof v.account === "string" &&
    typeof v.at === "number" &&
    !!v.spec &&
    typeof v.spec === "object" &&
    identity(v as QueuedRead) != null
  );
}

/** The live queue: parseable, well-formed, not expired. A broken row never
 *  blocks the rest. */
async function readQueue(now: number): Promise<QueuedRead[]> {
  try {
    const raw = await getAppMeta(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isQueuedRead).filter((e) => now - e.at <= QUEUE_MAX_AGE_MS);
  } catch {
    return [];
  }
}

// setAppMeta is a bare statement on the shared SQLite connection: it joins —
// and rolls back with — whatever withTransactionAsync is open at that moment
// (CLAUDE.md, the device-key note). A tab pull's transaction for ANOTHER
// contact can be open when the person screen marks this one, so wait for it
// to end before writing; bounded, because a caller that is itself inside a
// transaction would otherwise wait forever.
const IN_TX_WAIT_MS = 20;
const IN_TX_WAIT_ROUNDS = 25;
async function writeQueue(queue: QueuedRead[]): Promise<void> {
  try {
    const db = (await getDb()) as { isInTransactionSync?: () => boolean };
    for (let i = 0; i < IN_TX_WAIT_ROUNDS && db.isInTransactionSync?.() === true; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, IN_TX_WAIT_MS));
    }
  } catch {
    /* no handle to probe — the write below fails the same way if it is real */
  }
  await setAppMeta(QUEUE_KEY, JSON.stringify(queue));
}

/**
 * The signed-in account's queued marks, oldest first — what a cached or a
 * freshly fetched page must still be flipped by until the flush lands. The
 * bell's hook is unsubscribed while another screen is on top, so this is
 * how a mark made on the person screen reaches the cached page on return.
 * Read through the queue chain, so a mark announced a moment ago is here.
 */
export async function pendingInboxReadSpecs(account: string): Promise<InboxReadSpec[]> {
  const queue = await withQueue(() => readQueue(Date.now()));
  return queue.filter((e) => e.account === account).map((e) => e.spec);
}

// The highest through_rev the server has acknowledged per (account, tab).
// The person screen marks through the applied rev on every focus and every
// pull; once the server holds "everything ≤ R is read" for this account,
// re-sending R, or a single rev ≤ R, is pure traffic — a notice at rev ≤ R
// cannot appear later, because R was already the server's rev when the mark
// went out. The announcement still fires (tray + page flip are instant);
// only the queue and the POST are skipped. In memory on purpose: a relaunch
// re-sends once, which is what "harmless" means.
const sentThrough = new Map<string, number>();
const throughKey = (account: string, tabId: string) => account + " " + tabId;
function alreadyCovered(account: string, body: InboxReadBody): boolean {
  if (!("tab_id" in body)) return false;
  const top = sentThrough.get(throughKey(account, body.tab_id));
  if (top == null) return false;
  if ("through_rev" in body) return body.through_rev <= top;
  if ("rev" in body) return body.rev <= top;
  return false;
}
function recordSent(account: string, body: InboxReadBody): void {
  if (!("tab_id" in body) || !("through_rev" in body)) return;
  const key = throughKey(account, body.tab_id);
  sentThrough.set(key, Math.max(sentThrough.get(key) ?? 0, body.through_rev));
}

/**
 * Record that the user handled the notice(s) `spec` names. Chains the
 * durable append for the signed-in account, announces (optimistic page +
 * tray; the announcement still runs before the append is written), then
 * tries to send. The chain goes first so that ANY reader of the queue
 * started after the announcement — a listener, a reload whose fetch resolves
 * a moment later — is ordered behind the append and sees the mark. Never
 * throws and never blocks the caller's own work — every call site fires it
 * with `void`.
 */
export async function markInboxHandled(spec: InboxReadSpec): Promise<void> {
  try {
    let body: InboxReadBody;
    try {
      body = toReadBody(spec);
    } catch (err) {
      console.warn("[tabs] markInboxHandled ignored a spec with no target", err);
      return;
    }
    const account = getAccountIdSync();
    const now = Date.now();
    const key = account + " " + JSON.stringify(body);
    const appended =
      account && !alreadyCovered(account, body)
        ? withQueue(async () => {
            const queue = (await readQueue(now)).filter((e) => identity(e) !== key);
            queue.push({ spec, account, at: now });
            await writeQueue(queue.slice(-QUEUE_MAX));
          })
        : null;
    emit([spec], "handled");
    if (!appended) return;
    await appended;
    void flushInboxReads();
  } catch (err) {
    console.warn("[tabs] markInboxHandled failed", err);
  }
}

/**
 * The contact screen's share of "handled means read": with a linked
 * contact's rows on screen, every notice of its tab up to the rev this
 * device has applied is handled — but only while the user can actually SEE
 * them. Navigation focus survives backgrounding (the route stays focused
 * with the app behind the lock screen) and pulls run there too (an OS review
 * button's sync, a sweep already in flight), so a mark needs both: the
 * route focused AND the app active. Otherwise a tally nobody looked at
 * would be read server-side, its push dropped and its tray notification
 * dismissed — the opposite of the point. A closed tab counts; its notices
 * are still in the bell. Rev 0 has no notices and the server refuses it.
 * Returns whether a mark was issued (the selftest pins the gate).
 */
export function markTabNoticesSeen(
  link: { tab_id: string; rev: number },
  view: { focused: boolean; appState: string },
): boolean {
  if (!view.focused || view.appState !== "active" || !(link.rev > 0)) return false;
  void markInboxHandled({ tab_id: link.tab_id, through_rev: link.rev });
  return true;
}

type FlushOutcome = { sent: number; remaining: number; stopped: boolean };

/**
 * A 400 invalid_body for a tab-form body is version skew, not a verdict: a
 * backend that predates the tab selectors (2.0.0 knew only {id}/{through})
 * says it about every such mark. Keep the entry — and the order behind it —
 * until the backend that accepts it is live; the queue's 30-day life bounds
 * the wait. The same 400 for an {id}/{through} body is a real verdict.
 */
function isVersionSkew(err: unknown, body: InboxReadBody): boolean {
  return (
    err instanceof TabApiError &&
    err.status === 400 &&
    err.code === "invalid_body" &&
    "tab_id" in body
  );
}

async function runFlush(): Promise<FlushOutcome> {
  const account = getAccountIdSync();
  if (!account) return { sent: 0, remaining: 0, stopped: false };
  const now = Date.now();
  const mine = (await withQueue(() => readQueue(now)))
    .filter((e) => e.account === account)
    .sort((a, b) => a.at - b.at);
  const done = new Set<string>();
  let sent = 0;
  let stopped = false;
  for (const entry of mine) {
    if (getAccountIdSync() !== account) {
      stopped = true;
      break;
    }
    const key = identity(entry)!;
    const body = toReadBody(entry.spec);
    try {
      await markInboxRead(body);
      sent++;
      done.add(key);
      recordSent(account, body);
    } catch (err) {
      // A verdict (400 / 403 / 404 / any other non-retryable 4xx) will repeat
      // forever: drop the entry. Transport, 401, 408, 429, 5xx, version skew
      // and anything unexpected (signed out mid-flush) keep it AND everything
      // after it — the order is the user's, and a later mark is never sent
      // ahead of an earlier one that is about to succeed.
      if (err instanceof TabApiError && !isRetryableTabError(err) && !isVersionSkew(err, body)) {
        done.add(key);
        continue;
      }
      stopped = true;
      break;
    }
  }
  const remaining = await withQueue(async () => {
    const queue = await readQueue(Date.now());
    const kept = queue.filter((e) => !(e.account === account && done.has(identity(e)!)));
    if (kept.length !== queue.length || done.size) await writeQueue(kept);
    return kept.filter((e) => e.account === account).length;
  });
  return { sent, remaining, stopped };
}

type FlushResult = { sent: number; remaining: number };

let inflight: Promise<FlushOutcome> | null = null;
let waiting: Promise<FlushResult> | null = null;

/**
 * Send the signed-in account's queued marks, oldest first. Single-flight:
 * never two passes at once. A call that arrives while a pass is running gets
 * ONE follow-up pass after it (shared by every such caller), because the
 * caller's promise is that everything queued before the call was attempted —
 * the inbox reload relies on that to fetch a page that already carries the
 * mark it just made, and a mark queued mid-pass is sent the same way.
 * Entries for other accounts are left untouched. Never throws; `remaining`
 * counts this account's entries still queued.
 */
export async function flushInboxReads(): Promise<FlushResult> {
  if (inflight) {
    const followUp = () => {
      waiting = null;
      return flushInboxReads();
    };
    waiting ??= inflight.then(followUp, followUp);
    return waiting;
  }
  const run = runFlush()
    .catch((err): FlushOutcome => {
      console.warn("[tabs] flushInboxReads failed", err);
      return { sent: 0, remaining: 0, stopped: true };
    })
    .finally(() => {
      inflight = null;
    });
  inflight = run;
  const outcome = await run;
  return { sent: outcome.sent, remaining: outcome.remaining };
}
