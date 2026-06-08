// apps/mobile/plugins/withNearbyWifiNeverForLocation.js
//
// Expo config plugin: add `android:usesPermissionFlags="neverForLocation"`
// to permission entries that Android 12+/13+ would otherwise treat as
// location-deriving.
//
// Permissions patched:
//   - NEARBY_WIFI_DEVICES (Android 13+) — for mDNS browse (Phase 5.1).
//   - BLUETOOTH_SCAN (Android 12+)      — for BLE peer discovery (Phase 6).
//
// Without `neverForLocation`:
//   - The OS treats BLE/Wi-Fi peers as a location-derivation signal and
//     ALSO requires ACCESS_FINE_LOCATION at runtime — a terrible UX
//     ("Kaata wants your location?!") for a ledger app.
//   - Google Play scanners flag the app as collecting physical location.
//
// expo's `android.permissions` array in app.json can't express XML
// attributes, hence this plugin.

const { withAndroidManifest } = require("@expo/config-plugins");

const PERMISSIONS_NEVER_FOR_LOCATION = [
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.BLUETOOTH_SCAN",
];

module.exports = function withNearbyWifiNeverForLocation(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults?.manifest;
    if (!manifest) return cfg;
    // The manifest array shape from @expo/config-plugins is:
    //   manifest["uses-permission"] = [{ $: { "android:name": "..." } }, ...]
    const permList = manifest["uses-permission"];
    if (!Array.isArray(permList)) return cfg;
    for (const entry of permList) {
      const name = entry?.$?.["android:name"];
      if (PERMISSIONS_NEVER_FOR_LOCATION.includes(name)) {
        entry.$["android:usesPermissionFlags"] = "neverForLocation";
      }
    }
    return cfg;
  });
};
