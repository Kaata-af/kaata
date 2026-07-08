import { getAppMeta, setAppMeta } from "./db";
import { getDb } from "./db-tx";
import { getLocale } from "./i18n";

// Currency selection for entry amounts. Curated for the Afghan market:
// AFN as the default, USD for parallel pricing (common in Afghan shops),
// then the currencies of the diaspora and neighbouring countries.
//
// IMPORTANT data-integrity note: kaata currently stores `amount_afn` as an
// integer with no per-entry currency tagging. The active currency is a
// DISPLAY label, not a math attribute — changing it relabels existing
// amounts; it does not convert them. A shopkeeper who logs 500 entries in
// AFN and then switches to USD now sees their numbers labeled with the new
// symbol even though they were entered as AFN. We don't migrate.
//
// True multi-currency (per-entry tagging + conversion) is a Phase 2
// refactor: adds `currency TEXT NOT NULL` to entries, updates balance math
// to be per-currency, may add exchange-rate handling. Out of scope for now.

export type Currency = {
  // ISO code (kept as the persistence key in app_meta + a stable picker id).
  code: string;
  // Locale-specific names. `name` is English; `nameFa` is Afghan Dari.
  name: string;
  nameFa: string;
  // Display symbol. Used everywhere amounts render — replaces the letter
  // code (per the user request: ؋ instead of AFN, $ instead of USD, etc.).
  symbol: string;
};

export const CURRENCIES: ReadonlyArray<Currency> = [
  { code: "AFN", name: "Afghan Afghani", nameFa: "افغانی", symbol: "؋" },
  { code: "USD", name: "US Dollar", nameFa: "دالر امریکا", symbol: "$" },
  { code: "EUR", name: "Euro", nameFa: "یورو", symbol: "€" },
  { code: "AUD", name: "Australian Dollar", nameFa: "دالر آسترالیا", symbol: "A$" },
  { code: "GBP", name: "British Pound", nameFa: "پوند انگلیس", symbol: "£" },
  { code: "PKR", name: "Pakistani Rupee", nameFa: "روپیه پاکستان", symbol: "₨" },
  { code: "IRR", name: "Iranian Rial", nameFa: "ریال ایران", symbol: "﷼" },
  { code: "AED", name: "UAE Dirham", nameFa: "درهم امارات", symbol: "د.إ" },
  { code: "TRY", name: "Turkish Lira", nameFa: "لیره ترکیه", symbol: "₺" },
];

export const DEFAULT_CURRENCY = "AFN";

// Active currency code, set on app start via initCurrencyFromPref(). Lives
// as a module-level mutable so callers can read it synchronously from any
// render path without prop-drilling.
let currentCurrency: string = DEFAULT_CURRENCY;

// Picks an entry from CURRENCIES with a fallback to AFN if the code is
// somehow unknown (defensive — picker should never let us into that state).
function findCurrency(code: string): Currency {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

export function getCurrentCurrencyCode(): string {
  return currentCurrency;
}

// Display symbol for the active currency. This is what every amount in the
// UI renders next to — home total, balance row, list rows, entry-form
// label, WhatsApp share body.
export function getCurrentCurrencySymbol(): string {
  return findCurrency(currentCurrency).symbol;
}

// Locale-aware human name for the active currency. Used in the picker so
// each row reads "؋  افغانی" in Dari and "؋  Afghan Afghani" in English.
export function getCurrencyName(code: string): string {
  const c = findCurrency(code);
  return getLocale() === "fa" ? c.nameFa : c.name;
}

// Called by _layout.tsx during init alongside i18n. Reads from app_meta and
// applies the saved choice before the first render so amount labels are
// correct from frame zero.
export async function initCurrencyFromPref(): Promise<void> {
  try {
    const stored = await getAppMeta("default_currency");
    if (stored && CURRENCIES.some((c) => c.code === stored)) {
      currentCurrency = stored;
    }
  } catch {
    // app_meta unreadable — fall back to AFN silently.
  }
}

// Imperatively set the currency code. Caller is responsible for also
// persisting via setAppMeta("default_currency", code).
export function setCurrentCurrency(code: string): void {
  if (CURRENCIES.some((c) => c.code === code)) {
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
    if (code && CURRENCIES.some((c) => c.code === code) && code !== currentCurrency) {
      currentCurrency = code;
      await setAppMeta("default_currency", code).catch(() => {});
    }
  } catch {
    // vaults row unreadable — keep the prior symbol.
  }
}
