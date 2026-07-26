import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { AppStoreBadge, PlayStoreBadge } from "../components/StoreButtons";
import { useI18n } from "../lib/i18n";

// Store-only download page (2026-07-26, Play went live): the two official
// badges and nothing else. The sideload APK flow — direct download button +
// the "allow from this source" walkthrough — retired with the Play launch;
// existing sideload installs keep updating through the in-app banner's
// /v1/download channel, which is unaffected by this page.
//
// This page stays even though it's "just two badges": it is the QR-code
// landing target (web_visits → install attribution keys off it) and the
// baked-in never-dead-end fallback in shipped apps' update buttons.
export function Download() {
  const { t } = useI18n();
  // Visitor's own store first. Most arrivals are phones scanning a QR code —
  // the badge they can actually use should be the first thing under their
  // thumb. Desktop and unknown agents get the Android-first default (the
  // audience skews overwhelmingly Android).
  const isIOS =
    typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent ?? "");
  return (
    <main>
      <SiteHeader />

      <section className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-neutral-900">
          {t("download.title")}
        </h1>
        <p className="mt-4 text-base text-neutral-600 leading-relaxed">{t("download.sub")}</p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          {isIOS ? (
            <>
              <AppStoreBadge />
              <PlayStoreBadge />
            </>
          ) : (
            <>
              <PlayStoreBadge />
              <AppStoreBadge />
            </>
          )}
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
