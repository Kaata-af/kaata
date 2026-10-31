import { getWebSession, webRequest, WebApiError, type WebSession } from "./web-auth";

export type WebProPlan = {
  id: "web_pro_monthly" | "web_pro_yearly";
  amount_minor: number;
  currency: "AFN";
  duration_months: 1 | 12;
};
export type WebProStatus = {
  status: "trial" | "active";
  access: "trial_open";
  subscription_expires_at: string | null;
  checkout_ready: boolean;
  checkout_hosts: string[];
  pending_order_id: string | null;
  plans: WebProPlan[];
};
export type WebProCheckout = { checkout_url: string; order_id: string };
export type WebProOrder = {
  order_id: string;
  plan_id: WebProPlan["id"];
  status: "creating" | "pending" | "paid" | "failed" | "expired";
  amount_minor: number;
  currency: "AFN";
  created_at: string;
  checkout_expires_at: string | null;
  checkout_url?: string;
  can_start_new_checkout: boolean;
};

// Display-only offers while the billing service loads. The server owns the
// actual amount and period used to create every checkout.
export const WEB_PRO_OFFERS: readonly WebProPlan[] = [
  { id: "web_pro_monthly", amount_minor: 20_000, currency: "AFN", duration_months: 1 },
  { id: "web_pro_yearly", amount_minor: 200_000, currency: "AFN", duration_months: 12 },
];

function invalid(): never {
  throw new WebApiError(
    "Subscription details could not be read. Try again.",
    502,
    "invalid_response",
  );
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function checkoutHost(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) &&
    value.includes(".") &&
    !value.includes("..") &&
    !value.endsWith(".")
  );
}
export function parseWebProStatus(input: unknown): WebProStatus {
  const value = record(input);
  if (
    !["trial", "active"].includes(String(value.status)) ||
    value.access !== "trial_open" ||
    typeof value.checkout_ready !== "boolean" ||
    !Array.isArray(value.checkout_hosts) ||
    value.checkout_hosts.length > 16 ||
    !value.checkout_hosts.every(checkoutHost) ||
    new Set(value.checkout_hosts).size !== value.checkout_hosts.length ||
    !Array.isArray(value.plans) ||
    value.plans.length > 2
  )
    invalid();
  if (
    value.subscription_expires_at !== null &&
    (typeof value.subscription_expires_at !== "string" ||
      !/^\d{4}-\d\d-\d\dT/.test(value.subscription_expires_at) ||
      !Number.isFinite(Date.parse(value.subscription_expires_at)))
  )
    invalid();
  if (value.status === "active" && value.subscription_expires_at === null) invalid();
  if (
    value.pending_order_id !== null &&
    value.pending_order_id !== undefined &&
    (typeof value.pending_order_id !== "string" ||
      webProReturnOrder(`?order=${encodeURIComponent(value.pending_order_id)}`) !==
        value.pending_order_id)
  )
    invalid();
  const plans = value.plans.map((item) => {
    const plan = record(item);
    if (
      !["web_pro_monthly", "web_pro_yearly"].includes(String(plan.id)) ||
      !Number.isSafeInteger(plan.amount_minor) ||
      (plan.amount_minor as number) <= 0 ||
      (plan.amount_minor as number) > 999_999_999 ||
      plan.currency !== "AFN" ||
      plan.duration_months !== (plan.id === "web_pro_monthly" ? 1 : 12)
    )
      invalid();
    return plan as WebProPlan;
  });
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length) invalid();
  if (value.checkout_ready && (!plans.length || !value.checkout_hosts.length)) invalid();
  return { ...value, plans, pending_order_id: value.pending_order_id ?? null } as WebProStatus;
}

/** Keep the provider's signed URL byte-for-byte after validating its destination. */
export function validateWebProCheckoutURL(value: unknown, allowedHosts: readonly string[]): string {
  if (typeof value !== "string" || value.length > 8192 || value.trim() !== value) invalid();
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !allowedHosts.includes(url.hostname) ||
      !allowedHosts.every(checkoutHost)
    )
      invalid();
    return value;
  } catch {
    invalid();
  }
}

