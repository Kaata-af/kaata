// All build-time URLs for the web app. Override via VITE_* env vars at
// build time (Dokploy build args / .env.local for dev). Defaults are chosen so
// a `vite build` works out of the box for local testing.
//
// IMPORTANT: read every value through envOr(), NOT `?? default`. A Docker ARG
// that is declared but not given a value (see apps/web/Dockerfile — e.g.
// `ARG VITE_APK_DOWNLOAD_URL=`) reaches the bundle as an EMPTY STRING, and
// `?? default` does NOT fall back on "" (only on null/undefined). A blank
// VITE_APK_DOWNLOAD_URL build-arg therefore used to render the download button
// as <a href="">, which silently navigates to the current page instead of
// downloading. envOr() treats blank/whitespace as "unset" and uses the default.
function envOr(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}

export const BACKEND_URL: string = envOr(import.meta.env.VITE_BACKEND_URL, "http://localhost:8080");

export const WHATSAPP_CONTACT_URL: string = envOr(
  import.meta.env.VITE_WHATSAPP_CONTACT_URL,
  "https://wa.me/93781696644",
);

// Social profiles — stable brand handles shown in the footer (and mirrored in
// the JSON-LD `sameAs` in index.html). Not env-driven: there's no per-deploy
// reason to point these elsewhere, so no VITE_* var / Dockerfile ARG.
export const FACEBOOK_URL = "https://www.facebook.com/kaata.af";
export const INSTAGRAM_URL = "https://www.instagram.com/kaata.af";

// The store listings. Like the social handles, these are stable brand URLs
// (app ids never change across releases), so they're not env-driven. The
// old VITE_APK_VERSION / VITE_APK_DOWNLOAD_URL build args retired with the
// sideload download button when Play went live (2026-07-26) — delete them
// from Dokploy's kaata-web build args; the backend's APK_DOWNLOAD_URL (its
// cache source for the existing sideload fleet's update banner) is a
// DIFFERENT var and stays.
export const APP_STORE_URL = "https://apps.apple.com/us/app/kaata/id6789651127";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=af.kaata.app";

// NOTE: there is deliberately NO ADMIN_API_KEY export. VITE_* values are baked
// verbatim into the public JS bundle served to every kaata.af visitor, so
// exposing the admin secret here (even as an optional convenience) risked
// leaking the whole user PII directory the moment an operator set the build
// arg. The /admin dashboard authenticates via a paste-once localStorage login;
// the backend Bearer check is the only real security boundary.
