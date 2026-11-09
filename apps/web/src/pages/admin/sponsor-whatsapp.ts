import { normalizeWebPhone } from "../../lib/web-ledger-protocol";

const MAX_DESTINATION_BYTES = 2048;

export function buildSponsorWhatsAppLink(
  phone: string,
  message: string,
): { url: string } | { error: string } {
  let recipient: string | null;
  try {
    recipient = normalizeWebPhone(phone);
  } catch {
    recipient = null;
  }
  if (!recipient) return { error: "Enter a WhatsApp number with its country code." };
  if (!message.trim()) return { error: "Enter a prewritten WhatsApp message." };

  let text: string;
  try {
    text = encodeURIComponent(message);
  } catch {
    return { error: "The message contains an invalid character." };
  }
  const url = `https://wa.me/${recipient.slice(1)}?text=${text}`;
  if (url.length > MAX_DESTINATION_BYTES) {
    return { error: "Shorten the WhatsApp message so it fits in the link." };
  }
  return { url };
}

export function parseSponsorWhatsAppLink(url: string): { phone: string; message: string } | null {
  const match = /^https:\/\/wa\.me\/([1-9]\d{6,14})\?text=(.*)$/.exec(url);
  if (!match) return null;
  const phone = `+${match[1]}`;
  let message: string;
  try {
    message = decodeURIComponent(match[2]);
  } catch {
    return null;
  }

  // Only recover links this editor can reproduce without changing the destination.
  const result = buildSponsorWhatsAppLink(phone, message);
  return "url" in result && result.url === url ? { phone, message } : null;
}
