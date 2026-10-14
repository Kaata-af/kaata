import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { getActiveVaultIdSyncMaybe, onAccountIdentityChanged } from "./db-tx";
import { listCustomerReminders, reminderOwnerScope, reminderTimezone } from "./customer-reminders";
import { consumeReminderPing, discardReminderPing, hasReminderPing } from "./reminder-ping-intent";

/** Wait for the target's full ledger to paint in the foreground, then reuse
 * its normal WhatsApp flow. Loading, deep links and return visits aren't taps. */
export function useReminderPing(props: {
  actionKey?: string;
  reminderId?: string;
  personId: string;
  vaultId: string | null;
  ownerScope: string;
  ready: boolean;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const focused = useRef(false);
  const automatic = useRef(false);
  const generation = useRef(0);
  const [wake, setWake] = useState(0);
  const { actionKey, reminderId, personId, vaultId, ownerScope, ready, busy } = props;

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setWake((value) => value + 1);
      const identity = onAccountIdentityChanged(() => {
        generation.current++;
        discardReminderPing(actionKey);
        latest.current.onCancel();
      });
      const app = AppState.addEventListener("change", (state) => {
        generation.current++;
        if (state === "active") setWake((value) => value + 1);
        else if (automatic.current) {
          automatic.current = false;
          latest.current.onCancel();
        }
      });
      return () => {
        focused.current = false;
        automatic.current = false;
        generation.current++;
        discardReminderPing(actionKey);
        latest.current.onCancel();
        identity();
        app.remove();
      };
    }, [actionKey, reminderId, personId, vaultId, ownerScope]),
  );

  useEffect(() => {
    if (typeof actionKey !== "string" || typeof reminderId !== "string" || !vaultId) return;
    const context = { reminderId, personId, vaultId, ownerScope };
    if (!hasReminderPing(actionKey, context)) return;
    // A manual press during the tiny handoff window already starts this flow.
    if (busy) {
      discardReminderPing(actionKey);
      return;
    }
    if (!ready || !focused.current || AppState.currentState !== "active") return;
    const request = ++generation.current;
    let cancelled = false;
    const current = () =>
      !cancelled &&
      request === generation.current &&
      focused.current &&
      AppState.currentState === "active" &&
      latest.current.ready &&
      !latest.current.busy &&
      latest.current.actionKey === actionKey &&
      latest.current.personId === personId &&
      latest.current.vaultId === vaultId &&
      latest.current.ownerScope === ownerScope &&
      reminderOwnerScope() === ownerScope &&
      getActiveVaultIdSyncMaybe() === vaultId;
    void listCustomerReminders(vaultId, personId)
      .then((rows) => {
        if (!current()) return;
        const row = rows.find((row) => row.id === reminderId);
        if (!row) {
          discardReminderPing(actionKey);
          return;
        }
        const fingerprint = `${row.updated_at}:${row.schedule_json}:${reminderTimezone()}`;
        if (consumeReminderPing(actionKey, { ...context, fingerprint })) {
          automatic.current = true;
          latest.current.onStart();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [actionKey, reminderId, personId, vaultId, ownerScope, ready, busy, wake]);
}
