import { getAppMeta, setAppMeta } from "./db";
import { getDb } from "./db-tx";
import { getLocale } from "./i18n";

import { CURRENCIES, getCurrencyNameForLocale } from "./currency-catalog";
export { CURRENCIES, type Currency } from "./currency-catalog";

// Every kaata has one display currency. Existing amount_afn values stay in
// major units with at most two decimal places. Selecting another currency
// relabels those amounts; it never converts or rescales stored money.
// Third-decimal currency support needs a coordinated money/sync change.
export const DEFAULT_CURRENCY = "AFN";
const currenciesByCode = new Map(CURRENCIES.map((currency) => [currency.code, currency]));

// Active currency code, set on app start via initCurrencyFromPref(). Lives
// as a module-level mutable so callers can read it synchronously from any
// render path without prop-drilling.
let currentCurrency: string = DEFAULT_CURRENCY;

export function getCurrentCurrencyCode(): string {
  return currentCurrency;
}

// Display symbol for the active currency. This is what every amount in the
// UI renders next to — home total, balance row, list rows, entry-form
// label, WhatsApp share body.
export function getCurrentCurrencySymbol(): string {
  return getCurrencySymbol(currentCurrency);
}

// Locale-aware human name for the active currency. Used in the picker so
// each row reads "؋  افغانی" in Dari and "؋  Afghan Afghani" in English.
export function getCurrencyName(code: string): string {
  return getCurrencyNameForLocale(code, getLocale());
}

// Preserve the ledger's two-decimal contract even when an ISO currency uses
// three. Entry screens explain the limit before an amount is entered.
export function currencyNeedsPrecisionHint(code = currentCurrency): boolean {
  return (currenciesByCode.get(code)?.minorUnits ?? 2) > 2;
}

// Display symbol for an arbitrary code (not the active one) — the vault
// switcher tags each kaata with its own currency so the two-books-per-store
// pattern (AFN kaata + USD kaata) is legible at a glance. Falls back to the
// raw code for an unknown currency rather than the AFN symbol: mislabeling
// a foreign-currency book "؋" is worse than showing "XYZ".
export function getCurrencySymbol(code: string): string {
  return currenciesByCode.get(code)?.symbol ?? code;
}

// Called by _layout.tsx during init alongside i18n. Reads from app_meta and
// applies the saved choice before the first render so amount labels are
// correct from frame zero.
export async function initCurrencyFromPref(): Promise<void> {
  try {
    const stored = await getAppMeta("default_currency");
    if (stored && currenciesByCode.has(stored)) {
      currentCurrency = stored;
    }
  } catch {
    // app_meta unreadable — fall back to AFN silently.
  }
}

// Imperatively set the currency code. Caller is responsible for also
// persisting via setAppMeta("default_currency", code).
export function setCurrentCurrency(code: string): void {
  if (currenciesByCode.has(code)) {
    currentCurrency = code;
  }
}

// Make the module-global display currency follow the ACTIVE vault. Currency is
// a per-vault property (vaults.currency), but the display symbol was a single
// global seeded once from app_meta.default_currency and only updated when
// editing the active vault's settings — so onboarding's currency pick, creating
// a second vault, and switching vaults all left amounts (home totals, balances,
// entry rows, the WhatsApp share body, and the shared web ledger) labelled with
// the wrong currency. Call this whenever the active vault becomes known (home
// load, vault switch, restore) so getCurrentCurrencySymbol() matches the vault
// the user is looking at. Also mirrors the choice into default_currency so a
// pre-first-render read stays consistent. Best-effort; keeps the prior value on
// any DB error.
export async function applyVaultCurrency(vaultId: string | null): Promise<void> {
  if (!vaultId) return;
  try {
    const db = await getDb();
    const row = await db.getFirstAsync<{ currency: string | null }>(
      "SELECT currency FROM vaults WHERE id = ?",
      vaultId,
    );
    const code = row?.currency;
    if (code && currenciesByCode.has(code) && code !== currentCurrency) {
      currentCurrency = code;
      await setAppMeta("default_currency", code).catch(() => {});
    }
  } catch {
    // vaults row unreadable — keep the prior symbol.
  }
}
