import { DownloadDemo } from "../components/DownloadDemo";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { AppStoreBadge, PlayStoreBadge } from "../components/StoreButtons";
import { useI18n } from "../lib/i18n";

// Store-only download page: official badges, also reached by existing QR links.
export function Download() {
  const { t } = useI18n();
  // Put the visitor's own store first; desktop and unknown agents get Android first.
  const isIOS =
    typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent ?? "");
  return (
    <main>
      <SiteHeader />

      <section className="px-5 py-10 sm:px-6 md:py-20 max-w-2xl mx-auto">
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

        <DownloadDemo />
      </section>

      <SiteFooter />
    </main>
  );
}
