import { applyForUnchangedLocalSession, captureCurrentSession } from "./auth";
import {
  getDb,
  getInstallIdSync,
  getSessionAccountIdSync,
  onAccountIdentityChanged,
} from "./db-tx";
import {
  mergeNotificationPolicy,
  normalizeNotificationOverrides,
  normalizeNotificationPolicy,
  type NotificationOverrides,
  type NotificationPolicy,
} from "./notification-policy";
import type { TabLink } from "./tabs/types";
import { canReadReminderVault } from "./customer-reminders";

export type NotificationContact = { vaultId: string; personId: string };
const listeners = new Set<() => void>();
let revision = 0;
export const notificationPreferencesRevision = () => revision;
export const notificationOwnerScope = () => {
  const account = getSessionAccountIdSync();
  return account ? `account:${account}` : `local:${getInstallIdSync()}`;
};
const preferenceKey = (owner: string, contact?: NotificationContact) =>
  `notification_preferences:v1:${owner}${contact ? `:${contact.vaultId}:${contact.personId}` : ""}`;

export function onNotificationPreferencesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed() {
  revision++;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* isolate observers */
    }
  }
}
onAccountIdentityChanged(changed);

async function readValue(owner: string, contact?: NotificationContact): Promise<unknown> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key=?",
    preferenceKey(owner, contact),
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function readSettingsUnlocked(owner: string, contact?: NotificationContact) {
  const global = normalizeNotificationPolicy(await readValue(owner));
  const raw = contact ? await readValue(owner, contact) : null;
  const overrides = raw == null ? null : normalizeNotificationOverrides(raw);
  if (owner !== notificationOwnerScope()) throw new Error("notification_settings_scope_changed");
  return { global, overrides, effective: mergeNotificationPolicy(global, overrides), owner };
}

export async function readNotificationSettings(contact?: NotificationContact): Promise<{
  global: NotificationPolicy;
  overrides: NotificationOverrides | null;
  effective: NotificationPolicy;
  owner: string;
}> {
  const owner = notificationOwnerScope();
  // Wait for ledger transactions rather than reading their uncommitted app_meta.
  const { applyEventMutex } = await import("./projection");
  return applyEventMutex.runExclusive(() => readSettingsUnlocked(owner, contact));
}

export async function notificationPolicyForContact(
  contact?: NotificationContact,
): Promise<NotificationPolicy> {
  return (await readNotificationSettings(contact)).effective;
}

export async function notificationPolicyForTab(link: TabLink): Promise<NotificationPolicy> {
  const owner = notificationOwnerScope();
  const { applyEventMutex } = await import("./projection");
  return applyEventMutex.runExclusive(async () => {
    const db = await getDb();
    const row = await db.getFirstAsync<{ person_id: string; archived_at: number | null }>(
      "SELECT user_b_id AS person_id, archived_at FROM relationships WHERE id=? AND vault_id=?",
      link.relationship_id,
      link.vault_id,
    );
    const policy = (
      await readSettingsUnlocked(
        owner,
        row ? { vaultId: link.vault_id, personId: row.person_id } : undefined,
      )
    ).effective;
    // A missing/removed contact never broadens its old private or muted override.
    const readable =
      row && row.archived_at == null && (await canReadReminderVault(db, link.vault_id));
    if (owner !== notificationOwnerScope()) throw new Error("notification_settings_scope_changed");
    return readable ? policy : { ...policy, enabled: false };
  });
}

/** Preferences are personal to this signed-in account on this phone, not ledger events. */
export async function saveNotificationSettings(
  value: NotificationPolicy | NotificationOverrides | null,
  options: { contact?: NotificationContact; owner: string; shouldContinue?: () => boolean },
): Promise<void> {
  const session = await captureCurrentSession();
  const check = () => {
    if (options.owner !== notificationOwnerScope() || options.shouldContinue?.() === false)
      throw new Error("notification_settings_scope_changed");
  };
  await applyForUnchangedLocalSession(session, async () => {
    const { applyEventMutex } = await import("./projection");
    await applyEventMutex.runExclusive(async () => {
      const db = await getDb();
      await db.withTransactionAsync(async () => {
        check();
        const key = preferenceKey(options.owner, options.contact);
        if (value == null && options.contact)
          await db.runAsync("DELETE FROM app_meta WHERE key=?", key);
        else {
          const normalized = options.contact
            ? normalizeNotificationOverrides(value)
            : normalizeNotificationPolicy(value);
          await db.runAsync(
            "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            key,
            JSON.stringify(normalized),
          );
        }
        check();
      });
    });
  });
  changed();
}
