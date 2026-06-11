// Projection module entry point. Owns:
//   - The Applier type
//   - The APPLIERS registry (event_type -> applier function)
//   - applyEvent: the single transactional entry point used by BOTH local
//     writes (via the appendXxx helpers in lib/event-log.ts) and remote
//     writes (Phase 3 sync worker pulls call applyEvent with origin='remote').
//   - _dispatchProjectionApplier: dev-only direct applier dispatch used by
//     lib/__dev__/replay-test.ts to rebuild the projection from event_log
//     without going through applyEvent's HLC tick + INSERT OR IGNORE machinery.
//
// Extracted from event-log.ts as part of the Phase 3 modularity refactor.
// Behavior is unchanged: every SQL statement, every guard, every comment is
// preserved byte-for-byte from the original implementation. The Go projection
// in apps/backend/internal/sync/project.go must produce equivalent output
// to the dispatched chain below — verified by the shared JSON conformance
// corpus in apps/_shared/projection-corpus/.

import { getAppMetaInTx, getDb, getInstallIdSync, setAppMetaInTx, type SQLiteTx } from "../db-tx";
import type { EventType, LedgerEvent } from "../events";
import { isKnownEventType } from "../events";
import { signEvent } from "../event-sig";
import { ensureDeviceKey, getDevicePubkey, signWithDeviceKey } from "../mesh/device-key";
import { deserializeHLC, serializeHLC, tickLocal, tickReceive, type HLC } from "../hlc";

import { applyAccountBound } from "./account";
import { applyEntryAmended, applyEntryCreated, applyEntryDeleted } from "./entries";
import {
  applyPersonAdded,
  applyPersonArchived,
  applyPersonPhoneChanged,
  applyPersonRenamed,
  applyPersonUnarchived,
} from "./persons";
import { checkRoleForEvent, recordRoleGateReject, type RoleGateResult } from "./role-gate";
import { applyShopProfileUpdated } from "./shop";
import {
  applyVaultMemberAdded,
  applyVaultMemberRemoved,
  applyVaultMemberRoleChanged,
} from "./vault_members";
import { applyVaultSettingSet } from "./vault_settings";
import { notifyProjectionConflictsChanged } from "../projection-conflicts";

// app_meta key for the persisted HLC frontier. JSON-encoded {pms, l, did}.
// Read/written inside the same transaction as every event_log INSERT.
const HLC_LAST_KEY = "hlc_last";

// ---------- applier registry ----------

export type Applier = (tx: SQLiteTx, event: LedgerEvent) => Promise<void>;

// Cast through unknown so each typed applier slots into the homogeneous
// registry without losing its own narrow event-type signature at call sites.
// Phase 2 wires entry_* + person_* + shop_profile_updated + account_bound.
export const APPLIERS: Partial<Record<EventType, Applier>> = {
  entry_created: applyEntryCreated as unknown as Applier,
  entry_amended: applyEntryAmended as unknown as Applier,
  entry_deleted: applyEntryDeleted as unknown as Applier,

  // Phase 2 — users / relationships / shop_profile. account_bound is
  // registered too even though its local applier is a no-op: dispatching
  // (rather than throwing) keeps the event in the local log for
  // forward-sync + replay, while the backend handles retroactive
  // author re-stamping.
  person_added: applyPersonAdded as unknown as Applier,
  person_renamed: applyPersonRenamed as unknown as Applier,
  person_phone_changed: applyPersonPhoneChanged as unknown as Applier,
  person_archived: applyPersonArchived as unknown as Applier,
  person_unarchived: applyPersonUnarchived as unknown as Applier,
  shop_profile_updated: applyShopProfileUpdated as unknown as Applier,
  account_bound: applyAccountBound as unknown as Applier,

  // Phase 4 — vault membership + vault-scoped settings. Closes Phase 3
  // caveat #2: pull no longer throws-then-skips these events. The first
  // three appliers update vault_members_mirror so useVaultRole reflects
  // server-side ACL changes; vault_setting_set upserts vault_settings
  // with per-key LWW.
  vault_member_added: applyVaultMemberAdded as unknown as Applier,
  vault_member_role_changed: applyVaultMemberRoleChanged as unknown as Applier,
  vault_member_removed: applyVaultMemberRemoved as unknown as Applier,
  vault_setting_set: applyVaultSettingSet as unknown as Applier,
};

