import { DownloadButton } from "../components/DownloadButton";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { AppStoreBadge, PlayBadgeComingSoon } from "../components/StoreButtons";
import { useI18n, type TKey } from "../lib/i18n";

// Step copy matches the dialogs modern Android actually shows (the per-app
// "Allow from this source" flow replaced the global "unknown sources"
// setting in Android 8; Play Protect commonly interjects on Android 14).
const STEP_KEYS: TKey[] = [
  "download.step1",
  "download.step2",
  "download.step3",
  "download.step4",
  "download.step5",
];

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

        {/* The standard store-badge row (official artwork): App Store live,
            Google Play dimmed while closed testing runs. The direct APK —
            this audience's primary channel — keeps its own full-width
            button beneath (sideloading has no official badge, and must not
            imitate one). */}
        <div className="mt-10 space-y-4">
          <div className="flex flex-wrap items-start gap-3">
            <AppStoreBadge />
            <PlayBadgeComingSoon />
          </div>
          <DownloadButton />
        </div>

        {/* APK sideload walkthrough — Android-only concern; iPhone installs
            come straight from the App Store with no steps to explain. */}
        <h2 className="mt-14 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          {t("download.stepsTitle")}
        </h2>
        <ol className="mt-5 space-y-5">
          {STEP_KEYS.map((key, i) => (
            <li key={key} className="flex gap-4 items-start">
              <div className="flex-shrink-0 w-7 h-7 rounded-full border border-neutral-300 bg-white text-neutral-700 font-semibold flex items-center justify-center text-xs font-mono mt-0.5">
                {i + 1}
              </div>
              <p className="pt-0.5 text-neutral-700 leading-relaxed">{t(key)}</p>
            </li>
          ))}
        </ol>
      </section>

      <SiteFooter />
    </main>
  );
}
