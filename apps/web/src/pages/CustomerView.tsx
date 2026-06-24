import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BACKEND_URL } from "../env";

// /v/:token — the customer-facing shared ledger ("see the full ledger on
// kaata.af"). The shopkeeper's app POSTs a small snapshot to the backend and
// shares kaata.af/v/<token> over WhatsApp; this React page fetches the full
// snapshot from GET /v1/shared/<token> and renders the transaction list.
//
// This is a FOCUSED, single-purpose page — a slim brand bar instead of the full
// marketing chrome, so a customer opening a debt reminder sees the balance, not
// a nav. In production it's the fallback: when kaata.af/v/* is routed to the
// backend SSR shell (for per-customer WhatsApp previews) the customer sees that
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

// Content language follows the SHOPKEEPER's locale (carried in the snapshot),
// not the viewer's browser — the message they're reading was composed in it.
const LABELS = {
  en: {
    owe: "Balance to settle",
    credit: "In your favour",
    settled: "All settled",
    tx: "Transactions",
    empty: "No transactions yet.",
    error: "This shared ledger has expired or doesn’t exist.",
    debt: "Credit",
    payment: "Payment",
    asOf: "As of",
    home: "Go to kaata.af",
    tag: "Keep your own ledger, free with",
  },
  fa: {
    owe: "مانده برای تصفیه",
    credit: "به نفع شما",
    settled: "تصفیه شده",
    tx: "معاملات",
    empty: "هنوز معامله‌ای نیست.",
    error: "این کاتای مشترک منقضی شده یا وجود ندارد.",
    debt: "خرید نسیه",
    payment: "پرداخت",
    asOf: "تا تاریخ",
    home: "رفتن به kaata.af",
    tag: "حساب‌های خود را رایگان نگه دارید با",
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
    <main className="flex min-h-screen flex-col bg-neutral-50">
      <ShareBar />
      {phase.kind === "loading" ? (
        <LedgerSkeleton />
      ) : phase.kind === "error" ? (
        <LedgerError />
      ) : (
        <Ledger data={phase.data} />
      )}
    </main>
  );
}

// Slim brand bar — the focused-page chrome. Just the wordmark and a single
// "get the app" growth CTA; no marketing nav.
function ShareBar() {
  return (
    <header className="mx-auto flex h-14 w-full max-w-xl items-center justify-between px-5">
      <Link to="/" className="text-base font-extrabold tracking-tight text-neutral-900">
        kaata.
      </Link>
      <Link
        to="/download"
        className="rounded-lg bg-neutral-900 px-3 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800"
      >
        Get the app
      </Link>
    </header>
  );
}

function Ledger({ data: d }: { data: SharedLedger }) {
  const rtl = isRTL(d.locale);
  const L = pickLabels(d.locale);
  const dir = d.balance > 0 ? "owe" : d.balance < 0 ? "credit" : "settled";
  const balColor =
    dir === "owe" ? "text-red-600" : dir === "credit" ? "text-green-600" : "text-neutral-900";

  return (
    <section
      dir={rtl ? "rtl" : "ltr"}
      lang={rtl ? "fa" : "en"}
      style={rtl ? { fontFamily: PERSIAN_FONT } : undefined}
      className="mx-auto w-full max-w-xl flex-1 px-5 pb-12 pt-2"
    >
      {/* Hero — who + how much */}
      <div className="rounded-[18px] border border-neutral-200 bg-white p-6 shadow-sm">
        {d.shop ? <p className="text-[13px] font-medium text-neutral-500">{d.shop}</p> : null}
        <p className="mt-0.5 text-[21px] font-semibold tracking-tight text-neutral-900">
          {d.person}
        </p>

        <p className="mt-[22px] text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          {L[dir]}
        </p>
        <p className={`mt-1.5 flex items-baseline gap-2 ${balColor}`}>
          <span className="text-[42px] font-bold leading-none tracking-tight tabular-nums">
            {fmtAmount(d.balance, rtl)}
          </span>
          <span className="text-[19px] font-semibold text-neutral-400">{d.currency}</span>
        </p>
      </div>

      {/* Transaction history */}
      <div className="mb-2.5 mt-[26px] flex items-baseline justify-between px-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{L.tx}</p>
        {d.entries.length > 0 ? (
          <p className="text-[11px] font-medium tabular-nums text-neutral-400">
            {fmtAmount(d.entries.length, rtl)}
          </p>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-[18px] border border-neutral-200 bg-white">
        {d.entries.length === 0 ? (
          <p className="p-6 text-center text-sm text-neutral-500">{L.empty}</p>
        ) : (
          d.entries.map((e, i) => {
            const isPayment = e.type === "payment";
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3.5 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-neutral-900">
                    {isPayment ? L.payment : L.debt}
                  </p>
                  {e.note ? (
                    <p className="mt-0.5 truncate text-[13px] text-neutral-500">{e.note}</p>
                  ) : null}
                  <p className="mt-0.5 text-[11px] text-neutral-400">{fmtDate(e.date, rtl)}</p>
                </div>
                <p
                  className={`whitespace-nowrap text-[15px] font-bold tabular-nums ${
                    isPayment ? "text-green-600" : "text-red-600"
                  }`}
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
      <p className="mt-[22px] text-center text-[11px] text-neutral-400">
        {L.asOf} {fmtDate(d.generated_at, rtl)}
      </p>
      {/* Quiet growth nudge — replaces the old nonsensical "see your ledger on kaata.af". */}
      <Link
        to="/"
        className="mt-3.5 block text-center text-xs text-neutral-400 transition-colors hover:text-neutral-600"
      >
        {L.tag} <span className="font-extrabold text-neutral-500">kaata.</span>
      </Link>
    </section>
  );
}

// Mirrors the ready layout (hero card + four rows) so the page doesn't reflow
// when data lands. `animate-pulse` gives the placeholders a soft shimmer.
function LedgerSkeleton() {
  return (
    <section aria-hidden="true" className="mx-auto w-full max-w-xl flex-1 animate-pulse px-5 pb-12 pt-2">
      <div className="rounded-[18px] border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="h-3.5 w-24 rounded bg-neutral-100" />
        <div className="mt-2 h-5 w-40 rounded bg-neutral-100" />
        <div className="mt-7 h-2.5 w-28 rounded bg-neutral-100" />
        <div className="mt-2.5 h-10 w-48 rounded-lg bg-neutral-100" />
      </div>
      <div className="mb-2.5 mt-[26px] h-2.5 w-24 rounded bg-neutral-100" />
      <div className="overflow-hidden rounded-[18px] border border-neutral-200 bg-white">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-neutral-100 px-4 py-3.5 last:border-b-0"
          >
            <div className="space-y-2">
              <div className="h-3.5 w-20 rounded bg-neutral-100" />
              <div className="h-2.5 w-28 rounded bg-neutral-100" />
            </div>
            <div className="h-4 w-14 rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </section>
  );
}

function LedgerError() {
  return (
    <section className="mx-auto w-full max-w-md flex-1 px-6 py-24 text-center">
      <p className="text-neutral-600">{LABELS.en.error}</p>
      <Link
        to="/"
        className="mt-6 inline-block text-sm font-semibold text-neutral-900 hover:underline"
      >
        {LABELS.en.home}
      </Link>
    </section>
  );
}
