// Projection appliers for entry_* events.
//
// Phase 4: per-field LWW HLC bookkeeping. Each entry row carries a
// field_hlcs JSON sidecar column (migration 009). The amended applier
// compares the event's HLC against each touched field's stored HLC and
// only applies fields whose event is strictly greater. The same JSON map
// is rewritten in the same UPDATE.
//
// These appliers are dispatched by applyEvent (lib/projection/index.ts) and
// by _dispatchProjectionApplier (the dev-only replay-test path). They are
// also the TS counterpart to the Go projection in
// apps/backend/internal/sync/project.go — any change here must be mirrored
// there and against the shared JSON conformance corpus in
// apps/_shared/projection-corpus/.

import type { SQLiteTx } from "../db-tx";
import type { EntryAmendedEvent, EntryCreatedEvent, EntryDeletedEvent } from "../events";
import { MissingPrereqError } from "./errors";
import { compareFieldHLC, parseFieldHLCs, serializeFieldHLCs, type FieldHLCMap } from "./field-hlc";

export async function applyEntryCreated(tx: SQLiteTx, event: EntryCreatedEvent): Promise<void> {
  // INSERT OR REPLACE so a projection rebuild (replayTest, future cross-device
  // restore-from-log) doesn't need to wipe entries first to be safe. The
  // event_log itself remains idempotent via its INSERT OR IGNORE in
  // applyEvent — the OR REPLACE here is purely a projection-side safety.
  //
  // Phase 4: seed field_hlcs with the create event's HLC for every mutable
  // field. Subsequent amends compare against these floors via compareFieldHLC.
  const p = event.payload;
  if (event.vault_id == null) {
    throw new Error(`entry_created event ${event.event_id} missing envelope vault_id`);
  }

  const seed: FieldHLCMap = {
    amount_afn: event.hlc,
    note: event.hlc,
    type: event.hlc,
    occurred_at_ms: event.hlc,
  };

  await tx.runAsync(
    `INSERT OR REPLACE INTO entries (
       id, vault_id, relationship_id, type, amount_afn, note,
       created_at, updated_at, proposed_by_user_id,
       current_event_id, is_deleted, is_settled,
       accepted_at, disputed_at, disputed_reason, settled_at,
       deleted_at, field_hlcs
     ) VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?,  ?, 0, ?,  ?, ?, ?, ?,  NULL, ?)`,
    p.entry_id,
    event.vault_id,
    p.relationship_id,
    p.type,
    p.amount_afn,
    p.note,
    p.occurred_at_ms,
    p.occurred_at_ms,
    // author_user_id_local_only is device-local and NEVER crosses the wire —
    // ingest forces it to "" for any replicated event. proposed_by_user_id has
    // a REFERENCES users(id) FK with PRAGMA foreign_keys=ON, and "" is non-null
    // so SQLite enforces it: with no users row id="" the applier throws
    // "FOREIGN KEY constraint failed" and the sweep quarantines EVERY synced
    // entry forever (the bug where tallies never replicated). NULL is the honest
    // value for a remote entry (no local author) and skips the FK check. Local
    // appends still carry the real author id. The UI author-fallback already
    // coalesces a null proposed_by to the local self (db.ts).
    event.author_user_id_local_only || null,
    event.event_id,
    p.backfill_settled_at != null ? 1 : 0,
    p.backfill_accepted_at ?? null,
    p.backfill_disputed_at ?? null,
    p.backfill_disputed_reason ?? null,
    p.backfill_settled_at ?? null,
    serializeFieldHLCs(seed),
  );
}

