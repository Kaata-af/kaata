import type { WebProPlan } from "../../lib/web-pro";
import { AuthError } from "./api";
import { parseAdminProGrant, type AdminProGrant } from "./admin-pro-grants";
import {
  ADMIN_PRO_UUID as UUID,
  adminProRequest as request,
  adminProTimestamp as timestamp,
} from "./admin-pro-request";

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
  paid_expires_at: string | null;
  manual_grant: AdminProGrant | null;
  grant_history: AdminProGrant[];
  grants_available: boolean;
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

const RECEIPT = /^[A-Za-z0-9._/-]{3,64}$/;
const UNCONFIRMED = "Kaata could not confirm the payment. Retry with the same receipt reference.";

export function manualProReference(input: string): string | null {
  const reference = input.trim();
  return RECEIPT.test(reference) ? reference : null;
}

export function adminProKey(token: string, accountID: string) {
  return ["admin", "web-pro", token, accountID] as const;
}

export function isAdminProPlanID(value: unknown): value is WebProPlan["id"] {
  return value === "web_pro_monthly" || value === "web_pro_yearly";
}

function validAmount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999
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
    !isAdminProPlanID(value.id) ||
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

export function parseAdminProPayment(input: unknown): AdminProPayment {
  const value = record(input);
  if (
    typeof value.payment_id !== "string" ||
    !UUID.test(value.payment_id) ||
    !isAdminProPlanID(value.plan_id) ||
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
  const grantsAvailable = Object.hasOwn(value, "grant_history");
  if (
    typeof value.account_id !== "string" ||
    value.account_id.toLowerCase() !== accountID.toLowerCase() ||
    (value.status !== "trial" && value.status !== "active") ||
    (value.subscription_expires_at !== null && !timestamp(value.subscription_expires_at)) ||
    (value.status === "active" && !value.subscription_expires_at) ||
    (grantsAvailable &&
      ((value.paid_expires_at !== null && !timestamp(value.paid_expires_at)) ||
        !Object.hasOwn(value, "manual_grant") ||
        !Array.isArray(value.grant_history))) ||
    typeof value.pending_checkout !== "boolean" ||
    !Array.isArray(value.plans) ||
    value.plans.length > 2 ||
    !Array.isArray(value.payments)
  )
    throw new Error("Invalid Pro details for this account.");
  const plans = value.plans.map(parsePlan);
  if (new Set(plans.map((plan) => plan.id)).size !== plans.length)
    throw new Error("Duplicate Pro plans.");
  const grant =
    grantsAvailable && value.manual_grant !== null ? parseAdminProGrant(value.manual_grant) : null;
  if (grant?.revoked_at) throw new Error("Invalid active Pro grant.");
  return {
    account_id: value.account_id,
    status: value.status,
    subscription_expires_at: value.subscription_expires_at,
    paid_expires_at: grantsAvailable
      ? (value.paid_expires_at as string | null)
      : value.subscription_expires_at,
    manual_grant: grant,
    grant_history: Array.isArray(value.grant_history)
      ? value.grant_history.map(parseAdminProGrant)
      : [],
    grants_available: grantsAvailable,
    plans,
    pending_checkout: value.pending_checkout,
    payments: value.payments.map(parseAdminProPayment),
  };
}

export async function recordAdminProPayment(
  token: string,
  accountID: string,
  input: ManualProPayment,
): Promise<AdminProReceipt> {
  const reference = manualProReference(input.reference);
  if (
    !reference ||
    !isAdminProPlanID(input.plan_id) ||
    !manualMethod(input.method) ||
    !UUID.test(accountID)
  )
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
    const payment = parseAdminProPayment(value.payment);
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
