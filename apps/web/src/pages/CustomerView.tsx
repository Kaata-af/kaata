import { useEffect, useState } from "react";
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
    debt: "Credit",
    payment: "Payment",
    asOf: "As of",
    home: "Go to kaata.af",
    tag: "Powered by",
  },
  fa: {
    owe: "بدهکار است",
    credit: "طلبکار است",
    settled: "تسویه شده",
    tx: "معاملات",
    empty: "هنوز معامله‌ای نیست.",
    error: "این کاتای مشترک منقضی شده یا وجود ندارد.",
    debt: "خرید نسیه",
    payment: "پرداخت",
    asOf: "تا تاریخ",
    home: "رفتن به kaata.af",
    tag: "قدرت‌گرفته از",
  },
} as const;

// Vazirmatn (the mobile app's Persian face) is only wired to `html[lang="fa"]`
// in globals.css, but this page's content language is the SNAPSHOT's locale —
// independent of the viewer's site language. Apply the Persian stack inline so
// a Dari ledger always renders in Vazirmatn even on an English-chrome visit.
const PERSIAN_FONT = '"Vazirmatn","Inter",system-ui,-apple-system,sans-serif';

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

// First grapheme of the shop name, for the monogram brand mark. Spread to count
// by code point (Persian letters are BMP, so this is safe); uppercase is a no-op
// for Arabic-script letters.
function firstLetter(s: string): string {
  const first = [...s.trim()][0];
  return first ? first.toUpperCase() : "";
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
    <section
      dir={rtl ? "rtl" : "ltr"}
      lang={rtl ? "fa" : "en"}
      style={rtl ? { fontFamily: PERSIAN_FONT } : undefined}
    >
      {/* Statement card — the shop reads as a branded letterhead (monogram +
          name); the counterparty + balance read as a plain "<person> owes
          <amount>" statement, the hero of the page. */}
      <div className="rounded-2xl border bg-white px-6 py-[26px]" style={{ borderColor: C.line }}>
        {d.shop ? (
          <div className="flex items-center gap-[11px]">
            <div
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] text-base font-semibold uppercase leading-none text-white"
              style={{ background: C.ink }}
            >
              {firstLetter(d.shop)}
            </div>
            <p className="min-w-0 text-[15px] font-semibold tracking-[-0.01em]" style={{ color: C.ink }}>
              {d.shop}
            </p>
          </div>
        ) : null}

        <div className="mt-6">
          <p className="text-[15px]" style={{ color: C.sub }}>
            <span className="font-semibold" style={{ color: C.ink }}>
              {d.person}
            </span>{" "}
            {L[dir]}
          </p>
          <p
            className="mt-2 flex items-baseline gap-2 text-[40px] font-semibold leading-none tracking-[-0.025em] tabular-nums"
            style={{ color: accent }}
          >
            {fmtAmount(d.balance, rtl)}
            <span className="text-[17px] font-medium" style={{ color: C.mut }}>
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
          <p className="text-[11px] font-medium tabular-nums" style={{ color: C.mut }}>
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
            const isPayment = e.type === "payment";
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-3.5 border-b px-[18px] py-[15px] last:border-b-0"
                style={{ borderColor: C.hair }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium" style={{ color: C.ink }}>
                    {isPayment ? L.payment : L.debt}
                  </p>
                  {e.note ? (
                    <p className="mt-[3px] truncate text-[13px]" style={{ color: C.sub }}>
                      {e.note}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[12px] tabular-nums" style={{ color: C.mut }}>
                    {fmtDate(e.date, rtl)}
                  </p>
                </div>
                <p
                  className="whitespace-nowrap text-sm font-semibold tabular-nums tracking-[-0.01em]"
                  style={{ color: isPayment ? C.green : C.red }}
                >
                  {isPayment ? "−" : "+"}
                  {fmtAmount(e.amount, rtl)}
                </p>
              </div>
            );
          })
        )}
      </div>

      {/* Snapshot freshness — a point-in-time copy, so stamp when it was taken. */}
      <p className="mt-6 text-center text-[12px] tabular-nums" style={{ color: C.mut }}>
        {L.asOf} {fmtDate(d.generated_at, rtl)}
      </p>
      {/* Quiet footer — a single brand nudge line, nothing more. */}
      <p className="mt-[22px] text-center text-[12px]" style={{ color: C.mut }}>
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
        <div className="flex items-center gap-[11px]">
          <div className="h-[38px] w-[38px] shrink-0 rounded-[10px]" style={{ background: C.hair }} />
          <Bar className="h-4 w-44" />
        </div>
        <div className="mt-6">
          <Bar className="h-3 w-32" />
          <Bar className="mt-2.5 h-10 w-40" />
        </div>
      </div>
      <Bar className="mb-3 mt-7 h-2.5 w-24" />
      <div className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: C.line }}>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b px-[18px] py-[15px] last:border-b-0"
            style={{ borderColor: C.hair }}
          >
            <div className="space-y-2.5">
              <Bar className="h-3.5 w-20" />
              <Bar className="h-2.5 w-28" />
            </div>
            <Bar className="h-3.5 w-14" />
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
