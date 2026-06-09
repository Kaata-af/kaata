// applyVaultSettingSet (Phase 4 + Phase 7 local-CA).
//
// Vault-scoped key/value setting with per-(vault_id, key) LWW.
//
// The vault_settings table stores its own HLC columns (hlc_pms, hlc_l,
// hlc_did) so we can resolve LWW without an event_log join. value is
// stored as the raw payload string; callers JSON.parse it if structured.
//
// Phase 7 local-CA: a small set of RESERVED keys ("name", "currency",
// "archived_at") additionally mirror onto the vaults row so the existing
// list / picker / settings queries keep returning the latest projected
// value without joining vault_settings. The mirror is HLC-gated by the
// same comparison as the upsert above, so a stale offline write can't
// clobber a fresher state on the vaults row.

import type { SQLiteTx } from "../db-tx";
import type { VaultSettingSetEvent } from "../events";
import { compareHLC } from "../hlc";

// Reserved keys that mirror onto the vaults row. Any other key is stored
// only in vault_settings.
const RESERVED_VAULTS_MIRROR_KEYS = new Set(["name", "currency", "archived_at"]);

export async function applyVaultSettingSet(
  tx: SQLiteTx,
  event: VaultSettingSetEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_setting_set event ${event.event_id} missing envelope vault_id`);
  }

  const current = await tx.getFirstAsync<{
    hlc_pms: number;
    hlc_l: number;
    hlc_did: string;
  }>(
    `SELECT hlc_pms, hlc_l, hlc_did
       FROM vault_settings
      WHERE vault_id = ? AND key = ?`,
    event.vault_id,
    event.payload.key,
  );

  if (current != null) {
    const currentHlc = {
      pms: current.hlc_pms,
      l: current.hlc_l,
      did: current.hlc_did,
    };
    if (compareHLC(event.hlc, currentHlc) <= 0) {
      // Stale: a newer write to this (vault_id, key) is already projected.
      return;
    }
  }

  await tx.runAsync(
    `INSERT INTO vault_settings
       (vault_id, key, value, hlc_pms, hlc_l, hlc_did, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (vault_id, key) DO UPDATE SET
       value      = excluded.value,
       hlc_pms    = excluded.hlc_pms,
       hlc_l      = excluded.hlc_l,
       hlc_did    = excluded.hlc_did,
       updated_at = excluded.updated_at`,
    event.vault_id,
    event.payload.key,
    event.payload.value,
    event.hlc.pms,
    event.hlc.l,
    event.hlc.did,
    event.appended_at,
  );

  // Phase 7 D-LOCAL-CA-VAULT-OPS-ROUTER: mirror reserved keys onto the
  // vaults row so list queries keep working. The HLC gate above already
  // dropped stale writes, so the mirror is safe to apply unconditionally
  // here. Engineering critique: every UPDATE is followed by a row-count
  // check — if the vaults row didn't exist when this event landed (e.g.
  // a setting_set arrived via mesh before the corresponding vault row
  // was bootstrapped), we log a warning so the divergence shows up in
  // logs rather than silently producing a vault_settings row that
  // disagrees with the absent vaults row.
  if (RESERVED_VAULTS_MIRROR_KEYS.has(event.payload.key)) {
    switch (event.payload.key) {
      case "name": {
        const r = await tx.runAsync(
          `UPDATE vaults SET name = ?, updated_at = ? WHERE id = ?`,
          event.payload.value,
          event.appended_at,
          event.vault_id,
        );
        if (r.changes === 0) {
          console.warn(
            `[vault_setting_set] mirror UPDATE vaults.name affected 0 rows for vault_id=${event.vault_id}`,
          );
        }
        // Also mirror to shop_profile.shop_name. Without this, the home
        // header (which reads getLocalSelf → shop_profile.shop_name) stays
        // stuck on the pre-rename value while VaultPickerSheet (which reads
        // vaults.name) shows the new one. Two tables, one user-perceived
        // "name" — keep them in lockstep on every rename.
        // 0-row UPDATE is fine: a brand-new vault may not have a
        // shop_profile row yet (created lazily during onboarding); the
        // next createSelfProfile / shop_profile bootstrap will write the
        // correct value at that point.
        await tx.runAsync(
          `UPDATE shop_profile SET shop_name = ?, updated_at = ? WHERE vault_id = ?`,
          event.payload.value,
          event.appended_at,
          event.vault_id,
        );
        break;
      }
      case "currency": {
        const r = await tx.runAsync(
          `UPDATE vaults SET currency = ?, updated_at = ? WHERE id = ?`,
          event.payload.value,
          event.appended_at,
          event.vault_id,
        );
        if (r.changes === 0) {
          console.warn(
            `[vault_setting_set] mirror UPDATE vaults.currency affected 0 rows for vault_id=${event.vault_id}`,
          );
        }
        break;
      }
      case "archived_at": {
        // Value is a decimal string of wall-ms, or "" to unarchive.
        const trimmed = (event.payload.value ?? "").trim();
        const parsed = trimmed === "" ? null : Number.parseInt(trimmed, 10);
        const archivedAt = parsed != null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        const r = await tx.runAsync(
          `UPDATE vaults SET archived_at = ?, updated_at = ? WHERE id = ?`,
          archivedAt,
          event.appended_at,
          event.vault_id,
        );
        if (r.changes === 0) {
          console.warn(
            `[vault_setting_set] mirror UPDATE vaults.archived_at affected 0 rows for vault_id=${event.vault_id}`,
          );
        }
        // Archiving rotates the trust boundary: any peer still carrying a
        // VMC at the prior epoch should be refused at the next mesh
        // handshake. Mirrors the membership-events behavior in
        // vault_members.ts (UPDATE vaults SET vault_epoch = vault_epoch + 1).
        // Unarchiving (archived_at = NULL) does NOT bump — by the time
        // we unarchive, the previous archive transition already bumped
        // the epoch (so any pre-archive VMCs are already rejected); the
        // un-archive doesn't introduce a NEW trust-boundary rotation.
        // Peers will need to re-fetch a fresh VMC at the current
        // (post-archive-bump) epoch to resume syncing — the local
        // unarchive is enough to make this device participate again,
        // but a peer holding a VMC issued at the pre-archive epoch
        // stays refused at handshake until it's reissued.
        if (archivedAt != null) {
          await tx.runAsync(
            `UPDATE vaults SET vault_epoch = vault_epoch + 1 WHERE id = ?`,
            event.vault_id,
          );
        }
        break;
      }
    }
  }
}
