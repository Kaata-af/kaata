// Store badges for the download page — both stores LIVE, official artwork:
//   - "Download on the App Store": Apple's genuine badge (fetched from
//     Apple's marketing-toolbox badge API), linked to the listing.
//   - "Get it on Google Play": Google's official badge, linked to the Play
//     listing (live since 2026-07-26 — the dimmed "coming soon" state and
//     the direct-APK sideload button retired with it; the backend's
//     /v1/download + the in-app update banner keep serving the EXISTING
//     sideload fleet, which cannot migrate to Play in place because Play
//     App Signing re-signs with a different key).
//
// Both badges are BUNDLED (src/assets, hashed by Vite), never hotlinked:
// the site's CSP blocks foreign origins, and self-hosted assets match the
// slow-network posture the fonts already follow. Badges stay English in
// both locales — brand badges are conventionally untranslated here,
// matching the "brand names stay Latin" rule.

import { APP_STORE_URL, PLAY_STORE_URL } from "../env";
import { useI18n } from "../lib/i18n";
import appStoreBadge from "../assets/app-store-badge.svg";
import googlePlayBadge from "../assets/google-play-badge.svg";

// Badge height: 52px clears Apple's 40px minimum with room to spare; both
// badges render at the same height (their differing widths are by design —
// Google's badge is natively wider).
const BADGE_H = "h-[52px] w-auto";

/** Apple's official "Download on the App Store" badge, linked live. */
export function AppStoreBadge() {
  const { t } = useI18n();
  return (
    <a
      href={APP_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block transition-opacity hover:opacity-80"
    >
      <img src={appStoreBadge} alt={t("download.appStoreButton")} className={BADGE_H} />
    </a>
  );
}

/** Google's official "Get it on Google Play" badge, linked live. */
export function PlayStoreBadge() {
  const { t } = useI18n();
  return (
    <a
      href={PLAY_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block transition-opacity hover:opacity-80"
    >
      <img src={googlePlayBadge} alt={t("download.playStoreButton")} className={BADGE_H} />
    </a>
  );
}
