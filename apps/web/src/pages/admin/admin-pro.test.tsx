import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminTokenContext, AuthError } from "./api";
import { AdminProPayments } from "./AdminProPayments";
import {
  AdminProPaymentError,
  adminProKey,
  getAdminProStatus,
  manualProReference,
  recordAdminProPayment,
  type AdminProPayment,
  type AdminProStatus,
  type ManualProPayment,
} from "./admin-pro";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const PAYMENT = "00000000-0000-4000-8000-000000000002";
const KEY = "synthetic-admin-key";
const EXPIRY = "2026-12-01T09:30:00Z";
const payload: ManualProPayment = {
  plan_id: "web_pro_monthly",
  method: "cash",
  reference: "Cash-1042",
};
const payment: AdminProPayment = {
  payment_id: PAYMENT,
  plan_id: payload.plan_id,
  amount_minor: 22550,
  currency: "AFN",
  method: payload.method,
  reference: "CASH-1042",
  recorded_at: "2026-11-01T09:30:00Z",
  subscription_expires_at: EXPIRY,
};
const status: AdminProStatus = {
  account_id: ACCOUNT,
  status: "active",
  subscription_expires_at: EXPIRY,
  paid_expires_at: EXPIRY,
  manual_grant: null,
  grant_history: [],
  grants_available: true,
  plans: [{ id: "web_pro_monthly", amount_minor: 22550, currency: "AFN", duration_months: 1 }],
  pending_checkout: true,
  payments: [payment],
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("account Pro details use the operator key and show confirmed expiry and payment history", async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/admin/users/${ACCOUNT}/pro`);
    assert.equal(url.search, "");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json(status);
  };
  const loaded = await getAdminProStatus(KEY, ACCOUNT);
  assert.deepEqual(loaded, status);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(adminProKey(KEY, ACCOUNT), loaded);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AdminTokenContext.Provider value={KEY}>
        <AdminProPayments accountID={ACCOUNT} accountName="Fixture user" />
      </AdminTokenContext.Provider>
    </QueryClientProvider>,
  );
  assert.match(html, /Active/);
  assert.match(html, /Access through Dec 1, 2026, 14:00 Kabul time/);
  assert.match(html, /A HesabPay payment is still unconfirmed/);
  assert.match(html, /225\.5 AFN/);
  assert.match(html, /CASH-1042/);
  assert.match(html, /Record offline payment/);
  assert.doesNotMatch(html, /Review offline payment|>Record payment</);
  client.clear();
});

test("old servers keep offline payments available while the grant API rolls out", async () => {
  globalThis.fetch = async () =>
    Response.json({
      account_id: ACCOUNT,
      status: "active",
      subscription_expires_at: EXPIRY,
      plans: status.plans,
      pending_checkout: false,
      payments: [],
    });
  const loaded = await getAdminProStatus(KEY, ACCOUNT);
  assert.equal(loaded.grants_available, false);
  assert.equal(loaded.paid_expires_at, EXPIRY);
});

test("an account cannot load another account's Pro state or use incomplete active data", async () => {
  globalThis.fetch = async () => Response.json({ ...status, account_id: PAYMENT });
  await assert.rejects(() => getAdminProStatus(KEY, ACCOUNT), /Invalid Pro details/);
  globalThis.fetch = async () => Response.json({ ...status, subscription_expires_at: null });
  await assert.rejects(() => getAdminProStatus(KEY, ACCOUNT), /Invalid Pro details/);
});

test("manual payments require a supported receipt and an account UUID before making a write", async () => {
  assert.equal(manualProReference(" Cash-1042 "), "Cash-1042");
  assert.equal(manualProReference("cash/2026.11_1042"), "cash/2026.11_1042");
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("Unexpected request");
  };
  for (const reference of ["", "A2", "REF 4", "CASH#123", "a".repeat(65)]) {
    await assert.rejects(
      () => recordAdminProPayment(KEY, ACCOUNT, { ...payload, reference }),
      (error: unknown) => error instanceof AdminProPaymentError && error.kind === "rejected",
    );
  }
  await assert.rejects(
    () => recordAdminProPayment(KEY, "../other-user", payload),
    AdminProPaymentError,
  );
  assert.equal(requests, 0);
});

test("a lost response is unconfirmed and the same explicit receipt retry accepts the original spelling", async () => {
  const writes: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, `/v1/admin/users/${ACCOUNT}/pro`);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${KEY}`);
    writes.push(String(init?.body));
    if (writes.length === 1) throw new TypeError("Response lost");
    return Response.json({ payment, subscription_expires_at: EXPIRY, duplicate: true });
  };
  await assert.rejects(
    () => recordAdminProPayment(KEY, ACCOUNT, payload),
    (error: unknown) => error instanceof AdminProPaymentError && error.kind === "unconfirmed",
  );
  assert.equal(writes.length, 1);
  const receipt = await recordAdminProPayment(KEY, ACCOUNT, payload);
  assert.equal(receipt.duplicate, true);
  assert.equal(receipt.payment.reference, "CASH-1042");
  assert.deepEqual(writes, [JSON.stringify(payload), JSON.stringify(payload)]);
});

test("a receipt conflict and an expired operator key remain distinct from an uncertain result", async () => {
  globalThis.fetch = async () =>
    Response.json({ error_code: "manual_payment_conflict" }, { status: 409 });
  await assert.rejects(
    () => recordAdminProPayment(KEY, ACCOUNT, payload),
    (error: unknown) => error instanceof AdminProPaymentError && error.kind === "conflict",
  );
  globalThis.fetch = async () => Response.json({}, { status: 401 });
  await assert.rejects(() => recordAdminProPayment(KEY, ACCOUNT, payload), AuthError);
  await assert.rejects(() => getAdminProStatus(KEY, ACCOUNT), AuthError);
});

test("a response confirming a different payment stays uncertain", async () => {
  globalThis.fetch = async () =>
    Response.json({
      payment: { ...payment, reference: "CASH-1043" },
      subscription_expires_at: EXPIRY,
      duplicate: false,
    });
  await assert.rejects(
    () => recordAdminProPayment(KEY, ACCOUNT, payload),
    (error: unknown) => error instanceof AdminProPaymentError && error.kind === "unconfirmed",
  );
});
