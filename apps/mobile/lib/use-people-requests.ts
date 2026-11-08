import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { declinePeopleRequest, listPeopleRequests, type PeopleRequest } from "./people-connections";
import { TabApiError } from "./tabs/errors";

/** Invitations stay in the existing inbox. No ledger or contacts are created
 * on receipt; only the normal join screen may accept an invitation. */
export function usePeopleRequests() {
  const identityRevision = useRef(0);
  const subscribe = useCallback(
    (notify: () => void) =>
      onAccountIdentityChanged(() => {
        identityRevision.current++;
        notify();
      }),
    [],
  );
  const currentScope = () => `${identityRevision.current}:${getSessionAccountIdSync() ?? ""}`;
  const scope = useSyncExternalStore(subscribe, currentScope, () => "signed-out");
  const account = getSessionAccountIdSync();
  const [snapshot, setSnapshot] = useState<{ scope: string; rows: PeopleRequest[] } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; failed: boolean } | null>(null);
  const sequence = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const isCurrent = () => !!account && active.current && currentScope() === scope;
  const reload = useCallback(async () => {
    if (!account || currentScope() !== scope || !active.current || busy.current) return;
    const run = ++sequence.current;
    busy.current = true;
    try {
      const rows = await listPeopleRequests();
      if (active.current && run === sequence.current && currentScope() === scope) {
        setSnapshot({ scope, rows });
        setFailure({ scope, failed: false });
      }
    } catch (error) {
      if (active.current && run === sequence.current && currentScope() === scope) {
        // Keep the ordinary notification inbox usable with an older server.
        setFailure({ scope, failed: !(error instanceof TabApiError && error.status === 404) });
      }
    } finally {
      if (run === sequence.current) busy.current = false;
    }
  }, [account, scope]);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      busy.current = false;
      setFailure(null);
      void reload();
      const listener = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
      });
      const timer = setInterval(() => {
        if (AppState.currentState === "active") void reload();
      }, 60_000);
      return () => {
        active.current = false;
        sequence.current++;
        busy.current = false;
        listener.remove();
        clearInterval(timer);
      };
    }, [reload]),
  );
  const decline = async (id: string) => {
    if (!isCurrent()) return;
    await declinePeopleRequest(id);
    if (isCurrent()) {
      sequence.current++;
      busy.current = false;
      setSnapshot((previous) =>
        previous?.scope === scope
          ? { ...previous, rows: previous.rows.filter((item) => item.id !== id) }
          : previous,
      );
    }
  };
  return {
    rows: account && snapshot?.scope === scope ? snapshot.rows : [],
    failed: account && failure?.scope === scope ? failure.failed : false,
    isCurrent,
    reload,
    decline,
  };
}
