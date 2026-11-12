import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { captureCurrentSession, SessionChangedError } from "./auth";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import {
  acceptFriendRequest,
  dismissFriendRequest,
  listFriendRequests,
  type FriendRequest,
} from "./friends-api";
import { observeIncomingRequests, type IncomingRequestSnapshot } from "./incoming-request-cue";
import { TabApiError } from "./tabs/errors";
import { onNotificationInboxChanged, notifyNotificationInboxChanged } from "./notification-events";

type RequestSnapshot = { scope: string; rows: FriendRequest[]; failed: boolean };
type RequestAction = { scope: string; id: string; action: "accept" | "decline" };

/** Friendship requests are account data, independent of the selected ledger. */
export function useFriendRequests() {
  const identity = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        identity.current++;
        notify();
      }),
    [],
  );
  const readScope = useCallback(() => `${identity.current}:${getSessionAccountIdSync() ?? ""}`, []);
  const scope = useSyncExternalStore(subscribe, readScope, () => "signed-out");
  const account = getSessionAccountIdSync();
  const [snapshot, setSnapshot] = useState<RequestSnapshot | null>(null);
  const latest = useRef<RequestSnapshot | null>(null);
  const [responding, setResponding] = useState<RequestAction | null>(null);
  const activeResponse = useRef<RequestAction | null>(null);
  const cueBaseline = useRef<IncomingRequestSnapshot | null>(null);
  const focused = useRef(false);
  const sequence = useRef(0);
  const loading = useRef(false);
  const refreshPending = useRef(false);
  const commit = useCallback((next: RequestSnapshot) => {
    latest.current = next;
    setSnapshot(next);
  }, []);
  const isCurrent = useCallback(
    () => !!account && focused.current && readScope() === scope,
    [account, readScope, scope],
  );
  const hasCurrentRequest = (id: string) =>
    isCurrent() &&
    latest.current?.scope === scope &&
    latest.current.rows.some((row) => row.id === id);
  const reload = useCallback(async () => {
    if (!isCurrent()) return;
    if (loading.current) {
      refreshPending.current = true;
      return;
    }
    const run = ++sequence.current;
    const current = () => isCurrent() && run === sequence.current;
    const guard = () => {
      if (!current()) throw new SessionChangedError();
    };
    loading.current = true;
    try {
      const session = await captureCurrentSession();
      guard();
      const rows = await listFriendRequests(session, guard);
      if (current()) {
        if (AppState.currentState === "active") {
          cueBaseline.current = observeIncomingRequests(
            cueBaseline.current,
            rows,
            "friend_request",
            current,
          );
        }
        commit({ scope, rows, failed: false });
      }
    } catch (error) {
      if (current()) {
        const unsupported = error instanceof TabApiError && error.status === 404;
        const previous = latest.current;
        commit({
          scope,
          rows: !unsupported && previous?.scope === scope ? previous.rows : [],
          failed: !unsupported,
        });
      }
    } finally {
      if (run === sequence.current) {
        loading.current = false;
        if (refreshPending.current) {
          refreshPending.current = false;
          void reload();
        }
      }
    }
  }, [commit, isCurrent, scope]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      refreshPending.current = false;
      loading.current = false;
      cueBaseline.current = null;
      setResponding(null);
      void reload();
      const offNotice = onNotificationInboxChanged(({ account: who }) => {
        if (who === account) void reload();
      });
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
        else cueBaseline.current = null;
      });
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void reload();
      }, 60_000);
      return () => {
        focused.current = false;
        refreshPending.current = false;
        activeResponse.current = null;
        sequence.current++;
        loading.current = false;
        subscription.remove();
        offNotice();
        clearInterval(timer);
      };
    }, [reload]),
  );
  const rows = account && snapshot?.scope === scope ? snapshot.rows : [];
  const respond = async (id: string, action: RequestAction["action"]) => {
    if (!hasCurrentRequest(id) || activeResponse.current) return;
    const operation = { scope, id, action };
    activeResponse.current = operation;
    setResponding(operation);
    const current = () => isCurrent() && activeResponse.current === operation;
    const guard = () => {
      if (!current() || !hasCurrentRequest(id)) throw new SessionChangedError();
    };
    try {
      try {
        const session = await captureCurrentSession();
        guard();
        if (action === "accept") await acceptFriendRequest(id, session, guard);
        else await dismissFriendRequest(id, session, guard);
      } catch (error) {
        if (!current() || !hasCurrentRequest(id)) return;
        // A request removed elsewhere is already gone. A conflict or a
        // lost response needs a fresh read before the next attempt.
        if (!(error instanceof TabApiError && error.status === 404)) {
          sequence.current++;
          loading.current = false;
          void reload();
          throw error;
        }
      }
      if (!current()) return;
      sequence.current++;
      loading.current = false;
      const previous = latest.current;
      if (previous?.scope === scope) {
        commit({ ...previous, rows: previous.rows.filter((row) => row.id !== id) });
      }
      if (account) notifyNotificationInboxChanged(account, "local");
    } finally {
      if (activeResponse.current === operation) {
        activeResponse.current = null;
        if (isCurrent()) setResponding(null);
      }
    }
  };
  return {
    rows,
    failed: !!account && snapshot?.scope === scope && snapshot.failed,
    isCurrent,
    isRequestCurrent: (id: string) => !activeResponse.current && hasCurrentRequest(id),
    reload,
    responding: responding?.scope === scope ? responding : null,
    accept: (id: string) => respond(id, "accept"),
    decline: (id: string) => respond(id, "decline"),
  };
}
