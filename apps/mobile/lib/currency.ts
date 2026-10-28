import { getAppMeta, setAppMeta } from "./db";
import { getDb } from "./db-tx";
import { getLocale } from "./i18n";
import { useEffect, useState } from "react";
import { getActiveVaultIdSyncMaybe } from "./db-tx";
import {
  getLedgerCurrencyCode,
  isValidCurrencyCode,
  setLedgerCurrencyCode,
  subscribeLedgerCurrency,
} from "./currency-scope";
import { parseEnabledCurrencies, settingCurrency } from "./currency-settings";

import { CURRENCIES, getCurrencyNameForLocale } from "./currency-catalog";
export { CURRENCIES, type Currency } from "./currency-catalog";

// Tallies retain their own currency. The selected view and future-entry default
// never relabel or convert saved amounts. ISO minor units are metadata only;
// all money keeps the existing two-decimal storage and arithmetic contract.
export const DEFAULT_CURRENCY = "AFN";
const currenciesByCode = new Map(CURRENCIES.map((currency) => [currency.code, currency]));

// Active currency code, set on app start via initCurrencyFromPref(). Lives
// as a module-level mutable so callers can read it synchronously from any
// render path without prop-drilling.
const selectedCurrencyKey = (vaultId: string) => `selected_currency:${vaultId}`;
let selectedVault: string | null = null;

export function getCurrentCurrencyCode(): string {
  return getLedgerCurrencyCode();
}

// Display symbol for the active currency. This is what every amount in the
// UI renders next to — home total, balance row, list rows, entry-form
// label, WhatsApp share body.
export function getCurrentCurrencySymbol(): string {
  return getCurrencySymbol(getLedgerCurrencyCode());
}

/** One unambiguous label, including in books that mix dollar currencies.
 * Compact amount controls use getCurrencySymbol instead of adding a symbol here. */
export function getCurrencyLabel(code: string): string {
  return code;
}

export async function getDefaultEntryCurrency(
  vaultId: string,
  fallback = DEFAULT_CURRENCY,
): Promise<string> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    value: string | null;
    default_entry_currency: string | null;
  }>(
    "SELECT default_entry_currency, (SELECT value FROM vault_settings WHERE vault_id=v.id AND key='default_entry_currency') AS value FROM vaults v WHERE v.id=?",
    vaultId,
  );
  let code = row?.value;
  if (code) {
    try {
      const parsed = JSON.parse(code);
      if (typeof parsed === "string") code = parsed;
    } catch {}
  }
  if (isValidCurrencyCode(code)) return code;
  return isValidCurrencyCode(row?.default_entry_currency) ? row.default_entry_currency : fallback;
}

/** Enabled currencies constrain future choices; saved tally currencies stay readable. */
export async function getEnabledCurrencies(vaultId: string): Promise<string[]> {
  const db = await getDb();
  const read = () =>
    db.getFirstAsync<{
      currency: string | null;
      legacy_currency: string | null;
      default_entry_currency: string | null;
      default_value: string | null;
      enabled_value: string | null;
    }>(
      `SELECT currency, legacy_currency, default_entry_currency,
       (SELECT value FROM vault_settings WHERE vault_id=v.id AND key='default_entry_currency') AS default_value,
       (SELECT value FROM vault_settings WHERE vault_id=v.id AND key='enabled_currencies') AS enabled_value
     FROM vaults v WHERE id=?`,
      vaultId,
    );
  let row = await read();
  let enabled = parseEnabledCurrencies(row?.enabled_value);
  let used: string[] = [];
  if (!enabled) {
    const { listLedgerCurrencies } = require("./db") as typeof import("./db");
    used = await listLedgerCurrencies(vaultId);
    // A synced owner choice may have arrived during discovery. Honor that
    // explicit list before offering any previously used currency again.
    row = await read();
    enabled = parseEnabledCurrencies(row?.enabled_value);
  }
  const defaultCode =
    [row?.default_value, row?.default_entry_currency, row?.currency]
      .map(settingCurrency)
      .find(Boolean) ?? DEFAULT_CURRENCY;
  const fallback =
    settingCurrency(row?.legacy_currency) ?? settingCurrency(row?.currency) ?? defaultCode;
  // Separate LWW settings can arrive in either order. The current default
  // remains enabled even when another owner's concurrent list omitted it.
  return [
    ...new Set([...(enabled ?? [fallback, ...used.filter(isValidCurrencyCode)]), defaultCode]),
  ];
}

