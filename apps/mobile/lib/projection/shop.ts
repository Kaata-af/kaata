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

  let row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM shop_profile WHERE vault_id = ?`,
    event.target_id,
  );
  if (row == null) {
    // M32: create the shop_profile row on demand (mirrors the Go projection,
    // which creates it on the fly). The row is normally minted at onboarding,
    // but a JOINED/restored vault whose FIRST shop rename lands in the
    // post-cursor tail has no row yet — the old silent return was counted
    // {applied} by the sweep and lost the rename permanently. Seed a bare row
    // (empty field_hlcs) so the LWW update below applies and future updates
    // compare correctly.
    await tx.runAsync(
      `INSERT OR IGNORE INTO shop_profile
         (vault_id, owner_name, shop_name, created_at, updated_at, field_hlcs)
       VALUES (?, NULL, '', ?, ?, ?)`,
      event.target_id,
      event.hlc.pms,
      event.hlc.pms,
      serializeFieldHLCs({}),
    );
    row = { field_hlcs: serializeFieldHLCs({}) };
  }

  const current: FieldHLCMap = parseFieldHLCs(row.field_hlcs);
  const next: FieldHLCMap = { ...current };

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  let anyFieldApplied = false;

  // M33: reject null for shop_name (NOT NULL), matching Go's pointer decode.
  if ("shop_name" in c && c.shop_name != null) {
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
