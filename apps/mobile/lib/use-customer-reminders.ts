import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getInstallIdSync, onAccountIdentityChanged } from "./db-tx";
import {
  listCustomerReminders,
  onCustomerRemindersChanged,
  readReminderCustomer,
  reminderOwnerScope,
  type CustomerReminder,
} from "./customer-reminders";
import { onLedgerApplied } from "./ledger-events";

/** Scoped local reads; never request OS permission during focus or polling. */
export function useCustomerReminders(vaultId?: string, personId?: string, active = true) {
  const [state, setState] = useState<{
    rows: CustomerReminder[];
    loaded: boolean;
    failed: boolean;
    customer: { name: string } | null;
    owner: string;
    install: string;
    vaultId?: string;
    personId?: string;
  }>({
    rows: [],
    loaded: false,
    failed: false,
    customer: null,
    owner: reminderOwnerScope(),
    install: getInstallIdSync(),
    vaultId,
    personId,
  });
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0),
    focused = useRef(false);
  const refresh = useCallback(async () => {
    if (!active || !focused.current) return;
    const request = ++generation.current,
      owner = reminderOwnerScope(),
      install = getInstallIdSync();
    const current = () =>
      focused.current &&
      request === generation.current &&
      owner === reminderOwnerScope() &&
      install === getInstallIdSync();
    try {
      const [rows, customer] = await Promise.all([
        listCustomerReminders(vaultId, personId),
        vaultId && personId ? readReminderCustomer(vaultId, personId) : Promise.resolve(null),
      ]);
      if (current()) {
        setState({
          rows,
          loaded: true,
          failed: false,
          customer,
          owner,
          install,
          vaultId,
          personId,
        });
        setNow(Date.now());
      }
    } catch {
      if (current())
        setState({
          rows: [],
          loaded: true,
          failed: true,
          customer: null,
          owner,
          install,
          vaultId,
          personId,
        });
    }
  }, [active, vaultId, personId]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void refresh();
      return () => {
        focused.current = false;
        generation.current++;
      };
    }, [refresh]),
  );
  useEffect(() => {
    const update = () => {
      generation.current++;
      void refresh();
    };
    const identity = onAccountIdentityChanged(() => {
      generation.current++;
      setState({
        rows: [],
        loaded: false,
        failed: false,
        customer: null,
        owner: reminderOwnerScope(),
        install: getInstallIdSync(),
        vaultId,
        personId,
      });
      void refresh();
    });
    const reminders = onCustomerRemindersChanged(update),
      ledger = onLedgerApplied(update);
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") update();
    });
    const timer = active
      ? setInterval(() => {
          if (focused.current) setNow(Date.now());
        }, 30_000)
      : null;
    return () => {
      generation.current++;
      identity();
      reminders();
      ledger();
      app.remove();
      if (timer) clearInterval(timer);
    };
  }, [active, refresh]);
  const current =
    state.owner === reminderOwnerScope() &&
    state.install === getInstallIdSync() &&
    state.vaultId === vaultId &&
    state.personId === personId;
  const rows = current && active ? state.rows : [];
  return {
    rows,
    due: rows.filter((row) => row.next_due_at <= now),
    now,
    loaded: current && state.loaded,
    failed: state.failed,
    customer: current ? state.customer : null,
    refresh,
  };
}
