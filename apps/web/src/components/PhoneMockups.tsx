import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../lib/i18n";

// Visual mockups of the mobile app shown on the landing page. They mirror the
// current home screen (apps/mobile/app/index.tsx) as closely as a static render
// can: the kaata-name switcher with the bell and profile chip, the black
// segmented tabs, the hero total, one bordered people card and the bottom dock
// (Sort & filter, customer search, the black add button). All copy flows
// through useI18n() so the screens flip to Dari with the page.
//
// Fidelity rules that make these read like the real app:
//   1. The app's own chrome is neutral black/white/gray, so the screens use the
//      app palette below, not the site's plum-tinted neutrals. Brand color stays
//      outside the phone; only money direction (collect green) is colored.
//   2. UI text renders in Vazirmatn, the app's face in English too; amounts use
//      JetBrains Mono and stay Western digits in BOTH languages (formatAmount()
//      uses toLocaleString("en-US")).
//   3. The currency label is the AFN symbol "؋" (getCurrentCurrencySymbol()),
//      not the letters "AFN", in every language.
//   4. Dari mirrors each ROW the way the app's rowDir()/textDir() do (titles and
//      names on the right, amounts on the left), while the screen stays
//      LTR-locked: To collect stays the left tab and the add button stays right.
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
} as const;

const APP_FONT: CSSProperties = { fontFamily: '"Vazirmatn", system-ui, sans-serif' };

// The app writes Dari text right-to-left (lib/direction.ts textDir), which
// also keeps trailing periods and leading digits on the correct side inside
// the LTR frame. Applied to text leaves only; layout mirrors via row-reverse.
const textDir = (isRTL: boolean) => (isRTL ? "rtl" : undefined);

function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    // dir="ltr": the mockups depict the mobile app, which is deliberately
    // locked LTR (see the app's I18nManager architecture) — they must not
    // mirror when the surrounding page flips to RTL for Persian. Rows that the
    // app mirrors for Dari are mirrored explicitly below.
    <div
      dir="ltr"
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

function OptionsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <path {...STROKE} d="M368 128h80M64 128h240M368 384h80M64 384h240M208 256h240M64 256h80" />
      <circle {...STROKE} cx="336" cy="128" r="32" />
      <circle {...STROKE} cx="176" cy="256" r="32" />
      <circle {...STROKE} cx="336" cy="384" r="32" />
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
      <div className={`flex min-w-0 items-center gap-[3px] ${isRTL ? "flex-row-reverse" : ""}`}>
        <span
          dir={textDir(isRTL)}
          className="truncate text-[19px] font-bold leading-snug"
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
        style={{ background: APP.muted, color: APP.emphasis }}
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

function Tabs({ active }: { active: "collect" | "pay" }) {
  const { t } = useI18n();
  // Not mirrored in Dari: the tabs track the LTR-locked swipe rail.
  return (
    <div
      className="flex rounded-[6px] border p-[3px]"
      style={{ background: APP.muted, borderColor: APP.border }}
    >
      {(["collect", "pay"] as const).map((key) => (
        <div
          key={key}
          className={`flex h-[30px] flex-1 items-center justify-center rounded-[5px] text-[10.5px] ${
            key === active ? "font-semibold" : "font-medium"
          }`}
          style={
            key === active ? { background: APP.action, color: APP.surface } : { color: APP.text }
          }
        >
          {t(key === "collect" ? "home.tab.collect" : "home.tab.pay")}
        </div>
      ))}
    </div>
  );
}

function Total({ amount, count }: { amount: string; count: number }) {
  const { t, isRTL } = useI18n();
  return (
    <div className={`mt-3 px-3 ${isRTL ? "text-right" : ""}`}>
      <p
        dir={textDir(isRTL)}
        className={`text-[9px] font-semibold ${isRTL ? "" : "uppercase tracking-[0.06em]"}`}
        style={{ color: APP.subtle }}
      >
        {t("home.total.label.collect")}
      </p>
      <div className={`mt-1 flex items-baseline gap-1.5 ${isRTL ? "flex-row-reverse" : ""}`}>
        <span className="font-mono text-[28px] font-bold leading-none -tracking-[0.02em] text-collect-strong">
          {amount}
        </span>
        <span className="text-[11px] font-medium" style={{ color: APP.faint }}>
          {CURRENCY}
        </span>
      </div>
      <p dir={textDir(isRTL)} className="mt-1 text-[10px]" style={{ color: APP.subtle }}>
        {t("home.from.many", { count })}
      </p>
    </div>
  );
}

