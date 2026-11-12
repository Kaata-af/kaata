// Admin invitations require the owner's own device signature. A server
// membership witness alone remains insufficient to create an Admin seat.
import { sha256 } from "@noble/hashes/sha256";
import type { ChainCrypto, MembershipEventLike } from "./chain";

export const ADMIN_INVITE_GRANT_DOMAIN = "kaata-admin-invite-v1";
export const ADMIN_INVITE_RECEIPT_DOMAIN = "kaata-admin-invite-acceptance-v1";
export const MAX_ADMIN_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type AdminInviteGrant = {
  domain: typeof ADMIN_INVITE_GRANT_DOMAIN;
  grant_id: string;
  vault_id: string;
  from_account_id: string;
  from_chain_account_id?: string;
  recipient_account_id: string;
  role: "manager";
  issued_at_ms: number;
  expires_at_ms: number;
};

export type AdminInviteAuthorization = {
  grant: AdminInviteGrant;
  signer_device_pubkey: string;
  sig_b64: string;
};

export type AdminInviteReceipt = {
  domain: typeof ADMIN_INVITE_RECEIPT_DOMAIN;
  grant_id: string;
  vault_id: string;
  grant_sha256: string;
  to_account_id: string;
  accepted_at_ms: number;
  event_id: string;
  vault_epoch: number;
};

export type AdminInviteProof = {
  authorization: AdminInviteAuthorization;
  receipt: AdminInviteReceipt;
};

const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const isUUID = (value: unknown): value is string =>
  typeof value === "string" && uuidPattern.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function parseAdminInviteGrant(value: unknown): AdminInviteGrant | null {
  const grant = object(value);
  if (
    !grant || grant.domain !== ADMIN_INVITE_GRANT_DOMAIN ||
    !isUUID(grant.grant_id) || !isUUID(grant.vault_id) || !isUUID(grant.from_account_id) ||
    !isUUID(grant.recipient_account_id) ||
    grant.role !== "manager" ||
    !Number.isSafeInteger(grant.issued_at_ms) || !Number.isSafeInteger(grant.expires_at_ms)
  ) return null;
  const issued = grant.issued_at_ms as number, expires = grant.expires_at_ms as number;
  if (
    issued <= 0 || expires <= issued || expires - issued > MAX_ADMIN_INVITE_LIFETIME_MS ||
    (grant.from_chain_account_id !== undefined && !isUUID(grant.from_chain_account_id) &&
      !(typeof grant.from_chain_account_id === "string" &&
        /^local:[A-Za-z0-9_-]{16}$/.test(grant.from_chain_account_id)))
  ) return null;
  return {
    domain: ADMIN_INVITE_GRANT_DOMAIN,
    grant_id: grant.grant_id,
    vault_id: grant.vault_id,
    from_account_id: grant.from_account_id,
    ...(grant.from_chain_account_id !== undefined
      ? { from_chain_account_id: grant.from_chain_account_id as string }
      : {}),
    recipient_account_id: grant.recipient_account_id as string,
    role: "manager",
    issued_at_ms: issued,
    expires_at_ms: expires,
  };
}

export function adminInviteGrantBytes(
  grant: AdminInviteGrant,
  canonicalize: ChainCrypto["canonicalize"],
): Uint8Array {
  const parsed = parseAdminInviteGrant(grant);
  if (!parsed) throw new Error("invalid Admin invitation grant");
  return new TextEncoder().encode(canonicalize(parsed));
}

