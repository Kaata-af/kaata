import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import { getSessionAccountIdSync, onAccountIdentityChanged } from "./db-tx";
import { ApiError } from "./vault-api";
import {
  declineVaultMemberRequest,
  listVaultMemberRequests,
  type VaultMemberRequest,
} from "./vault-member-requests";

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
  const [snapshot, setSnapshot] = useState<{ scope: string; rows: VaultMemberRequest[] } | null>(
    null,
  );
  const [failure, setFailure] = useState<{ scope: string; failed: boolean } | null>(null);
  const sequence = useRef(0);
  const active = useRef(false);
  const busy = useRef(false);
  const reload = useCallback(async () => {
    if (!account || currentScope() !== scope || !active.current || busy.current) return;
    const run = ++sequence.current;
    busy.current = true;
    try {
      const rows = await listVaultMemberRequests();
      if (active.current && run === sequence.current && currentScope() === scope) {
        setSnapshot({ scope, rows });
        setFailure({ scope, failed: false });
      }
    } catch (error) {
      if (active.current && run === sequence.current && currentScope() === scope)
        setFailure({ scope, failed: !(error instanceof ApiError && error.status === 404) });
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
    if (!account || !active.current || currentScope() !== scope) return;
    await declineVaultMemberRequest(id);
    if (active.current && currentScope() === scope) {
      sequence.current++;
      busy.current = false;
      setSnapshot((previous) =>
        previous?.scope === scope
          ? { scope, rows: previous.rows.filter((item) => item.id !== id) }
          : previous,
      );
    }
  };
  return {
    rows: account && snapshot?.scope === scope ? snapshot.rows : [],
    failed: account && failure?.scope === scope ? failure.failed : false,
    reload,
    decline,
  };
}
