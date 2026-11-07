import {
  applyForCurrentSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import { getActiveVaultIdSyncMaybe } from "./db-tx";
import type { VaultRole } from "./events";
import { peopleRequest } from "./people-connections";
import { TabApiError, TabAuthUnavailableError } from "./tabs/errors";
import { ApiError, type InviteInfo } from "./vault-api";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ROLES = new Set(["editor", "clerk", "viewer"]);
export type VaultMemberInviteRole = Extract<VaultRole, "editor" | "clerk" | "viewer">;
export type VaultMemberRequestResult = {
  invite_id: string;
  invite_token: string;
  delivery: "in_app";
  expires_at: number;
};
export type VaultMemberRequest = {
  id: string;
  token: string;
  vault_id: string;
  vault_name: string;
  inviter_name: string;
  role: VaultMemberInviteRole;
  invited_at: number;
  expires_at: number;
};

export function isVaultMemberRequestToken(token: string): boolean {
  return token.startsWith("v_") && UUID.test(token.slice(2));
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  session?: SessionSnapshot,
  guard?: () => void,
): Promise<T> {
  try {
    return await peopleRequest<T>(method, path, body, session, guard);
  } catch (error) {
    if (error instanceof TabAuthUnavailableError)
      throw new ApiError(401, "session_changed", "Sign in to manage member invitations");
    if (error instanceof TabApiError)
      throw new ApiError(error.status, error.code, "Member invitation request failed");
    throw error;
  }
}

/** Stages no membership or local contact. Only the recipient's acceptance may grant access. */
export async function createVaultMemberRequest(
  vaultId: string,
  body: { recipientAccountId: string; role: VaultRole },
  expectedSession?: SessionSnapshot,
): Promise<VaultMemberRequestResult> {
  const session = expectedSession ?? (await captureCurrentSession());
  const guard = () => {
    if (getActiveVaultIdSyncMaybe() !== vaultId) throw new SessionChangedError();
  };
  if (!UUID.test(vaultId) || !UUID.test(body.recipientAccountId) || !ROLES.has(body.role))
    throw new ApiError(400, "invalid_invite", "Choose a person and member role");
  if (session.accountId === body.recipientAccountId)
    throw new ApiError(400, "self_invite", "You already belong to this Kaata");
  await applyForCurrentSession(session, async () => guard());
  const capabilities = await request<{ vault_account_invites?: boolean }>(
    "GET",
    "/v1/sync/capabilities",
    undefined,
    session,
    guard,
  );
  if (capabilities.vault_account_invites !== true)
    throw new ApiError(
      503,
      "vault_account_invites_unsupported",
      "Member invitations are unavailable",
    );
  await applyForCurrentSession(session, async () => guard());
  const { uploadPendingCreditPolicies } = await import("./credit-limits");
  await uploadPendingCreditPolicies(vaultId, session);
  await applyForCurrentSession(session, async () => guard());
  const raw = await request<{
    invite_id: string;
    invite_token: string;
    delivery: string;
    expires_at: string;
  }>(
    "POST",
    `/v1/vaults/${encodeURIComponent(vaultId)}/account-invites`,
    { target_account_id: body.recipientAccountId, role: body.role },
    session,
    guard,
  );
  return applyForCurrentSession(session, async () => {
    guard();
    const expiresAt = Date.parse(raw?.expires_at);
    if (
      !raw ||
      !UUID.test(raw.invite_id) ||
      raw.invite_token !== `v_${raw.invite_id}` ||
      raw.delivery !== "in_app" ||
      typeof raw.expires_at !== "string" ||
      !Number.isFinite(expiresAt)
    )
      throw new ApiError(502, "invalid_response", "Member invitation could not be confirmed");
    return {
      invite_id: raw.invite_id,
      invite_token: raw.invite_token,
      delivery: "in_app",
      expires_at: expiresAt,
    };
  });
}

/** Account-scoped transient inbox data; never writes the legacy token cache. */
export async function listVaultMemberRequests(): Promise<VaultMemberRequest[]> {
  const session = await captureCurrentSession();
  const raw = await request<{ pending: Array<Record<string, unknown>> }>(
    "GET",
    "/v1/vaults/invites/pending?include_account_invites=1",
    undefined,
    session,
  );
  if (!raw || !Array.isArray(raw.pending))
    throw new ApiError(502, "invalid_response", "Member invitations could not be loaded");
  const seen = new Set<string>();
  const rows: VaultMemberRequest[] = [];
  for (const item of raw.pending) {
    if (
      !item ||
      typeof item.invite_id !== "string" ||
      !UUID.test(item.invite_id) ||
      item.invite_token !== `v_${item.invite_id}` ||
      seen.has(item.invite_id) ||
      typeof item.vault_id !== "string" ||
      !UUID.test(item.vault_id) ||
      typeof item.vault_name !== "string" ||
      !ROLES.has(String(item.role))
    )
      continue;
    const invitedAt = typeof item.invited_at === "string" ? Date.parse(item.invited_at) : NaN;
    const expiresAt = typeof item.expires_at === "string" ? Date.parse(item.expires_at) : NaN;
    if (!Number.isFinite(invitedAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
      continue;
    seen.add(item.invite_id);
    rows.push({
      id: item.invite_id,
      token: item.invite_token as string,
      vault_id: item.vault_id,
      vault_name: item.vault_name,
      inviter_name: typeof item.inviter_name === "string" ? item.inviter_name : "",
      role: item.role as VaultMemberInviteRole,
      invited_at: invitedAt,
      expires_at: expiresAt,
    });
    if (rows.length >= 50) break;
  }
  return applyForCurrentSession(session, async () => rows);
}

export async function fetchVaultMemberRequestInfo(
  token: string,
  expectedSession?: SessionSnapshot,
): Promise<InviteInfo | null> {
  if (!isVaultMemberRequestToken(token)) return null;
  const session = expectedSession ?? (await captureCurrentSession());
  try {
    const raw = await request<{
      vault_name: string;
      role: string;
      inviter_name?: string;
      inviter_email_redacted?: string;
      expires_at: string;
    }>(
      "GET",
      `/v1/vaults/invites/requests/${encodeURIComponent(token.slice(2))}`,
      undefined,
      session,
    );
    const expiresAt = Date.parse(raw?.expires_at);
    if (
      !raw ||
      typeof raw.vault_name !== "string" ||
      !ROLES.has(raw.role) ||
      typeof raw.expires_at !== "string" ||
      !Number.isFinite(expiresAt)
    )
      throw new ApiError(502, "invalid_response", "Member invitation could not be loaded");
    return {
      vault_name: raw.vault_name,
      role: raw.role as VaultRole,
      inviter_name: typeof raw.inviter_name === "string" ? raw.inviter_name : null,
      inviter_email_redacted:
        typeof raw.inviter_email_redacted === "string" ? raw.inviter_email_redacted : null,
      expires_at: expiresAt,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function declineVaultMemberRequest(
  id: string,
  expectedSession?: SessionSnapshot,
): Promise<void> {
  if (!UUID.test(id)) throw new ApiError(400, "invalid_invite", "Invalid member invitation");
  const session = expectedSession ?? (await captureCurrentSession());
  try {
    await request(
      "DELETE",
      `/v1/vaults/invites/requests/${encodeURIComponent(id)}`,
      undefined,
      session,
    );
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
  await applyForCurrentSession(session, async () => {});
}
