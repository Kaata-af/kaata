import { getAppMeta } from "./db";
import type { LocaleCode } from "./i18n";
import { toAsciiDigits } from "./digits";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/core";
import phoneMetadata from "libphonenumber-js/metadata.min.json";
import { COUNTRIES, type Country } from "./phone-countries";

export { COUNTRIES, type Country } from "./phone-countries";

// Multi-country phone normalization. Both Afghan numbers and international
// contacts (diaspora destinations, neighbours) are accepted with a permissive
// E.164 shape check (+ followed by 7-15 digits), including landlines.
//
// This module is the ONLY place that decides what a phone number means.
// Callers must pass user input through verbatim — pre-cleaning it upstream
// (stripping a leading 0, slicing a dial code) breaks the branches below and
// silently produces a valid-shaped but wrong number. See normalizePhone.
//
// Storage is always the E.164 string. Country code on the input screen is a
// UX hint that disambiguates a national number — it's not persisted; it's
// inferred from the dial code on load when editing.
//
// Default country (the preselected entry in the picker on new-person /
// new-entry screens) is user-configurable via Preferences. The choice is
// persisted in app_meta under "default_country_code" and read into a
// module-global on startup via initDefaultCountryFromPref(), same pattern
// as currency in lib/currency.ts.

/** Localized picker label; stored country and dial codes are unchanged. */
export function getCountryName(code: string, locale: LocaleCode): string {
  const country = getCountry(code);
  return locale === "ps" ? country.namePs : locale === "fa" ? country.nameFa : country.name;
}

export const DEFAULT_COUNTRY_CODE = "AF";

// Module-global mirror of app_meta.default_country_code. Set on startup
// by initDefaultCountryFromPref(); callers read synchronously via
// getCurrentDefaultCountryCode() without prop-drilling. Falls back to
// DEFAULT_COUNTRY_CODE (AF) until the init completes, which is fine
// because phone-input screens (person/new, person/[id]/edit) only mount
// after the app has booted past initDb + Promise.all of the init calls
// in _layout.tsx.
let currentDefaultCountryCode: string = DEFAULT_COUNTRY_CODE;

export function getCurrentDefaultCountryCode(): string {
  return currentDefaultCountryCode;
}

// Imperative setter for the active default. Caller is responsible for
// also persisting via setAppMeta("default_country_code", code) — same
// contract as setCurrentCurrency.
export function setCurrentDefaultCountryCode(code: string): void {
  if (COUNTRIES.some((c) => c.code === code)) {
    currentDefaultCountryCode = code;
  }
}

// Called from _layout.tsx during init alongside locale + currency.
// Reads app_meta and applies the saved choice before the first
// person/new mount so the picker pre-selects the user's country.
export async function initDefaultCountryFromPref(): Promise<void> {
  try {
    const stored = await getAppMeta("default_country_code");
    if (stored && COUNTRIES.some((c) => c.code === stored)) {
      currentDefaultCountryCode = stored;
    }
  } catch {
    // app_meta unreadable — fall back to AF silently.
  }
}

export function getCountry(code: string): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

const E164_AF_MOBILE = /^\+937\d{8}$/;
const E164_GENERIC = /^\+\d{7,15}$/;
// Metadata orders the main region first for shared calling codes. Alphabetical
// picker order must not turn an unrecognized +1 number into American Samoa.
const CALLING_CODE_COUNTRIES = Object.entries(phoneMetadata.country_calling_codes)
  .flatMap(([dialCode, countries]) => {
    const code = countries.find((candidate) =>
      COUNTRIES.some((country) => country.code === candidate),
    );
    return code ? [{ dialCode: "+" + dialCode, code }] : [];
  })
  .sort((a, b) => b.dialCode.length - a.dialCode.length);

