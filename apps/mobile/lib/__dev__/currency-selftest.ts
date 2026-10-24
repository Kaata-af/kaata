// Synthetic preferences/vaults only. No native database or network is opened.
import assert from "node:assert/strict";
import { CURRENCIES, getCurrencyNameForLocale, searchCurrencies } from "../currency-catalog";
import { compileUI } from "./ui-fixture";
import { formatMoneyAmount, parseAmountInput, sumAmounts } from "../money";

let locale = "en";
const preferences = new Map<string, string>();
const vaults = new Map<string, string>();
let unreadable = false;
const currency = compileUI("../currency", {
  "./currency-catalog": require("../currency-catalog"),
  "./i18n": { getLocale: () => locale },
  "./db": {
    getAppMeta: async (key: string) => {
      if (unreadable) throw new Error("Synthetic unavailable preference");
      return preferences.get(key) ?? null;
    },
    setAppMeta: async (key: string, value: string) => {
      preferences.set(key, value);
    },
  },
  "./db-tx": {
    getDb: async () => ({
      getFirstAsync: async (sql: string, id: string) => {
        assert.equal(sql, "SELECT currency FROM vaults WHERE id = ?");
        if (unreadable) throw new Error("Synthetic unavailable vault");
        return vaults.has(id) ? { currency: vaults.get(id) } : null;
      },
    }),
  },
}) as typeof import("../currency");

