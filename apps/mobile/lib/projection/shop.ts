// Projection applier for shop_profile_updated events.
//
// Phase 4: per-field LWW HLC bookkeeping on shop_name and owner_name.
// Each shop_profile row carries a field_hlcs JSON sidecar column
// (migration 009).

import type { SQLiteTx } from "../db-tx";
import type { ShopProfileUpdatedEvent } from "../events";
import { compareFieldHLC, parseFieldHLCs, serializeFieldHLCs, type FieldHLCMap } from "./field-hlc";

export async function applyShopProfileUpdated(
  tx: SQLiteTx,
  event: ShopProfileUpdatedEvent,
): Promise<void> {
  // After migration 007 shop_profile is keyed by vault_id. target_id IS
  // the vault_id (set on the envelope by appendShopProfileUpdated).
  const c = event.payload.changes;

  const row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM shop_profile WHERE vault_id = ?`,
    event.target_id,
  );
  if (row == null) {
    // shop_profile row is created during onboarding before any
    // shop_profile_updated can be authored locally. If we receive an
    // update for a vault whose shop_profile we haven't pulled yet,
    // drop and let the next pull pick up the create.
    return;
  }

  const current: FieldHLCMap = parseFieldHLCs(row.field_hlcs);
  const next: FieldHLCMap = { ...current };

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  let anyFieldApplied = false;

  if ("shop_name" in c && c.shop_name !== undefined) {
    if (compareFieldHLC(current, "shop_name", event.hlc) === "apply") {
      sets.push("shop_name = ?");
      args.push(c.shop_name);
      next["shop_name"] = event.hlc;
      anyFieldApplied = true;
    }
  }
  if ("owner_name" in c) {
    if (compareFieldHLC(current, "owner_name", event.hlc) === "apply") {
      sets.push("owner_name = ?");
      args.push(c.owner_name ?? null);
      next["owner_name"] = event.hlc;
      anyFieldApplied = true;
    }
  }

  if (!anyFieldApplied) return;

  sets.push("updated_at = ?");
  args.push(event.hlc.pms);
  sets.push("field_hlcs = ?");
  args.push(serializeFieldHLCs(next));

  args.push(event.target_id);

  await tx.runAsync(`UPDATE shop_profile SET ${sets.join(", ")} WHERE vault_id = ?`, ...args);
}
