import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminProDocument } from "./AdminProDocument";
import type { AdminProPayment } from "./admin-pro";
import {
  BillingWriteError,
  billingDate,
  listBillingPayments,
  listInvoices,
  runBillingOperation,
  type AdminInvoice,
  type AdminReceipt,
  type BillingDocument,
  type BillingOperation,
} from "./admin-pro-invoices";
import { AuthError } from "./api";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000002";
const INVOICE = "00000000-0000-4000-8000-000000000003";
const PAYMENT = "00000000-0000-4000-8000-000000000004";
const RECEIPT = "00000000-0000-4000-8000-000000000005";
const INVOICE_CODE = "KPRO-I-91A2B3C4D5E6F702A8B9";
const RECEIPT_CODE = "KPRO-R-FE0DB1AC2B3E4D5A6789";
const KEY = "test-operator-key";
const ISSUED = "2026-11-07T21:00:00Z";
const PAID = "2026-11-10T12:00:00Z";
const DUE = "2026-11-14";
const plan = {
  id: "web_pro_monthly",
  amount_minor: 20000,
  currency: "AFN",
  duration_months: 1,
} as const;
const open: AdminInvoice = {
  invoice_id: INVOICE,
  invoice_number: INVOICE_CODE,
  plan_id: plan.id,
  amount_minor: plan.amount_minor,
  currency: plan.currency,
  status: "unpaid",
  bill_to_name: "Fixture <b>Customer</b>",
  bill_to_email: "fixture@example.test",
  issued_at: ISSUED,
  due_on: DUE,
  payment_id: null,
  payment_source: null,
  paid_at: null,
  voided_at: null,
  void_reason: null,
};
const paid: AdminInvoice = {
  ...open,
  status: "paid",
  payment_id: PAYMENT,
  payment_source: "manual",
  paid_at: PAID,
};
const voided: AdminInvoice = {
  ...open,
  status: "void",
  voided_at: PAID,
  void_reason: "Duplicate billing request",
};
const manualPayment: AdminProPayment = {
  payment_id: PAYMENT,
  plan_id: plan.id,
  amount_minor: plan.amount_minor,
  currency: plan.currency,
  method: "cash",
  reference: "CASH-1042",
  recorded_at: PAID,
};
const providerPayment: AdminProPayment = {
  payment_id: PAYMENT,
  plan_id: plan.id,
  amount_minor: plan.amount_minor,
  currency: plan.currency,
  method: "hesabpay",
  recorded_at: PAID,
};
const receipt: AdminReceipt = {
  receipt_id: RECEIPT,
  receipt_number: RECEIPT_CODE,
  bill_to_name: open.bill_to_name,
  bill_to_email: open.bill_to_email,
  issued_at: PAID,
  payment: manualPayment,
};
const issue: BillingOperation = { kind: "issue", requestID: REQUEST, plan, dueOn: DUE };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("invoice issuance retries with the original request ID and reuses the returned invoice", async () => {
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/admin/users/${ACCOUNT}/pro/invoices`);
    assert.equal(url.search, "");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
    assert.equal(init?.method, "POST");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    writes.push(String(init?.body));
    if (writes.length === 1) throw new TypeError("Connection lost after save");
    return Response.json(open);
  };
  await assert.rejects(
    () => runBillingOperation(KEY, ACCOUNT, issue),
    (error: unknown) => error instanceof BillingWriteError && error.unconfirmed,
  );
  assert.deepEqual(await runBillingOperation(KEY, ACCOUNT, issue), {
    kind: "invoice",
    invoice: open,
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[0], writes[1]);
  assert.deepEqual(JSON.parse(writes[0]), { request_id: REQUEST, plan_id: plan.id, due_on: DUE });
});

test("receipt confirmation checks the payment source as well as its ID", async () => {
  let result = receipt;
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, `/v1/admin/users/${ACCOUNT}/pro/receipts`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      payment_id: PAYMENT,
      payment_source: "hesabpay",
    });
    return Response.json(result);
  };
  const operation = { kind: "receipt", payment: providerPayment } as const;
  await assert.rejects(
    () => runBillingOperation(KEY, ACCOUNT, operation),
    (error: unknown) => error instanceof BillingWriteError && error.unconfirmed,
  );
  result = { ...receipt, payment: providerPayment };
  assert.deepEqual(await runBillingOperation(KEY, ACCOUNT, operation), {
    kind: "receipt",
    receipt: result,
  });
});

test("linking an offline payment targets the invoice action and verifies the linked source", async () => {
  let result = paid;
  globalThis.fetch = async (input, init) => {
    assert.equal(
      new URL(String(input)).pathname,
      `/v1/admin/users/${ACCOUNT}/pro/invoices/${INVOICE}/apply-payment`,
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      payment_id: PAYMENT,
      payment_source: "manual",
    });
    return Response.json(result);
  };
  const apply = { kind: "apply", invoice: open, payment: manualPayment } as const;
  assert.deepEqual(await runBillingOperation(KEY, ACCOUNT, apply), {
    kind: "invoice",
    invoice: paid,
  });
  result = { ...paid, payment_source: "hesabpay" };
  await assert.rejects(
    () => runBillingOperation(KEY, ACCOUNT, apply),
    (error: unknown) => error instanceof BillingWriteError && error.unconfirmed,
  );
});

test("invoice lists preserve pagination and reject inconsistent status or dates", async () => {
  const signal = new AbortController().signal;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/admin/users/${ACCOUNT}/pro/invoices`);
    assert.equal(url.search, "?offset=20");
    return Response.json({ invoices: [open, paid, voided], next_offset: 23 });
  };
  assert.deepEqual(await listInvoices(KEY, ACCOUNT, 20, signal), {
    items: [open, paid, voided],
    next: 23,
  });
  globalThis.fetch = async () =>
    Response.json({ invoices: [{ ...paid, payment_id: null }], next_offset: null });
  await assert.rejects(() => listInvoices(KEY, ACCOUNT, 20, signal), /Invalid invoice status/);
  globalThis.fetch = async () => Response.json({ invoices: [open], next_offset: 20 });
  await assert.rejects(() => listInvoices(KEY, ACCOUNT, 20, signal), /Invalid billing list/);
  assert.equal(billingDate("2027-02-29"), false);
  assert.equal(billingDate("2028-02-29"), true);
});

