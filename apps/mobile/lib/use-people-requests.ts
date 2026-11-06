import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import { getAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { declinePeopleRequest, listPeopleRequests, type PeopleRequest } from "./people-connections";
import { TabApiError } from "./tabs/errors";

/** Invitations stay in the existing inbox. No ledger or contacts are created
 * on receipt; only the normal join screen may accept an invitation. */
export function usePeopleRequests() {
  const account = useSyncExternalStore(onAccountIdentityChanged, getAccountIdSync, () => null);
  const [snapshot, setSnapshot] = useState<{ account: string; rows: PeopleRequest[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const reload = useCallback(async () => {
    if (!account || !active.current || busy.current) return;
    const run = ++sequence.current;
    busy.current = true;
    try {
      const rows = await listPeopleRequests();
      if (active.current && run === sequence.current && account === getAccountIdSync()) {
        setSnapshot({ account, rows });
        setFailed(false);
      }
    } catch (error) {
      if (active.current && run === sequence.current && account === getAccountIdSync()) {
        // Keep the ordinary notification inbox usable with an older server.
        setFailed(!(error instanceof TabApiError && error.status === 404));
      }
    } finally {
      if (run === sequence.current) busy.current = false;
    }
  }, [account]);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      busy.current = false;
      setFailed(false);
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
    if (!active.current || account !== getAccountIdSync()) return;
    await declinePeopleRequest(id);
    if (active.current && account === getAccountIdSync()) {
      sequence.current++;
      busy.current = false;
      setSnapshot((previous) =>
        previous?.account === account
          ? { ...previous, rows: previous.rows.filter((item) => item.id !== id) }
          : previous,
      );
    }
  };
  return { rows: snapshot?.account === account ? snapshot.rows : [], failed, reload, decline };
}
