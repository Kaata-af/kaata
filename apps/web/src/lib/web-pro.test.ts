import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { clearWebSession, createWebAuthNonce, signInWithGoogle, WebApiError } from "./web-auth";
import {
  createWebProCheckout,
  getWebProOrder,
  getWebProStatus,
  parseWebProStatus,
  validateWebProCheckoutURL,
  WEB_PRO_OFFERS,
  webProCanStartCheckout,
  webProReturnOrder,
  type WebProStatus,
} from "./web-pro";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const browser = Object.assign(new EventTarget(), {
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
const ORDER = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const CHECKOUT = "https://developers.hesab.com/checkout/session?token=sample%2Bsignature%3D";
const hosts = ["developers.hesab.com"];
function status(overrides: Partial<WebProStatus> = {}): WebProStatus {
  return {
    status: "trial",
    access: "trial_open",
    subscription_expires_at: null,
    checkout_ready: true,
    checkout_hosts: hosts,
    pending_order_id: null,
    plans: [...WEB_PRO_OFFERS],
    ...overrides,
  };
}
async function login(account = "fixture-account") {
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const claims = {
      account_id: account,
      install_id: body.install_id,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    return Response.json({
      account_id: account,
      default_vault_id: null,
      user: { has_password: false },
      session_jwt: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    });
  }) as typeof fetch;
  return signInWithGoogle("fixture-provider-token", createWebAuthNonce());
}
beforeEach(() => {
  clearWebSession();
  storage.clear();
});
after(() => {
  clearWebSession();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("trial status never requires payment and setup can be unavailable", () => {
  const trial = parseWebProStatus(status({ checkout_ready: false, checkout_hosts: [] }));
  assert.equal(trial.status, "trial");
  assert.equal(trial.access, "trial_open");
  assert.equal(trial.checkout_ready, false);
  assert.deepEqual(
    trial.plans.map((plan) => [plan.amount_minor, plan.duration_months]),
    [
      [20000, 1],
      [200000, 12],
    ],
  );
  assert.equal(
    parseWebProStatus(status({ status: "active", subscription_expires_at: "2027-01-01T00:00:00Z" }))
      .status,
    "active",
  );
});

test("malformed pricing or access responses cannot invent a paid entitlement", () => {
  for (const value of [
    status({ status: "active" }),
    { ...status(), access: "locked" },
    { ...status(), plans: [{ ...WEB_PRO_OFFERS[0], amount_minor: -1 }] },
    { ...status(), plans: [{ ...WEB_PRO_OFFERS[0], amount_minor: 1.01 }] },
    { ...status(), plans: [{ ...WEB_PRO_OFFERS[0], duration_months: 12 }] },
    { ...status(), plans: [WEB_PRO_OFFERS[0], WEB_PRO_OFFERS[0]] },
    { ...status(), checkout_hosts: ["https://developers.hesab.com"] },
    status({ checkout_hosts: [] }),
    status({ plans: [] }),
  ])
    assert.throws(() => parseWebProStatus(value));
});

test("checkout destination is exact-host HTTPS and signed URL encoding stays unchanged", () => {
  assert.equal(validateWebProCheckoutURL(CHECKOUT, hosts), CHECKOUT);
  for (const value of [
    "http://developers.hesab.com/checkout",
    "javascript:alert(1)",
    "//developers.hesab.com/checkout",
    "https://developers.hesab.com.evil.test/checkout",
    "https://evil.test/?next=developers.hesab.com",
    "https://user:secret@developers.hesab.com/checkout",
    "https://developers.hesab.com:8443/checkout",
    "https://developers.hesab.com/checkout#token",
    " https://developers.hesab.com/checkout",
  ])
    assert.throws(() => validateWebProCheckoutURL(value, hosts));
});

test("browser return only identifies an order and never trusts success flags", () => {
  assert.equal(webProReturnOrder(`?order=${ORDER}&success=true&status=paid`), ORDER);
  assert.equal(
    webProReturnOrder("?success=true&status=paid&data=%7B%22success%22%3Atrue%7D"),
    null,
  );
  assert.equal(webProReturnOrder("?order=../../other-account"), null);
});

test("unresolved returned payments cannot start another checkout", () => {
  assert.equal(webProCanStartCheckout(false, null), true);
  for (const value of [null, "creating", "pending", "expired"] as const)
    assert.equal(webProCanStartCheckout(true, value), false);
  assert.equal(webProCanStartCheckout(true, "paid"), true);
  assert.equal(webProCanStartCheckout(true, "failed"), true);
  assert.equal(webProCanStartCheckout(true, "pending", false, true, false), false);
  assert.equal(webProCanStartCheckout(true, "pending", false, false, true), false);
  assert.equal(
    webProCanStartCheckout(true, "pending", false, true, true),
    true,
    "only server permission plus explicit acknowledgement permits replacement",
  );
  assert.equal(
    webProCanStartCheckout(true, null, true),
    true,
    "authenticated order_not_found can release a forged or unrelated return link",
  );
});

test("checkout uses authenticated server pricing and preserves the request ID on retry", async () => {
  const session = await login();
  const requests: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.ok(String(url).endsWith("/v1/web-pro/checkout"));
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${session.session_jwt}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? Response.json({ code: "checkout_pending" }, { status: 503 })
      : Response.json({ order_id: ORDER, checkout_url: CHECKOUT });
  }) as typeof fetch;
  await assert.rejects(
    createWebProCheckout(session, WEB_PRO_OFFERS[0], REQUEST, hosts),
    WebApiError,
  );
  assert.equal(
    (await createWebProCheckout(session, WEB_PRO_OFFERS[0], REQUEST, hosts)).checkout_url,
    CHECKOUT,
  );
  assert.deepEqual(requests, [
    { plan_id: "web_pro_monthly", request_id: REQUEST },
    { plan_id: "web_pro_monthly", request_id: REQUEST },
  ]);
});

test("old accounts cannot prepare checkout or accept an in-flight billing response", async () => {
  const first = await login();
  const second = await login("second-account");
  let sent = false;
  globalThis.fetch = (async () => {
    sent = true;
    return Response.json({});
  }) as typeof fetch;
  await assert.rejects(createWebProCheckout(first, WEB_PRO_OFFERS[0], REQUEST, hosts));
  assert.equal(sent, false);
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as typeof fetch;
  const loading = getWebProStatus(second);
  await login("third-account");
  release!(
    Response.json(status({ status: "active", subscription_expires_at: "2027-01-01T00:00:00Z" })),
  );
  await assert.rejects(
    loading,
    (error: unknown) => error instanceof WebApiError && error.code === "session_expired",
  );
});

test("expired checkout replacement is explicitly scoped to the acknowledged order", async () => {
  const session = await login();
  globalThis.fetch = (async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      plan_id: "web_pro_monthly",
      request_id: REQUEST,
      replace_order_id: ORDER,
    });
    return Response.json({ order_id: REQUEST, checkout_url: CHECKOUT });
  }) as typeof fetch;
  await createWebProCheckout(session, WEB_PRO_OFFERS[0], REQUEST, hosts, undefined, ORDER);
  await assert.rejects(
    createWebProCheckout(session, WEB_PRO_OFFERS[0], REQUEST, hosts, undefined, "not-an-order"),
  );
});

test("order reconciliation reads the authenticated matching order and rejects substituted IDs", async () => {
  const session = await login();
  const order = {
    order_id: ORDER,
    plan_id: "web_pro_monthly",
    status: "paid",
    amount_minor: 20000,
    currency: "AFN",
    created_at: "2026-10-31T00:00:00Z",
    checkout_expires_at: "2026-10-31T00:15:00Z",
    can_start_new_checkout: false,
  };
  globalThis.fetch = (async (url) => {
    assert.ok(String(url).endsWith(`/v1/web-pro/orders/${ORDER}`));
    return Response.json(order);
  }) as typeof fetch;
  assert.equal((await getWebProOrder(session, ORDER)).status, "paid");
  globalThis.fetch = (async () => Response.json({ ...order, order_id: REQUEST })) as typeof fetch;
  await assert.rejects(getWebProOrder(session, ORDER));
});
