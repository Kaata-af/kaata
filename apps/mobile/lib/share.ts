import { Linking } from "react-native";
import { getCurrentCurrencySymbol } from "./currency";
import { bumpUsageCounter } from "./db";
import { formatAmount } from "./format";
import { t } from "./i18n";
import type { Self } from "./types";

// WhatsApp ping. Wording, sign and color emoji are all framed from the
// *receiver's* perspective — banking convention, since they're the one
// reading. App's internal balance flips:
//   sender balance > 0 → receiver is debtor → "🔴 You owe: −X"
//   sender balance < 0 → receiver is creditor → "🟢 I owe you: +X"
// A short action line ("Please settle when you can." etc.) sits alongside
// the number so users who don't intuit "owe" still get a clear ask.
//
// Message body uses the SENDER's locale (the shopkeeper composing it).
// The receiver may be on a different locale, but the message is one block
// of text sent verbatim, so it's whatever the sender's kaata is set to.
// Returns true when WhatsApp opened; false when it couldn't (not
// installed / disabled). Callers surface the failure — the ping bar is
// the app's primary share CTA and a silent no-op tap reads as "broken".
export async function shareKaataViaWhatsApp(
  person: { name: string; phone: string | null },
  balance: number,
  self: Self | null,
): Promise<boolean> {
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  const currency = getCurrentCurrencySymbol();
  const amount = formatAmount(balance);
  const lines: string[] = [t("share.greeting", { name: person.name }), ""];

  if (balance > 0) {
    lines.push(t("share.theyOwe.header", { accountWith }));
    lines.push(t("share.theyOwe.amount", { amount, currency }));
    lines.push("");
    lines.push(t("share.theyOwe.cta"));
  } else if (balance < 0) {
    lines.push(t("share.youOwe.header"));
    lines.push(t("share.youOwe.amount", { amount, currency }));
    lines.push("");
    lines.push(t("share.youOwe.cta"));
  } else {
    lines.push(t("share.settled.line"));
    lines.push("");
    lines.push(t("share.settled.cta"));
  }

  lines.push("");
  lines.push(t("share.footer"));

  const text = lines.join("\n");
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  try {
    await Linking.openURL(url);
  } catch (err) {
    console.warn("[share] WhatsApp open failed", err);
    return false;
  }
  // Count only AFTER the open succeeded — bumping first inflated the
  // shares_sent telemetry on every failed attempt.
  await bumpUsageCounter("shares_sent").catch(() => undefined);
  return true;
}
