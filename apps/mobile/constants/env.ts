// First-launch fallback backend URL — baked into the APK at build time via
// EXPO_PUBLIC_BACKEND_URL in apps/mobile/eas.json. Used only when there's no
// `backend_url_override` saved in app_meta yet. As soon as the backend's
// check-in response includes a `next_backend_url`, that becomes canonical.
// See lib/api.ts -> getBackendUrl().
export const BACKEND_URL_FALLBACK = process.env.EXPO_PUBLIC_BACKEND_URL || "http://localhost:8080";
