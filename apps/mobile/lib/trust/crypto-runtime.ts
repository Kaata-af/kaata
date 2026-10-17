// Runtime ChainCrypto wiring — connects the pure chain fold to the app's
// real signature implementations in lib/event-sig.ts. Kept OUT of chain.ts
// so the bun selftest can import chain.ts without dragging in event-sig's
// expo-crypto shim (which only resolves inside React Native).

import {
  canonicalize,
  canonicalizeEvent,
  verifyRawSignature,
  type SignableEvent,
} from "../event-sig";
import { verifyEd25519BatchAsync } from "kaata-bt-classic";
import {
  deviceWitnessTuple,
  memberWitnessTuple,
  parseChainRole,
  type ChainCrypto,
  type MembershipEventLike,
} from "./chain";
import {
  hasOwnershipTransferPayload,
  ownershipTransferGrantBytes,
  parseOwnershipTransferGrant,
} from "./ownership-transfer";
import {
  createSuccessfulVerificationCache,
  type SignatureCheck,
} from "./successful-verification-cache";

// Repeated local/published/peer folds often contain identical signed bytes.
// Cache only their cryptographic check. The fold still reads current inputs
// and evaluates membership, removals, anchors and witness pins every time.
const verifySignature = createSuccessfulVerificationCache(
  verifyRawSignature,
  { maxEntries: 2048, maxKeyBytes: 4 * 1024 * 1024 },
  async (checks) =>
    verifyEd25519BatchAsync(
      checks.map(({ message, signature, publicKey }) => ({
        messageBase64: encodeBase64(message),
        signatureBase64: signature,
        publicKeyBase64: publicKey,
      })),
    ),
);

export const runtimeChainCrypto: ChainCrypto = {
  verifyEvent: (event: MembershipEventLike, sigB64: string, pubkeyB64: string) =>
    verifySignature(canonicalizeEvent(event as unknown as SignableEvent), sigB64, pubkeyB64),
  verifyRaw: verifySignature,
  canonicalize,
};

function encodeBase64(message: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < message.length; i += 1024) {
    parts.push(String.fromCharCode(...message.subarray(i, i + 1024)));
  }
  return btoa(parts.join(""));
}

const object = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Warm mathematical checks only. Constructors match the pure verifier;
 * the fold remains the sole authority for freshness, membership and removal.
 * Invalid/unsupported inputs still use the original Noble verifier. */
export async function prewarmMembershipSignatures(
  events: readonly MembershipEventLike[],
  serverWitnessPubkeysB64: readonly string[],
): Promise<void> {
  function* checks(): Generator<SignatureCheck> {
    for (const event of events) {
      if (event.event_sig_b64 && event.signer_device_pubkey) {
        yield {
          message: canonicalizeEvent(event as unknown as SignableEvent),
          signature: event.event_sig_b64,
          publicKey: event.signer_device_pubkey,
        };
      }
      const payload = object(event.payload);
      if (hasOwnershipTransferPayload(event)) {
        const authorization = object(object(payload?.ownership_transfer)?.authorization);
        const grant = parseOwnershipTransferGrant(authorization?.grant);
        if (
          grant &&
          typeof authorization?.sig_b64 === "string" &&
          typeof authorization.signer_device_pubkey === "string"
        ) {
          yield {
            message: ownershipTransferGrantBytes(grant, canonicalize),
            signature: authorization.sig_b64,
            publicKey: authorization.signer_device_pubkey,
          };
        }
        continue;
      }
      const witness = object(payload?.witness);
      if (typeof witness?.sig_b64 !== "string" || typeof witness.issued_at_ms !== "number")
        continue;
      let tuple: Record<string, unknown> | null = null;
      const role = parseChainRole(payload?.role);
      if (
        event.event_type === "vault_member_added" &&
        role &&
        typeof payload?.account_id === "string" &&
        typeof witness.inviter_account_id === "string" &&
        event.vault_id
      ) {
        tuple = memberWitnessTuple({
          vault_id: event.vault_id,
          account_id: payload.account_id,
          inviter_account_id: witness.inviter_account_id,
          role,
          issued_at_ms: witness.issued_at_ms,
        });
      } else if (
        event.event_type === "vault_device_added" &&
        event.vault_id &&
        typeof payload?.account_id === "string" &&
        typeof payload.device_id === "string" &&
        typeof payload.device_pubkey === "string"
      ) {
        tuple = deviceWitnessTuple({
          vault_id: event.vault_id,
          account_id: payload.account_id,
          device_id: payload.device_id,
          device_pubkey_b64: payload.device_pubkey,
          issued_at_ms: witness.issued_at_ms,
        });
      }
      if (tuple) {
        const message = new TextEncoder().encode(canonicalize(tuple));
        for (const publicKey of serverWitnessPubkeysB64)
          yield { message, signature: witness.sig_b64, publicKey };
      }
    }
  }
  await verifySignature.prewarm(checks());
}
