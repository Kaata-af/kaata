import { isRunningInExpoGo } from "expo";
import { Platform } from "react-native";
import { getDb } from "./db-tx";
import { getLocale, t } from "./i18n";
import {
  listCustomerReminders,
  readReminderSchedule,
  reminderOwnerScope,
  reminderTimezone,
} from "./customer-reminders";
import {
  MAX_REMINDER_NOTIFICATION_REQUESTS,
  nextReminderOccurrence,
  reminderNativeRequests,
} from "./reminder-schedule";
import {
  notificationAllowed,
  notificationChannel,
  quietNotificationMinute,
  type NotificationPolicy,
} from "./notification-policy";
import {
  notificationPolicyForContact,
  notificationOwnerScope,
  notificationPreferencesRevision,
  onNotificationPreferencesChanged,
} from "./notification-preferences";

const CHANNEL = "customer-reminders";
const PREFIX = "kaata-customer-reminder:";
let generation = 0;
let tail: Promise<unknown> = Promise.resolve();
let expoGoHandlerInstalled = false;
let configuredChannelLocale: string | null = null;

async function native() {
  const expoGo = isRunningInExpoGo();
  if (expoGo && Platform.OS !== "ios") return null;
  const notifications = await import("expo-notifications");
  // iOS Expo Go supports local reminders, but skips the native app's shared
  // notification bootstrap. Do not replace that handler in signed builds.
  if (expoGo && !expoGoHandlerInstalled) {
    notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const data = notification.request.content.data;
        const owner = notificationOwnerScope(),
          revision = notificationPreferencesRevision();
        const policy = await notificationPolicyForContact(
          typeof data?.vault_id === "string" && typeof data?.person_id === "string"
            ? { vaultId: data.vault_id, personId: data.person_id }
            : undefined,
        );
        const show =
          owner === notificationOwnerScope() &&
          revision === notificationPreferencesRevision() &&
          data?.kind === "customer_reminder" &&
          data.owner_scope === owner &&
          notificationAllowed(policy, "customer_reminder");
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show && policy.sound,
          shouldSetBadge: false,
        };
      },
    });
    expoGoHandlerInstalled = true;
  }
  return notifications;
}

export async function requestReminderNotifications(): Promise<
  "granted" | "denied" | "unavailable"
> {
  const n = await native();
  if (!n) return "unavailable";
  if (Platform.OS === "android")
    await n.setNotificationChannelAsync(CHANNEL, {
      name: t("reminders.channel"),
      importance: n.AndroidImportance.DEFAULT,
    });
  let permission = await n.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await n.requestPermissionsAsync();
  return permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL
    ? "granted"
    : "denied";
}

/** Permission as it stands, without ever prompting (screens read it on focus). */
export async function reminderNotificationStatus(): Promise<"granted" | "denied" | "unavailable"> {
  const n = await native();
  if (!n) return "unavailable";
  const permission = await n.getPermissionsAsync();
  return permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL
    ? "granted"
    : "denied";
}

export async function notificationPermissionDetails(): Promise<
  "granted" | "denied" | "notAsked" | "unavailable"
> {
  const n = await native();
  if (!n) return "unavailable";
  const permission = await n.getPermissionsAsync();
  return permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL
    ? "granted"
    : permission.canAskAgain
      ? "notAsked"
      : "denied";
}

/** Only our prefixed requests are touched. Editing, deletion, account changes,
 * revocation and restored backups cannot leave old schedules running. */
