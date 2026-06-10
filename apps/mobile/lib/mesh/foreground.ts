// apps/mobile/lib/mesh/foreground.ts
//
// Wraps @notifee/react-native foreground-service primitives so the rest
// of the codebase (mesh/index.ts, _layout.tsx) doesn't have a hard dep on
// the native module. Keeps unit tests + web compile alive when notifee
// isn't installed.
//
// On non-Android platforms (web, iOS for now) every export is a no-op —
// mesh is Android-only in Phase 6.
//
// FGS TYPE DECLARATION (Android 14+):
//   - Manifest declares `connectedDevice|dataSync` (see plugins/
//     withNotifeeForegroundService.js).
//   - JS-side displayNotification passes the matching bitmask so
//     Service.startForeground doesn't throw
//     MissingForegroundServiceTypeException. Both types are required:
//       CONNECTED_DEVICE — justifies holding open the BLE GATT link
//       DATA_SYNC        — justifies anti-entropy event replication
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
 * Resolve the FGS types bitmask. notifee exposes
 * `AndroidForegroundServiceType` as an enum-style object — we read the
 * symbolic constants when available and fall back to the documented
 * numeric values for older notifee versions where the constants weren't
 * exported.
 *   DATA_SYNC = 1
 *   CONNECTED_DEVICE = 16
 */
function fgsTypes(notifee: NotifeeModule): number[] {
  const t = notifee?.AndroidForegroundServiceType ?? {};
  return [t.DATA_SYNC ?? 1, t.CONNECTED_DEVICE ?? 16];
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
    await notifee.default.createChannel({
      id: SHOP_MODE_CHANNEL_ID,
      name: "Nearby sync",
      importance: notifee.AndroidImportance.LOW,
      description: "Shown while Kaata is syncing with nearby phones over Bluetooth.",
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
  const notifee = getNotifee();
  if (!notifee) return false;

  // D-FOREGROUND-CRASH: GUARANTEE the channel exists before we ever ask
  // Android to spawn the foreground service. ensureShopModeChannel is also
  // called at boot from _layout.tsx, but cold-start auto-resume can fire
  // startShopMode before that init effect finishes. createChannel is
  // idempotent on the channelId, so calling twice is free.
  await ensureShopModeChannel();

  // Android 13+ permission ask. notifee.requestPermission is idempotent —
  // returns immediately if already granted/denied.
  try {
    await notifee.default.requestPermission();
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] requestPermission failed", err);
  }
  try {
    await notifee.default.displayNotification({
      id: SHOP_MODE_NOTIFICATION_ID,
      // Privacy-aware framing: the copy must NOT imply broadcast to
      // anyone nearby (the user explicitly rejected "Sharing your kaata
      // nearby" — they pointed out a neighbour shop's phone could
      // misread that as "Kaata is leaking my ledger to anything in
      // range"). The TRUTH is: only phones you've pre-paired via QR
      // can sync. The copy should reflect that controlled-trust model.
      // "Connecting with your paired phones" makes the trust boundary
      // explicit. Body during search frames it as a private session
      // ("Waiting for your team to connect…") rather than open discovery.
      title: opts?.title ?? "Connecting with your paired phones",
      body: opts?.body ?? "Waiting for your team to connect…",
      android: {
        channelId: SHOP_MODE_CHANNEL_ID,
        // D-FOREGROUND-HARDEN: REQUIRED for the foreground-service
        // Notification to build. Without a valid drawable resolvable via
        // getResources().getIdentifier(name, "drawable", pkg), Service
        // .startForeground() is never called and Android force-kills us
        // after 5s with ForegroundServiceDidNotStartInTimeException.
        // "notification_icon" is generated by the expo-notifications
        // plugin's "icon" config (app.json) and lives in res/drawable-*/.
        // Previously "ic_launcher" was used here — but ic_launcher is in
        // res/mipmap-*/, NOT res/drawable*/, so notifee's lookup returned
        // 0 (resource not found) → invalid notification → 5s crash.
        smallIcon: "notification_icon",
        asForegroundService: true,
        foregroundServiceTypes: fgsTypes(notifee),
        ongoing: true,
        importance: notifee.AndroidImportance.LOW,
        // Tapping the notification opens the app via the default
        // launchActivity; the kaata:// deep-link routing is handled by
        // the onForegroundEvent listener registered in _layout.tsx, and
        // cold-start by the getInitialNotification handler.
        pressAction: {
          id: "open-shop-mode-settings",
          launchActivity: "default",
        },
        visibility: notifee.AndroidVisibility.SECRET,
        showTimestamp: false,
      },
    });
    return true;
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
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    await notifee.default.displayNotification({
      id: SHOP_MODE_NOTIFICATION_ID,
      title: opts.title ?? "Connecting with your paired phones",
      body: opts.body ?? "Waiting for your team to connect…",
      android: {
        channelId: SHOP_MODE_CHANNEL_ID,
        // D-FOREGROUND-HARDEN: same smallIcon contract as start — the
        // "update" path re-emits with asForegroundService:true so Android
        // treats the new notification as the service's foreground
        // notification. A missing smallIcon here crashes the same way.
        smallIcon: "notification_icon",
        asForegroundService: true,
        foregroundServiceTypes: fgsTypes(notifee),
        ongoing: true,
        importance: notifee.AndroidImportance.LOW,
        pressAction: {
          id: "open-shop-mode-settings",
          launchActivity: "default",
        },
        visibility: notifee.AndroidVisibility.SECRET,
        showTimestamp: false,
      },
    });
  } catch (err) {
    if (__DEV__) console.warn("[mesh/foreground] updateShopModeNotification failed", err);
  }
}

/**
 * Cancel the foreground-service notification, which lets Android demote
 * the process back to "background" priority. Idempotent.
 */
export async function stopShopModeForegroundService(): Promise<void> {
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    await notifee.default.stopForegroundService();
  } catch {
    // Already stopped — ignore.
  }
  try {
    await notifee.default.cancelDisplayedNotification(SHOP_MODE_NOTIFICATION_ID);
  } catch {
    // Already cancelled — ignore.
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