// ---------- single transactional entry point ----------
//
// Local writes call this via the appendEntry* helpers in event-log.ts.
// Remote writes (Phase 3 sync worker + Phase 5 mesh) call it directly with
// origin='remote'. Migration 006 backfill calls it with origin='backfill'.
//
// Contract:
//   - HLC tick + event_log INSERT + projection update + hlc_last write are
//     ONE transaction. WAL mode gives us serial semantics on the single
//     shared connection, so two concurrent appendEntry calls cannot interleave.
//   - Idempotent by event_id (INSERT OR IGNORE). If a duplicate id lands,
//     applied=false and the projection applier is NOT dispatched. This is
//     how Phase 3 retries land safely.
//   - If the applier throws, the whole transaction rolls back. The event_log
//     row, the projection update, and the hlc_last advance all disappear.
// Reason codes surfaced alongside applied=false so append-helpers (and
// their UI callers) can differentiate a "role-gate refused" no-op from a
// duplicate event_id no-op or a preflight-aborted no-op.
//
// - "duplicate"      — INSERT OR IGNORE matched an existing event_id.
//                       Projection is already up-to-date from the original
//                       apply; the caller should treat this as success.
// - "preflight"      — preflightAbort returned true (e.g. entry is already
//                       deleted). No event_log row, no projection update;
//                       UI should treat as a benign no-op.
// - "role_gate"      — checkRoleForEvent refused. Event_log row was kept
//                       (audit trail) but projection was NOT updated.
//                       This is the case the "demoted editor" UI needs to
//                       surface — see lib/projection-conflicts for the
//                       reactive surface; the append helper can also throw
//                       a typed RoleGateRejectionError so synchronous
//                       callers (entry/new save handler) can surface a
//                       specific "you don't have permission" toast.
export type ApplyEventNotAppliedReason = "duplicate" | "preflight" | "role_gate";

export type ApplyEventResult =
  | { applied: true }
  | {
      applied: false;
      reason: ApplyEventNotAppliedReason;
      role_gate?: {
        reason: "insufficient_role" | "unknown_actor" | "unsigned_event" | "bad_signature";
        current_role: string | null;
        required_role: "owner" | "editor";
      };
    };

