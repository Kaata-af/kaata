import { toAsciiDigits } from "./digits";

// Amounts remain in major currency units: an old stored 100 still means 100.
// Cents are only an exact arithmetic representation, never a new storage unit.
export const MAX_ENTRY_AMOUNT = 9_999_999_999.99;

/** Normalize keyboard digits/separators without deleting meaningful input.
 * Invalid or ambiguous grouping stays visible and fails parseAmountInput. */
export function normalizeAmountInput(text: string): string {
  const normalized = toAsciiDigits(text).replace(/٫/g, ".").trim();
  // With at most two following digits this cannot be a thousands group.
  // Preserve the empty fractional part so a comma keyboard can type 12,50.
  return /^\d*,\d{0,2}$/.test(normalized) ? normalized.replace(",", ".") : normalized;
}

/** Positive entry amount, with at most two decimal places. No rounding. */
export function parseAmountInput(text: string): number | null {
  const normalized = normalizeAmountInput(text);
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ENTRY_AMOUNT) return null;
  return amount;
}

/** Signed, exact cents. Reject extra precision and unsafe integer arithmetic. */
export function toMinorUnits(amount: number): number {
  if (!Number.isFinite(amount)) throw new RangeError("Amount must be finite");
  // Decimal text avoids 0.29 * 100 becoming 28.999999999999996. Scientific
  // notation is either sub-cent precision or beyond the safe cents range.
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(Math.abs(amount)));
  if (!parts) throw new RangeError("Amount must have at most two decimal places");
  const minor = Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) throw new RangeError("Amount exceeds safe cents range");
  return amount < 0 ? -minor : minor;
}

export function fromMinorUnits(minor: number): number {
  if (!Number.isSafeInteger(minor)) throw new RangeError("Cents must be a safe integer");
  const magnitude = Math.abs(minor);
  const amount = Number(
    `${minor < 0 ? "-" : ""}${Math.floor(magnitude / 100)}.${String(magnitude % 100).padStart(2, "0")}`,
  );
  // Near Number's precision limit, a safe integer cent value can still lose a
  // cent when represented in major units. Fail instead of changing the value.
  if (toMinorUnits(amount) !== minor) throw new RangeError("Amount cannot preserve exact cents");
  return amount;
}

export function addAmounts(a: number, b: number): number {
  return fromMinorUnits(toMinorUnits(a) + toMinorUnits(b));
}

export function sumAmounts(amounts: Iterable<number>): number {
  let minor = 0;
  for (const amount of amounts) {
    minor += toMinorUnits(amount);
    if (!Number.isSafeInteger(minor)) throw new RangeError("Total exceeds safe cents range");
  }
  return fromMinorUnits(minor);
}

/** Unsigned Latin digits in every language; whole amounts retain their shape. */
export function formatMoneyAmount(amount: number): string {
  const minor = Math.abs(toMinorUnits(amount));
  const whole = Math.floor(minor / 100).toLocaleString("en-US");
  const cents = minor % 100;
  return cents === 0 ? whole : `${whole}.${String(cents).padStart(2, "0")}`;
}
