import { useI18n } from "../lib/i18n";
import {
  COMPARISON_BRANDS,
  COMPARISON_REVIEWED_AT,
  COMPARISON_ROWS,
  COMPARISON_SOURCES,
  type ComparisonCell,
  type ComparisonSourceId,
  type ComparisonStatus,
} from "./comparison-data";

const sourceEntries = Object.entries(COMPARISON_SOURCES) as [
  ComparisonSourceId,
  (typeof COMPARISON_SOURCES)[ComparisonSourceId],
][];
const sourceNumbers = Object.fromEntries(
  sourceEntries.map(([id], index) => [id, index + 1]),
) as Record<ComparisonSourceId, number>;

function StatusIcon({ status }: { status: ComparisonStatus }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-5 w-5 shrink-0 ${status === "yes" ? "text-[#0C745A]" : status === "no" ? "text-[#A3203A]" : "text-neutral-400"}`}
    >
      <path
        d={
          status === "yes"
            ? "m5 12 4 4L19 6"
            : status === "no"
              ? "m6 6 12 12M6 18 18 6"
              : "M5 12h14"
        }
      />
    </svg>
  );
}

function FeatureCell({ cell, brandName }: { cell: ComparisonCell; brandName: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex items-center gap-1.5" dir="ltr">
        <StatusIcon status={cell.status} />
        <span className="sr-only">{t(`comparison.status.${cell.status}`)}</span>
        <span className="flex items-center gap-0.5 self-start text-[10px] leading-none text-neutral-500">
          {cell.sources.map((sourceId) => {
            const source = COMPARISON_SOURCES[sourceId];
            return (
              <a
                key={sourceId}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-5 min-w-4 items-center justify-center rounded hover:bg-neutral-100 hover:text-neutral-900"
                aria-label={t("comparison.sourceLink", {
                  brand: brandName,
                  source: t(`comparison.sourceKind.${source.kind}`),
                })}
              >
                <sup>{sourceNumbers[sourceId]}</sup>
              </a>
            );
          })}
        </span>
      </div>
      {cell.note ? (
        <span className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[10px] leading-snug text-neutral-600">
          {t(`comparison.note.${cell.note}`)}
        </span>
      ) : null}
    </div>
  );
}

export function ProductComparison() {
  const { t, lang, isRTL } = useI18n();
  const reviewedDate = new Intl.DateTimeFormat(
    lang === "en" ? "en-GB" : lang === "fa" ? "fa-AF" : "ps-AF",
    {
      calendar: "gregory",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    },
  ).format(new Date(`${COMPARISON_REVIEWED_AT}T12:00:00Z`));

  return (
    <section id="compare" className="scroll-mt-16 border-t border-neutral-200 px-6 py-20 md:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p
            className={`mb-4 text-[11px] font-semibold uppercase text-neutral-500 ${isRTL ? "" : "tracking-wider"}`}
          >
            {t("comparison.eyebrow")}
          </p>
          <h2
            id="comparison-title"
            className={`text-3xl font-bold leading-tight text-neutral-900 md:text-5xl ${isRTL ? "" : "tracking-tight"}`}
          >
            {t("comparison.title")}
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-neutral-600">
            {t("comparison.body")}
          </p>
        </div>

        <div
          id="comparison-legend"
          className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-neutral-600"
        >
          {(["yes", "no", "unknown"] as const).map((status) => (
            <span key={status} className="inline-flex items-center gap-2">
              <StatusIcon status={status} />
              {t(`comparison.status.${status}`)}
            </span>
          ))}
        </div>
        <p
          id="comparison-offline-note"
          className="mt-3 max-w-2xl text-xs leading-relaxed text-neutral-500"
        >
          {t("comparison.offlineNote")}{" "}
          <a
            href={COMPARISON_SOURCES.zoodSite.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-5 min-w-4 items-center justify-center rounded text-[10px] hover:bg-neutral-100 hover:text-neutral-900"
            aria-label={t("comparison.sourceLink", {
              brand: "ZoodHesab",
              source: t("comparison.sourceKind.website"),
            })}
          >
            <sup>{sourceNumbers.zoodSite}</sup>
          </a>
        </p>
        <p
          id="comparison-scroll-hint"
          className="mt-5 text-xs leading-relaxed text-neutral-500 lg:hidden"
        >
          {t("comparison.scrollHint")}
        </p>

        <div
          role="region"
          aria-labelledby="comparison-title"
          aria-describedby="comparison-legend comparison-offline-note comparison-scope"
          tabIndex={0}
          className="relative mt-4 overflow-x-auto rounded-2xl border border-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-neutral-900"
        >
          <table className="w-full min-w-[848px] table-fixed border-separate border-spacing-0 text-center sm:min-w-[960px]">
            <caption className="sr-only">{t("comparison.caption")}</caption>
            <colgroup>
              <col className="w-32 sm:w-60" />
              {COMPARISON_BRANDS.map((brand) => (
                <col key={brand.id} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky z-20 border-b border-neutral-200 bg-white px-3 py-6 text-start text-xs font-semibold text-neutral-500 sm:px-5"
                  style={{ insetInlineStart: 0, borderInlineEnd: "1px solid #E5E5E5" }}
                >
                  {t("comparison.featureLabel")}
                </th>
                {COMPARISON_BRANDS.map((brand) => (
                  <th
                    key={brand.id}
                    scope="col"
                    className={`border-b border-neutral-200 px-3 py-6 text-[15px] font-semibold text-neutral-900 ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-neutral-50/60"}`}
                  >
                    <a
                      href={brand.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-neutral-200 underline-offset-4 hover:decoration-neutral-600"
                    >
                      <bdi dir="ltr">{brand.name}</bdi>
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.id}>
                  <th
                    scope="row"
                    className="sticky z-10 border-b border-neutral-100 bg-white px-3 py-5 text-start text-xs font-medium leading-relaxed text-neutral-700 sm:px-5 sm:text-sm"
                    style={{ insetInlineStart: 0, borderInlineEnd: "1px solid #E5E5E5" }}
                  >
                    {t(`comparison.feature.${row.id}`)}
                  </th>
                  {COMPARISON_BRANDS.map((brand) => (
                    <td
                      key={brand.id}
                      className={`border-b border-neutral-100 px-2 py-5 ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-white"}`}
                    >
                      <FeatureCell cell={row.cells[brand.id]} brandName={brand.name} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          id="comparison-scope"
          className="mt-5 max-w-3xl space-y-2 text-xs leading-relaxed text-neutral-500"
        >
          <p>{t("comparison.unknownNote")}</p>
          <p>{t("comparison.scopeNote")}</p>
          <p>{t("comparison.badgeNote")}</p>
          <p>
            {t("comparison.reviewed")} <time dateTime={COMPARISON_REVIEWED_AT}>{reviewedDate}</time>
          </p>
        </div>

        <details className="mt-7 border-t border-neutral-200 pt-5">
          <summary className="w-fit cursor-pointer text-sm font-semibold text-neutral-700 marker:text-neutral-400">
            {t("comparison.sources")}
          </summary>
          <div className="mt-6 grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
            {COMPARISON_BRANDS.map((brand) => (
              <div key={brand.id} className="min-w-0">
                <h3 className="text-sm font-semibold text-neutral-900">
                  <bdi dir="ltr">{brand.name}</bdi>
                </h3>
                <ul className="mt-3 space-y-2 text-xs leading-relaxed text-neutral-600">
                  {sourceEntries
                    .filter(([, source]) => source.brand === brand.id)
                    .map(([id, source]) => (
                      <li key={id} className="flex items-baseline gap-2">
                        <span
                          dir="ltr"
                          className="min-w-4 shrink-0 font-mono text-[10px] text-neutral-400"
                        >
                          {sourceNumbers[id]}
                        </span>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 underline decoration-neutral-200 underline-offset-4 hover:text-neutral-900 hover:decoration-neutral-600"
                        >
                          {t(`comparison.sourceKind.${source.kind}`)}
                        </a>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
