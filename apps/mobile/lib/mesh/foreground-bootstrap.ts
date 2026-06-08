// apps/mobile/lib/mesh/foreground-bootstrap.ts
//
// D-FOREGROUND-HARDEN — Phase 7.1
//
// This module's ONLY job is to run notifee setup calls at JS-bundle load
// time, BEFORE any other code can call displayNotification with
// asForegroundService:true. It is imported as the very first import of
// app/_layout.tsx. Nothing else should import this file — re-importing is
// a no-op because ES modules are evaluated once.
//
// Why a dedicated module:
//   - notifee.registerForegroundService MUST execute before Android's
//     Context.startForegroundService(intent) is issued. If the callback
//     is missing when notifee's ForegroundService.onStartCommand runs,
//     the service has nothing to keep alive → it never calls
//     Service.startForeground(notification) → after 5s the OS aborts the
//     process with ForegroundServiceDidNotStartInTimeException.
//   - createChannel MUST resolve before any displayNotification using
//     that channel. On Android 8+, posting to a non-existent channel
//     silently drops the notification → same 5s crash as above.
//   - Both of these must survive the process being resurrected by Android
//     to host the foreground service (e.g. after a Doze kill where the
//     FGS intent is re-delivered). The cleanest way to guarantee that is
//     to have a leaf module with zero non-RN dependencies that's imported
//     at the top of the entry file.
//
// On non-Android (web, iOS, Expo Go without the native module) this
// module no-ops — mesh is Android-only as of Phase 6.

import { Platform } from "react-native";

export const SHOP_MODE_CHANNEL_ID = "shop-mode";

// Marker the rest of the app can import to assert bootstrap ran. Tests
// and adb logcat triage use this as a sanity check.
export const FOREGROUND_BOOTSTRAP_LOADED = true;

if (Platform.OS === "android") {
  try {
    // require, not import, so Metro doesn't try to resolve notifee when
    // bundling for web. Same pattern as foreground.ts::getNotifee.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifee = require("@notifee/react-native");

    // ─────────────────────────────────────────────────────────────────
    // 1. Register the foreground-service task FIRST.
    //
    // The callback returns a never-resolving Promise. While the Promise
    // is pending, notifee's native ForegroundService keeps the JS task
    // alive (which keeps the process at foreground priority). The
    // Promise resolves implicitly when we call
    // notifee.stopForegroundService() (or cancelDisplayedNotification on
    // the FGS notification), at which point notifee tears the task down
    // and Android demotes us back to background.
    //
    // Per notifee docs: this MUST be called at module top level, not
    // inside a React effect, because Android can deliver the FGS start
    // intent BEFORE the React tree mounts (e.g. process resurrection
    // after Doze).
    // ─────────────────────────────────────────────────────────────────
    notifee.default.registerForegroundService(
      // The notification arg is intentionally unused — we only need the
      // Promise to stay pending so the native service stays alive.
      (_notification: unknown) =>
        new Promise<void>(() => {
          // Never resolves. notifee tears the task down externally when
          // the FGS notification is cancelled via stopForegroundService.
        }),
    );

    // ─────────────────────────────────────────────────────────────────
    // 2. Ensure the notification channel exists.
    //
    // createChannel is idempotent on (channelId). Calling on every boot
    // is cheap and guarantees the channel exists by the time the first
    // displayNotification({channelId: SHOP_MODE_CHANNEL_ID}) fires.
    //
    // importance: LOW so the notification is silent + no heads-up. The
    // user sees it in the shade and can mute it via Settings → Apps →
    // Kaata → Notifications → "Nearby sync". Channel name uses the same
    // BLE-primary "Nearby sync" wording the in-app UI uses.
    //
    // Fire-and-forget: notifee's createChannel returns a Promise. We
    // intentionally don't await it (top-level await isn't enabled in
    // the Hermes bundle and we don't want to block the boot path); we
    // just attach a .catch so a rejection doesn't bubble as an
    // unhandled-promise warning. The await inside
    // startShopModeForegroundService in foreground.ts serves as the
    // actual sync point.
    // ─────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────
    // 3. Register the background-event handler at module top level.
    //
    // notifee requires onBackgroundEvent be registered at module load
    // for cold-start notification taps to deliver. The handler is a
    // no-op today — cold-start routing is handled by
    // getInitialShopModeNotification (foreground.ts) reading
    // notifee.getInitialNotification() from inside the React tree once
    // it mounts. We register the handler purely to satisfy notifee's
    // contract and silence the dev-time warning.
    // ─────────────────────────────────────────────────────────────────
    notifee.default.onBackgroundEvent(async () => {
      // Intentional no-op. Cold-start routing happens via
      // getInitialShopModeNotification inside _layout.tsx.
    });
  } catch (err) {
    // notifee not bundled (Expo Go) — degrade gracefully. Shop mode
    // still "works" but Doze will kill BLE within minutes of
    // backgrounding. Production APK always has notifee, so this branch
    // only fires in Expo Go.
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn("[foreground-bootstrap] notifee not available", err);
    }
  }
}
