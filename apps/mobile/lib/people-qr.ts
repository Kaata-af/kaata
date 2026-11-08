const PREFIX = "kaata-person:1:";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function isAccountID(value: string): boolean {
  return typeof value === "string" && value.length === 36 && value !== NIL_UUID && UUID.test(value);
}

/** A public account locator, not a link, invitation, or proof of permission. */
export function encodePeopleQr(accountId: string): string | null {
  return isAccountID(accountId) ? PREFIX + accountId : null;
}

/** Resolve the result through the existing authenticated people/profile flow. */
export function decodePeopleQr(data: string): string | null {
  if (typeof data !== "string" || data.length !== PREFIX.length + 36 || !data.startsWith(PREFIX))
    return null;
  const accountId = data.slice(PREFIX.length);
  return isAccountID(accountId) ? accountId : null;
}
