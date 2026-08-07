import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BACKEND_URL } from "../env";
import { useI18n } from "../lib/i18n";
import { ledger } from "../theme";

// /v/:token — the customer-facing shared ledger ("see the full ledger on
// kaata.af"). The shopkeeper's app POSTs a small snapshot to the backend and
// shares the link over WhatsApp; this React page fetches the full snapshot from
// GET /v1/shared/<token> and renders it as a quiet, statement-style page.
//
// Information hierarchy mirrors the backend SSR shell (internal/shared/
// templates.go): the SHOP is the letterhead, the balance is the hero, and the
// counterparty is a clearly-labelled "Account" line — so the two names never
// compete. In production it's the fallback: when the share link resolves to the
// backend SSR (for per-customer WhatsApp previews) the customer sees that
// instead; the two are kept visually in sync.

type SharedEntry = {
  type: "debt" | "payment";
  amount: number;
  note: string | null;
  date: number;
};

type SharedLedger = {
  v: number;
  shop: string;
  person: string;
  currency: string;
  balance: number;
  locale: string;
  entries: SharedEntry[];
  // Settled-chapter structure (2026-07-27, optional — old snapshots lack it):
  // entries dated <= settled_boundary_ms belong to settled (ruled-off)
  // chapters and render collapsed; settled_chapters is the trust-line count.
  settled_chapters?: number;
  settled_boundary_ms?: number | null;
  /** Every boundary (oldest→newest) — draws each dated ruled-off line in
   *  the expanded history. Absent on older snapshots. */
  settled_boundaries?: number[];
  generated_at: number;
};

type Phase = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: SharedLedger };

// Quiet-fintech palette: cool grays here, the semantic pair from the shared
// ledger palette (src/theme.ts). owe = you owe (a liability), credit = you're
// owed (an asset) — read from the viewer's side; a refined red/green pair, not
// the generic bright primaries.
const C = {
  bg: "#f9fafb",
  ink: "#101828",
  sub: "#475467",
  mut: "#98a2b3",
  line: "#eaecf0",
  hair: "#f2f4f7",
  owe: ledger.payStrong,
  oweBg: ledger.payBg,
  credit: ledger.collectStrong,
  creditBg: ledger.collectBg,
};

// Content language follows the SHOPKEEPER's locale (carried in the snapshot),
// not the viewer's browser — the message they're reading was composed in it.
const LABELS = {
  en: {
    owe: "owes",
    credit: "is owed",
    settled: "is settled",
    clearTitle: "All settled",
    clearBody: "nothing owed.",
    tx: "Transactions",
    empty: "No transactions yet.",
    error: "This shared ledger doesn’t exist.",
    debt: "I gave",
    payment: "I received",
    home: "Go to kaata.af",
    tag: "Powered by",
    wordmark: "kaata.",
    more: "more",
    less: "less",
    // The settled count lives HERE and only here (operator decision
    // 2026-07-27: the statement-card trust line came off entirely).
    settledShow: "View settled history ({n})",
    settledHide: "Hide settled history",
    settledOn: "Settled · {date}",
    // Bills are permanent (paper rule 2026-08-07): the issue date is
    // load-bearing — an old link must read as a dated bill, never as the
    // current balance.
    billDated: "Bill dated {date}",
  },
  fa: {
    owe: "بدهکار است",
    credit: "طلبکار است",
    settled: "تصفیه شده",
    clearTitle: "حساب صاف است",
    clearBody: "چیزی باقی نمانده.",
    tx: "معاملات",
    empty: "هنوز معامله‌ای نیست.",
    error: "این کاتای مشترک وجود ندارد.",
    debt: "دادم",
    payment: "گرفتم",
    home: "رفتن به kaata.af",
    // Deliberately English for Dari too — the translated "قدرت‌گرفته از"
    // reads clunky (operator decision 2026-07-27); the brand line stays
    // "Powered by kaata." in both languages.
    tag: "Powered by",
    wordmark: "kaata.",
    more: "بیشتر",
    less: "کمتر",
    settledShow: "دیدن سابقهٔ تصفیه‌شده ({n})",
    settledHide: "پنهان کردن سابقهٔ تصفیه‌شده",
    settledOn: "تصفیه شد · {date}",
    billDated: "بل مورخ {date}",
  },
} as const;

