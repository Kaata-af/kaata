// apps/mobile/lib/tabs/notify.ts
//
// Mutual-tab notifications: renewable, party-authorized Expo push
// subscriptions, with a local pull fallback when server delivery is off.
// Real background delivery requires an EAS/native build with FCM/APNs
// credentials and TAB_PUSH_ENABLED on the server. No prompt at boot.
//
// It subscribes at module load — index.js imports it beside bg-notify — so the
// subscription exists in whichever VM applied the pull.
//
// Three rules, each of which was a bug somewhere else in this app:
//
//   - BOTH platforms. bg-notify is Android-gated because its producer (cloud
//     ledger sync) can run headless there; this one is driven by an ordinary
//     foreground/background pull, and an iPhone shopkeeper needs it just as
//     much. iOS therefore needs a permission prompt, which is why
//     ensureTabNotificationPermission exists and is asked at link/join time —
//     the one moment the request has obvious meaning — not at first launch.
//   - expo-notifications is imported LAZILY and never in Expo Go. Importing it
//     registers a push-token listener at module scope, which THROWS on Android
//     under Expo Go since SDK 53; this module is reachable from index.js, so a
//     static import would red-screen every Expo Go session (CLAUDE.md). The
//     loader below is bg-notify's, copied rather than imported: bg-notify is
//     Android-gated and already subscribed at boot, and importing its
//     internals would tie this feature's platform coverage to that file's.
//   - origin === "pull" only. A "local" event is this device's own optimistic
//     write; notifying the user about their own tap is noise, and AppState is
//     "active" then anyway.

import { AppState } from "react-native";
import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";

import { getAppMeta, setAppMeta } from "../db";
import { t, getLocale } from "../i18n";
import { getInstallIdSync } from "../db-tx";
import { getPersonIdForRelationship, getTabLink, listTabLinks } from "./db";
import { registerTabNotifications, resolveTabAuth, TabApiError } from "./api";
import { setTabPushRefreshHook } from "./sync";
import { onTabApplied } from "./events";
import { setTabNotifyHook } from "./link";

const CHANNEL_ID = "tab-updates";
// One notification per tab per burst: a pull that lands five tallies and three
// status changes is one event to the shopkeeper, not eight.
const DEBOUNCE_MS = 3000;
// Asked once per install, at link/join time (D14). The value is only ever "1".
const ASKED_KEY = "tab_notify_asked";
const PUSH_ACTIVE_KEY = "tab_push_active";
let nextRegistration = 0;
let registering: Promise<void> | null = null;

/** Refresh subscriptions on foreground; no permission prompt outside linking.
 * Registration failures leave local notifications and ledger sync usable. */
export function syncTabPushSubscriptions(): Promise<void> {
  if (registering) return registering;
  if (Date.now() < nextRegistration) return Promise.resolve();
  registering = (async () => {
    const links = await listTabLinks();
    if (!links.length) return;
    const notifications = await loadNotifications();
    if (!notifications) return;
    await ensureChannel(notifications);
    const permission = await notifications.getPermissionsAsync();
    const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const token = permission.granted
      ? (await notifications.getExpoPushTokenAsync({ projectId })).data
      : "";
    let enabled = false;
    for (const link of links) {
      let auth = await resolveTabAuth(link);
      const body = { install_id: getInstallIdSync(), token, locale: getLocale() };
      try {
        const result = await registerTabNotifications(auth, link.tab_id, body);
        enabled ||= result.enabled;
      } catch (err) {
        if (
          auth &&
          "jwt" in auth &&
          link.party_token &&
          err instanceof TabApiError &&
          (err.status === 401 || err.status === 404)
        ) {
          auth = { token: link.party_token };
          const result = await registerTabNotifications(auth, link.tab_id, body);
          enabled ||= result.enabled;
        } else throw err;
      }
    }
    await setAppMeta(PUSH_ACTIVE_KEY, enabled && token ? "1" : "0");
    nextRegistration = Date.now() + 60 * 60_000;
  })()
    .catch(() => {
      // Missing native credentials / offline: retry later, never fail startup.
      nextRegistration = Date.now() + 60_000;
    })
    .finally(() => {
      registering = null;
    });
  return registering;
}

type NotificationsModule = typeof import("expo-notifications");
let notificationsPromise: Promise<NotificationsModule> | null = null;

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (isRunningInExpoGo()) return null;
  if (!notificationsPromise) {
    notificationsPromise = import("expo-notifications").catch((err) => {
      // Clear the cached rejection so a transient failure can be retried on the
      // next pull instead of silencing this feature for the whole process.
      notificationsPromise = null;
      throw err;
    });
  }
  return notificationsPromise;
}

let channelReady = false;

async function ensureChannel(notifications: NotificationsModule): Promise<void> {
  if (channelReady) return;
  // Android only in effect (a no-op elsewhere), but calling it unconditionally
  // keeps the permission path and the post path identical on both platforms.
  // DEFAULT importance: a tally landing is worth a sound, not a heads-up
  // interruption — and the user can still mute the channel in system settings.
  await notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: t("tab.notify.channel"),
    importance: notifications.AndroidImportance.DEFAULT,
    description: t("tab.notify.channelDescription"),
  });
  channelReady = true;
}