function currentSession(session: WebSession) {
  const current = getWebSession();
  if (
    !current ||
    current.account_id !== session.account_id ||
    current.install_id !== session.install_id ||
    current.session_jwt !== session.session_jwt
  )
    throw new WebApiError(
      "Your session has changed. Open subscriptions again.",
      401,
      "session_expired",
    );
}

export async function getWebProStatus(
  session: WebSession,
  signal?: AbortSignal,
): Promise<WebProStatus> {
  currentSession(session);
  const result = await webRequest<unknown>("/v1/web-pro", { signal });
  currentSession(session);
  return parseWebProStatus(result);
}

export async function createWebProCheckout(
  session: WebSession,
  plan: WebProPlan,
  requestID: string,
  allowedHosts: readonly string[],
  signal?: AbortSignal,
  replaceOrderID?: string,
): Promise<WebProCheckout> {
  currentSession(session);
  if (
    !WEB_PRO_OFFERS.some((offer) => offer.id === plan.id) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestID) ||
    !allowedHosts.length ||
    !allowedHosts.every(checkoutHost)
  )
    invalid();
  if (
    replaceOrderID &&
    webProReturnOrder(`?order=${encodeURIComponent(replaceOrderID)}`) !== replaceOrderID
  )
    invalid();
  const result = record(
    await webRequest<unknown>("/v1/web-pro/checkout", {
      method: "POST",
      signal,
      body: JSON.stringify({
        plan_id: plan.id,
        request_id: requestID,
        ...(replaceOrderID ? { replace_order_id: replaceOrderID } : {}),
      }),
    }),
  );
  currentSession(session);
  if (
    typeof result.order_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.order_id)
  )
    invalid();
  return {
    order_id: result.order_id,
    checkout_url: validateWebProCheckoutURL(result.checkout_url, allowedHosts),
  };
}

export function webProReturnOrder(search: string): string | null {
  const order = new URLSearchParams(search).get("order");
  return order && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order)
    ? order
    : null;
}

export function webProCanStartCheckout(
  hasReturnOrder: boolean,
  orderStatus: WebProOrder["status"] | null,
  orderNotFound = false,
  replacementAllowed = false,
  replacementAcknowledged = false,
): boolean {
  return (
    !hasReturnOrder ||
    orderNotFound ||
    orderStatus === "paid" ||
    orderStatus === "failed" ||
    (replacementAllowed && replacementAcknowledged)
  );
}

export async function getWebProOrder(
  session: WebSession,
  orderID: string,
  signal?: AbortSignal,
): Promise<WebProOrder> {
  currentSession(session);
  if (webProReturnOrder(`?order=${encodeURIComponent(orderID)}`) !== orderID) invalid();
  const value = record(await webRequest<unknown>(`/v1/web-pro/orders/${orderID}`, { signal }));
  currentSession(session);
  if (
    value.order_id !== orderID ||
    !["web_pro_monthly", "web_pro_yearly"].includes(String(value.plan_id)) ||
    !["creating", "pending", "paid", "failed", "expired"].includes(String(value.status)) ||
    !Number.isSafeInteger(value.amount_minor) ||
    (value.amount_minor as number) <= 0 ||
    value.currency !== "AFN" ||
    !(
      value.can_start_new_checkout === undefined ||
      typeof value.can_start_new_checkout === "boolean"
    ) ||
    !(value.checkout_url === undefined || typeof value.checkout_url === "string") ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    !(
      value.checkout_expires_at === null ||
      (typeof value.checkout_expires_at === "string" &&
        Number.isFinite(Date.parse(value.checkout_expires_at)))
    )
  )
    invalid();
  return { ...value, can_start_new_checkout: value.can_start_new_checkout === true } as WebProOrder;
}
