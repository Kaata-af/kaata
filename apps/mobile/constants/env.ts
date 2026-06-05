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
