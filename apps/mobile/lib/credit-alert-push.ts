import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import { getBackendUrl } from "./api";
import { applyForCurrentSession, captureCurrentSession } from "./auth";
import { canReadReminderVault } from "./customer-reminders";
import { getDb, getInstallIdSync } from "./db-tx";
import { getLocale } from "./i18n";
import {
  notificationOwnerScope,
  notificationPolicyForContact,
  notificationPreferencesRevision,
} from "./notification-preferences";
import { getReminderDeviceId } from "./reminder-device";
import { readVaultRole } from "./use-vault-role";
import {
  creditAlertObservationEpoch,
  creditAlertObservationPaused,
} from "./credit-alert-observation";

const retries = new Map<string, { signature: string; next: number }>();
let registering: Promise<void> | null = null;
let rerun = false;
const keyFor = (owner: string, device: string, install: string, vault: string) =>
  `credit_alert_remote:v1:${owner}:${device}:${install}:${vault}`;

/** Server registration is optional/additive. A missing endpoint or unavailable
 * network never erases the last confirmed transport capability. */
export function syncCreditAlertPushSubscriptions(force = false): Promise<void> {
  if (registering) {
    rerun ||= force;
    return registering;
  }
  registering = (async () => {
    if (creditAlertObservationPaused()) return;
    const observationEpoch = creditAlertObservationEpoch();
    if (isRunningInExpoGo()) return;
    const session = await captureCurrentSession();
    if (!session.jwt || !session.accountId) return;
    const owner = notificationOwnerScope();
    if (owner !== `account:${session.accountId}`) return;
    const install = getInstallIdSync();
    const device = await getReminderDeviceId();
    const revision = notificationPreferencesRevision();
    const locale = getLocale();
    const signature = `${session.bindingVersion}:${revision}:${locale}`;
    const current = () =>
      !creditAlertObservationPaused() &&
      observationEpoch === creditAlertObservationEpoch() &&
      owner === notificationOwnerScope() &&
      install === getInstallIdSync() &&
      revision === notificationPreferencesRevision() &&
      locale === getLocale();
    if (!current()) return;
    const db = await getDb();
    const { applyEventMutex } = await import("./projection");
    const vaults = await applyEventMutex.runExclusive(async () => {
      const rows = await db.getAllAsync<{ id: string }>(
        "SELECT id FROM vaults WHERE archived_at IS NULL",
      );
      const accessible: string[] = [];
      for (const row of rows) {
        if (!(await canReadReminderVault(db, row.id))) continue;
        const role = await readVaultRole(row.id, session.accountId);
        if (role === "owner" || role === "manager") accessible.push(row.id);
      }
      return accessible;
    });
    if (!current()) return;
    const due = vaults.filter((vault) => {
      const retry = retries.get(keyFor(owner, device, install, vault));
      return force || !retry || retry.signature !== signature || Date.now() >= retry.next;
    });
    if (!due.length) return;
    const n = await import("expo-notifications");
    const permission = await n.getPermissionsAsync();
    // Permission belongs to explicit setup/settings actions; startup observes it.
    const granted =
      permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL;
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!current() || (granted && !projectId)) return;
    const token = granted ? (await n.getExpoPushTokenAsync({ projectId: projectId! })).data : "";
    const base = await getBackendUrl();
    for (const vaultId of due) {
      if (!current()) return;
      const cacheKey = keyFor(owner, device, install, vaultId);
      retries.set(cacheKey, { signature, next: Date.now() + 60_000 });
      try {
        const preferences = await notificationPolicyForContact();
        const customers = await applyEventMutex.runExclusive(() =>
          db.getAllAsync<{ relationship_id: string; person_id: string }>(
            `SELECT r.id AS relationship_id,r.user_b_id AS person_id FROM relationships r
           JOIN users u ON u.id=r.user_b_id WHERE r.vault_id=? AND r.archived_at IS NULL AND u.archived_at IS NULL`,
            vaultId,
          ),
        );
        const customerPreferences = [];
        for (const customer of customers) {
          const effective = await notificationPolicyForContact({
            vaultId,
            personId: customer.person_id,
          });
          // The server falls back to the global policy for omitted customers.
          // Ordinary large vaults therefore need no per-customer payload rows.
          if (JSON.stringify(effective) !== JSON.stringify(preferences))
            customerPreferences.push({
              relationship_id: customer.relationship_id,
              preferences: effective,
            });
        }
        if (!current()) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const registration = {
            install_id: install,
            token,
            locale,
            preferences,
            customer_preferences: customerPreferences,
          };
          const register = (limits: boolean) =>
            fetch(
              `${base}/v1/sync/credit-alerts/notifications?vault_id=${encodeURIComponent(vaultId)}`,
              {
                method: "POST",
                signal: controller.signal,
                headers: {
                  Authorization: `Bearer ${session.jwt}`,
                  "Content-Type": "application/json",
                  "X-Kaata-Currencies": "1",
                },
                body: JSON.stringify({
                  ...registration,
                  ...(limits ? { limit_alerts: true } : {}),
                }),
              },
            );
          let requestedLimits = true;
          let response = await register(true);
          // Previous servers reject unknown JSON fields. One bounded legacy
          // retry preserves their combined-alert transport without granting
          // them ownership of the new currency-limit notifications.
          if (
            response.status === 400 &&
            response.headers.get("X-Kaata-Credit-Limit-Notifications") == null &&
            current()
          ) {
            requestedLimits = false;
            response = await register(false);
          }
          if (!response.ok) continue;
          const result = (await response.json()) as {
            remote_delivery_enabled?: unknown;
            remote_delivery_lease_ms?: unknown;
            limit_notifications_enabled?: unknown;
          };
          if (typeof result.remote_delivery_enabled !== "boolean" || !current()) continue;
          if (
            result.remote_delivery_enabled &&
            (typeof result.remote_delivery_lease_ms !== "number" ||
              !Number.isSafeInteger(result.remote_delivery_lease_ms) ||
              result.remote_delivery_lease_ms <= 0 ||
              result.remote_delivery_lease_ms > 366 * 24 * 3600_000)
          )
            continue;
          await applyForCurrentSession(session, () =>
            applyEventMutex.runExclusive(async () => {
              if (!current()) return;
              await db.runAsync(
                "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                cacheKey,
                JSON.stringify({
                  at: Date.now(),
                  enabled: !!token && result.remote_delivery_enabled === true,
                  limits_enabled:
                    requestedLimits &&
                    !!token &&
                    result.remote_delivery_enabled === true &&
                    result.limit_notifications_enabled === true,
                  lease_ms: result.remote_delivery_lease_ms ?? 0,
                }),
              );
            }),
          );
          retries.set(cacheKey, { signature, next: Date.now() + 3600_000 });
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        /* Retry without claiming that a prior valid registration vanished. */
      }
    }
  })().finally(() => {
    registering = null;
    if (rerun) {
      rerun = false;
      void syncCreditAlertPushSubscriptions(true).catch(() => undefined);
    }
  });
  return registering;
}

