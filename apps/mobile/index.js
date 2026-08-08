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
//
//   _crypto-polyfill MUST be the very first import: it is the ONLY
//   crypto-setup module with zero @noble/* imports, so it can install
//   globalThis.crypto.getRandomValues before any @noble/hashes/crypto
//   module is evaluated (those capture globalThis.crypto eagerly at load —
//   see lib/mesh/_crypto-polyfill.ts). _ed25519-setup imports it first
//   internally too, but listing it explicitly here keeps the guarantee
//   robust against future import reordering.

import "./lib/mesh/_crypto-polyfill";
import "./lib/mesh/_ed25519-setup";
// #43 P2 Phase 1: register the periodic background-catch-up task (TaskManager
// .defineTask runs at module load). Imported AFTER the crypto polyfills so the
// task — which may run in a headless context that re-enters this bundle — has
// crypto ready. The task itself does nothing unless the Phase 0 kill-switch is on.
import "./lib/mesh/bg-task";
// #46: per-sync notifications. Subscribes to ledger-applied at load so it's active
// in both the foreground (when backgrounded) and the headless context.
import "./lib/mesh/bg-notify";

// Keep the native (black, branded) splash up until the React tree has actually
// mounted + drawn its first frame — app/_layout.tsx calls hideAsync() once the
// app (or an error / restart screen) is ready. Without this the native splash
// auto-dismisses the moment the JS bundle loads, and on some Android ROMs
// (Xiaomi/MIUI) the Activity then shows its bare WHITE window background —
// covering even the status + nav bars — until a touch forces the first draw
// (the "blank white until I swipe" bug). Calling preventAutoHideAsync at the
// entry is the earliest possible point.
import * as SplashScreen from "expo-splash-screen";
SplashScreen.preventAutoHideAsync().catch(() => {});

// eslint-disable-next-line import/no-unresolved
import "expo-router/entry";
