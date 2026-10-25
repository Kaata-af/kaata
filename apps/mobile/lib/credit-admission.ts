import type { SQLiteTx } from "./db-tx";
import type {
  EntryCreatedEvent,
  EntryAmendedEvent,
  EntryDeletedEvent,
  LedgerEvent,
  VaultRole,
} from "./events";

export class CreditMutationAdmissionError extends Error {
  constructor(readonly status: "pending" | "refused") {
    super(`credit mutation ${status}`);
    this.name = "CreditMutationAdmissionError";
  }
}

type CreditMutation = EntryCreatedEvent | EntryAmendedEvent | EntryDeletedEvent;
function isCreditMutation(event: LedgerEvent): event is CreditMutation {
  return (
    event.event_type === "entry_created" ||
    event.event_type === "entry_amended" ||
    event.event_type === "entry_deleted"
  );
}

/** A cloud snapshot may have the entry but none of its original events. Keep
 * a durable before-image so a later server refusal can restore that money. */
export async function captureCreditMutationBaseline(
  tx: SQLiteTx,
  event: LedgerEvent,
): Promise<void> {
  if (
    event.server_acked_at != null ||
    (event.event_type !== "entry_amended" && event.event_type !== "entry_deleted")
  )
    return;
  const row = await tx.getFirstAsync<Record<string, unknown>>(
    "SELECT * FROM entries WHERE id=? AND vault_id=?",
    event.target_id,
    event.vault_id,
  );
  if (!row) return;
  await tx.runAsync(
    "DELETE FROM credit_mutation_baselines WHERE vault_id=? AND event_id IN (SELECT event_id FROM event_log WHERE server_acked_at IS NOT NULL)",
    event.vault_id,
  );
  await tx.runAsync(
    "INSERT OR IGNORE INTO credit_mutation_baselines(event_id,vault_id,entry_id,row_json) VALUES(?,?,?,?)",
    event.event_id,
    event.vault_id,
    event.target_id,
    JSON.stringify(row),
  );
}

export function needsCreditAdmission(
  event: LedgerEvent,
  lawfulRole: VaultRole | undefined,
): boolean {
  return (
    isCreditMutation(event) &&
    (lawfulRole === "clerk" || lawfulRole === "editor") &&
    event.server_acked_at == null
  );
}

// Warning-only and unlimited customers stay usable offline. Known hard rules
// hold covered members' financial changes until authenticated acknowledgement.
// Policies not yet cached here are checked on push; refused optimistic changes
// are restored from lawful evidence rather than retried as money forever.
export async function requiresCreditAdmission(
  tx: SQLiteTx,
  event: LedgerEvent,
  lawfulRole: VaultRole | undefined,
  trustedAccountId?: string | null,
): Promise<boolean> {
  if (!isCreditMutation(event) || event.server_acked_at != null) return false;
  // Once deferred (pending or refused), a tally stays in admission until the
  // server decides; a policy change on this phone must not apply it early.
  const intent = await tx.getFirstAsync<{ n: number }>(
    "SELECT 1 AS n FROM credit_admission_intents WHERE event_id=?",
    event.event_id,
  );
  if (intent) return true;
  if (!needsCreditAdmission(event, lawfulRole)) return false;
  if (event.origin === "local" && event.event_type !== "entry_created") {
    const prior = await tx.getFirstAsync<{ event_id: string }>(
      "SELECT i.event_id FROM credit_admission_intents i JOIN event_log e ON e.event_id=i.event_id WHERE e.vault_id=? AND e.target_id=? AND i.status='pending' AND e.server_acked_at IS NULL AND e.event_id<>? LIMIT 1",
      event.vault_id,
      event.target_id,
      event.event_id,
    );
    if (prior) throw new CreditMutationAdmissionError("pending");
  }
  // Note/date-only edits do not move exposure and need no server round trip.
  if (
    event.event_type === "entry_amended" &&
    event.payload.changes.amount_afn === undefined &&
    event.payload.changes.type === undefined
  )
    return false;
  const relationshipId =
    event.event_type === "entry_created" ? event.payload.relationship_id : event.relationship_id;
  return hardLimitApplies(
    tx,
    event.vault_id,
    relationshipId,
    lawfulRole,
    trustedAccountId ?? (event.origin === "local" ? event.actor_account_id : null),
  );
}

