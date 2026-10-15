/** Keys the kaata-wide default limit: it covers every customer without their
 *  own policy, newly added ones included (Matee, 2026-10-12). No relationship
 *  can have this id; the server uses the same one. */
export const KAATA_DEFAULT_CREDIT_ID = "00000000-0000-0000-0000-000000000000";
/** Route id that opens the default in the limit screen: /person/kaata-default/credit-limit. */
export const KAATA_DEFAULT_ROUTE_ID = "kaata-default";

export type CreditPolicy = {
  relationship_id: string;
  max_collect_minor: number | null;
  max_pay_minor: number | null;
  mode: "warn" | "clerk_block";
  /** Hard limits also cover editors. Missing on older policies means clerks only. */
  restrict_editors?: boolean;
  updated_at_ms: number;
};

export function creditExceeded(p: CreditPolicy | null, before: number, after: number): boolean {
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after))
    throw new RangeError("Unsafe credit balance");
  return (
    !!p &&
    ((p.max_collect_minor != null && after > before && after > 0 && after > p.max_collect_minor) ||
      (p.max_pay_minor != null && after < before && after < 0 && after < -p.max_pay_minor))
  );
}

export function validCreditPolicy(p: CreditPolicy): boolean {
  return (
    (p.mode === "warn" || p.mode === "clerk_block") &&
    (p.restrict_editors === undefined || typeof p.restrict_editors === "boolean") &&
    [p.max_collect_minor, p.max_pay_minor].every(
      (n) => n == null || (Number.isSafeInteger(n) && n >= 0 && n <= 999999999999),
    )
  );
}
