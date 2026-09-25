// All build-time URLs for the web app. Override via VITE_* env vars at
// build time (Dokploy build args / .env.local for dev). Defaults are chosen so
// a `vite build` works out of the box for local testing.
//
// Treat blank/whitespace build args as unset so empty Docker arguments do not
// override usable defaults with an empty URL.
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
export const TIKTOK_URL = "https://www.tiktok.com/@kaata.af";
export const YOUTUBE_URL = "https://www.youtube.com/@KaataAF";

// Official store listings are stable brand URLs, not environment settings.
export const APP_STORE_URL = "https://apps.apple.com/us/app/kaata/id6789651127";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=af.kaata.app";

// NOTE: there is deliberately NO ADMIN_API_KEY export. VITE_* values are baked
// verbatim into the public JS bundle served to every kaata.af visitor, so
// exposing the admin secret here (even as an optional convenience) risked
// leaking the whole user PII directory the moment an operator set the build
// arg. The /admin dashboard authenticates via a paste-once localStorage login;
// the backend Bearer check is the only real security boundary.
