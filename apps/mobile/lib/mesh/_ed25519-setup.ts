// Side-effect-only module — install the crypto shims that Hermes needs
// before any sign/verify/keygen call AND any AEAD / X25519 ECDH call.
//
//   - sha512Sync                  — synchronous SHA-512 (Hermes has no Subtle Crypto)
//   - etc.randomBytes             — CSPRNG for @noble/ed25519 v2
//   - globalThis.crypto.getRandomValues
//                                  — Web Crypto polyfill for the other @noble/*
//                                    libraries (@noble/ciphers, @noble/curves)
//                                    that don't go through ed25519's etc namespace
//                                    and reach for the global directly. Without
//                                    this, the BLE handshake threw
//                                    "[Error: crypto.getRandomValues must be defined]"
//                                    at AEAD setup → caught as MeshHandshakeError →
//                                    surfaced as menu.ble.peerHandshakeFailed toast
//                                    with NO mesh sync ever working on real hardware.
//                                    The error was silent before BUG-Q's MAC
//                                    randomization fix because the dial cancellation
//                                    cascade killed handshakes before they reached
//                                    AEAD setup.
//
// Import this module (for its side effects only — no exports) from any
// file that calls @noble/* BEFORE the call site. The mesh barrel
// `./index.ts` imports it, and `./device-key.ts` imports it directly
// because `vault/new.tsx` reaches into device-key.ts without going
// through the barrel and would otherwise hit the keygen path with
// `etc.randomBytes` undefined.

import { sha512 } from "@noble/hashes/sha512";
import { etc } from "@noble/ed25519";
import * as ExpoCrypto from "expo-crypto";

etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));
etc.randomBytes = (len?: number) => ExpoCrypto.getRandomBytes(len ?? 32);

// Web Crypto polyfill. Install ONCE, defensively: respect any existing
// real implementation (e.g. a future Hermes update that ships subtle).
// expo-crypto's getRandomBytes is a CSPRNG (NDK SecRandom on Android,
// SecRandomCopyBytes on iOS), so the entropy quality is correct.
declare const globalThis: {
  crypto?: { getRandomValues?: <T extends ArrayBufferView>(buf: T) => T };
};
if (typeof globalThis.crypto === "undefined") {
  // Hermes default — install both the namespace and the method.
  (globalThis as { crypto: object }).crypto = {};
}
if (globalThis.crypto != null && typeof globalThis.crypto.getRandomValues !== "function") {
  (globalThis.crypto as { getRandomValues: unknown }).getRandomValues = <T extends ArrayBufferView>(
    buf: T,
  ): T => {
    const bytes = ExpoCrypto.getRandomBytes(buf.byteLength);
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).set(bytes);
    return buf;
  };
}
