import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import type { WebProPlan } from "../../lib/web-pro";
import { useAdminToken } from "./api";
import { AdminProGrants } from "./AdminProGrants";
import { AdminProInvoices } from "./AdminProInvoices";
import {
  AdminProPaymentError,
  adminProKey,
  getAdminProStatus,
  MANUAL_PAYMENT_METHODS,
  manualProReference,
  recordAdminProPayment,
  type AdminProPayment,
  type ManualPaymentMethod,
  type ManualProPayment,
} from "./admin-pro";
import { ErrorCard, fmtDateTime } from "./ui";

const METHOD_LABELS: Record<AdminProPayment["method"], string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  other: "Other",
  hesabpay: "HesabPay",
};
const AMOUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const LABEL = "block min-w-0 space-y-1.5 text-xs font-medium text-brand-ink";

type Draft = { planID: string; method: string; reference: string };
type Review = { plan: WebProPlan; payment: ManualProPayment };
const EMPTY: Draft = { planID: "", method: "", reference: "" };

function planLabel(id: WebProPlan["id"]) {
  return id === "web_pro_monthly" ? "Monthly" : "Yearly";
}

function amountLabel(amount: number, currency: string) {
  return `${AMOUNT.format(amount / 100)} ${currency}`;
}

function methodFrom(value: string): ManualPaymentMethod | undefined {
  return MANUAL_PAYMENT_METHODS.find((method) => method === value);
}