/** A "restrict clerks" limit covers this customer on this phone: their own
 *  limit, else the kaata default (which covers customers added since). */
export async function hardLimitApplies(
  tx: SQLiteTx,
  vaultId: string | null | undefined,
  relationshipId: string | null | undefined,
  role: VaultRole | undefined = "clerk",
  accountId?: string | null,
): Promise<boolean> {
  if (!vaultId || !relationshipId) return false;
  if (role !== "clerk" && role !== "editor") return false;
  const own = await tx.getFirstAsync<{ mode: string; restrict_editors: number }>(
    "SELECT mode,restrict_editors FROM customer_credit_limits WHERE vault_id=? AND relationship_id=?",
    vaultId,
    relationshipId,
  );
  const policy =
    own ??
    (await tx.getFirstAsync<{ mode: string; restrict_editors: number }>(
      "SELECT mode,restrict_editors FROM kaata_credit_defaults WHERE vault_id=?",
      vaultId,
    ));
  if (policy?.mode !== "clerk_block") return false;
  const override = accountId
    ? await tx.getFirstAsync<{ credit_limit_override: string }>(
        "SELECT credit_limit_override FROM vault_member_credit_permissions WHERE vault_id=? AND account_id=?",
        vaultId,
        accountId,
      )
    : null;
  if (override?.credit_limit_override === "bypass") return false;
  if (override?.credit_limit_override === "enforce") return true;
  return role === "clerk" || !!policy.restrict_editors;
}

