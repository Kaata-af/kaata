import { useI18n } from "../lib/i18n";
import { PhoneFrame } from "./PhoneMockups";

const APP_FONT = { fontFamily: '"Vazirmatn", system-ui, sans-serif' };

// The current mobile VaultPickerSheet is only a switcher: active kaatas,
// their currency codes and Add a Kaata. Settings live in the profile sheet.
export function PhoneMockupBusinesses() {
  const { t, isRTL } = useI18n();
  const businesses = [
    { name: t("mock.self.shop"), currencies: "AFN · USD", active: true },
    { name: t("mock.businesses.shop2"), currencies: "AFN", active: false },
    { name: t("mock.businesses.shop3"), currencies: "AFN", active: false },
  ];
  return (
    <PhoneFrame label={t("mock.businesses.preview.label")}>
      <div className="relative min-h-0 flex-1" style={APP_FONT}>
        <div className="h-full" aria-hidden="true">
          <div className={`flex h-11 items-center gap-2.5 px-3 ${isRTL ? "flex-row-reverse" : ""}`}>
            <div
              className={`flex min-w-0 items-center gap-1.5 rounded-lg border border-neutral-200 px-2 py-1.5 ${isRTL ? "flex-row-reverse" : ""}`}
            >
              <span
                dir={isRTL ? "rtl" : "ltr"}
                className="max-w-[117px] truncate text-[11px] font-semibold text-neutral-900"
              >
                {t("mock.self.shop")}
              </span>
              <svg viewBox="0 0 20 20" className="h-2.5 w-2.5 shrink-0 text-neutral-500">
                <path d="m5 7 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </div>
            <div className="flex-1" />
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 shrink-0 text-neutral-800"
            >
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" />
            </svg>
            <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full bg-[#E8EAF7] text-[11px] font-bold text-[#39409B]">
              {t("mock.self.name").charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="mx-3 mt-1 overflow-hidden rounded-[11px] border border-[#DBE4DF] bg-[linear-gradient(120deg,#D0EBDD,#F6F9F7_55%,#F8DCE2)]">
            <div className="flex items-center justify-between border-b border-[#DBE4DF] px-2.5 py-1.5 text-[9px] text-neutral-600">
              <span className="font-semibold">AFN</span>
              <span dir={isRTL ? "rtl" : "ltr"}>{t("mock.balance.title")}</span>
            </div>
            <div className="grid grid-cols-2">
              {[
                { label: t("home.total.label.collect"), amount: "5,800", color: "#0C745A" },
                { label: t("mock.balance.pay"), amount: "420", color: "#A3203A" },
              ].map((balance, index) => (
                <div
                  key={balance.amount}
                  className={`px-2.5 pb-3 pt-2 ${index ? "border-l border-[#DBE4DF]" : ""}`}
                >
                  <p dir={isRTL ? "rtl" : "ltr"} className="text-[9px] text-neutral-600">
                    {balance.label}
                  </p>
                  <p
                    dir="ltr"
                    className="mt-3 font-mono text-[25px] font-semibold leading-none tracking-tight"
                    style={{ color: balance.color }}
                  >
                    {balance.amount}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="mx-3 mt-3 overflow-hidden rounded-[10px] border border-neutral-200">
            {[
              { name: t("mock.name.mahmood"), balance: "+3,800" },
              { name: t("mock.name.ahmad"), balance: "+1,250" },
            ].map((person, index) => (
              <div
                key={person.balance}
                className={`flex items-center justify-between gap-2 px-2.5 py-3 ${isRTL ? "flex-row-reverse" : ""} ${index ? "border-t border-neutral-200" : ""}`}
              >
                <p dir={isRTL ? "rtl" : "ltr"} className="text-[12px] font-semibold">
                  {person.name}
                </p>
                <span dir="ltr" className="font-mono text-[11px] font-semibold text-[#0C745A]">
                  {person.balance} <span className="font-sans text-[8px]">AFN</span>
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute inset-0 bg-black/25 backdrop-blur-[1.5px]" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 rounded-t-[18px] border-t border-neutral-200 bg-white pb-2.5 pt-2">
          <div className="flex h-6 items-center justify-center">
            <div className="h-1 w-7 rounded-full bg-neutral-300" />
          </div>
          <p
            dir={isRTL ? "rtl" : "ltr"}
            className={`px-3.5 pb-1.5 pt-1 text-[8px] font-semibold uppercase text-neutral-600 ${isRTL ? "" : "tracking-wider"}`}
          >
            {t("menu.allKaatas")}
          </p>
          {businesses.map((business) => (
            <div
              key={business.name}
              className={`flex min-h-[49px] items-center gap-2.5 border-b border-neutral-100 px-3.5 py-3 ${isRTL ? "flex-row-reverse" : ""}`}
            >
              <SelectionIcon selected={business.active} />
              <p
                dir={isRTL ? "rtl" : "ltr"}
                className={`min-w-0 max-w-[50%] shrink truncate text-[11px] text-neutral-800 ${business.active ? "font-semibold" : "font-medium"}`}
              >
                {business.name}
              </p>
              <span
                dir="ltr"
                className={`min-w-0 flex-1 truncate text-[10px] font-medium text-neutral-500 ${isRTL ? "text-left" : "text-right"}`}
              >
                {business.currencies}
              </span>
            </div>
          ))}
          <div
            className={`flex min-h-[49px] items-center gap-2.5 px-3.5 py-3 ${isRTL ? "flex-row-reverse" : ""}`}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="h-[18px] w-[18px] shrink-0 text-neutral-900"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v10M7 12h10" />
            </svg>
            <p dir={isRTL ? "rtl" : "ltr"} className="text-[11px] font-semibold text-neutral-900">
              {t("menu.allKaatas.add")}
            </p>
          </div>
          <div className="mx-auto mt-2 h-1 w-20 rounded-full bg-neutral-900" />
        </div>
      </div>
    </PhoneFrame>
  );
}

function SelectionIcon({ selected }: { selected: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" aria-hidden="true" fill="none">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill={selected ? "#000000" : "none"}
        stroke={selected ? "#000000" : "#6B6B6B"}
        strokeWidth="1.5"
      />
      {selected ? <path d="m7.5 12 3 3 6-6" stroke="white" strokeWidth="1.6" /> : null}
    </svg>
  );
}