export async function applyEntryAmended(tx: SQLiteTx, event: EntryAmendedEvent): Promise<void> {
  // Phase 4 per-field LWW. Snapshot current field_hlcs, decide per-field
  // whether to apply, write back the merged map.
  const row = await tx.getFirstAsync<{ field_hlcs: string | null; is_deleted: number }>(
    `SELECT field_hlcs, is_deleted FROM entries WHERE id = ?`,
    event.target_id,
  );
  if (row == null) {
    // Out-of-order delivery (amend before its create). On the REMOTE/sweep
    // path the event is already durably ingested (event_log row exists), so
    // throwing here does NOT lose it — it QUARANTINES (missing_prereq) and the
    // sweep retries once the create lands (HLC order makes create sort first,
    // so they heal in one fixpoint pass). The old silent `return` was counted
    // as {applied} by the sweep → the amend left quarantine permanently and was
    // never re-applied → silent edit loss. LOCAL/backfill origin keeps the
    // benign no-op (a local amend's target always exists; a synthetic backfill
    // replays in order), so we never break those callers.
    if (event.origin === "remote") {
      throw new MissingPrereqError(
        `entry_amended ${event.event_id}: target entry ${event.target_id} not found (missing prereq)`,
      );
    }
    return;
  }

  // Sticky tombstone: once an entry is deleted, a later entry_amended must be
  // fully ignored — no field write, no updated_at / current_event_id bump —
  // matching the Go projection (project.go: `if entry.IsDeleted { return nil }`)
  // and corpus fixture 03 (delete_then_amend). Only the remote/sweep path can
  // reach a deleted row here (local appends pre-check is_deleted); without this
  // guard a concurrent amend-after-delete mutates the tombstone and the mobile
  // row diverges permanently from the server snapshot / other replicas.
  if (row.is_deleted === 1) return;

  const current: FieldHLCMap = parseFieldHLCs(row.field_hlcs);
  const next: FieldHLCMap = { ...current };

  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  const c = event.payload.changes;
  let anyFieldApplied = false;

  if ("amount_afn" in c && c.amount_afn !== undefined) {
    if (compareFieldHLC(current, "amount_afn", event.hlc) === "apply") {
      sets.push("amount_afn = ?");
      args.push(c.amount_afn);
      next["amount_afn"] = event.hlc;
      anyFieldApplied = true;
    }
  }
  if ("note" in c) {
    if (compareFieldHLC(current, "note", event.hlc) === "apply") {
      sets.push("note = ?");
      args.push(c.note ?? null);
      next["note"] = event.hlc;
      anyFieldApplied = true;
    }
  }
  if ("type" in c && c.type !== undefined) {
    if (compareFieldHLC(current, "type", event.hlc) === "apply") {
      sets.push("type = ?");
      args.push(c.type);
      next["type"] = event.hlc;
      anyFieldApplied = true;
    }
  }
  // occurred_at_ms is not projected onto a column in Phase 1 — created_at is
  // the proxy. We still tick its field HLC here for future-proofing.
  if ("occurred_at_ms" in c && c.occurred_at_ms !== undefined) {
    if (compareFieldHLC(current, "occurred_at_ms", event.hlc) === "apply") {
      next["occurred_at_ms"] = event.hlc;
      anyFieldApplied = true;
    }
  }

  // If every field in the payload was older than the stored HLC, the
  // event is fully redundant. Leave the row alone — don't bump
  // current_event_id or updated_at so the UI's "Last edited" label
  // reflects the last WINNING event, not the last SEEN event.
  if (!anyFieldApplied) return;

  sets.push("updated_at = ?");
  args.push(event.hlc.pms);
  sets.push("current_event_id = ?");
  args.push(event.event_id);
  sets.push("field_hlcs = ?");
  args.push(serializeFieldHLCs(next));

  args.push(event.target_id);

  await tx.runAsync(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`, ...args);
}

export async function applyEntryDeleted(tx: SQLiteTx, event: EntryDeletedEvent): Promise<void> {
  // Sticky tombstone — once is_deleted = 1, no future entry_amended can
  // bring it back. The WHERE clause omits is_deleted = 0 deliberately:
  // re-applying entry_deleted on an already-deleted row is a harmless no-op
  // and we want migration 006's backfill replay to be idempotent without
  // checking the projection state first.
  //
  // deleted_at / updated_at come from event.hlc.pms so a backfilled delete
  // restores the original entries.deleted_at byte-identical (replay
  // invariant). For live deletes hlc.pms is nowMs.
  const res = await tx.runAsync(
    `UPDATE entries
       SET is_deleted       = 1,
           deleted_at       = ?,
           updated_at       = ?,
           current_event_id = ?
     WHERE id = ?`,
    event.hlc.pms,
    event.hlc.pms,
    event.event_id,
    event.target_id,
  );
  // 0 rows changed ⇒ the entry isn't on disk yet (delete arrived before its
  // create, cross-batch). On the REMOTE/sweep path, throw so it QUARANTINES and
  // retries once the create lands — a silent return is counted {applied} and
  // never retried, so the entry would RESURRECT (un-deleted) when the create
  // later applies. LOCAL/backfill keep the harmless no-op (a local delete's
  // target exists; backfill replays the create first).
  if ((res?.changes ?? 0) === 0 && event.origin === "remote") {
    throw new MissingPrereqError(
      `entry_deleted ${event.event_id}: target entry ${event.target_id} not found (missing prereq)`,
    );
  }
}
