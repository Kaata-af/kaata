// apps/mobile/lib/mesh/foreground.ts
//
// Foreground-service facade for the "Nearby sync" mesh notification.
//
// REVIVED 2026-07-04 (was parked 2026-06-24 → 2026-07-04 behind MESH_PARKED).
// The bodies below are the exact pre-park implementations — they were
// preserved verbatim in PARKED comment blocks and restored unchanged, because
// this was the hard-won combination that actually worked on-device.
//
// History that must not regress: updateShopModeNotification was the leak
// behind "the notification is always up" — the native
// updateMeshForegroundService issues startService(ACTION_START), which used to
// CREATE the service (posting the notification + arming the 15-min revival
// alarm) when it wasn't already running, and stopShopMode()'s status emit
// fired it on every launch. The real fix is native and survives here:
// KaataForegroundService tracks isForeground (true only after a successful
// startForeground) and updateMeshForegroundService no-ops unless isForeground
// — an in-place UPDATE can never START the service. Keep that guard.
//
//   • startShopModeForegroundService — promotes the app to a foreground service
//     and posts the notification (via the native KaataForegroundService).
//   • updateShopModeNotification     — updates the notification body as the
//     peer count changes (native no-op unless the FGS is foregrounded).
//   • ensureShopModeChannel          — creates the notifee notification channel.
//   • getInitialShopModeNotification — inspects a cold-start notification tap.
//   • stopShopModeForegroundService  — tears down the native FGS (clears its
//     run-flag + cancels the revival alarm). Also used by the solo-build boot
//     teardown in _layout.tsx, so it must keep working with the FGS stopped.
//
// On non-Android platforms every export is a no-op.

import { Platform } from "react-native";

import { MESH_PARKED } from "../../constants/env";
import { IS_EXPO_GO } from "../expo-go";

export const SHOP_MODE_CHANNEL_ID = "shop-mode";
export const SHOP_MODE_NOTIFICATION_ID = "shop-mode-fg";

export type ShopModeNotificationOpts = {
  title?: string;
  body?: string;
};

/** Create the low-importance "Nearby sync" notifee channel (idempotent). */
export async function ensureShopModeChannel(): Promise<void> {
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
}

/** Promote to a foreground service + post the notification. */
export async function startShopModeForegroundService(
  opts?: ShopModeNotificationOpts,
): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  // SINGLE FGS-start choke point (pre-park invariant, restored on the 2026-07
  // revive). Every path that starts the service flows through here — mesh
  // startShopMode, the home-screen direct toggle, the pair/pair-scan join
  // flows, cold-start auto-resume. If Nearby sync is ever re-parked
  // (MESH_PARKED=true), no-oping here guarantees the "Nearby sync" notification
  // cannot appear no matter what calls startShopMode: the native service never
  // starts, so KEY_FGS_SHOULD_RUN is never set and its 15-min revival alarm
  // never arms. No-op while MESH_PARKED=false.
  if (MESH_PARKED) return false;
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
}

/**
 * Update the notification body (peer count changes). Safe while the FGS is
 * not running: the native side no-ops unless KaataForegroundService actually
 * entered the foreground (the 435cfed isForeground guard) — an UPDATE can
 * never CREATE the service.
 */
export async function updateShopModeNotification(opts: ShopModeNotificationOpts): Promise<void> {
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
}

/**
 * Tear down the native foreground service: clears its run-flag and cancels
 * the Doze-exempt revival alarm. Used both by normal stopShopMode teardown
 * and by the solo-build boot teardown (kills a leftover FGS from an upgrade).
 * Never posts anything. Idempotent; no-op off Android.
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

/** Inspect a cold-start notification tap (app launched via the FGS notification). */
export async function getInitialShopModeNotification(): Promise<{
  pressActionId: string | null;
} | null> {
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
}

// notifee module resolver. notifee's native module is NOT present in Expo Go —
// require() there re-triggers a LogBox red error, so the IS_EXPO_GO gate is
// load-bearing (see git 9911413).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotifeeModule = any;
let notifeeModule: NotifeeModule | null = null;
let notifeeLoadAttempted = false;
function getNotifee(): NotifeeModule | null {
  if (Platform.OS !== "android") return null;
  if (IS_EXPO_GO) return null;
  if (notifeeLoadAttempted) return notifeeModule;
  notifeeLoadAttempted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notifeeModule = require("@notifee/react-native");
    return notifeeModule;
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] notifee not available:", err);
    return null;
  }
}
