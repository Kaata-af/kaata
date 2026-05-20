import { useEffect, useState } from "react";

// Cookie consent banner. Kaata doesn't actually set cookies (we use localStorage
// for a few preference keys), but users expect the affordance — so we surface
// the standard accept/reject pattern. Both buttons dismiss; the choice is
// recorded in localStorage so the banner doesn't reappear on subsequent visits.
const CONSENT_KEY = "kaata_cookie_consent"; // "accepted" | "rejected"
const REVEAL_AFTER_MS = 500;

type Choice = "accepted" | "rejected";

export function CookieConsent() {
  // `null` = haven't checked storage yet (don't flash); `false` = already
  // decided once, don't show; `true` = no prior choice, render the card.
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
      // localStorage unavailable — render the card; choice becomes per-session.
    }
    setVisible(true);
    const t = window.setTimeout(() => setEntered(true), REVEAL_AFTER_MS);
    return () => window.clearTimeout(t);
  }, []);

  function record(choice: Choice) {
    try {
      window.localStorage.setItem(CONSENT_KEY, choice);
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
      aria-label="Cookie preferences"
      className={[
        "fixed z-50 inset-x-4 bottom-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-w-sm",
        "rounded-xl border border-neutral-200 bg-white",
        "shadow-[0_12px_30px_-12px_rgba(0,0,0,0.18)]",
        "transition-all duration-300 ease-out",
        entered ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3",
      ].join(" ")}
    >
      <div className="p-5">
        <p className="text-sm text-neutral-700 leading-relaxed">
          We use cookies to improve your experience and understand how this site is used.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => record("rejected")}
            className="text-sm font-semibold text-neutral-600 hover:text-neutral-900 px-3 py-2 rounded-lg transition-colors"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => record("accepted")}
            className="bg-neutral-900 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-neutral-800 transition-colors"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
