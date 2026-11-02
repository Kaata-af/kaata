import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { COMPARISON_BRANDS, COMPARISON_ROWS, type ComparisonStatus } from "./comparison-data";

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
  const { t, lang, isRTL } = useI18n();
  const layoutRef = useRef<HTMLDivElement>(null);
  const [rowHeights, setRowHeights] = useState<number[]>([]);

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    let active = true;
    const contents = Array.from(layout.querySelectorAll<HTMLElement>("[data-comparison-measure]"));
    const measure = () => {
      if (!active) return;
      const heights = Array<number>(COMPARISON_ROWS.length + 1).fill(0);
      for (const content of contents) {
        const index = Number(content.dataset.comparisonMeasure);
        // Content wrappers include their natural padding; the shared row
        // height also includes its one-pixel separator.
        heights[index] = Math.max(
          heights[index],
          Math.ceil(content.getBoundingClientRect().height) + 1,
        );
      }
      setRowHeights((previous) =>
        previous.length === heights.length &&
        previous.every((height, index) => height === heights[index])
          ? previous
          : heights,
      );
    };
    // Observe intrinsic content, never the wrappers whose heights we set.
    // This also responds to wrapping, zoom and font changes without a
    // ResizeObserver feedback loop or any scroll/touch repaint handlers.
    const observer = new ResizeObserver(measure);
    contents.forEach((content) => observer.observe(content));
    measure();
    void document.fonts.ready.then(measure);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [lang]);

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
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-neutral-600">
            {t("comparison.csvNote")}
          </p>
        </div>

        <div
          ref={layoutRef}
          className="relative mt-8 flex items-start overflow-hidden rounded-2xl border border-neutral-200 bg-white focus-within:outline focus-within:outline-2 focus-within:outline-offset-4 focus-within:outline-neutral-900"
        >
          {/* Keep the visible labels outside the scroller. Safari can drop
              sticky table cells while compositing an RTL overflow region. */}
          <div
            data-comparison-labels
            aria-hidden="true"
            className="w-32 shrink-0 bg-white sm:w-60"
            style={{ borderInlineEnd: "1px solid #E5E5E5" }}
          >
            <div
              data-comparison-label="header"
              className="flex items-center border-b border-neutral-200"
              style={{ height: rowHeights[0] }}
            >
              <div
                data-comparison-measure="0"
                className="w-full px-3 py-6 text-start text-xs font-semibold text-neutral-500 sm:px-5"
              >
                {t("comparison.featureLabel")}
              </div>
            </div>
            {COMPARISON_ROWS.map((row, index) => (
              <div
                key={row.id}
                data-comparison-label={row.id}
                className="flex items-center border-b border-neutral-100"
                style={{ height: rowHeights[index + 1] }}
              >
                <div
                  data-comparison-measure={index + 1}
                  className="w-full px-3 py-5 text-start text-xs font-medium leading-relaxed text-neutral-700 sm:px-5 sm:text-sm"
                >
                  {t(`comparison.feature.${row.id}`)}
                </div>
              </div>
            ))}
          </div>
          <div
            role="region"
            aria-labelledby="comparison-title"
            tabIndex={0}
            className="relative min-w-0 flex-1 overflow-x-auto focus-visible:outline-none"
          >
            <table className="relative w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-center">
              <caption className="sr-only">{t("comparison.caption")}</caption>
              <colgroup>
                <col className="w-0" />
                {COMPARISON_BRANDS.map((brand) => (
                  <col key={brand.id} />
                ))}
              </colgroup>
              <thead>
                <tr data-comparison-row="header" style={{ height: rowHeights[0] }}>
                  <th scope="col" className="relative w-0 p-0">
                    <span className="sr-only">{t("comparison.featureLabel")}</span>
                  </th>
                  {COMPARISON_BRANDS.map((brand) => (
                    <th
                      key={brand.id}
                      scope="col"
                      className={`border-b border-neutral-200 p-0 align-middle text-[15px] font-semibold text-neutral-900 ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-neutral-50/60"}`}
                    >
                      <div data-comparison-measure="0" className="px-3 py-6">
                        <a
                          href={brand.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline decoration-neutral-200 underline-offset-4 hover:decoration-neutral-600"
                        >
                          <bdi dir="ltr">{brand.name}</bdi>
                        </a>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row, index) => (
                  <tr
                    key={row.id}
                    data-comparison-row={row.id}
                    style={{ height: rowHeights[index + 1] }}
                  >
                    <th scope="row" className="relative w-0 p-0">
                      <span className="sr-only">{t(`comparison.feature.${row.id}`)}</span>
                    </th>
                    {COMPARISON_BRANDS.map((brand) => (
                      <td
                        key={brand.id}
                        className={`border-b border-neutral-100 p-0 align-middle ${brand.id === "kaata" ? "bg-[#F6F9F7]" : "bg-white"}`}
                      >
                        <div data-comparison-measure={index + 1} className="px-2 py-5">
                          <FeatureCell status={row.cells[brand.id].status} />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