// Undo optimistic money the server refused under a policy not yet cached on
// this phone. Preserve the other applied evidence and independent review flags.
export async function revertRefusedClerkTally(
  tx: SQLiteTx,
  eventId: string,
  reason: string,
  now: number,
): Promise<boolean> {
  const row = await tx.getFirstAsync<{
    vault_id: string | null;
    event_type: string;
    target_id: string;
    relationship_id: string | null;
    payload_json: string;
    applied_at: number | null;
  }>(
    "SELECT vault_id,event_type,target_id,relationship_id,payload_json,applied_at FROM event_log WHERE event_id=?",
    eventId,
  );
  if (
    !row?.vault_id ||
    !["entry_created", "entry_amended", "entry_deleted"].includes(row.event_type) ||
    row.applied_at == null
  )
    return false;
  let payload: { entry_id?: string; relationship_id?: string };
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return false;
  }
  const entryId = row.target_id || payload.entry_id;
  const relationshipId = row.relationship_id || payload.relationship_id;
  if (!entryId || !relationshipId) return false;
  const history = await tx.getAllAsync<Record<string, any>>(
    "SELECT * FROM event_log WHERE vault_id=? AND target_id=? AND event_id<>? AND event_type IN ('entry_created','entry_amended','entry_deleted') AND applied_at IS NOT NULL AND rejected_at IS NULL ORDER BY hlc_physical_ms,hlc_logical,hlc_device_id",
    row.vault_id,
    entryId,
    eventId,
  );
  const baseline = await tx.getFirstAsync<{ row_json: string }>(
    "SELECT b.row_json FROM credit_mutation_baselines b JOIN event_log e ON e.event_id=b.event_id WHERE b.vault_id=? AND b.entry_id=? ORDER BY b.rowid LIMIT 1",
    row.vault_id,
    entryId,
  );
  const hasCreate = history.some((stored) => stored.event_type === "entry_created");
  // Older clients may have neither a before-image nor creation evidence. Do
  // not erase a lawful snapshot row because its history is absent locally.
  if (row.event_type !== "entry_created" && !hasCreate && !baseline) return false;
  const metadata = await tx.getFirstAsync<{
    accepted_at: number | null;
    disputed_at: number | null;
    disputed_reason: string | null;
    settled_at: number | null;
    is_settled: number;
  }>(
    "SELECT accepted_at,disputed_at,disputed_reason,settled_at,is_settled FROM entries WHERE id=? AND vault_id=?",
    entryId,
    row.vault_id,
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
    relationshipId,
    reason,
  );
  // Rebuild just this entry from its remaining applied evidence. An editor
  // can have changed money before this phone learned a new restriction; a
  // rejected edit/deletion must restore the last lawful amount and fields.
  if (row.event_type === "entry_created") {
    // Descendants of a refused creation have no admitted base on the server.
    await tx.runAsync(
      "UPDATE event_log SET applied_at=NULL,rejected_at=?,last_reject_reason=? WHERE vault_id=? AND target_id=? AND event_type IN ('entry_amended','entry_deleted') AND server_acked_at IS NULL",
      now,
      reason,
      row.vault_id,
      entryId,
    );
  }
  await tx.runAsync("DELETE FROM entries WHERE id=? AND vault_id=?", entryId, row.vault_id);
  if (!hasCreate && baseline && row.event_type !== "entry_created") {
    const previous = JSON.parse(baseline.row_json) as Record<string, unknown>;
    if (previous.id !== entryId || previous.vault_id !== row.vault_id)
      throw new Error("Invalid credit mutation baseline");
    const columns = await tx.getAllAsync<{ name: string }>("PRAGMA table_info(entries)");
    const names = columns.map((column) => column.name).filter((name) => name in previous);
    await tx.runAsync(
      `INSERT INTO entries (${names.map((name) => '"' + name.replace(/"/g, '""') + '"').join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      ...names.map((name) => previous[name] as string | number | null),
    );
  }
  const { applyEntryCreated, applyEntryAmended, applyEntryDeleted } = await import(
    "./projection/entries"
  );
  for (const stored of row.event_type === "entry_created" ? [] : history) {
    const event = {
      ...stored,
      payload: JSON.parse(stored.payload_json),
      hlc: { pms: stored.hlc_physical_ms, l: stored.hlc_logical, did: stored.hlc_device_id },
      author_user_id_local_only: stored.author_user_id_local_only ?? "",
    } as LedgerEvent;
    if (event.event_type === "entry_created") await applyEntryCreated(tx, event);
    else if (event.event_type === "entry_amended") await applyEntryAmended(tx, event);
    else if (event.event_type === "entry_deleted") await applyEntryDeleted(tx, event);
  }
  if (metadata && row.event_type !== "entry_created")
    await tx.runAsync(
      "UPDATE entries SET accepted_at=?,disputed_at=?,disputed_reason=?,settled_at=?,is_settled=? WHERE id=? AND vault_id=?",
      metadata.accepted_at,
      metadata.disputed_at,
      metadata.disputed_reason,
      metadata.settled_at,
      metadata.is_settled,
      entryId,
      row.vault_id,
    );
  return true;
}

// A clerk's durable intent is visible separately from recorded money until
// HTTPS acknowledgement. Mesh receipt cannot satisfy this prerequisite.
export async function deferCreditAdmission(tx: SQLiteTx, event: CreditMutation): Promise<void> {
  await tx.runAsync(
    "UPDATE event_log SET applied_at=NULL,quarantine_reason='missing_prereq' WHERE event_id=?",
    event.event_id,
  );
  await tx.runAsync(
    "INSERT OR IGNORE INTO credit_admission_intents(event_id,vault_id,relationship_id,status,reason) VALUES(?,?,?,'pending',NULL)",
    event.event_id,
    event.vault_id,
    event.event_type === "entry_created" ? event.payload.relationship_id : event.relationship_id,
  );
}
