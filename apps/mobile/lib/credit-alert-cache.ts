import type { SQLiteTx } from "./db-tx";
import { KAATA_DEFAULT_CREDIT_ID } from "./credit-policy";
import { type CreditAlertPolicy, validCreditAlertPolicy } from "./credit-alert-policy";

export async function readCreditAlertPolicyInTx(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
): Promise<CreditAlertPolicy | null> {
  let row: {
    relationship_id: string;
    groups_json: string;
    updated_at_ms: number;
  } | null;
  try {
    row = await tx.getFirstAsync<typeof row>(
      "SELECT relationship_id,groups_json,updated_at_ms FROM credit_alert_policies WHERE vault_id=? AND relationship_id=? AND deleted=0",
      vaultId,
      relationshipId,
    );
  } catch (error) {
    // Expo Go can refresh the advisory code while the already-open database
    // still has the pre-049 schema. An absent optional cache must not prevent
    // recording money or evaluating the existing independent credit limits.
    // Startup still owns migration; configuration writes and all other storage
    // failures remain errors rather than pretending a rule was saved/read.
    if (
      error instanceof Error &&
      /\bno such table:\s*(?:main\.)?credit_alert_policies(?:\s|$)/i.test(error.message)
    )
      return null;
    throw error;
  }
  if (!row) return null;
  const policy = {
    relationship_id: row.relationship_id,
    groups: JSON.parse(row.groups_json) as unknown,
    updated_at_ms: row.updated_at_ms,
  };
  if (!validCreditAlertPolicy(policy)) throw new Error("Invalid cached credit alert policy");
  return policy;
}

export async function cacheCreditAlerts(
  tx: SQLiteTx,
  vaultId: string,
  policies: CreditAlertPolicy[],
  startedAt: number,
  authoritativeRevision = false,
): Promise<boolean> {
  if (!Array.isArray(policies) || policies.some((p) => !validCreditAlertPolicy(p)))
    throw new Error("Invalid credit alert response");
  const present = new Set(policies.map((p) => p.relationship_id));
  if (present.size !== policies.length) throw new Error("Duplicate credit alert policy");
  let changes = 0;
  const old = await tx.getAllAsync<{
    relationship_id: string;
    updated_at_ms: number;
    sync_pending: number;
    deleted: number;
  }>(
    "SELECT relationship_id,updated_at_ms,sync_pending,deleted FROM credit_alert_policies WHERE vault_id=?",
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
        "UPDATE credit_alert_policies SET groups_json='[]',deleted=1,updated_at_ms=CASE WHEN ? THEN ? ELSE updated_at_ms END WHERE vault_id=? AND relationship_id=? AND sync_pending=0 AND updated_at_ms<=?",
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
        `INSERT INTO credit_alert_policies(vault_id,relationship_id,groups_json,updated_at_ms,sync_pending)
         SELECT ?,?,?,?,0 WHERE ?=? OR EXISTS(SELECT 1 FROM relationships WHERE id=? AND vault_id=?)
         ON CONFLICT(vault_id,relationship_id) DO UPDATE SET groups_json=excluded.groups_json,updated_at_ms=excluded.updated_at_ms,deleted=0
         WHERE credit_alert_policies.sync_pending=0
           AND (credit_alert_policies.updated_at_ms<excluded.updated_at_ms OR
             (credit_alert_policies.deleted=0 AND credit_alert_policies.updated_at_ms=excluded.updated_at_ms))
           AND (credit_alert_policies.groups_json IS NOT excluded.groups_json OR credit_alert_policies.updated_at_ms IS NOT excluded.updated_at_ms)`,
        vaultId,
        p.relationship_id,
        JSON.stringify(p.groups),
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
