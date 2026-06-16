// Mirror table appliers for vault_member_* events (Phase 4).
//
// The authoritative ACL lives on the server in vault_members (Phase 2
// migration 006). vault_members_mirror is a local cache that lets the
// mobile UI render role-gated affordances (useVaultRole / useVaultPermission)
// without a network roundtrip per render.
//
// Closes Phase 3 caveat #2: prior to Phase 4, pull would throw inside
// applyEvent for these event types and silently skip them. With these
// appliers registered, vault_member_added / role_changed / removed now
// keep vault_members_mirror coherent with server state.
//
// PHASE 4 ARCHITECTURE NOTE (ARCH #1):
// The server does NOT currently emit vault_member_* events into the
// `events` table — it writes vault_members + vault_audit_log directly
// in vaults/service.go. These appliers are wired ahead of the producer
// so when (Phase 4.1 or Phase 5) the server starts emitting the events,
// existing clients already have correct projection semantics. Until
// then, vault_members_mirror is seeded by a periodic GET /v1/vaults
// reconciliation pull (lib/sync/vaults-reconcile.ts) and the appliers
// here act as belt-and-suspenders. The mirror is read-only — clients
// never write membership locally.

import type { SQLiteTx } from "../db-tx";
import type {
  VaultMemberAddedEvent,
  VaultMemberRemovedEvent,
  VaultMemberRoleChangedEvent,
} from "../events";
import { compareHLC } from "../hlc";
import { invalidateVaultRoleCache } from "../use-vault-role";

