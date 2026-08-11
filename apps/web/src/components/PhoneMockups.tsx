import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n";

// Visual mockups of the mobile app shown on the landing page. Mirrors the
// production UI as closely as a static render can: same wordmark, same
// monochrome palette, same Inter + JetBrains Mono treatment of amounts. All
// copy flows through useI18n() so the screens flip to Dari with the page.
//
// Two fidelity rules that make these read like the real app:
//   1. Amounts stay Western digits in BOTH languages — the app's formatAmount()
//      uses toLocaleString("en-US"), so Dari users see "1,250" too, not "۱٬۲۵۰".
//   2. The currency label is the AFN symbol "؋" (getCurrentCurrencySymbol()),
//      not the letters "AFN" — that's what the app actually renders everywhere,
//      including the WhatsApp share body, and it's locale-independent.
const CURRENCY = "؋";

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    // dir="ltr": the mockups depict the mobile app, which is deliberately
    // locked LTR (see the app's I18nManager architecture) — they must not
    // mirror when the surrounding page flips to RTL for Persian. Dari text
    // still renders correctly (bidi handles the RTL runs), just left-aligned,
    // exactly as the LTR-locked app shows it.
    <div
      dir="ltr"
      className="relative w-[284px] max-w-full aspect-[284/580] bg-white rounded-[2.25rem] border-[7px] border-neutral-900 shadow-[0_20px_50px_-15px_rgba(0,0,0,0.18)] overflow-hidden flex flex-col"
    >
      {/* Pill notch — purely decorative */}
      <div className="h-5 bg-neutral-900 mx-auto w-28 rounded-b-2xl shrink-0" />
      {children}
    </div>
  );
}

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.76.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.84 9.84 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.22 8.22 0 0 1 2.41 5.83c0 4.55-3.7 8.23-8.23 8.23zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.12-.16.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07s.88 2.4 1.01 2.57c.12.16 1.74 2.66 4.21 3.73.59.25 1.05.4 1.41.52.59.19 1.13.16 1.55.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.22-.16-.47-.28z" />
    </svg>
  );
}

function ListRow(props: { name: string; amount: number; sub: string }) {
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-neutral-200 last:border-0">
      <div className="min-w-0 mr-2">
        <p className="text-[12px] font-semibold text-neutral-900 truncate">{props.name}</p>
        <p className="text-[10px] text-neutral-500 mt-0.5">{props.sub}</p>
      </div>
      <div className="flex items-baseline gap-1 shrink-0">
        <span className="text-[12px] font-semibold font-mono text-neutral-900">
          {props.amount.toLocaleString("en-US")}
        </span>
        <span className="text-[9px] font-medium text-neutral-400">{CURRENCY}</span>
      </div>
    </div>
  );
}

function Tabs({ active }: { active: "collect" | "pay" }) {
  const { t } = useI18n();
  return (
    <div className="flex p-[3px] bg-neutral-50 border border-neutral-200 rounded-[10px]">
      <div
        className={`flex-1 py-1.5 rounded-[7px] text-[11px] text-center ${
          active === "collect"
            ? "bg-neutral-900 text-white font-semibold"
            : "text-neutral-700 font-medium"
        }`}
      >
        {t("home.tab.collect")}
      </div>
      <div
        className={`flex-1 py-1.5 rounded-[7px] text-[11px] text-center ${
          active === "pay"
            ? "bg-neutral-900 text-white font-semibold"
            : "text-neutral-700 font-medium"
        }`}
      >
        {t("home.tab.pay")}
      </div>
    </div>
  );
}

// Small uppercase eyebrow labels. Arabic script doesn't uppercase and reacts
// badly to letter-spacing, so drop both for Dari (mirrors the SiteChrome
// wordmark treatment).
function eyebrowClass(isRTL: boolean): string {
  return `text-[9px] font-semibold text-neutral-500 ${isRTL ? "" : "uppercase tracking-wider"}`;
}

