// apps/mobile/lib/mesh/_crypto-polyfill.ts
//
// Side-effect-only module — installs `globalThis.crypto.getRandomValues`
// (a Hermes-safe Web Crypto CSPRNG shim) and NOTHING ELSE. It deliberately
// imports NO @noble/* module. Import it FIRST, before any noble code anywhere.
//
// WHY THIS MUST BE SEPARATE FROM _ed25519-setup / _chacha-setup
// ------------------------------------------------------------
// @noble/hashes, @noble/ciphers, and @noble/curves capture `globalThis.crypto`
// EAGERLY at module-load time:
//
//     // node_modules/@noble/hashes/crypto.js
//     exports.crypto = 'crypto' in globalThis ? globalThis.crypto : undefined;
//
// That binding is frozen for the life of the process. @noble/curves' x25519
// keygen routes through @noble/hashes/utils.randomBytes(), which reads that
// frozen binding and throws "crypto.getRandomValues must be defined" if it was
// undefined at capture time.
//
// The old polyfill lived at the BOTTOM of _ed25519-setup.ts — but that file
// imports `@noble/hashes/sha512` at its TOP, and ES `import` statements always
// evaluate before the module body. So @noble/hashes/crypto loaded (capturing
// `undefined`) BEFORE the polyfill ran. @noble/ed25519 survived because its
// randomness goes through the overridable `etc.randomBytes`; x25519 (the ChaCha
// AEAD ECDH in the real mesh handshake) does NOT — it threw the instant a
// Bluetooth handshake first reached AEAD setup on real hardware (BLE never got
// that far, which is why this stayed latent until M-BTC-3.1).
//
// Because this module has zero noble imports, importing it can never trigger a
// premature `@noble/*/crypto` capture. It is the first import of index.js
// (before expo-router/entry walks the route tree) AND the first import of
// _ed25519-setup.ts / _chacha-setup.ts — so whichever path loads first, the
// shim is installed before the first `@noble/hashes/crypto` evaluation.
//
// expo-crypto's getRandomBytes is a real CSPRNG (NDK SecureRandom on Android,
// SecRandomCopyBytes on iOS). require()'d LAZILY so a WebCrypto-capable runtime
// (bun/Node selftests) never drags the react-native module graph in and never
// overrides its own native implementation.

const g = globalThis as unknown as {
  crypto?: { getRandomValues?: <T extends ArrayBufferView>(buf: T) => T };
};

// Respect any real implementation (e.g. a future Hermes that ships Web Crypto,
// or bun/Node in the selftests).
if (typeof g.crypto === "undefined") {
  (g as { crypto: object }).crypto = {};
}
if (g.crypto != null && typeof g.crypto.getRandomValues !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ExpoCrypto = require("expo-crypto") as { getRandomBytes: (n: number) => Uint8Array };
  (g.crypto as { getRandomValues: unknown }).getRandomValues = <T extends ArrayBufferView>(
    buf: T,
  ): T => {
    const bytes = ExpoCrypto.getRandomBytes(buf.byteLength);
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).set(bytes);
    return buf;
  };
  if (__DEV__) console.log("[crypto-polyfill] globalThis.crypto.getRandomValues shim installed");
}
