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
import { applyVaultDeviceAdded, applyVaultDeviceRemoved } from "./vault_devices";
import {
  applyVaultMemberAdded,
  applyVaultMemberRemoved,
  applyVaultMemberRoleChanged,
} from "./vault_members";
import { applyVaultSettingSet } from "./vault_settings";
import { notifyProjectionConflictsChanged } from "../projection-conflicts";
import { Mutex } from "../util/mutex";

// Serializes every applyEvent transaction (and pull's post-batch patch tx —
// see lib/sync/pull.ts). expo-sqlite's withTransactionAsync is documented
// NON-exclusive: two concurrent callers interleave on the same connection,
// the second BEGIN throws, and its rollback can tear the first caller's
// open transaction into autocommit statements. That hazard predates M1,
// but the author_seq assignment (MAX()+1 read-then-INSERT under a UNIQUE
// index) now leans on transaction exclusivity, so we make it real.
//
// EVERY event_log/projection write-transaction on the shared connection
// must hold this mutex: applyEvent (below), push's ack tx (lib/sync/push.ts),
// ingestPulledEvents (./ingest-row.ts), the sweep's per-event replay tx
// (./replay.ts), and the mesh ingest txs (lib/mesh/anti-entropy.ts). The
// last two acquire it while ALREADY holding sweepMutex (./sweep.ts) — that
// order, sweepMutex → applyEventMutex, is the ONLY permitted nesting.
// Never take sweepMutex (or await anything that does) while holding this
// mutex: both Mutexes are non-reentrant FIFO chains and the reverse order
// deadlocks. applyEvent stays safe because its scheduleSweep fires
// post-release via the debounce timer.
export const applyEventMutex = new Mutex();

// app_meta key for the persisted HLC frontier. JSON-encoded {pms, l, did}.
// Read/written inside the same transaction as every event_log INSERT.
const HLC_LAST_KEY = "hlc_last";

