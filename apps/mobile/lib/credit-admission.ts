import type { SQLiteTx } from "./db-tx";
import type { EntryCreatedEvent, LedgerEvent, VaultRole } from "./events";

export function needsCreditAdmission(
  event: LedgerEvent,
  lawfulRole: VaultRole | undefined,
): boolean {
  return (
    event.event_type === "entry_created" && lawfulRole === "clerk" && event.server_acked_at == null
  );
}

// Exception only for a fully observed local-CA notebook: all membership/device
// identities are local sentinels, no server acknowledgment/binding exists, and
// no hard policy has been installed. NULL registration alone is not evidence
// (cloud pair-scan deliberately leaves it NULL). Unknown/mixed state waits.
export async function requiresCreditAdmission(
  tx: SQLiteTx,
  event: LedgerEvent,
  lawfulRole: VaultRole | undefined,
): Promise<boolean> {
  if (!needsCreditAdmission(event, lawfulRole)) return false;
  const vault = await tx.getFirstAsync<{
    account_id: string | null;
    registered_with_server_at: number | null;
    vault_trust_anchor_pubkey: string | null;
  }>(
    "SELECT account_id,registered_with_server_at,vault_trust_anchor_pubkey FROM vaults WHERE id=?",
    event.vault_id,
  );
  if (
    !vault ||
    vault.account_id != null ||
    vault.registered_with_server_at != null ||
    !vault.vault_trust_anchor_pubkey
  )
    return true;
  if (event.actor_account_id && !/^local:[A-Za-z0-9_-]{16}$/.test(event.actor_account_id))
    return true;
  const cloud = await tx.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM event_log WHERE vault_id=? AND (server_acked_at IS NOT NULL OR (applied_at IS NOT NULL AND (event_type='account_bound' OR (actor_account_id IS NOT NULL AND actor_account_id NOT GLOB 'local:*')))) LIMIT 1",
    event.vault_id,
  );
  if (cloud) return true;
  const hard = await tx.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM customer_credit_limits WHERE vault_id=? AND mode='clerk_block' LIMIT 1",
    event.vault_id,
  );
  if (hard) return true;
  const members = await tx.getAllAsync<{ account_id: string }>(
    "SELECT account_id FROM vault_members_mirror WHERE vault_id=?",
    event.vault_id,
  );
  const devices = await tx.getAllAsync<{ account_id: string }>(
    "SELECT account_id FROM vault_device_registry WHERE vault_id=?",
    event.vault_id,
  );
  const legacy = await tx.getAllAsync<{ account_id: string }>(
    "SELECT account_id FROM vault_credentials WHERE vault_id=?",
    event.vault_id,
  );
  return (
    !members.length ||
    !devices.length ||
    [...members, ...devices, ...legacy].some((r) => !/^local:[A-Za-z0-9_-]{16}$/.test(r.account_id))
  );
}

// A clerk's durable intent is visible separately from recorded money until
// HTTPS acknowledgement. Mesh receipt cannot satisfy this prerequisite.
export async function deferCreditAdmission(tx: SQLiteTx, event: EntryCreatedEvent): Promise<void> {
  await tx.runAsync(
    "UPDATE event_log SET applied_at=NULL,quarantine_reason='missing_prereq' WHERE event_id=?",
    event.event_id,
  );
  await tx.runAsync(
    "INSERT OR IGNORE INTO credit_admission_intents(event_id,vault_id,relationship_id,status,reason) VALUES(?,?,?,'pending',NULL)",
    event.event_id,
    event.vault_id,
    event.payload.relationship_id,
  );
}
