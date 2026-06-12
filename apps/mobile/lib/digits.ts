// Persian (U+06F0–U+06F9) and Arabic-Indic (U+0660–U+0669) digit
// transliteration. Persian keyboards on Android emit Extended-Arabic-Indic
// digits even on the number pad, so every numeric input path (amounts,
// phone numbers) must transliterate BEFORE validating with /\d/ — JS \d is
// ASCII-only, and without this step digits typed by Persian-locale users
// are silently stripped as they type.
const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

export function toAsciiDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= PERSIAN_ZERO ? PERSIAN_ZERO : ARABIC_ZERO;
    return String(code - base);
  });
}
