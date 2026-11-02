import { useI18n } from "../lib/i18n";
import { COMPARISON_BRANDS, COMPARISON_ROWS, type ComparisonStatus } from "./comparison-data";

const compactBrandNames: Record<string, readonly string[]> = {
  zoodhesab: ["Zood", "Hesab"],
  khatabook: ["Khata", "book"],
  digikhata: ["Digi", "Khata"],
};

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
      className={`h-[18px] w-[18px] shrink-0 sm:h-5 sm:w-5 ${status === "yes" ? "text-[#0C745A]" : status === "no" ? "text-[#A3203A]" : "text-neutral-400"}`}
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

function FeatureCell({ status }: { status: ComparisonStatus }) {
  const { t } = useI18n();
  return (
    <div className="flex justify-center">
      <StatusIcon status={status} />
      <span className="sr-only">{t(`comparison.status.${status}`)}</span>
    </div>
  );
}

export function ProductComparison() {
  const { t, isRTL } = useI18n();

  return (
    <section
      id="compare"
      className="scroll-mt-16 border-t border-neutral-200 px-4 py-20 sm:px-6 md:py-28"
    >
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
        </div>

        <div className="relative mt-8 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          {/* A normal table fits every brand on phones without sticky cells
                or an independently scrolling layer. */}
          <table
            aria-labelledby="comparison-title"
            className="relative w-full table-fixed border-separate border-spacing-0 text-center"
          >
            <caption className="sr-only">{t("comparison.caption")}</caption>
            <colgroup>
              <col className="w-[34%] md:w-[28%] lg:w-1/4" />
              {COMPARISON_BRANDS.map((brand) => (
                <col key={brand.id} />
              ))}
            </colgroup>
            <thead>
              <tr data-comparison-row="header">
                <th
                  scope="col"
                  className="border-b border-neutral-200 px-2 py-4 text-start text-[11px] font-semibold text-neutral-500 sm:px-4 sm:text-xs"
                >
                  {t("comparison.featureLabel")}
                </th>
                {COMPARISON_BRANDS.map((brand) => (
                  <th
                    key={brand.id}
                    scope="col"
                    className={`border-b border-neutral-200 px-0.5 py-4 align-middle text-[11px] font-semibold leading-tight text-neutral-900 sm:px-2 sm:text-xs md:text-[13px] lg:text-[15px] ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-neutral-50/60"}`}
                  >
                    <a
                      href={brand.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={brand.name}
                      className="underline decoration-neutral-200 underline-offset-4 hover:decoration-neutral-600"
                    >
                      <bdi dir="ltr" className="inline-block md:hidden" aria-hidden="true">
                        {(compactBrandNames[brand.id] ?? [brand.name]).map((part) => (
                          <span key={part} className="block">
                            {part}
                          </span>
                        ))}
                      </bdi>
                      <bdi dir="ltr" className="hidden md:inline">
                        {brand.name}
                      </bdi>
                    </a>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.id} data-comparison-row={row.id}>
                  <th
                    scope="row"
                    className="border-b border-neutral-100 px-2 py-3 text-start text-xs font-medium leading-relaxed text-neutral-700 sm:px-4 sm:py-5 sm:text-sm"
                  >
                    {t(`comparison.feature.${row.id}`)}
                  </th>
                  {COMPARISON_BRANDS.map((brand) => (
                    <td
                      key={brand.id}
                      className={`border-b border-neutral-100 px-1 py-3 align-middle sm:px-2 sm:py-5 ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-white"}`}
                    >
                      <FeatureCell status={row.cells[brand.id].status} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p
          data-comparison-csv-note
          className="mt-5 max-w-2xl text-sm leading-relaxed text-neutral-600"
        >
          {t("comparison.csvNote")}
        </p>
      </div>
    </section>
  );
}
