// apps/mobile/plugins/withKaataForegroundService.js
//
// Declare the NATIVE foreground service (modules/kaata-bt-classic
// KaataForegroundService) in the APP manifest, so the persistent "Nearby sync"
// notification survives swipe-away the way Briar's BriarService does.
//
// WHY A CONFIG PLUGIN (not just the module's own AndroidManifest):
//   The Kotlin class lives in the kaata-bt-classic local module, whose manifest
//   only merges into the app manifest at GRADLE BUILD time. That merge is
//   invisible to a plain `expo prebuild` + easy to miss with a stale android/
//   dir (exactly the bug that shipped the old notifee FGS instead). Declaring
//   the service HERE puts it directly in the prebuild's app manifest, which is
//   verifiable (`grep KaataForegroundService android/app/src/main/AndroidManifest.xml`)
//   and present in every build regardless of module-merge timing. The class is
//   on the app classpath via the autolinked module, so the app manifest can
//   reference it by fully-qualified name.
//
// foregroundServiceType=connectedDevice ONLY (matches
// KaataForegroundService.startForegroundSafely): we hold RFCOMM links to nearby
// phones. We intentionally avoid dataSync — on Android 14+ a dataSync FGS is
// capped at ~6h/day and auto-stopped, which would silently kill always-on sync.
// This mirrors Briar (connectedDevice only). stopWithTask="false" => the service
// is not torn down when the user swipes the app from recents.

const { withAndroidManifest } = require("@expo/config-plugins");

const FGS_NAME = "expo.modules.kaatabtclassic.KaataForegroundService";
// #43 P2: the killed-app HeadlessJS mesh runner. Declared as a PLAIN background
// <service> with NO android:foregroundServiceType — this is the load-bearing
// MIUI-safety point: MIUI 5s-crashed this app once by treating a startService to
// an FGS-shaped service as an FGS start that never called startForeground. This
// service NEVER calls startForeground (the existing connectedDevice FGS owns
// foreground); not declaring a type keeps the OS from expecting one.
const HEADLESS_NAME = "expo.modules.kaatabtclassic.KaataMeshHeadlessService";
// Briar-parity P1b: the Doze-exempt revival alarm receiver. Fires ~15min while
// Nearby sync is on; if the process was hard-killed it revives the FGS (the alarm
// delivery grants a temporary background-FGS-start allowlist). NOT exported — only
// our own AlarmManager PendingIntent targets it.
const ALARM_RECEIVER_NAME = "expo.modules.kaatabtclassic.KaataMeshAlarmReceiver";

// Each entry's attrs are upserted (idempotent across prebuilds).
const SERVICES = [
  {
    "android:name": FGS_NAME,
    "android:foregroundServiceType": "connectedDevice",
    "android:exported": "false",
    "android:stopWithTask": "false",
  },
  {
    "android:name": HEADLESS_NAME,
    // NO foregroundServiceType (see comment above).
    "android:exported": "false",
    "android:stopWithTask": "false",
  },
];

const RECEIVERS = [
  {
    "android:name": ALARM_RECEIVER_NAME,
    "android:exported": "false",
  },
];

module.exports = function withKaataForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults?.manifest?.application?.[0];
    if (!application) return cfg;
    if (!Array.isArray(application.service)) application.service = [];

    for (const attrs of SERVICES) {
      const existing = application.service.find(
        (entry) => entry?.$ && entry.$["android:name"] === attrs["android:name"],
      );
      if (existing) {
        // Reset attrs to match (and DROP any stale foregroundServiceType on the
        // headless one if a prior version set it).
        existing.$ = { ...attrs };
      } else {
        application.service.push({ $: { ...attrs } });
      }
    }

    if (!Array.isArray(application.receiver)) application.receiver = [];
    for (const attrs of RECEIVERS) {
      const existing = application.receiver.find(
        (entry) => entry?.$ && entry.$["android:name"] === attrs["android:name"],
      );
      if (existing) {
        existing.$ = { ...attrs };
      } else {
        application.receiver.push({ $: { ...attrs } });
      }
    }

    return cfg;
  });
};
