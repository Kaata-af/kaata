// apps/mobile/plugins/withBleAdvertiser.js
//
// Expo config plugin for react-native-ble-advertiser. The library is archived
// upstream (last release 2022-09-27) and ships with two known incompatibilities
// with Expo SDK 54 / AGP 8.x that this plugin patches at prebuild time:
//
//   1. AGP 8.x REMOVED support for the legacy `package="…"` attribute on
//      <manifest> and REQUIRES an `android.namespace` field in build.gradle.
//      The library's android/build.gradle is missing both. Without patching
//      we get `AAPT: error: namespace not specified` on every EAS build.
//      Fix: inject `namespace 'com.vitorpamplona.bleadvertiser'` into the
//      `android { … }` block of the library's build.gradle, AND remove the
//      `package="…"` attribute from its AndroidManifest.xml (the namespace
//      replaces it; leaving both produces an AAPT2 error on AGP 8).
//
//   2. The library's AndroidManifest declares ACCESS_FINE_LOCATION and
//      ACCESS_COARSE_LOCATION (legacy BLE requirement, pre-Android 12).
//      Android's manifest merger pulls these into the final APK, which
//      silently undoes our BLUETOOTH_SCAN-with-neverForLocation strategy
//      (withNearbyWifiNeverForLocation.js). The user would see a "Kaata
//      wants your location" runtime prompt on Android 11 and below, and
//      Play scanners would flag the app as collecting physical location.
//      Fix: inject xmlns:tools + `tools:node="remove"` entries for both
//      permissions so the merger explicitly drops them. The library does
//      NOT need location at runtime — Kaata targets Android 12+ where
//      BLUETOOTH_SCAN + neverForLocation replaces ACCESS_FINE_LOCATION
//      for BLE scanning entirely.
//
// We ALSO declare BLUETOOTH_ADVERTISE in the main app manifest (the perm
// Android 12+ requires for LE peripheral mode) — belt-and-suspenders since
// app.json's android.permissions array already lists it.
//
// !!! KNOWN GAP — GATT server !!!
// react-native-ble-advertiser ONLY exposes BluetoothLeAdvertiser. There is
// no BluetoothGattServer wrapped by the library. That means the peripheral
// side advertises but has no characteristic to receive central writes on.
// See PERIPHERAL_GATT_SERVER_TODO in transport-ble.ts — v0.5.3 will ship
// a small Expo Module (Kotlin) wrapping both APIs and let us delete this
// plugin entirely. Until then BLE_TRANSPORT_PRODUCTION_READY = false.

const fs = require("fs");
const path = require("path");
const { withAndroidManifest, withDangerousMod } = require("@expo/config-plugins");

const ADVERTISE_PERM = "android.permission.BLUETOOTH_ADVERTISE";
const FINE_LOC_PERM = "android.permission.ACCESS_FINE_LOCATION";
const COARSE_LOC_PERM = "android.permission.ACCESS_COARSE_LOCATION";

function patchMainManifest(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults?.manifest;
    if (!manifest) return cfg;

    // 0. Ensure xmlns:tools is declared so tools:node="remove" works on
    //    the inherited location permissions below.
    if (!manifest.$) manifest.$ = {};
    if (!manifest.$["xmlns:tools"]) {
      manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    }

    if (!Array.isArray(manifest["uses-permission"])) {
      manifest["uses-permission"] = [];
    }

    // 1. Ensure BLUETOOTH_ADVERTISE is declared.
    const hasAdvertise = manifest["uses-permission"].some(
      (entry) => entry?.$?.["android:name"] === ADVERTISE_PERM,
    );
    if (!hasAdvertise) {
      manifest["uses-permission"].push({
        $: { "android:name": ADVERTISE_PERM },
      });
    }

    // 2. Block ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION inherited from
    //    react-native-ble-advertiser's AAR. tools:node="remove" wins the
    //    manifest-merger fight regardless of order.
    const hasFineRemove = manifest["uses-permission"].some(
      (entry) =>
        entry?.$?.["android:name"] === FINE_LOC_PERM && entry?.$?.["tools:node"] === "remove",
    );
    if (!hasFineRemove) {
      manifest["uses-permission"].push({
        $: { "android:name": FINE_LOC_PERM, "tools:node": "remove" },
      });
    }
    const hasCoarseRemove = manifest["uses-permission"].some(
      (entry) =>
        entry?.$?.["android:name"] === COARSE_LOC_PERM && entry?.$?.["tools:node"] === "remove",
    );
    if (!hasCoarseRemove) {
      manifest["uses-permission"].push({
        $: { "android:name": COARSE_LOC_PERM, "tools:node": "remove" },
      });
    }

    // 3. Ensure <uses-feature bluetooth_le required="false">. Required=false
    //    so phones without BLE can still install (we degrade to non-mesh mode).
    if (!Array.isArray(manifest["uses-feature"])) {
      manifest["uses-feature"] = [];
    }
    const hasBleFeature = manifest["uses-feature"].some(
      (entry) => entry?.$?.["android:name"] === "android.hardware.bluetooth_le",
    );
    if (!hasBleFeature) {
      manifest["uses-feature"].push({
        $: {
          "android:name": "android.hardware.bluetooth_le",
          "android:required": "false",
        },
      });
    }

    return cfg;
  });
}

// Patch the LIBRARY's android/build.gradle to add `namespace` (AGP 8) and
// the LIBRARY's AndroidManifest.xml to remove the legacy `package=` attr.
// Both files are inside node_modules/, so we run inside a withDangerousMod
// targeting "android" prebuild.
function patchBleAdvertiserNativeForAgp8(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const libRoot = path.join(
        projectRoot,
        "node_modules",
        "react-native-ble-advertiser",
        "android",
      );

      // 1. build.gradle — inject namespace into android { … } block.
      const gradlePath = path.join(libRoot, "build.gradle");
      try {
        if (fs.existsSync(gradlePath)) {
          let gradle = fs.readFileSync(gradlePath, "utf8");
          if (!gradle.includes("namespace ")) {
            gradle = gradle.replace(
              /android\s*\{/,
              "android {\n    namespace 'com.vitorpamplona.bleadvertiser'",
            );
            fs.writeFileSync(gradlePath, gradle, "utf8");
          }
        }
      } catch (err) {
        console.warn(
          "[withBleAdvertiser] failed to patch build.gradle for AGP 8 namespace:",
          err?.message,
        );
      }

      // 2. AndroidManifest.xml — strip the legacy `package="…"` attr.
      //    AGP 8 rejects manifests that carry both `package=` and a
      //    library `namespace` field; the namespace is canonical.
      const manifestPath = path.join(libRoot, "src", "main", "AndroidManifest.xml");
      try {
        if (fs.existsSync(manifestPath)) {
          let mf = fs.readFileSync(manifestPath, "utf8");
          if (/\bpackage=/.test(mf)) {
            mf = mf.replace(/\s*package="[^"]*"/, "");
            fs.writeFileSync(manifestPath, mf, "utf8");
          }
        }
      } catch (err) {
        console.warn(
          "[withBleAdvertiser] failed to strip legacy package= from library manifest:",
          err?.message,
        );
      }

      return cfg;
    },
  ]);
}

module.exports = function withBleAdvertiser(config) {
  config = patchMainManifest(config);
  config = patchBleAdvertiserNativeForAgp8(config);
  return config;
};