// Mythos Fix Set A: thrown by applyEvent when a LOCAL-origin event cannot
// be signed because the device key / pubkey cache is unavailable. The old
// behavior was to swallow the signing failure and land the row with
// signer_device_pubkey = NULL — which then gets refused at every peer's
// mesh ingest (verifyAndIngest → missing_signer_pubkey, pre-insert, head
// never advances, re-sent forever, never applied), silently killing sync
// AND leaving the members projection empty/wrong on the owner. A save that
// cannot be signed must fail VISIBLY rather than succeed-then-never-sync.
// Re-exported from event-log.ts so save handlers import it next to
// RoleGateRejectionError.
export class EventSigningUnavailableError extends Error {
  readonly kind = "signing_unavailable" as const;
  constructor(message = "event signing unavailable") {
    super(message);
    this.name = "EventSigningUnavailableError";
  }
}

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

  // M2 membership chain — device-binding fold into vault_device_registry
  // (migration 019). Appliers only fold; authorization is the role-gate +
  // chain fold's job. See lib/projection/vault_devices.ts.
  vault_device_added: applyVaultDeviceAdded as unknown as Applier,
  vault_device_removed: applyVaultDeviceRemoved as unknown as Applier,
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
  //
  // Mythos Fix Set A: guarantee the in-memory pubkey cache is WARM before
  // we enter the tx. getDevicePubkey() reads only the cache; ensureDeviceKey
  // populates it. On a fresh install the SecureStore write and the cache
  // warmup can race, so we retry the ensure once. If the cache is STILL
  // cold after the retry we must NOT proceed to write an event whose
  // signer_device_pubkey would be null — that event gets refused at every
  // peer's mesh ingest and silently breaks sync + the members projection.
  if (opts.origin === "local") {
    let pub = getDevicePubkey();
    if (!pub) {
      try {
        await ensureDeviceKey();
        pub = getDevicePubkey();
      } catch (err) {
        console.warn("[projection] ensureDeviceKey failed before signing", err);
      }
    }
    if (!pub) {
      // Cannot produce a propagatable (signed-with-pubkey) event. Fail
      // loud — the caller surfaces "couldn't prepare secure save, reopen
      // the app" (Fix Set C). Reopening the app warms the key cache.
      throw new EventSigningUnavailableError(
        "device key/pubkey cache unavailable; refusing to write an unsigned local event",
      );
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

  await applyEventMutex.runExclusive(() =>
    db.withTransactionAsync(async () => {
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
        // Mythos Fix Set A: the pubkey cache was guaranteed warm above (we
        // threw EventSigningUnavailableError otherwise), so pub is non-null
        // here. We DELIBERATELY let signEvent throw rather than swallowing:
        // a local write that cannot be signed must fail visibly instead of
        // landing a non-propagatable row. The throw unwinds the tx (nothing
        // is written) and the caller surfaces a clear message.
        const pub = getDevicePubkey();
        if (!pub) {
          throw new EventSigningUnavailableError(
            "device pubkey vanished between pre-warm and sign",
          );
        }
        const sig = await signEvent(
          stampedBase as unknown as Parameters<typeof signEvent>[0],
          signWithDeviceKey,
        );
        stamped = {
          ...stampedBase,
          event_sig_b64: sig,
          signer_device_pubkey: pub,
        } as LedgerEvent;
      }

      // 2. INSERT OR IGNORE — idempotent by event_id.
      //
      // MIGRATION 014 HOTFIX: the state-machine trigger created by
      // migration 014 requires `ingested_at IS NOT NULL` on every
      // INSERT into event_log. Without setting it here, the trigger
      // ABORTs every local write — every contact-create, every entry-
      // append, every vault_member_added event. Caught by user testing
      // the same day the migration shipped.
      //
      // For local-origin events: ingested_at = applied_at = appended_at,
      // because the local path is atomic INSERT+role-gate+applier inside
      // one withTransactionAsync. If role-gate refuses (line 317 below),
      // we UPDATE applied_at back to NULL so the sweep can retry on the
      // next role-elevation event. If the applier throws, the entire
      // txn rolls back, including this INSERT — no row, no inconsistency.
      //
      // For remote-origin events going through this path (pull from
      // backend, NOT mesh): same semantic — the server is authoritative,
      // we believe what it tells us. (Mesh-origin events DO NOT use
      // this path; they go through anti-entropy.ts's verifyAndIngest
      // pipeline which sets ingested_at and defers applied_at to the
      // sweep.)
      // Sync v2 M1 (migration 018): per-author sequence number. Authoring
      // origins (local + backfill synthetics) assign the next seq for this
      // (vault, device) inside the same tx as the INSERT (serialized by
      // applyEventMutex). Remote origin trusts the wire (the author assigned
      // it); legacy remote events without one stay NULL. Never signed.
      let authorSeq: number | null;
      if (opts.origin === "remote") {
        authorSeq = stamped.author_seq ?? null;
        // Slot pre-check: if a DIFFERENT local row already holds this
        // (vault, author, seq) slot (divergent legacy backfills meeting
        // through a relay), sacrifice the seq — NEVER the event. Without
        // this, INSERT OR IGNORE swallows the UNIQUE-index violation, the
        // event is silently dropped as a "duplicate", and the pull cursor
        // advances past it forever: permanent, unhealable replica
        // divergence. Same intent as push.ts's seq_conflict strip and
        // pull.ts's UPDATE OR IGNORE backfill.
        if (authorSeq != null && stamped.vault_id != null) {
          const slot = await db.getFirstAsync<{ event_id: string }>(
            `SELECT event_id FROM event_log
            WHERE vault_id = ? AND device_id = ? AND author_seq = ?`,
            stamped.vault_id,
            stamped.device_id,
            authorSeq,
          );
          if (slot && slot.event_id !== stamped.event_id) {
            authorSeq = null;
          }
        }
      } else if (stamped.author_seq != null) {
        authorSeq = stamped.author_seq;
      } else {
        authorSeq = await nextAuthorSeqInTx(db, stamped);
        // Conflict floor (own device only): if a previous push had OUR seq N
        // stripped via seq_conflict (server slot squatted — pathological:
        // install-id clone or local reset), MAX()+1 would re-mint N forever.
        // The floor marks "lowest seq we may still use"; it advances ONLY on
        // strip (lib/sync/push.ts), never on assignment, so the duplicate
        // path can't burn seqs and normal operation has zero gaps.
        if (stamped.vault_id != null && stamped.device_id === getInstallIdSync()) {
          const floorRaw = await getAppMetaInTx(db, `author_seq_floor:${stamped.vault_id}`);
          const floor = floorRaw ? Number(floorRaw) : 0;
          if (Number.isFinite(floor) && floor > authorSeq) {
            authorSeq = floor;
          }
        }
      }

      const result = await db.runAsync(
        `INSERT OR IGNORE INTO event_log (
         event_id, event_type, vault_id, target_id, relationship_id,
         hlc_physical_ms, hlc_logical, hlc_device_id,
         device_id, author_user_id_local_only, actor_account_id,
         payload_json, payload_schema,
         appended_at, server_acked_at, rejected_at, origin,
         event_sig_b64, signer_device_pubkey,
         ingested_at, applied_at, author_seq
       ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?)`,
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
        stamped.appended_at,
        stamped.appended_at,
        authorSeq,
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
        // MIGRATION 014 HOTFIX: the INSERT above optimistically set
        // applied_at = appended_at because the local path normally
        // commits ingest+apply atomically. Now that role-gate refused,
        // the applier WILL NOT run, so applied_at is wrong. Clear it
        // and set quarantine_reason so the sweep retries on a later
        // role-elevation event.
        await db.runAsync(
          `UPDATE event_log
            SET applied_at = NULL, quarantine_reason = 'role_insufficient'
          WHERE event_id = ?`,
          stamped.event_id,
        );
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
    }),
  );

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
    // Notify UI + the mesh push loop that the ledger changed. origin lets the
    // mesh filter to LOCAL writes only (push our own edits; never re-dial in
    // response to a remote apply). Fires post-commit so subscribers read
    // committed state. Lazy require to avoid a projection↔ledger-events cycle.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { emitLedgerApplied } = require("../ledger-events") as {
        emitLedgerApplied: (vaultId: string, origin: "local" | "remote" | "backfill") => void;
      };
      emitLedgerApplied(event.vault_id, opts.origin);
    } catch {
      /* best-effort */
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

// Next per-author sequence for an authoring-origin event, computed inside
// the caller's transaction (Sync v2 M1; see migration 018 in lib/db.ts).
// Branched SQL so the common vault-scoped case hits the
// idx_event_log_author_seq index instead of a COALESCE expression scan.
async function nextAuthorSeqInTx(
  db: SQLiteTx,
  e: { vault_id: string | null; device_id: string },
): Promise<number> {
  const row =
    e.vault_id != null
      ? await db.getFirstAsync<{ next_seq: number }>(
          `SELECT COALESCE(MAX(author_seq), 0) + 1 AS next_seq
             FROM event_log
            WHERE vault_id = ? AND device_id = ?`,
          e.vault_id,
          e.device_id,
        )
      : await db.getFirstAsync<{ next_seq: number }>(
          `SELECT COALESCE(MAX(author_seq), 0) + 1 AS next_seq
             FROM event_log
            WHERE vault_id IS NULL AND device_id = ?`,
          e.device_id,
        );
  return row?.next_seq ?? 1;
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
