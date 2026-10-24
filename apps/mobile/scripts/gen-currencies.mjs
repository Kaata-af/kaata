// Generate the complete offline currency catalog; no network access is used.
//   node apps/mobile/scripts/gen-currencies.mjs [--check]
//
// SIX is the ISO 4217 Maintenance Agency. Its pinned current List One supplies
// codes, ISO minor units, fund markers, and country aliases. Unicode CLDR 49
// supplies localized currency/territory names and display symbols. See the
// checked-in source notices in scripts/data/currencies/.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceHashes = {
  "iso-4217.xml": "0a02b74bc807b11dccfb6402d9e9d39b3b0fd0d02d20306172c1b5c69d9cbe36",
  "currencies-en.json": "50c29c39b6d54444e2e0e72245c22e75ff567d85060da9a531e3590aa4064f66",
  "currencies-fa-AF.json": "d7899dab43e249a30f6509706f80735628ddd20f1656cc49f0ba9a166c41c986",
  "currencies-ps.json": "322359c6f822c3a14d382167dfa3b18674acba95cc7c7e991671eedd6cd544c6",
  "territories-en.json": "1326fb3bcdf8b8cf63df73ea02ea7f8bf7a8362cbb60bd12bcdb53f3ad22bf04",
  "territories-fa-AF.json": "3934dc2de86ff6f3cbe94d8e21d99db3fdb15494a75ca648e59648b78c99b500",
  "territories-ps.json": "1658c008691ef3c8fa44968beba39648cc977314c2d77b0c3ee70a297a5fb8d7",
  "currency-data.json": "c187138fb1a91508056924caa7e11a63d4d579c2f34176949afa817f7ed63715",
};
const sources = Object.fromEntries(
  Object.entries(sourceHashes).map(([filename, expectedHash]) => {
    // Hash canonical LF so Git's Windows CRLF setting does not affect checks.
    const source = readFileSync(new URL(`./data/currencies/${filename}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
      throw new Error(`Pinned currency source changed: ${filename}`);
    }
    return [filename, source];
  }),
);
const locales = ["en", "fa-AF", "ps"];
const localizedCurrencies = Object.fromEntries(locales.map((locale) => [
  locale,
  JSON.parse(sources[`currencies-${locale}.json`]).main[locale].numbers.currencies,
]));
const territories = Object.fromEntries(locales.map((locale) => [
  locale,
  JSON.parse(sources[`territories-${locale}.json`]).main[locale].localeDisplayNames.territories,
]));
const usages = JSON.parse(sources["currency-data.json"]).supplemental.currencyData.region;
const asOf = "2026-10-24";

function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity];
  }).trim();
}
function tag(row, name) {
  const match = row.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : "";
}

// This intentionally parses the small, hash-pinned SIX schema, not arbitrary
// XML. Fund-marked rows and codes without ISO minor units are not everyday
// currencies (metals, SDR, accounting/bond units, testing, or no currency).
const isoCurrencies = new Map();
const excluded = new Set();
for (const [, row] of sources["iso-4217.xml"].matchAll(/<CcyNtry>([\s\S]*?)<\/CcyNtry>/g)) {
  const code = tag(row, "Ccy");
  if (!code) continue; // An ISO entity may explicitly have no universal currency.
  const minorUnitsText = tag(row, "CcyMnrUnts");
  if (/<CcyNm\s[^>]*IsFund="true"/.test(row) || minorUnitsText === "N.A.") {
    excluded.add(code);
    continue;
  }
  const minorUnits = Number(minorUnitsText);
  if (!/^[A-Z]{3}$/.test(code) || !/^[023]$/.test(minorUnitsText)) {
    throw new Error(`Unexpected current ISO currency metadata for ${code}`);
  }
  const existing = isoCurrencies.get(code);
  if (existing && existing.minorUnits !== minorUnits) {
    throw new Error(`Inconsistent ISO minor units for ${code}`);
  }
  const item = existing ?? { code, minorUnits, isoName: tag(row, "CcyNm"), countryAliases: new Set() };
  item.countryAliases.add(tag(row, "CtryNm"));
  isoCurrencies.set(code, item);
}
if (isoCurrencies.size !== 155 || excluded.size !== 23) {
  throw new Error(`Review ISO coverage: ${isoCurrencies.size} currencies, ${excluded.size} excluded codes`);
}
for (const code of excluded) {
  if (isoCurrencies.has(code)) throw new Error(`Conflicting currency/fund classification for ${code}`);
}

// Preserve labels and symbols already reviewed for Kaata's Afghan market.
// The remaining two overrides translate current ISO codes absent from CLDR's
// Dari/Pashto names: SVC and VED remain current in SIX even though CLDR treats
// their everyday usage as historical/non-tender. Do not silently drop ISO codes.
const overrides = {
  AFN: { name: "Afghan Afghani", nameFa: "افغانی", namePs: "افغانۍ", symbol: "؋" },
  USD: { name: "US Dollar", nameFa: "دالر امریکا", namePs: "امریکایي ډالر", symbol: "$" },
  EUR: { name: "Euro", nameFa: "یورو", namePs: "یورو", symbol: "€" },
  AUD: { name: "Australian Dollar", nameFa: "دالر آسترالیا", namePs: "اسټرالیايي ډالر", symbol: "A$" },
  GBP: { name: "British Pound", nameFa: "پوند انگلیس", namePs: "برتانوي پونډ", symbol: "£" },
  PKR: { name: "Pakistani Rupee", nameFa: "روپیه پاکستان", namePs: "پاکستانۍ روپۍ", symbol: "₨" },
  IRR: { name: "Iranian Rial", nameFa: "ریال ایران", namePs: "ایراني ریال", symbol: "﷼" },
  AED: { name: "UAE Dirham", nameFa: "درهم امارات", namePs: "د متحده عربي اماراتو درهم", symbol: "د.إ" },
  TRY: { name: "Turkish Lira", nameFa: "لیره ترکیه", namePs: "ترکي لیره", symbol: "₺" },
  SVC: { nameFa: "کولون السالوادور", namePs: "د السلوادور کولون" },
  VED: { name: "Venezuelan Digital Bolívar", nameFa: "بولیوار دیجیتال ونزوئلا", namePs: "د وینزویلا ډیجیټل بولیوار" },
};
const priorityCodes = ["AFN", "USD", "EUR", "AUD", "GBP", "PKR", "IRR", "AED", "TRY"];
const currencies = [...isoCurrencies.values()].map((iso) => {
  const english = localizedCurrencies.en[iso.code];
  const item = {
    code: iso.code,
    name: english?.displayName,
    nameFa: localizedCurrencies["fa-AF"][iso.code]?.displayName,
    namePs: localizedCurrencies.ps[iso.code]?.displayName,
    // Standard English symbols retain distinctions such as CA$ vs US$;
    // narrow symbols would collapse many unrelated currencies to "$".
    symbol: english?.symbol ?? iso.code,
    minorUnits: iso.minorUnits,
    ...overrides[iso.code],
  };
  if (Object.values(item).some((value) => value == null || value === "")) {
    throw new Error(`Missing localized name for ${iso.code}`);
  }
  const aliases = new Set([iso.isoName, ...iso.countryAliases]);
  for (const locale of locales) {
    const originalName = localizedCurrencies[locale][iso.code]?.displayName;
    if (originalName) aliases.add(originalName);
  }
  for (const [region, periods] of Object.entries(usages)) {
    if (!/^[A-Z]{2}$/.test(region)) continue;
    const activeHere = periods.some((period) => {
      const usage = period[iso.code];
      return usage && usage._tender !== "false"
        && (!usage._from || usage._from <= asOf)
        && (!usage._to || usage._to >= asOf);
    });
    if (!activeHere) continue;
    for (const locale of locales) {
      const names = territories[locale];
      if (!names[region]) throw new Error(`Missing ${locale} territory name for ${region}`);
      aliases.add(names[region]);
      if (names[`${region}-alt-short`]) aliases.add(names[`${region}-alt-short`]);
      if (names[`${region}-alt-variant`]) aliases.add(names[`${region}-alt-variant`]);
    }
  }
  for (const ownLabel of [item.code, item.name, item.nameFa, item.namePs, item.symbol]) aliases.delete(ownLabel);
  return { ...item, searchAliases: [...aliases].filter(Boolean).sort() };
});
currencies.sort((a, b) => {
  const aPriority = priorityCodes.indexOf(a.code);
  const bPriority = priorityCodes.indexOf(b.code);
  if (aPriority >= 0 || bPriority >= 0) {
    return (aPriority < 0 ? Infinity : aPriority) - (bPriority < 0 ? Infinity : bPriority);
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.code < b.code ? -1 : 1;
});

const output = `// Generated by scripts/gen-currencies.mjs. Do not edit the catalog by hand.
// 155 current ISO 4217 currencies: SIX List One, published 2026-09-17.
// Excludes fund/accounting-only, precious-metal, testing and no-currency codes.
// Names/country search aliases: Unicode CLDR 49.0.0, en / fa-AF / ps.
// Source notices and Unicode-3.0 license: scripts/data/currencies/.
// Existing nine currencies remain first; the rest use English name ordering.
export type Currency = {
  code: string;
  name: string;
  nameFa: string;
  namePs: string;
  symbol: string;
  // ISO metadata only. Kaata's existing amount storage still uses two decimals.
  minorUnits: number;
  searchAliases: ReadonlyArray<string>;
};

export const CURRENCIES: ReadonlyArray<Currency> = ${JSON.stringify(currencies, null, 2)};

const currenciesByCode = new Map(CURRENCIES.map((currency) => [currency.code, currency]));

export function getCurrencyNameForLocale(code: string, locale: string): string {
  const currency = currenciesByCode.get(code);
  if (!currency) return code;
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return language === "fa" ? currency.nameFa : language === "ps" ? currency.namePs : currency.name;
}

function normalizeCurrencySearch(value: string): string {
  return value.normalize("NFD").replace(/\\p{M}/gu, "")
    .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/\\u200c/g, " ")
    .toLowerCase().trim().replace(/\\s+/g, " ");
}

// Most screens import currency helpers only to render an amount. Build the
// normalized alias index only when someone actually searches the picker.
let searchIndex: ReadonlyArray<{ currency: Currency; text: string }> | undefined;
function getSearchIndex(): ReadonlyArray<{ currency: Currency; text: string }> {
  return searchIndex ??= CURRENCIES.map((currency) => ({
    currency,
    text: normalizeCurrencySearch([
      currency.code, currency.name, currency.nameFa, currency.namePs,
      currency.symbol, ...currency.searchAliases,
    ].join(" ")),
  }));
}

// Search every supported language, regardless of the current app language.
// Country aliases make searches such as "Canada" and "کانادا" useful too.
export function searchCurrencies(query: string, locale = "en"): ReadonlyArray<Currency> {
  const normalized = normalizeCurrencySearch(query);
  if (!normalized) return CURRENCIES;
  const terms = normalized.split(" ");
  const matches = getSearchIndex().filter(({ text }) => terms.every((term) => text.includes(term)))
    .map(({ currency }) => currency);
  const priority = (currency: Currency) => {
    if (currency.code.toLowerCase() === normalized) return 0;
    if (normalizeCurrencySearch(currency.symbol) === normalized) return 1;
    if (normalizeCurrencySearch(getCurrencyNameForLocale(currency.code, locale)).startsWith(normalized)) return 2;
    return 3;
  };
  return matches.sort((a, b) => priority(a) - priority(b));
}
`;
const target = new URL("../lib/currency-catalog.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8").replace(/\r\n/g, "\n") !== output) {
    throw new Error("currency-catalog.ts is out of date");
  }
  console.log(`Verified ${currencies.length} current currencies with three-language names and country search`);
} else {
  writeFileSync(target, output);
  console.log(`Generated ${currencies.length} current currencies in ${fileURLToPath(target)}`);
}
