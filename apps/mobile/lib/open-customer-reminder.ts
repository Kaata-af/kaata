import { router } from "expo-router";
import { applyVaultCurrency } from "./currency";
import { onAccountIdentityChanged, setActiveVaultId } from "./db-tx";
import { listCustomerReminders, reminderOwnerScope, reminderTimezone } from "./customer-reminders";
import { queueReminderPing } from "./reminder-ping-intent";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let latestTap = 0;

/** Resolve opaque notice IDs against the current private state. Payloads never
 * choose a customer/vault route or grant access, and opening is not Mark done.
 * Only a native notification tap supplies a key to prepare the reminder draft;
 * an in-app View action just opens the customer. */
export async function openCustomerReminder(
  id: string,
  owner: string,
  notificationKey?: string,
  notificationFingerprint?: string,
  canOpen: () => boolean = () => true,
): Promise<void> {
  if (!canOpen() || !UUID.test(id) || owner !== reminderOwnerScope()) return;
  const tap = ++latestTap;
  let switched = false;
  const stop = onAccountIdentityChanged(() => {
    switched = true;
  });
  const current = () =>
    canOpen() && !switched && tap === latestTap && owner === reminderOwnerScope();
  try {
    const reminder = (await listCustomerReminders()).find((r) => r.id === id);
    if (!reminder || !current()) return;
    await setActiveVaultId(reminder.vault_id);
    if (!current()) return;
    await applyVaultCurrency(reminder.vault_id);
    if (!current()) return;
    // Membership/customer removal can apply while the vault switch awaits.
    const fresh = (await listCustomerReminders(reminder.vault_id, reminder.person_id)).find(
      (r) => r.id === id,
    );
    if (!fresh || !current()) return;
    const fingerprint = `${fresh.updated_at}:${fresh.schedule_json}:${reminderTimezone()}`;
    // Editing or completing a recurrence can update the same ID before the
    // old alert leaves the tray. Still show its customer, but do not prepare a
    // draft for that stale occurrence. Older alerts lack a fingerprint.
    const stale = notificationFingerprint !== undefined && notificationFingerprint !== fingerprint;
    const actionKey =
      notificationKey !== undefined && !stale
        ? queueReminderPing({
            reminderId: id,
            personId: reminder.person_id,
            vaultId: reminder.vault_id,
            ownerScope: owner,
            notificationKey,
            fingerprint,
          })
        : null;
    // Draft consumption and navigation are separate: retrying a tap after a
    // failed route must still open its customer, without preparing it twice.
    if (!current()) return;
    router.push({
      pathname: "/person/[id]",
      params: {
        id: reminder.person_id,
        reminderId: id,
        ...(actionKey ? { reminderActionKey: actionKey } : {}),
      },
    });
  } finally {
    stop();
  }
}
