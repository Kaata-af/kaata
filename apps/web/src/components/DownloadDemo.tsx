import demoPoster from "../assets/kaata-demo.jpg";
import { useI18n } from "../lib/i18n";

/** A self-hosted thumbnail links straight to the guide; no third-party player. */
export function DownloadDemo() {
  const { t } = useI18n();

  return (
    <section
      aria-labelledby="download-demo-title"
      className="mt-8 border-t border-neutral-200 pt-8"
    >
      <h2 id="download-demo-title" className="text-xl font-semibold text-neutral-900 md:text-2xl">
        {t("download.demo.title")}
      </h2>

      <a
        href="https://www.youtube.com/watch?v=_QmnfAnOM4s"
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${t("download.demo.title")} — ${t("download.demo.youtube")}`}
        className="group mt-4 block overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm hover:border-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neutral-900"
      >
        <div className="relative">
          <img
            src={demoPoster}
            alt=""
            width={1280}
            height={720}
            decoding="async"
            className="block h-auto w-full"
          />
          <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg ring-4 ring-white/90 group-hover:bg-neutral-700">
              <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor">
                <path d="m9 5 12 7-12 7V5Z" />
              </svg>
            </span>
          </span>
        </div>
        <div className="flex min-h-14 items-center justify-between gap-3 border-t border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-900">
          <span>{t("download.demo.youtube")}</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17 17 7M7 7h10v10" />
          </svg>
        </div>
      </a>
    </section>
  );
}
