// Synthetic preferences/vaults only. No native database or network is opened.
import assert from "node:assert/strict";
import { CURRENCIES, getCurrencyNameForLocale, searchCurrencies } from "../currency-catalog";
import { compileUI, jsx, uiHooks } from "./ui-fixture";
import { formatMoneyAmount, parseAmountInput, sumAmounts } from "../money";
import * as currencyScope from "../currency-scope";
import * as currencySettings from "../currency-settings";

let locale = "en";
const preferences = new Map<string, string>();
type Vault = {
  currency: string;
  legacy_currency?: string;
  default_entry_currency?: string;
  defaultValue?: string;
  enabledValue?: string;
  usedCurrencies?: string[];
};
const vaults = new Map<string, Vault>();
let activeVault: string | null = null;
let unreadable = false;
let heldRead: { vaultId: string; promise: Promise<void> } | undefined;
let onDiscover: (() => void) | undefined;
const hooks = uiHooks();
const currency = compileUI("../currency", {
  react: hooks.react,
  "./currency-catalog": require("../currency-catalog"),
  "./currency-scope": currencyScope,
  "./currency-settings": currencySettings,
  "./i18n": { getLocale: () => locale },
  "./db": {
    getAppMeta: async (key: string) => {
      if (unreadable) throw new Error("Synthetic unavailable preference");
      return preferences.get(key) ?? null;
    },
    setAppMeta: async (key: string, value: string) => {
      preferences.set(key, value);
    },
    listLedgerCurrencies: async (id: string) => {
      const used = vaults.get(id)?.usedCurrencies ?? [];
      onDiscover?.();
      return used;
    },
  },
  "./db-tx": {
    getActiveVaultIdSyncMaybe: () => activeVault,
    getDb: async () => ({
      getFirstAsync: async (sql: string, id: string) => {
        if (unreadable) throw new Error("Synthetic unavailable vault");
        if (heldRead?.vaultId === id) await heldRead.promise;
        const row = vaults.get(id);
        if (!row) return null;
        if (sql.startsWith("SELECT value FROM vault_settings")) {
          return { value: row.defaultValue ?? null };
        }
        if (sql.startsWith("SELECT default_entry_currency,")) {
          return { default_entry_currency: row.default_entry_currency, value: row.defaultValue };
        }
        if (sql.startsWith("SELECT currency, default_entry_currency FROM vaults")) {
          return { currency: row.currency, default_entry_currency: row.default_entry_currency };
        }
        assert.ok(sql.startsWith("SELECT currency, legacy_currency, default_entry_currency"));
        return { ...row, default_value: row.defaultValue, enabled_value: row.enabledValue };
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
    activeVault = null;
    currency.setCurrentCurrency(item.code);
    assert.equal(currency.getCurrentCurrencyCode(), item.code);
    assert.equal(currency.getCurrentCurrencySymbol(), item.symbol);
    assert.equal(currency.getCurrencySymbol(item.code), item.symbol);
    assert.equal(currency.currencyNeedsPrecisionHint(), item.minorUnits > 2);
    currency.setCurrentCurrency("AFN");
    preferences.set("default_currency", item.code);
    await currency.initCurrencyFromPref();
    assert.equal(
      currency.getCurrentCurrencyCode(),
      item.code,
      "restored preference accepts every currency",
    );
    const id = `catalog-${item.code}`;
    vaults.set(id, { currency: item.code, default_entry_currency: item.code });
    currency.setCurrentCurrency("AFN");
    activeVault = id;
    await currency.applyVaultCurrency(id);
    assert.equal(
      currency.getCurrentCurrencyCode(),
      item.code,
      "active vault applies every currency",
    );
    // ISO minor-unit metadata does not change the app's two-decimal arithmetic.
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
  activeVault = null;
  currency.setCurrentCurrency("INR");
  currency.setCurrentCurrency("invalid");
  preferences.set("default_currency", "usd");
  await currency.initCurrencyFromPref();
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "INR",
    "invalid preference leaves known currency intact",
  );
  await currency.applyVaultCurrency(null);
  assert.equal(currency.getCurrentCurrencyCode(), "INR");
  unreadable = true;
  await currency.initCurrencyFromPref();
  activeVault = "unreadable";
  await currency.applyVaultCurrency("unreadable");
  assert.equal(currency.getCurrentCurrencyCode(), "INR");
  unreadable = false;
  activeVault = "missing";
  await currency.applyVaultCurrency("missing");
  assert.equal(currency.getCurrentCurrencyCode(), "AFN", "a missing book has a safe view fallback");

  vaults.set("one", {
    currency: "AFN",
    legacy_currency: "AFN",
    default_entry_currency: "USD",
    defaultValue: '"USD"',
    enabledValue: '["USD","EUR"]',
    usedCurrencies: ["GBP"],
  });
  vaults.set("two", { currency: "JPY", default_entry_currency: "JPY" });
  activeVault = "one";
  await currency.applyVaultCurrency("one");
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "USD",
    "an unseen view starts at the entry default",
  );
  assert.deepEqual(await currency.getEnabledCurrencies("one"), ["USD", "EUR"]);
  const renderCurrency = () =>
    hooks.render(() => jsx("Currency", { value: currency.useCurrency() }));
  renderCurrency();
  await currency.selectLedgerCurrency("EUR", "one");
  assert.equal(renderCurrency().props.value, "EUR", "mounted views follow the selected currency");
  assert.equal(preferences.get("selected_currency:one"), "EUR");
  assert.equal(await currency.getDefaultEntryCurrency("one"), "USD");
  assert.equal(vaults.get("one")!.legacy_currency, "AFN");
  assert.deepEqual(await currency.getEnabledCurrencies("one"), ["USD", "EUR"]);

  activeVault = "two";
  await currency.applyVaultCurrency("two");
  assert.equal(currency.getCurrentCurrencyCode(), "JPY");
  await currency.selectLedgerCurrency("CAD", "two");
  activeVault = "one";
  await currency.applyVaultCurrency("one");
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "EUR",
    "each book restores its own selected view",
  );
  await currency.selectLedgerCurrency("CHF", "two");
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "EUR",
    "an inactive book cannot change the live view",
  );
  activeVault = "two";
  await currency.applyVaultCurrency("two");
  assert.equal(currency.getCurrentCurrencyCode(), "CHF");
  assert.equal(await currency.getDefaultEntryCurrency("two"), "JPY");

  vaults.set("legacy", {
    currency: "AFN",
    legacy_currency: "AFN",
    default_entry_currency: "USD",
    usedCurrencies: ["GBP", "GBP", "bad"],
  });
  assert.deepEqual(await currency.getEnabledCurrencies("legacy"), ["AFN", "GBP", "USD"]);
  vaults.get("legacy")!.enabledValue = '["EUR"]';
  assert.deepEqual(
    await currency.getEnabledCurrencies("legacy"),
    ["EUR", "USD"],
    "current default remains enabled when concurrent settings omit it",
  );
  delete vaults.get("legacy")!.enabledValue;
  onDiscover = () => {
    vaults.get("legacy")!.enabledValue = '["JPY"]';
  };
  assert.deepEqual(
    await currency.getEnabledCurrencies("legacy"),
    ["JPY", "USD"],
    "an explicit synced list arriving during discovery wins over old used codes",
  );
  onDiscover = undefined;

  let release!: () => void;
  heldRead = {
    vaultId: "one",
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  activeVault = "one";
  const late = currency.applyVaultCurrency("one");
  await Promise.resolve();
  activeVault = "two";
  release();
  await late;
  heldRead = undefined;
  assert.equal(
    currency.getCurrentCurrencyCode(),
    "CHF",
    "a late read from the previous book cannot repaint the current view",
  );

  activeVault = null;
  // Full third-decimal storage is intentionally outside this catalog update.
  currency.setCurrentCurrency("KWD");
  assert.equal(currency.currencyNeedsPrecisionHint(), true);
  assert.equal(parseAmountInput("1.234"), null);
  assert.equal(parseAmountInput("1.23"), 1.23);
  currency.setCurrentCurrency("AFN");
  assert.equal(currency.currencyNeedsPrecisionHint(), false);
  hooks.unmount();
  console.log(
    "Currency selftest passed: 155 currencies, localized search, scoped selected/default/enabled settings, late-read guards and two-decimal money contract.",
  );
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
