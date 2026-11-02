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
  receivedCoin: "#CDDFD1",
  payCoin: "#F1DADE",
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

export function PhoneFrame({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useI18n();
  return (
    // dir="ltr": the mockups depict the mobile app, which is deliberately
    // locked LTR (see the app's I18nManager architecture) — they must not
    // mirror when the surrounding page flips to RTL for Persian. Rows that the
    // app mirrors for Dari are mirrored explicitly below.
    <div
      dir="ltr"
      role="img"
      aria-label={label ?? t("mock.preview.label")}
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

function CalendarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" {...props}>
      <rect {...STROKE} x="48" y="80" width="416" height="384" rx="48" />
      <path {...STROKE} d="M128 48v64M384 48v64M48 192h416" />
      <path {...STROKE} d="M128 272h0M256 272h0M384 272h0M128 368h0M256 368h0" />
    </svg>
  );
}

function MoreIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" {...props}>
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function SharedAccountIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#2563EB"
        d="m23 12-2.44-2.79.34-3.69-3.61-.82L15.4 1.5 12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.35 3.7L1 12l2.44 2.8-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.35-3.69L23 12Z"
      />
      <path fill="white" d="m10 16-4-4 1.41-1.41L10 13.17l6.59-6.59L18 8l-8 8Z" />
    </svg>
  );
}

