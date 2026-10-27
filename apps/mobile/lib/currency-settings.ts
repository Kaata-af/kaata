import { isValidCurrencyCode } from "./currency-scope";

/** The setting is a small, nonempty set. Raw JSON stays signed and synced. */
export function parseEnabledCurrencies(value: unknown): string[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) return null;
  if (!parsed.every(isValidCurrencyCode) || new Set(parsed).size !== parsed.length) return null;
  return [...parsed];
}

export function requireEnabledCurrencies(value: unknown): string[] {
  const codes = parseEnabledCurrencies(value);
  if (!codes) throw new Error("Invalid enabled currencies");
  return codes;
}

export function settingCurrency(value: unknown): string | null {
  let code = value;
  if (typeof code === "string") {
    try {
      const parsed = JSON.parse(code);
      if (typeof parsed === "string") code = parsed;
    } catch {}
  }
  return isValidCurrencyCode(code) ? code : null;
}
