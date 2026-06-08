// apps/mobile/lib/mesh/local-vmc.ts
//
// Phase 7 Part B: Local-CA VMC issuance.
//
// When a vault is rooted on the owner's DEVICE (vault_trust_anchor_pubkey
// populated on the vaults row) instead of the backend, the owner mints
// VMCs for newly-paired peers directly — no server round-trip, no Google
// sign-in. The wire format and field set are IDENTICAL to server-issued
// VMCs (so the verifier code path is one branch, not two parsers), but
// the `iss` field is "kaata-mesh-local-v1" and the signature is over the
// canonical JSON bytes using the owner's device Ed25519 private key (the
// same key already minted by ensureDeviceKey() for handshake PoP).
//
// Trust model recap:
//   - Server-anchored vault: trust anchor = pinned server pubkey
//     (app_meta.mesh_server_pubkey_primary). iss = "kaata-mesh-v1".
//   - Local-anchored vault:  trust anchor = vaults.vault_trust_anchor_pubkey
//     (owner device pubkey). iss = "kaata-mesh-local-v1".
//
// A vault is one OR the other for its entire lifetime; the trust anchor
// is captured at vault-create time and never rotates in Phase 7
// (rotation gossip is deferred to Phase 6.1).
//
// KNOWN GAP — REVOCATION (Phase 7, documented for Phase 6.1 follow-up):
// Local-CA mode has NO peer-to-peer revocation channel. Once a VMC is
// issued for a peer, it remains verifiable until its 60-day TTL elapses.
// If a paired peer goes hostile or a phone is stolen, the only mitigation
// today is rotating the vault trust anchor entirely — which is itself
// deferred to Phase 6.1 (rotation gossip). Server-anchored vaults still
// have working revocation via the existing /v1/check-in revocation_list
// payload (see applyServerRevocations in vmc.ts). Until Phase 6.1, users
// of local-anchored vaults should be told that pairing is a one-way trust
// extension — if they need to un-trust a phone, they have to abandon the
// vault and create a new one.
//
// The "account_id" field is required by the VMC schema. For a local-only
// peer (never signed in) we synthesize a stable sentinel of the form
//   "local:<base64url(devicePubkey).slice(0, 16)>"
// so events authored by that peer have a non-empty actor identity that
// survives across reboots and is collision-resistant in practice (~96
// bits of entropy after the prefix).

import { signWithDeviceKey } from "./device-key";

// ---------------------------------------------------------------------------
// Constants — mirror vmc.ts where possible
// ---------------------------------------------------------------------------

const LOCAL_VMC_SCHEMA_VERSION = 1;
const LOCAL_VMC_ISSUER = "kaata-mesh-local-v1";
const DEFAULT_EXPIRES_IN_DAYS = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalVMCRole = "owner" | "editor" | "viewer";

export type LocalVMCParams = {
  vaultId: string;
  /**
   * Account identity to embed. For peers signed in to Google, pass the real
   * account_id. For local-only peers, pass the sentinel produced by
   * buildLocalAccountId(peerDevicePubkey).
   */
  peerAccountId: string;
  peerDeviceId: string;
  /**
   * Peer's Ed25519 public key as base64 (44 chars, standard encoding —
   * NOT URL-safe). Same encoding used by server-issued VMCs so the
   * verifier in vmc.ts doesn't need a separate decode path.
   */
  peerDevicePubkey: string;
  role: LocalVMCRole;
  vaultEpoch: number;
  /** Defaults to 60 days, matching server-issued VMC lifetime. */
  expiresInDays?: number;
};

export type LocalVMCIssueResult = {
  /** Wire format: base64(canonical_json) + "." + base64(signature). */
  blob: string;
  expiresAtMs: number;
};

// ---------------------------------------------------------------------------
// base64 helpers (Hermes-safe, latin-1 round-trip — same shape as vmc.ts)
// ---------------------------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  return btoa(s);
}

function bytesToB64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Canonical JSON for VMC payloads: keys sorted lexicographically, no
 * whitespace, no trailing newline. The verifier signs the EXACT bytes we
 * emit here (and the verifier itself only decodes base64 → bytes and
 * feeds those bytes to ed25519.verify), so the canonical encoding is
 * what binds the signature.
 *
 * We intentionally re-implement this here (instead of relying on
 * JSON.stringify with sorted keys) to make the field ordering explicit
 * and audit-friendly. The output is deterministic across Hermes / Node.
 */
