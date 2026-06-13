// Fold-target appliers for vault_device_* events (M2 membership chain,
// docs/m2-membership-chain.md §6).
//
// vault_device_registry (migration 019) materializes the device-binding
// half of the membership chain: which Ed25519 device pubkeys are bound to
// which account in each vault, and whether the binding is currently live.
// The role-gate's chain-backed source (M2b) reads this table to
// authenticate a remote event's signer without the legacy
// vault_credentials VMC cache.
//
// IMPORTANT: appliers do NOT authorize. Whether the signer was an
// owner-bound device / carried a valid server witness is the job of the
// role-gate and the pure chain fold (lib/trust/chain.ts). These functions
// only FOLD an already-accepted event into the registry — exactly like
// applyVaultMemberAdded folds into vault_members_mirror. A device-add the
// chain would refuse never reaches this applier (role-gate runs first in
// applyEvent), and the at-HLC history stays in event_log regardless.

import type { SQLiteTx } from "../db-tx";
import type { VaultDeviceAddedEvent, VaultDeviceRemovedEvent } from "../events";
import { compareHLC } from "../hlc";
import { invalidateVaultRoleCache } from "../use-vault-role";

// HLC sidecar lookup, mirroring readLatestRoleEventHlc in vault_members.ts
// (ARCH #3 rationale documented there): the latest projected HLC for this
// (vault_id, device_id) cell is resolved by scanning event_log rather than
// carrying HLC columns on vault_device_registry. target_id = device_id for
// device events (stamped by the append helpers in lib/event-log.ts), so
// idx_event_log_vault_type_target / idx_event_log_membership bound the scan.
// applyEvent has ALREADY INSERTED the current event's row by the time the
// applier runs, so it is excluded via event_id != ?.
async function readLatestDeviceEventHlc(
  tx: SQLiteTx,
  vaultId: string,
  deviceId: string,
  excludingEventId: string,
): Promise<{ pms: number; l: number; did: string } | null> {
  const row = await tx.getFirstAsync<{
    hlc_physical_ms: number;
    hlc_logical: number;
    hlc_device_id: string;
  }>(
    // SECURITY (M2 review): only APPLIED rows may shadow this cell. A
    // role-gate-refused event stays in event_log with applied_at=NULL +
    // quarantine_reason (projection/index.ts) — it never mutated the
    // registry, so it must not block a legitimate later add/remove either.
    // Without this filter, any member could author an unauthorized
    // far-future vault_device_* event that quarantines everywhere yet
    // out-HLCs (and so suppresses) the owner's real removal — a revocation
    // bypass + gate/fold divergence (the fold ignores it; the apply path
    // honored it).
    `SELECT hlc_physical_ms, hlc_logical, hlc_device_id
       FROM event_log
      WHERE vault_id = ?
        AND event_type IN ('vault_device_added','vault_device_removed')
        AND target_id = ?
        AND event_id != ?
        AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL
      ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT 1`,
    vaultId,
    deviceId,
    excludingEventId,
  );
  if (row == null) return null;
  return {
    pms: row.hlc_physical_ms,
    l: row.hlc_logical,
    did: row.hlc_device_id,
  };
}

/**
 * applyVaultDeviceAdded
 *
 * HLC-aware upsert: if a later vault_device_* event for the same
 * (vault_id, device_id) cell already lives in event_log, this add is a
 * stale offline write and we drop it — INSERT OR REPLACE unconditionally
 * would clobber a more recent removal. PRIMARY KEY (vault_id,
 * device_pubkey) makes the apply path idempotent (duplicate backfill
 * admissions are no-ops state-wise); the HLC compare gates correctness
 * under out-of-order delivery.
 *
 * When the incoming HLC wins, INSERT OR REPLACE with removed_at_ms = NULL
 * lifts a prior removal — re-add semantics, matching the chain fold's
 * bindDevice (existing.removed = false on re-bind).
 *
 * added_at_ms = event.hlc.pms: the AUTHOR's clock, deterministic across
 * replicas (unlike appended_at, which is receive-local). Same choice for
 * removed_at_ms below — every replica folds to byte-identical registry rows.
 */
export async function applyVaultDeviceAdded(
  tx: SQLiteTx,
  event: VaultDeviceAddedEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_device_added event ${event.event_id} missing envelope vault_id`);
  }

  const currentHlc = await readLatestDeviceEventHlc(
    tx,
    event.vault_id,
    event.payload.device_id,
    event.event_id,
  );
  if (currentHlc != null && compareHLC(event.hlc, currentHlc) <= 0) {
    // A later device-binding event has already been projected.
    return;
  }

  await tx.runAsync(
    `INSERT OR REPLACE INTO vault_device_registry
       (vault_id, device_pubkey, device_id, account_id, added_at_ms, removed_at_ms)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    event.vault_id,
    event.payload.device_pubkey,
    event.payload.device_id,
    event.payload.account_id,
    event.hlc.pms,
  );

  // The registry feeds the role-gate's chain-backed source (M2b); a new
  // binding can change how the next render's role resolves.
  invalidateVaultRoleCache(event.vault_id);
}

/**
 * applyVaultDeviceRemoved
 *
 * Sticky tombstone: sets removed_at_ms and never clears it from this
 * applier. A subsequent vault_device_added is the only way back, and
 * INSERT OR REPLACE in applyVaultDeviceAdded explicitly resets
 * removed_at_ms to NULL.
 *
 * The payload carries only device_id (per docs §2 — the remover may not
 * know the pubkey), so the UPDATE keys on (vault_id, device_id) and
 * tombstones every pubkey row that device ever bound — matching the chain
 * fold, which removes by device_id too.
 *
 * HLC compare guards against a stale remove arriving after a more recent
 * re-add, same as applyVaultMemberRemoved.
 */
export async function applyVaultDeviceRemoved(
  tx: SQLiteTx,
  event: VaultDeviceRemovedEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_device_removed event ${event.event_id} missing envelope vault_id`);
  }

  const currentHlc = await readLatestDeviceEventHlc(
    tx,
    event.vault_id,
    event.payload.device_id,
    event.event_id,
  );
  if (currentHlc != null && compareHLC(event.hlc, currentHlc) <= 0) {
    return;
  }

  await tx.runAsync(
    `UPDATE vault_device_registry
        SET removed_at_ms = ?, removed_at_l = ?, removed_at_did = ?
      WHERE vault_id = ?
        AND device_id = ?
        AND removed_at_ms IS NULL`,
    event.hlc.pms,
    event.hlc.l,
    event.hlc.did,
    event.vault_id,
    event.payload.device_id,
  );
  // No-op UPDATE (unknown device / already removed) is fine: the event
  // stays in event_log and a late-arriving vault_device_added respects
  // this event's HLC via the sidecar lookup above.

  invalidateVaultRoleCache(event.vault_id);
}
