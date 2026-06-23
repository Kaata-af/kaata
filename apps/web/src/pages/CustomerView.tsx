import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { BACKEND_URL } from "../env";

// /v/:token — the customer-facing shared ledger ("see the full ledger on
// kaata.af"). The shopkeeper's app POSTs a small snapshot to the backend and
// shares kaata.af/v/<token> over WhatsApp; the backend SSRs a tiny preview shell
// (OG meta + summary) and this React page fetches the full snapshot from
// GET /v1/shared/<token> and renders the transaction list.

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
    settled: "Settled",
    tx: "Transactions",
    empty: "No transactions yet.",
    error: "This shared ledger has expired or doesn't exist.",
    debt: "Credit",
    payment: "Payment",
    foot: "See your ledger on",
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
    foot: "کاتای خود را ببینید در",
  },
} as const;

function pickLabels(locale: string) {
  return locale.startsWith("fa") || locale.startsWith("ps") ? LABELS.fa : LABELS.en;
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

  if (phase.kind === "loading") {
    return (
      <main>
        <SiteHeader />
        <section className="px-6 py-24 max-w-md mx-auto text-center text-neutral-500">…</section>
        <SiteFooter />
      </main>
    );
  }

  if (phase.kind === "error") {
    return (
      <main>
        <SiteHeader />
        <section className="px-6 py-24 max-w-md mx-auto text-center">
          <p className="text-neutral-600">{LABELS.en.error}</p>
          <Link to="/" className="mt-6 inline-block text-sm font-medium text-neutral-900">
            kaata.af
          </Link>
        </section>
        <SiteFooter />
      </main>
    );
  }

  const d = phase.data;
  const rtl = d.locale.startsWith("fa") || d.locale.startsWith("ps");
  const L = pickLabels(d.locale);
  const dir = d.balance > 0 ? "owe" : d.balance < 0 ? "credit" : "settled";
  const balColor =
    dir === "owe" ? "text-red-600" : dir === "credit" ? "text-green-600" : "text-neutral-900";

  return (
    <main dir={rtl ? "rtl" : "ltr"}>
      <SiteHeader />
      <section className="px-5 py-8 md:py-12 max-w-xl mx-auto">
        {d.shop ? <p className="text-sm text-neutral-500">{d.shop}</p> : null}

        <div className="mt-4 rounded-2xl border border-neutral-200 bg-white p-6">
          <p className="text-lg font-semibold text-neutral-900">{d.person}</p>
          <p className="mt-4 text-xs uppercase tracking-wide text-neutral-500">{L[dir]}</p>
          <p className={`mt-1 text-4xl font-bold ${balColor}`}>
            {fmtAmount(d.balance, rtl)}
            <span className="ms-1.5 text-lg font-semibold text-neutral-500">{d.currency}</span>
          </p>
        </div>

        <p className="mt-7 mb-2 px-1 text-xs uppercase tracking-wide text-neutral-500">{L.tx}</p>
        <div className="rounded-2xl border border-neutral-200 bg-white overflow-hidden">
          {d.entries.length === 0 ? (
            <p className="p-5 text-center text-sm text-neutral-500">{L.empty}</p>
          ) : (
            d.entries.map((e, i) => {
              const isPayment = e.type === "payment";
              return (
                <div
                  key={i}
                  className="flex items-center justify-between px-4 py-3.5 border-b border-neutral-100 last:border-b-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neutral-900">
                      {isPayment ? L.payment : L.debt}
                    </p>
                    {e.note ? (
                      <p className="text-sm text-neutral-500 truncate max-w-[60vw]">{e.note}</p>
                    ) : null}
                    <p className="text-[11px] text-neutral-400">{fmtDate(e.date, rtl)}</p>
                  </div>
                  <p
                    className={`ms-3 text-[15px] font-bold whitespace-nowrap ${
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

        <p className="mt-8 text-center text-sm text-neutral-500">
          {L.foot}{" "}
          <Link to="/" className="font-semibold text-neutral-900">
            kaata.af
          </Link>
        </p>
      </section>
      <SiteFooter />
    </main>
  );
}
