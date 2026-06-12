import { Link, useParams } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { useI18n } from "../lib/i18n";

// Placeholder for /v/:token — Phase 2 customer-facing balance view.
// Will decode a signed JSON payload from the URL token and render the
// customer's kaata at a given shop. For now, shows a coming-soon screen
// so the route is wired and the SPA fallback in Caddy is validated.
export function CustomerView() {
  const { token } = useParams<{ token: string }>();
  const { t } = useI18n();

  return (
    <main>
      <SiteHeader />

      <section className="px-6 py-20 md:py-28 max-w-2xl mx-auto text-center">
        <p className="text-[11px] font-semibold tracking-wider uppercase text-neutral-500 mb-4">
          {t("customer.kicker")}
        </p>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-neutral-900">
          {t("customer.title")}
        </h1>
        <p className="mt-6 text-lg text-neutral-600 leading-relaxed">{t("customer.body")}</p>
        <p className="mt-8 text-xs text-neutral-600 font-mono break-all" dir="ltr">
          token: {token}
        </p>

        <Link
          to="/"
          className="mt-10 inline-block text-sm text-neutral-600 hover:text-neutral-900 transition-colors font-medium"
        >
          {t("customer.back")}
        </Link>
      </section>

      <SiteFooter />
    </main>
  );
}
