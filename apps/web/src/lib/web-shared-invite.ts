const KEY = "kaata_web_shared_invitation_v1";
const MAX_AGE = 15 * 60_000;
const TOKEN = /^(?:g_)?[A-Za-z0-9_-]{16,512}$/;
let pending: { token: string; at: number } | null = null;

export function sharedInvitationToken(value: string): string | null {
  const input = value.trim();
  if (TOKEN.test(input)) return input;
  try {
    const url = new URL(input);
    const match = /^\/t\/([^/]+)\/?$/.exec(url.pathname);
    if (
      url.protocol === "https:" &&
      ["kaata.af", "www.kaata.af", "api.kaata.af"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      match &&
      TOKEN.test(match[1])
    )
      return match[1];
  } catch {
    // A pasted invitation must be a Kaata link or its opaque token.
  }
  return null;
}

export function captureSharedInvitation(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has("shared_invite")) return;
  clearSharedInvitation();
  // Scrub before authentication SDKs or requests can observe the invitation.
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
  const token =
    params.getAll("shared_invite").length === 1
      ? sharedInvitationToken(params.get("shared_invite") ?? "")
      : null;
  if (token) {
    pending = { token, at: Date.now() };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(pending));
    } catch {
      /* In-memory fallback. */
    }
  }
}

export function pendingSharedInvitation(): string | null {
  if (!pending) {
    try {
      pending = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    } catch {
      /* Optional cache. */
    }
  }
  if (
    pending &&
    typeof pending.token === "string" &&
    TOKEN.test(pending.token) &&
    typeof pending.at === "number" &&
    Number.isFinite(pending.at) &&
    Date.now() >= pending.at &&
    Date.now() - pending.at < MAX_AGE
  )
    return pending.token;
  clearSharedInvitation();
  return null;
}

export function clearSharedInvitation(): void {
  pending = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Optional cache. */
  }
}
