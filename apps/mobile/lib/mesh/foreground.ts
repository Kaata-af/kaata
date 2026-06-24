// apps/mobile/lib/mesh/foreground.ts
//
// Foreground-service facade for the "Nearby sync" mesh notification.
//
// ⚠️  PARKED — the mesh / Nearby-sync subsystem is parked, so this module no
// longer posts the persistent "Nearby sync is on" foreground-service
// notification. The functions that did the work are kept as no-op stubs with
// their real implementations preserved verbatim in the `PARKED — uncomment to
// revive` blocks, so reviving the feature is a local uncomment, not a git dig:
//
//   • startShopModeForegroundService — promoted the app to a foreground service
//     and posted the notification (via the native KaataForegroundService).
//   • updateShopModeNotification     — updated the notification body as the peer
//     count changed. THIS was the leak behind "the notification is always up":
//     the native updateMeshForegroundService issues startService(ACTION_START),
//     which CREATES the service (posting the notification + arming the revival
//     alarm) when it isn't already running — and stopShopMode()'s status emit
//     fired it on every launch.
//   • ensureShopModeChannel          — created the notifee notification channel.
//   • getInitialShopModeNotification — inspected a cold-start notification tap.
//
// To revive: restore those bodies + getNotifee below, and re-enable the call
// sites (foreground-bootstrap.ts createChannel, _layout.tsx's channel +
// notification-tap handlers, MeshController's status-driven update). The native
// KaataForegroundService (modules/kaata-bt-classic) is untouched + revive-ready.
//
// stopShopModeForegroundService stays LIVE: it only TEARS DOWN a leftover native
// FGS (clears its run-flag + cancels the revival alarm) — that's what kills any
// notification still running on a device upgrading from a pre-park build. It
// never posts anything.
//
// On non-Android platforms every export is a no-op.

import { Platform } from "react-native";

export const SHOP_MODE_CHANNEL_ID = "shop-mode";
export const SHOP_MODE_NOTIFICATION_ID = "shop-mode-fg";

export type ShopModeNotificationOpts = {
  title?: string;
  body?: string;
};

/** PARKED no-op (was: create the low-importance "Nearby sync" notifee channel). */
export async function ensureShopModeChannel(): Promise<void> {
  /* PARKED — uncomment to revive (also un-park getNotifee at the bottom)
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    const { t } = await import("../i18n");
    await notifee.default.createChannel({
      id: SHOP_MODE_CHANNEL_ID,
      name: t("fgs.channelName"),
      importance: notifee.AndroidImportance.LOW,
      description: t("fgs.channelDescription"),
      vibration: false,
      sound: undefined,
    });
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] ensureShopModeChannel failed", err);
  }
  */
}

/** PARKED no-op (was: promote to a foreground service + post the notification). */
export async function startShopModeForegroundService(
  opts?: ShopModeNotificationOpts,
): Promise<boolean> {
  void opts; // PARKED — see revive block
  return false;
  /* PARKED — uncomment to revive
  if (Platform.OS !== "android") return false;
  await ensureShopModeChannel();
  // Android 13+ POST_NOTIFICATIONS so the tray notification is actually visible.
  try {
    const notifee = getNotifee();
    if (notifee) await notifee.default.requestPermission();
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] requestPermission failed", err);
  }
  // Hand off to the NATIVE START_STICKY service (modules/kaata-bt-classic).
  try {
    const { t } = await import("../i18n");
    const bt = await import("../../modules/kaata-bt-classic");
    return await bt.startMeshForegroundService(
      opts?.title ?? t("fgs.title"),
      opts?.body ?? t("fgs.waiting"),
      t("fgs.channelName"),
      t("fgs.channelDescription"),
    );
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] startShopModeForegroundService failed", err);
    return false;
  }
  */
}

/** PARKED no-op (was: update the notification body — the leak; see header). */
export async function updateShopModeNotification(opts: ShopModeNotificationOpts): Promise<void> {
  void opts; // PARKED — see revive block
  /* PARKED — uncomment to revive
  if (Platform.OS !== "android") return;
  try {
    const { t } = await import("../i18n");
    const bt = await import("../../modules/kaata-bt-classic");
    await bt.updateMeshForegroundService(
      opts.title ?? t("fgs.title"),
      opts.body ?? t("fgs.waiting"),
    );
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] updateShopModeNotification failed", err);
  }
  */
}

/**
 * LIVE. Tear down a leftover native foreground service: clears its run-flag and
 * cancels the Doze-exempt revival alarm so a notification left running by a
 * pre-park build dies on first launch and can't resurrect. Never posts anything.
 * Idempotent; no-op off Android.
 */
export async function stopShopModeForegroundService(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const bt = await import("../../modules/kaata-bt-classic");
    await bt.stopMeshForegroundService();
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] stopShopModeForegroundService failed", err);
  }
}

/** PARKED no-op (was: inspect a cold-start notification tap). */
export async function getInitialShopModeNotification(): Promise<{
  pressActionId: string | null;
} | null> {
  return null;
  /* PARKED — uncomment to revive (also un-park getNotifee below)
  const notifee = getNotifee();
  if (!notifee) return null;
  try {
    const init = await notifee.default.getInitialNotification();
    if (!init) return null;
    if (init.notification?.id !== SHOP_MODE_NOTIFICATION_ID) return null;
    return {
      pressActionId: init.pressAction?.id ?? init.notification?.android?.pressAction?.id ?? null,
    };
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] getInitialNotification failed", err);
    return null;
  }
  */
}

/* PARKED — uncomment to revive: the notifee module resolver used by the parked
   functions above. Also re-add `import { IS_EXPO_GO } from "../expo-go";`.

type NotifeeModule = any;
let notifeeModule: NotifeeModule | null = null;
let notifeeLoadAttempted = false;
function getNotifee(): NotifeeModule | null {
  if (Platform.OS !== "android") return null;
  if (IS_EXPO_GO) return null;
  if (notifeeLoadAttempted) return notifeeModule;
  notifeeLoadAttempted = true;
  try {
    notifeeModule = require("@notifee/react-native");
    return notifeeModule;
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] notifee not available:", err);
    return null;
  }
}
*/
