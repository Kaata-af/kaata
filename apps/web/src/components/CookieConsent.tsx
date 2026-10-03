import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";

// Privacy notice card. Kaata sets no cookies (localStorage holds a few
// preference keys), and the copy says what IS recorded: every visit, with its
// IP address, whatever the visitor presses here. Nothing reads a choice from
// this card, so it offers none: no "No thanks" that would imply an opt-out we
// don't have. It is an informational affordance, not a consent gate; its one
// button acknowledges it, and the dismissal is stored so the card doesn't
// reappear on later visits.

// Stored as "accepted"; "rejected" is left from the old two-button card. Either
// means the card has been seen.
const CONSENT_KEY = "kaata_cookie_consent";
const REVEAL_AFTER_MS = 700;

export function CookieConsent() {
  const { t } = useI18n();
  // `null` = haven't checked storage yet (don't flash); `false` = already
  // dismissed once, don't show; `true` = never dismissed, render the card.
  const [visible, setVisible] = useState<boolean | null>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    try {
      const prior = window.localStorage.getItem(CONSENT_KEY);
      if (prior === "accepted" || prior === "rejected") {
        setVisible(false);
        return;
      }
    } catch {
      // localStorage unavailable — render the card; dismissal becomes per-session.
    }
    setVisible(true);
    const timer = window.setTimeout(() => setEntered(true), REVEAL_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(CONSENT_KEY, "accepted");
    } catch {
      // ignore — in-memory dismissal still works for this session
    }
    setEntered(false);
    // Wait for the slide-out to play, then unmount.
    window.setTimeout(() => setVisible(false), 250);
  }

  if (visible !== true) return null;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label={t("consent.body")}
      className={[
        // end-6 (not right-6): the card hugs the reading-end corner, so it
        // sits bottom-left for Persian and bottom-right for English.
        "fixed z-50 inset-x-4 bottom-4 sm:inset-x-auto sm:end-6 sm:bottom-6 sm:max-w-sm",
        "rounded-2xl border border-neutral-200/80 bg-white/90 backdrop-blur-xl",
        "shadow-[0_16px_40px_-16px_rgba(0,0,0,0.22)]",
        "transition-all duration-300 ease-out",
        entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
      ].join(" ")}
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <img src="/logo.png" alt="" className="w-5 h-5 mt-0.5 shrink-0" />
          <p className="text-[13px] text-neutral-700 leading-relaxed">{t("consent.body")}</p>
        </div>
        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            onClick={dismiss}
            className="bg-neutral-900 text-white text-[13px] font-semibold px-4 py-1.5 rounded-lg ring-0 ring-neutral-200 hover:ring-4 transition-[box-shadow]"
          >
            {t("consent.accept")}
          </button>
        </div>
      </div>
    </div>
  );
}
