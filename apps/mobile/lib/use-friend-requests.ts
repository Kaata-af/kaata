import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { captureCurrentSession, SessionChangedError } from "./auth";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { dismissFriendRequest, listFriendRequests, type FriendRequest } from "./friends-api";
import { TabApiError } from "./tabs/errors";

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
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    rows: FriendRequest[];
    failed: boolean;
  } | null>(null);
  const focus = useRef(0);
  const focused = useRef(false);
  const sequence = useRef(0);
  const loading = useRef(false);
  const isCurrent = useCallback(
    () => !!account && focused.current && readScope() === scope,
    [account, readScope, scope],
  );
  const reload = useCallback(async () => {
    if (!isCurrent() || loading.current) return;
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
      if (current()) setSnapshot({ scope, rows, failed: false });
    } catch (error) {
      if (current()) {
        const unsupported = error instanceof TabApiError && error.status === 404;
        setSnapshot((previous) => ({
          scope,
          rows: !unsupported && previous?.scope === scope ? previous.rows : [],
          failed: !unsupported,
        }));
      }
    } finally {
      if (run === sequence.current) loading.current = false;
    }
  }, [isCurrent, scope]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      focus.current++;
      loading.current = false;
      void reload();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
      });
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void reload();
      }, 60_000);
      return () => {
        focused.current = false;
        focus.current++;
        sequence.current++;
        loading.current = false;
        subscription.remove();
        clearInterval(timer);
      };
    }, [reload]),
  );
  const rows = account && snapshot?.scope === scope ? snapshot.rows : [];
  const decline = async (id: string) => {
    if (!isCurrent() || !rows.some((row) => row.id === id)) return;
    const view = focus.current;
    const current = () => isCurrent() && view === focus.current;
    const guard = () => {
      if (!current()) throw new SessionChangedError();
    };
    try {
      const session = await captureCurrentSession();
      guard();
      await dismissFriendRequest(id, session, guard);
    } catch (error) {
      if (!current()) return;
      // A request removed from another device is already gone. A changed
      // relationship (409) is refreshed instead of silently dismissed.
      if (!(error instanceof TabApiError && error.status === 404)) {
        void reload();
        throw error;
      }
    }
    if (!current()) return;
    sequence.current++;
    loading.current = false;
    setSnapshot((previous) =>
      previous?.scope === scope
        ? { ...previous, rows: previous.rows.filter((row) => row.id !== id) }
        : previous,
    );
  };
  return {
    rows,
    failed: !!account && snapshot?.scope === scope && snapshot.failed,
    isCurrent,
    reload,
    decline,
  };
}
