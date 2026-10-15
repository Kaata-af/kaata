// Owner authorization and server acceptance are separate proofs. A normal
// member witness still cannot grant Owner or Admin. This pure module can run
// in Hermes and in the real-signature selftests without native dependencies.
import { sha256 } from "@noble/hashes/sha256";
import type { ChainCrypto, MembershipEventLike } from "./chain";

export const OWNERSHIP_GRANT_DOMAIN = "kaata-ownership-transfer-v1";
export const OWNERSHIP_RECEIPT_DOMAIN = "kaata-ownership-transfer-acceptance-v1";
export const MAX_OWNERSHIP_GRANT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export type OwnershipTransferGrant = {
  domain: typeof OWNERSHIP_GRANT_DOMAIN;
  transfer_id: string;
  vault_id: string;
  from_account_id: string;
  from_chain_account_id?: string;
  recipient_email_normalized: string;
  demote_self_to: "editor";
  issued_at_ms: number;
  expires_at_ms: number;
};
export type OwnershipTransferAuthorization = {
  grant: OwnershipTransferGrant;
  signer_device_pubkey: string;
  sig_b64: string;
};
export type OwnershipTransferReceipt = {
  domain: typeof OWNERSHIP_RECEIPT_DOMAIN;
  transfer_id: string;
  vault_id: string;
  grant_sha256: string;
  to_account_id: string;
  accepted_at_ms: number;
  event_id: string;
  vault_epoch: number;
};
export type OwnershipTransferProof = {
  authorization: OwnershipTransferAuthorization;
  receipt: OwnershipTransferReceipt;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUUID = (v: unknown): v is string =>
  typeof v === "string" && uuidPattern.test(v) && v !== "00000000-0000-0000-0000-000000000000";
const object = (v: unknown): Record<string, unknown> | null =>
  v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function normalizeOwnershipTransferEmail(raw: string): string {
  const s = raw.trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 0) return s;
  const local = s.slice(0, at),
    domain = s.slice(at + 1);
  return domain === "gmail.com" || domain === "googlemail.com"
    ? `${local.split("+")[0].replace(/\./g, "")}@gmail.com`
    : s;
}

export function parseOwnershipTransferGrant(v: unknown): OwnershipTransferGrant | null {
  const g = object(v);
  if (
    !g ||
    g.domain !== OWNERSHIP_GRANT_DOMAIN ||
    !isUUID(g.transfer_id) ||
    !isUUID(g.vault_id) ||
    !isUUID(g.from_account_id) ||
    g.demote_self_to !== "editor" ||
    typeof g.recipient_email_normalized !== "string" ||
    !Number.isSafeInteger(g.issued_at_ms) ||
    !Number.isSafeInteger(g.expires_at_ms)
  )
    return null;
  const email = g.recipient_email_normalized;
  const at = email.lastIndexOf("@");
  const issued = g.issued_at_ms as number,
    expires = g.expires_at_ms as number;
  if (
    g.from_chain_account_id !== undefined &&
    !(
      isUUID(g.from_chain_account_id) ||
      (typeof g.from_chain_account_id === "string" &&
        /^local:[A-Za-z0-9_-]{16}$/.test(g.from_chain_account_id))
    )
  )
    return null;
  if (
    issued <= 0 ||
    expires <= issued ||
    expires - issued > MAX_OWNERSHIP_GRANT_LIFETIME_MS ||
    email.length > 254 ||
    at <= 0 ||
    at === email.length - 1 ||
    /[ \t\r\n\x00]/.test(email) ||
    email.indexOf("@") !== at ||
    normalizeOwnershipTransferEmail(email) !== email
  )
    return null;
  // Copy the exact signed fields. Unknown extension fields cannot change the
  // canonical form on one platform while disappearing from Go's typed grant.
  return {
    domain: OWNERSHIP_GRANT_DOMAIN,
    transfer_id: g.transfer_id,
    vault_id: g.vault_id,
    from_account_id: g.from_account_id,
    recipient_email_normalized: email,
    demote_self_to: "editor",
    issued_at_ms: issued,
    expires_at_ms: expires,
    ...(g.from_chain_account_id !== undefined
      ? { from_chain_account_id: g.from_chain_account_id as string }
      : {}),
  };
}