export function PhoneMockupHome() {
  const { t, lang } = useI18n();
  const isRTL = lang === "fa";
  return (
    <PhoneFrame>
      <div className="px-4 pt-3 pb-4 flex-1 flex flex-col">
        <p className={`text-[18px] font-bold text-neutral-900 ${isRTL ? "" : "-tracking-tight"}`}>
          {t("brand.wordmark")}
        </p>
        <p className="text-[10px] text-neutral-500 mt-0.5">
          {t("mock.self.name")} · {t("mock.self.shop")}
        </p>

        <div className="mt-4">
          <Tabs active="collect" />
        </div>

        <div className="mt-4">
          <p className={eyebrowClass(isRTL)}>{t("home.total.label.collect")}</p>
          <div className="flex items-baseline gap-1.5 mt-1">
            <p className="text-[32px] font-bold font-mono text-collect-strong leading-none -tracking-tight">
              6,220
            </p>
            <p className="text-[11px] text-neutral-400 font-medium">{CURRENCY}</p>
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">{t("home.from.many", { count: 4 })}</p>
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 overflow-hidden bg-white">
          <ListRow
            name={t("mock.name.mahmood")}
            amount={3800}
            sub={t("format.daysAgo", { n: 2 })}
          />
          <ListRow name={t("mock.name.ahmad")} amount={1250} sub={t("format.yesterday")} />
          <ListRow name={t("mock.name.sultan")} amount={750} sub={t("format.daysAgo", { n: 3 })} />
          <ListRow name={t("mock.name.wahid")} amount={420} sub={t("format.weeksAgo", { n: 1 })} />
        </div>

        {/* Mirrors the app's home FAB, which draws a rounded-square
            "home button" mark rather than a "+" — see HOME_MARK_SIZE in
            apps/mobile/app/index.tsx. The app's ratios, scaled to this 44px
            mock: mark = 42% of the button, corner radius = 32% of the mark. */}
        <div className="mt-auto flex justify-end pt-3">
          <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center">
            <div className="w-[18px] h-[18px] rounded-[6px] border-2 border-white" />
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupWhatsApp() {
  const { t, lang } = useI18n();
  const isRTL = lang === "fa";
  const name = t("mock.name.ahmad");
  const accountWith = t("mock.self.shop");

  // Built line-for-line from the EXACT app share.* strings (see
  // apps/mobile/lib/share.ts, balance > 0 path). Amount is formatAmount(1250)
  // = "1,250" and the currency is ؋ — identical to the message the app sends.
  const messageBody = [
    t("share.greeting", { name }),
    "",
    t("share.theyOwe.header", { accountWith }),
    t("share.theyOwe.amount", { amount: "1,250", currency: CURRENCY }),
    "",
    t("share.theyOwe.cta"),
  ].join("\n");

  return (
    <PhoneFrame>
      <div className="px-4 pt-3 pb-3 flex-1 flex flex-col bg-[#efeae2]">
        {/* WhatsApp header */}
        <div className="flex items-center gap-2 pb-3 border-b border-neutral-300/60">
          <div className="w-7 h-7 rounded-full bg-neutral-300 flex items-center justify-center text-[11px] font-semibold text-neutral-700">
            {name.charAt(0)}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-neutral-900 leading-tight truncate">
              {name}
            </p>
            <p className="text-[10px] text-neutral-500 truncate" dir="ltr">
              +93 70 123 4567
            </p>
          </div>
        </div>

        {/* Outgoing message (the Kaata ping). dir follows the language so the
            Dari message reads right-to-left the way WhatsApp renders it for the
            recipient; the bubble stays on the right via physical ml-auto. */}
        <div className="mt-4 flex-1 space-y-2.5">
          <div
            dir={isRTL ? "rtl" : "ltr"}
            className="ml-auto max-w-[88%] bg-[#d9fdd3] rounded-2xl rounded-br-sm px-3 py-2.5 text-[12px] text-neutral-900 leading-relaxed shadow-[0_1px_0_rgba(0,0,0,0.04)]"
          >
            <span className="whitespace-pre-line">{messageBody}</span>
            <br />
            <br />
            <span className="text-neutral-500">{t("share.footer")}</span>
            <div className="mt-1 text-right text-[9px] text-neutral-500" dir="ltr">
              10:23 AM <span className="text-sky-600">✓✓</span>
            </div>
          </div>

          <div
            dir={isRTL ? "rtl" : "ltr"}
            className="mr-auto max-w-[70%] bg-white rounded-2xl rounded-bl-sm px-3 py-2 text-[12px] text-neutral-900 shadow-[0_1px_0_rgba(0,0,0,0.04)]"
          >
            {t("mock.whatsapp.reply")}
            <div className="mt-0.5 text-right text-[9px] text-neutral-500" dir="ltr">
              10:31 AM
            </div>
          </div>
        </div>

        {/* Reply field */}
        <div className="mt-3 flex items-center gap-2">
          <div className="flex-1 bg-white rounded-full px-3 py-2">
            <span className="text-[11px] text-neutral-400">
              {t("mock.whatsapp.messagePlaceholder")}
            </span>
          </div>
          <div className="w-9 h-9 rounded-full bg-[#00a884] flex items-center justify-center text-white">
            <WhatsAppGlyph className="w-4 h-4" />
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

// The just-restored home screen: same layout as PhoneMockupHome, with a
// success card where the offline mockup shows its "entry saved" card. Depicts
// the sign-in-on-a-new-phone moment the backup feature section describes.
export function PhoneMockupRestore() {
  const { t, lang } = useI18n();
  const isRTL = lang === "fa";
  return (
    <PhoneFrame>
      <div className="px-4 pt-3 pb-4 flex-1 flex flex-col">
        <p className={`text-[18px] font-bold text-neutral-900 ${isRTL ? "" : "-tracking-tight"}`}>
          {t("brand.wordmark")}
        </p>
        <p className="text-[10px] text-neutral-500 mt-0.5">
          {t("mock.self.name")} · {t("mock.self.shop")}
        </p>

        <div className="mt-4">
          <Tabs active="collect" />
        </div>

        <div className="mt-4">
          <p className={eyebrowClass(isRTL)}>{t("home.total.label.collect")}</p>
          <div className="flex items-baseline gap-1.5 mt-1">
            <p className="text-[32px] font-bold font-mono text-collect-strong leading-none -tracking-tight">
              6,220
            </p>
            <p className="text-[11px] text-neutral-400 font-medium">{CURRENCY}</p>
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">{t("home.from.many", { count: 4 })}</p>
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 overflow-hidden bg-white">
          <ListRow
            name={t("mock.name.mahmood")}
            amount={3800}
            sub={t("format.daysAgo", { n: 2 })}
          />
          <ListRow name={t("mock.name.ahmad")} amount={1250} sub={t("format.yesterday")} />
          <ListRow name={t("mock.name.sultan")} amount={750} sub={t("format.daysAgo", { n: 3 })} />
        </div>

        <div className="mt-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5 flex items-start gap-2">
          <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white text-[9px] leading-none">
            ✓
          </span>
          <div>
            <p className="text-[10px] font-semibold text-neutral-900 leading-tight">
              {t("mock.restored.title")}
            </p>
            <p className="text-[10px] text-neutral-500 leading-tight mt-0.5">
              {t("mock.restored.sub")}
            </p>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupOffline() {
  const { t, lang } = useI18n();
  const isRTL = lang === "fa";
  return (
    <PhoneFrame>
      <div className="px-4 pt-3 pb-4 flex-1 flex flex-col">
        <div className="flex items-center justify-between">
          <p className={`text-[18px] font-bold text-neutral-900 ${isRTL ? "" : "-tracking-tight"}`}>
            {t("brand.wordmark")}
          </p>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-neutral-100 border border-neutral-200">
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-400" />
            <span
              className={`text-[9px] font-semibold text-neutral-600 ${isRTL ? "" : "uppercase tracking-wider"}`}
            >
              {t("mock.offline")}
            </span>
          </div>
        </div>
        <p className="text-[10px] text-neutral-500 mt-0.5">
          {t("mock.self.name")} · {t("mock.self.shop")}
        </p>

        <div className="mt-4">
          <Tabs active="collect" />
        </div>

        <div className="mt-4">
          <p className={eyebrowClass(isRTL)}>{t("home.total.label.collect")}</p>
          <div className="flex items-baseline gap-1.5 mt-1">
            <p className="text-[32px] font-bold font-mono text-collect-strong leading-none -tracking-tight">
              5,800
            </p>
            <p className="text-[11px] text-neutral-400 font-medium">{CURRENCY}</p>
          </div>
          <p className="text-[10px] text-neutral-500 mt-1">{t("home.from.many", { count: 3 })}</p>
        </div>

        <div className="mt-4 rounded-xl border border-neutral-200 overflow-hidden bg-white">
          <ListRow
            name={t("mock.name.mahmood")}
            amount={3800}
            sub={t("format.daysAgo", { n: 2 })}
          />
          <ListRow name={t("mock.name.ahmad")} amount={1250} sub={t("format.yesterday")} />
          <ListRow name={t("mock.name.sultan")} amount={750} sub={t("format.daysAgo", { n: 3 })} />
        </div>

        <div className="mt-auto rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2.5">
          <p className="text-[10px] font-semibold text-neutral-900 leading-tight">
            {t("mock.entrySaved.title")}
          </p>
          <p className="text-[10px] text-neutral-500 leading-tight mt-0.5">
            {t("mock.entrySaved.sub")}
          </p>
        </div>
      </div>
    </PhoneFrame>
  );
}
