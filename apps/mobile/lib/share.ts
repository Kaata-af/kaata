import { Linking } from "react-native";
import { formatAFN } from "./format";
import type { Self } from "./types";

export async function sharekaataViaWhatsApp(
  customer: { name: string; phone: string | null },
  balance: number,
  self: Self | null,
): Promise<void> {
  const heading = self?.shop_name
    ? `Your kaata at ${self.shop_name}`
    : self?.name
      ? `Your kaata with ${self.name}`
      : "Your kaata";

  const text =
    `Salaam ${customer.name}.\n\n` +
    `${heading}:\n` +
    `Balance: ${formatAFN(balance)}\n\n` +
    `— Sent via Kaata.af`;

  const phone = customer.phone ? customer.phone.replace(/[^0-9+]/g, "") : "";
  const url = phone
    ? `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
    : `whatsapp://send?text=${encodeURIComponent(text)}`;
  await Linking.openURL(url);
}
