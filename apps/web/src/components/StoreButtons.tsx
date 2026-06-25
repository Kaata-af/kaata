// Platform icons + the "coming soon" store badges for the download page.
// Android is the only live channel (the APK, via <DownloadButton>); Google Play
// and the App Store are shown as muted, non-interactive "coming soon" badges so
// visitors know they're on the roadmap without a dead link. Brand names stay in
// Latin in both locales for recognizability; only "Coming soon" is translated.
// Layout uses logical flow (no physical left/right), so it flips cleanly under
// the page's RTL (dir="rtl") for Persian.

import { type ReactNode } from "react";

import { useI18n } from "../lib/i18n";

type IconProps = { className?: string };

export function AndroidIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.62.62 0 0 0-.83.22l-1.88 3.24a11.46 11.46 0 0 0-8.94 0L5.65 5.67a.62.62 0 0 0-.85-.22c-.3.16-.42.54-.26.85L6.38 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z" />
    </svg>
  );
}

export function GooglePlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" className={className} aria-hidden="true">
      <path d="M325.3 234.3 104.6 13l280.8 161.2-60.1 60.1zM47 0C34 6.8 25.3 19.2 25.3 35.3v441.3c0 16.1 8.7 28.5 21.7 35.3l256.6-256L47 0zm425.2 225.6-58.9-34.1-65.7 64.5 65.7 64.5 60.1-34.1c18-14.3 18-46.5-1.3-60.8zM104.6 499l220.7-221.3 60.1 60.1L104.6 499z" />
    </svg>
  );
}

export function AppleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.493 2.27-1.177 3.08-.744.9-1.99 1.57-2.987 1.57-.12 0-.23-.02-.3-.03-.01-.06-.04-.22-.04-.39 0-1.15.572-2.27 1.206-2.98.804-.94 2.142-1.64 3.248-1.68.03.13.05.28.05.43zm4.565 15.71c-.03.07-.463 1.58-1.518 3.12-.945 1.34-1.94 2.71-3.43 2.71-1.517 0-1.9-.88-3.63-.88-1.698 0-2.302.91-3.67.91-1.377 0-2.332-1.26-3.428-2.8-1.287-1.82-2.323-4.63-2.323-7.28 0-4.28 2.797-6.55 5.552-6.55 1.448 0 2.675.95 3.6.95.865 0 2.222-1.01 3.902-1.01.613 0 2.886.06 4.374 2.19-.13.09-2.383 1.37-2.383 4.19 0 3.26 2.854 4.42 2.955 4.45z" />
    </svg>
  );
}

function ComingSoonBadge({ icon, name, soon }: { icon: ReactNode; name: string; soon: string }) {
  return (
    <div
      aria-disabled="true"
      className="flex items-center gap-3 px-5 py-3.5 rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-400 select-none cursor-default"
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-neutral-500">{name}</span>
        <span className="text-xs">{soon}</span>
      </span>
    </div>
  );
}

export function ComingSoonStores() {
  const { t } = useI18n();
  const soon = t("download.comingSoon");
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <ComingSoonBadge
        icon={<GooglePlayIcon className="w-6 h-6" />}
        name={t("download.playStore")}
        soon={soon}
      />
      <ComingSoonBadge
        icon={<AppleIcon className="w-6 h-6" />}
        name={t("download.appStore")}
        soon={soon}
      />
    </div>
  );
}
