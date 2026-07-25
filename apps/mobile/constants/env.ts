// First-launch fallback backend URL — baked into the APK at build time via
// EXPO_PUBLIC_BACKEND_URL in apps/mobile/eas.json. Used only when there's no
// `backend_url_override` saved in app_meta yet. As soon as the backend's
// check-in response includes a `migrate_to_backend_url`, that becomes canonical.
// See lib/api.ts -> getBackendUrl().
export const BACKEND_URL_FALLBACK = process.env.EXPO_PUBLIC_BACKEND_URL || "http://localhost:8080";

// Google OAuth Web Client ID — the "Web application" client configured in
// Google Cloud Console for kaata. Passed to GoogleSignin.configure() at
// app start so the ID token's `aud` claim matches what the backend
// expects (the backend env var GOOGLE_WEB_CLIENT_ID is the same string).
// Public value; safe to bake into the APK.
export const GOOGLE_WEB_CLIENT_ID =
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  "987359341353-3bjb28b0hksu9l0ubaogk3p0d7aftjv1.apps.googleusercontent.com";

// SOLO_STORE_MODE gates the multi-employee / device-mesh surface for the
// single-shopkeeper release. When "1", hides the Nearby (Bluetooth/WiFi) sync
// toggle + the kaata-pairing entry points — a lone shopkeeper has no use for them
// and they read as broken/confusing. Cloud backup (the solo-relevant sync) stays.
// Build-time, like the other EXPO_PUBLIC_ flags; set in eas.json preview/production.
export const SOLO_STORE_MODE = process.env.EXPO_PUBLIC_SOLO_STORE_MODE === "1";

// Google OAuth iOS Client ID — the "iOS" OAuth client in Google Cloud
// Console (bundle id af.kaata.app), required for Google sign-in ON IPHONES.
// Distinct from GOOGLE_WEB_CLIENT_ID above (the token audience the backend
// verifies — that one stays the Web client on BOTH platforms). Unset =
// Google sign-in stays unavailable on iOS (the button hides); Android is
// unaffected. When setting this, apps/mobile/app.json's google-signin plugin
// `iosUrlScheme` must be the REVERSED form of this same id
// (com.googleusercontent.apps.<id-without-suffix>). Public value.
export const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || "";

// DISTRIBUTION — which channel THIS BINARY was built for, deciding where the
// update banner / force-update screen send the user:
//   "apk"   → sideload builds (preview profile). Updates come as a direct APK
//             download (the resumable backend endpoint).
//   "store" → store builds (production profile: Play AAB / App Store IPA).
//             Updates must go through the store listing — a Play install
//             CANNOT apply a sideloaded APK (Play App Signing re-signs, so
//             the signatures differ) and vice versa.
// Build-time via eas.json env. Defaults to "apk": every existing sideload
// install predates this flag, and dev builds behave like sideloads.
export const DISTRIBUTION: "apk" | "store" =
  process.env.EXPO_PUBLIC_DISTRIBUTION === "store" ? "store" : "apk";

// The app's App Store listing — stable brand URL (the Apple app id never
// changes across releases), safe to bake as the iOS update fallback.
export const APP_STORE_URL = "https://apps.apple.com/us/app/kaata/id6789651127";

// MESH_PARKED hard-disables the offline Bluetooth/Wi-Fi "Nearby sync" mesh (and
// its persistent foreground-service notification) WITHOUT deleting any feature
// code — the whole subsystem is parked until a future release. Unlike
// SOLO_STORE_MODE this is deliberately NOT env-driven: it's a compile-time
// constant, so the mesh stays off in EVERY build and profile regardless of
// whether the eas.json env got baked in correctly. Honored at the single FGS
// start choke point (lib/mesh/foreground.ts -> startShopModeForegroundService),
// by MeshController's wantOn gate, and by _layout.tsx's boot teardown (which
// stops any leftover native FGS + cancels its revival alarm). Because we never
// START the service while parked, KEY_FGS_SHOULD_RUN is never set, so the native
// 15-min revival alarm can never resurrect the notification either. Flip to
// false to bring Nearby sync back.
export const MESH_PARKED = true;
