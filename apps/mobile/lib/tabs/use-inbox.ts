import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { getAccountIdSync } from "../db-tx";
import { getAppMeta, setAppMeta } from "../db";
import { getLocale } from "../i18n";
import { fetchInbox, type InboxPage } from "./api";
import { onTabApplied } from "./events";
import {
  announceServerReads,
  coversWholeInbox,
  flushInboxReads,
  inboxItemMatches,
  markInboxHandled,
  onInboxReadsApplied,
  pendingInboxReadSpecs,
  type InboxReadSpec,
} from "./inbox-reads";

const empty = (): InboxPage => ({ items: [], unread: 0, latest_id: "0", next_before: "" });
const cacheKey = (account: string, locale: string) =>
  "notification_inbox:" + account + ":" + locale;

// How long a reload waits for the queued marks to go out before it fetches.
// Long enough for one round trip on shop 3G (the answer then already carries
// the marks); short enough that a connected-but-dead link does not stack the
// request timeout twice in front of the bell. A flush still running after
// this continues in the background, and withPendingReads flips whatever it
// has not sent yet.
const FLUSH_WAIT_MS = 3_000;

/**
 * Flip every item `specs` cover and recount. Local "handled" marks
 * (lib/tabs/inbox-reads.ts) win over a server page until the flush lands,
 * and over the cache while offline. `unread` counts the whole history, so
 * when the page IS the whole history (no next cursor) it is recounted from
 * the rows, a "mark all" past the newest notice zeroes it outright, and
 * otherwise only the visible flips are subtracted — an under-count the next
 * successful fetch corrects. Pure; returns `page` itself when nothing changed.
 */
function applyReads(page: InboxPage, specs: InboxReadSpec[]): InboxPage {
  if (!specs.length) return page;
  let flipped = 0;
  const items = page.items.map((item) => {
    if (item.read || !specs.some((spec) => inboxItemMatches(item, spec))) return item;
    flipped++;
    return { ...item, read: true };
  });
  const unread = specs.some((spec) => coversWholeInbox(page, spec))
    ? 0
    : page.next_before === ""
      ? items.filter((item) => !item.read).length
      : Math.max(0, page.unread - flipped);
  if (!flipped && unread === page.unread) return page;
  return { ...page, items, unread };
}

async function withPendingReads(page: InboxPage, account: string): Promise<InboxPage> {
  try {
    return applyReads(page, await pendingInboxReadSpecs(account));
  } catch {
    return page;
  }
}

// Every read and write of a cached first page goes through this chain, so a
// patch from a mark and a reload's write can never interleave (a patch that
// read the page before the reload wrote it would otherwise put the stale
// page back, new notices and all).
let cacheChain: Promise<unknown> = Promise.resolve();
function withCache<T>(fn: () => Promise<T>): Promise<T> {
  const next = cacheChain.then(fn, fn);
  cacheChain = next.catch(() => undefined);
  return next;
}

// A notice handled while the bell is NOT on screen — the person screen's
// accept / reject / cancel or its "seen through rev", an OS button, a tap on
// the tray — must already be read when the bell comes back, before any
// fetch. While the mark is still queued withPendingReads covers it; once the
// flush has SENT it the queue is empty and only the cached page remembers,
// so patch the persisted copy here, outside any focus scope. The hook's own
// subscriber (below) flips the live page; this one owns the cache.
onInboxReadsApplied((specs, source) => {
  if (source !== "handled") return;
  const account = getAccountIdSync();
  if (!account) return;
  const key = cacheKey(account, getLocale());
  void withCache(async () => {
    const cached = await getAppMeta(key);
    if (!cached) return;
    const parsed = JSON.parse(cached) as InboxPage;
    if (!Array.isArray(parsed.items)) return;
    const next = applyReads(parsed, specs);
    if (next !== parsed) await setAppMeta(key, JSON.stringify(next));
  }).catch(() => undefined);
});

/** Server history survives dismissed pushes, reinstalls and permission denial.
 * The first page is cached per ACCOUNT + locale, never across sign-ins. */
