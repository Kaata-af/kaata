// apps/mobile/lib/mesh/foreground.ts
//
// Foreground-service facade for the rest of the codebase (mesh/index.ts,
// MeshController, _layout.tsx). The FGS itself is now a NATIVE START_STICKY
// service (modules/kaata-bt-classic KaataForegroundService) — the Briar model —
// so the "Nearby sync" notification + process survive app close / MIUI process
// death. notifee is kept ONLY for the notification channel + the Android 13+
// POST_NOTIFICATIONS prompt + cold-start tap inspection; it no longer owns the
// foreground service (its JS-callback-bound FGS was the thing that vanished on
// close and tripped the 5s ForegroundServiceDidNotStartInTime crash on restart).
//
// On non-Android platforms (web, iOS for now) every export is a no-op —
// mesh is Android-only in Phase 6.
//
// FGS TYPE DECLARATION (Android 14+):
//   - The native service is declared with `connectedDevice|dataSync` in the
//     kaata-bt-classic module manifest, and KaataForegroundService passes the
//     matching bitmask to startForeground (or it throws on API 34+). Both:
//       CONNECTED_DEVICE — holding open RFCOMM links to nearby phones
//       DATA_SYNC        — anti-entropy event replication
//   - app.json declares both FOREGROUND_SERVICE_CONNECTED_DEVICE and
//     FOREGROUND_SERVICE_DATA_SYNC runtime permissions.

import { Platform } from "react-native";

export const SHOP_MODE_CHANNEL_ID = "shop-mode";
export const SHOP_MODE_NOTIFICATION_ID = "shop-mode-fg";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotifeeModule = any;

let notifeeModule: NotifeeModule | null = null;
let notifeeLoadAttempted = false;

function getNotifee(): NotifeeModule | null {
  if (Platform.OS !== "android") return null;
  if (notifeeLoadAttempted) return notifeeModule;
  notifeeLoadAttempted = true;
  try {
    // require() — not import() — so Metro doesn't try to resolve on web.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notifeeModule = require("@notifee/react-native");
    return notifeeModule;
  } catch (err) {
    // Notifee not installed (e.g. running in Expo Go) — degrade gracefully.
    // Shop Mode still "works" but will be killed by Doze within minutes of
    // backgrounding.
    if (__DEV__) {
      console.warn("[mesh/foreground] notifee not available:", err);
    }
    return null;
  }
}

/**
 * Create the persistent low-importance notification channel.
 * Must be called once at app startup (idempotent — channel ID is the key).
 * Low importance = silent + no heads-up, but the notification IS visible
 * in the shade and the service stays foreground.
 *
 * Channel name uses the BLE-primary "Nearby sync" wording so a shopkeeper
 * navigating Settings → Apps → Kaata → Notifications can find / mute
 * what they actually see in the app UI.
 */
export async function ensureShopModeChannel(): Promise<void> {
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    // Lazy import keeps this module a leaf for foreground-bootstrap's
    // module-load registration (no static i18n → db chain). The bootstrap
    // call runs before the locale pref loads (English); _layout's later
    // ensureShopModeChannel() call re-applies with the loaded locale —
    // notifee createChannel updates the existing channel's name in place.
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

// NOTE: there is intentionally NO `registerShopModeForegroundTask` here.
//
// Foreground-service task registration is owned by
// `lib/mesh/foreground-bootstrap.ts`, which runs `registerForegroundService`
// at JS-module load time — BEFORE the React tree mounts and before any
// component can issue `Context.startForegroundService`. Notifee documents
// that the callback MUST be registered once at module top level; calling
// `registerForegroundService` again from inside a React effect (or
// anywhere else) would replace notifee's already-pending JS promise with
// a fresh one, breaking the contract that keeps the FGS alive.
//
// Engineering critique (foreground.ts dead-code removal): a previous
// version of this file exported `registerShopModeForegroundTask` for use
// from `_layout.tsx`'s init effect. After moving the registration to
// `foreground-bootstrap.ts`, the function became unused — but leaving it
// exported was a foot-gun: a future contributor reading both files might
// have called it from a useEffect, re-running registration after notifee
// already had a live FGS callback. Removed entirely so the only path is
// via the bootstrap module.

export type ShopModeNotificationOpts = {
  title?: string;
  body?: string;
};

/**
 * Promote the JS process to a foreground service with a persistent
 * notification. Returns true if the foreground service was actually
 * started; false on web / iOS / Expo Go.
 *
 * Android 13+ requires POST_NOTIFICATIONS at runtime; we request it on
 * the first start so the tray notification actually appears. Android 14+
 * also requires the FGS to declare a foregroundServiceType — we pass
 * `connectedDevice|dataSync` to match the manifest entry (BLE GATT
 * holds = connectedDevice; anti-entropy = dataSync).
 */
export async function startShopModeForegroundService(
  opts?: ShopModeNotificationOpts,
): Promise<boolean> {
  if (Platform.OS !== "android") return false;

  // Apply the localized channel name (notifee path). The native service also
  // creates the channel as a no-JS fallback, but this seeds the user's
  // language. Idempotent — safe to call on every start / cold-start auto-resume.
  await ensureShopModeChannel();

  // Android 13+ POST_NOTIFICATIONS so the tray notification is actually
  // visible. The foreground service runs without it, but the notification
  // would be hidden. notifee.requestPermission is idempotent.
  try {
    const notifee = getNotifee();
    if (notifee) await notifee.default.requestPermission();
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] requestPermission failed", err);
  }

  // Hand off to the NATIVE START_STICKY service (modules/kaata-bt-classic).
  // Title/body are the controlled-trust copy (only pre-paired phones sync);
  // channelName/Desc seed the native channel for the no-JS sticky-restart case.
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
 * Update the foreground-service notification's title/body in-place.
 * Notifee re-emits with the same notification id, which Android treats
 * as an update (no extra tray entry, no sound).
 *
 * Used by MeshController as it observes status changes:
 *   - 0 peers           → "Looking for nearby phones…"
 *   - 1 peer            → "Connected to {name}'s phone"
 *   - 2+ peers          → "Connected to {n} phones"
 *   - idle after activity → "Last synced {rel}"
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
 * Cancel the foreground-service notification, which lets Android demote
 * the process back to "background" priority. Idempotent.
 */
export async function stopShopModeForegroundService(): Promise<void> {
  if (Platform.OS !== "android") return;
  // Native stopService -> onDestroy removes the notification. This also drops
  // the old notifee.stopForegroundService() call, which itself was a MIUI crash
  // vector (it spawned a HeadlessJS task the OS misread as an FGS start).
  try {
    const bt = await import("../../modules/kaata-bt-classic");
    await bt.stopMeshForegroundService();
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] stopShopModeForegroundService failed", err);
  }
}

/**
 * Cold-start helper: if the app was launched by tapping our notification,
 * notifee.getInitialNotification() resolves with the notification + the
 * pressAction. Caller uses this to deep-link to `?menu=sync` on first
 * frame, since onForegroundEvent only fires after JS engine init.
 *
 * Returns null when not a notification-tap launch or on non-Android.
 */
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
