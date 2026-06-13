// apps/mobile/lib/mesh/_chacha-setup.ts
//
// Side-effect-only module — install a `globalThis.crypto.getRandomValues`
// shim so @noble/curves (x25519) and @noble/ciphers (ChaCha20-Poly1305)
// can call into the OS CSPRNG via expo-crypto on Hermes.
//
// Both libraries reach for `globalThis.crypto.getRandomValues` at runtime
// (see @noble/hashes/utils.js: randomBytes()). Hermes does NOT ship this
// global, so without the shim x25519.utils.randomSecretKey() throws
// "No secure random number generator available".
//
// This mirrors the convention from _ed25519-setup.ts (etc.randomBytes
// shim for @noble/ed25519 v2). Importing for side effects only — no
// exports.
//
// IMPORTANT: import this BEFORE any x25519.* or chacha20poly1305() call,
// at the top of aead.ts and (transitively) transport-ble.ts.
//
// expo-crypto is require()'d LAZILY — only when the platform actually lacks
// WebCrypto (i.e. Hermes). Metro still bundles it (the require() has a static
// string literal), so the Hermes shim path is unchanged. But on a runtime
// that already ships globalThis.crypto.getRandomValues (bun, Node, a future
// Hermes), the require never executes, so the bun mesh selftests can import
// aead.ts without dragging in the react-native module graph through
// expo-crypto. (Eager `import * as ExpoCrypto from "expo-crypto"` resolved
// react-native at module-load and broke `bun lib/mesh/__dev__/*-selftest.ts`.)

const g = globalThis as unknown as {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
};
if (!g.crypto || typeof g.crypto.getRandomValues !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExpoCrypto = require("expo-crypto") as { getRandomBytes: (n: number) => Uint8Array };
  g.crypto = {
    ...(g.crypto ?? {}),
    getRandomValues: (arr: Uint8Array): Uint8Array => {
      const bytes = ExpoCrypto.getRandomBytes(arr.length);
      arr.set(bytes);
      return arr;
    },
  } as Crypto;
  if (__DEV__) console.log("[chacha-setup] globalThis.crypto.getRandomValues shim installed");
}
