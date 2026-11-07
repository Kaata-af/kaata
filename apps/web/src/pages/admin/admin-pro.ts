import { BACKEND_URL } from "../../env";
import type { WebProPlan } from "../../lib/web-pro";
import { AuthError } from "./api";

export const MANUAL_PAYMENT_METHODS = ["cash", "bank_transfer", "other"] as const;
export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];
export type AdminProPayment = {
  payment_id: string;
  plan_id: WebProPlan["id"];
  amount_minor: number;
  currency: "AFN";
  method: ManualPaymentMethod | "hesabpay";
  reference?: string;
  recorded_at: string;
  subscription_expires_at?: string;
};
export type AdminProStatus = {
  account_id: string;
  status: "active" | "trial";
  subscription_expires_at: string | null;
  plans: WebProPlan[];
  pending_checkout: boolean;
  payments: AdminProPayment[];
};
export type ManualProPayment = {
  plan_id: WebProPlan["id"];
  method: ManualPaymentMethod;
  reference: string;
};
export type AdminProReceipt = {
  payment: AdminProPayment;
  subscription_expires_at: string;
  duplicate: boolean;
};

export class AdminProPaymentError extends Error {
  constructor(
    public kind: "conflict" | "rejected" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "AdminProPaymentError";
  }
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RECEIPT = /^[A-Za-z0-9._/-]{3,64}$/;
const TIMEOUT_MS = 20_000;
const UNCONFIRMED = "Kaata could not confirm the payment. Retry with the same receipt reference.";

export function manualProReference(input: string): string | null {
  const reference = input.trim();
  return RECEIPT.test(reference) ? reference : null;
}

export function adminProKey(token: string, accountID: string) {
  return ["admin", "web-pro", token, accountID] as const;
}

function path(accountID: string) {
  if (!UUID.test(accountID)) throw new Error("Invalid account ID.");
  return `/v1/admin/users/${accountID}/pro`;
}

function planID(value: unknown): value is WebProPlan["id"] {
  return value === "web_pro_monthly" || value === "web_pro_yearly";
}

function validAmount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Pro payment response.");
  return value as Record<string, unknown>;
}

function manualMethod(value: unknown): value is ManualPaymentMethod {
  return MANUAL_PAYMENT_METHODS.some((method) => method === value);
}

function parsePlan(input: unknown): WebProPlan {
  const value = record(input);
  if (
    !planID(value.id) ||
    !validAmount(value.amount_minor) ||
    value.currency !== "AFN" ||
    value.duration_months !== (value.id === "web_pro_monthly" ? 1 : 12)
  )
    throw new Error("Invalid Kaata Pro plan.");
  return {
    id: value.id,
    amount_minor: value.amount_minor,
    currency: value.currency,
    duration_months: value.id === "web_pro_monthly" ? 1 : 12,
  };
}

function parsePayment(input: unknown): AdminProPayment {
  const value = record(input);
  if (
    typeof value.payment_id !== "string" ||
    !UUID.test(value.payment_id) ||
    !planID(value.plan_id) ||
    !validAmount(value.amount_minor) ||
    value.currency !== "AFN" ||
    !timestamp(value.recorded_at) ||
    (!manualMethod(value.method) && value.method !== "hesabpay") ||
    (value.reference != null &&
      (typeof value.reference !== "string" || value.reference.length > 64)) ||
    (manualMethod(value.method) &&
      (typeof value.reference !== "string" || !RECEIPT.test(value.reference))) ||
    (value.subscription_expires_at != null && !timestamp(value.subscription_expires_at))
  )
    throw new Error("Invalid Pro payment response.");
  return {
    payment_id: value.payment_id,
    plan_id: value.plan_id,
    amount_minor: value.amount_minor,
    currency: value.currency,
    method: value.method,
    recorded_at: value.recorded_at,
    ...(typeof value.reference === "string" && value.reference
      ? { reference: value.reference }
      : {}),
    ...(typeof value.subscription_expires_at === "string"
      ? { subscription_expires_at: value.subscription_expires_at }
      : {}),
  };
}

async function request(token: string, accountID: string, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${BACKEND_URL.replace(/\/$/, "")}${path(accountID)}`, {
    ...init,
    headers,
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (response.status === 401) throw new AuthError();
  return response;
}

export async function getAdminProStatus(
  token: string,
  accountID: string,
  signal?: AbortSignal,
): Promise<AdminProStatus> {
  const response = await request(token, accountID, { signal });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "Pro details are unavailable for this account."
        : `Server error (${response.status}).`,
    );
  const value = record(await response.json());
  if (
    typeof value.account_id !== "string" ||
    value.account_id.toLowerCase() !== accountID.toLowerCase() ||
    (value.status !== "trial" && value.status !== "active") ||
    (value.subscription_expires_at !== null && !timestamp(value.subscription_expires_at)) ||
    (value.status === "active" && !value.subscription_expires_at) ||
    typeof value.pending_checkout !== "boolean" ||
    !Array.isArray(value.plans) ||
    value.plans.length > 2 ||
    !Array.isArray(value.payments)
  )
    throw new Error("Invalid Pro details for this account.");
  const plans = value.plans.map(parsePlan);
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error("Duplicate Pro plans.");
  return {
    account_id: value.account_id,
    status: value.status,
    subscription_expires_at: value.subscription_expires_at,
    plans,
    pending_checkout: value.pending_checkout,
    payments: value.payments.map(parsePayment),
  };
}

export async function recordAdminProPayment(
  token: string,
  accountID: string,
  input: ManualProPayment,
): Promise<AdminProReceipt> {
  const reference = manualProReference(input.reference);
  if (!reference || !planID(input.plan_id) || !manualMethod(input.method) || !UUID.test(accountID))
    throw new AdminProPaymentError(
      "rejected",
      "Check the account, plan, payment method, and receipt reference.",
    );
  let response: Response;
  try {
    response = await request(token, accountID, {
      method: "POST",
      body: JSON.stringify({ plan_id: input.plan_id, method: input.method, reference }),
    });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AdminProPaymentError("unconfirmed", UNCONFIRMED);
  }
  if (!response.ok) {
    if (response.status === 409) {
      const error = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
      if (error?.error_code === "manual_payment_conflict")
        throw new AdminProPaymentError(
          "conflict",
          "This receipt reference belongs to a different payment. Check the receipt before continuing.",
        );
    }
    if ([400, 403, 404, 409, 422, 429].includes(response.status))
      throw new AdminProPaymentError(
        "rejected",
        `Kaata refused this payment (${response.status}). Check the account and receipt before trying again.`,
      );
    throw new AdminProPaymentError("unconfirmed", UNCONFIRMED);
  }
  try {
    const value = record(await response.json());
    const payment = parsePayment(value.payment);
    if (
      !timestamp(value.subscription_expires_at) ||
      typeof value.duplicate !== "boolean" ||
      payment.plan_id !== input.plan_id ||
      payment.method !== input.method ||
      payment.reference?.toLowerCase() !== reference.toLowerCase()
    )
      throw new Error("Mismatched payment confirmation.");
    return {
      payment,
      subscription_expires_at: value.subscription_expires_at,
      duplicate: value.duplicate,
    };
  } catch {
    throw new AdminProPaymentError("unconfirmed", UNCONFIRMED);
  }
}
