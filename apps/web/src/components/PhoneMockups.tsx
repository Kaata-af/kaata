import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../lib/i18n";

// Localized app previews with fictional demo data. Follow the current mobile
// balance cards, mixed-currency rows and entry actions. These are responsive
// illustrations rather than native screen captures. Amounts retain Western
// digits, while text and row direction follow the reader's language.
const CURRENCY = "؋";

// Mirror of apps/mobile/lib/colors.ts (actionPrimary, bgDefault, bgMuted,
// borderDefault, textEmphasis, textDefault, textSubtle, textMuted).
const APP = {
  action: "#000000",
  surface: "#FFFFFF",
  muted: "#F7F7F7",
  border: "#E2E2E2",
  emphasis: "#171717",
  text: "#292929",
  subtle: "#616161",
  faint: "#6B6B6B",
  balance: "#F6F9F7",
  balanceBorder: "#DBE4DF",
  collect: "#0C745A",
  collectBg: "#E8F4EF",
  pay: "#A3203A",
  payBg: "#F8EAEC",
  receivedBg: "#E4EEE6",
  receivedText: "#3E6149",
} as const;

const BALANCE_SURFACE: CSSProperties = {
  background:
    "radial-gradient(ellipse at 0% 0%, #D0EBDD 0%, transparent 72%), radial-gradient(ellipse at 100% 100%, #F8DCE2 0%, transparent 68%), #F6F9F7",
  borderColor: APP.balanceBorder,
};

const APP_FONT: CSSProperties = { fontFamily: '"Vazirmatn", system-ui, sans-serif' };

// The app writes Dari text right-to-left (lib/direction.ts textDir), which
// also keeps trailing periods and leading digits on the correct side inside
// the LTR frame. Applied to text leaves only; layout mirrors via row-reverse.
const textDir = (isRTL: boolean) => (isRTL ? "rtl" : undefined);

function PhoneFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    // dir="ltr": the mockups depict the mobile app, which is deliberately
    // locked LTR (see the app's I18nManager architecture) — they must not
    // mirror when the surrounding page flips to RTL for Persian. Rows that the
    // app mirrors for Dari are mirrored explicitly below.
    <div
      dir="ltr"
      role="img"
      aria-label={t("mock.preview.label")}
      className="relative w-[284px] max-w-full aspect-[284/580] bg-white rounded-[2.25rem] border-[7px] border-[#111111] shadow-[0_20px_50px_-15px_rgba(0,0,0,0.18)] overflow-hidden flex flex-col"
    >
      {/* Pill notch — purely decorative */}
      <div className="h-5 bg-[#111111] mx-auto w-28 rounded-b-2xl shrink-0" />
      {children}
    </div>
  );
}

// ---- Icons: Ionicons outlines (the app's icon set), drawn inline ----------

type IconProps = { className?: string; style?: CSSProperties };

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 32,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function ChevronDownIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path {...STROKE} strokeWidth={48} d="M112 184l144 144 144-144" />
    </svg>
  );
}

function BellIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path
        {...STROKE}
        d="M427.68 351.43C402 320 383.87 304 383.87 217.35 383.87 138 343.35 109.73 310 96c-4.43-1.82-8.6-6-9.95-10.55C294.2 65.54 277.8 48 256 48s-38.21 17.55-44 37.47c-1.35 4.6-5.52 8.71-9.95 10.53-33.39 13.75-73.87 41.92-73.87 121.35C128.13 304 110 320 84.32 351.43 73.68 364.45 83 384 101.61 384h308.88c18.51 0 27.77-19.61 17.19-32.57zM320 384v16a64 64 0 01-128 0v-16"
      />
    </svg>
  );
}

function SearchIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path
        {...STROKE}
        d="M221.09 64a157.09 157.09 0 10157.09 157.09A157.1 157.1 0 00221.09 64zM338.29 338.29L448 448"
      />
    </svg>
  );
}

function AddIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path {...STROKE} d="M256 112v288M400 256H112" />
    </svg>
  );
}

function CheckCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" fill="currentColor" {...props}>
      <path d="M256 48C141.31 48 48 141.31 48 256s93.31 208 208 208 208-93.31 208-208S370.69 48 256 48zm108.25 138.29l-134.4 160a16 16 0 01-12 5.71h-.27a16 16 0 01-11.89-5.3l-57.6-64a16 16 0 1123.78-21.4l45.29 50.32 122.59-145.91a16 16 0 0124.5 20.58z" />
    </svg>
  );
}

function CloudOfflineIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path
        {...STROKE}
        d="M93.72 183.25C49.49 198.05 16 233.1 16 288c0 66 54 112 120 112h184.37M467.82 377.74C485.24 363.3 496 341.61 496 312c0-59.82-53-85.76-96-88-8.89-89.54-71-144-144-144-26.16 0-48.79 6.93-67.6 18.14M448 448L64 64"
      />
    </svg>
  );
}

function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.76.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.84 9.84 0 0 0 12.04 2zm0 18.15h-.01a8.23 8.23 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.24 8.24 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 2.2 0 4.27.86 5.83 2.42a8.22 8.22 0 0 1 2.41 5.83c0 4.55-3.7 8.23-8.23 8.23zm4.52-6.16c-.25-.12-1.47-.72-1.7-.81-.23-.08-.39-.12-.56.12-.16.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.39.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07s.88 2.4 1.01 2.57c.12.16 1.74 2.66 4.21 3.73.59.25 1.05.4 1.41.52.59.19 1.13.16 1.55.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.22-.16-.47-.28z" />
    </svg>
  );
}

// ---- Home screen pieces ----------------------------------------------------

function AppHeader({ badge }: { badge?: ReactNode }) {
  const { t, isRTL } = useI18n();
  // The profile chip shows the signed-in user's first letter (InitialAvatar).
  const initial = Array.from(t("mock.self.name"))[0] ?? "";
  return (
    <div className={`flex items-center px-3 pt-3 pb-2.5 ${isRTL ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex min-w-0 items-center gap-2 rounded-[9px] border px-2 py-1.5 ${isRTL ? "flex-row-reverse" : ""}`}
        style={{ borderColor: APP.border }}
      >
        <span
          dir={textDir(isRTL)}
          className="truncate text-[13px] font-semibold leading-snug"
          style={{ color: APP.emphasis }}
        >
          {t("mock.self.shop")}
        </span>
        <ChevronDownIcon className="h-[11px] w-[11px] shrink-0" style={{ color: APP.subtle }} />
      </div>
      {badge}
      <div className="flex-1" />
      <BellIcon className="h-[15px] w-[15px] shrink-0" style={{ color: APP.emphasis }} />
      <span
        className={`flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${isRTL ? "mr-2.5" : "ml-2.5"}`}
        style={{ background: "#E8EAF7", color: "#39409B" }}
      >
        {initial}
      </span>
    </div>
  );
}

function OfflineBadge() {
  const { t, isRTL } = useI18n();
  // Styled like the app's read-only header badge: a quiet gray pill.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-[3px] rounded-full px-[6px] py-[2px] ${isRTL ? "mr-1.5 flex-row-reverse" : "ml-1.5"}`}
      style={{ background: APP.muted, color: APP.subtle }}
    >
      <CloudOfflineIcon className="h-[9px] w-[9px]" />
      <span dir={textDir(isRTL)} className="text-[8.5px] font-medium leading-none">
        {t("mock.offline")}
      </span>
    </span>
  );
}

function DirectionArrow({ up, className }: { up?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={up ? "M12 20V4m-6 6 6-6 6 6" : "M12 4v16m-6-6 6 6 6-6"} />
    </svg>
  );
}