// Normalizes a user-typed phone number to E.164. The `countryCode` argument
// is used only as a fallback when the input doesn't already include a country
// prefix (+, 00) — if the user types `+61412345678` the AF default is ignored.
//
// Validation checks generic E.164 shape for every country; it does not verify
// that the number is assigned or reachable.
export function normalizePhone(
  input: string | null | undefined,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  if (input == null) return null;
  // Transliterate Persian/Arabic-Indic digits first — Persian keyboards emit
  // U+06F0-9, which /[^\d+]/ would otherwise strip as "not a digit",
  // rejecting perfectly valid numbers typed by Persian-locale users.
  // Then strip everything except digits and a single leading '+'.
  let cleaned = toAsciiDigits(input.trim()).replace(/[^\d+]/g, "");
  if (cleaned.length > 1) {
    cleaned = cleaned[0] + cleaned.slice(1).replace(/\+/g, "");
  }
  if (!cleaned) return null;

  // Keep Kaata's existing convention that 00 explicitly starts an international
  // number, even in countries whose telephone network uses a different IDD.
  // An explicit international prefix always takes precedence over the picker.
  const explicit = cleaned.startsWith("+") || cleaned.startsWith("00");
  const number = cleaned.startsWith("00") ? "+" + cleaned.slice(2) : cleaned;
  const country = getCountry(countryCode);
  const parsed = parsePhoneNumberFromString(
    number,
    { defaultCountry: country.code as CountryCode, extract: false },
    phoneMetadata,
  );

  // Numbering-plan metadata removes actual national prefixes (AF/AU/DE's 0,
  // Russia's 8, Hungary's 06, etc.) while preserving significant digits such as
  // Italy/Vatican's leading 0. It also disambiguates an omitted '+' against real
  // national area codes, rather than blindly removing a matching calling code.
  // Parsing is deliberately NOT a validity gate: unassigned numbers, landlines
  // and newly allocated ranges still follow the same permissive shape policy.
  const e164 = parsed?.number ?? (explicit ? number : country.dialCode + number);

  // Afghanistan: accept mobiles (+937XXXXXXXX) AND landlines / "digital" numbers
  // like Kabul 020-XXX-XXXX (-> +9320XXXXXXX). The old strict mobile-only regex
  // rejected landlines, which shopkeepers legitimately have, so a contact simply
  // couldn't be added. Use the generic E.164 length check for AF too — storage +
  // uniqueness key are still the normalized E.164; only the over-strict
  // validation gate is relaxed. (E164_AF_MOBILE is still used for display.)
  return E164_GENERIC.test(e164) ? e164 : null;
}

// Use numbering-plan prefixes to distinguish countries that share a calling
// code (+1, +7, +44, +39, +262...). A calling code alone cannot distinguish
// US from Canada or Italy from Vatican City. The fallback is only for a number
// whose country metadata cannot identify; it never changes the stored number.
export function inferCountryFromE164(e164: string | null | undefined): string {
  if (!e164) return DEFAULT_COUNTRY_CODE;
  const parsed = parsePhoneNumberFromString(e164, { extract: false }, phoneMetadata);
  if (parsed?.country && COUNTRIES.some((country) => country.code === parsed.country)) {
    return parsed.country;
  }
  for (const c of CALLING_CODE_COUNTRIES) {
    if (e164.startsWith(c.dialCode)) return c.code;
  }
  return DEFAULT_COUNTRY_CODE;
}

// Formats an E.164 number for human reading. AF gets the familiar 70 123 4567
// grouping; everything else keeps the existing compact "+CC rest" presentation.
export function formatPhoneForDisplay(e164: string): string {
  if (E164_AF_MOBILE.test(e164)) {
    const rest = e164.slice(3);
    return `+93 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  const parsed = parsePhoneNumberFromString(e164, { extract: false }, phoneMetadata);
  if (parsed && e164.startsWith("+" + parsed.countryCallingCode)) {
    const dialCode = "+" + parsed.countryCallingCode;
    return `${dialCode} ${e164.slice(dialCode.length)}`;
  }
  for (const c of CALLING_CODE_COUNTRIES) {
    if (e164.startsWith(c.dialCode)) {
      const rest = e164.slice(c.dialCode.length);
      return `${c.dialCode} ${rest}`;
    }
  }
  return e164;
}
