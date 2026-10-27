// Phone identity matching for contact suggestions and phone-book writes. Pure:
// no database, native contacts, persisted default country, or device access.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/core";
import phoneMetadata from "libphonenumber-js/metadata.min.json";
import { toAsciiDigits } from "./digits";

const E164_SHAPE = /^\+\d{7,15}$/;

function cleanedPhone(phone: string | null | undefined): string {
  return toAsciiDigits((phone ?? "").trim()).replace(/[^\d+]/g, "");
}

export function isInternationalPhone(phone: string | null | undefined): boolean {
  return /^(\+|00)/.test(cleanedPhone(phone));
}

function international(phone: string) {
  const input = phone.startsWith("00") ? "+" + phone.slice(2) : phone;
  const parsed = parsePhoneNumberFromString(input, { extract: false }, phoneMetadata);
  const number = parsed?.number ?? input;
  if (!E164_SHAPE.test(number)) return null;
  // Non-geographic numbers have no national country context. Shared calling
  // codes fall back to their main region, whose national prefixes are shared.
  const country =
    parsed?.country ??
    phoneMetadata.country_calling_codes[parsed?.countryCallingCode ?? ""]?.find(
      (code) => code in phoneMetadata.countries,
    );
  return { number, country };
}

function knownRegion(country: string | null | undefined): CountryCode | null {
  const code = (country ?? "").toUpperCase();
  return code in phoneMetadata.countries ? (code as CountryCode) : null;
}

function national(phone: string, country: string | null | undefined) {
  const code = knownRegion(country);
  if (!code) return null;
  const parsed = parsePhoneNumberFromString(
    phone,
    { defaultCountry: code as CountryCode, extract: false },
    phoneMetadata,
  );
  return parsed && E164_SHAPE.test(parsed.number)
    ? { number: parsed.number, country: parsed.country ?? (code as CountryCode) }
    : null;
}

/** Use a native contact's explicit prefix or supplied country hint. Unknown
 * national numbers remain unassigned, rather than guessing the app default. */
export function normalizeContactPhone(
  phone: string | null | undefined,
  countryCode?: string,
): string | null {
  const cleaned = cleanedPhone(phone);
  if (!cleaned) return null;
  return (
    (isInternationalPhone(cleaned) ? international(cleaned) : national(cleaned, countryCode))
      ?.number ?? null
  );
}

/** Compare complete numbers, never suffixes. A national number may use the
 * explicit counterpart's country context; two national-only values have no
 * reliable country context, so every digit must agree. */
export function samePhoneNumber(
  left: string | null | undefined,
  right: string | null | undefined,
  leftCountryCode?: string,
  rightCountryCode?: string,
): boolean {
  const a = cleanedPhone(left);
  const b = cleanedPhone(right);
  if (!a || !b) return false;
  const aInternational = isInternationalPhone(a);
  const bInternational = isInternationalPhone(b);
  const identifiedA = aInternational ? international(a) : national(a, leftCountryCode);
  const identifiedB = bInternational ? international(b) : national(b, rightCountryCode);
  if (identifiedA && identifiedB) return identifiedA.number === identifiedB.number;
  // A known native country is stronger evidence than the other number's
  // country. A failed parse must not silently retry that card under a new plan.
  if (!aInternational && knownRegion(leftCountryCode) && !identifiedA) return false;
  if (!bInternational && knownRegion(rightCountryCode) && !identifiedB) return false;
  if ((aInternational && !identifiedA) || (bInternational && !identifiedB)) return false;
  if (identifiedA) return national(b, identifiedA.country)?.number === identifiedA.number;
  if (identifiedB) return national(a, identifiedB.country)?.number === identifiedB.number;
  return !aInternational && !bInternational && a === b;
}

/** The suffix only narrows candidates. A complete samePhoneNumber comparison
 * is always required before a match, including when a bucket has one item.
 * Four digits also covers short national numbers such as Ascension's. */
export class PhoneMatchIndex<T> {
  private readonly buckets = new Map<string, { phone: string; value: T; countryCode?: string }[]>();

  private bucket(phone: string | null | undefined): string {
    return cleanedPhone(phone).replace(/\D/g, "").slice(-4);
  }

  add(phone: string | null | undefined, value: T, countryCode?: string): void {
    const key = this.bucket(phone);
    if (!key || !phone) return;
    const bucket = this.buckets.get(key) ?? [];
    bucket.push({ phone, value, countryCode });
    this.buckets.set(key, bucket);
  }

  replace(oldPhone: string, phone: string, value: T, countryCode?: string): void {
    const key = this.bucket(oldPhone);
    const remaining = this.buckets.get(key)?.filter((entry) => entry.value !== value);
    if (remaining?.length) this.buckets.set(key, remaining);
    else this.buckets.delete(key);
    this.add(phone, value, countryCode);
  }

  find(phone: string | null | undefined, countryCode?: string): T | undefined {
    const key = this.bucket(phone);
    return this.buckets
      .get(key)
      ?.find((entry) => samePhoneNumber(entry.phone, phone, entry.countryCode, countryCode))?.value;
  }
}
