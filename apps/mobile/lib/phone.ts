// Afghan mobile numbers in E.164: +93 followed by 9 digits starting with 7.
// Examples of accepted input: 0701234567, 701234567, 93701234567,
// +93701234567, +93 70 123 4567, 0093701234567.

const E164_AF_MOBILE = /^\+937\d{8}$/;

export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null;
  // Strip everything except digits and a single leading '+'.
  let cleaned = input.trim().replace(/[^\d+]/g, "");
  if (cleaned.length > 1) {
    // Allow only a leading '+'; strip any other '+' chars
    cleaned = cleaned[0] + cleaned.slice(1).replace(/\+/g, "");
  }
  if (!cleaned) return null;

  if (cleaned.startsWith("+")) {
    // already has country code marker — fall through to validation
  } else if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  } else if (cleaned.startsWith("93") && cleaned.length === 11) {
    cleaned = "+" + cleaned;
  } else if (cleaned.startsWith("0") && cleaned.length === 10) {
    cleaned = "+93" + cleaned.slice(1);
  } else if (cleaned.length === 9 && cleaned.startsWith("7")) {
    cleaned = "+93" + cleaned;
  } else {
    return null;
  }

  return E164_AF_MOBILE.test(cleaned) ? cleaned : null;
}

export function formatPhoneForDisplay(e164: string): string {
  if (!E164_AF_MOBILE.test(e164)) return e164;
  const rest = e164.slice(3); // 9 digits, starts with 7
  return `+93 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
}
