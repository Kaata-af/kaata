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

// Clerks record offline like everyone else; only a customer under a known hard
// ("restrict clerks") limit needs the server's OK first (Matee, 2026-10-12).
// Codex's earlier rule sent EVERY cloud clerk tally through HTTPS admission,
// even with no limit, so clerks could not work without internet. The residual
// risk is a hard limit set elsewhere that this phone has not pulled yet: the
// server still refuses such a tally on push, and revertRefusedClerkTally then
// moves it from the balance to the refused list instead of retrying it forever.
export async function requiresCreditAdmission(
  tx: SQLiteTx,
  event: LedgerEvent,
  lawfulRole: VaultRole | undefined,
): Promise<boolean> {
  if (!needsCreditAdmission(event, lawfulRole)) return false;
  // Once deferred (pending or refused), a tally stays in admission until the
  // server decides; a policy change on this phone must not apply it early.
  const intent = await tx.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM credit_admission_intents WHERE event_id=?",
    event.event_id,
  );
  if (intent) return true;
  const relationshipId = (event as EntryCreatedEvent).payload?.relationship_id;
  return hardLimitApplies(tx, event.vault_id, relationshipId);
}

/** A "restrict clerks" limit covers this customer on this phone: their own
 *  limit, else the kaata default (which covers customers added since). */
export async function hardLimitApplies(
  tx: SQLiteTx,
  vaultId: string | null | undefined,
  relationshipId: string | null | undefined,
): Promise<boolean> {
  if (!vaultId || !relationshipId) return false;
  const own = await tx.getFirstAsync<{ mode: string }>(
    "SELECT mode FROM customer_credit_limits WHERE vault_id=? AND relationship_id=?",
    vaultId,
    relationshipId,
  );
  if (own) return own.mode === "clerk_block";
  const kaataDefault = await tx.getFirstAsync<{ mode: string }>(
    "SELECT mode FROM kaata_credit_defaults WHERE vault_id=?",
    vaultId,
  );
  return kaataDefault?.mode === "clerk_block";
}

// The server refused an offline clerk tally this phone had already recorded:
// a hard limit it had not pulled yet. Take it out of the balance into the
// refused list, where the clerk sees it was not recorded. Only an untouched
// created row moves; anything already built on it keeps the retry rule.
export async function revertRefusedClerkTally(
  tx: SQLiteTx,
  eventId: string,
  reason: string,
  now: number,
): Promise<boolean> {
  const row = await tx.getFirstAsync<{
    vault_id: string | null;
    event_type: string;
    payload_json: string;
    applied_at: number | null;
  }>("SELECT vault_id,event_type,payload_json,applied_at FROM event_log WHERE event_id=?", eventId);
  if (!row?.vault_id || row.event_type !== "entry_created" || row.applied_at == null) return false;
  let payload: { entry_id?: string; relationship_id?: string };
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return false;
  }
  if (!payload.entry_id || !payload.relationship_id) return false;
  const entry = await tx.getFirstAsync<{ current_event_id: string; is_settled: number }>(
    "SELECT current_event_id,is_settled FROM entries WHERE id=?",
    payload.entry_id,
  );
  if (!entry || entry.current_event_id !== eventId || entry.is_settled) return false;
  await tx.runAsync(
    "DELETE FROM entries WHERE id=? AND current_event_id=?",
    payload.entry_id,
    eventId,
  );
  await tx.runAsync(
    "UPDATE event_log SET applied_at=NULL,rejected_at=?,last_reject_reason=? WHERE event_id=?",
    now,
    reason,
    eventId,
  );
  await tx.runAsync(
    "INSERT OR REPLACE INTO credit_admission_intents(event_id,vault_id,relationship_id,status,reason) VALUES(?,?,?,'refused',?)",
    eventId,
    row.vault_id,
    payload.relationship_id,
    reason,
  );
  return true;
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
