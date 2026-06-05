import { getAppMeta } from "./db";

// Multi-country phone normalization. Afghan numbers stay the strict-format
// canonical input; everything else (Afghan diaspora destinations, neighbours)
// is accepted with a permissive E.164 check (+ followed by 6-15 digits).
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

export type Country = {
  code: string; // ISO 3166 alpha-2
  name: string;
  dialCode: string; // e.g., "+93"
  flag: string;
};

// Curated list. Afghanistan first (default for the local market), then the
// destinations Afghan shopkeepers most often have contacts in: neighbours
// (PK, IR), Gulf (AE), diaspora hubs (DE, NL, SE, TR, GB, US), plus AU since
// it came up. Order matters: AF is the default; otherwise alphabetical so
// the picker reads naturally.
export const COUNTRIES: Country[] = [
  { code: "AF", name: "Afghanistan", dialCode: "+93", flag: "🇦🇫" },
  { code: "AU", name: "Australia", dialCode: "+61", flag: "🇦🇺" },
  { code: "DE", name: "Germany", dialCode: "+49", flag: "🇩🇪" },
  { code: "IR", name: "Iran", dialCode: "+98", flag: "🇮🇷" },
  { code: "NL", name: "Netherlands", dialCode: "+31", flag: "🇳🇱" },
  { code: "PK", name: "Pakistan", dialCode: "+92", flag: "🇵🇰" },
  { code: "SE", name: "Sweden", dialCode: "+46", flag: "🇸🇪" },
  { code: "TR", name: "Turkey", dialCode: "+90", flag: "🇹🇷" },
  { code: "AE", name: "UAE", dialCode: "+971", flag: "🇦🇪" },
  { code: "GB", name: "United Kingdom", dialCode: "+44", flag: "🇬🇧" },
  { code: "US", name: "United States", dialCode: "+1", flag: "🇺🇸" },
];

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

// Normalizes a user-typed phone number to E.164. The `countryCode` argument
// is used only as a fallback when the input doesn't already include a country
// prefix (+, 00) — if the user types `+61412345678` the AF default is ignored.
//
// Validation: strict for AF mobiles (+93 7XXXXXXXX); generic E.164 shape
// otherwise.
export function normalizePhone(
  input: string | null | undefined,
  countryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  if (input == null) return null;
  // Strip everything except digits and a single leading '+'.
  let cleaned = input.trim().replace(/[^\d+]/g, "");
  if (cleaned.length > 1) {
    cleaned = cleaned[0] + cleaned.slice(1).replace(/\+/g, "");
  }
  if (!cleaned) return null;

  // If the user wrote a country prefix themselves, trust it over the picker.
  let e164: string;
  if (cleaned.startsWith("+")) {
    e164 = cleaned;
  } else if (cleaned.startsWith("00")) {
    e164 = "+" + cleaned.slice(2);
  } else {
    // National number — prefix with the selected country's dial code.
    // Strip a leading '0' (trunk prefix; common AF / European convention).
    const national = cleaned.startsWith("0") ? cleaned.slice(1) : cleaned;
    const country = getCountry(countryCode);
    e164 = country.dialCode + national;
  }

  if (e164.startsWith("+93")) {
    return E164_AF_MOBILE.test(e164) ? e164 : null;
  }
  return E164_GENERIC.test(e164) ? e164 : null;
}

// Best-effort reverse lookup: which country's dial code does this E.164 start
// with? Used to pre-select the picker when editing an existing contact. We
// scan in dial-code-length-descending order so longer prefixes win — without
// this, "+1" would pre-empt a hypothetical "+1XXX" entry. Falls back to AF.
//
// Ambiguity caveat: when two countries share a dial code (e.g., +1 covers US
// and CA), the first matching entry wins. The picker is for input convenience
// only — the stored number is unambiguous either way.
export function inferCountryFromE164(e164: string | null | undefined): string {
  if (!e164) return DEFAULT_COUNTRY_CODE;
  const sorted = [...COUNTRIES].sort((a, b) => b.dialCode.length - a.dialCode.length);
  for (const c of sorted) {
    if (e164.startsWith(c.dialCode)) return c.code;
  }
  return DEFAULT_COUNTRY_CODE;
}

// Formats an E.164 number for human reading. AF gets the familiar 70 123 4567
// grouping; everything else is shown as "+CC rest" (no per-country grouping
// logic, which would require libphonenumber-sized rules we don't want yet).
export function formatPhoneForDisplay(e164: string): string {
  if (E164_AF_MOBILE.test(e164)) {
    const rest = e164.slice(3);
    return `+93 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}`;
  }
  const sorted = [...COUNTRIES].sort((a, b) => b.dialCode.length - a.dialCode.length);
  for (const c of sorted) {
    if (e164.startsWith(c.dialCode)) {
      const rest = e164.slice(c.dialCode.length);
      return `${c.dialCode} ${rest}`;
    }
  }
  return e164;
}
