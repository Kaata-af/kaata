import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Button } from "../../components/ui/button";
import type { WebProPlan } from "../../lib/web-pro";
import type { AdminProPayment } from "./admin-pro";
import type { BillingDocument } from "./admin-pro-invoices";
import "./AdminProDocument.css";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kabul",
});
const amountFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function billingDateLabel(date: string) {
  return dateFormat.format(new Date(date));
}

export function billingAmount(amount: number) {
  return `${amountFormat.format(amount / 100)} AFN`;
}

export function billingPlan(id: WebProPlan["id"]) {
  return id === "web_pro_monthly" ? "Monthly" : "Yearly";
}

export const billingMethod: Record<AdminProPayment["method"], string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  other: "Other",
  hesabpay: "HesabPay",
};

function DocumentField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DocumentPaper({ data }: { data: BillingDocument }) {
  const invoice = data.kind === "invoice" ? data.invoice : null;
  const doc = data.kind === "invoice" ? data.invoice : data.receipt;
  const payment = data.kind === "receipt" ? data.receipt.payment : null;
  const number =
    data.kind === "invoice" ? data.invoice.invoice_number : data.receipt.receipt_number;
  const status =
    invoice?.status === "void" ? "Void" : invoice?.status === "unpaid" ? "Unpaid" : "Paid";
  const line = data.kind === "invoice" ? data.invoice : data.receipt.payment;
  const paidDate = invoice?.paid_at ?? payment?.recorded_at;
  return (
    <article
      className="kaata-pro-document"
      aria-label={`${invoice ? "Invoice" : "Receipt"} ${number}`}
    >
      <header>
        <div>
          <strong>Kaata</strong>
          <p>kaata.af · hello@kaata.af</p>
        </div>
        <div>
          <span className="kaata-pro-document-state">{status}</span>
        </div>
      </header>
      <h2>{invoice ? "Kaata Pro invoice" : "Kaata Pro payment receipt"}</h2>
      <p className="kaata-pro-document-number">{number}</p>
      <dl>
        <DocumentField label={invoice ? "Bill to" : "Received from"}>
          <bdi>{doc.bill_to_name}</bdi>
          {doc.bill_to_email && (
            <>
              <br />
              <bdi>{doc.bill_to_email}</bdi>
            </>
          )}
        </DocumentField>
        <DocumentField label="Issued">{billingDateLabel(doc.issued_at)}</DocumentField>
        {invoice?.due_on && (
          <DocumentField label="Due date">{billingDateLabel(invoice.due_on)}</DocumentField>
        )}
        {paidDate && (
          <DocumentField label="Payment date">{billingDateLabel(paidDate)}</DocumentField>
        )}
        {payment && (
          <DocumentField label="Payment method">{billingMethod[payment.method]}</DocumentField>
        )}
        {payment?.reference && (
          <DocumentField label="Payment reference">
            <bdi>{payment.reference}</bdi>
          </DocumentField>
        )}
        {invoice?.voided_at && (
          <DocumentField label="Voided on">{billingDateLabel(invoice.voided_at)}</DocumentField>
        )}
      </dl>
      <table>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Kaata Pro · {billingPlan(line.plan_id)}</td>
            <td>{billingAmount(line.amount_minor)}</td>
          </tr>
        </tbody>
      </table>
      <p className="kaata-pro-document-total">
        {status === "Paid" ? "Amount paid" : "Amount due"}{" "}
        <strong>{billingAmount(status === "Void" ? 0 : line.amount_minor)}</strong>
      </p>
    </article>
  );
}

export function AdminProDocument({
  data,
  onClose,
}: {
  data: BillingDocument;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    const afterPrint = () => setPrinting(false);
    window.addEventListener("afterprint", afterPrint);
    return () => window.removeEventListener("afterprint", afterPrint);
  }, []);

  return (
    <>
      <dialog
        ref={dialog}
        aria-labelledby={heading}
        onClose={onClose}
        className="max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-[600px] overflow-auto rounded-xl border border-brand-border bg-white p-4 shadow-xl backdrop:bg-black/30 sm:p-6"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold text-brand-ink" id={heading}>
            {data.kind === "invoice" ? "Invoice preview" : "Receipt preview"}
          </h4>
          <Button type="button" variant="outline" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
        <DocumentPaper data={data} />
        <div className="mt-4 flex justify-end">
          <Button
            type="button"
            onClick={() => {
              flushSync(() => setPrinting(true));
              window.print();
            }}
          >
            Print / save PDF
          </Button>
        </div>
      </dialog>
      {printing &&
        createPortal(
          <div className="kaata-pro-print">
            <DocumentPaper data={data} />
          </div>,
          document.body,
        )}
    </>
  );
}
