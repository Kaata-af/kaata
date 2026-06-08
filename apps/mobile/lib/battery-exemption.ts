// apps/mobile/lib/battery-exemption.ts
//
// One-shot battery optimization exemption prompt. Shown the FIRST time the
// user enables Shop Mode. We can't programmatically request the exemption
// (requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS which Play Store flags),
// so we deep-link the user to Settings → Apps → Kaata → Battery via
// Linking.openSettings().

import { Platform } from "react-native";
import { getAppMeta, setAppMeta } from "./db";

const FLAG_KEY = "battery_exemption_prompted_at";

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
