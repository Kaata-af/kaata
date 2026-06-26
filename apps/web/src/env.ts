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

export const APK_VERSION: string = envOr(import.meta.env.VITE_APK_VERSION, "0.1.0");

// The APK is distributed as a GitHub Release asset (it exceeds GitHub's 100 MB
// per-file git limit, so the old same-origin /downloads/kaata-*.apk path is gone
// — it would 404). When VITE_APK_DOWNLOAD_URL isn't set, derive the canonical
// release asset for the current version: `kaata-<version>.apk` under tag
// `v<version>` (the naming the release playbook in CLAUDE.md uses). This keeps
// the button working even if the build-arg is forgotten, as long as the asset
// follows that name.
export const APK_DOWNLOAD_URL: string = envOr(
  import.meta.env.VITE_APK_DOWNLOAD_URL,
  `https://github.com/Kaata-af/kaata/releases/download/v${APK_VERSION}/kaata-${APK_VERSION}.apk`,
);

// Operator analytics dashboard (/admin) — the shared secret matching the
// backend's ADMIN_API_KEY. Optional convenience: if baked in, the dashboard
// auto-authenticates; otherwise the operator pastes the key into the login box
// (stored in localStorage). Empty is a valid "not baked in" state.
export const ADMIN_API_KEY: string = (import.meta.env.VITE_ADMIN_API_KEY ?? "").trim();
