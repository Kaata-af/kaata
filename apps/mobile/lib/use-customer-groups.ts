import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { getAccountIdSync } from "./db-tx";
import { readCustomerGroups, type CustomerGroupsState } from "./customer-groups";
import { useLedgerRefresh } from "./ledger-events";

export function useCustomerGroups(vaultId: string | null) {
  const [state, setState] = useState<
    CustomerGroupsState & { vault: string | null; account: string | null }
  >({ groups: [], groupByPerson: {}, groupsByPerson: {}, vault: null, account: null });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0),
    mounted = useRef(true);
  const account = getAccountIdSync();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!vaultId) {
      setState({ groups: [], groupByPerson: {}, groupsByPerson: {}, vault: null, account });
      setLoaded(true);
      return;
    }
    try {
      const next = await readCustomerGroups(vaultId);
      if (!mounted.current || request !== generation.current || getAccountIdSync() !== account)
        return;
      setState({ ...next, vault: vaultId, account });
      setFailed(false);
      setLoaded(true);
    } catch {
      if (!mounted.current || request !== generation.current || getAccountIdSync() !== account)
        return;
      setFailed(true);
      setLoaded(true);
    }
  }, [vaultId, account]);
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setState({ groups: [], groupByPerson: {}, groupsByPerson: {}, vault: vaultId, account });
    void refresh();
  }, [refresh]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        generation.current++;
      };
    }, [refresh]),
  );
  useLedgerRefresh(vaultId, () => {
    void refresh();
  });
  const current = state.vault === vaultId && state.account === account;
  return {
    groups: current ? state.groups : [],
    groupByPerson: current ? state.groupByPerson : {},
    groupsByPerson: current ? state.groupsByPerson : {},
    loaded: current && loaded,
    failed: current && failed,
    refresh,
  };
}
