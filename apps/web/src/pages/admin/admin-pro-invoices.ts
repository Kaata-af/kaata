import type { WebProPlan } from "../../lib/web-pro";
import { AuthError } from "./api";
import { isAdminProPlanID, parseAdminProPayment, type AdminProPayment } from "./admin-pro";
import { ADMIN_PRO_UUID, adminProRequest, adminProTimestamp } from "./admin-pro-request";

export type PaymentSource = "manual" | "hesabpay";
export type BillingPayment = AdminProPayment & { linked_invoice_number?: string };

export type AdminInvoice = {
  invoice_id: string;
  invoice_number: string;
  plan_id: WebProPlan["id"];
  amount_minor: number;
  currency: "AFN";
  status: "unpaid" | "paid" | "void";
  bill_to_name: string;
  bill_to_email: string;
  issued_at: string;
  due_on: string | null;
  payment_id: string | null;
  payment_source: PaymentSource | null;
  paid_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
};

export type AdminReceipt = {
  receipt_id: string;
  receipt_number: string;
  bill_to_name: string;
  bill_to_email: string;
  issued_at: string;
  payment: AdminProPayment;
};

export type BillingOperation =
  | { kind: "issue"; requestID: string; plan: WebProPlan; dueOn: string }
  | { kind: "apply"; invoice: AdminInvoice; payment: AdminProPayment }
  | { kind: "void"; invoice: AdminInvoice; reason: string }
  | { kind: "receipt"; payment: AdminProPayment };

export type BillingDocument =
  | { kind: "invoice"; invoice: AdminInvoice }
  | { kind: "receipt"; receipt: AdminReceipt };

export class BillingWriteError extends Error {
  constructor(
    public readonly unconfirmed: boolean,
    message: string,
  ) {
    super(message);
    this.name = "BillingWriteError";
  }
}

const invoiceNumber = /^KPRO-I-[0-9A-F]{20}$/;
const receiptNumber = /^KPRO-R-[0-9A-F]{20}$/;
const unconfirmed = () =>
  new BillingWriteError(true, "Kaata could not confirm the result. Retry this same action.");

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid billing response.");
  return value as Record<string, unknown>;
}

function id(value: unknown): value is string {
  return typeof value === "string" && ADMIN_PRO_UUID.test(value);
}

export function billingDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

export function paymentSource(payment: AdminProPayment): PaymentSource {
  return payment.method === "hesabpay" ? "hesabpay" : "manual";
}

function billingIdentity(value: Record<string, unknown>) {
  return (
    typeof value.bill_to_name === "string" &&
    typeof value.bill_to_email === "string" &&
    adminProTimestamp(value.issued_at)
  );
}

function parseInvoice(input: unknown): AdminInvoice {
  const value = object(input);
  if (
    !billingIdentity(value) ||
    !id(value.invoice_id) ||
    typeof value.invoice_number !== "string" ||
    !invoiceNumber.test(value.invoice_number) ||
    !isAdminProPlanID(value.plan_id) ||
    typeof value.amount_minor !== "number" ||
    !Number.isSafeInteger(value.amount_minor) ||
    value.amount_minor <= 0 ||
    value.currency !== "AFN" ||
    (value.due_on !== null && !billingDate(value.due_on))
  )
    throw new Error("Invalid invoice details.");
  const linked =
    id(value.payment_id) &&
    (value.payment_source === "manual" || value.payment_source === "hesabpay") &&
    adminProTimestamp(value.paid_at);
  const unlinked =
    value.payment_id === null && value.payment_source === null && value.paid_at === null;
  const voided =
    adminProTimestamp(value.voided_at) &&
    typeof value.void_reason === "string" &&
    !!value.void_reason;
  const open = value.voided_at === null && value.void_reason === null;
  if (
    !(
      (value.status === "paid" && linked && open) ||
      (value.status === "unpaid" && unlinked && open) ||
      (value.status === "void" && unlinked && voided)
    )
  )
    throw new Error("Invalid invoice status.");
  return value as AdminInvoice;
}

function parseReceipt(input: unknown): AdminReceipt {
  const value = object(input);
  if (
    !billingIdentity(value) ||
    !id(value.receipt_id) ||
    typeof value.receipt_number !== "string" ||
    !receiptNumber.test(value.receipt_number)
  )
    throw new Error("Invalid receipt details.");
  return { ...value, payment: parseAdminProPayment(value.payment) } as AdminReceipt;
}

