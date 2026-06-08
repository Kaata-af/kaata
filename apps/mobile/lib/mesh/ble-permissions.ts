// apps/mobile/lib/mesh/ble-permissions.ts
//
// Phase 6: Android 12+ runtime BLE permission flow.
//
// Stock Android prompts ("Allow Kaata to find, connect to, and determine
// the relative position of nearby devices?") panic non-technical Afghan
// shopkeepers. The expected UX is:
//
//   1. User toggles "Sync with phones nearby" → ON.
//   2. Kaata shows its OWN rationale ConfirmDialog explaining the
//      Bluetooth-not-location framing.
//   3. On Continue, request BLUETOOTH_SCAN / CONNECT / ADVERTISE via
//      PermissionsAndroid.requestMultiple — the OS dialogs fire here.
//   4. On all-granted → proceed.
//      On any-denied (not "Don't ask again") → toast + revert toggle.
//      On any-denied with "Don't ask again" (NEVER_ASK_AGAIN) → show
//      "Open settings" dialog so the user can grant manually.
//
// All Android-only. Returns "ok" on iOS (no BLE peripheral mode is
// shipped) so callers can stay platform-agnostic. The mesh subsystem
// itself is Android-only — see lib/mesh/index.ts header.
//
// Why a separate module: lib/mesh/index.ts shouldn't import from
// react-native at all (it's used from background contexts too); the
// MeshController component owns the UI flow. This module is the bridge.

import { PermissionsAndroid, Platform } from "react-native";

// Permission strings as react-native's PermissionsAndroid typed enum.
// On Android < 12 these constants don't exist; we guard via Platform.Version.
const PERMS_ANDROID_12 = [
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_ADVERTISE",
] as const;

export type BlePermissionResult =
  | { kind: "ok" }
  | { kind: "denied"; canRetry: boolean }
  | { kind: "never_ask_again" }
  | { kind: "platform_unsupported" };

/**
 * True iff we already hold all three BLE runtime perms. Cheap synchronous
 * check (PermissionsAndroid.check is itself async, but doesn't pop the
 * dialog). Returns true on non-Android.
 */
export async function hasBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const version =
    typeof Platform.Version === "number"
      ? Platform.Version
      : parseInt(String(Platform.Version), 10);
  // Android 11 (API 30) and below used legacy BLUETOOTH/BLUETOOTH_ADMIN
  // which are install-time. The Android-12+ runtime perms don't exist on
  // those versions, so any check would return false — short-circuit ok.
  if (version < 31) return true;
  try {
    for (const p of PERMS_ANDROID_12) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await PermissionsAndroid.check(p as any);
      if (!ok) return false;
    }
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[ble-perms] check failed", err);
    return false;
  }
}

/**
 * Request all three BLE runtime perms. Caller must have shown a rationale
 * dialog FIRST so the OS dialogs land in a context the user can parse.
 *
 * Returns:
 *   ok                   — all three granted
 *   denied(canRetry=true)— user denied but didn't tick "Don't ask again";
 *                          caller can revert toggle + re-prompt next time
 *   never_ask_again      — user denied with "Don't ask again";
 *                          caller must surface an "Open settings" path
 *   platform_unsupported — non-Android, or Android < 12 (no runtime ask
 *                          is possible / needed)
 */
export async function requestBlePermissions(): Promise<BlePermissionResult> {
  if (Platform.OS !== "android") return { kind: "platform_unsupported" };
  const version =
    typeof Platform.Version === "number"
      ? Platform.Version
      : parseInt(String(Platform.Version), 10);
  if (version < 31) return { kind: "ok" }; // legacy install-time perms

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await PermissionsAndroid.requestMultiple(PERMS_ANDROID_12 as any);
    let anyDenied = false;
    let anyNeverAskAgain = false;
    for (const p of PERMS_ANDROID_12) {
      const status = res[p];
      if (status === PermissionsAndroid.RESULTS.GRANTED) continue;
      anyDenied = true;
      if (status === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        anyNeverAskAgain = true;
      }
    }
    if (!anyDenied) return { kind: "ok" };
    if (anyNeverAskAgain) return { kind: "never_ask_again" };
    return { kind: "denied", canRetry: true };
  } catch (err) {
    if (__DEV__) console.warn("[ble-perms] request failed", err);
    return { kind: "denied", canRetry: true };
  }
}
