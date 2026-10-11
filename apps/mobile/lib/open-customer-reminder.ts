import { router } from "expo-router";
import { applyVaultCurrency } from "./currency";
import { onAccountIdentityChanged, setActiveVaultId } from "./db-tx";
import { listCustomerReminders, reminderOwnerScope } from "./customer-reminders";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
let latestTap = 0;

/** Resolve opaque notice IDs against the current private state. Payloads never
 * choose a customer/vault route or grant access, and opening is not Mark done. */
export async function openCustomerReminder(id: string, owner: string): Promise<void> {
  if (!UUID.test(id) || owner !== reminderOwnerScope()) return;
  const tap = ++latestTap;
  let switched = false;
  const stop = onAccountIdentityChanged(() => {
    switched = true;
  });
  const current = () => !switched && tap === latestTap && owner === reminderOwnerScope();
  try {
    const reminder = (await listCustomerReminders()).find((r) => r.id === id);
    if (!reminder || !current()) return;
    await setActiveVaultId(reminder.vault_id);
    if (!current()) return;
    await applyVaultCurrency(reminder.vault_id);
    if (!current()) return;
    // Membership/customer removal can apply while the vault switch awaits.
    if (
      !(await listCustomerReminders(reminder.vault_id, reminder.person_id)).some(
        (r) => r.id === id,
      ) ||
      !current()
    )
      return;
    router.push({ pathname: "/person/[id]", params: { id: reminder.person_id, reminderId: id } });
  } finally {
    stop();
  }
}
