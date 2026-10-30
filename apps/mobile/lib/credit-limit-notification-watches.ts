import type { SQLiteTx } from "./db-tx";
import { KAATA_DEFAULT_CREDIT_ID } from "./credit-policy";
import type { CreditAlertCustomer } from "./credit-alerts";
import type { CreditAlertGroup } from "./credit-alert-policy";

export type CreditLimitNotificationWatch = CreditAlertCustomer & {
  watch_key: string;
  limit_currency: string;
};

type WatchRow = {
  vault_id: string;
  relationship_id: string;
  person_id: string;
  currency: string;
  max_collect_minor: number | null;
  max_pay_minor: number | null;
  cap_updated_at_ms: number;
  cap_pending: number;
  config_updated_at_ms: number;
  config_pending: number;
};

/** Derive notification thresholds from current caps without copying them into
 * combined rules. Every denomination owns a separate pair of alert episodes. */
export async function listCreditLimitNotificationWatches(
  tx: SQLiteTx,
  vaultId?: string,
  relationshipId?: string,
  currency?: string,
): Promise<CreditLimitNotificationWatch[]> {
  let rows: WatchRow[];
  try {
    rows = await tx.getAllAsync<WatchRow>(
      `WITH subscribed AS (
        SELECT r.vault_id,r.id AS relationship_id,r.user_b_id AS person_id,
          MAX(COALESCE(n.updated_at_ms,d.updated_at_ms,0),COALESCE(t.updated_at_ms,0)) AS config_updated_at_ms,
          CASE WHEN t.relationship_id IS NOT NULL THEN 1 ELSE COALESCE(n.sync_pending,d.sync_pending,0) END AS config_pending
        FROM relationships r JOIN vaults v ON v.id=r.vault_id JOIN users u ON u.id=r.user_b_id
        LEFT JOIN customer_credit_limit_notifications n ON n.vault_id=r.vault_id AND n.relationship_id=r.id AND n.deleted=0
        LEFT JOIN customer_credit_limit_notifications t ON t.vault_id=r.vault_id AND t.relationship_id=r.id AND t.deleted=1 AND t.sync_pending=1
        LEFT JOIN customer_credit_limit_notifications d ON d.vault_id=r.vault_id AND d.relationship_id=? AND d.deleted=0
        WHERE r.archived_at IS NULL AND v.archived_at IS NULL AND u.archived_at IS NULL
          AND COALESCE(n.enabled,d.enabled,0)=1
          ${vaultId ? "AND r.vault_id=?" : ""}
          ${relationshipId ? "AND r.id=?" : ""}
      ), currencies AS (
        SELECT s.vault_id,s.relationship_id,p.currency FROM subscribed s
          JOIN customer_credit_limits p ON p.vault_id=s.vault_id AND p.relationship_id=s.relationship_id
        UNION
        SELECT s.vault_id,s.relationship_id,d.currency FROM subscribed s
          JOIN kaata_credit_defaults d ON d.vault_id=s.vault_id
      )
      SELECT s.*,c.currency,
        CASE WHEN p.relationship_id IS NOT NULL THEN p.max_collect_minor ELSE d.max_collect_minor END AS max_collect_minor,
        CASE WHEN p.relationship_id IS NOT NULL THEN p.max_pay_minor ELSE d.max_pay_minor END AS max_pay_minor,
        CASE WHEN p.relationship_id IS NOT NULL THEN p.updated_at_ms ELSE d.updated_at_ms END AS cap_updated_at_ms,
        COALESCE(p.sync_pending,0) AS cap_pending
      FROM subscribed s JOIN currencies c ON c.vault_id=s.vault_id AND c.relationship_id=s.relationship_id
      LEFT JOIN customer_credit_limits p ON p.vault_id=s.vault_id AND p.relationship_id=s.relationship_id AND p.currency=c.currency
      LEFT JOIN kaata_credit_defaults d ON d.vault_id=s.vault_id AND d.currency=c.currency
      ${currency ? "WHERE c.currency=?" : ""}
      ORDER BY s.vault_id,s.relationship_id,c.currency`,
      KAATA_DEFAULT_CREDIT_ID,
      ...(vaultId ? [vaultId] : []),
      ...(relationshipId ? [relationshipId] : []),
      ...(currency ? [currency] : []),
    );
  } catch (error) {
    // Fast refresh can load this optional observer before startup migrates an
    // already-open Expo Go database. Real storage failures must remain visible.
    if (
      error instanceof Error &&
      /\bno such table:\s*(?:main\.)?customer_credit_limit_notifications(?:\s|$)/i.test(
        error.message,
      )
    )
      return [];
    throw error;
  }
  return rows.flatMap((row) => {
    if (!/^[A-Z]{3}$/.test(row.currency)) throw new Error("Invalid cached credit limit currency");
    const groups: CreditAlertGroup[] = [];
    for (const [direction, cap] of [
      ["collect", row.max_collect_minor],
      ["pay", row.max_pay_minor],
    ] as const) {
      if (cap == null) continue;
      if (!Number.isSafeInteger(cap) || cap < 0 || cap > 999999999999)
        throw new Error("Invalid cached credit limit amount");
      groups.push({
        direction,
        // A zero cap means no positive exposure: settled zero must stay clear.
        conditions: [{ currency: row.currency, threshold_minor: Math.max(1, cap) }],
      });
    }
    if (!groups.length) return [];
    return [
      {
        vault_id: row.vault_id,
        relationship_id: row.relationship_id,
        person_id: row.person_id,
        watch_key: `limit:${row.currency}`,
        limit_currency: row.currency,
        policy: {
          relationship_id: row.relationship_id,
          groups,
          updated_at_ms: Math.max(row.cap_updated_at_ms, row.config_updated_at_ms),
        },
        sync_pending: !!row.config_pending || !!row.cap_pending,
      },
    ];
  });
}

export async function readCreditLimitNotificationWatch(
  tx: SQLiteTx,
  vaultId: string,
  relationshipId: string,
  currency: string,
): Promise<CreditLimitNotificationWatch | null> {
  return (
    (await listCreditLimitNotificationWatches(tx, vaultId, relationshipId, currency))[0] ?? null
  );
}
