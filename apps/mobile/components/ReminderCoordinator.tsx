import { useEffect } from "react";
import { AppState } from "react-native";
import { onAccountIdentityChanged } from "../lib/db-tx";
import { onLedgerApplied } from "../lib/ledger-events";
import { onCustomerRemindersChanged } from "../lib/customer-reminders";
import { subscribeLocale } from "../lib/i18n";
import {
  reconcileReminderNotifications,
  invalidateReminderNotificationWork,
} from "../lib/reminder-notifications";

/** Mounted after database boot; no permission prompt during launch/resume. */
export function ReminderCoordinator() {
  useEffect(() => {
    let ledgerTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      void reconcileReminderNotifications().catch(() => undefined);
    };
    const account = () => {
      clearTimeout(ledgerTimer);
      invalidateReminderNotificationWork();
      refresh();
    };
    refresh();
    const identity = onAccountIdentityChanged(account);
    const reminders = onCustomerRemindersChanged(refresh);
    // Scheduled alerts carry their text; a language switch rewrites them.
    const locale = subscribeLocale(refresh);
    // A restore/sync sweep emits many ledger notifications. Reconcile once
    // after the burst instead of repeatedly cancelling work mid-schedule.
    const ledger = onLedgerApplied(() => {
      clearTimeout(ledgerTimer);
      ledgerTimer = setTimeout(refresh, 150);
    });
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearTimeout(ledgerTimer);
      invalidateReminderNotificationWork();
      identity();
      reminders();
      locale();
      ledger();
      app.remove();
    };
  }, []);
  return null;
}
