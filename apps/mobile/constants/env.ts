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

// MESH_PARKED hard-disables the offline Bluetooth/Wi-Fi "Nearby sync" mesh (and
// its persistent foreground-service notification) WITHOUT deleting any feature
// code. Unlike SOLO_STORE_MODE this is deliberately NOT env-driven: it's a
// compile-time constant, so a re-park applies to EVERY build and profile
// regardless of whether the eas.json env got baked in correctly. Honored at
// three points: the single FGS start choke point (lib/mesh/foreground.ts ->
// startShopModeForegroundService no-ops), MeshController's wantOn gate, and
// _layout.tsx's boot teardown (which stops any leftover native FGS + cancels
// its revival alarm on every launch while parked/solo). Because a re-park
// makes the choke point no-op, the native service never starts,
// KEY_FGS_SHOULD_RUN is never set, and the 15-min revival alarm can never
// resurrect the notification.
//
// REVIVED 2026-07-04: Nearby sync is back on. The park (2026-06-24, 0802a09)
// was driven by the FGS-notification resurrection bug — fixed at its real
// source in 435cfed (native isForeground guard: an UPDATE can never CREATE the
// service) — plus the solo-release pivot, NOT by a broken sync protocol
// (5d42e4d recorded end-to-end Bluetooth sync working on 2026-06-19). Flip
// back to true to re-park; all three enforcement points above still hold.
export const MESH_PARKED = false;
