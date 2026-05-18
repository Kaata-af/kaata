import { Linking } from "react-native";
import { formatAFN } from "./format";
import type { Self } from "./types";

// WhatsApp ping. Wording flips by balance sign — a polite reminder to a
// debtor, a heads-up to a creditor, or a clean "all settled" note.
export async function shareKaataViaWhatsApp(
  person: { name: string; phone: string | null },
  balance: number,
  self: Self | null,
): Promise<void> {
  const accountWith = self?.shop_name ?? self?.name ?? "Kaata";
  const lines: string[] = [`Salaam ${person.name}.`, ""];

  if (balance > 0) {
    lines.push(`Your kaata at ${accountWith}:`, `Balance: ${formatAFN(balance)}`);
  } else if (balance < 0) {
    lines.push(`Our kaata with you:`, `I owe you: ${formatAFN(balance)}`);
  } else {
    lines.push(`Our kaata with you is fully settled.`);
  }
  lines.push("", "— Sent via Kaata.af");

  const text = lines.join("\n");
  const phone = person.phone ? person.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  await Linking.openURL(url);
}