/** Bound to account, private device key, installation, and vault. Once the
 * server owns delivery, ordinary offline time cannot transfer it back to this
 * phone and create a second alert after upload. The server's explicit lease or
 * a confirmed disable determines when local fallback can take over.
 * Another phone's restored cache cannot inherit that delivery ownership. */
export async function creditAlertRemoteDeliveryActive(
  vaultId: string,
  source: "combined" | "limit" = "combined",
): Promise<boolean> {
  const owner = notificationOwnerScope();
  const install = getInstallIdSync();
  const device = await getReminderDeviceId();
  const { applyEventMutex } = await import("./projection");
  return applyEventMutex.runExclusive(async () => {
    const row = await (
      await getDb()
    ).getFirstAsync<{ value: string }>(
      "SELECT value FROM app_meta WHERE key=?",
      keyFor(owner, device, install, vaultId),
    );
    if (owner !== notificationOwnerScope() || install !== getInstallIdSync()) return false;
    try {
      const value = JSON.parse(row?.value ?? "null") as {
        at?: number;
        enabled?: boolean;
        limits_enabled?: boolean;
        lease_ms?: number;
      } | null;
      if (!value) return false;
      return (
        (source === "limit" ? value.limits_enabled === true : value.enabled === true) &&
        typeof value.at === "number" &&
        Number.isSafeInteger(value.at) &&
        value.at >= 0 &&
        typeof value.lease_ms === "number" &&
        Number.isSafeInteger(value.lease_ms) &&
        value.lease_ms > 0 &&
        Math.max(0, Date.now() - value.at) < value.lease_ms
      );
    } catch {
      return false;
    }
  });
}
