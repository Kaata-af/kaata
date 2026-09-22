// apps/mobile/lib/tabs/wire.ts
//
// Wire money ⇄ integer hundredths, by string surgery only. The wire carries
// `"12.34"` / `"100"` (D16); the cache stores 1234 / 10000. Going through a
// float for cents is exactly the 0.1 + 0.2 = 0.30000000000000004 bug that
// lib/money.ts exists to avoid, so neither function ever multiplies a decimal.
// Pure — loaded by the selftest, which pins "0.10" + "0.20" = "0.3" (no
// trailing zero, byte-identical to Go's formatMinor) and the MAX_ENTRY_AMOUNT
// edge ("9999999999.99" ⇄ 999_999_999_999).

/** Server bound (§3.1): `^\d{1,10}(\.\d{1,2})?$`, i.e. 9,999,999,999.99 — the
 *  same ceiling as lib/money.ts MAX_ENTRY_AMOUNT, in hundredths. */
export const MAX_WIRE_MINOR = 999_999_999_999;

const WIRE_AMOUNT = /^(-)?(\d{1,10})(?:\.(\d{1,2}))?$/;

/**
 * Parse a wire amount into signed hundredths. Signed because the tab's
 * `balance` map is signed ("-1250"); entry amounts are always positive.
 * Throws RangeError on anything the server would not have produced — a
 * malformed amount from the server must fail loudly, not silently zero.
 */
export function wireToMinor(amount: string): number {
  const m = WIRE_AMOUNT.exec(amount.trim());
  if (!m) throw new RangeError(`invalid wire amount: ${JSON.stringify(amount)}`);
  const whole = Number(m[2]) * 100;
  const cents = Number((m[3] ?? "").padEnd(2, "0"));
  const minor = whole + cents;
  if (!Number.isSafeInteger(minor) || minor > MAX_WIRE_MINOR) {
    throw new RangeError(`wire amount out of range: ${amount}`);
  }
  return m[1] ? -minor : minor;
}

/**
 * Format signed hundredths as a wire amount: no thousands separators, no
 * trailing zeros in the fraction ("-10", "0.25", "12.5" — the server regex
 * accepts one or two decimals). Matches the `expected` strings in
 * apps/_shared/tab-vectors.json byte for byte.
 */
export function minorToWire(minor: number): string {
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > MAX_WIRE_MINOR) {
    throw new RangeError(`cents out of wire range: ${minor}`);
  }
  const magnitude = Math.abs(minor);
  const whole = String(Math.floor(magnitude / 100));
  const cents = magnitude % 100;
  let text = whole;
  if (cents !== 0) {
    text += cents % 10 === 0 ? `.${cents / 10}` : `.${String(cents).padStart(2, "0")}`;
  }
  return minor < 0 ? `-${text}` : text;
}
