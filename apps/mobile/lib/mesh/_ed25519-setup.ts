// Side-effect-only module — install the @noble/ed25519 v2 shims that Hermes
// needs before any sign/verify/keygen call:
//
//   - sha512Sync       — synchronous SHA-512 (Hermes has no Subtle Crypto)
//   - etc.randomBytes  — CSPRNG for @noble/ed25519 v2
//
// The `globalThis.crypto.getRandomValues` polyfill (needed by @noble/ciphers
// and @noble/curves, which don't go through ed25519's `etc` namespace) lives in
// `./_crypto-polyfill` and is imported FIRST below. It MUST run before the
// `@noble/hashes/sha512` import on the next line: @noble/hashes/crypto captures
// `globalThis.crypto` eagerly at module load (see _crypto-polyfill.ts for the
// full story), so loading any @noble/hashes module before the shim freezes an
// undefined CSPRNG and x25519 keygen throws "crypto.getRandomValues must be
// defined" at AEAD setup. ES imports evaluate in order, so _crypto-polyfill
// (first import, zero noble deps) is guaranteed in place before sha512 loads.
//
// Import this module (for its side effects only — no exports) from any file
// that calls @noble/ed25519 BEFORE the call site. The mesh barrel `./index.ts`
// imports it, and `./device-key.ts` imports it directly because `vault/new.tsx`
// reaches into device-key.ts without going through the barrel and would
// otherwise hit the keygen path with `etc.randomBytes` undefined.

import "./_crypto-polyfill";
import { sha512 } from "@noble/hashes/sha512";
import { etc } from "@noble/ed25519";
import * as ExpoCrypto from "expo-crypto";

etc.sha512Sync = (...m: Uint8Array[]) => sha512(etc.concatBytes(...m));
etc.randomBytes = (len?: number) => ExpoCrypto.getRandomBytes(len ?? 32);
