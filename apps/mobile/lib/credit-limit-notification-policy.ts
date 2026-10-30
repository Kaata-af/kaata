/** Shared customer configuration, separate from each recipient's delivery
 * preferences and from combined credit-alert rules. */
export type CreditLimitNotificationPolicy = {
  relationship_id: string;
  enabled: boolean;
  updated_at_ms: number;
};

export type CreditLimitNotificationSetting = CreditLimitNotificationPolicy & {
  sync_pending: boolean;
};

export function validCreditLimitNotificationPolicy(
  value: unknown,
): value is CreditLimitNotificationPolicy {
  if (!value || typeof value !== "object") return false;
  const p = value as CreditLimitNotificationPolicy;
  return (
    typeof p.relationship_id === "string" &&
    p.relationship_id.length > 0 &&
    typeof p.enabled === "boolean" &&
    Number.isSafeInteger(p.updated_at_ms) &&
    p.updated_at_ms >= 0
  );
}
