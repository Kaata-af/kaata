import { Linking } from "react-native";
import { bumpUsageCounter } from "./db";
import { formatAmount } from "./format";
import type { Self } from "./types";

// WhatsApp ping. Wording, sign and color emoji are all framed from the
// *receiver's* perspective — banking convention, since they're the one
// reading. App's internal balance flips:
//   sender balance > 0 → receiver is debtor → "🔴 You owe: −X"
//   sender balance < 0 → receiver is creditor → "🟢 I owe you: +X"
// A short action line ("Please settle when you can." etc.) sits alongside
// the number so users who don't intuit "owe" still get a clear ask.
export async function shareKaataViaWhatsApp(
  person: { name: string; phone: string | null },
  balance: number,
  self: Self | null,
): Promise<void> {
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  const lines: string[] = [`Salaam ${person.name}.`, ""];

  if (balance > 0) {
    lines.push(`Your kaata at ${accountWith}:`);
    lines.push(`🔴 You owe: −${formatAmount(balance)} AFN`);
    lines.push("");
    lines.push("Please settle when you can.");
  } else if (balance < 0) {
    lines.push(`Our kaata:`);
    lines.push(`🟢 I owe you: +${formatAmount(balance)} AFN`);
    lines.push("");
    lines.push("I will settle soon.");
  } else {
    lines.push(`🤝 Our kaata is fully settled.`);
    lines.push("");
    lines.push("Thank you.");
  }

  lines.push("");
  lines.push("— Sent via Kaata.af");

  const text = lines.join("\n");
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  await bumpUsageCounter("shares_sent");
  await Linking.openURL(url);
}
