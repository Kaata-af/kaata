// App-wide notification bootstrap, imported by index.js in foreground and headless VMs.
// Never import expo-notifications in Expo Go (Android throws during module load).
import { AppState, Platform } from "react-native";
import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import * as TaskManager from "expo-task-manager";
import { getAppMeta, setAppMeta } from "../db";
import { getAccountIdSync, getInstallIdSync } from "../db-tx";
import { getLocale, t, tIn } from "../i18n";
import { getTabLink, listTabLinks, queueNotificationReview } from "./db";
import { registerTabNotifications, resolveTabAuth } from "./api";
import { setTabPushRefreshHook, syncTab, requestTabSync } from "./sync";
import { onTabApplied } from "./events";
import { setTabNotifyHook } from "./link";
import { parseTabReview, TAB_ACCEPT, TAB_REJECT } from "./notification-data";
import type { NotificationResponse, NotificationTaskPayload } from "expo-notifications";

const TASK = "kaata-tab-notification-actions";
const CHANNEL = "tab-updates";
const ASKED = "tab_notify_asked";
let nextRegistration = 0;
let registering: Promise<void> | null = null;
let notificationsPromise: Promise<typeof import("expo-notifications")> | null = null;
const processing = new Map<string, Promise<void>>();

async function notifications() {
  if (isRunningInExpoGo()) return null;
  notificationsPromise ??= import("expo-notifications").catch((err) => {
    notificationsPromise = null;
    throw err;
  });
  return notificationsPromise;
}

async function configure(n: typeof import("expo-notifications")) {
  await n.setNotificationChannelAsync(CHANNEL, {
    name: t("tab.notify.channel"),
    description: t("tab.notify.channelDescription"),
    importance: n.AndroidImportance.DEFAULT,
  });
  // Stable locale-specific IDs let a message use its registration's locale,
  // even if another device has since changed the account language.
  for (const locale of ["en", "fa"] as const) {
    await n.setNotificationCategoryAsync("tab-review-" + locale, [
      {
        identifier: TAB_ACCEPT,
        buttonTitle: "✓ " + tIn(locale, "tab.accept"),
        options: { opensAppToForeground: false, isAuthenticationRequired: true },
      },
      {
        identifier: TAB_REJECT,
        buttonTitle: "× " + tIn(locale, "tab.reject"),
        options: { opensAppToForeground: false, isAuthenticationRequired: true },
      },
    ]);
  }
}

/** Both native response paths use the same durable outbox receipt. Payload
 * IDs choose the target; session + server membership alone authorize it. */
async function review(action: string, data: unknown, notificationId: string) {
  const parsed = parseTabReview(action, data);
  if (!parsed) return;
  const key = parsed.tabId + ":" + parsed.entryId + ":" + parsed.rev;
  const existing = processing.get(key);
  if (existing) return existing;
  const work = (async () => {
    const link = await getTabLink(parsed.tabId);
    if (!link || link.role !== parsed.role || link.closed_at != null) return;
    // Never turn a signed-out tap into an operation for a later account.
    await resolveTabAuth(link);
    await queueNotificationReview(link, parsed.entryId, parsed.rev, parsed.action);
    const n = await notifications();
    // Durable now. A weak connection retries through the existing ordered
    // outbox; a stale/revoked/closed verdict becomes a visible failed operation.
    await n?.dismissNotificationAsync(notificationId);
    await syncTab(link.tab_id);
  })().finally(() => processing.delete(key));
  processing.set(key, work);
  return work;
}

async function handleResponse(response: NotificationResponse) {
  try {
    await review(
      response.actionIdentifier,
      response.notification.request.content.data,
      response.notification.request.identifier,
    );
    const { notificationActions } = await import("../../modules/kaata-notification-actions");
    await notificationActions?.complete(response.notification.request.identifier);
  } catch {
    // No successful receipt = no claim of success. iOS retains its native
    // handoff; Android offers an explicit retry by opening the notification.
    const n = await notifications().catch(() => null);
    await n
      ?.scheduleNotificationAsync({
        content: {
          title: "Kaata",
          body: t("tab.notify.actionFailed"),
          data: response.notification.request.content.data,
        },
        trigger: { channelId: CHANNEL },
      })
      .catch(() => undefined);
  }
}

async function drainNativeReviews() {
  if (Platform.OS !== "ios") return;
  const { notificationActions } = await import("../../modules/kaata-notification-actions");
  for (const pending of (await notificationActions?.pending()) ?? []) {
    try {
      await review(pending.action, pending.data, pending.id);
      await notificationActions?.complete(pending.id);
    } catch {
      /* keychain locked / DB booting: native handoff stays durable */
    }
  }
}

// Android delivers background action responses through TaskManager, whereas
// iOS delivers UNNotificationResponse; its native handoff grants bounded time
// and persists a tap before the JS runtime is ready.
TaskManager.defineTask<NotificationTaskPayload>(TASK, async ({ data, error }) => {
  if (error || !data || !("actionIdentifier" in data)) return;
  await handleResponse(data);
});

