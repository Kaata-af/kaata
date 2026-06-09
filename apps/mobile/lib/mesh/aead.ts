// apps/mobile/lib/mesh/aead.ts
//
// Phase 6 follow-up: per-session AEAD for the BLE transport.
//
// CRYPTO STACK
//   - Ephemeral key agreement: X25519 ECDH (one fresh keypair per session;
//     NOT the device long-term Ed25519 key — that's authentication only).
//   - Session key derivation:  HKDF-SHA512(shared_secret,
//                                          info="kaata-mesh-aead-v1",
//                                          salt=initiator_nonce||responder_nonce)
//     32-byte output → ChaCha20-Poly1305 key.
//   - Frame AEAD:              ChaCha20-Poly1305 (IETF variant, 12-byte nonce).
//
// NONCE LAYOUT (12 bytes)
//   [0..3]  direction marker — 4 bytes, big-endian:
//             0x00000000 = sender-with-lexicographically-smaller-ephemeral-pub
//             0x00000001 = the other side
//           This guarantees the two directions never share a nonce, even with
//           identical sequence counters.
//   [4..11] sequence counter — 8 bytes, big-endian u64, monotonic per
//           direction, starts at 0, increments per frame sent.
//
// REPLAY PROTECTION
//   The receiver tracks recvLastCounter and rejects any inbound chunk whose
//   reconstructed counter <= recvLastCounter. We do NOT support a sliding
//   window — BLE GATT notifications on a single characteristic are ORDERED
//   per link, so strict monotonicity is correct.
//
// AAD
//   The 7-byte frame header (frame_id, chunk_index, chunk_count, length)
//   is authenticated but NOT encrypted. Header tampering yields AEAD
//   failure on the very first chunk of the frame.
//
// FAIL CLOSED
//   Any decrypt failure throws MeshAeadError. Caller (BleMeshConnection)
//   closes the connection on this error — we never return "maybe-valid"
//   bytes.

import "./_chacha-setup";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha512 } from "@noble/hashes/sha512";

export class MeshAeadError extends Error {
  code: "bad_pubkey" | "decrypt_failed" | "replay" | "rollover";
  constructor(message: string, code: MeshAeadError["code"]) {
    super(message);
    this.name = "MeshAeadError";
    this.code = code;
  }
}

export const AEAD_KEY_BYTES = 32;
export const X25519_PUBKEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
// v2: salt construction changed in 0.5.2 final to use RAW nonce bytes +
// initiator/responder ephemeral pubkeys (see deriveSessionAead). Bumping
// the info string prevents a silent confusion between v0.5.2-rc clients
// (kaata-mesh-aead-v1) and the final 0.5.2 release.
export const HKDF_INFO = new TextEncoder().encode("kaata-mesh-aead-v2");
export const SEQ_MAX = (1n << 64n) - 1n;

export type EphemeralKeyPair = {
  privateKey: Uint8Array; // 32 bytes — KEEP IN MEMORY ONLY, never persisted
  publicKey: Uint8Array; //  32 bytes — sent in HelloMessage
};

/**
 * Generate a fresh X25519 keypair for a single mesh session. Discarded
 * when the connection closes. Even if a future device-key compromise
 * happens, recorded BLE traffic from a past session is unrecoverable
 * (forward secrecy).
 */
