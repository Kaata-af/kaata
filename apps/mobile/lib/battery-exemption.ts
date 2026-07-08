// apps/mobile/lib/battery-exemption.ts
//
// Battery-optimization (Doze) exemption — Briar parity. Swap-survival aid:
// without the OS whitelist, hostile OEMs (MIUI/Huawei/Xiaomi) kill the
// unwhitelisted process on swipe BEFORE the revival alarm can fire, so the
// foreground-service notification vanishes and the native engine never runs.
//
// PLAY-SAFE (2026-07): we do NOT hold REQUEST_IGNORE_BATTERY_OPTIMIZATIONS and
// do NOT fire the restricted one-tap ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
// dialog (both dropped in H3 for Play submission). requestBatteryExemption()
// instead OPENS the battery-optimization settings list (native side) so the
// user exempts Kaata manually. isIgnoringBatteryOptimizations() is a plain
// PowerManager query (no permission) so we still detect the result on resume.
// Trade-off: a couple more taps for the user; no Play-restricted API used.

import { Platform } from "react-native";
import { getAppMeta, setAppMeta } from "./db";
import {
  isIgnoringBatteryOptimizations as nativeIsIgnoring,
  requestIgnoreBatteryOptimizations as nativeRequest,
  oemAutostartAvailable as nativeOemAvailable,
  openOemAutostartSettings as nativeOpenOem,
} from "../modules/kaata-bt-classic";

const FLAG_KEY = "battery_exemption_prompted_at";
const OEM_FLAG_KEY = "oem_autostart_prompted_at";

/** True iff the app is already on the OS Doze whitelist (or non-Android). */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  return nativeIsIgnoring();
}

/** Fire the system battery-optimization exemption dialog. Resolves true if
 *  already exempt (no dialog). Re-check isIgnoringBatteryOptimizations on resume
 *  — the user can dismiss the dialog without granting. */
export async function requestBatteryExemption(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  return nativeRequest();
}

/**
 * True iff the platform is Android AND the user has never been shown the
 * battery-optimization prompt. The Android check is kept here (not just in
 * the UI) so that a cross-platform restore can't flip the flag on iOS and
 * then skip the prompt when the user later runs the same account on
 * Android.
 */
export async function shouldPromptBatteryExemption(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const seen = await getAppMeta(FLAG_KEY);
  return !seen;
}

export async function markBatteryExemptionPrompted(): Promise<void> {
  await setAppMeta(FLAG_KEY, String(Date.now()));
}

// OEM autostart / protected-apps — the killer the Doze whitelist doesn't cover
// (MIUI/EMUI auto-start managers). We prompt ONCE (it can't be detected as
// granted, unlike battery optimization), the first time sync is enabled on a
// device that has such a screen.

/** True iff this device has an OEM autostart screen AND we haven't prompted yet. */
export async function shouldPromptOemAutostart(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  const seen = await getAppMeta(OEM_FLAG_KEY);
  if (seen) return false;
  return nativeOemAvailable();
}

export async function markOemAutostartPrompted(): Promise<void> {
  await setAppMeta(OEM_FLAG_KEY, String(Date.now()));
}

/** Open the OEM autostart/protected-apps screen. No-op (false) if none exists. */
export async function openOemAutostartSettings(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  return nativeOpenOem();
}