type Row = { name: string; amount: number; sub: string };

function PeopleCard({ rows }: { rows: Row[] }) {
  const { isRTL } = useI18n();
  return (
    <div
      className="mx-3 mt-3.5 overflow-hidden rounded-[9px] border bg-white"
      style={{ borderColor: APP.border }}
    >
      {rows.map((row, index) => (
        <div
          key={row.name}
          className={`flex items-center px-2.5 py-[9px] ${isRTL ? "flex-row-reverse" : ""} ${
            index > 0 ? "border-t" : ""
          }`}
          style={{ borderColor: APP.border }}
        >
          <div className={`min-w-0 flex-1 ${isRTL ? "ml-2 text-right" : "mr-2"}`}>
            <p
              dir={textDir(isRTL)}
              className="truncate text-[12px] font-semibold"
              style={{ color: APP.emphasis }}
            >
              {row.name}
            </p>
            <p dir={textDir(isRTL)} className="mt-px text-[9.5px]" style={{ color: APP.subtle }}>
              {row.sub}
            </p>
          </div>
          <div className={`flex shrink-0 items-baseline gap-1 ${isRTL ? "flex-row-reverse" : ""}`}>
            <span className="font-mono text-[12px] font-semibold" style={{ color: APP.emphasis }}>
              {row.amount.toLocaleString("en-US")}
            </span>
            <span className="text-[9px] font-medium" style={{ color: APP.faint }}>
              {CURRENCY}
            </span>
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

// Bottom dock: Sort & filter stays left and add stays right in both languages;
// only the search field's contents mirror in Dari.
function Dock() {
  const { t, isRTL } = useI18n();
  return (
    <div className="flex items-center gap-1.5 px-3 pb-3.5">
      <div
        className="flex h-9 w-[30px] shrink-0 items-center justify-center rounded-[8px] border bg-white"
        style={{ borderColor: APP.border, color: APP.text }}
      >
        <OptionsIcon className="h-[15px] w-[15px]" />
      </div>
      <div
        className={`flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] border bg-white px-1.5 ${
          isRTL ? "flex-row-reverse" : ""
        }`}
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

function HomeScreen(props: {
  total: string;
  count: number;
  rows: Row[];
  badge?: ReactNode;
  toast?: { title: string; sub: string };
}) {
  return (
    <div className="flex flex-1 flex-col" style={APP_FONT}>
      <AppHeader badge={props.badge} />
      <div className="px-3">
        <Tabs active="collect" />
      </div>
      <Total amount={props.total} count={props.count} />
      <PeopleCard rows={props.rows} />
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
    { name: t("mock.name.mahmood"), amount: 3800, sub: t("format.daysAgo", { n: 2 }) },
    { name: t("mock.name.ahmad"), amount: 1250, sub: t("format.yesterday") },
    { name: t("mock.name.sultan"), amount: 750, sub: t("format.daysAgo", { n: 3 }) },
    { name: t("mock.name.wahid"), amount: 420, sub: t("format.weeksAgo", { n: 1 }) },
  ];
}

export function PhoneMockupHome() {
  const rows = useSampleRows();
  return (
    <PhoneFrame>
      <HomeScreen total="6,220" count={4} rows={rows} />
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
        total="6,220"
        count={4}
        rows={rows}
        toast={{ title: t("mock.restored.title"), sub: t("mock.restored.sub") }}
      />
    </PhoneFrame>
  );
}

export function PhoneMockupOffline() {
  const { t } = useI18n();
  const rows = useSampleRows().slice(0, 3);
  return (
    <PhoneFrame>
      <HomeScreen
        total="5,800"
        count={3}
        rows={rows}
        badge={<OfflineBadge />}
        toast={{ title: t("mock.entrySaved.title"), sub: t("mock.entrySaved.sub") }}
      />
    </PhoneFrame>
  );
}
