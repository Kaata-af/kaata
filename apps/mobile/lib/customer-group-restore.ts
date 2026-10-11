import type { SQLiteTx } from "./db-tx";
import { parseFieldHLCs, serializeFieldHLCs, type FieldHLCMap } from "./projection/field-hlc";

export type SnapshotCustomerGroup = {
  id: string;
  vault_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  field_hlcs: FieldHLCMap;
};

export async function seedSnapshotCustomerGroups(
  tx: SQLiteTx,
  vaultId: string,
  groups: readonly SnapshotCustomerGroup[] | undefined,
): Promise<void> {
  for (const group of groups ?? []) {
    if (group.vault_id !== vaultId) throw new Error("snapshot group vault mismatch");
    await tx.runAsync(
      `INSERT OR REPLACE INTO customer_groups
      (vault_id,id,name,created_at,updated_at,archived_at,field_hlcs) VALUES (?,?,?,?,?,?,?)`,
      group.vault_id,
      group.id,
      group.name,
      group.created_at,
      group.updated_at,
      group.archived_at,
      serializeFieldHLCs(group.field_hlcs ?? {}),
    );
  }
}

/** Keep old archive seed behavior while restoring exact new group registers. */
export function restoredRelationshipFieldHLCs(
  archiveFloor: string,
  groups: FieldHLCMap | undefined,
): string {
  return serializeFieldHLCs({ ...parseFieldHLCs(archiveFloor), ...(groups ?? {}) });
}
