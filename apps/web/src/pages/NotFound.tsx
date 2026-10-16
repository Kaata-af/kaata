import { Link } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { useI18n } from "../lib/i18n";

// Catch-all so mistyped or stale URLs (old invite links, typo'd QR slugs)
// show a useful page instead of an empty <Routes>.
export function NotFound() {
  const { t } = useI18n();
  return (
    <main>
      <SiteHeader />

      <section className="px-6 py-20 md:py-28 max-w-2xl mx-auto text-center">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
          {t("notFound.kicker")}
        </p>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-neutral-900">
          {t("notFound.title")}
        </h1>
        <p className="mt-6 text-lg text-neutral-600 leading-relaxed">{t("notFound.body")}</p>

        <Link
          to="/"
          className="mt-10 inline-block bg-brand-primary text-white font-semibold px-7 py-3 rounded-lg hover:bg-brand-hover transition-colors text-sm"
        >
          {t("notFound.back")}
        </Link>
      </section>

      <SiteFooter />
    </main>
  );
}
