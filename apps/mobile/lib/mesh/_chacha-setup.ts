// apps/mobile/lib/mesh/_chacha-setup.ts
//
// Side-effect-only module — ensures `globalThis.crypto.getRandomValues` is
// installed before @noble/curves (x25519) and @noble/ciphers (ChaCha20-Poly1305)
// load. The actual shim now lives in `./_crypto-polyfill` (a noble-free module
// imported first, everywhere) — see that file for why the polyfill MUST precede
// the first `@noble/hashes/crypto` evaluation, and why splitting it out of
// _ed25519-setup.ts was necessary to make x25519 keygen work on Hermes.
//
// This module is kept as a thin, named alias because aead.ts imports
// "./_chacha-setup" right above its @noble/ciphers / @noble/curves imports to
// document the ordering requirement at the call site. Importing it simply pulls
// in the shared polyfill.

import "./_crypto-polyfill";
