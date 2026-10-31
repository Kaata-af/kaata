import {
  getWebSession,
  isSameWebSession,
  webRequest,
  WebApiError,
  type WebSession,
} from "./web-auth";
import type { WebLedger, WebPerson } from "./web-ledger";
import { WEB_SYNC_HEADERS } from "./web-sync-headers";

export const WEB_DEFAULT_CREDIT_ID = "00000000-0000-0000-0000-000000000000";
const MAX_CREDIT_MINOR = 999_999_999_999;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebCreditPolicy = {
  relationship_id: string;
  currency: string;
  max_collect_minor: number | null;
  max_pay_minor: number | null;
  mode: "warn" | "clerk_block";
  restrict_editors: boolean;
  updated_at_ms: number;
};
export type WebCreditInput = Omit<WebCreditPolicy, "updated_at_ms">;
export type WebCreditStatus = "none" | "near" | "reached" | "over";

export class WebCreditError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "WebCreditError";
  }
}

function session(): WebSession {
  const value = getWebSession();
  if (!value) throw new WebApiError("Sign in again.", 401, "session_expired");
  return value;
}

function assertSession(expected: WebSession) {
  if (!isSameWebSession(getWebSession(), expected)) throw new WebCreditError("session_changed");
}

function path(vaultID: string): string {
  if (!UUID.test(vaultID)) throw new WebCreditError("invalid_credit_policy");
  return `/v1/sync/credit-limits?${new URLSearchParams({ vault_id: vaultID })}`;
}

function validCap(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_CREDIT_MINOR)
  );
}

function parsePolicy(raw: unknown): WebCreditPolicy {
  if (!raw || typeof raw !== "object") throw new WebCreditError("invalid_credit_response");
  const value = raw as Record<string, unknown>;
  if (
    typeof value.relationship_id !== "string" ||
    !UUID.test(value.relationship_id) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !validCap(value.max_collect_minor) ||
    !validCap(value.max_pay_minor) ||
    (value.mode !== "warn" && value.mode !== "clerk_block") ||
    !(value.restrict_editors === undefined || typeof value.restrict_editors === "boolean") ||
    typeof value.updated_at_ms !== "number" ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    value.updated_at_ms < 0
  )
    throw new WebCreditError("invalid_credit_response");
  return {
    relationship_id: value.relationship_id,
    currency: value.currency,
    max_collect_minor: value.max_collect_minor,
    max_pay_minor: value.max_pay_minor,
    mode: value.mode,
    restrict_editors: value.restrict_editors === true,
    updated_at_ms: value.updated_at_ms,
  };
}

