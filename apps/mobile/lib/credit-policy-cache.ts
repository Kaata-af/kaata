import type { SQLiteTx } from "./db-tx";
import { type CreditPolicy, KAATA_DEFAULT_CREDIT_ID, validCreditPolicy } from "./credit-policy";

export async function cacheCreditPolicies(
  tx: SQLiteTx,
  vaultId: string,
  all: CreditPolicy[],
  startedAt: number,
): Promise<void> {
  // The kaata default belongs to no customer: it has its own table.
  const kaataDefault = all.find((p) => p.relationship_id === KAATA_DEFAULT_CREDIT_ID);
  const policies = all.filter((p) => p.relationship_id !== KAATA_DEFAULT_CREDIT_ID);
  if (kaataDefault) {
    if (!validCreditPolicy(kaataDefault)) throw new Error("Invalid credit policy response");
    await tx.runAsync(
      "INSERT INTO kaata_credit_defaults(vault_id,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors) VALUES(?,?,?,?,?,?) ON CONFLICT(vault_id) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors WHERE kaata_credit_defaults.updated_at_ms<=excluded.updated_at_ms",
      vaultId,
      kaataDefault.max_collect_minor,
      kaataDefault.max_pay_minor,
      kaataDefault.mode,
      kaataDefault.updated_at_ms,
      Number(!!kaataDefault.restrict_editors),
    );
  } else {
    await tx.runAsync(
      "DELETE FROM kaata_credit_defaults WHERE vault_id=? AND updated_at_ms<=?",
      vaultId,
      startedAt,
    );
  }
  const present = new Set(policies.map((p) => p.relationship_id));
  const old = await tx.getAllAsync<{
    relationship_id: string;
    updated_at_ms: number;
    sync_pending: number;
  }>(
    "SELECT relationship_id,updated_at_ms,sync_pending FROM customer_credit_limits WHERE vault_id=?",
    vaultId,
  );
  for (const p of old)
    if (!present.has(p.relationship_id) && !p.sync_pending && p.updated_at_ms <= startedAt)
      await tx.runAsync(
        "DELETE FROM customer_credit_limits WHERE vault_id=? AND relationship_id=? AND sync_pending=0 AND updated_at_ms<=?",
        vaultId,
        p.relationship_id,
        startedAt,
      );
  for (const p of policies) {
    if (!validCreditPolicy(p)) throw new Error("Invalid credit policy response");
    await tx.runAsync(
      "INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors,sync_pending) SELECT ?,?,?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM relationships WHERE id=? AND vault_id=?) ON CONFLICT(vault_id,relationship_id) DO UPDATE SET max_collect_minor=excluded.max_collect_minor,max_pay_minor=excluded.max_pay_minor,mode=excluded.mode,updated_at_ms=excluded.updated_at_ms,restrict_editors=excluded.restrict_editors WHERE customer_credit_limits.sync_pending=0 AND customer_credit_limits.updated_at_ms<=excluded.updated_at_ms",
      vaultId,
      p.relationship_id,
      p.max_collect_minor,
      p.max_pay_minor,
      p.mode,
      p.updated_at_ms,
      Number(!!p.restrict_editors),
      p.relationship_id,
      vaultId,
    );
  }
}