export async function applyEvent(
  event: LedgerEvent,
  opts: {
    origin: "local" | "remote" | "backfill";
    // Optional inside-tx predicate. If it returns true, applyEvent skips
    // the event_log INSERT and the projection applier dispatch entirely —
    // no event_log row is created. Used by appendEntryAmended /
    // appendEntryDeleted to re-check is_deleted inside the same tx that
    // would have written the event, so an interleaved local mutation
    // can't produce a phantom event_log row claiming a projection update
    // that never happened.
    preflightAbort?: (tx: SQLiteTx) => Promise<boolean>;
  },
): Promise<ApplyEventResult> {
  if (!isKnownEventType(event.event_type)) {
    // No CHECK constraint on event_type in the schema — validate here at
    // insert. Unknown types from a future client build are refused so the
    // projection cannot diverge from the log.
    throw new Error(`unknown event_type: ${String(event.event_type)}`);
  }
  // After migration 007 every event must carry a vault_id (the column is
  // still nullable in the schema for backward-compat with pre-migration
  // rows the backfill stamped, but no NEW event should ever land with null).
  if (opts.origin === "local" && event.vault_id == null) {
    throw new Error(
      `cannot append event ${event.event_id} of type ${event.event_type}: vault_id is null (migration 007 not yet run, or append helper failed to stamp it)`,
    );
  }
  const applier = APPLIERS[event.event_type];
  if (!applier) {
    throw new Error(`no projection applier for event_type ${event.event_type}`);
  }

  // Phase 8 event signing: pre-warm the device key OUTSIDE the tx (it
  // hits SecureStore on first call; we don't want SecureStore I/O inside
  // a SQLite transaction). Idempotent: subsequent calls are sync cache
  // reads. Skipped for non-local origins — those events were signed by
  // the authoring device and we re-verify their signature, not re-sign.
  if (opts.origin === "local") {
    try {
      await ensureDeviceKey();
    } catch (err) {
      // Bootstrap edge case: if SecureStore is wedged we still want the
      // local write to land (the user typed something and pressed save).
      // The role-gate will see a null signer and accept on local origin.
      console.warn("[projection] ensureDeviceKey failed before signing", err);
    }
  }

  const db = await getDb();
  let applied = false;
  // Phase 8 D-ROLE-ENFORCEMENT-MOBILE: tracked across the tx boundary so
  // we can fire notifyProjectionConflictsChanged() AFTER the commit. The
  // notifier triggers React subscribers to re-query projection_conflicts.
  let roleGateRejected = false;
  // Tracks WHY applied=false so the return shape can be discriminated by
  // the caller. Initialized to "duplicate" because the most common
  // non-applied path is the INSERT OR IGNORE PK collision; the role-gate
  // and preflight paths overwrite it. Held inside an object so TypeScript
  // doesn't narrow the type to the initializer literal through the closure
  // mutation that happens inside withTransactionAsync.
  const notApplied: {
    reason: ApplyEventNotAppliedReason;
    roleGateDetail: Extract<RoleGateResult, { ok: false }> | null;
  } = { reason: "duplicate", roleGateDetail: null };

  await db.withTransactionAsync(async () => {
    // 0. Optional inside-tx pre-flight.
    if (opts.preflightAbort && (await opts.preflightAbort(db))) {
      applied = false;
      notApplied.reason = "preflight";
      return;
    }

    // 1. HLC tick — read frontier, advance, write back at the end.
    const nowMs = Date.now();
    const prevRaw = await getAppMetaInTx(db, HLC_LAST_KEY);
    const prev = prevRaw ? deserializeHLC(prevRaw) : null;

    let newHlc: HLC;
    if (opts.origin === "local") {
      newHlc = tickLocal(prev, nowMs, event.device_id);
    } else {
      // Remote and backfill arrive with their own HLC already stamped — we
      // merge it into our frontier so our next local tick can't sort before
      // an event we've already accepted.
      newHlc = tickReceive(prev, event.hlc, nowMs, getInstallIdSync());
    }

    // Build the stamped event locally rather than mutating the caller's
    // object. The applier sees the final event with its real HLC; the
    // caller's reference is unchanged.
    const stampedBase: LedgerEvent = {
      ...event,
      hlc: opts.origin === "local" ? newHlc : event.hlc,
      device_id: opts.origin === "local" ? newHlc.did : event.device_id,
      appended_at: nowMs,
      origin: opts.origin,
    };

    // Phase 8 D-ROLE-ENFORCEMENT-MOBILE: sign LOCAL-origin events AFTER
    // tickLocal stamps the final HLC. Remote-origin events arrive with
    // their authoring device's signature already populated by the wire
    // (anti-entropy.ts) — we re-verify it inside checkRoleForEvent, not
    // here. Backfill-origin events are unsigned (synthetic pre-Phase 8).
    let stamped: LedgerEvent = stampedBase;
    if (opts.origin === "local") {
      try {
        const sig = await signEvent(
          stampedBase as unknown as Parameters<typeof signEvent>[0],
          signWithDeviceKey,
        );
        // getDevicePubkey returns the cached b64 pubkey synchronously.
        // ensureDeviceKey() was awaited above, so this is non-null in
        // the steady state. The fallback (null) leaves both columns
        // NULL; checkRoleForEvent accepts that for origin='local'.
        const pub = getDevicePubkey();
        stamped = {
          ...stampedBase,
          event_sig_b64: sig,
          signer_device_pubkey: pub ?? null,
        } as LedgerEvent;
      } catch (err) {
        // Signing failure must not abort the local write — the user
        // typed something and pressed save. Land the row unsigned; the
        // role-gate accepts unsigned local events. Other peers WILL
        // refuse it on mesh receive (unsigned + remote origin =
        // refused), which is the right safety property: a device that
        // can't sign shouldn't be propagating writes.
        console.warn("[projection] signEvent failed for local origin", err);
        stamped = stampedBase;
      }
    }

    // 2. INSERT OR IGNORE — idempotent by event_id.
    const result = await db.runAsync(
      `INSERT OR IGNORE INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema,
         appended_at, server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey
       ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?,  ?, ?)`,
      stamped.event_id,
      stamped.event_type,
      stamped.vault_id,
      stamped.target_id,
      stamped.relationship_id,
      stamped.hlc.pms,
      stamped.hlc.l,
      stamped.hlc.did,
      stamped.device_id,
      stamped.author_user_id_local_only,
      stamped.actor_account_id,
      JSON.stringify(stamped.payload),
      stamped.payload_schema,
      stamped.appended_at,
      stamped.server_acked_at,
      stamped.rejected_at,
      stamped.origin,
      stamped.event_sig_b64 ?? null,
      stamped.signer_device_pubkey ?? null,
    );

    // changes === 0 means the INSERT OR IGNORE hit the PK and skipped.
    // Duplicate event — projection already reflects it from the first apply.
    if (result.changes === 0) {
      applied = false;
      notApplied.reason = "duplicate";
      return;
    }

    // 3. Pre-flight role gate (Phase 8 D-ROLE-ENFORCEMENT-MOBILE). MUST
    //    run AFTER the INSERT OR IGNORE (so a duplicate event's role
    //    isn't re-checked) and BEFORE the applier dispatch (so an
    //    unauthorized event never mutates the projection).
    //
    //    On reject, the event_log row stays — the log is append-only
    //    and the audit trail benefits from seeing the attempt — but
    //    projection_conflicts gets a row and applier dispatch is
    //    SKIPPED. We still advance the HLC cursor so the frontier
    //    doesn't get stuck on a rejected event.
    const gate = await checkRoleForEvent(db, stamped);
    if (!gate.ok) {
      await recordRoleGateReject(db, stamped, gate);
      await setAppMetaInTx(db, HLC_LAST_KEY, serializeHLC(newHlc));
      roleGateRejected = true;
      applied = false;
      notApplied.reason = "role_gate";
      notApplied.roleGateDetail = gate;
      return;
    }

    // 4. Dispatch to projection applier. Throws roll the entire tx back.
    await applier(db, stamped);

    // 5. Advance the HLC cursor. Done last so a failed applier doesn't burn
    //    the frontier.
    await setAppMetaInTx(db, HLC_LAST_KEY, serializeHLC(newHlc));

    applied = true;
  });

  // Post-commit notification: subscribers to projection_conflicts (the
  // demotion banner / toast) re-query and surface the new row. Fires
  // outside the tx so subscribers see the committed state.
  if (roleGateRejected) {
    notifyProjectionConflictsChanged();
  }

  // Migration 014 trigger (c): a role-changing event MAY cure events
  // currently quarantined as role_insufficient. Also covers trigger
  // (a) for local appends — a new event landing might be the prereq
  // for a missing_prereq quarantine elsewhere. Debounced + idempotent
  // (sweep is a no-op when nothing's quarantined), so it's safe to
  // call on every successful apply. Lazy-import to avoid circular
  // deps between projection/index.ts and projection/sweep.ts.
  if (applied && event.vault_id != null) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scheduleSweep } = require("./sweep") as {
        scheduleSweep: (vaultId: string) => void;
      };
      scheduleSweep(event.vault_id);
    } catch {
      /* sweep is best-effort */
    }
  }

  if (applied) return { applied: true };
  if (notApplied.reason === "role_gate" && notApplied.roleGateDetail != null) {
    return {
      applied: false,
      reason: "role_gate",
      role_gate: {
        reason: notApplied.roleGateDetail.reason,
        current_role: notApplied.roleGateDetail.current_role,
        required_role: notApplied.roleGateDetail.required_role,
      },
    };
  }
  return { applied: false, reason: notApplied.reason };
}

// ---------- dev-only helpers ----------

// Direct projection-applier dispatch, used only by lib/__dev__/replay-test.ts
// to rebuild the entries projection from event_log without going through
// applyEvent's HLC tick + INSERT OR IGNORE machinery (which would no-op on
// the duplicate event_ids during replay). Caller is responsible for opening
// the transaction.
export async function _dispatchProjectionApplier(tx: SQLiteTx, event: LedgerEvent): Promise<void> {
  if (!isKnownEventType(event.event_type)) {
    throw new Error(`unknown event_type: ${String(event.event_type)}`);
  }
  const applier = APPLIERS[event.event_type];
  if (!applier) {
    throw new Error(
      `no projection applier for event_type ${event.event_type} — replay would diverge from live projection`,
    );
  }
  await applier(tx, event);
}

// ---------- re-exports for direct applier access ----------

export { applyEntryAmended, applyEntryCreated, applyEntryDeleted } from "./entries";
export {
  applyPersonAdded,
  applyPersonArchived,
  applyPersonPhoneChanged,
  applyPersonRenamed,
  applyPersonUnarchived,
} from "./persons";
export { applyShopProfileUpdated } from "./shop";
export { applyAccountBound } from "./account";
