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

const SERVICE_NAME = "expo.modules.kaatabtclassic.KaataForegroundService";
const SERVICE_TYPE = "connectedDevice";
const STOP_WITH_TASK = "false";

module.exports = function withKaataForegroundService(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults?.manifest?.application?.[0];
    if (!application) return cfg;

    if (!Array.isArray(application.service)) {
      application.service = [];
    }

    // Idempotency: keep attributes in sync if a previous prebuild added it.
    const existing = application.service.find(
      (entry) => entry?.$ && entry.$["android:name"] === SERVICE_NAME,
    );
    if (existing) {
      existing.$["android:foregroundServiceType"] = SERVICE_TYPE;
      existing.$["android:exported"] = "false";
      existing.$["android:stopWithTask"] = STOP_WITH_TASK;
      return cfg;
    }

    application.service.push({
      $: {
        "android:name": SERVICE_NAME,
        "android:foregroundServiceType": SERVICE_TYPE,
        "android:exported": "false",
        "android:stopWithTask": STOP_WITH_TASK,
      },
    });

    return cfg;
  });
};
