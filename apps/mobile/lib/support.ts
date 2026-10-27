// apps/mobile/lib/support.ts
//
// Opens the chosen support composer with a prefilled message for review.
//
// Why this exists: the App-health screen's old Share button opened the OS
// share sheet with the report as the body, which left the hardest step to the
// user — knowing WHO to send it to. A shopkeeper who has just hit a bug is
// exactly the person least likely to hunt for our number, so the report died
// in the share sheet. This addresses the chat directly.

import { Linking } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

import { SUPPORT_SMS_E164, SUPPORT_WHATSAPP_E164 } from "../constants/env";

/**
 * How the message was handed off:
 *  - "app"    WhatsApp itself opened on the support chat (the good case)
 *  - "web"    WhatsApp isn't installed / didn't take the deep link, so the
 *             wa.me page opened in the browser, which still lands on the same
 *             chat once WhatsApp is installed
 *  - "failed" neither opened; the caller should fall back to its own sharing
 */
export type SupportHandoff = "app" | "web" | "failed";
export type SupportSmsHandoff = "opened" | "cancelled" | "unavailable" | "failed";

function stillCurrent(canOpen: () => boolean): boolean {
  try {
    return canOpen();
  } catch {
    return false;
  }
}

/** Open the OS composer for the user to review and send. `opened` never
 * confirms delivery; Android reports only an unknown outcome. No fallback
 * sends the summary through another transport. */
export async function openSupportSms(
  text: string,
  canOpen: () => boolean = () => true,
): Promise<SupportSmsHandoff> {
  if (!stillCurrent(canOpen)) return "cancelled";
  let sms: typeof import("expo-sms");
  try {
    // Old installed binaries can lack this newly added native package. Probe
    // before importing its native entry point, which otherwise throws.
    if (!requireOptionalNativeModule("ExpoSMS")) return "unavailable";
    sms = await import("expo-sms");
  } catch {
    return stillCurrent(canOpen) ? "unavailable" : "cancelled";
  }
  if (!stillCurrent(canOpen)) return "cancelled";
  try {
    const available = await sms.isAvailableAsync();
    if (!stillCurrent(canOpen)) return "cancelled";
    if (!available) return "unavailable";
    const response = await sms.sendSMSAsync([SUPPORT_SMS_E164], text);
    if (!stillCurrent(canOpen)) return "cancelled";
    return response.result === "cancelled" ? "cancelled" : "opened";
  } catch {
    return stillCurrent(canOpen) ? "failed" : "cancelled";
  }
}

/**
 * Open the support chat with `text` prefilled. Never throws.
 *
 * Deliberately does NOT call Linking.canOpenURL first. On Android 11+ that
 * needs a <queries> entry and on iOS an LSApplicationQueriesSchemes entry —
 * neither of which this app declares — so canOpenURL answers "no" even when
 * WhatsApp is installed and openURL would have worked. Try, and catch.
 */
export async function openSupportWhatsApp(
  text: string,
  canOpen: () => boolean = () => true,
): Promise<SupportHandoff> {
  if (!stillCurrent(canOpen)) return "failed";
  const phone = SUPPORT_WHATSAPP_E164.replace(/[^0-9]/g, "");
  const encoded = encodeURIComponent(text);

  try {
    await Linking.openURL(`whatsapp://send?phone=${phone}&text=${encoded}`);
    return "app";
  } catch (err) {
    console.warn("[support] whatsapp:// open failed, falling back to wa.me", err);
  }

  if (!stillCurrent(canOpen)) return "failed";
  try {
    await Linking.openURL(`https://wa.me/${phone}?text=${encoded}`);
    return "web";
  } catch (err) {
    console.warn("[support] wa.me open failed", err);
    return "failed";
  }
}
