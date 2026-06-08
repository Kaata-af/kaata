import { BACKEND_URL } from "../env";

// Phase 4 — public, no-auth fetchers for the invite landing page.
// kaata.af doesn't authenticate; this just renders enough about a token for
// the recipient to decide whether to open it on their phone. Actual
// acceptance happens in the mobile app via POST /v1/vaults/invites/accept.

export type InviteInfo = {
  vault_name: string;
  role: "owner" | "editor" | "viewer";
  inviter_email_redacted: string;
  inviter_name: string | null;
  expires_at: string; // ISO-8601 UTC
};

export type InviteInfoError =
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "network" }
  | { kind: "server"; status: number };

export type InviteInfoResult =
  | { ok: true; info: InviteInfo }
  | { ok: false; error: InviteInfoError };

// getInviteInfo — GET /v1/vaults/invites/:token/info
//
// 404 collapses unknown / expired / revoked / already-accepted into one
// "this link doesn't work" UX state — the page never tells the visitor
// which of those four it was, by design (token enumeration defence).
export async function getInviteInfo(token: string): Promise<InviteInfoResult> {
  const cleaned = token.trim();
  if (cleaned === "") {
    return { ok: false, error: { kind: "not_found" } };
  }

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/v1/vaults/invites/${encodeURIComponent(cleaned)}/info`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }

  if (res.status === 404) return { ok: false, error: { kind: "not_found" } };
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
    return {
      ok: false,
      error: {
        kind: "rate_limited",
        retryAfterSeconds: Number.isFinite(parsed) ? parsed : undefined,
      },
    };
  }
  if (!res.ok) {
    return { ok: false, error: { kind: "server", status: res.status } };
  }

  try {
    const body = (await res.json()) as InviteInfo;
    if (
      typeof body.vault_name !== "string" ||
      typeof body.role !== "string" ||
      typeof body.inviter_email_redacted !== "string" ||
      typeof body.expires_at !== "string"
    ) {
      return { ok: false, error: { kind: "server", status: res.status } };
    }
    return { ok: true, info: body };
  } catch {
    return { ok: false, error: { kind: "server", status: res.status } };
  }
}
