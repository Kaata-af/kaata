// Cheap form feedback mirrors mobile's account-rules.ts. The server remains
// authoritative, including common-password and personal-detail checks.

function asciiDigits(raw: string): string {
  return raw.replace(/[\u06f0-\u06f9\u0660-\u0669]/g, (digit) =>
    String(digit.charCodeAt(0) - (digit >= "\u06f0" ? 0x06f0 : 0x0660)),
  );
}

export function normalizeWebEmailCode(raw: string): string {
  return asciiDigits(raw)
    .replace(/[^0-9]/g, "")
    .slice(0, 6);
}

export function normalizeWebEmailAddress(raw: string): string {
  return asciiDigits(raw).trim();
}

export function normalizeWebEmailIdentifier(raw: string): string {
  const identifier = normalizeWebEmailAddress(raw);
  return identifier.startsWith("@") && identifier.indexOf("@", 1) === -1
    ? identifier.slice(1).trim()
    : identifier;
}

function canonicalPassword(raw: string): string {
  let password = raw;
  try {
    password = password.normalize("NFKC");
  } catch {
    // Match mobile when normalization data is unavailable.
  }
  return asciiDigits(password)
    .replace(/[\u064a\u0649]/g, "\u06cc")
    .replace(/\u0643/g, "\u06a9")
    .replace(/[\u200c\u200d\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "");
}

function hasEasyRun(password: string): boolean {
  const points = Array.from(password.toLowerCase(), (character) => character.codePointAt(0) ?? 0);
  let same = 1;
  let ascending = 1;
  let descending = 1;
  for (let index = 1; index < points.length; index++) {
    const difference = points[index] - points[index - 1];
    same = difference === 0 ? same + 1 : 1;
    ascending = difference === 1 ? ascending + 1 : 1;
    descending = difference === -1 ? descending + 1 : 1;
    if (same >= 6 || ascending >= 6 || descending >= 6) return true;
  }
  return false;
}

export type WebPasswordProblem = "too_short" | "too_long" | "whitespace" | "pattern";

// Apply only when setting a NEW password, never when signing in with one.
// Submit the original password; this canonical form is solely for feedback.
export function newWebPasswordProblem(raw: string): WebPasswordProblem | null {
  const password = canonicalPassword(raw);
  const length = Array.from(password).length;
  if (length < 8) return "too_short";
  if (length > 128) return "too_long";
  if (password !== password.trim()) return "whitespace";
  if ((/^[0-9]+$/.test(password) && length < 12) || hasEasyRun(password)) return "pattern";
  return null;
}