test("payment listing identifies records already applied to an invoice", async () => {
  const linked = { ...manualPayment, linked_invoice_number: paid.invoice_number };
  globalThis.fetch = async (input) => {
    assert.equal(new URL(String(input)).pathname, `/v1/admin/users/${ACCOUNT}/pro/payments`);
    return Response.json({ payments: [linked, providerPayment], next_offset: null });
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await listBillingPayments(KEY, ACCOUNT, 0, signal), {
    items: [linked, providerPayment],
    next: null,
  });
});

test("billing documents reject legacy sequential numbers", async () => {
  globalThis.fetch = async () =>
    Response.json({ invoices: [{ ...open, invoice_number: "KPRO-I-000103" }], next_offset: null });
  const signal = new AbortController().signal;
  await assert.rejects(() => listInvoices(KEY, ACCOUNT, 0, signal), /Invalid invoice details/);

  globalThis.fetch = async () => Response.json({ ...receipt, receipt_number: "KPRO-R-000017" });
  await assert.rejects(
    () => runBillingOperation(KEY, ACCOUNT, { kind: "receipt", payment: manualPayment }),
    (error: unknown) => error instanceof BillingWriteError && error.unconfirmed,
  );
});

test("operator authentication errors and write conflicts stay distinct from an unconfirmed result", async () => {
  globalThis.fetch = async () => Response.json({}, { status: 409 });
  await assert.rejects(
    () => runBillingOperation(KEY, ACCOUNT, issue),
    (error: unknown) => error instanceof BillingWriteError && !error.unconfirmed,
  );
  globalThis.fetch = async () => Response.json({}, { status: 401 });
  await assert.rejects(() => runBillingOperation(KEY, ACCOUNT, issue), AuthError);
});

function preview(data: BillingDocument) {
  return renderToStaticMarkup(<AdminProDocument data={data} onClose={() => {}} />);
}

test("invoice previews distinguish an unpaid amount, a paid amount, and a void invoice", () => {
  const unpaidHTML = preview({ kind: "invoice", invoice: open });
  assert.match(unpaidHTML, /<dialog[^>]*aria-labelledby=/);
  assert.match(unpaidHTML, /Invoice preview/);
  assert.ok(unpaidHTML.includes(`aria-label="Invoice ${INVOICE_CODE}"`));
  assert.match(unpaidHTML, /Unpaid/);
  assert.match(unpaidHTML, /Amount due\s*<strong>200 AFN/);
  assert.match(unpaidHTML, /<dt>Issued<\/dt><dd>Nov 8, 2026/);
  assert.match(unpaidHTML, /<dt>Due date<\/dt><dd>Nov 14, 2026/);
  assert.match(unpaidHTML, /Fixture &lt;b&gt;Customer&lt;\/b&gt;/);
  assert.match(unpaidHTML, /Print \/ save PDF/);
  assert.doesNotMatch(unpaidHTML, /Payment date|kaata-pro-print/);

  const paidHTML = preview({ kind: "invoice", invoice: paid });
  assert.match(paidHTML, /Amount paid\s*<strong>200 AFN/);
  assert.match(paidHTML, /<dt>Payment date<\/dt><dd>Nov 10, 2026/);
  assert.doesNotMatch(paidHTML, /Amount due/);

  const voidHTML = preview({ kind: "invoice", invoice: voided });
  assert.match(voidHTML, />Void</);
  assert.match(voidHTML, /Amount due\s*<strong>0 AFN/);
  assert.match(voidHTML, /<dt>Voided on<\/dt><dd>Nov 10, 2026/);
  assert.doesNotMatch(voidHTML, /Amount paid/);
});

test("receipt previews show evidence of money received without an amount due", () => {
  const html = preview({ kind: "receipt", receipt });
  assert.match(html, /Receipt preview/);
  assert.ok(html.includes(`aria-label="Receipt ${RECEIPT_CODE}"`));
  assert.match(html, /<dt>Payment method<\/dt><dd>Cash/);
  assert.match(html, /<dt>Payment reference<\/dt><dd><bdi>CASH-1042/);
  assert.match(html, /Amount paid\s*<strong>200 AFN/);
  assert.doesNotMatch(html, /Amount due|Due date/);
});
