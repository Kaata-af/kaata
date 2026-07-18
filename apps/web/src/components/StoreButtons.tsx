// Store options for the download page — the OFFICIAL store badges, the
// visual convention every app landing page uses:
//   - "Download on the App Store": Apple's genuine badge artwork (fetched
//     from Apple's marketing-toolbox badge API), linked to the listing.
//   - "Get it on Google Play": Google's official badge artwork, shown dimmed
//     with a "coming soon" caption while the app is in closed testing —
//     recognizable, visibly not-yet-clickable.
//   - The direct APK keeps its own custom button (DownloadButton) — there is
//     no official badge for sideloading, and it must NOT imitate one.
//
// Both badges are BUNDLED (src/assets, hashed by Vite), never hotlinked:
// the site's CSP blocks foreign origins, and self-hosted assets match the
// slow-network posture the fonts already follow. Badges stay English in both
// locales — brand badges are conventionally untranslated here, matching the
// "brand names stay Latin" rule.

import { APP_STORE_URL } from "../env";
import { useI18n } from "../lib/i18n";
import appStoreBadge from "../assets/app-store-badge.svg";
import googlePlayBadge from "../assets/google-play-badge.svg";

type IconProps = { className?: string };

export function AndroidIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.62.62 0 0 0-.83.22l-1.88 3.24a11.46 11.46 0 0 0-8.94 0L5.65 5.67a.62.62 0 0 0-.85-.22c-.3.16-.42.54-.26.85L6.38 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />
    </svg>
  );
}

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

/**
 * Google's official "Get it on Google Play" badge, dimmed + non-interactive
 * with a "coming soon" caption while closed testing runs. When Play goes
 * public, this becomes a live link like the App Store badge.
 */
export function PlayBadgeComingSoon() {
  const { t } = useI18n();
  return (
    <div className="inline-flex flex-col items-center gap-1 select-none">
      <img
        src={googlePlayBadge}
        alt={`${t("download.playStore")} — ${t("download.comingSoon")}`}
        className={`${BADGE_H} opacity-40 grayscale`}
      />
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
        {t("download.comingSoon")}
      </span>
    </div>
  );
}
