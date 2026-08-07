// Projection appliers for person_* events.
//
// Phase 4: per-field LWW HLC bookkeeping on display_name and phone_e164.
// Each users row carries a field_hlcs JSON sidecar column (migration 009).

import type { SQLiteTx } from "../db-tx";
import type {
  PersonAddedEvent,
  PersonArchivedEvent,
  PersonPhoneChangedEvent,
  PersonRenamedEvent,
  PersonUnarchivedEvent,
} from "../events";
import { MissingPrereqError } from "./errors";
import { compareFieldHLC, parseFieldHLCs, serializeFieldHLCs, type FieldHLCMap } from "./field-hlc";

export async function applyPersonAdded(tx: SQLiteTx, event: PersonAddedEvent): Promise<void> {
  // Inserts BOTH the users row and the bound peer-relationship in one shot.
  // event.relationship_id (envelope) carries the relationship id minted by
  // the caller; never recomputed so replay is deterministic.
  //
  // Phase 4: seed field_hlcs for the mutable fields at the create event's
  // HLC so future amends compare against a real floor.
  const p = event.payload;
  const ts = event.hlc.pms;

  const seed: FieldHLCMap = {
    display_name: event.hlc,
    phone_e164: event.hlc,
  };

  await tx.runAsync(
    `INSERT OR REPLACE INTO users (
       id, phone_e164, display_name, is_local_self,
       google_sub, account_id,
       created_at, updated_at, archived_at, field_hlcs
     ) VALUES (?, ?, ?, 0,  NULL, NULL,  ?, ?, NULL, ?)`,
    p.user_id,
    p.phone_e164,
    p.name,
    ts,
    ts,
    serializeFieldHLCs(seed),
  );

  if (event.relationship_id == null) {
    throw new Error(`person_added event ${event.event_id} missing envelope relationship_id`);
  }
  if (event.vault_id == null) {
    throw new Error(`person_added event ${event.event_id} missing envelope vault_id`);
  }

  // user_a_id resolution — see original comment for full reasoning. The
  // local_self row may not yet exist for a brand-new device replaying
  // events before onboarding completes; fall back to the event's
  // author_user_id_local_only in that case.
  const selfRow = await tx.getFirstAsync<{ id: string }>(
    "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  const userAId = selfRow?.id ?? event.author_user_id_local_only;

  await tx.runAsync(
    `INSERT OR IGNORE INTO relationships (
       id, user_a_id, user_b_id, context, vault_id,
       created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, 'peer', ?,  ?, ?, NULL)`,
    event.relationship_id,
    userAId,
    p.user_id,
    event.vault_id,
    ts,
    ts,
  );
}

export async function applyPersonRenamed(tx: SQLiteTx, event: PersonRenamedEvent): Promise<void> {
  const row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM users WHERE id = ?`,
    event.target_id,
  );
  if (row == null) {
    // Out-of-order rename before the person_added. On the REMOTE/sweep path the
    // event is durably ingested, so throwing QUARANTINES (missing_prereq) for
    // retry rather than dropping the rename forever (a silent return is counted
    // {applied} by the sweep → never re-applied = lost edit). LOCAL keeps the
    // benign no-op.
    if (event.origin === "remote") {
      throw new MissingPrereqError(
        `person_renamed ${event.event_id}: target user ${event.target_id} not found (missing prereq)`,
      );
    }
    return;
  }

  const current: FieldHLCMap = parseFieldHLCs(row.field_hlcs);
  if (compareFieldHLC(current, "display_name", event.hlc) === "skip") return;

  const next: FieldHLCMap = { ...current, display_name: event.hlc };
  await tx.runAsync(
    `UPDATE users
        SET display_name = ?,
            updated_at   = ?,
            field_hlcs   = ?
      WHERE id = ?`,
    event.payload.name,
    event.hlc.pms,
    serializeFieldHLCs(next),
    event.target_id,
  );
}

export async function applyPersonPhoneChanged(
  tx: SQLiteTx,
  event: PersonPhoneChangedEvent,
): Promise<void> {
  // Per-vault uniqueness is enforced by callers BEFORE this event is
  // appended. The applier just writes whatever the event carries.
  // A stale phone change with a duplicate number reaching this point under
  // some exotic concurrency would raise a UNIQUE violation inside the tx,
  // rolling back the event apply — which is correct: LWW can't paper over
  // a uniqueness violation.
  const row = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM users WHERE id = ?`,
    event.target_id,
  );
  if (row == null) {
    // Out-of-order phone-change before the person_added — same rationale as
    // applyPersonRenamed: throw to quarantine-and-retry on the remote/sweep
    // path, benign no-op for local.
    if (event.origin === "remote") {
      throw new MissingPrereqError(
        `person_phone_changed ${event.event_id}: target user ${event.target_id} not found (missing prereq)`,
      );
    }
    return;
  }

  const current: FieldHLCMap = parseFieldHLCs(row.field_hlcs);
  if (compareFieldHLC(current, "phone_e164", event.hlc) === "skip") return;

  const next: FieldHLCMap = { ...current, phone_e164: event.hlc };
  await tx.runAsync(
    `UPDATE users
        SET phone_e164 = ?,
            updated_at = ?,
            field_hlcs = ?
      WHERE id = ?`,
    event.payload.phone_e164,
    event.hlc.pms,
    serializeFieldHLCs(next),
    event.target_id,
  );
}

