import type { SQLiteTx } from "./db-tx";
import { type CreditPolicy, KAATA_DEFAULT_CREDIT_ID, validCreditPolicy } from "./credit-policy";

/** Responses contain every currency. An older server's untagged policies
 * belong only to the frozen legacy denomination, never the selected view. */
export async function cacheCreditPolicies(
  tx: SQLiteTx,
  vaultId: string,
  all: CreditPolicy[],
  startedAt: number,
): Promise<boolean> {
  const vault = await tx.getFirstAsync<{ currency: string }>(
    "SELECT COALESCE(legacy_currency,currency,'AFN') AS currency FROM vaults WHERE id=?",
    vaultId,
  );
  const policies = all.map((policy) => ({
    ...policy,
    currency: policy.currency ?? vault?.currency ?? "AFN",
  }));
  for (const policy of policies)
    if (!validCreditPolicy(policy)) throw new Error("Invalid credit policy response");
  const key = (p: { relationship_id: string; currency: string }) =>
    `${p.relationship_id}:${p.currency}`;
  const present = new Set(policies.map(key));
  let changes = 0;
  const old = await tx.getAllAsync<{
    relationship_id: string;
    currency: string;
    updated_at_ms: number;
    sync_pending: number;
  }>(
    `SELECT relationship_id,currency,updated_at_ms,sync_pending FROM customer_credit_limits WHERE vault_id=?
     UNION ALL SELECT ?,currency,updated_at_ms,0 AS sync_pending FROM kaata_credit_defaults WHERE vault_id=?`,
    vaultId,
    KAATA_DEFAULT_CREDIT_ID,
    vaultId,
  );
  for (const policy of old) {
    if (present.has(key(policy)) || policy.sync_pending || policy.updated_at_ms > startedAt)
      continue;
    changes += (
      policy.relationship_id === KAATA_DEFAULT_CREDIT_ID
        ? await tx.runAsync(
            "DELETE FROM kaata_credit_defaults WHERE vault_id=? AND currency=? AND updated_at_ms<=?",
            vaultId,
            policy.currency,
            startedAt,
          )
        : await tx.runAsync(
            "DELETE FROM customer_credit_limits WHERE vault_id=? AND relationship_id=? AND currency=? AND sync_pending=0 AND updated_at_ms<=?",
            vaultId,
            policy.relationship_id,
            policy.currency,
            startedAt,
          )
    ).changes;
  }
  for (const p of policies) {
    if (p.relationship_id === KAATA_DEFAULT_CREDIT_ID) {
      changes += (
        await tx.runAsync(
          `INSERT INTO kaata_credit_defaults(vault_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors
        WHERE kaata_credit_defaults.updated_at_ms<=excluded.updated_at_ms AND (
          kaata_credit_defaults.max_collect_minor IS NOT excluded.max_collect_minor OR kaata_credit_defaults.max_pay_minor IS NOT excluded.max_pay_minor
          OR kaata_credit_defaults.mode IS NOT excluded.mode OR kaata_credit_defaults.updated_at_ms IS NOT excluded.updated_at_ms
          OR kaata_credit_defaults.restrict_editors IS NOT excluded.restrict_editors)`,
          vaultId,
          p.currency,
          p.max_collect_minor,
          p.max_pay_minor,
          p.mode,
          p.updated_at_ms,
          Number(!!p.restrict_editors),
        )
      ).changes;
    } else {
      changes += (
        await tx.runAsync(
          `INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors,sync_pending)
        SELECT ?,?,?,?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM relationships WHERE id=? AND vault_id=?)
        ON CONFLICT(vault_id,relationship_id,currency) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors
        WHERE customer_credit_limits.sync_pending=0 AND customer_credit_limits.updated_at_ms<=excluded.updated_at_ms AND (
          customer_credit_limits.max_collect_minor IS NOT excluded.max_collect_minor OR customer_credit_limits.max_pay_minor IS NOT excluded.max_pay_minor
          OR customer_credit_limits.mode IS NOT excluded.mode OR customer_credit_limits.updated_at_ms IS NOT excluded.updated_at_ms
          OR customer_credit_limits.restrict_editors IS NOT excluded.restrict_editors)`,
          vaultId,
          p.relationship_id,
          p.currency,
          p.max_collect_minor,
          p.max_pay_minor,
          p.mode,
          p.updated_at_ms,
          Number(!!p.restrict_editors),
          p.relationship_id,
          vaultId,
        )
      ).changes;
    }
  }
  return changes > 0;
}
