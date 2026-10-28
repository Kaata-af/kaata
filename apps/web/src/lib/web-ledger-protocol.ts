// Wire-compatible with mobile/lib/event-sig.ts and backend/internal/canonical.
// Keep this module browser-independent so the signing contract can be tested.
export type WebHLC = { pms: number; l: number; did: string };
export class WebLedgerError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "WebLedgerError";
  }
}
export type SignableWebEvent = {
  event_id: string;
  event_type: string;
  vault_id: string;
  target_id: string;
  relationship_id: string | null;
  hlc: WebHLC;
  device_id: string;
  actor_account_id: string | null;
  payload_schema: number;
  payload: unknown;
};

export function canonicalWebJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new WebLedgerError("Invalid signed value", "invalid_data");
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalWebJSON).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalWebJSON(object[key])}`)
    .join(",")}}`;
}

export function canonicalWebEvent(event: SignableWebEvent): Uint8Array {
  return new TextEncoder().encode(
    canonicalWebJSON({
      actor_account_id: event.actor_account_id,
      device_id: event.device_id,
      event_id: event.event_id,
      event_type: event.event_type,
      hlc: { did: event.hlc.did, l: event.hlc.l, pms: event.hlc.pms },
      payload: event.payload,
      payload_schema: event.payload_schema,
      relationship_id: event.relationship_id,
      target_id: event.target_id,
      vault_id: event.vault_id,
    }),
  );
}

export function nextWebHLC(previous: WebHLC, deviceID: string, now = Date.now()): WebHLC {
  if (!Number.isSafeInteger(previous.pms) || !Number.isSafeInteger(previous.l) || previous.l < 0) {
    throw new WebLedgerError(
      "The ledger clock is unreadable. Refresh and try again.",
      "invalid_clock",
    );
  }
  const pms = Math.max(now, previous.pms);
  const l = pms === previous.pms ? previous.l + 1 : 0;
  if (!Number.isSafeInteger(l))
    throw new WebLedgerError("The ledger clock is out of range.", "invalid_clock");
  return { pms, l, did: deviceID };
}

export function asciiWebDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)),
  );
}

// Amounts stay in major units on the wire. Arithmetic is in exact hundredths.
export function webAmountMinor(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new WebLedgerError("Invalid amount", "invalid_amount");
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor))
    throw new WebLedgerError("This amount is too large to display exactly.", "invalid_amount");
  return minor;
}

export function parseWebEntryAmount(input: string): number {
  let normalized = asciiWebDigits(input).replaceAll("٫", ".").trim();
  if (/^\d*,\d{0,2}$/.test(normalized)) normalized = normalized.replace(",", ".");
  if (/^\.\d{1,2}$/.test(normalized)) normalized = `0${normalized}`;
  if (/^\d+\.$/.test(normalized)) normalized = normalized.slice(0, -1);
  const minor = webAmountMinor(normalized);
  const amount = Number(normalized);
  if (minor <= 0 || minor > 999_999_999_999 || webAmountMinor(String(amount)) !== minor) {
    throw new WebLedgerError(
      "Enter an amount greater than zero, with at most two decimal places.",
      "invalid_amount",
    );
  }
  return amount;
}

export function normalizeWebPhone(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  const digits = asciiWebDigits(input)
    .trim()
    .replace(/[\s()\-]/g, "");
  const phone = digits.startsWith("00") ? `+${digits.slice(2)}` : digits;
  // Explicit international numbers avoid guessing a diaspora contact's country.
  if (!/^\+[1-9]\d{6,14}$/.test(phone))
    throw new WebLedgerError(
      "Include the country code, for example +93701234567.",
      "invalid_phone",
    );
  return phone;
}

export function bytesToWebBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(""));
}

export function webBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