export function generateEphemeralKeyPair(): EphemeralKeyPair {
  // x25519.utils.randomSecretKey() goes through globalThis.crypto via the
  // _chacha-setup.ts shim. 32 bytes CSPRNG.
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export type BleAeadContext = {
  /** 32-byte ChaCha20-Poly1305 key */
  key: Uint8Array;
  /** u32, encoded into nonce bytes [0..3] for outbound */
  sendDirectionTag: number;
  /** u32, expected in inbound nonce bytes [0..3] */
  recvDirectionTag: number;
  /** outbound u64, increments per sealed chunk */
  sendCounter: bigint;
  /** highest inbound counter accepted (-1n initially → first inbound is 0) */
  recvLastCounter: bigint;
};

/**
 * Derive the per-session ChaCha20-Poly1305 key + per-direction nonce
 * prefixes from both ephemeral pubkeys + both handshake nonces.
 *
 * The role discriminator (initiator vs responder) is computed
 * deterministically by comparing the two X25519 pubkeys lexicographically.
 * BOTH sides arrive at the SAME (key, our-direction, their-direction)
 * assignment without an explicit role round-trip in Hello.
 *
 * The HKDF salt uses the two pop_nonces from Hello — these are already
 * exchanged and authenticated as part of the PoP step, so reusing them
 * binds the session key to the same exchange that authenticated the
 * peer's device key.
 */
export function deriveSessionAead(args: {
  ownPriv: Uint8Array;
  ownPub: Uint8Array;
  peerPub: Uint8Array;
  ownNonceB64: string;
  peerNonceB64: string;
}): BleAeadContext {
  if (args.peerPub.length !== X25519_PUBKEY_BYTES) {
    throw new MeshAeadError(
      `peer X25519 pubkey wrong length ${args.peerPub.length} (expected ${X25519_PUBKEY_BYTES})`,
      "bad_pubkey",
    );
  }
  // All-zero peer pubkey would produce all-zero shared secret. @noble enforces
  // this on getSharedSecret, but be explicit for the dev-readable error.
  let allZero = true;
  for (let i = 0; i < args.peerPub.length; i++) {
    if (args.peerPub[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new MeshAeadError("peer X25519 pubkey is all zero (illegal)", "bad_pubkey");
  }
  // Mobile-Native critique H2: reject identical pubkeys. lexLess(a,a) returns
  // false; if a peer echoes our ephemeral pubkey (faulty CSPRNG / hostile
  // peer), both sides would compute the same direction tag → catastrophic
  // nonce reuse on frame 0. Refuse explicitly.
  if (args.ownPub.length === args.peerPub.length) {
    let identical = true;
    for (let i = 0; i < args.ownPub.length; i++) {
      if (args.ownPub[i] !== args.peerPub[i]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      throw new MeshAeadError(
        "peer X25519 pubkey is identical to our own (illegal — would force nonce reuse)",
        "bad_pubkey",
      );
    }
  }

  const sharedSecret = x25519.getSharedSecret(args.ownPriv, args.peerPub);

  // HKDF salt — Mobile-Native critique H3: use RAW nonce bytes (decoded
  // from base64url) rather than the ASCII representation, which has only
  // 64 possible bytes per position. Both sides arrive at the same bytes
  // because the (initiator, responder) ordering is deterministic.
  //
  // Engineering critique N#2 / H4: ALSO bind both ephemeral pubkeys into
  // the salt so a Hello-mutation attacker who substitutes a different
  // ephemeral pubkey can't end up with a key the peer's PoP signature
  // commits to. The PoP also binds these via buildPopMessageWithEphemerals;
  // belt-and-suspenders.
  const ownNonceRaw = b64UrlToBytes(args.ownNonceB64);
  const peerNonceRaw = b64UrlToBytes(args.peerNonceB64);
  const initiatorIsUs = lexLess(args.ownPub, args.peerPub);
  const initiatorNonce = initiatorIsUs ? ownNonceRaw : peerNonceRaw;
  const responderNonce = initiatorIsUs ? peerNonceRaw : ownNonceRaw;
  const initiatorPub = initiatorIsUs ? args.ownPub : args.peerPub;
  const responderPub = initiatorIsUs ? args.peerPub : args.ownPub;
  const saltLen =
    initiatorNonce.length + responderNonce.length + initiatorPub.length + responderPub.length;
  const salt = new Uint8Array(saltLen);
  let off = 0;
  salt.set(initiatorNonce, off);
  off += initiatorNonce.length;
  salt.set(responderNonce, off);
  off += responderNonce.length;
  salt.set(initiatorPub, off);
  off += initiatorPub.length;
  salt.set(responderPub, off);

  const key = hkdf(sha512, sharedSecret, salt, HKDF_INFO, AEAD_KEY_BYTES);

  return {
    key,
    sendDirectionTag: initiatorIsUs ? 0x00000000 : 0x00000001,
    recvDirectionTag: initiatorIsUs ? 0x00000001 : 0x00000000,
    sendCounter: 0n,
    recvLastCounter: -1n,
  };
}

/**
 * Mobile-Native critique H5: best-effort zero-fill of the ephemeral
 * private key after deriveSessionAead has consumed it. Hermes doesn't
 * guarantee GC zeroization; explicit wipe shrinks the heap-snapshot
 * exfil window for the forward-secrecy property.
 *
 * Safe to call repeatedly. Does not affect the derived AEAD key.
 */
export function wipeEphemeralPriv(priv: Uint8Array): void {
  for (let i = 0; i < priv.length; i++) priv[i] = 0;
}

/** Lexicographic comparison: returns true iff `a` < `b`. */
function lexLess(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Build a 12-byte nonce: 4-byte BE direction tag, 8-byte BE u64 counter. */
function buildNonce(directionTag: number, counter: bigint): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  n[0] = (directionTag >>> 24) & 0xff;
  n[1] = (directionTag >>> 16) & 0xff;
  n[2] = (directionTag >>> 8) & 0xff;
  n[3] = directionTag & 0xff;
  let v = counter;
  for (let i = 11; i >= 4; i--) {
    n[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return n;
}

/**
 * Seal one plaintext chunk. Returns ciphertext (plaintext.length + 16 tag
 * bytes). Advances aead.sendCounter.
 *
 * `aad` is the 7-byte frame header — authenticated but not encrypted.
 */
export function sealChunk(
  plaintext: Uint8Array,
  aad: Uint8Array,
  aead: BleAeadContext,
): Uint8Array {
  // Strict > comparison: SEQ_MAX (2^64-1) is the LAST legal counter value.
  // Reject only when the increment would overflow. Cosmetic — at BLE chunk
  // rates this is unreachable in practice, but matches u64 semantics.
  if (aead.sendCounter > SEQ_MAX) {
    throw new MeshAeadError("send-side sequence counter rolled over u64", "rollover");
  }
  const nonce = buildNonce(aead.sendDirectionTag, aead.sendCounter);
  const cipher = chacha20poly1305(aead.key, nonce, aad);
  const ct = cipher.encrypt(plaintext) as Uint8Array;
  aead.sendCounter += 1n;
  return ct;
}

/**
 * Open one ciphertext chunk. Verifies replay protection via the
 * monotonic receive counter, then ChaCha20-Poly1305 decrypt+verify.
 * Throws MeshAeadError on any failure — caller must close the connection.
 *
 * The expected counter is reconstructed as recvLastCounter+1 (strict
 * monotonic ordering — BLE GATT notifications on a single characteristic
 * are ORDERED per link).
 */
export function openChunk(
  ciphertext: Uint8Array,
  aad: Uint8Array,
  aead: BleAeadContext,
): Uint8Array {
  const expectedCounter = aead.recvLastCounter + 1n;
  if (expectedCounter > SEQ_MAX) {
    throw new MeshAeadError("recv-side sequence counter rolled over u64", "rollover");
  }
  const nonce = buildNonce(aead.recvDirectionTag, expectedCounter);
  const cipher = chacha20poly1305(aead.key, nonce, aad);
  let pt: Uint8Array;
  try {
    pt = cipher.decrypt(ciphertext) as Uint8Array;
  } catch (err) {
    throw new MeshAeadError(
      `ChaCha20-Poly1305 decrypt failed (seq=${expectedCounter}): ${(err as Error).message}`,
      "decrypt_failed",
    );
  }
  aead.recvLastCounter = expectedCounter;
  return pt;
}

// ---------------------------------------------------------------------------
// Base64url helpers (kept here so this module has no upward dep on
// anti-entropy.ts; anti-entropy has its own pair of identical helpers).
// ---------------------------------------------------------------------------

export function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64UrlToBytes(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