function BalanceCard() {
  const { t, isRTL } = useI18n();
  return (
    <div className="mx-3 mt-1 overflow-hidden rounded-[11px] border" style={BALANCE_SURFACE}>
      <div
        className="flex items-center justify-between border-b px-2.5 py-1.5 text-[9px]"
        style={{ borderColor: APP.balanceBorder, color: APP.subtle }}
      >
        <span className="font-semibold" dir="ltr">
          AFN
        </span>
        <span dir={textDir(isRTL)}>{t("mock.balance.title")}</span>
      </div>
      <div className="grid grid-cols-2">
        {(
          [
            { key: "collect", amount: "5,800", color: APP.collect, up: false },
            { key: "pay", amount: "420", color: APP.pay, up: true },
          ] as const
        ).map((side) => (
          <div
            key={side.key}
            className={`min-w-0 px-2.5 pb-3 pt-2 ${side.up ? "border-l" : ""}`}
            style={{ borderColor: APP.balanceBorder }}
          >
            <div
              className={`flex items-center justify-between gap-1 text-[9px] ${isRTL ? "flex-row-reverse" : ""}`}
              style={{ color: APP.subtle }}
            >
              <span dir={textDir(isRTL)}>
                {t(side.up ? "mock.balance.pay" : "home.total.label.collect")}
              </span>
              <DirectionArrow up={side.up} className="h-3 w-3 shrink-0" />
            </div>
            <p
              className="mt-3 font-mono text-[25px] font-semibold leading-none tracking-tight"
              style={{ color: side.color }}
              dir="ltr"
            >
              {side.amount}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

type Row = { name: string; balances: { amount: number; currency: string }[]; sub: string };

function PeopleCard({ rows }: { rows: Row[] }) {
  const { isRTL } = useI18n();
  return (
    <div
      className="mx-3 mt-3 overflow-hidden rounded-[10px] border bg-white"
      style={{ borderColor: APP.border }}
    >
      {rows.map((row, index) => (
        <div
          key={row.name}
          className={`flex items-center gap-2 px-2.5 py-2 ${isRTL ? "flex-row-reverse" : ""} ${index > 0 ? "border-t" : ""}`}
          style={{ borderColor: APP.border }}
        >
          <div className={`min-w-0 flex-1 ${isRTL ? "text-right" : ""}`}>
            <p
              dir={textDir(isRTL)}
              className="truncate text-[12px] font-semibold"
              style={{ color: APP.emphasis }}
            >
              {row.name}
            </p>
            <p dir={textDir(isRTL)} className="mt-0.5 text-[9px]" style={{ color: APP.subtle }}>
              {row.sub}
            </p>
          </div>
          <div className={`flex shrink-0 flex-col gap-1 ${isRTL ? "items-start" : "items-end"}`}>
            {row.balances.map((balance) => (
              <div key={balance.currency} dir="ltr" className="flex items-baseline gap-1">
                <span
                  className="font-mono text-[11px] font-semibold"
                  style={{ color: balance.amount < 0 ? APP.pay : APP.collect }}
                >
                  {balance.amount < 0 ? "−" : "+"}
                  {Math.abs(balance.amount).toLocaleString("en-US")}
                </span>
                <span className="text-[8px] font-medium" style={{ color: APP.faint }}>
                  {balance.currency}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// The app's success toast: white card, hairline border, lifted, check icon.
function AppToast({ title, sub }: { title: string; sub: string }) {
  const { isRTL } = useI18n();
  return (
    <div
      className={`mx-3 mb-2 flex items-start gap-2 rounded-[10px] border bg-white px-2.5 py-2 shadow-[0_10px_20px_-10px_rgba(0,0,0,0.3)] ${
        isRTL ? "flex-row-reverse text-right" : ""
      }`}
      style={{ borderColor: APP.border }}
    >
      <CheckCircleIcon className="h-[15px] w-[15px] shrink-0" style={{ color: APP.emphasis }} />
      <div className="min-w-0">
        <p
          dir={textDir(isRTL)}
          className="text-[10px] font-semibold leading-tight"
          style={{ color: APP.emphasis }}
        >
          {title}
        </p>
        <p
          dir={textDir(isRTL)}
          className="mt-0.5 text-[9.5px] leading-tight"
          style={{ color: APP.subtle }}
        >
          {sub}
        </p>
      </div>
    </div>
  );
}

// The default home dock keeps search and the black add action in a fixed row.
function Dock() {
  const { t, isRTL } = useI18n();
  return (
    <div
      className="flex items-center gap-2 border-t px-3 pb-3.5 pt-2.5"
      style={{ borderColor: "#EFEFEF" }}
    >
      <div
        className={`flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[9px] border bg-white px-2 ${isRTL ? "flex-row-reverse" : ""}`}
        style={{ borderColor: APP.border }}
      >
        <SearchIcon className="h-[15px] w-[15px] shrink-0" style={{ color: APP.subtle }} />
        <span
          dir={textDir(isRTL)}
          className={`min-w-0 flex-1 truncate text-[10px] ${isRTL ? "text-right" : ""}`}
          style={{ color: APP.faint }}
        >
          {t("customers.search")}
        </span>
      </div>
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: APP.action, color: APP.surface }}
      >
        <AddIcon className="h-[19px] w-[19px]" />
      </div>
    </div>
  );
}

function HomeScreen(props: { rows: Row[]; toast?: { title: string; sub: string } }) {
  const { t, isRTL } = useI18n();
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
      <AppHeader />
      <BalanceCard />
      <div className="mx-3 mt-1.5 h-px bg-neutral-200">
        <div className="h-px w-1/2 bg-neutral-500" />
      </div>
      <PeopleCard rows={props.rows} />
      <div
        className={`mx-3 mt-3 flex items-center gap-1.5 text-[9px] ${isRTL ? "flex-row-reverse" : ""}`}
        style={{ color: APP.subtle }}
      >
        <span aria-hidden="true">✓✓</span>
        <span dir={textDir(isRTL)}>{t("mock.settled")}</span>
        <span className="flex-1" />
        <span>2</span>
        <ChevronDownIcon className="h-2.5 w-2.5" />
      </div>
      <div className="mt-auto pt-3">
        {props.toast ? <AppToast title={props.toast.title} sub={props.toast.sub} /> : null}
        <Dock />
      </div>
    </div>
  );
}

function useSampleRows(): Row[] {
  const { t } = useI18n();
  return [
    {
      name: t("mock.name.mahmood"),
      balances: [
        { amount: 3800, currency: "AFN" },
        { amount: 100, currency: "USD" },
      ],
      sub: t("format.daysAgo", { n: 2 }),
    },
    {
      name: t("mock.name.ahmad"),
      balances: [{ amount: 1250, currency: "AFN" }],
      sub: t("format.yesterday"),
    },
    {
      name: t("mock.name.sultan"),
      balances: [{ amount: 750, currency: "AFN" }],
      sub: t("format.daysAgo", { n: 3 }),
    },
    {
      name: t("mock.name.wahid"),
      balances: [{ amount: -420, currency: "AFN" }],
      sub: t("format.weeksAgo", { n: 1 }),
    },
  ];
}

export function PhoneMockupHome() {
  const rows = useSampleRows();
  return (
    <PhoneFrame>
      <HomeScreen rows={rows} />
    </PhoneFrame>
  );
}

export function PhoneMockupWhatsApp() {
  const { t, lang } = useI18n();
  const isRTL = lang !== "en";
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

        {/* Outgoing message (the Kaata reminder). dir follows the language so
            the Dari message reads right-to-left the way WhatsApp renders it for
            the recipient; the bubble stays on the right via physical ml-auto. */}
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

// The just-restored home screen: the sign-in-on-a-new-phone moment the backup
// feature section describes, confirmed by the app's success toast.
export function PhoneMockupRestore() {
  const { t } = useI18n();
  const rows = useSampleRows();
  return (
    <PhoneFrame>
      <HomeScreen
        rows={rows}
        toast={{ title: t("mock.restored.title"), sub: t("mock.restored.sub") }}
      />
    </PhoneFrame>
  );
}

export function PhoneMockupOffline() {
  const { t, isRTL } = useI18n();
  const tallies = [
    { amount: "500", gave: false, when: t("mock.today"), note: t("mock.payment") },
    { amount: "750", gave: true, when: t("format.yesterday"), note: t("mock.supplies") },
    { amount: "1,000", gave: true, when: t("format.daysAgo", { n: 3 }), note: t("mock.goods") },
  ];
  return (
    <PhoneFrame>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <div className={`flex items-center gap-2 px-3 py-3 ${isRTL ? "flex-row-reverse" : ""}`}>
          <span
            className="text-[22px] leading-none"
            style={{ color: APP.emphasis }}
            aria-hidden="true"
          >
            {isRTL ? "›" : "‹"}
          </span>
          <p
            dir={textDir(isRTL)}
            className="min-w-0 flex-1 text-center text-[14px] font-semibold"
            style={{ color: APP.emphasis }}
          >
            {t("mock.name.ahmad")}
          </p>
          <OfflineBadge />
        </div>
        <div
          className="mx-3 mb-2 rounded-[8px] border px-2.5 py-2"
          style={{ background: APP.muted, borderColor: APP.border }}
          dir={textDir(isRTL)}
        >
          <p className="text-[8px] font-medium" style={{ color: APP.subtle }}>
            {t("mock.customerNote")}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed" style={{ color: APP.text }}>
            {t("mock.customerNote.body")}
          </p>
        </div>
        <div className="mx-3 overflow-hidden rounded-[11px] border" style={BALANCE_SURFACE}>
          <div
            className={`flex items-center justify-between gap-2 px-2.5 py-3 ${isRTL ? "flex-row-reverse" : ""}`}
          >
            <div dir="ltr" className="flex items-baseline gap-1.5">
              <span
                className="font-mono text-[25px] font-semibold leading-none"
                style={{ color: APP.collect }}
              >
                1,250
              </span>
              <span className="text-[9px]" style={{ color: APP.subtle }}>
                AFN
              </span>
            </div>
            <span
              className="rounded-md px-1.5 py-1 text-[8px] font-medium"
              dir={textDir(isRTL)}
              style={{ background: APP.collectBg, color: APP.collect }}
            >
              {t("mock.owesYou")}
            </span>
          </div>
          <div
            className="grid grid-cols-2 border-t text-[9px]"
            style={{ borderColor: APP.balanceBorder }}
          >
            {(
              [
                { gave: false, amount: "500" },
                { gave: true, amount: "1,750" },
              ] as const
            ).map((item) => (
              <div
                key={item.amount}
                className={`px-2.5 py-2 ${item.gave ? "border-l" : ""}`}
                style={{ borderColor: APP.balanceBorder }}
              >
                <p dir={textDir(isRTL)} style={{ color: APP.subtle }}>
                  {t(item.gave ? "mock.gave" : "mock.received")}
                </p>
                <p
                  className="mt-1 font-mono text-[12px] font-medium"
                  style={{ color: APP.emphasis }}
                  dir="ltr"
                >
                  {item.amount}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div
          className="mx-3 mt-2.5 overflow-hidden rounded-[10px] border"
          style={{ borderColor: APP.border }}
        >
          {tallies.map((tally, index) => (
            <div
              key={tally.amount}
              className={`flex gap-2 px-2.5 py-2 ${isRTL ? "flex-row-reverse" : ""} ${index ? "border-t" : ""}`}
              style={{ borderColor: APP.border }}
            >
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                style={{
                  background: tally.gave ? APP.payBg : APP.collectBg,
                  color: tally.gave ? APP.pay : APP.collect,
                }}
              >
                <DirectionArrow up={tally.gave} className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={`flex items-baseline justify-between gap-1 ${isRTL ? "flex-row-reverse" : ""}`}
                >
                  <span
                    dir="ltr"
                    className="font-mono text-[11px] font-semibold"
                    style={{ color: APP.emphasis }}
                  >
                    {tally.amount}{" "}
                    <span className="font-sans text-[8px]" style={{ color: APP.faint }}>
                      AFN
                    </span>
                  </span>
                  <span className="text-[8px]" dir={textDir(isRTL)} style={{ color: APP.subtle }}>
                    {tally.when}
                  </span>
                </div>
                <p dir={textDir(isRTL)} className="mt-1 text-[9px]" style={{ color: APP.subtle }}>
                  {tally.note}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-auto pt-2">
          <AppToast title={t("mock.entrySaved.title")} sub={t("mock.entrySaved.sub")} />
          <div className="flex gap-2 px-3 pb-2.5">
            {([false, true] as const).map((gave) => (
              <div
                key={String(gave)}
                className={`flex min-h-9 flex-1 items-center justify-center gap-1 rounded-[9px] px-1 text-[10px] font-semibold ${isRTL ? "flex-row-reverse" : ""}`}
                style={{
                  background: gave ? APP.payBg : APP.receivedBg,
                  color: gave ? APP.pay : APP.receivedText,
                }}
              >
                <DirectionArrow up={gave} className="h-3.5 w-3.5 shrink-0" />
                <span dir={textDir(isRTL)}>{t(gave ? "mock.gave" : "mock.received")}</span>
              </div>
            ))}
          </div>
          <div className="mx-auto mb-2.5 h-1 w-20 rounded-full bg-neutral-900" />
        </div>
      </div>
    </PhoneFrame>
  );
}