export function reconcileReminderNotifications(): Promise<void> {
  const request = ++generation;
  const owner = reminderOwnerScope();
  const current = () => request === generation && owner === reminderOwnerScope();
  const run = async () => {
    const n = await native();
    if (!n || !current()) return;
    if (Platform.OS === "android" && configuredChannelLocale !== getLocale())
      await n.setNotificationChannelAsync(CHANNEL, {
        name: t("reminders.channel"),
        importance: n.AndroidImportance.DEFAULT,
      });
    if (Platform.OS === "android" && configuredChannelLocale !== getLocale())
      for (const sound of [false, true])
        for (const vibration of [false, true]) {
          const key = sound
            ? vibration
              ? "notificationSettings.channel.soundVibration"
              : "notificationSettings.channel.sound"
            : vibration
              ? "notificationSettings.channel.vibration"
              : "notificationSettings.channel.silent";
          await n.setNotificationChannelAsync(notificationChannel({ sound, vibration }, true), {
            name: `${t("reminders.channel")} · ${t(key)}`,
            importance: n.AndroidImportance.DEFAULT,
            sound: sound ? "default" : null,
            enableVibrate: vibration,
            vibrationPattern: vibration ? [0, 250, 250, 250] : [],
          });
        }
    if (Platform.OS === "android") configuredChannelLocale = getLocale();
    const permission = await n.getPermissionsAsync();
    const enabled =
      permission.granted || permission.ios?.status === n.IosAuthorizationStatus.PROVISIONAL;
    const candidates = enabled ? await listCustomerReminders() : [];
    const policies = new Map<string, NotificationPolicy>();
    for (const row of candidates) {
      const key = `${row.vault_id}:${row.person_id}`;
      if (!policies.has(key))
        policies.set(
          key,
          await notificationPolicyForContact({ vaultId: row.vault_id, personId: row.person_id }),
        );
      if (!current()) return;
    }
    const policyFor = (row: (typeof candidates)[number]) =>
      policies.get(`${row.vault_id}:${row.person_id}`)!;
    const rows = candidates.filter((row) => policyFor(row).enabled && policyFor(row).reminders);
    const existing = (await n.getAllScheduledNotificationsAsync()).filter((r) =>
      r.identifier.startsWith(PREFIX),
    );
    if (!current()) return;
    const live = new Map(existing.map((r) => [r.identifier, r]));
    const wanted = new Set<string>();
    const zone = reminderTimezone();
    // A delivered one-off stays in the tray while its task is outstanding.
    // Completed/removed tasks and a previous account's notices are dismissed.
    const activeTasks = new Map(rows.map((row) => [row.id, row]));
    const presented = await n.getPresentedNotificationsAsync();
    if (!current()) return;
    for (const notice of presented) {
      const request = notice.request;
      if (!request.identifier.startsWith(PREFIX)) continue;
      const reminderId = request.content.data?.reminder_id;
      // Legacy single-request notices did not always include the opaque ID in
      // fixtures/restored trays. New multi-request notices share one task ID.
      const row = activeTasks.get(
        typeof reminderId === "string" ? reminderId : request.identifier.slice(PREFIX.length),
      );
      const fingerprint = row ? `${row.updated_at}:${row.schedule_json}:${zone}` : null;
      const policy = row ? policyFor(row) : null;
      const policyKey = policy ? textHash(JSON.stringify(policy)) : null;
      if (
        !row ||
        (request.identifier !== PREFIX + row.id &&
          !request.identifier.startsWith(PREFIX + row.id + ":")) ||
        request.content.data?.owner_scope !== owner ||
        request.content.data?.reminder_fingerprint !== fingerprint ||
        (request.content.data?.policy_key != null &&
          request.content.data.policy_key !== policyKey) ||
        (policy?.previews === "private" && request.content.data?.policy_key !== policyKey)
      ) {
        await n.dismissNotificationAsync(request.identifier);
        if (!current()) return;
      }
    }
    const plans = rows.flatMap((row) => {
      const schedule = readReminderSchedule(row);
      if (!schedule || (schedule.kind === "once" && schedule.at <= Date.now())) return [];
      const policy = policyFor(row);
      if (
        schedule.kind === "once"
          ? !notificationAllowed(policy, "customer_reminder", new Date(schedule.at))
          : !policy.quiet_hours.allow_reminders &&
            quietNotificationMinute(policy, schedule.hour * 60 + schedule.minute)
      )
        return [];
      return reminderNativeRequests(
        schedule,
        notificationChannel(policy, true),
        Platform.OS === "ios" ? "ios" : "android",
      ).map((request) => ({
        row,
        id: PREFIX + row.id + request.suffix,
        trigger: request.trigger,
      }));
    });
    if (plans.length > MAX_REMINDER_NOTIFICATION_REQUESTS)
      throw new Error("reminder_notification_limit");
    for (const plan of plans) wanted.add(plan.id);
    // Remove replaced weekday/month fragments before adding their replacements;
    // edits must not temporarily exceed the OS cap while the old plan is live.
    for (const old of existing) {
      if (!current()) return;
      if (!wanted.has(old.identifier)) await n.cancelScheduledNotificationAsync(old.identifier);
    }
    for (const row of rows) {
      if (!current()) return;
      const schedule = readReminderSchedule(row);
      if (!schedule) continue;
      if (row.timezone !== zone && schedule.kind !== "once") {
        // Keep an already-due task outstanding, while future clock times follow
        // the new device timezone. Native daily/weekly triggers do this too.
        const due =
          row.next_due_at <= Date.now()
            ? row.next_due_at
            : nextReminderOccurrence(schedule, Date.now());
        if (due != null) {
          await (
            await getDb()
          ).runAsync(
            "UPDATE customer_reminders SET next_due_at=?, timezone=? WHERE id=? AND owner_scope=? AND updated_at=?",
            due,
            zone,
            row.id,
            owner,
            row.updated_at,
          );
        }
      }
    }
    for (const { row, id, trigger } of plans) {
      if (!current()) return;
      const fingerprint = `${row.updated_at}:${row.schedule_json}:${zone}`;
      const policy = policyFor(row);
      const policyKey = textHash(JSON.stringify(policy));
      // The text is fixed when scheduled: a language switch or a rename
      // rewrites pending alerts. A notice already in the tray is left as it is
      // (the task did not change), so the text is kept apart from the
      // fingerprint.
      const name = (row.person_name ?? "").trim();
      const textKey = textHash(`${getLocale()}\0${name}`);
      const old = live.get(id);
      if (
        old?.content.data?.reminder_fingerprint === fingerprint &&
        old.content.data?.owner_scope === owner &&
        old.content.data?.text_key === textKey &&
        old.content.data?.policy_key === policyKey
      )
        continue;
      if (old) await n.cancelScheduledNotificationAsync(id);
      if (!current()) return;
      await n.scheduleNotificationAsync({
        identifier: id,
        content: {
          title: "Kaata",
          // Name the customer (Matee, 2026-10-12): several due reminders used
          // to look identical. Shared-account alerts already show names.
          body:
            policy.previews !== "private" && name
              ? t("reminders.notifyBodyNamed", { name })
              : t("reminders.notifyBody"),
          sound: policy.sound ? "default" : undefined,
          vibrate: policy.vibration ? [0, 250, 250, 250] : [],
          data: {
            kind: "customer_reminder",
            reminder_id: row.id,
            owner_scope: owner,
            reminder_fingerprint: fingerprint,
            text_key: textKey,
            policy_key: policyKey,
            vault_id: row.vault_id,
            person_id: row.person_id,
          },
        },
        trigger,
      });
      if (!current()) {
        await n.cancelScheduledNotificationAsync(id);
        return;
      }
    }
  };
  const work = tail.then(run, run);
  tail = work.catch(() => undefined);
  return work;
}

// FNV-1a of the alert's text inputs: notices which alerts need rewriting
// without putting the customer's name into the payload's data.
function textHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function invalidateReminderNotificationWork(): void {
  generation++;
}

onNotificationPreferencesChanged(() => {
  void reconcileReminderNotifications().catch(() => undefined);
});