/** Repaint an already mounted ledger when its selected currency changes. */
export function useCurrency(): string {
  const [code, setCode] = useState(getLedgerCurrencyCode);
  useEffect(() => {
    const unsubscribe = subscribeLedgerCurrency(setCode);
    // A selection can change between the first render and subscription.
    setCode(getLedgerCurrencyCode());
    return unsubscribe;
  }, []);
  return code;
}

// Locale-aware name for choice rows, paired with one ISO code.
export function getCurrencyName(code: string): string {
  return getCurrencyNameForLocale(code, getLocale());
}

/** ISO metadata does not change the ledger's two-decimal money contract. */
export function currencyNeedsPrecisionHint(code = getLedgerCurrencyCode()): boolean {
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
    if (isValidCurrencyCode(stored)) {
      setLedgerCurrencyCode(stored);
    }
  } catch {
    // app_meta unreadable — fall back to AFN silently.
  }
}

/** Select and remember a ledger view without changing any stored money. */
export function setCurrentCurrency(code: string): void {
  if (!isValidCurrencyCode(code)) return;
  const vaultId = getActiveVaultIdSyncMaybe();
  if (vaultId) void selectLedgerCurrency(code, vaultId).catch(() => {});
  else {
    setLedgerCurrencyCode(code);
    void setAppMeta("default_currency", code).catch(() => {});
  }
}

/** A notification or join flow awaits persistence before opening its ledger. */
export async function selectLedgerCurrency(code: string, vaultId: string): Promise<void> {
  if (!isValidCurrencyCode(code)) throw new Error("Invalid currency code");
  if (getActiveVaultIdSyncMaybe() === vaultId) {
    selectedVault = vaultId;
    setLedgerCurrencyCode(code);
  }
  await setAppMeta(selectedCurrencyKey(vaultId), code);
  if (getActiveVaultIdSyncMaybe() === vaultId) await setAppMeta("default_currency", code);
}

// Restore this kaata's selected view. A new view starts at its entry default;
// switching to another currency leaves existing tallies and defaults alone.
export async function applyVaultCurrency(vaultId: string | null): Promise<void> {
  if (!vaultId) return;
  if (selectedVault === vaultId) return;
  try {
    const db = await getDb();
    const [stored, row, setting] = await Promise.all([
      getAppMeta(selectedCurrencyKey(vaultId)),
      db.getFirstAsync<{ currency: string | null; default_entry_currency: string | null }>(
        "SELECT currency, default_entry_currency FROM vaults WHERE id = ?",
        vaultId,
      ),
      db.getFirstAsync<{ value: string | null }>(
        "SELECT value FROM vault_settings WHERE vault_id = ? AND key = 'default_entry_currency'",
        vaultId,
      ),
    ]);
    let defaultCode = setting?.value;
    if (defaultCode) {
      try {
        const parsed = JSON.parse(defaultCode);
        if (typeof parsed === "string") defaultCode = parsed;
      } catch {}
    }
    const code = [
      stored,
      defaultCode,
      row?.default_entry_currency,
      row?.currency,
      DEFAULT_CURRENCY,
    ].find((candidate) => isValidCurrencyCode(candidate))!;
    if (getActiveVaultIdSyncMaybe() !== vaultId) return;
    selectedVault = vaultId;
    setLedgerCurrencyCode(code);
    await setAppMeta("default_currency", code).catch(() => {});
  } catch {
    // vaults row unreadable — keep the prior symbol.
  }
}
