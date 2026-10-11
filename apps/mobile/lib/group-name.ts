/** Keep Dari joining characters; strip control/bidi overrides from labels. */
export function normalizeGroupName(input: string): string {
  return input
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function isValidGroupName(input: string): boolean {
  const name = normalizeGroupName(input);
  return Array.from(name).length >= 1 && Array.from(name).length <= 40;
}
