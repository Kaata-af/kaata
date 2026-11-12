import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useIsFocused } from "expo-router";
import * as Network from "expo-network";
import { AppState } from "react-native";
import { applyForCurrentSession, captureCurrentSession, SessionChangedError } from "./auth";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { listFriends } from "./friends-api";
import type { DiscoveredPerson } from "./people-search";
import { notifyPeopleSearchChanged, onPeopleSearchChanged } from "./people-search-events";
import { onNotificationInboxChanged } from "./notification-events";
import { TabApiError } from "./tabs/errors";

const FRESH_MS = 5 * 60_000;
const RETRY_MS = 30_000;
type FriendsSnapshot = {
  accountId: string | null;
  epoch: number;
  revision: number;
  loadedRevision: number;
  rows: DiscoveredPerson[];
  removedAccountIds: ReadonlySet<string>;
  loaded: boolean;
  loading: boolean;
  failed: boolean;
  completedAt: number | null;
  attemptedAt: number | null;
  attemptedRevision: number;
};
let epoch = 0;
const empty = (accountId: string | null): FriendsSnapshot => ({
  accountId,
  epoch,
  revision: 0,
  loadedRevision: -1,
  rows: [],
  removedAccountIds: new Set(),
  loaded: false,
  loading: false,
  failed: false,
  completedAt: null,
  attemptedAt: null,
  attemptedRevision: -1,
});
let snapshot = empty(null);
const listeners = new Set<() => void>();
let activeReaders = 0;
let request: { revision: number } | null = null;
let refreshQueued = false;
let notifyingDirectory = false;
const emit = () => listeners.forEach((listener) => listener());
const commit = (next: FriendsSnapshot) => {
  snapshot = next;
  emit();
};
function resetIdentity() {
  epoch++;
  request = null;
  refreshQueued = false;
  snapshot = empty(getSessionAccountIdSync());
  emit();
}
function read() {
  // This also prevents one frame of another account's rows if React renders
  // before the identity event reaches its subscribers.
  if (snapshot.accountId !== getSessionAccountIdSync()) {
    epoch++;
    request = null;
    refreshQueued = false;
    snapshot = empty(getSessionAccountIdSync());
  }
  return snapshot;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function invalidate(accountId: string) {
  const previous = read();
  if (previous.accountId !== accountId) return;
  commit({ ...previous, revision: previous.revision + 1 });
}
// Keep the in-memory cache scoped even when Home is temporarily unmounted.
// No friend identities or credentials are written to disk.
onAccountIdentityChanged(resetIdentity);
onPeopleSearchChanged(({ accountId, vaultId }) => {
  if (!vaultId && !notifyingDirectory) invalidate(accountId);
});
onNotificationInboxChanged(({ account }) => invalidate(account));

async function refresh(force = false) {
  const start = read();
  if (!start.accountId || !activeReaders || AppState.currentState !== "active") return;
  if (request) {
    if (force || start.revision !== request.revision) refreshQueued = true;
    return;
  }
  const now = Date.now();
  if (!force) {
    if (
      start.failed &&
      start.attemptedRevision === start.revision &&
      start.attemptedAt !== null &&
      now - start.attemptedAt < RETRY_MS
    )
      return;
    if (
      start.loaded &&
      start.revision === start.loadedRevision &&
      start.completedAt !== null &&
      now - start.completedAt < FRESH_MS
    )
      return;
  }
  const operation = { revision: start.revision };
  request = operation;
  refreshQueued = false;
  const current = () =>
    request === operation &&
    read().epoch === start.epoch &&
    getSessionAccountIdSync() === start.accountId;
  const guard = () => {
    if (!current()) throw new SessionChangedError();
  };
  commit({
    ...start,
    loading: true,
    failed: false,
    attemptedAt: now,
    attemptedRevision: start.revision,
  });
  try {
    const session = await captureCurrentSession();
    guard();
    if (session.accountId !== start.accountId) throw new SessionChangedError();
    const rows = new Map<string, DiscoveredPerson>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      guard();
      const page = await listFriends(cursor, session);
      await applyForCurrentSession(session, async () => {
        guard();
        for (const person of page.friends) rows.set(person.account_id, person);
      });
      guard();
      cursor = page.next_cursor;
      if (cursor && cursors.has(cursor)) throw new Error("friends_cursor_cycle");
      if (cursor) cursors.add(cursor);
      // A refresh is atomic: paging never temporarily removes old friends.
      // New screens can show the first page while remaining pages arrive.
      if (!start.loaded && read().revision === start.revision)
        commit({ ...read(), rows: [...rows.values()] });
    } while (cursor);
    guard();
    if (read().revision === start.revision) {
      const membershipChanged =
        start.loaded &&
        (start.rows.length !== rows.size ||
          start.rows.some((person) => !rows.has(person.account_id)));
      const removedAccountIds = new Set(start.removedAccountIds);
      if (start.loaded)
        for (const person of start.rows)
          if (!rows.has(person.account_id)) removedAccountIds.add(person.account_id);
      for (const accountId of rows.keys()) removedAccountIds.delete(accountId);
      commit({
        ...read(),
        rows: [...rows.values()],
        removedAccountIds,
        loaded: true,
        loadedRevision: start.revision,
        completedAt: Date.now(),
        failed: false,
      });
      guard();
      if (membershipChanged) {
        // An old directory result must not keep calling a removed person a
        // friend (or hide a new friend's badge) after this authoritative list.
        notifyingDirectory = true;
        try {
          notifyPeopleSearchChanged({ accountId: start.accountId });
        } finally {
          notifyingDirectory = false;
        }
      }
    } else refreshQueued = true;
  } catch (error) {
    if (current()) {
      const accessChanged =
        error instanceof SessionChangedError ||
        (error instanceof TabApiError && [401, 403].includes(error.status));
      commit({
        ...read(),
        ...(accessChanged ? { rows: [], loaded: false, completedAt: null } : {}),
        failed: true,
      });
    }
  } finally {
    if (current()) {
      request = null;
      const queued = refreshQueued;
      refreshQueued = false;
      commit({ ...read(), loading: false });
      if (queued) void refresh(true);
    }
  }
}

/** Account-level friends survive sheets, focus changes and offline moments. */
export function useFriends(enabled = true) {
  const state = useSyncExternalStore(subscribe, read, read);
  const focused = useIsFocused();
  const network = Network.useNetworkState();
  const offline = network.isConnected === false || network.isInternetReachable === false;
  const latest = useRef({ enabled, focused, epoch: state.epoch });
  latest.current = { enabled, focused, epoch: state.epoch };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = enabled && focused && !offline && !!state.accountId;
  useEffect(() => {
    if (!active) return;
    activeReaders++;
    void refresh();
    const app = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });
    const timer = setInterval(() => void refresh(), FRESH_MS);
    return () => {
      activeReaders--;
      app.remove();
      clearInterval(timer);
    };
  }, [active, state.epoch, state.revision]);
  const isCurrent = useCallback(
    () =>
      mounted.current &&
      latest.current.enabled &&
      latest.current.focused &&
      latest.current.epoch === state.epoch &&
      !!state.accountId &&
      read().epoch === state.epoch &&
      getSessionAccountIdSync() === state.accountId,
    [enabled, focused, state.accountId, state.epoch],
  );
  return {
    accountId: state.accountId,
    rows: state.rows,
    removedAccountIds: state.removedAccountIds,
    loaded: state.loaded,
    loading: state.loading,
    failed: state.failed,
    offline,
    isCurrent,
    retry: () => {
      if (isCurrent() && !offline) void refresh(true);
    },
  };
}