export function ownershipTransferGrantBytes(
  grant: OwnershipTransferGrant,
  canonicalize: ChainCrypto["canonicalize"],
): Uint8Array {
  const parsed = parseOwnershipTransferGrant(grant);
  if (!parsed) throw new Error("invalid ownership transfer grant");
  return new TextEncoder().encode(canonicalize(parsed));
}

export function ownershipTransferGrantHash(
  grant: OwnershipTransferGrant,
  canonicalize: ChainCrypto["canonicalize"],
): string {
  return Array.from(sha256(ownershipTransferGrantBytes(grant, canonicalize)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Structural+cryptographic proof only. The caller MUST separately check the
 * authorizing device's active source-owner binding in its membership state. */
export function verifyOwnershipTransferEvent(
  event: MembershipEventLike,
  serverPubkeys: readonly string[],
  crypto: ChainCrypto,
): OwnershipTransferProof | null {
  try {
    const payload = object(event.payload);
    const proof = object(payload?.ownership_transfer);
    const auth = object(proof?.authorization),
      receipt = object(proof?.receipt);
    const grant = parseOwnershipTransferGrant(auth?.grant);
    if (
      event.event_type !== "vault_member_added" ||
      payload?.role !== "owner" ||
      !proof ||
      !auth ||
      !grant ||
      !receipt ||
      typeof auth.signer_device_pubkey !== "string" ||
      typeof auth.sig_b64 !== "string" ||
      !event.signer_device_pubkey ||
      !event.event_sig_b64 ||
      !serverPubkeys.includes(event.signer_device_pubkey) ||
      !crypto.verifyEvent(event, event.event_sig_b64, event.signer_device_pubkey) ||
      !crypto.verifyRaw(
        ownershipTransferGrantBytes(grant, crypto.canonicalize),
        auth.sig_b64,
        auth.signer_device_pubkey,
      )
    )
      return null;
    if (
      receipt.domain !== OWNERSHIP_RECEIPT_DOMAIN ||
      receipt.transfer_id !== grant.transfer_id ||
      receipt.vault_id !== grant.vault_id ||
      receipt.grant_sha256 !== ownershipTransferGrantHash(grant, crypto.canonicalize) ||
      !isUUID(receipt.to_account_id) ||
      receipt.to_account_id === grant.from_account_id ||
      receipt.to_account_id === grant.from_chain_account_id ||
      !isUUID(receipt.event_id) ||
      !Number.isSafeInteger(receipt.accepted_at_ms) ||
      (receipt.accepted_at_ms as number) < grant.issued_at_ms ||
      (receipt.accepted_at_ms as number) > grant.expires_at_ms ||
      !Number.isSafeInteger(receipt.vault_epoch) ||
      (receipt.vault_epoch as number) <= 0 ||
      event.event_id !== receipt.event_id ||
      event.vault_id !== receipt.vault_id ||
      event.target_id !== receipt.to_account_id ||
      payload.account_id !== receipt.to_account_id ||
      event.hlc.pms !== receipt.accepted_at_ms ||
      event.hlc.l !== 0 ||
      event.hlc.did !== event.device_id ||
      event.actor_account_id !== null ||
      event.relationship_id !== null ||
      event.payload_schema !== 1
    )
      return null;
    return {
      authorization: {
        grant,
        signer_device_pubkey: auth.signer_device_pubkey,
        sig_b64: auth.sig_b64,
      },
      receipt: receipt as OwnershipTransferReceipt,
    };
  } catch {
    return null;
  }
}

export function hasOwnershipTransferPayload(event: {
  event_type: string;
  payload: unknown;
}): boolean {
  return (
    event.event_type === "vault_member_added" &&
    Object.prototype.hasOwnProperty.call(object(event.payload) ?? {}, "ownership_transfer")
  );
}