function canonicalJSON(obj: Record<string, string | number>): string {
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    parts.push(JSON.stringify(k) + ":" + JSON.stringify(v));
  }
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deterministic account_id sentinel for a local-only peer who is
 * not signed in to Google. The string is stable across reboots (depends
 * only on the device's long-lived Ed25519 pubkey) and surfaces clearly
 * in audit / projection rows as a "local:..." prefix.
 *
 * Accepts either the raw 32 bytes or the base64-encoded pubkey for
 * convenience (the in-memory device-key cache hands back base64 already).
 */
export function buildLocalAccountId(devicePubkey: Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof devicePubkey === "string") {
    bytes = b64ToBytes(devicePubkey);
  } else {
    bytes = devicePubkey;
  }
  if (bytes.length !== 32) {
    throw new Error(`buildLocalAccountId: device pubkey must be 32 bytes (got ${bytes.length})`);
  }
  return "local:" + bytesToB64Url(bytes).slice(0, 16);
}

/**
 * Issue a VMC for a peer device, signed by THIS device's private key.
 *
 * Pre-condition: this device must be the owner of the vault (the verifier
 * matches the signature against vault.vault_trust_anchor_pubkey, which
 * equals this device's pubkey when this device created the vault).
 * Issuing a local VMC from a non-owner device is structurally allowed by
 * this function (it doesn't read the vault row), but the resulting blob
 * will fail verification on the receiving end.
 *
 * Returns: { blob, expiresAtMs }.
 */
export async function issueLocalVMC(params: LocalVMCParams): Promise<LocalVMCIssueResult> {
  // Validate peer pubkey length without losing the base64 round-trip.
  let peerPubkeyBytes: Uint8Array;
  try {
    peerPubkeyBytes = b64ToBytes(params.peerDevicePubkey);
  } catch {
    throw new Error("issueLocalVMC: peerDevicePubkey is not valid base64");
  }
  if (peerPubkeyBytes.length !== 32) {
    throw new Error(
      `issueLocalVMC: peerDevicePubkey must decode to 32 bytes (got ${peerPubkeyBytes.length})`,
    );
  }
  if (params.role !== "owner" && params.role !== "editor" && params.role !== "viewer") {
    throw new Error(`issueLocalVMC: invalid role ${params.role}`);
  }

  const issuedAtMs = Date.now();
  const expiresInDays = params.expiresInDays ?? DEFAULT_EXPIRES_IN_DAYS;
  const expiresAtMs = issuedAtMs + expiresInDays * 24 * 60 * 60 * 1000;

  // Field set MUST mirror server-signed VMCs (vmc.ts parsePayload
  // typecheck) so the same verifier accepts both. The only field that
  // differs is `iss`.
  const payload: Record<string, string | number> = {
    v: LOCAL_VMC_SCHEMA_VERSION,
    vault_id: params.vaultId,
    account_id: params.peerAccountId,
    device_id: params.peerDeviceId,
    device_pubkey: params.peerDevicePubkey,
    role: params.role,
    vault_epoch: params.vaultEpoch,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
    iss: LOCAL_VMC_ISSUER,
  };

  const canonical = canonicalJSON(payload);
  // eslint-disable-next-line no-undef
  const payloadBytes = new TextEncoder().encode(canonical);

  // Sign the canonical payload bytes with this device's Ed25519 privkey.
  // signWithDeviceKey is the same primitive used for handshake PoP.
  const sigBytes = await signWithDeviceKey(payloadBytes);
  if (sigBytes.length !== 64) {
    throw new Error(
      `issueLocalVMC: signWithDeviceKey returned ${sigBytes.length} bytes (expected 64)`,
    );
  }

  const blob = bytesToB64(payloadBytes) + "." + bytesToB64(sigBytes);
  return { blob, expiresAtMs };
}

// Re-export issuer string so call sites in vmc.ts / tests can reference
// it without restating the literal.
export const LOCAL_ISSUER_TAG = LOCAL_VMC_ISSUER;