// HLC sidecar lookup. We snapshot the latest projected HLC for the
// (vault_id, account_id) cell by scanning event_log for both
// vault_member_added and vault_member_role_changed events excluding the
// event currently being applied. Returns null when no prior event
// targets this cell.
//
// ARCH #3: the lookup queries event_log rather than carrying HLC
// columns on vault_members_mirror itself because:
//   1. The mirror is a small auxiliary table (<= members count) so a
//      JSON sidecar column would be overkill;
//   2. event_log is indexed on (vault_id, event_type, target_id, hlc)
//      via idx_event_log_target so the scan is bounded;
//   3. applyEvent has ALREADY INSERTED the current event_log row by the
//      time the applier runs, so we exclude it via event_id != ?.
async function readLatestRoleEventHlc(
  tx: SQLiteTx,
  vaultId: string,
  accountId: string,
  excludingEventId: string,
): Promise<{ pms: number; l: number; did: string } | null> {
  const row = await tx.getFirstAsync<{
    hlc_physical_ms: number;
    hlc_logical: number;
    hlc_device_id: string;
  }>(
    // SECURITY (M2 review): only APPLIED rows may shadow this cell — a
    // role-gate-refused event (applied_at NULL + quarantine_reason) never
    // mutated the mirror and must not block a later legitimate change.
    // Mirrors the same fix in vault_devices.ts readLatestDeviceEventHlc.
    `SELECT hlc_physical_ms, hlc_logical, hlc_device_id
       FROM event_log
      WHERE vault_id = ?
        AND event_type IN
              ('vault_member_added','vault_member_role_changed','vault_member_removed')
        AND target_id = ?
        AND event_id != ?
        AND applied_at IS NOT NULL
        AND quarantine_reason IS NULL
      ORDER BY hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC
      LIMIT 1`,
    vaultId,
    accountId,
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
 * applyVaultMemberAdded
 *
 * HLC-aware upsert (ARCH #3): if a later vault_member_* event for the
 * same (vault_id, account_id) cell already lives in event_log, this
 * add is a stale offline write and we drop it. INSERT OR REPLACE
 * unconditionally would otherwise clobber a more recent role change
 * with the original-add's role. PRIMARY KEY (vault_id, account_id)
 * makes the apply path idempotent; the HLC compare gates correctness
 * under out-of-order delivery.
 *
 * When the incoming HLC wins, INSERT OR REPLACE is used so a re-add
 * after a prior remove clears revoked_at.
 */
export async function applyVaultMemberAdded(
  tx: SQLiteTx,
  event: VaultMemberAddedEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_member_added event ${event.event_id} missing envelope vault_id`);
  }

  const currentHlc = await readLatestRoleEventHlc(
    tx,
    event.vault_id,
    event.payload.account_id,
    event.event_id,
  );
  if (currentHlc != null && compareHLC(event.hlc, currentHlc) <= 0) {
    // A later role/membership event has already been projected.
    return;
  }

  // Preserve display_name across name-less re-applies. The old INSERT OR REPLACE
  // dropped + reinserted the row WITHOUT display_name, so every time the owner's
  // genesis vault_member_added (which carries no name) was gossiped, it reset
  // the row's display_name to NULL — wiping the name the joiner seeded from the
  // QR. That's the "peer renders as their role label instead of a name" bug, and
  // why a re-scan made it worse. UPSERT with COALESCE keeps any stored name
  // unless this event actually carries one; revoked_at is explicitly cleared so
  // a re-add after a remove still works (the behaviour OR REPLACE gave us).
  await tx.runAsync(
    `INSERT INTO vault_members_mirror
       (vault_id, account_id, role, accepted_at, revoked_at, display_name)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT(vault_id, account_id) DO UPDATE SET
       role         = excluded.role,
       accepted_at  = excluded.accepted_at,
       revoked_at   = NULL,
       display_name = COALESCE(excluded.display_name, vault_members_mirror.display_name)`,
    event.vault_id,
    event.payload.account_id,
    event.payload.role,
    event.appended_at,
    event.payload.display_name ?? null,
  );

  // M2 (review P0): GENESIS anchor binding. The chain fold (lib/trust/
  // chain.ts) binds the owner's anchor device IMPLICITLY at genesis, but
  // nothing else writes that binding into vault_device_registry (genesis
  // emits no vault_device_added). Without it, a JOINER receiving the
  // owner's genesis/owner events finds no signer binding in the registry,
  // so lookupSignerCredential returns unknown_actor and quarantines every
  // owner event — gate refuses what the handshake-fold accepts, and past
  // the 64-row unknown_actor cap sync stalls (the joiner sees an empty
  // vault). Seed it here: when this member_added is signed by the vault's
  // trust anchor and admits an owner (genesis self-admission), bind
  // (anchor_pubkey -> device_id, owner account). The "no existing row"
  // guard keeps it genesis-scoped and idempotent.
  if (
    event.payload.role === "owner" &&
    typeof event.signer_device_pubkey === "string" &&
    event.signer_device_pubkey.length > 0
  ) {
    const anchorRow = await tx.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
      `SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ? LIMIT 1`,
      event.vault_id,
    );
    if (
      anchorRow?.vault_trust_anchor_pubkey != null &&
      anchorRow.vault_trust_anchor_pubkey === event.signer_device_pubkey
    ) {
      // Authoritative owner binding. UPSERT (was guarded INSERT) so it lands
      // even when the pair-time QR seed (pair-scan.tsx, placeholder device_id)
      // already inserted this (vault_id, pubkey) — correcting device_id +
      // account_id to the real chain values and clearing any removal. Without
      // the seed coexisting, the joiner couldn't authorize the owner's ledger
      // until this genesis replicated (often never, on a fresh pair).
      await tx.runAsync(
        `INSERT INTO vault_device_registry
           (vault_id, device_pubkey, device_id, account_id, added_at_ms, removed_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(vault_id, device_pubkey) DO UPDATE SET
           device_id = excluded.device_id,
           account_id = excluded.account_id,
           removed_at_ms = NULL`,
        event.vault_id,
        event.signer_device_pubkey,
        event.device_id,
        event.payload.account_id,
        event.hlc.pms,
      );
    } else if (event.origin === "remote") {
      // A remote genesis owner-admission applied but its signer != our pinned
      // anchor, so the owner binding is NOT seeded and the owner's ledger
      // events will quarantine as unknown_actor. Loud so this silent path is
      // visible if it ever happens (should not — the QR pins this same anchor).
      console.warn(
        "[vault_members] genesis owner member_added signer != vault anchor — registry NOT seeded",
        { vault: event.vault_id.slice(0, 8) },
      );
    }
  }

  // ENG #8 fix: lift any matching revocation_list rows for the
  // re-added account's devices. Without this, removed-then-re-added
  // devices stay permanently refused at mesh handshake even though
  // their account is welcome again on the mirror.
  //
  // Implementation: vault_credentials.account_id -> device_id rows for
  // this account are the candidates. UPDATE revocation_list SET
  // lifted_at = appended_at WHERE (vault_id, device_id) matches and
  // lifted_at IS NULL. isRevoked() in lib/trust/revocation.ts now ignores
  // rows where lifted_at IS NOT NULL.
  const deviceRows = await tx.getAllAsync<{ device_id: string }>(
    `SELECT device_id FROM vault_credentials
      WHERE vault_id = ? AND account_id = ?`,
    event.vault_id,
    event.payload.account_id,
  );
  for (const { device_id } of deviceRows) {
    await tx.runAsync(
      `UPDATE revocation_list
          SET lifted_at = ?
        WHERE vault_id = ? AND device_id = ? AND lifted_at IS NULL`,
      event.appended_at,
      event.vault_id,
      device_id,
    );
  }

  // Invalidate the role cache so the next render reads fresh state.
  invalidateVaultRoleCache(event.vault_id);
}

/**
 * applyVaultMemberRoleChanged
 *
 * Per-field LWW on `role`: we resolve the role's "current HLC" by
 * joining back through event_log, looking for the most recent
 * vault_member_added / vault_member_role_changed / vault_member_removed
 * event targeting the same (vault_id, account_id). If the incoming
 * event's HLC is older than the resolved current HLC, we drop it — a
 * later membership-affecting event has already been projected and this
 * one is a stale offline write.
 *
 * If the mirror row is missing entirely (no add seen yet), we still
 * record the role change in event_log (already done by applyEvent step
 * 2) but emit a debug warning so the diagnostic surface flags it. The
 * subsequent vault_member_added applier above will respect this
 * event's HLC and stay out of the way if the late add arrives after.
 */
export async function applyVaultMemberRoleChanged(
  tx: SQLiteTx,
  event: VaultMemberRoleChangedEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_member_role_changed event ${event.event_id} missing envelope vault_id`);
  }

  const currentHlc = await readLatestRoleEventHlc(
    tx,
    event.vault_id,
    event.payload.account_id,
    event.event_id,
  );
  if (currentHlc != null && compareHLC(event.hlc, currentHlc) <= 0) {
    // Stale: a later role-affecting event is already projected.
    return;
  }

  const result = await tx.runAsync(
    `UPDATE vault_members_mirror
        SET role = ?
      WHERE vault_id = ?
        AND account_id = ?`,
    event.payload.role,
    event.vault_id,
    event.payload.account_id,
  );
  if (result.changes === 0) {
    // ENG #13 / ARCH #3 mitigation: mirror row missing → either the
    // matching vault_member_added has not yet arrived, or sync has
    // dropped the cell. Surface a warning so dev builds spot the
    // ordering drift; production silently leaves the event in
    // event_log so a later applyVaultMemberAdded can read its HLC
    // and refuse to clobber.
    console.warn(
      `[projection/vault_members] role_changed for missing mirror row vault=${event.vault_id} account=${event.payload.account_id}`,
    );
  }

  // D-OFFLINE-ROLE-CHANGE: bump vault_epoch on every applied role change
  // so peers carrying a VMC minted under the OLD role get rejected at
  // the next mesh handshake (anti-entropy.ts:573-583 — strict-less
  // compare on peer_epoch < ours). Their next online check-in (or mesh
  // re-pair) re-issues a VMC at the new epoch with the new role baked in.
  //
  // This mirrors the backend behaviour in vaults/service.go where
  // SetMemberRole calls bumpEpoch() in the same transaction. Keeping
  // both sides bumping at the same projection step means a server-emitted
  // role-change event and a locally-emitted one converge to the same
  // epoch high-water mark across mesh-connected devices.
  //
  // Bump is gated on the actual UPDATE happening — if the mirror row
  // was missing (changes === 0) we skip the bump too, since there's no
  // membership context to invalidate. The late-arriving
  // vault_member_added applier will not bump either (it's a join, not a
  // role transition).
  if (result.changes > 0) {
    await tx.runAsync(
      `UPDATE vaults
          SET vault_epoch = vault_epoch + 1
        WHERE id = ?`,
      event.vault_id,
    );
  }

  invalidateVaultRoleCache(event.vault_id);
}

/**
 * applyVaultMemberRemoved
 *
 * Sticky tombstone: sets revoked_at and never clears it from this applier.
 * A subsequent vault_member_added is the only way back, and INSERT OR
 * REPLACE in applyVaultMemberAdded explicitly clears revoked_at.
 *
 * HLC compare here guards against a stale remove arriving after a more
 * recent re-add: under correct ordering the prior add's HLC predates
 * the remove, but offline batches and mesh delivery can reverse it.
 */
export async function applyVaultMemberRemoved(
  tx: SQLiteTx,
  event: VaultMemberRemovedEvent,
): Promise<void> {
  if (event.vault_id == null) {
    throw new Error(`vault_member_removed event ${event.event_id} missing envelope vault_id`);
  }
  const currentHlc = await readLatestRoleEventHlc(
    tx,
    event.vault_id,
    event.payload.account_id,
    event.event_id,
  );
  if (currentHlc != null && compareHLC(event.hlc, currentHlc) <= 0) {
    return;
  }
  const updateResult = await tx.runAsync(
    `UPDATE vault_members_mirror
        SET revoked_at = ?
      WHERE vault_id = ?
        AND account_id = ?
        AND revoked_at IS NULL`,
    event.appended_at,
    event.vault_id,
    event.payload.account_id,
  );

  // ENG #3 fix: if the UPDATE matched zero rows (target wasn't in the
  // mirror, or was already revoked), skip the revocation_list fan-out
  // and the epoch bump. Bumping unconditionally would churn peers'
  // VMCs on every no-op remove event, including duplicates re-arriving
  // via delta sync.
  if (updateResult.changes === 0) {
    invalidateVaultRoleCache(event.vault_id);
    return;
  }

  // D-OFFLINE-REMOVE / D-REVOCATION-GOSSIP: fan out a revocation_list
  // row for every device locally known to belong to the removed account
  // in this vault. We read vault_credentials INSIDE the tx so the
  // snapshot is consistent with the mirror update above. The UPSERT uses
  // MIN(revoked_at, excluded.revoked_at) so a later server-delivered
  // revocation can never push the timestamp forward, mirroring
  // applyServerRevocations() in lib/trust/revocation.ts.
  //
  // Note: we don't have a guaranteed-complete list of the removed
  // account's devices — only those we have credentials cached for
  // locally. That's by design: devices we've never seen can't reach us
  // anyway, and the moment they DO try to handshake they'll be added
  // (and then refused) via the standard mesh path because their
  // vault_epoch is now stale. Devices we HAVE seen are the ones at
  // risk of replay, and those get tombstoned now.
  const deviceRows = await tx.getAllAsync<{ device_id: string }>(
    `SELECT device_id FROM vault_credentials
      WHERE vault_id = ? AND account_id = ?`,
    event.vault_id,
    event.payload.account_id,
  );
  for (const { device_id } of deviceRows) {
    await tx.runAsync(
      `INSERT INTO revocation_list (vault_id, device_id, revoked_at, lifted_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT (vault_id, device_id) DO UPDATE SET
         revoked_at = MIN(revocation_list.revoked_at, excluded.revoked_at),
         -- A re-removal must invalidate any prior lift: the row went
         -- removed -> re-added (lifted) -> re-removed. Reset to active.
         lifted_at  = NULL`,
      event.vault_id,
      device_id,
      event.appended_at,
    );
  }

  // M2 (review): retire the removed account's device bindings in
  // vault_device_registry too. The chain fold (lib/trust/chain.ts) retires
  // every device of a removed account; if the apply-path registry doesn't
  // match, lookupSignerCredential would keep authenticating a removed
  // member's device (no device_removed verdict) — a gate/fold parity break
  // and revocation bypass. removed_at_ms = event.hlc.pms (the author clock,
  // matching applyVaultDeviceRemoved's deterministic choice). MIN-style
  // guard via "removed_at_ms IS NULL" keeps a stale re-removal from moving
  // an existing tombstone.
  await tx.runAsync(
    `UPDATE vault_device_registry
        SET removed_at_ms = ?, removed_at_l = ?, removed_at_did = ?
      WHERE vault_id = ?
        AND account_id = ?
        AND removed_at_ms IS NULL`,
    event.hlc.pms,
    event.hlc.l,
    event.hlc.did,
    event.vault_id,
    event.payload.account_id,
  );

  // Bump vault_epoch so the removed device(s) — even if they manage to
  // present a still-signature-valid VMC (cached pre-removal) — hit the
  // peer-epoch-older-than-ours rejection in anti-entropy.ts before the
  // revocation_list check even fires. Belt-and-suspenders: either gate
  // alone is sufficient; together they make the failure mode
  // unambiguous in handshake logs.
  await tx.runAsync(`UPDATE vaults SET vault_epoch = vault_epoch + 1 WHERE id = ?`, event.vault_id);

  invalidateVaultRoleCache(event.vault_id);
}
