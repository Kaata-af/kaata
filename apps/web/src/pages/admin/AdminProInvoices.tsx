import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select-field";
import type { WebProPlan } from "../../lib/web-pro";
import { useAdminToken } from "./api";
import {
  AdminProDocument,
  billingAmount,
  billingDateLabel,
  billingMethod,
  billingPlan,
} from "./AdminProDocument";
import { adminProKey } from "./admin-pro";
import {
  BillingWriteError,
  billingDate,
  listBillingPayments,
  listInvoices,
  paymentSource,
  runBillingOperation,
  type AdminInvoice,
  type BillingDocument,
  type BillingOperation,
  type BillingPayment,
} from "./admin-pro-invoices";
import { ErrorCard } from "./ui";

type Editor =
  | { kind: "issue"; planID: string; dueOn: string }
  | { kind: "apply"; invoice: AdminInvoice; paymentKey: string }
  | { kind: "void"; invoice: AdminInvoice; reason: string };

const STATE_LABELS = { unpaid: "Unpaid", paid: "Paid", void: "Void" } as const;
const LABEL = "block min-w-0 space-y-1.5 text-xs font-medium text-brand-ink";
const ACTION_CLASS = "h-8 px-2.5 text-xs";

function paymentKey(payment: BillingPayment) {
  return `${paymentSource(payment)}:${payment.payment_id}`;
}

function PageButtons({
  offset,
  next,
  onPage,
}: {
  offset: number;
  next: number | null;
  onPage: (offset: number) => void;
}) {
  if (!offset && next === null) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {offset > 0 && (
        <Button
          type="button"
          variant="outline"
          className={ACTION_CLASS}
          onClick={() => onPage(Math.max(0, offset - 20))}
        >
          Newer
        </Button>
      )}
      {next !== null && (
        <Button
          type="button"
          variant="outline"
          className={ACTION_CLASS}
          onClick={() => onPage(next)}
        >
          Older
        </Button>
      )}
    </div>
  );
}

export function AdminProInvoices({
  accountID,
  accountName,
  plans,
}: {
  accountID: string;
  accountName: string;
  plans: WebProPlan[];
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
      className="rounded-lg border border-brand-border"
    >
      <summary className="cursor-pointer rounded-lg px-3 py-2.5 text-xs font-semibold text-brand-ink focus-visible:outline-brand-sub">
        Invoices and receipts
      </summary>
      {opened && <BillingPanel accountID={accountID} accountName={accountName} plans={plans} />}
    </details>
  );
}

