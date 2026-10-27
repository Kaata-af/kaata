# Currency catalog sources

The mobile app bundles the generated `lib/currency-catalog.ts`; it does not
download currency data at runtime. Regenerate with
`node apps/mobile/scripts/gen-currencies.mjs`, or verify with `--check`.
The generator checks SHA-256 hashes after normalizing line endings to LF.

## Current ISO 4217 codes

- Publisher: SIX, the ISO 4217 Maintenance Agency.
- Register: [List One: Current Currency & Funds](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml).
- Publication date in the downloaded XML: 2026-09-17.
- Source and explanation: [SIX Financial Data Standards](https://www.six-group.com/en/products-services/financial-information/market-reference-data/data-standards.html).
- Snapshot downloaded on 2026-10-24 as `iso-4217.xml`.

The register contains 178 distinct codes. The picker includes all 155 codes
with a numeric minor unit that are not marked `IsFund="true"`. The 23 excluded
codes describe fund/accounting units, precious metals, SDR, bond units,
testing, or transactions without a currency. Historical currencies from
List Three are excluded. SVC and VED remain selectable because SIX still
lists them in List One, even though Unicode no longer considers them
everyday tender currencies.

The ISO minor-unit value is retained as metadata. It does not change Kaata's
existing two-decimal amount-storage contract, convert balances, or apply a
new rounding policy.

## Localized labels, symbols, and country search

All Unicode snapshots are pinned to [CLDR JSON 49.0.0](https://github.com/unicode-org/cldr-json/tree/49.0.0/cldr-json):

- `cldr-numbers-full/main/{en,fa-AF,ps}/currencies.json` →
  `currencies-{locale}.json`.
- `cldr-localenames-full/main/{en,fa-AF,ps}/territories.json` →
  `territories-{locale}.json`.
- `cldr-core/supplemental/currencyData.json` → `currency-data.json`.
- [Upstream LICENSE](https://github.com/unicode-org/cldr-json/blob/49.0.0/LICENSE) → `LICENSE`.

Currency names use English, Afghan Dari (`fa-AF`), and Pashto (`ps`). The nine
previously reviewed Kaata labels and symbols are preserved. SVC and VED lack
Dari/Pashto CLDR names, so their translations are explicit generator
overrides. New currencies use the standard English symbol or their ISO code,
not a narrow symbol that would collapse many currencies into `$` or `Rs`.

Search aliases include the ISO English currency/entity names, original CLDR
currency labels, and localized names of territories using each currency on
2026-10-24 according to CLDR. They are search aids, not a statement that a
currency is the only tender in a territory. The picker displays the ISO code
alongside the localized name so shared symbols remain distinguishable.
