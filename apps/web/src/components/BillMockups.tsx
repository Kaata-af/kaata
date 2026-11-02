import { useI18n } from "../lib/i18n";
import { formatBillAmount, formatBillDate, resolveBillCalendar } from "../lib/customer-dates";
import { brand, ledger } from "../theme";
import { PhoneFrame, PhoneMockupOffline } from "./PhoneMockups";

const APP_FONT = { fontFamily: '"Vazirmatn", system-ui, sans-serif' };
const DEMO_DATE = Date.UTC(2026, 10, 2, 8);
const DAY = 24 * 60 * 60 * 1_000;

function BillIcon({
  name,
  className,
}: {
  name: "share" | "download" | "up" | "down" | "globe";
  className?: string;
}) {
  const paths = {
    share: "M12 16V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2",
    download: "M12 3v13m-4-4 4 4 4-4M4 17v4h16v-4",
    up: "M12 20V4m-6 6 6-6 6 6",
    down: "M12 4v16m-6-6 6 6 6-6",
    globe:
      "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2a17 17 0 0 1 0 20 17 17 0 0 1 0-20Z",
  } as const;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={paths[name]} />
    </svg>
  );
}

function SendStatementPreview() {
  const { t, isRTL } = useI18n();
  const actions = [
    { key: "export.action.sharePdf", icon: "share" },
    { key: "export.action.shareCsv", icon: "share" },
    { key: "export.action.savePdf", icon: "download" },
    { key: "export.action.saveCsv", icon: "download" },
  ] as const;
  return (
    <div dir="ltr" className="relative w-[284px] max-w-full">
      <PhoneMockupOffline label={t("mock.bill.send.preview.label")} showToast={false} />
      {/* The export chooser is a native sheet over the customer's account. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-[7px] overflow-hidden rounded-[1.8rem]"
        style={APP_FONT}
      >
        <div className="absolute inset-0 bg-black/35" />
        <div className="absolute inset-x-0 bottom-0 rounded-t-[13px] border-t border-neutral-200 bg-white pt-2">
          <div className="mx-auto mb-2 h-1 w-8 rounded-full bg-neutral-300" />
          <p
            dir={isRTL ? "rtl" : "ltr"}
            className="px-3 pb-2 pt-1 text-[8.5px] font-semibold uppercase text-[#616161]"
          >
            {t("personEdit.export")}
          </p>
          {actions.map((action, index) => (
            <div
              key={action.key}
              className={`flex min-h-[43px] items-center gap-2.5 px-3 py-2.5 text-[#171717] ${isRTL ? "flex-row-reverse" : ""} ${index < actions.length - 1 ? "border-b border-[#EFEFEF]" : ""}`}
            >
              <BillIcon name={action.icon} className="h-4 w-4 shrink-0" />
              <span dir={isRTL ? "rtl" : "ltr"} className="min-w-0 flex-1 text-[11px] leading-snug">
                {t(action.key)}
              </span>
            </div>
          ))}
          <div className="mx-auto mb-2.5 mt-3 h-1 w-20 rounded-full bg-neutral-900" />
        </div>
      </div>
    </div>
  );
}

function ReceivedBillPreview() {
  const { t, lang, isRTL } = useI18n();
  const calendar = resolveBillCalendar(undefined, isRTL);
  const date = (value: number) => formatBillDate(value, lang, calendar);
  const amount = (value: number) => formatBillAmount(value, lang);
  const rows = [
    { amount: 500, gave: false, note: t("mock.payment"), date: DEMO_DATE },
    { amount: 750, gave: true, note: t("mock.supplies"), date: DEMO_DATE - DAY },
    { amount: 1_000, gave: true, note: t("mock.goods"), date: DEMO_DATE - 3 * DAY },
  ];
  return (
    <PhoneFrame label={t("mock.bill.receive.preview.label")}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{ ...APP_FONT, background: brand.ivory }}
      >
        <div className="flex h-9 shrink-0 items-center border-b border-neutral-200 bg-white px-3">
          <div className="flex h-6 w-full items-center gap-2 rounded-full bg-neutral-100 px-2 text-neutral-500">
            <BillIcon name="globe" className="h-3 w-3 shrink-0" />
            <span dir="ltr" className="text-[9px]">
              kaata.af/v/…
            </span>
          </div>
        </div>
        <div dir={isRTL ? "rtl" : "ltr"} className="min-h-0 flex-1 px-3 pt-3">
          <div
            className="rounded-xl border bg-white px-4 py-4"
            style={{ borderColor: brand.border }}
          >
            <p className="text-center text-[13px] font-bold" style={{ color: brand.ink }}>
              {t("mock.self.shop")}
            </p>
            <div className="mt-2 flex justify-center">
              <span
                className="rounded-full border bg-neutral-50 px-2 py-1 text-[8.5px] font-semibold"
                style={{ borderColor: brand.border, color: brand.sub }}
              >
                {t("mock.bill.dated", { date: date(DEMO_DATE) })}
              </span>
            </div>
            <div className="mt-3 border-t pt-3" style={{ borderColor: brand.border }}>
              <p className="text-[11px]" style={{ color: brand.sub }}>
                <span className="font-semibold" style={{ color: brand.ink }}>
                  {t("mock.name.ahmad")}
                </span>{" "}
                {t("mock.bill.owes")}
              </p>
              <p
                className="mt-2 flex items-baseline gap-1.5 font-mono text-[28px] font-semibold leading-none"
                style={{ color: ledger.payStrong }}
              >
                <bdi dir="ltr">{amount(1_250)}</bdi>
                <span
                  className="text-[11px] font-medium"
                  style={{ ...APP_FONT, color: brand.muted }}
                >
                  AFN
                </span>
              </p>
            </div>
          </div>
          <div className="mb-2 mt-4 flex items-baseline justify-between px-1">
            <p
              className={`text-[8.5px] font-semibold uppercase ${isRTL ? "" : "tracking-wider"}`}
              style={{ color: brand.sub }}
            >
              {t("mock.bill.transactions")}
            </p>
            <span className="font-mono text-[9px]" style={{ color: brand.muted }}>
              {amount(3)}
            </span>
          </div>
          <div
            className="overflow-hidden rounded-xl border bg-white"
            style={{ borderColor: brand.border }}
          >
            {rows.map((row, index) => (
              <div
                key={row.amount}
                className={`flex items-center gap-2 px-2.5 py-2.5 ${index < rows.length - 1 ? "border-b border-neutral-100" : ""}`}
              >
                <div
                  className="flex h-[23px] w-[23px] shrink-0 items-center justify-center rounded-md"
                  style={
                    row.gave
                      ? { background: ledger.payBg, color: ledger.payStrong }
                      : { background: ledger.collectBg, color: ledger.collectStrong }
                  }
                >
                  <BillIcon name={row.gave ? "up" : "down"} className="h-3 w-3" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="flex items-baseline gap-1">
                      <bdi
                        dir="ltr"
                        className="font-mono text-[11px] font-bold"
                        style={{ color: brand.ink }}
                      >
                        {amount(row.amount)}
                      </bdi>
                      <span className="text-[8px] font-medium" style={{ color: brand.muted }}>
                        AFN
                      </span>
                    </p>
                    <span
                      className="shrink-0 whitespace-nowrap text-[8px]"
                      style={{ color: brand.muted }}
                    >
                      {date(row.date)}
                    </span>
                  </div>
                  <p className="mt-1 text-[9px] leading-snug" style={{ color: brand.sub }}>
                    {row.note}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p dir="ltr" className="mt-5 text-center text-[9px]" style={{ color: brand.muted }}>
            Powered by{" "}
            <span className="font-bold" style={{ color: brand.primary }}>
              kaata.
            </span>
          </p>
        </div>
        <div className="mx-auto mb-2.5 mt-3 h-1 w-20 shrink-0 rounded-full bg-neutral-900" />
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupBill() {
  const { t } = useI18n();
  return (
    <div className="grid w-full max-w-3xl justify-items-center gap-10 md:grid-cols-2 md:gap-12">
      <figure className="flex w-full min-w-0 flex-col items-center">
        <figcaption className="mb-4 text-center text-sm font-semibold text-neutral-700">
          {t("mock.bill.send.caption")}
        </figcaption>
        <SendStatementPreview />
      </figure>
      <figure className="flex w-full min-w-0 flex-col items-center">
        <figcaption className="mb-4 text-center text-sm font-semibold text-neutral-700">
          {t("mock.bill.receive.caption")}
        </figcaption>
        <ReceivedBillPreview />
      </figure>
    </div>
  );
}
