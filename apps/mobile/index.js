// Mythos P4 fix: custom entry that GUARANTEES the crypto polyfill is
// installed before any module that might call globalThis.crypto.
// getRandomValues at import time.
//
// Why this exists (and why "first import of app/_layout.tsx" wasn't enough):
//
//   With Expo Router, expo-router/entry is the registered RN entry point.
//   It eagerly walks the app/ tree to build the route map BEFORE any
//   useEffect inside a component runs. If any module in that walk —
//   present today or added in the future — touches an @noble/ciphers /
//   @noble/curves call site at import time (a top-level `const k =
//   ed.utils.randomPrivateKey()`, a module-level seeded random, etc.),
//   crypto.getRandomValues throws and the bundle fails to load.
//
//   The bug Mythos found (R) was the runtime version of this: the AEAD
//   path inside the BLE handshake called getRandomValues. We fixed that
//   by importing _ed25519-setup at the top of app/_layout.tsx, which
//   USUALLY runs early enough. But it's not guaranteed earlier than
//   expo-router/entry's own module walk.
//
//   This file makes the ordering structural: polyfill loads first,
//   then expo-router/entry, then everything else. No race window.

import "./lib/mesh/_ed25519-setup";
// eslint-disable-next-line import/no-unresolved
import "expo-router/entry";
