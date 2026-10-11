import type { SQLiteTx } from "../db-tx";
import type { CustomerGroupEvent, PersonGroupSetEvent } from "../events";
import { isValidGroupName, normalizeGroupName } from "../group-name";
import { MissingPrereqError } from "./errors";
import { compareFieldHLC, parseFieldHLCs, serializeFieldHLCs } from "./field-hlc";

/** Archive is a tombstone. It never deletes contacts/assignments or balances. */
export async function applyCustomerGroup(tx: SQLiteTx, event: CustomerGroupEvent): Promise<void> {
  if (!event.vault_id || !event.target_id) throw new Error("group missing vault/target");
  const row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    "SELECT field_hlcs FROM customer_groups WHERE vault_id = ? AND id = ?",
    event.vault_id,
    event.target_id,
  );
  if (event.event_type === "group_created") {
    if (!isValidGroupName(event.payload.name)) throw new Error("invalid group name");
    // A repeated create cannot reset rename/archive state.
    if (row) return;
    await tx.runAsync(
      `INSERT INTO customer_groups
      (vault_id,id,name,created_at,updated_at,archived_at,field_hlcs) VALUES (?,?,?,?,?,NULL,?)`,
      event.vault_id,
      event.target_id,
      normalizeGroupName(event.payload.name),
      event.hlc.pms,
      event.hlc.pms,
      serializeFieldHLCs({ name: event.hlc }),
    );
    return;
  }
  if (!row) throw new MissingPrereqError(`group ${event.target_id} missing`);
  const hlcs = parseFieldHLCs(row.field_hlcs);
  const field = event.event_type === "group_renamed" ? "name" : "archived_at";
  if (compareFieldHLC(hlcs, field, event.hlc) === "skip") return;
  hlcs[field] = event.hlc;
  if (event.event_type === "group_renamed") {
    if (!isValidGroupName(event.payload.name)) throw new Error("invalid group name");
    await tx.runAsync(
      `UPDATE customer_groups SET name=?,updated_at=MAX(updated_at,?),field_hlcs=?
      WHERE vault_id=? AND id=?`,
      normalizeGroupName(event.payload.name),
      event.hlc.pms,
      serializeFieldHLCs(hlcs),
      event.vault_id,
      event.target_id,
    );
  } else {
    await tx.runAsync(
      `UPDATE customer_groups SET archived_at=?,updated_at=MAX(updated_at,?),field_hlcs=?
      WHERE vault_id=? AND id=?`,
      event.hlc.pms,
      event.hlc.pms,
      serializeFieldHLCs(hlcs),
      event.vault_id,
      event.target_id,
    );
  }
}

export async function applyPersonGroupSet(tx: SQLiteTx, event: PersonGroupSetEvent): Promise<void> {
  if (!event.vault_id || event.relationship_id !== event.target_id)
    throw new Error("person_group_set must target its own relationship");
  const row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    "SELECT field_hlcs FROM relationships WHERE vault_id=? AND id=?",
    event.vault_id,
    event.target_id,
  );
  if (!row) throw new MissingPrereqError(`relationship ${event.target_id} missing`);
  const hlcs = parseFieldHLCs(row.field_hlcs);
  if (compareFieldHLC(hlcs, "group_id", event.hlc) === "skip") return;
  const groupId = event.payload.group_id;
  if (groupId !== null && typeof groupId !== "string") throw new Error("invalid group id");
  if (groupId !== null) {
    const group = await tx.getFirstAsync<{ id: string }>(
      "SELECT id FROM customer_groups WHERE vault_id=? AND id=?",
      event.vault_id,
      groupId,
    );
    if (!group) throw new MissingPrereqError(`group ${groupId} missing in vault`);
  }
  await tx.runAsync(
    `UPDATE relationships SET group_id=?,field_hlcs=?
    WHERE vault_id=? AND id=?`,
    groupId,
    serializeFieldHLCs({ ...hlcs, group_id: event.hlc }),
    event.vault_id,
    event.target_id,
  );
}
