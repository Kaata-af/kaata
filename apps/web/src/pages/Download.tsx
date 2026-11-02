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
  const platforms: ("ios" | "android")[] = isIOS ? ["ios", "android"] : ["android", "ios"];
  return (
    <main className="bg-surface">
      <SiteHeader />

      <section data-download-hero className="px-4 pb-12 pt-12 sm:px-6 md:pb-16 md:pt-20">
        <div className="mx-auto max-w-4xl">
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-flex rounded-full border border-surface-balance-border bg-surface-balance px-4 py-2 text-xs font-medium text-brand-primary">
              {t("pricing.free.badge")}
            </span>
            <h1 className="mt-6 text-4xl font-bold leading-tight tracking-tight text-brand-primary md:text-6xl">
              {t("download.title")}
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-neutral-600 md:text-lg">
              {t("download.sub")}
            </p>
          </div>

          <div className="mt-9 grid gap-4 sm:grid-cols-2 md:mt-12">
            {platforms.map((platform, index) => (
              <div
                key={platform}
                data-download-platform={platform}
                className={`flex min-w-0 flex-col rounded-2xl border p-6 sm:p-8 ${index === 0 ? "border-surface-balance-border bg-surface-balance" : "border-neutral-200 bg-white"}`}
              >
                <h2 className="text-lg font-semibold text-neutral-900 sm:text-xl">
                  {t(`download.${platform}.title`)}
                </h2>
                <p className="mb-6 mt-2 text-sm leading-relaxed text-neutral-600">
                  {t(`download.${platform}.body`)}
                </p>
                <div className="mt-auto flex items-center">
                  {platform === "ios" ? <AppStoreBadge /> : <PlayStoreBadge />}
                </div>
              </div>
            ))}
          </div>
          <p className="mx-auto mt-6 max-w-xl text-center text-xs leading-relaxed text-neutral-500 sm:text-sm">
            {t("download.assurance")}
          </p>
        </div>
      </section>

      <div className="border-t border-neutral-200 px-4 py-12 sm:px-6 md:py-16">
        <DownloadDemo />
      </div>

      <SiteFooter />
    </main>
  );
}
