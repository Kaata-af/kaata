// All build-time URLs for the web app. Override via VITE_* env vars at
// build time (Dokploy build env / .env.local for dev). Defaults are
// chosen so a `vite build` works out of the box for local testing.

export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";

export const WHATSAPP_CONTACT_URL: string =
  import.meta.env.VITE_WHATSAPP_CONTACT_URL ?? "https://wa.me/93781696644";

export const APK_VERSION: string = import.meta.env.VITE_APK_VERSION ?? "0.1.0";

export const APK_DOWNLOAD_URL: string =
  import.meta.env.VITE_APK_DOWNLOAD_URL ?? `/downloads/kaata-${APK_VERSION}.apk`;

// Operator analytics dashboard (/admin) — the shared secret matching the
// backend's ADMIN_API_KEY. Optional convenience: if baked in, the dashboard
// auto-authenticates; otherwise the operator pastes the key into the login box
// (stored in localStorage). Both are operator-controlled, never a user secret.
export const ADMIN_API_KEY: string = import.meta.env.VITE_ADMIN_API_KEY ?? "";