export function useInbox() {
  const [page, setPage] = useState<InboxPage>(empty);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const owner = useRef<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const refreshPending = useRef(false);
  // The page as last committed, for the read listener: it runs outside a
  // render and must flip what is on screen, not what its closure captured.
  // Every state write goes through `commit` so the two never disagree.
  const latest = useRef<InboxPage>(page);
  const commit = useCallback((next: InboxPage) => {
    latest.current = next;
    setPage(next);
  }, []);
  const locale = getLocale();
  const account = getAccountIdSync();
  const reload = useCallback(
    async (before = ""): Promise<void> => {
      const who = getAccountIdSync();
      if (owner.current !== who) {
        owner.current = who;
        commit(empty());
      }
      if (!who) return;
      if (busy.current) {
        if (!before) refreshPending.current = true;
        return;
      }
      const run = generation.current;
      busy.current = true;
      setLoading(true);
      try {
        // Local "handled" marks go first so the answer already carries them;
        // otherwise a notice reviewed a second ago comes back unread for one
        // refresh. Best-effort and capped: offline, the fetch below fails the
        // same way, and a stalled link must not double the wait.
        const flush = flushInboxReads().catch(() => undefined);
        await new Promise<void>((resolve) => {
          const cap = setTimeout(resolve, FLUSH_WAIT_MS);
          void flush.finally(() => {
            clearTimeout(cap);
            resolve();
          });
        });
        if (run !== generation.current || who !== getAccountIdSync()) return;
        const fetched = await fetchInbox(locale, before);
        if (run !== generation.current || who !== getAccountIdSync()) return;
        // Marks the flush could not send yet still win over the server page.
        const next = await withPendingReads(fetched, who);
        if (run !== generation.current || who !== getAccountIdSync()) return;
        commit(
          before
            ? {
                ...next,
                items: [
                  ...latest.current.items,
                  ...next.items.filter((n) => !latest.current.items.some((o) => o.id === n.id)),
                ],
              }
            : next,
        );
        setFailed(false);
        // Reads the account made elsewhere (the other phone's review, the
        // server's own auto-read) clear this phone's tray too.
        announceServerReads(fetched.items);
        if (!before) await withCache(() => setAppMeta(cacheKey(who, locale), JSON.stringify(next)));
      } catch {
        if (run === generation.current) setFailed(true);
      } finally {
        if (run === generation.current) {
          busy.current = false;
          setLoading(false);
          if (refreshPending.current) {
            refreshPending.current = false;
            void reload();
          }
        }
      }
    },
    [locale, commit],
  );

  useFocusEffect(
    useCallback(() => {
      const run = ++generation.current;
      busy.current = false;
      refreshPending.current = false;
      owner.current = account;
      commit(empty());
      setLoading(false);
      setFailed(false);
      void (async () => {
        if (account) {
          try {
            const cached = await withCache(() => getAppMeta(cacheKey(account, locale)));
            if (cached && run === generation.current && getAccountIdSync() === account) {
              const parsed = JSON.parse(cached) as InboxPage;
              if (Array.isArray(parsed.items)) {
                // Marks made while this screen was not focused (the person
                // screen, an OS button) are still queued: show them now.
                const shown = await withPendingReads(parsed, account);
                if (run === generation.current && getAccountIdSync() === account) commit(shown);
              }
            }
          } catch {
            /* A broken cache never blocks a fresh read. */
          }
        }
        if (run === generation.current) await reload();
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = onTabApplied(() => {
        if (AppState.currentState !== "active") return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void reload(), 250);
      });
      // A notice handled anywhere — a review on the person screen, an OS
      // button, a tap on the tray — flips here at once, no round trip: the
      // badge must drop before the network is even tried, offline included.
      // A read learned from the server is already on the page it came with.
      const offReads = onInboxReadsApplied((specs, source) => {
        if (source !== "handled" || !account || getAccountIdSync() !== account) return;
        // A fetch in flight was answered before this mark: its page would
        // put the notice back. Let one trailing reload restate it.
        if (busy.current) refreshPending.current = true;
        const next = applyReads(latest.current, specs);
        if (next !== latest.current) commit(next);
      });
      const app = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
      });
      const poll = setInterval(() => {
        if (AppState.currentState === "active") void reload();
      }, 60_000);
      return () => {
        generation.current++;
        busy.current = false;
        refreshPending.current = false;
        off();
        offReads();
        app.remove();
        clearInterval(poll);
        if (timer) clearTimeout(timer);
      };
    }, [account, locale, reload, commit]),
  );

  const read = async (id?: string) => {
    const who = getAccountIdSync();
    if (!who || (id == null && page.latest_id === "0")) return;
    // The page flips through the listener above before anything is sent;
    // the mark itself is durable and never throws (offline is fine).
    const item = id ? page.items.find((n) => n.id === id) : undefined;
    await markInboxHandled(
      id
        ? item
          ? { id, tab_id: item.tab_id, rev: item.rev, entry_id: item.entry_id }
          : { id }
        : { through: page.latest_id },
    );
    if (who !== getAccountIdSync()) return;
    // Invalidate a pre-mark GET: otherwise its older unread count can land
    // after this acknowledgement and make a read notice look new again.
    generation.current++;
    busy.current = false;
    refreshPending.current = false;
    await reload();
  };
  return {
    page: owner.current === account ? page : empty(),
    loading,
    failed,
    reload,
    read,
    signedIn: !!account,
  };
}