export function adminInviteGrantHash(
  grant: AdminInviteGrant,
  canonicalize: ChainCrypto["canonicalize"],
): string {
  return Array.from(sha256(adminInviteGrantBytes(grant, canonicalize)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Mathematical/recipient/time checks. The fold additionally checks the
 * signing device's owner binding and consumes each grant exactly once. */
export function verifyAdminInviteAuthorization(
  value: unknown,
  expected: {
    vaultId: string;
    accountId: string;
    inviterAccountId: string;
    acceptedAt: unknown;
  },
  crypto: ChainCrypto,
): AdminInviteAuthorization | null {
  try {
    const authorization = object(value);
    const grant = parseAdminInviteGrant(authorization?.grant);
    if (
      !authorization || !grant ||
      typeof authorization.signer_device_pubkey !== "string" ||
      typeof authorization.sig_b64 !== "string" ||
      grant.vault_id !== expected.vaultId ||
      grant.from_account_id !== expected.inviterAccountId ||
      grant.recipient_account_id !== expected.accountId ||
      expected.accountId === grant.from_account_id ||
      expected.accountId === grant.from_chain_account_id ||
      !Number.isSafeInteger(expected.acceptedAt) ||
      (expected.acceptedAt as number) < grant.issued_at_ms ||
      (expected.acceptedAt as number) > grant.expires_at_ms ||
      !crypto.verifyRaw(
        adminInviteGrantBytes(grant, crypto.canonicalize),
        authorization.sig_b64,
        authorization.signer_device_pubkey,
      )
    ) return null;
    return {
      grant,
      signer_device_pubkey: authorization.signer_device_pubkey,
      sig_b64: authorization.sig_b64,
    };
  } catch {
    return null;
  }
}

/** An immutable server-signed acceptance event and an owner-signed grant are
 * both required. Recovery replays this same event instead of renewing intent. */
export function verifyAdminInviteEvent(
  event: MembershipEventLike,
  serverPubkeys: readonly string[],
  crypto: ChainCrypto,
): AdminInviteProof | null {
  try {
    const payload = object(event.payload);
    const proof = object(payload?.admin_invite);
    const receipt = object(proof?.receipt);
    const rawAuthorization = object(proof?.authorization);
    const grant = parseAdminInviteGrant(rawAuthorization?.grant);
    if (!payload || !proof || !receipt || !grant ||
        event.event_type !== "vault_member_added" || payload.role !== "manager" ||
        !event.signer_device_pubkey || !event.event_sig_b64 ||
        !serverPubkeys.includes(event.signer_device_pubkey) ||
        !crypto.verifyEvent(event, event.event_sig_b64, event.signer_device_pubkey)) return null;
    const authorization = verifyAdminInviteAuthorization(rawAuthorization, {
      vaultId: event.vault_id ?? "", accountId: String(payload.account_id),
      inviterAccountId: grant.from_account_id, acceptedAt: receipt.accepted_at_ms,
    }, crypto);
    if (!authorization || receipt.domain !== ADMIN_INVITE_RECEIPT_DOMAIN ||
        receipt.grant_id !== grant.grant_id || receipt.vault_id !== grant.vault_id ||
        receipt.grant_sha256 !== adminInviteGrantHash(grant, crypto.canonicalize) ||
        !isUUID(receipt.to_account_id) || !isUUID(receipt.event_id) ||
        receipt.to_account_id !== payload.account_id ||
        event.target_id !== receipt.to_account_id || event.event_id !== receipt.event_id ||
        event.event_id !== grant.grant_id || event.hlc.pms !== grant.issued_at_ms || event.hlc.l !== 0 ||
        event.device_id !== grant.grant_id || event.hlc.did !== grant.grant_id || event.actor_account_id !== null ||
        event.relationship_id !== null || event.payload_schema !== 1 ||
        !Number.isSafeInteger(receipt.vault_epoch) || (receipt.vault_epoch as number) <= 0)
      return null;
    return { authorization, receipt: receipt as AdminInviteReceipt };
  } catch {
    return null;
  }
}

export function hasAdminInvitePayload(event: { event_type: string; payload: unknown }): boolean {
  return event.event_type === "vault_member_added" &&
    Object.prototype.hasOwnProperty.call(object(event.payload) ?? {}, "admin_invite");
}
