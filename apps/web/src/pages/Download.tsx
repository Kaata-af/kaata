import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { AppStoreBadge, PlayStoreBadge } from "../components/StoreButtons";
import { useI18n } from "../lib/i18n";

// Store-only download page (2026-07-26, Play went live): the two official
// badges and nothing else. The sideload APK flow — direct download button +
// the "allow from this source" walkthrough — retired with the Play launch;
// existing sideload installs keep updating through the in-app banner's
// /v1/download channel, which is unaffected by this page.
export function Download() {
  const { t } = useI18n();
  return (
    <main>
      <SiteHeader />

      <section className="px-6 py-16 md:py-20 max-w-2xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-neutral-900">
          {t("download.title")}
        </h1>
        <p className="mt-4 text-base text-neutral-600 leading-relaxed">{t("download.sub")}</p>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <PlayStoreBadge />
          <AppStoreBadge />
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
