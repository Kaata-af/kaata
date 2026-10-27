// Run with: npx tsx lib/__dev__/phone-selftest.ts
// Synthetic numbering-plan examples only. No database, contacts, or network.
import assert from "node:assert/strict";
import { getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js/core";
import phoneMetadata from "libphonenumber-js/metadata.min.json";
import examples from "libphonenumber-js/examples.mobile.json";
import { compileUI } from "./ui-fixture";
import { COUNTRIES } from "../phone-countries";

let storedCountry: string | null = null;
const phone = compileUI("../phone", {
  "./db": { getAppMeta: async () => storedCountry },
  "./digits": require("../digits"),
  "./phone-countries": require("../phone-countries"),
  "libphonenumber-js/core": require("libphonenumber-js/core"),
  "libphonenumber-js/metadata.min.json": phoneMetadata,
}) as typeof import("../phone");

let checks = 0;
function same(actual: unknown, expected: unknown, message: string): void {
  assert.deepEqual(actual, expected, message);
  checks++;
}

async function main(): Promise<void> {
  same(
    COUNTRIES.map((country) => country.code).sort(),
    getCountries(phoneMetadata).sort(),
    "picker includes every geographic numbering region in the pinned metadata",
  );
  same(
    new Set(COUNTRIES.map((country) => country.code)).size,
    COUNTRIES.length,
    "unique ISO codes",
  );
  same(COUNTRIES[0].code, "AF", "Afghanistan remains the initial default");
  for (const country of COUNTRIES) {
    same(
      country.dialCode,
      "+" + getCountryCallingCode(country.code as CountryCode, phoneMetadata),
      `${country.code} dial code`,
    );
    assert.ok(
      country.name && country.nameFa && country.namePs && country.flag,
      `${country.code} labels`,
    );
  }

  const cases: [string, string, string][] = [
    ["0700 123 456", "AF", "+93700123456"],
    ["۷۰۰۱۲۳۴۵۶", "AF", "+93700123456"],
    ["٠٧٠٠١٢٣٤٥٦", "AF", "+93700123456"],
    ["93 700 123 456", "AF", "+93700123456"],
    ["+93 (0)700 123 456", "AU", "+93700123456"],
    ["020 123 4567", "AF", "+93201234567"],
    ["0412 345 678", "AU", "+61412345678"],
    ["412345678", "AU", "+61412345678"],
    ["61 412 345 678", "AU", "+61412345678"],
    ["+61 (0)412 345 678", "AF", "+61412345678"],
    ["0061 412345678", "AF", "+61412345678"],
    ["0044 20 7946 0018", "US", "+442079460018"],
    ["0491 234567", "DE", "+49491234567"],
    ["491234567", "DE", "+49491234567"],
    ["+49 (0)491 234567", "AF", "+49491234567"],
    ["0313 123456", "NL", "+31313123456"],
    ["0318 123456", "NL", "+31318123456"],
    ["0922 123456", "PK", "+92922123456"],
    ["0923 123456", "PK", "+92923123456"],
    ["046 123456", "SE", "+4646123456"],
    ["02 3660 1832", "IT", "+390236601832"],
    ["+39 02 3660 1832", "AF", "+390236601832"],
    ["06 698 12345", "VA", "+390669812345"],
    ["0039 06 698 12345", "AF", "+390669812345"],
    ["8 (800) 555-35-35", "RU", "+78005553535"],
    ["06 1 234 5678", "HU", "+3612345678"],
    ["01 45 45 32 45", "FR", "+33145453245"],
    ["080 1234 5678", "JP", "+818012345678"],
    ["+1 (416) 555-1234", "AF", "+14165551234"],
    ["(416) 555-1234", "CA", "+14165551234"],
    ["+12425551234", "CA", "+12425551234"],
    ["+77172123456", "AF", "+77172123456"],
    ["+441481256789", "AF", "+441481256789"],
    ["+999 123 4567", "AF", "+9991234567"],
    ["00999 123 4567", "US", "+9991234567"],
    ["12345", "AF", "+9312345"],
  ];
  for (const [input, country, expected] of cases) {
    same(phone.normalizePhone(input, country), expected, `${country}: ${input}`);
    same(phone.normalizePhone(expected, "AF"), expected, `international idempotence: ${expected}`);
  }

  for (const input of [
    null,
    undefined,
    "",
    " ",
    "+",
    "00",
    "123",
    "+123456",
    "+1234567890123456",
  ]) {
    same(phone.normalizePhone(input), null, `shape rejects ${String(input)}`);
  }
  same(
    phone.normalizePhone("+1234567"),
    "+1234567",
    "minimum international shape remains permissive",
  );
  same(phone.normalizePhone("+123456789012345"), "+123456789012345", "maximum international shape");

  const sharedCodes: [string, string][] = [
    ["+14165551234", "CA"],
    ["+12135551234", "US"],
    ["+12425551234", "BS"],
    ["+18685551234", "TT"],
    ["+441481256789", "GG"],
    ["+441534123456", "JE"],
    ["+390669812345", "VA"],
    ["+390236601832", "IT"],
    ["+77172123456", "KZ"],
    ["+74951234567", "RU"],
    ["+262269601234", "YT"],
    ["+262262123456", "RE"],
  ];
  for (const [number, country] of sharedCodes) {
    same(phone.inferCountryFromE164(number), country, `shared prefix: ${number}`);
    const national = number.slice(phone.getCountry(country).dialCode.length);
    same(phone.normalizePhone(national, country), number, `editing ${country} preserves identity`);
  }
  same(phone.inferCountryFromE164(null), "AF", "missing country fallback");
  same(phone.inferCountryFromE164("+9991234567"), "AF", "unknown country fallback");
  same(phone.inferCountryFromE164("+1555123"), "US", "ambiguous +1 uses the main region");
  same(phone.inferCountryFromE164("+7123456789"), "RU", "ambiguous +7 uses the main region");
  same(phone.inferCountryFromE164("+44123456"), "GB", "ambiguous +44 uses the main region");
  same(
    phone.inferCountryFromE164("+80012345678"),
    "AF",
    "non-geographic code has no picker region",
  );
  same(
    phone.normalizePhone("+80012345678"),
    "+80012345678",
    "non-geographic number remains accepted",
  );
  same(
    phone.formatPhoneForDisplay("+80012345678"),
    "+800 12345678",
    "non-geographic display retains calling code",
  );
  same(phone.formatPhoneForDisplay("+93700123456"), "+93 70 012 3456", "familiar Afghan grouping");
  same(phone.formatPhoneForDisplay("+14165551234"), "+1 4165551234", "shared calling code display");
  same(
    phone.formatPhoneForDisplay("+390669812345"),
    "+39 0669812345",
    "display retains Italian zero",
  );
  same(phone.formatPhoneForDisplay("+9991234567"), "+9991234567", "unknown display is untouched");

  // Execute the real normalizer against upstream's synthetic mobile example for
  // every region, including national re-entry after the edit screen removes
  // the selected calling code. This catches doubled prefixes and lost digits.
  for (const [country, national] of Object.entries(examples)) {
    const expected = "+" + getCountryCallingCode(country as CountryCode, phoneMetadata) + national;
    same(phone.normalizePhone(national, country), expected, `${country} national example`);
    same(phone.normalizePhone(expected, "AF"), expected, `${country} explicit prefix`);
    const inferred = phone.inferCountryFromE164(expected);
    const editNational = expected.slice(phone.getCountry(inferred).dialCode.length);
    same(
      phone.normalizePhone(editNational, inferred),
      expected,
      `${country} inferred edit round trip`,
    );
  }

  phone.setCurrentDefaultCountryCode("CA");
  same(phone.getCurrentDefaultCountryCode(), "CA", "new default can be selected");
  phone.setCurrentDefaultCountryCode("XX");
  same(phone.getCurrentDefaultCountryCode(), "CA", "unsupported preference is ignored");
  storedCountry = "JP";
  await phone.initDefaultCountryFromPref();
  same(phone.getCurrentDefaultCountryCode(), "JP", "new country preference restores");
  storedCountry = "XX";
  await phone.initDefaultCountryFromPref();
  same(
    phone.getCurrentDefaultCountryCode(),
    "JP",
    "invalid saved preference does not replace default",
  );
  console.log(`PASS ${checks} phone and country checks (${COUNTRIES.length} geographic regions)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
