// apps/mobile/lib/mesh/foreground-bootstrap.ts
//
// ⚠️  PARKED. This module's job was to run notifee setup (create the "Nearby
// sync" notification channel + register the background-event handler) at JS-
// bundle-load time, before any code could post the foreground-service
// notification. The mesh / Nearby-sync subsystem is parked, so it now does
// nothing — which also stops it from creating the empty "Nearby sync" channel
// that showed up (with no notifications under it) in Android Settings → Apps →
// Kaata → Notifications. The original setup is preserved in the `PARKED` block
// below; restore it (and the rest of the notification code — see
// lib/mesh/foreground.ts) to revive.
//
// Still imported first by app/_layout.tsx so the revive path keeps its
// load-order guarantee; as a no-op the import is harmless.

// Marker the rest of the app can import to assert bootstrap ran. Tests
// and adb logcat triage use this as a sanity check.
export const FOREGROUND_BOOTSTRAP_LOADED = true;

export const SHOP_MODE_CHANNEL_ID = "shop-mode";

/* PARKED — uncomment to revive. Also re-add the imports:
     import { Platform } from "react-native";
     import { IS_EXPO_GO } from "../expo-go";

   ⚠️  DO NOT restore this as-is. @notifee/react-native was REMOVED from the
   project: upstream archived it in April 2026 (9.1.8 is the last release that
   will ever exist) and it is a legacy-bridge module whose Android headless path
   throws under React Native 0.83 / Expo SDK 55. Rewrite against
   expo-notifications — see lib/mesh/bg-notify.ts for the channel + immediate
   notification pattern. Note that expo-notifications has no direct equivalent
   of an `asForegroundService` notification; a revived foreground service should
   post its notification from the native module instead.

if (Platform.OS === "android" && !IS_EXPO_GO) {
  try {
    // require, not import, so Metro doesn't try to resolve notifee for web.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require("@notifee/react-native");

    // Ensure the channel exists (idempotent on channelId). importance: LOW so
    // the notification is silent + no heads-up. Fire-and-forget — the await in
    // startShopModeForegroundService is the real sync point.
    notifee.default
      .createChannel({
        id: SHOP_MODE_CHANNEL_ID,
        name: "Nearby sync",
        importance: notifee.AndroidImportance.LOW,
        description: "Shown while Kaata is syncing with nearby phones over Bluetooth.",
        vibration: false,
        sound: undefined,
      })
      .catch((err) => {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn("[foreground-bootstrap] createChannel failed", err);
        }
      });

    // notifee requires onBackgroundEvent be registered at module load for
    // cold-start notification taps to deliver. No-op handler — cold-start
    // routing happens via getInitialShopModeNotification in _layout.tsx.
    notifee.default.onBackgroundEvent(async () => {});

    // !!! DO NOT call notifee.stopForegroundService() here — it crashes the app
    // on Xiaomi/MIUI (it dispatches a HeadlessJS task the OS misreads as an FGS
    // start that never calls startForeground → 5s force-kill). See git history.
  } catch (err) {
    // notifee not bundled (Expo Go) — degrade gracefully.
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn("[foreground-bootstrap] notifee not available", err);
    }
  }
}
*/