async function main() {
  assert.equal(
    CURRENCIES.length,
    155,
    "all current non-fund monetary currencies in pinned ISO list",
  );
  assert.equal(new Set(CURRENCIES.map((c) => c.code)).size, CURRENCIES.length);
  assert.deepEqual(
    CURRENCIES.slice(0, 9).map((c) => c.code),
    ["AFN", "USD", "EUR", "AUD", "GBP", "PKR", "IRR", "AED", "TRY"],
  );
  assert.deepEqual(
    CURRENCIES.slice(0, 9).map((c) => c.symbol),
    ["؋", "$", "€", "A$", "£", "₨", "﷼", "د.إ", "₺"],
    "existing currency symbols stay stable",
  );
  for (const code of [
    "INR",
    "CNY",
    "SAR",
    "BDT",
    "CAD",
    "JPY",
    "CHF",
    "ZAR",
    "XOF",
    "XAF",
    "XCG",
    "ZWG",
    "SVC",
    "VED",
  ]) {
    assert.ok(
      CURRENCIES.some((c) => c.code === code),
      `${code} is selectable`,
    );
  }
  for (const code of [
    "XXX",
    "XTS",
    "XAU",
    "XAG",
    "XDR",
    "CLF",
    "USN",
    "UYW",
    "ZWL",
    "ANG",
    "HRK",
  ]) {
    assert.ok(
      !CURRENCIES.some((c) => c.code === code),
      `${code} is not a current everyday monetary choice`,
    );
  }
  assert.deepEqual(
    CURRENCIES.filter((c) => c.minorUnits > 2)
      .map((c) => c.code)
      .sort(),
    ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"],
  );
  assert.equal(currency.getCurrentCurrencyCode(), "AFN");
  assert.equal(currency.getCurrentCurrencySymbol(), "؋");
  for (const item of CURRENCIES) {
    assert.match(item.code, /^[A-Z]{3}$/);
    assert.ok(item.name.trim() && item.nameFa.trim() && item.namePs.trim() && item.symbol.trim());
    assert.ok(Number.isInteger(item.minorUnits) && item.minorUnits >= 0);
    for (const lang of ["en", "fa", "ps"] as const) {
      const name = getCurrencyNameForLocale(item.code, lang);
      assert.ok(
        searchCurrencies(name, lang).some((c) => c.code === item.code),
        `${lang} name finds ${item.code}`,
      );
      assert.ok(
        searchCurrencies(item.code.toLowerCase(), lang).some((c) => c.code === item.code),
        `${lang} ISO search finds ${item.code}`,
      );
      locale = lang;
      assert.equal(currency.getCurrencyName(item.code), name);
    }
    for (const alias of item.searchAliases) {
      assert.ok(
        searchCurrencies(alias, "ps").some((c) => c.code === item.code),
        `country/original-name alias ${alias} finds ${item.code}`,
      );
    }
    currency.setCurrentCurrency(item.code);
    assert.equal(currency.getCurrentCurrencyCode(), item.code);
    assert.equal(currency.getCurrentCurrencySymbol(), item.symbol);
    assert.equal(currency.getCurrencySymbol(item.code), item.symbol);
    assert.equal(currency.currencyNeedsPrecisionHint(), item.minorUnits > 2);
    preferences.set("default_currency", item.code);
    currency.setCurrentCurrency("AFN");
    await currency.initCurrencyFromPref();
    assert.equal(
      currency.getCurrentCurrencyCode(),
      item.code,
      "restored preference accepts every currency",
    );
    vaults.set("synthetic-vault", item.code);
    currency.setCurrentCurrency("AFN");
    await currency.applyVaultCurrency("synthetic-vault");
    assert.equal(
      currency.getCurrentCurrencyCode(),
      item.code,
      "active vault applies every currency",
    );
    // Changing the label never changes ledger units, calculations or balances.
    assert.equal(sumAmounts([100, 0.29, 0.01]), 100.3);
    assert.equal(formatMoneyAmount(100.3), "100.30");
  }
  assert.deepEqual(searchCurrencies("   ", "en"), CURRENCIES);
  assert.deepEqual(searchCurrencies("no-such-currency-123", "ps"), []);
  assert.ok(searchCurrencies("€", "fa").some((c) => c.code === "EUR"));
  assert.equal(searchCurrencies("₨", "en")[0]?.code, "PKR");
  assert.equal(searchCurrencies("kwd", "fa")[0]?.code, "KWD");
  for (const query of ["Canada", "کانادا", "کاناډا"]) {
    assert.ok(searchCurrencies(query, "ps").some((c) => c.code === "CAD"));
  }
  for (const query of ["ایرانی", "ايراني", "IRR"]) {
    assert.ok(searchCurrencies(query, "en").some((c) => c.code === "IRR"));
  }
  assert.ok(searchCurrencies(" rupee ", "en").some((c) => c.code === "INR"));
  assert.equal(currency.getCurrencyName("XYZ"), "XYZ", "unknown names are never mislabeled as AFN");
  assert.equal(currency.getCurrencySymbol("XYZ"), "XYZ");
  currency.setCurrentCurrency("INR");
  currency.setCurrentCurrency("XYZ");
  preferences.set("default_currency", "XYZ");
  await currency.initCurrencyFromPref();
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "INR",
    "invalid preference leaves known currency intact",
  );
  vaults.set("unknown", "XYZ");
  await currency.applyVaultCurrency("unknown");
  await currency.applyVaultCurrency(null);
  await currency.applyVaultCurrency("missing");
  assert.equal(currency.getCurrentCurrencyCode(), "INR");
  unreadable = true;
  await currency.initCurrencyFromPref();
  await currency.applyVaultCurrency("synthetic-vault");
  assert.equal(currency.getCurrentCurrencyCode(), "INR");
  // Full third-decimal storage is intentionally outside this catalog update.
  currency.setCurrentCurrency("KWD");
  assert.equal(currency.currencyNeedsPrecisionHint(), true);
  assert.equal(parseAmountInput("1.234"), null);
  assert.equal(parseAmountInput("1.23"), 1.23);
  currency.setCurrentCurrency("AFN");
  assert.equal(currency.currencyNeedsPrecisionHint(), false);
  console.log(
    "Currency selftest passed: 155 currencies, localized search, saved preferences, vault switching and money contract.",
  );
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