export async function loadWebCreditPolicies(
  vaultID: string,
  signal?: AbortSignal,
): Promise<WebCreditPolicy[]> {
  const current = session();
  signal?.throwIfAborted();
  const response = await webRequest<unknown>(path(vaultID), { headers: WEB_SYNC_HEADERS, signal });
  signal?.throwIfAborted();
  assertSession(current);
  if (!Array.isArray(response)) throw new WebCreditError("invalid_credit_response");
  const policies = response.map(parsePolicy);
  const keys = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.relationship_id}:${policy.currency}`;
    if (keys.has(key)) throw new WebCreditError("invalid_credit_response");
    keys.add(key);
  }
  return policies;
}

export function effectiveWebCreditPolicy(
  policies: readonly WebCreditPolicy[],
  relationshipID: string,
  currency: string,
): WebCreditPolicy | null {
  return (
    policies.find((row) => row.relationship_id === relationshipID && row.currency === currency) ??
    policies.find(
      (row) => row.relationship_id === WEB_DEFAULT_CREDIT_ID && row.currency === currency,
    ) ??
    null
  );
}

function samePolicy(a: WebCreditPolicy | null, b: WebCreditPolicy | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.relationship_id === b.relationship_id &&
    a.currency === b.currency &&
    a.max_collect_minor === b.max_collect_minor &&
    a.max_pay_minor === b.max_pay_minor &&
    a.mode === b.mode &&
    a.restrict_editors === b.restrict_editors
  );
}

export async function saveWebCreditPolicy(
  ledger: WebLedger,
  input: WebCreditInput,
  expected: WebCreditPolicy | null,
  signal?: AbortSignal,
): Promise<WebCreditPolicy> {
  if (ledger.archived_at_ms != null || !["owner", "manager"].includes(ledger.role))
    throw new WebCreditError("permission_denied");
  const proposed = parsePolicy({ ...input, updated_at_ms: 0 });
  if (
    proposed.relationship_id !== WEB_DEFAULT_CREDIT_ID &&
    !ledger.people.some(
      (person) => person.relationship_id === proposed.relationship_id && person.archived_at == null,
    )
  )
    throw new WebCreditError("permission_denied");
  const current = session();
  // Review a fresh copy before replacing a policy. The backend remains the
  // final authority; its current API has no atomic compare-and-set contract.
  const policies = await loadWebCreditPolicies(ledger.vault_id, signal);
  signal?.throwIfAborted();
  assertSession(current);
  const latest =
    policies.find(
      (row) =>
        row.relationship_id === proposed.relationship_id && row.currency === proposed.currency,
    ) ?? null;
  // A previous PUT may have committed before its response was lost. Confirming
  // the exact desired settings is sufficient; do not submit the same save again.
  if (latest && samePolicy(proposed, latest)) return latest;
  if (!samePolicy(expected, latest)) throw new WebCreditError("stale_credit_policy");
  const { updated_at_ms: _updatedAt, ...body } = proposed;
  const response = await webRequest<unknown>(path(ledger.vault_id), {
    method: "PUT",
    headers: WEB_SYNC_HEADERS,
    signal,
    body: JSON.stringify(body),
  });
  assertSession(current);
  const saved = parsePolicy(response);
  if (!samePolicy(proposed, saved)) throw new WebCreditError("invalid_credit_response");
  return saved;
}

/** Blank is unlimited. Parse exact hundredths before narrowing the bounded cap. */
export function parseWebCreditAmount(value: string): number | null {
  let text = value
    .replace(/[۰-۹٠-٩]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x06f0 : 0x0660)))
    .trim()
    .replace(/٫/g, ".");
  if (!text) return null;
  if (text.length > 32) throw new WebCreditError("invalid_credit_amount");
  if (/^\d*,\d{1,2}$/.test(text)) text = text.replace(",", ".");
  const match = /^(\d+)(?:\.(\d{0,2}))?$|^\.(\d{1,2})$/.exec(text);
  if (!match) throw new WebCreditError("invalid_credit_amount");
  const minor =
    BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? match[3] ?? "").padEnd(2, "0"));
  if (minor > BigInt(MAX_CREDIT_MINOR)) throw new WebCreditError("invalid_credit_amount");
  return Number(minor);
}

export function webCreditAmount(value: number | null): string {
  if (value === null) return "";
  if (!validCap(value)) throw new WebCreditError("invalid_credit_amount");
  const amount = BigInt(value);
  return `${amount / 100n}${amount % 100n ? `.${String(amount % 100n).padStart(2, "0")}` : ""}`;
}

export function webCreditDetail(cap: number | null, exposure: bigint) {
  if (!validCap(cap) || exposure < 0n) throw new WebCreditError("invalid_credit_amount");
  const limit = cap === null ? null : BigInt(cap);
  const status: WebCreditStatus =
    limit === null || exposure === 0n
      ? "none"
      : exposure > limit
        ? "over"
        : exposure === limit
          ? "reached"
          : exposure * 5n >= limit * 4n
            ? "near"
            : "none";
  return { cap: limit, exposure, remaining: limit === null ? null : limit - exposure, status };
}

export function webCreditExposureKnown(
  ledger: WebLedger,
  person: WebPerson | undefined,
  balances: ReadonlyArray<{ currency: string; balance: bigint }> | undefined,
): boolean {
  return (
    ledger.credit_balances_complete === true &&
    !!balances &&
    !!person &&
    person.read_only_reason !== "shared_tab" &&
    person.archived_at == null
  );
}
