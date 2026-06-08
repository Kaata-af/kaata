// apps/mobile/plugins/withNotifeeForegroundService.js
//
// Phase 6 — Expo config plugin: register Notifee's ForegroundService
// in AndroidManifest so the persistent "Kaata — Nearby sync active"
// notification can keep the BLE GATT server / scanner alive while the
// app is backgrounded.
//
// Why this exists:
//   @notifee/react-native does NOT ship an Expo config plugin (as of
//   v9.1.x). The library's native module provides the ForegroundService
//   class, but Expo's prebuild process needs an explicit <service> entry
//   inside the <application> block of AndroidManifest.xml — otherwise
//   notifee.displayNotification({ android: { asForegroundService: true } })
//   silently no-ops on Android 9+ and the service never binds, so the OS
//   kills the process on doze.
//
//   The native ForegroundService class is shipped by the notifee AAR; we
//   only need to declare it in the manifest.
//
// foregroundServiceType notes:
//   "dataSync"        — matches the FOREGROUND_SERVICE_DATA_SYNC permission
//                       already declared in app.json. Justifies anti-entropy
//                       event replication.
//   "connectedDevice" — matches the Phase 6 BLE primary transport. Justifies
//                       holding open GATT connections to nearby phones.
//   Combining the two with "|" is the Android-blessed way to declare a
//   service that does both. Required on Android 14+ (API 34+) or
//   Service.startForeground throws SecurityException.
//
// Pattern mirrors plugins/withNearbyWifiNeverForLocation.js — same
// withAndroidManifest helper, same modResults.manifest XML shape.

const { withAndroidManifest } = require("@expo/config-plugins");

const SERVICE_NAME = "app.notifee.core.ForegroundService";
const SERVICE_TYPE = "connectedDevice|dataSync";

module.exports = function withNotifeeForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults?.manifest;
    if (!manifest) return cfg;

    // The <application> element is always present in an Expo-managed
    // AndroidManifest. config-plugins parses it as a single-entry array:
    //   manifest.application = [{ $: {...}, service: [...], activity: [...], ... }]
    const applicationArr = manifest.application;
    if (!Array.isArray(applicationArr) || applicationArr.length === 0) {
      return cfg;
    }
    const application = applicationArr[0];

    // Ensure the <service> array exists. Some Expo modules (notifications,
    // task-manager) may have already added their own <service> entries —
    // we must append, not overwrite.
    if (!Array.isArray(application.service)) {
      application.service = [];
    }

    // Idempotency guard: if a previous prebuild already added this entry,
    // keep attributes in sync and skip. We key on android:name because
    // that's the unique identifier for service classes in AndroidManifest.
    const existing = application.service.find(
      (entry) => entry?.$ && entry.$["android:name"] === SERVICE_NAME,
    );
    if (existing) {
      existing.$["android:foregroundServiceType"] = SERVICE_TYPE;
      existing.$["android:exported"] = "false";
      return cfg;
    }

    application.service.push({
      $: {
        "android:name": SERVICE_NAME,
        "android:foregroundServiceType": SERVICE_TYPE,
        "android:exported": "false",
      },
    });

    return cfg;
  });
};