export function AdminProPayments({
  accountID,
  accountName,
  accountContact,
}: {
  accountID: string;
  accountName: string;
  accountContact?: string;
}) {
  const token = useAdminToken();
  const client = useQueryClient();
  const key = adminProKey(token, accountID);
  const mutationKey = [...key, "record-payment"];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getAdminProStatus(token, accountID, signal),
    enabled: !!token,
    retry: false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const planField = useId();
  const methodField = useId();
  const referenceHint = useId();
  const busy = useIsMutating({ mutationKey, exact: true }) > 0;
  const save = useMutation({
    mutationKey,
    mutationFn: (payment: ManualProPayment) => recordAdminProPayment(token, accountID, payment),
    retry: false,
    onSuccess: (result) => {
      const confirmation = result.duplicate ? "Receipt already recorded." : "Payment recorded.";
      setNotice(
        `${confirmation} Subscription expiry is ${fmtDateTime(result.subscription_expires_at)} Kabul time.`,
      );
      setDraft(null);
      setReview(null);
      setUncertain(false);
    },
    onError: (error) => {
      if (error instanceof AdminProPaymentError) {
        if (error.kind === "unconfirmed") setUncertain(true);
        if (error.kind === "conflict") setUncertain(false);
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  useEffect(() => {
    if (review) reviewHeading.current?.focus({ preventScroll: true });
  }, [review]);

  const data = query.data;
  const planChanged =
    !!review &&
    !!data &&
    !data.plans.some(
      (plan) =>
        plan.id === review.plan.id &&
        plan.amount_minor === review.plan.amount_minor &&
        plan.currency === review.plan.currency &&
        plan.duration_months === review.plan.duration_months,
    );
  const conflict = save.error instanceof AdminProPaymentError && save.error.kind === "conflict";
  const canRecord =
    !!review && !busy && !conflict && (uncertain || (!!data && !query.isError && !planChanged));

  function begin() {
    save.reset();
    setNotice("");
    setFormError("");
    setDraft(EMPTY);
  }

  function update(next: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setFormError("");
  }

  function reviewPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy || query.isError) return;
    const plan = data?.plans.find((item) => item.id === draft.planID);
    const method = methodFrom(draft.method);
    const reference = manualProReference(draft.reference);
    if (!plan || !method || !reference) {
      setFormError("Choose a plan and payment method and enter a valid receipt reference.");
      return;
    }
    save.reset();
    setFormError("");
    setReview({ plan, payment: { plan_id: plan.id, method, reference } });
  }

  function record() {
    // The desktop and mobile account details share the query and write lock.
    if (!review || !canRecord || client.isMutating({ mutationKey, exact: true })) return;
    save.mutate(review.payment);
  }

  return (
    <section
      aria-label="Kaata Pro"
      className="min-w-0 space-y-4 rounded-xl border border-brand-border bg-white p-4"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-brand-ink">Kaata Pro</h4>
          {data && (
            <p className="mt-1 text-xs leading-5 text-brand-muted">
              <span
                className={
                  data.status === "active"
                    ? "font-medium text-emerald-700"
                    : "font-medium text-brand-sub"
                }
              >
                {data.status === "active" ? "Active" : "Trial"}
              </span>
              {data.subscription_expires_at && (
                <>
                  {" "}
                  · {data.status === "active" ? "Access through" : "Last expiry"}{" "}
                  {fmtDateTime(data.subscription_expires_at)} Kabul time
                </>
              )}
            </p>
          )}
        </div>
        {data && !draft && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || query.isError || !data.plans.length}
            onClick={begin}
          >
            Record offline payment
          </Button>
        )}
      </div>
      {query.isPending && (
        <p role="status" className="text-xs text-brand-muted">
          Loading Pro details…
        </p>
      )}
      {query.isError && (
        <ErrorCard
          message={`Could not load Pro details. ${query.error.message}`}
          onRetry={() => void query.refetch()}
        />
      )}
      {data?.grants_available && (
        <AdminProGrants
          accountID={accountID}
          accountName={accountName}
          status={data}
          unavailable={query.isError}
        />
      )}
      {data?.pending_checkout && (
        <p role="status" className="rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-900">
          A HesabPay payment is still unconfirmed for this account. Check which payment the customer
          made before recording an offline receipt.
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs leading-5 text-emerald-700">
          {notice}
        </p>
      )}
      {review ? (
        <div className="space-y-3 rounded-lg border border-brand-border bg-brand-ivory p-3">
          <h5
            tabIndex={-1}
            ref={reviewHeading}
            className="text-sm font-semibold text-brand-ink outline-none"
          >
            Review offline payment
          </h5>
          <dl className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="font-medium text-brand-muted">Account</dt>
              <dd className="mt-1 break-words text-brand-ink" dir="auto">
                {accountName}
              </dd>
              {accountContact && accountContact !== accountName && (
                <dd className="mt-1 break-all text-brand-sub">
                  <bdi>{accountContact}</bdi>
                </dd>
              )}
              <dd className="mt-1 break-all text-brand-muted">
                <bdi>{accountID}</bdi>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-brand-muted">Plan</dt>
              <dd className="mt-1 text-brand-ink">
                {planLabel(review.plan.id)} ·{" "}
                {amountLabel(review.plan.amount_minor, review.plan.currency)}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-brand-muted">Payment method</dt>
              <dd className="mt-1 text-brand-ink">{METHOD_LABELS[review.payment.method]}</dd>
            </div>
            <div className="min-w-0">
              <dt className="font-medium text-brand-muted">Receipt reference</dt>
              <dd className="mt-1 break-all text-brand-ink">
                <bdi>{review.payment.reference}</bdi>
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-5 text-brand-sub">
            Record this only after receiving the payment.
          </p>
          {planChanged && !uncertain && (
            <p role="alert" className="text-xs text-amber-800">
              This plan changed. Go back and review the current price.
            </p>
          )}
          {save.error && (
            <p role="alert" className="text-xs leading-5 text-red-700">
              {save.error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!uncertain && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  save.reset();
                  setReview(null);
                }}
              >
                Back to edit
              </Button>
            )}
            <Button type="button" disabled={!canRecord} onClick={record}>
              {busy ? "Recording…" : uncertain ? "Retry same receipt" : "Record payment"}
            </Button>
          </div>
        </div>
      ) : draft && data ? (
        <form className="space-y-3" onSubmit={reviewPayment}>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className={LABEL}>
              <label htmlFor={planField}>Plan</label>
              <SelectField
                id={planField}
                className="min-h-10 w-full"
                required
                value={draft.planID}
                placeholder="Choose a plan"
                onValueChange={(planID) => update({ planID })}
                options={data.plans.map((plan) => ({
                  value: plan.id,
                  label: `${planLabel(plan.id)} · ${amountLabel(plan.amount_minor, plan.currency)}`,
                }))}
              />
            </div>
            <div className={LABEL}>
              <label htmlFor={methodField}>Payment method</label>
              <SelectField
                id={methodField}
                className="min-h-10 w-full"
                required
                value={draft.method}
                placeholder="Choose a method"
                onValueChange={(method) => update({ method })}
                options={MANUAL_PAYMENT_METHODS.map((method) => ({
                  value: method,
                  label: METHOD_LABELS[method],
                }))}
              />
            </div>
          </div>
          <label className={LABEL}>
            <span>Receipt reference</span>
            <Input
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={referenceHint}
              placeholder="CASH-1042"
              value={draft.reference}
              onChange={(event) => update({ reference: event.target.value })}
            />
          </label>
          <p id={referenceHint} className="text-xs leading-5 text-brand-muted">
            Use a unique reference of 3 to 64 letters, numbers, or . _ / - characters.
          </p>
          {formError && (
            <p role="alert" className="text-xs text-red-700">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || query.isError}>
              Review payment
            </Button>
          </div>
        </form>
      ) : null}
      {data && (
        <div>
          <h5 className="text-xs font-semibold text-brand-sub">Recent payments</h5>
          {data.payments.length ? (
            <ul className="mt-1 divide-y divide-brand-faint">
              {data.payments.map((payment) => (
                <li
                  key={payment.payment_id}
                  className="flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 py-2 text-xs leading-5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-brand-ink">
                      {planLabel(payment.plan_id)} ·{" "}
                      {amountLabel(payment.amount_minor, payment.currency)}
                    </p>
                    <p className="text-brand-muted">
                      {METHOD_LABELS[payment.method]}
                      {payment.reference && (
                        <>
                          {" "}
                          · <bdi className="break-all">{payment.reference}</bdi>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="text-brand-muted">
                    <p>{fmtDateTime(payment.recorded_at)} Kabul time</p>
                    {payment.subscription_expires_at && (
                      <p>Extended through {fmtDateTime(payment.subscription_expires_at)}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-brand-muted">No payments recorded.</p>
          )}
        </div>
      )}
      {data?.billing_documents_available && (
        <AdminProInvoices accountID={accountID} accountName={accountName} plans={data.plans} />
      )}
    </section>
  );
}
