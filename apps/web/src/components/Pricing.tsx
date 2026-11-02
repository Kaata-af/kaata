import { Link } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { WEB_PRO_OFFERS } from "../lib/web-pro";
import { Button } from "./ui/button";

export function Pricing() {
  const { t, lang } = useI18n();
  const prices = new Intl.NumberFormat(lang === "en" ? "en-US" : `${lang}-AF`, {
    style: "currency",
    currency: "AFN",
    currencyDisplay: "code",
    numberingSystem: lang === "en" ? "latn" : "arabext",
    maximumFractionDigits: 0,
  });

  return (
    <section
      id="pricing"
      aria-labelledby="pricing-title"
      className="scroll-mt-16 border-t border-neutral-200 px-6 py-20 md:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            {t("pricing.eyebrow")}
          </p>
          <h2
            id="pricing-title"
            className="mt-4 text-3xl font-bold leading-tight tracking-tight text-brand-primary md:text-4xl"
          >
            {t("pricing.title")}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-neutral-600">{t("pricing.body")}</p>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col rounded-2xl border border-surface-balance-border bg-surface-balance p-6 sm:p-8">
            <span className="w-fit rounded-full bg-white/70 px-3 py-1 text-xs font-semibold text-brand-primary">
              {t("pricing.free.badge")}
            </span>
            <h3 className="mt-5 text-xl font-semibold text-brand-primary">
              {t("pricing.free.name")}
            </h3>
            <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-brand-primary">
              <span className="text-4xl font-bold tracking-tight">{t("pricing.free.price")}</span>
              <span className="text-sm">{t("pricing.free.period")}</span>
            </p>
            <p className="mt-5 text-sm leading-relaxed text-neutral-600">
              {t("pricing.free.body")}
            </p>
            <ul className="my-7 space-y-3 text-sm leading-relaxed text-neutral-800">
              {(
                [
                  "pricing.free.item1",
                  "pricing.free.item2",
                  "pricing.free.item3",
                  "pricing.free.item4",
                  "pricing.free.item5",
                  "pricing.free.item6",
                ] as const
              ).map((key) => (
                <li key={key} className="flex items-start gap-3">
                  <Check />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
            <p className="mb-7 text-xs leading-relaxed text-neutral-600">
              {t("pricing.free.note")}
            </p>
            <Button asChild variant="brand" size="lg" className="mt-auto w-full min-h-11">
              <Link to="/download">{t("pricing.free.cta")}</Link>
            </Button>
          </div>

          <div className="flex min-w-0 flex-col rounded-2xl border border-neutral-200 bg-white p-6 sm:p-8">
            <span className="w-fit rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-600">
              {t("pricing.pro.badge")}
            </span>
            <h3 className="mt-5 text-xl font-semibold text-neutral-900">{t("pricing.pro.name")}</h3>
            <p className="mt-3 text-sm leading-relaxed text-neutral-600">{t("pricing.pro.body")}</p>
            <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-3">
              {WEB_PRO_OFFERS.map((offer, index) => (
                <div key={offer.id} className="contents">
                  {index > 0 && (
                    <span className="text-xs text-neutral-500">{t("pricing.pro.or")}</span>
                  )}
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <bdi className="text-2xl font-bold tracking-tight text-neutral-900">
                      {prices.format(offer.amount_minor / 100)}
                    </bdi>
                    <span className="text-xs text-neutral-500">
                      / {t(offer.duration_months === 1 ? "pricing.pro.month" : "pricing.pro.year")}
                    </span>
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              {t("pricing.pro.account")}
            </p>
            <ul className="my-7 space-y-3 text-sm leading-relaxed text-neutral-700">
              {(["pricing.pro.item1", "pricing.pro.item2", "pricing.pro.item3"] as const).map(
                (key) => (
                  <li key={key} className="flex items-start gap-3">
                    <Check />
                    <span>{t(key)}</span>
                  </li>
                ),
              )}
            </ul>
            {/* Web Pro is voluntary during the open trial; keep this status
                beside the prices rather than implying a payment is required. */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <p className="text-sm font-semibold text-neutral-900">{t("pricing.trial.title")}</p>
              <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                {t("pricing.trial.body")}
              </p>
            </div>
            <p className="mb-7 mt-4 text-xs leading-relaxed text-neutral-500">
              {t("pricing.pro.payment")}
            </p>
            <Button asChild variant="outline" size="lg" className="mt-auto w-full min-h-11">
              <Link reloadDocument to="/app">
                {t("pricing.pro.cta")}
              </Link>
            </Button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-surface-balance-border px-6 py-5 sm:px-8">
          <p className="text-base font-semibold text-brand-primary">
            {t("pricing.reassurance.title")}
          </p>
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-neutral-600">
            {t("pricing.reassurance.body")}
          </p>
        </div>

        <div className="mt-14 max-w-3xl">
          <h3 className="text-xl font-semibold text-neutral-900">{t("pricing.faq.title")}</h3>
          <div className="mt-5 divide-y divide-neutral-200 border-y border-neutral-200">
            {([1, 2, 3] as const).map((index) => (
              <details key={index} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 text-sm font-medium text-neutral-900 [&::-webkit-details-marker]:hidden">
                  {t(`pricing.faq.q${index}`)}
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-neutral-500 transition-transform group-open:rotate-180"
                  >
                    <path d="m5 7.5 5 5 5-5" />
                  </svg>
                </summary>
                <p className="mt-4 text-sm leading-relaxed text-neutral-600">
                  {t(`pricing.faq.a${index}`)}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary"
    >
      <path d="m4 10 4 4 8-8" />
    </svg>
  );
}
