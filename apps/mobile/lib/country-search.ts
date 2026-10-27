import { COUNTRIES, type Country } from "./phone-countries";
import { toAsciiDigits } from "./digits";

// Search aliases only: labels and stored ISO/calling codes stay canonical.
const ALIASES: Record<string, string> = {
  AE: "UAE United Arab Emirates",
  GB: "UK Britain Great Britain United Kingdom",
  US: "USA United States of America",
};

function normalizeSearch(value: string): string {
  return toAsciiDigits(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200d\u0640\u200e\u200f\u2066-\u2069]/g, "")
    .replace(/[+().,'’&\-]/g, " ")
    .toLowerCase()
    .trim();
}

const SEARCH_INDEX = COUNTRIES.map((country) => ({
  country,
  text: normalizeSearch(
    `${country.name} ${country.nameFa} ${country.namePs} ${country.code} ${country.dialCode} ${ALIASES[country.code] ?? ""}`,
  ),
}));

/** Match names in all app languages, ISO codes or calling codes, including
 * Persian/Arabic keypad digits. This never touches a stored phone number. */
export function searchCountries(query: string): Country[] {
  const digits = toAsciiDigits(query).replace(/[\s().\-]/g, "");
  if (/^\+?\d+$/.test(digits)) {
    const prefix = digits.replace(/^\+/, "").replace(/^00(?=\d)/, "");
    return COUNTRIES.filter((country) => country.dialCode.slice(1).startsWith(prefix));
  }
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return COUNTRIES;
  const matches = SEARCH_INDEX.filter(({ text }) => terms.every((term) => text.includes(term))).map(
    ({ country }) => country,
  );
  // "US" should put United States before names such as Australia; other
  // matching names remain available underneath the exact ISO-code result.
  const exactCode = terms.length === 1 ? terms[0].toUpperCase() : "";
  const exactIndex = matches.findIndex((country) => country.code === exactCode);
  if (exactIndex > 0) matches.unshift(...matches.splice(exactIndex, 1));
  return matches;
}
