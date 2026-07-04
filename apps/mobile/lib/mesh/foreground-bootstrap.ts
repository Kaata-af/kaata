// apps/mobile/lib/mesh/foreground-bootstrap.ts
//
// Runs notifee setup (create the "Nearby sync" notification channel + register
// the background-event handler) at JS-bundle-load time, before any code can
// post the foreground-service notification. Imported second by app/_layout.tsx
// so the registration survives process resurrection by Android (e.g. when the
// FGS start intent is re-delivered after a Doze kill before the React tree
// mounts).
//
// REVIVED 2026-07-04 (was parked with the rest of Nearby sync). The body below
// is the exact pre-park implementation restored from the PARKED block.

import { Platform } from "react-native";

import { IS_EXPO_GO } from "../expo-go";

// Marker the rest of the app can import to assert bootstrap ran. Tests
// and adb logcat triage use this as a sanity check.
export const FOREGROUND_BOOTSTRAP_LOADED = true;

export const SHOP_MODE_CHANNEL_ID = "shop-mode";

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
      .catch((err: unknown) => {
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
