import { ADMIN_PRO_UUID, adminProRequest, adminProTimestamp } from "./admin-pro-request";
import { AuthError } from "./api";

export type AdminProGrant = {
  id: string;
  expires_at: string;
  reason: string;
  granted_at: string;
  revoked_at?: string;
  revoke_reason?: string;
};

export type AdminProGrantAction =
  | { kind: "grant"; operation_id: string; expires_at: string; reason: string }
  | { kind: "revoke"; operation_id: string; grant_id: string; reason: string };

export class AdminProGrantError extends Error {
  constructor(
    public kind: "conflict" | "rejected" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "AdminProGrantError";
  }
}

export const MAX_GRANT_REASON_LENGTH = 240;
const UNCONFIRMED = "Kaata could not confirm the access change. Retry the same request.";

export function proGrantReason(input: string): string | null {
  const reason = input.trim();
  return reason && Array.from(reason).length <= MAX_GRANT_REASON_LENGTH && !/\p{Cc}/u.test(reason)
    ? reason
    : null;
}

export function proGrantExpiry(day: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const calendarDay = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(+calendarDay) || calendarDay.toISOString().slice(0, 10) !== day) return null;
  const end = new Date(`${day}T23:59:59+04:30`);
  return +end > now ? end.toISOString() : null;
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid complimentary access response.");
  return input as Record<string, unknown>;
}

export function parseAdminProGrant(input: unknown): AdminProGrant {
  const value = object(input);
  if (
    typeof value.id !== "string" ||
    !ADMIN_PRO_UUID.test(value.id) ||
    !adminProTimestamp(value.granted_at) ||
    !adminProTimestamp(value.expires_at) ||
    typeof value.reason !== "string" ||
    proGrantReason(value.reason) !== value.reason
  )
    throw new Error("Invalid complimentary access response.");
  const grant = {
    id: value.id,
    granted_at: value.granted_at,
    expires_at: value.expires_at,
    reason: value.reason,
  };
  if (value.revoked_at == null && value.revoke_reason == null) return grant;
  if (
    !adminProTimestamp(value.revoked_at) ||
    typeof value.revoke_reason !== "string" ||
    proGrantReason(value.revoke_reason) !== value.revoke_reason
  )
    throw new Error("Invalid complimentary access revocation.");
  return { ...grant, revoked_at: value.revoked_at, revoke_reason: value.revoke_reason };
}

export async function changeAdminProGrant(
  token: string,
  accountID: string,
  action: AdminProGrantAction,
): Promise<{ grant: AdminProGrant; duplicate: boolean }> {
  const reason = proGrantReason(action.reason);
  if (
    !ADMIN_PRO_UUID.test(accountID) ||
    !ADMIN_PRO_UUID.test(action.operation_id) ||
    !reason ||
    (action.kind === "grant"
      ? !adminProTimestamp(action.expires_at)
      : !ADMIN_PRO_UUID.test(action.grant_id))
  )
    throw new AdminProGrantError("rejected", "Check the account, end date, and reason.");

  const fields = { operation_id: action.operation_id, reason };
  const suffix = action.kind === "grant" ? "/grants" : `/grants/${action.grant_id}/revoke`;
  let response: Response;
  try {
    response = await adminProRequest(
      token,
      accountID,
      {
        method: "POST",
        body: JSON.stringify(
          action.kind === "grant" ? { ...fields, expires_at: action.expires_at } : fields,
        ),
      },
      suffix,
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AdminProGrantError("unconfirmed", UNCONFIRMED);
  }
  if (!response.ok) {
    if (response.status === 409 || response.status === 404)
      throw new AdminProGrantError(
        "conflict",
        "The account or complimentary access changed. Check the refreshed details before trying again.",
      );
    if ([400, 403, 422, 429].includes(response.status))
      throw new AdminProGrantError(
        "rejected",
        `Kaata refused this access change (${response.status}). Check the end date and reason.`,
      );
    throw new AdminProGrantError("unconfirmed", UNCONFIRMED);
  }
  try {
    const value = object(await response.json());
    const grant = parseAdminProGrant(value.grant);
    if (
      typeof value.duplicate !== "boolean" ||
      (action.kind === "grant"
        ? grant.id.toLowerCase() !== action.operation_id.toLowerCase() ||
          Date.parse(grant.expires_at) !== Date.parse(action.expires_at) ||
          grant.reason !== reason
        : grant.id.toLowerCase() !== action.grant_id.toLowerCase() ||
          grant.revoke_reason !== reason)
    )
      throw new Error("Mismatched complimentary access confirmation.");
    return { grant, duplicate: value.duplicate };
  } catch {
    throw new AdminProGrantError("unconfirmed", UNCONFIRMED);
  }
}