function BillingPanel({
  accountID,
  accountName,
  plans,
}: {
  accountID: string;
  accountName: string;
  plans: WebProPlan[];
}) {
  const token = useAdminToken();
  const client = useQueryClient();
  const rootKey = [...adminProKey(token, accountID), "documents"];
  const mutationKey = [...rootKey, "write"];
  const [invoiceOffset, setInvoiceOffset] = useState(0);
  const [paymentOffset, setPaymentOffset] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [attempt, setAttempt] = useState<BillingOperation | null>(null);
  const [document, setDocument] = useState<BillingDocument | null>(null);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");
  const planField = useId();
  const paymentField = useId();
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const editorKind = editor?.kind;
  useEffect(() => {
    if (editorKind) editorHeading.current?.focus();
  }, [editorKind]);
  const invoices = useQuery({
    queryKey: [...rootKey, "invoices", invoiceOffset],
    queryFn: ({ signal }) => listInvoices(token, accountID, invoiceOffset, signal),
    enabled: !!token,
    retry: false,
  });
  const payments = useQuery({
    queryKey: [...rootKey, "payments", paymentOffset],
    queryFn: ({ signal }) => listBillingPayments(token, accountID, paymentOffset, signal),
    enabled: !!token,
    retry: false,
  });
  const busy = useIsMutating({ mutationKey, exact: true }) > 0;
  const save = useMutation({
    mutationKey,
    mutationFn: (operation: BillingOperation) => runBillingOperation(token, accountID, operation),
    retry: false,
    onSuccess: (result, operation) => {
      setAttempt(null);
      setEditor(null);
      if (result.kind === "receipt" || operation.kind === "issue") setDocument(result);
      if (operation.kind === "issue") setInvoiceOffset(0);
      if (result.kind === "invoice") {
        const label = result.invoice.invoice_number;
        setNotice(
          operation.kind === "apply"
            ? `Payment applied to ${label}.`
            : operation.kind === "void"
              ? `${label} was voided.`
              : `${label} was issued.`,
        );
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: rootKey }),
  });
  const uncertain = save.error instanceof BillingWriteError && save.error.unconfirmed;
  const locked = busy || uncertain;
  const availablePayments =
    editor?.kind === "apply"
      ? (payments.data?.items ?? []).filter(
          (item) =>
            item.plan_id === editor.invoice.plan_id &&
            item.amount_minor === editor.invoice.amount_minor &&
            item.currency === editor.invoice.currency &&
            !item.linked_invoice_number,
        )
      : [];

  function start(next: Editor | null) {
    save.reset();
    setAttempt(null);
    setEditor(next);
    setNotice("");
    setFormError("");
  }

  function run(operation: BillingOperation) {
    if (client.isMutating({ mutationKey, exact: true })) return;
    setAttempt(operation);
    setNotice("");
    save.mutate(operation);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || locked) return;
    setFormError("");
    switch (editor.kind) {
      case "issue": {
        const plan = plans.find((item) => item.id === editor.planID);
        if (!plan || (editor.dueOn && !billingDate(editor.dueOn))) {
          setFormError("Choose a plan and enter a valid due date.");
          return;
        }
        run({ kind: "issue", requestID: crypto.randomUUID(), plan, dueOn: editor.dueOn });
        break;
      }
      case "apply": {
        const payment = availablePayments.find((item) => paymentKey(item) === editor.paymentKey);
        if (!payment) {
          setFormError("Choose an available confirmed payment.");
          return;
        }
        run({ kind: "apply", invoice: editor.invoice, payment });
        break;
      }
      case "void": {
        const reason = editor.reason.trim();
        if (!reason) {
          setFormError("Enter a reason for voiding this invoice.");
          return;
        }
        run({ kind: "void", invoice: editor.invoice, reason });
        break;
      }
    }
  }

  const applyEditor = editor?.kind === "apply" ? editor : null;
  const currentPlan =
    editor?.kind === "issue" ? plans.find((plan) => plan.id === editor.planID) : null;
  function changePaymentPage(offset: number) {
    setPaymentOffset(offset);
    if (applyEditor) setEditor({ ...applyEditor, paymentKey: "" });
  }

  return (
    <div className="min-w-0 space-y-4 border-t border-brand-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-5 text-brand-muted">
          Issue an unpaid invoice or get a receipt for a confirmed payment.
        </p>
        {!editor && (
          <Button
            type="button"
            variant="outline"
            disabled={locked || !plans.length || !invoices.data}
            onClick={() => start({ kind: "issue", planID: "", dueOn: "" })}
          >
            New invoice
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {save.error && (
        <div className="space-y-2" role="alert">
          <p className="text-xs text-red-700">{save.error.message}</p>
          {uncertain && attempt && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => run(attempt)}>
              Retry same action
            </Button>
          )}
        </div>
      )}
      {editor && (
        <form
          onSubmit={submit}
          className="space-y-3 rounded-lg border border-brand-border bg-brand-ivory p-3"
        >
          <div className="space-y-1">
            <h5
              ref={editorHeading}
              tabIndex={-1}
              className="text-sm font-semibold text-brand-ink outline-none"
            >
              {editor.kind === "issue"
                ? "Issue invoice"
                : editor.kind === "apply"
                  ? `Apply payment to ${editor.invoice.invoice_number}`
                  : `Void ${editor.invoice.invoice_number}`}
            </h5>
            {editor.kind === "issue" ? (
              <p className="text-xs text-brand-muted">
                Bill to <bdi className="font-medium">{accountName}</bdi>
              </p>
            ) : (
              <p className="text-xs text-brand-muted">
                {billingPlan(editor.invoice.plan_id)} · {billingAmount(editor.invoice.amount_minor)}
              </p>
            )}
          </div>
          {editor.kind === "issue" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={LABEL}>
                <label htmlFor={planField}>Invoice plan</label>
                <SelectField
                  id={planField}
                  className="min-h-10 w-full"
                  required
                  disabled={locked}
                  placeholder="Choose a plan"
                  value={editor.planID}
                  onValueChange={(planID) => setEditor({ ...editor, planID })}
                  options={plans.map((plan) => ({
                    value: plan.id,
                    label: `${billingPlan(plan.id)} · ${billingAmount(plan.amount_minor)}`,
                  }))}
                />
              </div>
              <label className={LABEL}>
                <span>Due date (optional)</span>
                <Input
                  type="date"
                  disabled={locked}
                  value={editor.dueOn}
                  onChange={(event) => setEditor({ ...editor, dueOn: event.target.value })}
                />
              </label>
            </div>
          )}
          {applyEditor && (
            <div className="space-y-2">
              <div className={LABEL}>
                <label htmlFor={paymentField}>Confirmed payment</label>
                <SelectField
                  id={paymentField}
                  className="min-h-10 w-full"
                  required
                  disabled={locked || !availablePayments.length || payments.isError}
                  value={applyEditor.paymentKey}
                  placeholder={
                    availablePayments.length
                      ? "Choose a payment"
                      : "No matching payments on this page"
                  }
                  onValueChange={(selected) => setEditor({ ...applyEditor, paymentKey: selected })}
                  options={availablePayments.map((item) => ({
                    value: paymentKey(item),
                    label: `${billingMethod[item.method]} · ${billingDateLabel(item.recorded_at)} · ${item.reference ?? item.payment_id.slice(0, 8)}`,
                  }))}
                />
              </div>
              {payments.data && !locked && (
                <PageButtons
                  offset={paymentOffset}
                  next={payments.data.next}
                  onPage={changePaymentPage}
                />
              )}
              <p className="text-xs text-brand-muted">
                The selected payment has already been recorded and this action only marks the
                invoice paid.
              </p>
            </div>
          )}
          {editor.kind === "void" && (
            <label className={LABEL}>
              <span>Reason for voiding</span>
              <Input
                required
                maxLength={240}
                disabled={locked}
                value={editor.reason}
                onChange={(event) => setEditor({ ...editor, reason: event.target.value })}
              />
            </label>
          )}
          {formError && (
            <p className="text-xs text-red-700" role="alert">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={locked} onClick={() => start(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                locked ||
                (editor.kind === "issue" && !currentPlan) ||
                (editor.kind === "apply" &&
                  !availablePayments.some((item) => paymentKey(item) === editor.paymentKey))
              }
            >
              {editor.kind === "issue"
                ? "Issue unpaid invoice"
                : editor.kind === "apply"
                  ? "Apply payment"
                  : "Void invoice"}
            </Button>
          </div>
        </form>
      )}
      <div className="space-y-1">
        <h5 className="text-xs font-semibold text-brand-sub">Invoices</h5>
        {invoices.isPending && (
          <p role="status" className="text-xs text-brand-muted">
            Loading invoices…
          </p>
        )}
        {invoices.isError && (
          <ErrorCard message={invoices.error.message} onRetry={() => void invoices.refetch()} />
        )}
        {invoices.data && (
          <>
            {invoices.data.items.length === 0 && (
              <p className="text-xs text-brand-muted">No invoices on this page.</p>
            )}
            <ul className="divide-y divide-brand-faint">
              {invoices.data.items.map((invoice) => (
                <li
                  key={invoice.invoice_id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-brand-ink">
                      {invoice.invoice_number} · {STATE_LABELS[invoice.status]}
                    </p>
                    <p className="text-brand-muted">
                      {billingPlan(invoice.plan_id)} · {billingAmount(invoice.amount_minor)} ·{" "}
                      {billingDateLabel(invoice.issued_at)}
                    </p>
                    {invoice.void_reason && (
                      <p className="break-words text-brand-muted" dir="auto">
                        {invoice.void_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      className={ACTION_CLASS}
                      onClick={() => setDocument({ kind: "invoice", invoice })}
                    >
                      View invoice
                    </Button>
                    {invoice.status === "unpaid" && (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          className={ACTION_CLASS}
                          disabled={locked || !!editor || invoices.isError}
                          onClick={() => start({ kind: "apply", invoice, paymentKey: "" })}
                        >
                          Apply payment
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className={ACTION_CLASS}
                          disabled={locked || !!editor || invoices.isError}
                          onClick={() => start({ kind: "void", invoice, reason: "" })}
                        >
                          Void
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <PageButtons
              offset={invoiceOffset}
              next={invoices.data.next}
              onPage={setInvoiceOffset}
            />
          </>
        )}
      </div>
      <div className="space-y-1">
        <h5 className="text-xs font-semibold text-brand-sub">Payment receipts</h5>
        {payments.isPending && (
          <p role="status" className="text-xs text-brand-muted">
            Loading confirmed payments…
          </p>
        )}
        {payments.isError && (
          <ErrorCard message={payments.error.message} onRetry={() => void payments.refetch()} />
        )}
        {payments.data && (
          <>
            {payments.data.items.length === 0 && (
              <p className="text-xs text-brand-muted">No confirmed payments on this page.</p>
            )}
            <ul className="divide-y divide-brand-faint">
              {payments.data.items.map((payment) => (
                <li
                  key={paymentKey(payment)}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium text-brand-ink">
                      {billingMethod[payment.method]} · {billingAmount(payment.amount_minor)} ·{" "}
                      {billingDateLabel(payment.recorded_at)}
                    </p>
                    <p className="text-brand-muted">
                      {billingPlan(payment.plan_id)}
                      {payment.reference && (
                        <>
                          {" "}
                          · <bdi className="break-all">{payment.reference}</bdi>
                        </>
                      )}
                    </p>
                    {payment.linked_invoice_number && (
                      <p className="text-brand-muted">Applied to {payment.linked_invoice_number}</p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className={ACTION_CLASS}
                    disabled={locked || !!editor || payments.isError}
                    onClick={() => run({ kind: "receipt", payment })}
                  >
                    Get receipt
                  </Button>
                </li>
              ))}
            </ul>
            {!applyEditor && (
              <PageButtons
                offset={paymentOffset}
                next={payments.data.next}
                onPage={changePaymentPage}
              />
            )}
          </>
        )}
      </div>
      {document && <AdminProDocument data={document} onClose={() => setDocument(null)} />}
    </div>
  );
}
