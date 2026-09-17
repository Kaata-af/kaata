// apps/mobile/lib/support.ts
//
// Opens a WhatsApp chat with Kaata support, prefilled with a message.
//
// Why this exists: the App-health screen's old Share button opened the OS
// share sheet with the report as the body, which left the hardest step to the
// user — knowing WHO to send it to. A shopkeeper who has just hit a bug is
// exactly the person least likely to hunt for our number, so the report died
// in the share sheet. This addresses the chat directly.

import { Linking } from "react-native";

import { SUPPORT_WHATSAPP_E164 } from "../constants/env";

/**
 * How the message was handed off:
 *  - "app"    WhatsApp itself opened on the support chat (the good case)
 *  - "web"    WhatsApp isn't installed / didn't take the deep link, so the
 *             wa.me page opened in the browser, which still lands on the same
 *             chat once WhatsApp is installed
 *  - "failed" neither opened; the caller should fall back to its own sharing
 */
export type SupportHandoff = "app" | "web" | "failed";

/**
 * Open the support chat with `text` prefilled. Never throws.
 *
 * Deliberately does NOT call Linking.canOpenURL first. On Android 11+ that
 * needs a <queries> entry and on iOS an LSApplicationQueriesSchemes entry —
 * neither of which this app declares — so canOpenURL answers "no" even when
 * WhatsApp is installed and openURL would have worked. Try, and catch.
 */
export async function openSupportWhatsApp(text: string): Promise<SupportHandoff> {
  const phone = SUPPORT_WHATSAPP_E164.replace(/[^0-9]/g, "");
  const encoded = encodeURIComponent(text);

  try {
    await Linking.openURL(`whatsapp://send?phone=${phone}&text=${encoded}`);
    return "app";
  } catch (err) {
    console.warn("[support] whatsapp:// open failed, falling back to wa.me", err);
  }

  try {
    await Linking.openURL(`https://wa.me/${phone}?text=${encoded}`);
    return "web";
  } catch (err) {
    console.warn("[support] wa.me open failed", err);
    return "failed";
  }
}
