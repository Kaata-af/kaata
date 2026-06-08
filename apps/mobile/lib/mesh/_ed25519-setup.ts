// Side-effect-only module — install the two @noble/ed25519 v2 shims that
// Hermes needs before any sign/verify/keygen call.
//
//   - sha512Sync   — synchronous SHA-512 (Hermes has no Subtle Crypto)
//   - randomBytes  — CSPRNG via expo-crypto (Hermes has no globalThis.crypto.getRandomValues)
//
// Import this module (for its side effects only — no exports) from any
// file that calls @noble/ed25519 BEFORE the call site. The mesh barrel
// `./index.ts` imports it, and `./device-key.ts` imports it directly
// because `vault/new.tsx` reaches into device-key.ts without going
// through the barrel and would otherwise hit the keygen path with
// `etc.randomBytes` undefined.

import { sha512 } from "@noble/hashes/sha512";
import { etc } from "@noble/ed25519";
import * as ExpoCrypto from "expo-crypto";

etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));
etc.randomBytes = (len?: number) => ExpoCrypto.getRandomBytes(len ?? 32);