function parseBillingPayment(input: unknown): BillingPayment {
  const value = object(input);
  const payment = parseAdminProPayment(value);
  return typeof value.linked_invoice_number === "string" &&
    invoiceNumber.test(value.linked_invoice_number)
    ? { ...payment, linked_invoice_number: value.linked_invoice_number }
    : payment;
}

async function listPage<T>(
  token: string,
  accountID: string,
  resource: "invoices" | "payments",
  offset: number,
  signal: AbortSignal,
  parse: (value: unknown) => T,
) {
  const response = await adminProRequest(
    token,
    accountID,
    { signal },
    `/${resource}?offset=${offset}`,
  );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "Billing documents are unavailable for this account."
        : "Could not load billing records.",
    );
  const value = object(await response.json());
  const items = value[resource];
  const next = value.next_offset;
  if (
    !Array.isArray(items) ||
    items.length > 20 ||
    (next !== null &&
      (typeof next !== "number" ||
        !Number.isSafeInteger(next) ||
        next !== offset + items.length ||
        next <= offset))
  )
    throw new Error("Invalid billing list.");
  return { items: items.map(parse), next };
}

export const listInvoices = (
  token: string,
  accountID: string,
  offset: number,
  signal: AbortSignal,
) => listPage(token, accountID, "invoices", offset, signal, parseInvoice);
export const listBillingPayments = (
  token: string,
  accountID: string,
  offset: number,
  signal: AbortSignal,
) => listPage(token, accountID, "payments", offset, signal, parseBillingPayment);

function operationRequest(operation: BillingOperation) {
  switch (operation.kind) {
    case "issue":
      return {
        path: "/invoices",
        body: {
          request_id: operation.requestID,
          plan_id: operation.plan.id,
          ...(operation.dueOn ? { due_on: operation.dueOn } : {}),
        },
      };
    case "void":
      return {
        path: `/invoices/${operation.invoice.invoice_id}/void`,
        body: { reason: operation.reason },
      };
    case "apply":
      return {
        path: `/invoices/${operation.invoice.invoice_id}/apply-payment`,
        body: {
          payment_id: operation.payment.payment_id,
          payment_source: paymentSource(operation.payment),
        },
      };
    case "receipt":
      return {
        path: "/receipts",
        body: {
          payment_id: operation.payment.payment_id,
          payment_source: paymentSource(operation.payment),
        },
      };
  }
}

export async function runBillingOperation(
  token: string,
  accountID: string,
  operation: BillingOperation,
): Promise<BillingDocument> {
  const { path, body } = operationRequest(operation);
  let response: Response;
  try {
    response = await adminProRequest(
      token,
      accountID,
      { method: "POST", body: JSON.stringify(body) },
      path,
    );
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw unconfirmed();
  }
  if (response.status === 409)
    throw new BillingWriteError(
      false,
      "The billing record changed or this payment was already applied. Review the latest details.",
    );
  if ([400, 403, 404, 422, 429].includes(response.status))
    throw new BillingWriteError(
      false,
      "Kaata refused this action. Check the details and try again.",
    );
  if (!response.ok) throw unconfirmed();
  try {
    const value: unknown = await response.json();
    if (operation.kind === "receipt") {
      const receipt = parseReceipt(value);
      if (
        receipt.payment.payment_id !== operation.payment.payment_id ||
        paymentSource(receipt.payment) !== paymentSource(operation.payment)
      )
        throw new Error("Mismatched payment.");
      return { kind: "receipt", receipt };
    }
    const invoice = parseInvoice(value);
    if (
      operation.kind === "issue"
        ? invoice.plan_id !== operation.plan.id || invoice.due_on !== (operation.dueOn || null)
        : invoice.invoice_id !== operation.invoice.invoice_id
    )
      throw new Error("Mismatched invoice.");
    if (
      operation.kind === "apply" &&
      (invoice.status !== "paid" ||
        invoice.payment_id !== operation.payment.payment_id ||
        invoice.payment_source !== paymentSource(operation.payment))
    )
      throw new Error("Mismatched invoice payment.");
    if (operation.kind === "void" && invoice.status !== "void")
      throw new Error("Invoice still open.");
    return { kind: "invoice", invoice };
  } catch {
    throw unconfirmed();
  }
}
