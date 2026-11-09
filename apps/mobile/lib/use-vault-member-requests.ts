import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { observeIncomingRequests, type IncomingRequestSnapshot } from "./incoming-request-cue";
import { ApiError } from "./vault-api";
import {
  declineVaultMemberRequest,
  listVaultMemberRequests,
  type VaultMemberRequest,
} from "./vault-member-requests";

type RequestSnapshot = { scope: string; rows: VaultMemberRequest[] };

/** Pending access requests live in the existing inbox, scoped to its signed-in account. */
export function useVaultMemberRequests() {
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
  const [snapshot, setSnapshot] = useState<RequestSnapshot | null>(null);
  const latest = useRef<RequestSnapshot | null>(null);
  const [failure, setFailure] = useState<{ scope: string; failed: boolean } | null>(null);
  const sequence = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const observed = useRef<IncomingRequestSnapshot | null>(null);
  const commit = useCallback((next: RequestSnapshot) => {
    latest.current = next;
    setSnapshot(next);
  }, []);
  const isCurrent = () => !!account && active.current && currentScope() === scope;
  const isRequestCurrent = (id: string) =>
    isCurrent() &&
    AppState.currentState === "active" &&
    latest.current?.scope === scope &&
    latest.current.rows.some((row) => row.id === id);
  const reload = useCallback(async () => {
    if (!account || currentScope() !== scope || !active.current || busy.current) return;
    const run = ++sequence.current;
    const current = () => active.current && run === sequence.current && currentScope() === scope;
    busy.current = true;
    try {
      const rows = await listVaultMemberRequests();
      if (current()) {
        observed.current = observeIncomingRequests(
          observed.current,
          rows,
          "vault_member_request",
          current,
        );
        commit({ scope, rows });
        setFailure({ scope, failed: false });
      }
    } catch (error) {
      if (current())
        setFailure({ scope, failed: !(error instanceof ApiError && error.status === 404) });
    } finally {
      if (run === sequence.current) busy.current = false;
    }
  }, [account, scope, commit]);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      observed.current = null;
      busy.current = false;
      setFailure(null);
      void reload();
      const listener = AppState.addEventListener("change", (state) => {
        if (state === "active") void reload();
        else observed.current = null;
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
    if (!isRequestCurrent(id)) return;
    await declineVaultMemberRequest(id);
    const previous = latest.current;
    if (isCurrent() && previous?.scope === scope) {
      sequence.current++;
      busy.current = false;
      commit({ scope, rows: previous.rows.filter((item) => item.id !== id) });
    }
  };
  return {
    rows: account && snapshot?.scope === scope ? snapshot.rows : [],
    failed: account && failure?.scope === scope ? failure.failed : false,
    reload,
    decline,
    isCurrent,
    isRequestCurrent,
  };
}