/**
 * Ask for notification permission, once per install, at the moment it means
 * something: linkContact / joinTabAsContact call this through the hook they
 * registered below. Best effort by contract — the caller never awaits the UI
 * and a refusal must not fail the link.
 *
 * Both app_meta reads/writes happen HERE, outside any SQLite transaction:
 * setAppMeta is a bare statement on the shared connection and would join (and
 * roll back with) whatever transaction was open. The link flows call this
 * fire-and-forget after their own writes have committed.
 */
export async function ensureTabNotificationPermission(): Promise<void> {
  const notifications = await loadNotifications().catch(() => null);
  if (!notifications) return;
  // Channel first: on Android the system permission dialog shows the channel
  // list, and a request made before any channel exists is less legible.
  try {
    await ensureChannel(notifications);
  } catch (err) {
    if (__DEV__) console.warn("[tabs.notify] channel setup failed", err);
  }
  if ((await getAppMeta(ASKED_KEY)) === "1") {
    nextRegistration = 0;
    await syncTabPushSubscriptions();
    return;
  }
  try {
    const current = await notifications.getPermissionsAsync();
    if (!current.granted && current.canAskAgain) {
      await notifications.requestPermissionsAsync();
    }
  } catch (err) {
    if (__DEV__) console.warn("[tabs.notify] permission request failed", err);
  } finally {
    // Marked asked even on a refusal or a throw: the OS only honours one
    // prompt on iOS anyway, and re-asking every link would be nagging.
    await setAppMeta(ASKED_KEY, "1").catch(() => undefined);
    nextRegistration = 0;
    await syncTabPushSubscriptions();
  }
}

// ---------------------------------------------------------------------------
// The pull → notification path.

type Pending = { newFromThem: number; statusChangedOnMine: number };

const pending = new Map<string, Pending>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function flush(tabId: string): Promise<void> {
  timers.delete(tabId);
  const counts = pending.get(tabId);
  pending.delete(tabId);
  if (!counts) return;
  // Re-check on the way out: the user may have opened the app during the
  // coalesce window, in which case the person screen is already showing them
  // the rows and a notification is pure noise.
  if ((AppState.currentState as string) === "active") return;

  // The server already sent a remote alert. Do not duplicate it when a
  // background pull catches up with the same revision.
  if ((await getAppMeta(PUSH_ACTIVE_KEY)) === "1") return;

  const notifications = await loadNotifications().catch(() => null);
  if (!notifications) return;
  try {
    await ensureChannel(notifications);
  } catch {
    return;
  }

  const link = await getTabLink(tabId).catch(() => null);
  // The other party's own label is the title — it is how they named
  // themselves to us, and it is what the person screen's chip shows. Before
  // they join there is no label, hence the fallback.
  const title = link?.other_label?.trim() || t("tab.notify.fallbackTitle");
  const body =
    counts.newFromThem > 0
      ? t("tab.notify.newEntries", { count: counts.newFromThem })
      : t("tab.notify.reviewed");

  // Deep link straight to the contact whose account changed, not to home: the
  // tap already told us which tab. _layout.tsx's response listener reads this
  // tab_id and switches to its kaata before navigating. A missing contact
  // torn local state) still notifies — it just opens the app.
  const personId = link
    ? await getPersonIdForRelationship(link.relationship_id).catch(() => null)
    : null;

  try {
    // The CHANNEL-AWARE trigger form, not null: `null` drops the notification
    // onto expo-notifications' auto-created "Miscellaneous" channel, so the
    // user's mute/importance settings for this one would silently not apply.
    await notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: personId ? { tab_id: tabId } : {},
      },
      trigger: { channelId: CHANNEL_ID },
    });
  } catch (err) {
    if (__DEV__) console.warn("[tabs.notify] scheduleNotificationAsync failed", err);
  }
}

onTabApplied((ev) => {
  if (ev.origin !== "pull") return;
  if (ev.newFromThem <= 0 && ev.statusChangedOnMine <= 0) return;
  if ((AppState.currentState as string) === "active") return;
  const prev = pending.get(ev.tabId) ?? { newFromThem: 0, statusChangedOnMine: 0 };
  pending.set(ev.tabId, {
    newFromThem: prev.newFromThem + ev.newFromThem,
    statusChangedOnMine: prev.statusChangedOnMine + ev.statusChangedOnMine,
  });
  if (!timers.has(ev.tabId)) {
    timers.set(
      ev.tabId,
      setTimeout(() => void flush(ev.tabId), DEBOUNCE_MS),
    );
  }
});

// Hand the permission prompt to lib/tabs/link.ts, which owns the two moments
// worth asking at (link and join) but must not import expo-notifications
// itself — it is reachable from screens that load long before this module
// would otherwise be needed.
setTabNotifyHook(ensureTabNotificationPermission);
setTabPushRefreshHook(syncTabPushSubscriptions);