// Match the mobile app's typography: Vazirmatn for text (one face for Latin +
// Persian), JetBrains Mono for numbers. Both are bundled by the web app
// (Fontsource, see main.tsx); the SSR shell self-hosts them at /fonts/.
const APP_SANS = '"Vazirmatn","Inter",system-ui,-apple-system,sans-serif';
const MONO = '"JetBrains Mono","Vazirmatn",ui-monospace,Menlo,monospace';

// Direction arrows, mirroring the app's EntryRow: up = "I gave", down =
// "I received" (no +/− signs). They inherit currentColor, which the tinted
// row chip sets to red (gave / money out) or green (received / money in).
function ArrowUp() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="19" x2="12" y2="7" />
      <polyline points="6 13 12 7 18 13" />
    </svg>
  );
}
function ArrowDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="17" />
      <polyline points="18 11 12 17 6 11" />
    </svg>
  );
}

// One transaction row. The note and its "more"/"less" cue share a single line —
// the note truncates and the cue trails it — and the WHOLE row is tappable to
// expand a clipped note (matching the app's EntryRow and the SSR shell). Every
// row darkens on press for tactile feedback, just like the app's list rows, even
// when there's nothing to expand. Direction is carried by the arrow alone (the
// old "I gave/received" label is gone), exposed to screen readers via aria-label.
function Row({
  e,
  currency,
  rtl,
  L,
}: {
  e: SharedEntry;
  currency: string;
  rtl: boolean;
  L: ReturnType<typeof pickLabels>;
}) {
  const gave = e.type !== "payment"; // debt → "I gave" (up); payment → "I received" (down)
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  // Single-line truncation → overflow is horizontal; measure width, not height.
  useLayoutEffect(() => {
    const el = noteRef.current;
    if (el) setClipped(el.scrollWidth > el.clientWidth + 1);
  }, [e.note]);
  const interactive = clipped;
  const toggle = () => setOpen((v) => !v);
  return (
    <div
      className={
        // Every row darkens on press (active) for tactile feedback — parity with
        // the app's rows — whether or not it expands. hover + pointer only when
        // there's a clipped note to open. The --hair icon chip stays visible on
        // the lighter active tint.
        "flex items-center gap-3 border-b px-4 py-[13px] transition-colors last:border-b-0 active:bg-[#eaecf0]" +
        (interactive ? " cursor-pointer hover:bg-[#f9fafb]" : "")
      }
      style={{ borderColor: C.hair }}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? toggle : undefined}
      onKeyDown={
        interactive
          ? (ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                toggle();
              }
            }
          : undefined
      }
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        // Tinted chip carries direction (Khatabook flow): "I gave" = value out
        // → owe side; "I received" = value in → credit side. Same axis as the
        // balance, so one color always means "money toward you".
        style={
          gave ? { background: C.oweBg, color: C.owe } : { background: C.creditBg, color: C.credit }
        }
        role="img"
        aria-label={gave ? L.debt : L.payment}
      >
        {gave ? <ArrowUp /> : <ArrowDown />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex items-baseline gap-1">
            {/* Bold (not semibold) — the amount is the row's anchor. */}
            <span
              className="text-[15px] font-bold tabular-nums"
              style={{ color: C.ink, fontFamily: MONO }}
            >
              {fmtAmount(e.amount, rtl)}
            </span>
            <span className="text-[11px] font-medium" style={{ color: C.mut }}>
              {currency}
            </span>
          </p>
          {/* Date only — the arrow carries direction. */}
          <p className="shrink-0 whitespace-nowrap text-[12px]" style={{ color: C.mut }}>
            {fmtDate(e.date, rtl)}
          </p>
        </div>
        {e.note ? (
          <div className="mt-[5px] flex items-baseline gap-1.5">
            <p
              ref={noteRef}
              className={
                "min-w-0 flex-1 text-[13px] leading-[18px]" +
                (open ? " whitespace-normal break-words" : " truncate")
              }
              style={{ color: C.sub }}
            >
              {e.note}
              {/* Expanded: the "less" cue flows INLINE at the end of the wrapped
                  text (inside the same <p>), so it trails the last word instead
                  of floating in a baseline-aligned column to the right of line 1. */}
              {clipped && open ? (
                <span className="text-[12px] font-semibold" style={{ color: C.ink }}>
                  {" "}
                  {L.less}
                </span>
              ) : null}
            </p>
            {/* Collapsed: the note truncates to one line and the "more" cue
                trails it at the end of that line. */}
            {clipped && !open ? (
              <span className="shrink-0 text-[12px] font-semibold" style={{ color: C.ink }}>
                {L.more}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isRTL(locale: string) {
  return locale.startsWith("fa") || locale.startsWith("ps");
}

function pickLabels(locale: string) {
  return isRTL(locale) ? LABELS.fa : LABELS.en;
}

function fmtAmount(n: number, rtl: boolean): string {
  try {
    return Math.abs(n).toLocaleString(rtl ? "fa-AF" : undefined);
  } catch {
    return String(Math.abs(n));
  }
}

// Afghan (Dari) Solar Hijri month names — the zodiac set (حمل … حوت), NOT
// the Iranian set (فروردین …) that browsers ship for the fa locale and
// (incorrectly for Afghanistan) fall back to for fa-AF. Same calendar, same
// arithmetic — only the names differ, so we let ICU do the Persian-calendar
// conversion and substitute the vocabulary Afghans actually use.
const AFGHAN_MONTHS = [
  "حمل",
  "ثور",
  "جوزا",
  "سرطان",
  "اسد",
  "سنبله",
  "میزان",
  "عقرب",
  "قوس",
  "جدی",
  "دلو",
  "حوت",
];
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (v: number | string) => String(v).replace(/\d/g, (d) => FA_DIGITS[Number(d)]);

function fmtDate(ms: number, rtl: boolean): string {
  try {
    if (!rtl) {
      return new Date(ms).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
    // ASCII-digit parts from ICU's Persian-calendar conversion; the month
    // NUMBER indexes the Afghan name. e.g. "۵ اسد ۱۴۰۵".
    const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(new Date(ms));
    let y = "";
    let m = 0;
    let d = "";
    for (const p of parts) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = Number(p.value);
      else if (p.type === "day") d = p.value;
    }
    if (!y || !d || m < 1 || m > 12) throw new Error("persian calendar parts unavailable");
    return `${faDigits(d)} ${AFGHAN_MONTHS[m - 1]} ${faDigits(y)}`;
  } catch {
    // Last resort: the old (Iranian-named) rendering beats no date at all.
    try {
      return new Date(ms).toLocaleDateString(rtl ? "fa-AF" : undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }
}

export function CustomerView() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // iOS Safari only fires :active on an element if some ancestor has a touch
  // listener; this empty one lets every row show its tap-darken on iOS (Android
  // applies :active on tap regardless). Harmless on desktop.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhase({ kind: "error" });
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/v1/shared/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error("not ok");
        const data = (await res.json()) as SharedLedger;
        if (!cancelled) setPhase({ kind: "ready", data });
      } catch {
        if (!cancelled) setPhase({ kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="min-h-screen" style={{ background: C.bg, color: C.ink }}>
      <div className="mx-auto w-full max-w-[520px] px-[22px] pb-14 pt-10">
        {phase.kind === "loading" ? (
          <LedgerSkeleton />
        ) : phase.kind === "error" ? (
          <LedgerError />
        ) : (
          <Ledger data={phase.data} />
        )}
      </div>
    </main>
  );
}

function Ledger({ data: d }: { data: SharedLedger }) {
  const rtl = isRTL(d.locale);
  const L = pickLabels(d.locale);
  const dir = d.balance > 0 ? "owe" : d.balance < 0 ? "credit" : "settled";
  const accent = dir === "owe" ? C.owe : dir === "credit" ? C.credit : C.ink;

  // Settled-chapter collapse: the customer sees the CURRENT account; ruled-off
  // history sits behind one quiet row — mirroring the app's person screen.
  // COHERENCE RULE (parity with mobile): the collapse only engages while the
  // current chapter's sum exactly explains the balance — otherwise the view
  // falls open rather than hide entries that account for the number shown.
  // (The payload caps at 100 entries, so a truncated snapshot also fails
  // coherence and falls open — never a silently wrong "current account".)
  const boundary = d.settled_boundary_ms ?? null;
  const chapters = d.settled_chapters ?? 0;
  const [showSettled, setShowSettled] = useState(false);
  const currentEntries = boundary == null ? d.entries : d.entries.filter((e) => e.date > boundary);
  const settledEntries = boundary == null ? [] : d.entries.filter((e) => e.date <= boundary);
  const chapterSum = currentEntries.reduce(
    (sum, e) => sum + (e.type === "payment" ? -e.amount : e.amount),
    0,
  );
  const coherent = chapterSum === d.balance;
  const collapsed = coherent && !showSettled;
  const shownEntries = collapsed ? currentEntries : d.entries;

  // Expanded history interleaves each dated ruled-off line at its
  // chronological position (entries arrive newest-first) — the visible
  // lines of a paper khata, not one continuous list. Adjacent markers
  // (concurrent double-settle artifact) collapse to one.
  type LedgerItem = { kind: "entry"; e: SharedEntry } | { kind: "marker"; ms: number };
  const allBoundaries =
    d.settled_boundaries && d.settled_boundaries.length > 0
      ? d.settled_boundaries
      : boundary != null
        ? [boundary]
        : [];
  let shownItems: LedgerItem[];
  if (collapsed || allBoundaries.length === 0) {
    shownItems = shownEntries.map((e) => ({ kind: "entry" as const, e }));
  } else {
    const desc = [...allBoundaries].sort((a, b) => b - a);
    shownItems = [];
    let bi = 0;
    for (const e of shownEntries) {
      while (bi < desc.length && desc[bi] >= e.date) {
        if (shownItems.length === 0 || shownItems[shownItems.length - 1].kind !== "marker") {
          shownItems.push({ kind: "marker", ms: desc[bi] });
        }
        bi += 1;
      }
      shownItems.push({ kind: "entry", e });
    }
  }

  return (
    <section dir={rtl ? "rtl" : "ltr"} lang={rtl ? "fa" : "en"} style={{ fontFamily: APP_SANS }}>
      {/* Statement card — the shop name is the centered header; the counterparty
          + balance read as a plain "<person> owes <amount>" statement below it. */}
      <div className="rounded-2xl border bg-white px-6 py-[26px]" style={{ borderColor: C.line }}>
        {d.shop ? (
          <p
            className="text-center text-[17px] font-bold tracking-[-0.01em]"
            style={{ color: C.ink }}
          >
            {d.shop}
          </p>
        ) : null}

        {/* Bill issue date — LOAD-BEARING under the paper rule (2026-08-07):
            links live forever, so a two-year-old bill must read as "bill
            dated X", never as the current balance. Outside the settled fork
            so both layouts carry it. Older snapshots lack generated_at → 0
            → hidden. Mirrors the SSR shell's .billdate pill. */}
        {d.generated_at > 0 ? (
          <div className="mt-3 flex justify-center">
            <span
              className="rounded-full border px-3 py-1 text-[12px] font-semibold"
              style={{ borderColor: C.line, background: C.bg, color: C.sub }}
            >
              {L.billDated.replace("{date}", fmtDate(d.generated_at, rtl))}
            </span>
          </div>
        ) : null}

        {dir === "settled" ? (
          // SUCCESS state (operator feedback 2026-07-27): a settled account
          // is an achievement, not an empty ledger — a big "0 ؋" reads as
          // vague/meaningless. Check mark + "all settled", no number.
          <div
            className="mt-[18px] flex flex-col items-center border-t pt-[22px] text-center"
            style={{ borderColor: C.line }}
          >
            <div
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{ background: C.creditBg, color: C.credit }}
            >
              <svg
                viewBox="0 0 24 24"
                width="26"
                height="26"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="mt-3 text-[19px] font-bold tracking-[-0.01em]" style={{ color: C.ink }}>
              {L.clearTitle}
            </p>
            <p className="mt-1 text-[13px]" style={{ color: C.sub }}>
              <span className="font-semibold" style={{ color: C.ink }}>
                {d.person}
              </span>{" "}
              — {L.clearBody}
            </p>
          </div>
        ) : (
          <div className="mt-[18px] border-t pt-[18px]" style={{ borderColor: C.line }}>
            <p className="text-[15px]" style={{ color: C.sub }}>
              <span className="font-semibold" style={{ color: C.ink }}>
                {d.person}
              </span>{" "}
              {L[dir]}
            </p>
            <p
              className="mt-2 flex items-baseline gap-[7px] text-[38px] font-semibold leading-none tracking-[-0.02em] tabular-nums"
              style={{ color: accent, fontFamily: MONO }}
            >
              {fmtAmount(d.balance, rtl)}
              <span
                className="text-[16px] font-medium"
                style={{ color: C.mut, fontFamily: APP_SANS }}
              >
                {d.currency}
              </span>
            </p>
          </div>
        )}
      </div>

      {/* Transaction history */}
      <div className="mb-3 mt-7 flex items-baseline justify-between px-1">
        <p
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: C.sub }}
        >
          {L.tx}
        </p>
        {shownEntries.length > 0 ? (
          <p
            className="text-[11px] font-medium tabular-nums"
            style={{ color: C.mut, fontFamily: MONO }}
          >
            {fmtAmount(shownEntries.length, rtl)}
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: C.line }}>
        {shownEntries.length === 0 ? (
          // Fresh page right after settling: the statement card already says
          // "all settled" — repeating anything here is clutter. The card
          // holds just the history toggle; the plain empty line only shows
          // for a genuinely never-used ledger.
          chapters > 0 ? null : (
            <p className="p-7 text-center text-sm" style={{ color: C.mut }}>
              {L.empty}
            </p>
          )
        ) : (
          shownItems.map((item, i) =>
            item.kind === "marker" ? (
              <div
                key={`m-${item.ms}-${i}`}
                className="flex items-center gap-2.5 border-b px-4 py-[11px]"
                style={{ borderColor: C.hair, background: C.bg }}
              >
                <div className="h-px flex-1" style={{ background: C.mut, opacity: 0.4 }} />
                <span className="text-[11px] font-medium" style={{ color: C.sub }}>
                  {L.settledOn.replace("{date}", fmtDate(item.ms, rtl))}
                </span>
                <div className="h-px flex-1" style={{ background: C.mut, opacity: 0.4 }} />
              </div>
            ) : (
              <Row key={i} e={item.e} currency={d.currency} rtl={rtl} L={L} />
            ),
          )
        )}
        {/* Settled-history collapse row — only when there are ruled-off
            entries AND the collapse is coherent (else the list is forced
            open and the toggle hides). One quiet line, exactly like the app. */}
        {settledEntries.length > 0 && coherent ? (
          <button
            type="button"
            onClick={() => setShowSettled((v) => !v)}
            className={
              "w-full px-4 py-[13px] text-center text-[12px] font-medium transition-colors hover:bg-[#f9fafb] active:bg-[#eaecf0]" +
              (shownEntries.length > 0 ? " border-t" : "")
            }
            style={{ borderColor: C.hair, color: C.sub }}
          >
            {showSettled ? L.settledHide : L.settledShow.replace("{n}", fmtAmount(chapters, rtl))}
          </button>
        ) : null}
      </div>

      {/* Quiet footer — a single brand line, nothing more. dir="ltr": the
          line is all-English in BOTH locales, and inside the fa page's RTL
          paragraph the bidi algorithm snaps the wordmark's trailing "." to
          the left edge (".Powered by kaata" artifact). Forcing the line LTR
          keeps "kaata." intact; centered text, so alignment is unaffected. */}
      <p dir="ltr" className="mt-[26px] text-center text-[12px]" style={{ color: C.mut }}>
        {L.tag}{" "}
        <Link to="/" className="font-bold" style={{ color: C.sub }}>
          {L.wordmark}
        </Link>
      </p>
    </section>
  );
}

// Mirrors the ready layout (statement card + three rows) so the page doesn't
// reflow when data lands. `animate-pulse` gives the placeholders a soft shimmer.
function Bar({ className }: { className: string }) {
  return <div className={`rounded ${className}`} style={{ background: C.hair }} />;
}

function LedgerSkeleton() {
  return (
    <section aria-hidden="true" className="animate-pulse">
      <div className="rounded-2xl border bg-white px-6 py-[26px]" style={{ borderColor: C.line }}>
        <div className="flex justify-center">
          <Bar className="h-4 w-44" />
        </div>
        {/* bill-date pill */}
        <div className="mt-3 flex justify-center">
          <Bar className="h-6 w-36 rounded-full" />
        </div>
        <div className="mt-[18px] border-t pt-[18px]" style={{ borderColor: C.line }}>
          <Bar className="h-3 w-32" />
          <Bar className="mt-2.5 h-10 w-40" />
        </div>
      </div>
      <Bar className="mb-3 mt-7 h-2.5 w-24" />
      <div className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: C.line }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b px-4 py-[13px] last:border-b-0"
            style={{ borderColor: C.hair }}
          >
            <div className="h-8 w-8 shrink-0 rounded-lg" style={{ background: C.hair }} />
            <div className="flex min-w-0 flex-1 items-center justify-between">
              <Bar className="h-3.5 w-16" />
              <Bar className="h-2.5 w-28" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LedgerError() {
  // Unknown link — there's no snapshot to carry the shopkeeper's
  // locale, so fall back to the site language (browser-derived, toggleable).
  const { lang } = useI18n();
  const L = pickLabels(lang);
  return (
    <section className="px-2 py-20 text-center">
      <p style={{ color: C.sub }}>{L.error}</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-semibold hover:underline"
        style={{ color: C.ink }}
      >
        {L.home}
      </Link>
    </section>
  );
}
