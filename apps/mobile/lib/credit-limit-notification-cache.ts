import type { SQLiteTx } from "./db-tx";
import { KAATA_DEFAULT_CREDIT_ID } from "./credit-policy";
import {
  validCreditLimitNotificationPolicy,
  type CreditLimitNotificationPolicy,
  type CreditLimitNotificationSetting,
} from "./credit-limit-notification-policy";

export async function readCreditLimitNotificationPolicyInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
): Promise<CreditLimitNotificationSetting | null> {
  let row: {
    relationship_id: string;
    enabled: number;
    updated_at_ms: number;
    sync_pending: number;
  } | null;
  try {
    row = await tx.getFirstAsync<typeof row>(
      "SELECT relationship_id,enabled,updated_at_ms,sync_pending FROM customer_credit_limit_notifications WHERE vault_id=? AND relationship_id=? AND deleted=0",
      vaultId,
      relationshipId,
    );
  } catch (error) {
    // Fast Refresh may load advisory code before startup has migrated an
    // already-open Expo Go database. Reads may be empty; writes must still fail.
    if (
      error instanceof Error &&
      /\bno such table:\s*(?:main\.)?customer_credit_limit_notifications(?:\s|$)/i.test(
        error.message,
      )
    )
      return null;
    throw error;
  }
  if (!row) return null;
  const result = {
    relationship_id: row.relationship_id,
    enabled: row.enabled === 1,
    updated_at_ms: row.updated_at_ms,
    sync_pending: !!row.sync_pending,
  };
  if ((row.enabled !== 0 && row.enabled !== 1) || !validCreditLimitNotificationPolicy(result))
    throw new Error("Invalid cached credit limit notification policy");
  return result;
}

/** An explicit false customer row overrides an enabled Kaata default. */
export async function readCreditLimitNotificationSettingInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
): Promise<CreditLimitNotificationSetting | null> {
  const own = await readCreditLimitNotificationPolicyInTx(tx, vaultId, relationshipId);
  if (own || relationshipId === KAATA_DEFAULT_CREDIT_ID) return own;
  return readCreditLimitNotificationPolicyInTx(tx, vaultId, KAATA_DEFAULT_CREDIT_ID);
}

/** Merge complete server observations without erasing pending edits or
 * resurrecting a deleted override from a response requested before the reset. */
export async function cacheCreditLimitNotifications(
  tx: SQLiteTx,
  vaultId: string,
  policies: CreditLimitNotificationPolicy[],
  startedAt: number,
  authoritativeRevision = false,
): Promise<boolean> {
  if (!Array.isArray(policies) || policies.some((p) => !validCreditLimitNotificationPolicy(p)))
    throw new Error("Invalid credit limit notification response");
  const present = new Set(policies.map((p) => p.relationship_id));
  if (present.size !== policies.length)
    throw new Error("Duplicate credit limit notification policy");
  let changes = 0;
  const old = await tx.getAllAsync<{
    relationship_id: string;
    updated_at_ms: number;
    sync_pending: number;
    deleted: number;
  }>(
    "SELECT relationship_id,updated_at_ms,sync_pending,deleted FROM customer_credit_limit_notifications WHERE vault_id=?",
    vaultId,
  );
  for (const p of old) {
    if (
      present.has(p.relationship_id) ||
      p.sync_pending ||
      (p.deleted && (!authoritativeRevision || p.updated_at_ms >= startedAt)) ||
      p.updated_at_ms > startedAt
    )
      continue;
    changes += (
      await tx.runAsync(
        "UPDATE customer_credit_limit_notifications SET enabled=0,deleted=1,updated_at_ms=CASE WHEN ? THEN ? ELSE updated_at_ms END WHERE vault_id=? AND relationship_id=? AND sync_pending=0 AND updated_at_ms<=?",
        Number(authoritativeRevision),
        startedAt,
        vaultId,
        p.relationship_id,
        startedAt,
      )
    ).changes;
  }
  for (const p of policies) {
    changes += (
      await tx.runAsync(
        `INSERT INTO customer_credit_limit_notifications(vault_id,relationship_id,enabled,updated_at_ms,sync_pending)
         SELECT ?,?,?,?,0 WHERE ?=? OR EXISTS(SELECT 1 FROM relationships WHERE id=? AND vault_id=?)
         ON CONFLICT(vault_id,relationship_id) DO UPDATE SET enabled=excluded.enabled,updated_at_ms=excluded.updated_at_ms,deleted=0
         WHERE customer_credit_limit_notifications.sync_pending=0
           AND (customer_credit_limit_notifications.updated_at_ms<excluded.updated_at_ms OR
             (customer_credit_limit_notifications.deleted=0 AND customer_credit_limit_notifications.updated_at_ms=excluded.updated_at_ms))
           AND (customer_credit_limit_notifications.enabled IS NOT excluded.enabled OR customer_credit_limit_notifications.updated_at_ms IS NOT excluded.updated_at_ms)`,
        vaultId,
        p.relationship_id,
        Number(p.enabled),
        p.updated_at_ms,
        p.relationship_id,
        KAATA_DEFAULT_CREDIT_ID,
        p.relationship_id,
        vaultId,
      )
    ).changes;
  }
  return changes > 0;
}