async function bootstrap() {
  const n = await notifications();
  if (!n) return;
  n.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  n.addNotificationResponseReceivedListener((r) => {
    void handleResponse(r);
  });
  n.addNotificationReceivedListener((r) => {
    const id = r.request.content.data?.tab_id;
    if (typeof id === "string") requestTabSync(id);
  });
  await configure(n);
  if (Platform.OS === "android") await n.registerTaskAsync(TASK);
  const last = await n.getLastNotificationResponseAsync();
  if (last) await handleResponse(last);
  await drainNativeReviews();
}
if (!isRunningInExpoGo()) void bootstrap().catch(() => undefined);

export function syncTabPushSubscriptions(): Promise<void> {
  if (registering) return registering;
  if (Date.now() < nextRegistration) return Promise.resolve();
  registering = (async () => {
    await drainNativeReviews();
    const links = await listTabLinks();
    if (!links.length) return;
    const n = await notifications();
    if (!n) return;
    await configure(n);
    let permission = await n.getPermissionsAsync();
    // Upgrades/restores already have links, so the create/join hook may never
    // run again. Ask once during a signed-in FOREGROUND sweep as well. Never
    // prompt from a notification's headless/background execution.
    if (
      AppState.currentState === "active" &&
      !permission.granted &&
      permission.canAskAgain &&
      (await getAppMeta(ASKED)) !== "1"
    ) {
      await resolveTabAuth(links[0]);
      permission = await n.requestPermissionsAsync();
      await setAppMeta(ASKED, "1");
    }
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = permission.granted ? (await n.getExpoPushTokenAsync({ projectId })).data : "";
    let enabled = false;
    let failed = false;
    for (const link of links) {
      try {
        const auth = await resolveTabAuth(link);
        const result = await registerTabNotifications(auth, link.tab_id, {
          install_id: getInstallIdSync(),
          token,
          locale: getLocale(),
        });
        const active = result.enabled && !!token;
        enabled ||= active;
        await setAppMeta("tab_push_active:" + link.tab_id, active ? String(Date.now()) : "0");
      } catch {
        failed = true;
      }
    }
    await setAppMeta("tab_push_active", enabled ? "1" : "0");
    await setAppMeta(
      "tab_push_error",
      failed
        ? "registration_failed"
        : enabled
          ? ""
          : permission.granted
            ? "server_disabled"
            : "permission_denied",
    );
    nextRegistration = Date.now() + (failed ? 60_000 : 3600_000);
  })()
    .catch(async () => {
      nextRegistration = Date.now() + 60_000;
      await setAppMeta("tab_push_active", "0").catch(() => undefined);
      await setAppMeta("tab_push_error", "credentials_or_network").catch(() => undefined);
    })
    .finally(() => {
      registering = null;
    });
  return registering;
}

export async function ensureTabNotificationPermission() {
  nextRegistration = 0;
  await syncTabPushSubscriptions();
}

// Foreground pulls also notify. With server delivery active they only update
// the UI; remote alerts are shown by the handler above, avoiding duplicates.
onTabApplied((ev) => {
  if (ev.origin !== "pull" || !ev.changes?.length) return;
  void (async () => {
    const registered = Number(await getAppMeta("tab_push_active:" + ev.tabId));
    if (registered && Date.now() - registered < 2 * 3600_000) return;
    const n = await notifications();
    const link = await getTabLink(ev.tabId);
    if (!n || !link) return;
    await configure(n);
    const { readVaultRole, canPerformAction } = await import("../use-vault-role");
    const canReview =
      link.closed_at == null &&
      canPerformAction(await readVaultRole(link.vault_id, getAccountIdSync()), "entry.amend");
    for (const change of ev.changes!) {
      const body =
        change.kind === "entry_created"
          ? t("tab.notify.newEntries", { count: 1 })
          : t(
              change.kind === "entry_accepted"
                ? "tab.notify.accepted"
                : change.kind === "entry_rejected"
                  ? "tab.notify.rejected"
                  : "tab.notify.voided",
            );
      await n.scheduleNotificationAsync({
        identifier: `tab:${ev.tabId}:${change.entryId}:${change.rev}`,
        content: {
          title: t("tab.notify.fallbackTitle"),
          body,
          data: {
            tab_id: ev.tabId,
            entry_id: change.entryId,
            rev: change.rev,
            role: link.role,
            kind: change.kind,
          },
          categoryIdentifier:
            canReview && change.kind === "entry_created" ? "tab-review-" + getLocale() : undefined,
        },
        trigger: { channelId: CHANNEL },
      });
    }
  })().catch(() => undefined);
});
setTabNotifyHook(ensureTabNotificationPermission);
setTabPushRefreshHook(syncTabPushSubscriptions);
