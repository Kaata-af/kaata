import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BACKEND_URL } from "../env";

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
  generated_at: number;
};

type Phase = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: SharedLedger };

// Quiet-fintech palette (cool grays + muted semantic), matched to the SSR shell.
const C = {
  bg: "#f9fafb",
  ink: "#101828",
  sub: "#475467",
  mut: "#98a2b3",
  line: "#eaecf0",
  hair: "#f2f4f7",
  red: "#b42318",
  green: "#067647",
};

// Content language follows the SHOPKEEPER's locale (carried in the snapshot),
// not the viewer's browser — the message they're reading was composed in it.
const LABELS = {
  en: {
    owe: "owes",
    credit: "is owed",
    settled: "is settled",
    tx: "Transactions",
    empty: "No transactions yet.",
    error: "This shared ledger has expired or doesn’t exist.",
    debt: "I gave",
    payment: "I received",
    home: "Go to kaata.af",
    tag: "Powered by",
    more: "more",
    less: "less",
  },
  fa: {
    owe: "بدهکار است",
    credit: "طلبکار است",
    settled: "تسویه شده",
    tx: "معاملات",
    empty: "هنوز معامله‌ای نیست.",
    error: "این کاتای مشترک منقضی شده یا وجود ندارد.",
    debt: "دادم",
    payment: "گرفتم",
    home: "رفتن به kaata.af",
    tag: "قدرت‌گرفته از",
    more: "بیشتر",
    less: "کمتر",
  },
} as const;

// Match the mobile app's typography: Vazirmatn for text (one face for Latin +
// Persian), JetBrains Mono for numbers. Both are bundled by the web app
// (Fontsource, see main.tsx); the SSR shell self-hosts them at /fonts/.
const APP_SANS = '"Vazirmatn","Inter",system-ui,-apple-system,sans-serif';
const MONO = '"JetBrains Mono","Vazirmatn",ui-monospace,Menlo,monospace';

// Direction arrows, mirroring the app's EntryRow: up = "I gave", down =
// "I received" (no +/− signs, no colour — the arrow carries the direction).
function ArrowUp() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="7" />
      <polyline points="6 13 12 7 18 13" />
    </svg>
  );
}
function ArrowDown() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="17" />
      <polyline points="18 11 12 17 6 11" />
    </svg>
  );
}

// Note on its own line, clamped to 2 lines; a "more"/"less" toggle appears only
// when the text actually overflows (measured against the clamp, not guessed).
const CLAMP: CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};
function NoteLine({ text, more, less }: { text: string; more: string; less: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div className="mt-[3px]">
      <p ref={ref} className="text-[13px]" style={{ color: C.sub, ...(open ? {} : CLAMP) }}>
        {text}
      </p>
      {clipped ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-[3px] text-[12px] font-semibold"
          style={{ color: C.ink }}
        >
          {open ? less : more}
        </button>
      ) : null}
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

function fmtDate(ms: number, rtl: boolean): string {
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

export function CustomerView() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

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
  const accent = dir === "owe" ? C.red : dir === "credit" ? C.green : C.ink;

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
            <span className="text-[16px] font-medium" style={{ color: C.mut, fontFamily: APP_SANS }}>
              {d.currency}
            </span>
          </p>
        </div>
      </div>

      {/* Transaction history */}
      <div className="mb-3 mt-7 flex items-baseline justify-between px-1">
        <p
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: C.sub }}
        >
          {L.tx}
        </p>
        {d.entries.length > 0 ? (
          <p className="text-[11px] font-medium tabular-nums" style={{ color: C.mut, fontFamily: MONO }}>
            {fmtAmount(d.entries.length, rtl)}
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: C.line }}>
        {d.entries.length === 0 ? (
          <p className="p-7 text-center text-sm" style={{ color: C.mut }}>
            {L.empty}
          </p>
        ) : (
          d.entries.map((e, i) => {
            const gave = e.type !== "payment"; // debt → "I gave" (up); payment → "I received" (down)
            return (
              <div
                key={i}
                className="flex items-center gap-3 border-b px-4 py-[13px] last:border-b-0"
                style={{ borderColor: C.hair }}
              >
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: C.hair, color: C.sub }}
                >
                  {gave ? <ArrowUp /> : <ArrowDown />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="flex items-baseline gap-1">
                      <span
                        className="text-[15px] font-semibold tabular-nums"
                        style={{ color: C.ink, fontFamily: MONO }}
                      >
                        {fmtAmount(e.amount, rtl)}
                      </span>
                      <span className="text-[11px] font-medium" style={{ color: C.mut }}>
                        {d.currency}
                      </span>
                    </p>
                    <p className="flex shrink-0 items-center whitespace-nowrap text-[12px]">
                      <span className="font-medium" style={{ color: C.sub }}>
                        {gave ? L.debt : L.payment}
                      </span>
                      <span className="mx-[5px]" style={{ color: C.mut }}>
                        ·
                      </span>
                      <span style={{ color: C.mut }}>{fmtDate(e.date, rtl)}</span>
                    </p>
                  </div>
                  {e.note ? <NoteLine text={e.note} more={L.more} less={L.less} /> : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Quiet footer — a single brand line, nothing more. */}
      <p className="mt-[26px] text-center text-[12px]" style={{ color: C.mut }}>
        {L.tag}{" "}
        <Link to="/" className="font-bold" style={{ color: C.sub }}>
          kaata.
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
  return (
    <section className="px-2 py-20 text-center">
      <p style={{ color: C.sub }}>{LABELS.en.error}</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-semibold hover:underline"
        style={{ color: C.ink }}
      >
        {LABELS.en.home}
      </Link>
    </section>
  );
}