function NoticeIcon({ kind, ...props }: IconProps & { kind: "added" | "accepted" | "voided" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path
        d={
          kind === "added"
            ? "M4 3l2 1 2-1 2 1 2-1 2 1 2-1 2 1 2-1v18l-2-1-2 1-2-1-2 1-2-1-2 1-2-1-2 1V3ZM8 8h8M8 12h6"
            : kind === "accepted"
              ? "m5 12 4 4L19 6"
              : "m6 6 12 12M6 18 18 6"
        }
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

const CHAT_ICON_PATHS = {
  back: "M19 12H5m6-6-6 6 6 6",
  avatar: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 21v-2a7 7 0 0 1 14 0v2",
  video: "M15 8l6-3v14l-6-3M5 5h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  call: "M5 3h3l2 5-2 2a15 15 0 0 0 6 6l2-2 5 2v3a2 2 0 0 1-2 2A18 18 0 0 1 3 5a2 2 0 0 1 2-2Z",
  smile: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM8 9h.01M16 9h.01M7 14a5.5 5.5 0 0 0 10 0",
  attachment:
    "m9 13 6-6a3 3 0 0 1 4 4L10 20a5 5 0 0 1-7-7L13 3a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8",
  camera:
    "M8 5l2-2h4l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  microphone: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8",
} as const;

function ChatIcon({ name, ...props }: IconProps & { name: keyof typeof CHAT_ICON_PATHS }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={CHAT_ICON_PATHS[name]} />
    </svg>
  );
}

// One overlapping double-tick shape keeps receipts independent of font spacing.
function ReadReceipt() {
  return (
    <svg
      viewBox="0 0 24 18"
      fill="none"
      stroke="#53BDEB"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-[11px] w-[15px] shrink-0"
    >
      <path d="m1.5 9 4.5 4.5L17 2.5m-7 8 3 3L23 2.5" />
    </svg>
  );
}

function ChatWallpaper() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full text-[#b3aaa0]"
      aria-hidden="true"
    >
      <defs>
        <pattern id="whatsapp-chat-doodles" width="144" height="160" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="currentColor" strokeWidth="0.9" opacity="0.24">
            <path d="m19 12 2 5 6 1-5 4 1 6-5-3-5 2 1-6-4-4 6-1 3-4ZM101 99l3 7 8 1-6 5 2 8-7-4-7 4 1-8-6-5 8-1 4-7Z" />
            <path d="M64 24c-7-9-18 2 0 13 18-11 7-22 0-13ZM119 45c-5-7-14 2 0 10 14-8 5-17 0-10Z" />
            <path d="M12 74h19a5 5 0 0 1 5 5v9a5 5 0 0 1-5 5h-8l-7 5v-5h-4a5 5 0 0 1-5-5v-9a5 5 0 0 1 5-5ZM17 83h10" />
            <path d="M67 67a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM54 65h.1M62 65h.1M54 70q4 4 8 0M119 15l8 4-8 4-8-4 8-4ZM119 23v7" />
            <path d="M63 118c-12 1-15 10-11 17 10-1 17-6 11-17ZM52 135l8-12M16 128l10 4-10 4-10-4 10-4ZM22 144l4 4m-4 0 4-4M77 47l4 4m-4 0 4-4M132 139l4 4m-4 0 4-4" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#whatsapp-chat-doodles)" />
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
function AppToast({ title, sub }: { title: string; sub?: string }) {
  const { isRTL } = useI18n();
  return (
    <div
      className={`mx-3 mb-2 flex items-center gap-2 rounded-[10px] border bg-white px-2.5 py-2 shadow-[0_10px_20px_-10px_rgba(0,0,0,0.3)] ${
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
        {sub ? (
          <p
            dir={textDir(isRTL)}
            className="mt-0.5 text-[9.5px] leading-tight"
            style={{ color: APP.subtle }}
          >
            {sub}
          </p>
        ) : null}
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

// The person dock keeps the entry actions above search and the date filter.
// Both rows remain physically LTR, as in the mobile app.
function EntryDock() {
  const { t, isRTL } = useI18n();
  return (
    <div className="space-y-2 border-t px-3 pt-2.5" style={{ borderColor: "#EFEFEF" }}>
      <div className="flex gap-2">
        {([false, true] as const).map((gave) => (
          <div
            key={String(gave)}
            className="flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-[9px] px-1 text-[10px] font-semibold"
            style={{
              background: gave ? APP.payBg : APP.receivedBg,
              color: gave ? APP.pay : APP.receivedText,
            }}
          >
            <span
              className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full"
              style={{ background: gave ? APP.payCoin : APP.receivedCoin }}
            >
              <DirectionArrow up={gave} className="h-3 w-3" />
            </span>
            <span dir={textDir(isRTL)}>{t(gave ? "mock.gave" : "mock.received")}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[8px] border px-2"
          style={{ borderColor: APP.border }}
        >
          <SearchIcon className="h-[15px] w-[15px] shrink-0" style={{ color: APP.subtle }} />
          <span
            dir={textDir(isRTL)}
            className={`min-w-0 flex-1 text-[10px] ${isRTL ? "text-right" : ""}`}
            style={{ color: APP.faint }}
          >
            {t("person.search.placeholder")}
          </span>
        </div>
        <div
          title={t("person.date.title")}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border"
          style={{ borderColor: APP.border, color: APP.subtle }}
        >
          <CalendarIcon className="h-[17px] w-[17px]" />
        </div>
      </div>
    </div>
  );
}

function HomeScreen(props: { rows: Row[]; toast?: { title: string; sub: string } }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
      <AppHeader />
      <BalanceCard />
      <div className="mx-3 mt-1.5 h-px bg-neutral-200">
        <div className="h-px w-1/2 bg-neutral-500" />
      </div>
      <PeopleCard rows={props.rows} />
      <div className="mt-auto shrink-0 pt-3">
        <Dock />
        {props.toast ? (
          <>
            <AppToast title={props.toast.title} sub={props.toast.sub} />
            <div className="mx-auto mb-2.5 h-1 w-20 rounded-full bg-neutral-900" />
          </>
        ) : null}
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
  const [footerBefore, footerAfter] = t("share.footer").split("www.kaata.af");

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
      <div className="flex min-h-0 flex-1 flex-col text-[#111b21]" style={APP_FONT}>
        <div className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-black/5 bg-white px-2">
          <ChatIcon name="back" className="h-4 w-4 shrink-0" />
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#dfe5e7] text-white">
            <ChatIcon name="avatar" className="mt-1.5 h-[29px] w-[29px]" />
          </div>
          <p dir={textDir(isRTL)} className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {name}
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <ChatIcon name="video" className="h-[17px] w-[17px]" />
            <ChatIcon name="call" className="h-4 w-4" />
            <MoreIcon className="h-4 w-4 rotate-90" />
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col bg-[#efeae2]">
          <ChatWallpaper />
          <div className="relative min-h-0 flex-1 px-[9px] pt-3">
            <div className="mx-auto w-fit rounded-md bg-white/90 px-2 py-1 text-[8px] uppercase leading-none text-[#54656f] shadow-sm">
              {t("mock.today")}
            </div>

            {/* Message direction follows its language; sent bubbles and metadata
                keep their physical positions in every locale. */}
            <div
              dir={textDir(isRTL)}
              className="relative ml-auto mt-3 max-w-[92%] rounded-[7px] rounded-tr-none bg-[#d9fdd3] px-2 pb-1.5 pt-2 text-[12px] leading-[1.45] shadow-[0_1px_1px_rgba(11,20,26,0.12)] after:absolute after:-right-[6px] after:top-0 after:h-2 after:w-2 after:bg-[#d9fdd3] after:[clip-path:polygon(0_0,100%_0,0_100%)]"
            >
              <span className="whitespace-pre-line">{messageBody}</span>
              <p className="mt-3">
                {footerBefore}
                <bdi dir="ltr" className="text-[#027eb5] underline">
                  www.kaata.af
                </bdi>
                {footerAfter}
              </p>
              <div
                className="mt-1 flex items-center justify-end gap-[3px] text-[8px] leading-none text-[#667781]"
                dir="ltr"
              >
                <span>10:23</span>
                <ReadReceipt />
              </div>
            </div>

            <div
              dir={textDir(isRTL)}
              className="relative mr-auto mt-2 max-w-[82%] rounded-[7px] rounded-tl-none bg-white px-2 pb-1.5 pt-2 text-[12px] leading-[1.45] shadow-[0_1px_1px_rgba(11,20,26,0.12)] before:absolute before:-left-[6px] before:top-0 before:h-2 before:w-2 before:bg-white before:[clip-path:polygon(0_0,100%_0,100%_100%)]"
            >
              {t("mock.whatsapp.reply")}
              <div className="mt-1 text-right text-[8px] leading-none text-[#667781]" dir="ltr">
                10:31
              </div>
            </div>
          </div>

          <div className="relative mt-3 flex shrink-0 items-center gap-1.5 px-1.5 pb-2">
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-white px-2.5 text-[#667781] shadow-sm">
              <ChatIcon name="smile" className="h-[17px] w-[17px] shrink-0" />
              <span dir={textDir(isRTL)} className="min-w-0 flex-1 text-[11px]">
                {t("mock.whatsapp.messagePlaceholder")}
              </span>
              <ChatIcon name="attachment" className="h-4 w-4 shrink-0" />
              <ChatIcon name="camera" className="h-[17px] w-[17px] shrink-0" />
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#008069] text-white">
              <ChatIcon name="microphone" className="h-[18px] w-[18px]" />
            </div>
          </div>
          <div className="relative mx-auto mb-2.5 h-1 w-20 shrink-0 rounded-full bg-[#111b21]" />
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

function PreviewHeader({ title, shared = false }: { title: string; shared?: boolean }) {
  const { t, isRTL } = useI18n();
  const side = shared ? "w-16" : "w-8";
  return (
    <div
      className={`flex shrink-0 items-center gap-2 px-3 py-3 ${isRTL ? "flex-row-reverse" : ""}`}
    >
      <div className={`${side} shrink-0`} style={{ color: APP.emphasis }}>
        <ChevronDownIcon className={`h-4 w-4 ${isRTL ? "ml-auto -rotate-90" : "rotate-90"}`} />
      </div>
      <div
        className={`flex min-w-0 flex-1 items-center justify-center gap-1 ${isRTL ? "flex-row-reverse" : ""}`}
      >
        <span
          dir={textDir(isRTL)}
          className="truncate text-[14px] font-semibold"
          style={{ color: APP.emphasis }}
        >
          {title}
        </span>
        {shared ? (
          <span title={t("tab.join.title")} className="shrink-0">
            <SharedAccountIcon className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
      <div
        className={`${side} flex shrink-0 items-center justify-end gap-3 ${isRTL ? "flex-row-reverse" : ""}`}
        style={{ color: APP.emphasis }}
      >
        {shared ? (
          <>
            <WhatsAppGlyph className="h-4 w-4" />
            <MoreIcon className="h-[18px] w-[18px]" />
          </>
        ) : null}
      </div>
    </div>
  );
}

// An approval-mode shared account. Pending repayments stay outside the native
// financial headline and flow totals until reviewed (tabs/history.ts).
export function PhoneMockupShared() {
  const { t, isRTL } = useI18n();
  const isolate = (value: string) => `\u2066${value}\u2069`;
  const rows = [
    {
      amount: "500",
      gave: false,
      pending: true,
      open: false,
      note: t("mock.payment"),
      when: t("format.justNow"),
    },
    {
      amount: "1,250",
      gave: true,
      pending: false,
      open: true,
      note: t("mock.goods"),
      when: t("mock.shared.acceptedAt"),
    },
  ];
  return (
    <PhoneFrame label={t("mock.shared.preview.label")}>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <PreviewHeader title={t("mock.name.ahmad")} shared />
        <div
          className="mx-3 shrink-0 overflow-hidden rounded-[11px] border"
          style={BALANCE_SURFACE}
        >
          <div className="px-2.5 pb-2 pt-3">
            <div
              className={`flex items-center justify-between gap-2 ${isRTL ? "flex-row-reverse" : ""}`}
            >
              <div dir="ltr" className="flex items-baseline gap-1.5">
                <span
                  className="font-mono text-[25px] font-semibold leading-none"
                  style={{ color: APP.collect }}
                >
                  1,250
                </span>
                <span className="text-[9px]" style={{ color: APP.subtle }}>
                  {CURRENCY}
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
            <p
              className="mt-2 text-[8.5px] leading-relaxed"
              dir={textDir(isRTL)}
              style={{ color: APP.subtle }}
            >
              {t("tab.balance.confirmed", { amount: isolate("+1,250"), currency: isolate("AFN") })}
            </p>
            <p
              className="mt-0.5 text-[8.5px] leading-relaxed"
              dir={textDir(isRTL)}
              style={{ color: APP.subtle }}
            >
              {t("tab.balance.pending", {
                count: 1,
                amount: isolate("−500"),
                currency: isolate("AFN"),
              })}
            </p>
          </div>
          <div className="grid grid-cols-2 border-t" style={{ borderColor: APP.balanceBorder }}>
            {[
              { gave: false, count: 0, amount: "0" },
              { gave: true, count: 1, amount: "1,250" },
            ].map((flow) => (
              <div
                key={String(flow.gave)}
                className={`px-2.5 py-2 ${flow.gave ? "border-l" : ""}`}
                style={{ borderColor: APP.balanceBorder }}
              >
                <div className="flex items-center gap-1 text-[8px]" style={{ color: APP.subtle }}>
                  <DirectionArrow up={flow.gave} className="h-2.5 w-2.5 shrink-0" />
                  <span dir={textDir(isRTL)}>
                    {t(flow.gave ? "person.flows.gave" : "person.flows.received", {
                      count: flow.count,
                    })}
                  </span>
                </div>
                <p
                  className="mt-1 font-mono text-[12px] font-medium"
                  dir="ltr"
                  style={{ color: APP.emphasis }}
                >
                  {flow.amount}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div
          className="mx-3 mt-2.5 shrink-0 overflow-hidden rounded-[10px] border"
          style={{ borderColor: APP.border }}
        >
          {rows.map((row, index) => (
            <div
              key={row.amount}
              className={index ? "border-t" : ""}
              style={{ borderColor: APP.border, background: row.open ? APP.muted : APP.surface }}
            >
              {row.open ? (
                <div className="flex justify-center pt-2">
                  <span
                    className={`flex items-center gap-1 rounded-full border bg-white px-2 py-0.5 text-[8px] ${isRTL ? "flex-row-reverse" : ""}`}
                    style={{ borderColor: APP.border, color: APP.text }}
                  >
                    <span className="h-1 w-1 rounded-full bg-[#4B8660]" />
                    {t("tab.status.accepted")}
                  </span>
                </div>
              ) : null}
              <div className={`flex gap-2 px-2.5 py-2 ${isRTL ? "flex-row-reverse" : ""}`}>
                <div
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{
                    background: row.gave ? APP.payBg : APP.collectBg,
                    color: row.gave ? APP.pay : APP.collect,
                  }}
                >
                  <DirectionArrow up={row.gave} className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`flex items-baseline justify-between gap-1 ${isRTL ? "flex-row-reverse" : ""}`}
                  >
                    <span
                      dir="ltr"
                      className="shrink-0 font-mono text-[11px] font-semibold"
                      style={{ color: APP.emphasis }}
                    >
                      {row.amount}{" "}
                      <span className="font-sans text-[8px]" style={{ color: APP.faint }}>
                        AFN
                      </span>
                    </span>
                    <div
                      className={`flex min-w-0 flex-1 items-center justify-end gap-1 ${isRTL ? "flex-row-reverse" : ""}`}
                    >
                      {row.pending ? (
                        <span
                          className="h-1 w-1 shrink-0 rounded-full bg-[#D29A00]"
                          title={t("tab.status.pending")}
                        />
                      ) : null}
                      <span
                        dir={textDir(isRTL)}
                        className="min-w-0 truncate text-[8px]"
                        style={{ color: APP.subtle }}
                      >
                        {row.when}
                      </span>
                    </div>
                  </div>
                  <p dir={textDir(isRTL)} className="mt-1 text-[9px]" style={{ color: APP.subtle }}>
                    {row.note}
                  </p>
                  {row.open ? (
                    <div
                      className="mt-1 space-y-0.5 text-[8px] leading-relaxed"
                      dir={textDir(isRTL)}
                      style={{ color: APP.subtle }}
                    >
                      <p>
                        {t("tab.addedBy", {
                          name: t("entry.by.self", { name: t("mock.self.name") }),
                        })}
                      </p>
                      <p>
                        {t("tab.reviewedBy", { name: t("mock.name.ahmad") })} ·{" "}
                        {t("mock.shared.acceptedAt")}
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
              {row.pending ? (
                <div
                  className={`flex justify-end gap-1.5 px-2.5 pb-2 ${isRTL ? "flex-row-reverse" : ""}`}
                >
                  {[false, true].map((accept) => (
                    <div
                      key={String(accept)}
                      className={`flex min-h-6 items-center gap-1 rounded-full border px-2 text-[9px] font-medium ${isRTL ? "flex-row-reverse" : ""}`}
                      style={{
                        borderColor: accept ? APP.action : APP.border,
                        background: accept ? APP.action : APP.surface,
                        color: accept ? APP.surface : APP.text,
                      }}
                    >
                      <NoticeIcon kind={accept ? "accepted" : "voided"} className="h-2.5 w-2.5" />
                      <span dir={textDir(isRTL)}>{t(accept ? "tab.accept" : "tab.reject")}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-auto shrink-0 pt-3">
          <EntryDock />
          <div className="mx-auto mb-2.5 mt-3 h-1 w-20 rounded-full bg-neutral-900" />
        </div>
      </div>
    </PhoneFrame>
  );
}

// Full inbox, with the same flat rows and quiet unread treatment as
// components/NotificationInbox.tsx. Messages mirror the server templates.
export function PhoneMockupNotifications() {
  const { t, isRTL } = useI18n();
  const isolate = (value: string) => `\u2068${value}\u2069`;
  const notices = [
    {
      kind: "added" as const,
      unread: true,
      body: t("mock.notification.added", {
        name: isolate(t("mock.name.ahmad")),
        amount: `\u2066−500 AFN\u2069`,
      }),
      when: t("format.minutesAgo", { n: 2 }),
    },
    {
      kind: "accepted" as const,
      unread: true,
      body: t("mock.notification.accepted", {
        name: isolate(t("mock.name.ahmad")),
        amount: `\u2066+1250 AFN\u2069`,
      }),
      when: t("format.minutesAgo", { n: 18 }),
    },
    {
      kind: "voided" as const,
      unread: false,
      body: t("mock.notification.voided", {
        name: isolate(t("mock.name.mahmood")),
        amount: `\u2066−200 AFN\u2069`,
      }),
      when: t("format.yesterday"),
    },
  ];
  return (
    <PhoneFrame label={t("mock.notifications.preview.label")}>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <PreviewHeader title={t("inbox.title")} />
        <div
          className={`flex min-h-10 shrink-0 items-center justify-end px-3 ${isRTL ? "flex-row-reverse" : ""}`}
        >
          <span
            dir={textDir(isRTL)}
            className="text-[9px] font-medium"
            style={{ color: APP.emphasis }}
          >
            {t("inbox.markAll")}
          </span>
        </div>
        <div>
          {notices.map((notice) => (
            <div
              key={notice.kind}
              className={`flex items-start gap-2 border-t px-3 py-3 ${isRTL ? "flex-row-reverse" : ""}`}
              style={{
                background: notice.unread ? APP.muted : APP.surface,
                borderColor: "#EFEFEF",
              }}
            >
              <NoticeIcon
                kind={notice.kind}
                className="mt-0.5 h-4 w-4 shrink-0"
                style={{ color: APP.subtle }}
              />
              <div className="min-w-0 flex-1">
                <p
                  dir={textDir(isRTL)}
                  className="text-[11px] leading-relaxed"
                  style={{ color: APP.text }}
                >
                  {notice.body}
                </p>
                <p
                  dir={textDir(isRTL)}
                  className="mt-1 text-[9px] font-medium"
                  style={{ color: APP.subtle }}
                >
                  {notice.when}
                </p>
              </div>
              {notice.unread ? (
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[#2563EB]" />
              ) : null}
            </div>
          ))}
        </div>
        <div className="mx-auto mb-2.5 mt-auto h-1 w-20 shrink-0 rounded-full bg-neutral-900" />
      </div>
    </PhoneFrame>
  );
}

export function PhoneMockupOffline({
  label,
  showToast = true,
}: {
  label?: string;
  showToast?: boolean;
} = {}) {
  const { t, isRTL } = useI18n();
  const tallies = [
    { amount: "500", gave: false, when: t("mock.today"), note: t("mock.payment") },
    { amount: "750", gave: true, when: t("format.yesterday"), note: t("mock.supplies") },
    { amount: "1,000", gave: true, when: t("format.daysAgo", { n: 3 }), note: t("mock.goods") },
  ];
  return (
    <PhoneFrame label={label}>
      <div className="flex min-h-0 flex-1 flex-col" style={APP_FONT}>
        <div className={`flex items-center gap-2 px-3 py-3 ${isRTL ? "flex-row-reverse" : ""}`}>
          <div className="w-16 shrink-0" style={{ color: APP.emphasis }}>
            <ChevronDownIcon className={`h-4 w-4 ${isRTL ? "ml-auto -rotate-90" : "rotate-90"}`} />
          </div>
          <p
            dir={textDir(isRTL)}
            className="min-w-0 flex-1 text-center text-[14px] font-semibold"
            style={{ color: APP.emphasis }}
          >
            {t("mock.name.ahmad")}
          </p>
          <div
            className={`flex w-16 shrink-0 items-center justify-end gap-3 ${isRTL ? "flex-row-reverse" : ""}`}
            style={{ color: APP.emphasis }}
          >
            <WhatsAppGlyph className="h-4 w-4" />
            <MoreIcon className="h-[18px] w-[18px]" />
          </div>
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
                {CURRENCY}
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
                { gave: false, amount: "500", count: 1 },
                { gave: true, amount: "1,750", count: 2 },
              ] as const
            ).map((item) => (
              <div
                key={item.amount}
                className={`px-2.5 py-2 ${item.gave ? "border-l" : ""}`}
                style={{ borderColor: APP.balanceBorder }}
              >
                <div className="flex items-center gap-1" style={{ color: APP.subtle }}>
                  <DirectionArrow up={item.gave} className="h-2.5 w-2.5 shrink-0" />
                  <span dir={textDir(isRTL)}>
                    {t(item.gave ? "person.flows.gave" : "person.flows.received", {
                      count: item.count,
                    })}
                  </span>
                </div>
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
        <div className="mt-auto shrink-0 pt-3">
          <EntryDock />
          {showToast ? (
            <div className="pt-3 pb-2">
              <AppToast title={t("mock.entrySaved.title")} />
            </div>
          ) : null}
          <div className="mx-auto mb-2.5 h-1 w-20 rounded-full bg-neutral-900" />
        </div>
      </div>
    </PhoneFrame>
  );
}