export async function applyPersonArchived(tx: SQLiteTx, event: PersonArchivedEvent): Promise<void> {
  // Two writes in one applier: archive the relationship in this event's
  // vault, then null users.phone_e164 ONLY if no other active relationship
  // (across any vault) still references this user.
  if (event.relationship_id == null) {
    throw new Error(`person_archived event ${event.event_id} missing envelope relationship_id`);
  }
  if (event.vault_id == null) {
    throw new Error(`person_archived event ${event.event_id} missing envelope vault_id`);
  }

  const rel = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM relationships WHERE id = ? AND vault_id = ?`,
    event.relationship_id,
    event.vault_id,
  );
  // Null ⇒ the relationship isn't on disk yet (archive before its person_added,
  // cross-batch). On remote/sweep, throw so it quarantines+retries — a silent
  // no-op is counted {applied} and never retried, resurrecting the archived
  // contact when the add later applies. LOCAL/backfill keep the no-op.
  if (rel == null) {
    if (event.origin === "remote") {
      throw new MissingPrereqError(
        `person_archived ${event.event_id}: relationship ${event.relationship_id} not found (missing prereq)`,
      );
    }
    return;
  }

  // archived_at is an HLC-guarded LWW register (same treatment as
  // display_name / phone_e164, and the same divergence M31 fixed for the
  // phone). Mobile applies pulled events in server-ARRIVAL order, so without
  // this guard a concurrent archive with an OLDER HLC pushed late would land
  // after an already-applied restore and silently re-archive the person —
  // while the Go projection (which replays ALL events sorted by global HLC
  // from scratch, snapshot.go) keeps them active: permanent client/server
  // divergence. With the guard, the arrival-order fold converges to the same
  // HLC-max winner as the server's sorted fold — which is also why the Go
  // appliers need no matching change. Skipping here also skips the
  // phone-null below: when a newer unarchive already won, a stale archive
  // must not take the phone either.
  const relHlcs: FieldHLCMap = parseFieldHLCs(rel.field_hlcs);
  if (compareFieldHLC(relHlcs, "archived_at", event.hlc) === "skip") return;

  await tx.runAsync(
    `UPDATE relationships
        SET archived_at = ?, updated_at = ?, field_hlcs = ?
      WHERE id = ? AND vault_id = ?`,
    event.hlc.pms,
    event.hlc.pms,
    serializeFieldHLCs({ ...relHlcs, archived_at: event.hlc }),
    event.relationship_id,
    event.vault_id,
  );

  const remaining = await tx.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM relationships
      WHERE user_b_id = ? AND archived_at IS NULL`,
    event.target_id,
  );
  if ((remaining?.n ?? 0) === 0) {
    // M31: advance the phone_e164 field-HLC to this archive event's HLC when we
    // null the phone. Without it, a concurrently-authored phone change with an
    // OLDER HLC arriving later still clears the person_added floor and
    // resurrects the phone on this device — while the Go projection (global
    // HLC-order replay) keeps it NULL, a permanent divergence. Treating the
    // null as a phone write at the archive HLC keeps LWW consistent: a
    // genuinely newer (HLC > archive) phone change still wins and re-sets it.
    const urow = await tx.getFirstAsync<{ field_hlcs: string | null }>(
      `SELECT field_hlcs FROM users WHERE id = ?`,
      event.target_id,
    );
    // The null itself is also a phone LWW write, so it must RESPECT the
    // register: if a phone change with a NEWER HLC already applied (arrival
    // order ran ahead of HLC order), nulling here would regress the field
    // HLC and diverge from the server's sorted fold, where that newer change
    // re-sets the phone after this archive.
    const uHlcs: FieldHLCMap = parseFieldHLCs(urow?.field_hlcs ?? null);
    if (compareFieldHLC(uHlcs, "phone_e164", event.hlc) === "apply") {
      await tx.runAsync(
        "UPDATE users SET phone_e164 = NULL, updated_at = ?, field_hlcs = ? WHERE id = ?",
        event.hlc.pms,
        serializeFieldHLCs({ ...uHlcs, phone_e164: event.hlc }),
        event.target_id,
      );
    }
  }
}

export async function applyPersonUnarchived(
  tx: SQLiteTx,
  event: PersonUnarchivedEvent,
): Promise<void> {
  if (event.relationship_id == null) {
    throw new Error(`person_unarchived event ${event.event_id} missing envelope relationship_id`);
  }
  if (event.vault_id == null) {
    throw new Error(`person_unarchived event ${event.event_id} missing envelope vault_id`);
  }
  const rel = await tx.getFirstAsync<{ field_hlcs: string | null }>(
    `SELECT field_hlcs FROM relationships WHERE id = ? AND vault_id = ?`,
    event.relationship_id,
    event.vault_id,
  );
  // Null ⇒ relationship not on disk yet (unarchive before its add). Remote →
  // quarantine+retry rather than a silent {applied} no-op that loses the
  // unarchive when the add later lands. LOCAL/backfill keep the no-op.
  if (rel == null) {
    if (event.origin === "remote") {
      throw new MissingPrereqError(
        `person_unarchived ${event.event_id}: relationship ${event.relationship_id} not found (missing prereq)`,
      );
    }
    return;
  }

  // Same HLC guard as applyPersonArchived (see the comment there): a stale
  // concurrent unarchive arriving after a newer re-archive must not resurrect
  // the person on this device while the server's HLC-sorted fold keeps them
  // archived.
  const relHlcs: FieldHLCMap = parseFieldHLCs(rel.field_hlcs);
  if (compareFieldHLC(relHlcs, "archived_at", event.hlc) === "skip") return;

  await tx.runAsync(
    `UPDATE relationships
        SET archived_at = NULL, updated_at = ?, field_hlcs = ?
      WHERE id = ? AND vault_id = ?`,
    event.hlc.pms,
    serializeFieldHLCs({ ...relHlcs, archived_at: event.hlc }),
    event.relationship_id,
    event.vault_id,
  );
}
