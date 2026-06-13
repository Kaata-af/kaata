// apps/mobile/lib/ingest-types.ts
//
// Migration 014 (Mythos round-3 design). The ingest path's verdict types
// and the verifyAndIngest function for REMOTE events arriving via the
// mesh anti-entropy delta exchange.
//
// LOCAL events do NOT go through this path — they continue through
// projection/index.ts's applyEvent which does ingest + apply atomically
// (correct: locally-authored events are pre-trusted, and the single-txn
// guarantee avoids a stale-projection window).
//
// REMOTE events flow:
//
//   wire → verifyAndIngest (this file) → durable INSERT with
//                                        ingested_at=now,
//                                        applied_at=NULL,
//                                        quarantine_reason=NULL,
//                                        tombstone_reason=NULL
//        → scheduleSweep(vaultId) (commit 4)
//        → sweepQuarantine picks up the row and calls
//          applyAlreadyIngestedEvent (commit 3) to transition
//          state to applied / quarantined / tombstoned.
//
// The ingest commit is SEPARATE from the apply attempt. This is the
// crux of the data-loss fix — we durably acknowledge receipt of every
// signature-verified event the peer sends us, even ones we can't yet
// apply, so the summary head can advance truthfully and the peer never
// needs to re-send.

import type { LedgerEvent } from "./events";
import type { EventVerifyResult } from "./event-sig";
import { verifyEventSignature } from "./event-sig";

// ---------------------------------------------------------------------------
// Enum types
// ---------------------------------------------------------------------------

/**
 * Apply was skipped for a reason that MIGHT BE CURED by future events.
 * The sweep retries these on triggers:
 *   (a) new ingest of any event into this vault
 *   (b) a role-changing / membership event applies
 *
 * All triggers are debounced (commit 4) to one sweep per anti-entropy
 * round per vault.
 */
export type QuarantineReason =
  /** Signer's device->account binding not yet in the membership chain
   *  (vault_device_registry). Cured by mesh delivery of the owner's
   *  admission events (vault_member_added + vault_device_added). */
  | "unknown_actor"
  /** Applier needs a referenced row (target_id, relationship_id) that
   *  hasn't arrived yet. Cured when the prereq event applies. */
  | "missing_prereq"
  /** role-gate refused at this HLC. Cured by a later-arriving
   *  role-elevation event whose HLC is ≤ this event's HLC. */
  | "role_insufficient"
  /** Applier threw an unexpected error — possibly transient
   *  (SQLite busy, OOM). Retried; if it throws again the next sweep
   *  retries again. Loud-log on every throw. */
  | "applier_throw";

/**
 * Apply will NEVER happen for this row. The row stays in event_log
 * for:
 *   - SUMMARY HEAD ADVANCEMENT (receipt ≠ acceptance; we durably
 *     received this regardless of accept/reject).
 *   - Audit trail.
 *
 * Tombstoned rows are NOT relayed (the send filter excludes them).
 * The asymmetry is intentional: we never propagate something we are
 * cryptographically certain is bad, but the head movement prevents
 * the peer from re-sending it forever.
 *
 * IMPORTANT: 'server_rejected' is NOT a tombstone reason. Server-
 * authoritative rejection (push.ts:184) happens AFTER local apply
 * succeeded — folding it into tombstone_reason would crash the push
 * path because applied_at + tombstone_reason violates the state
 * machine. rejected_at stays orthogonal. See migration-014 comment
 * block for the full reasoning.
 */
export type TombstoneReason =
  /** Embedded sig didn't verify against embedded signer_device_pubkey.
   *  AEAD already rules out transit corruption, so this is a hostile
   *  or broken peer. */
  | "bad_signature"
  /** Remote event arrived without signer_device_pubkey AND/OR
   *  event_sig_b64. Per Mythos point 3 these are refused AT INGEST
   *  (never inserted) — this reason is reserved for the migration-014
   *  backfill case where a wire-schema downgrade leaves us with such
   *  a row already on disk. */
  | "unsigned_event"
  /** payload JSON parse failed at ingest, OR event_type unknown, OR
   *  vault_id mismatches the credential's vault scope. Structural
   *  refusal — never retryable. */
  | "schema_invalid";

/**
 * Result of verifyAndIngest on a single remote event.
 *
 * "ingested" — durably written to event_log, ingested_at set, apply
 * deferred to the sweep. quarantineReason is NULL at this point because
 * apply hasn't been attempted yet; the sweep determines that.
 *
 * "tombstoned" — written to event_log with tombstone_reason set, head
 * advances, but never relayed and never retried.
 *
 * "refused_pre_insert" — NOTHING written to event_log. Reserved for:
 *   - Cap hit: too many unknown_actor rows for this (vault, device).
 *     Flood defense. The summary head DOES NOT advance for refused-
 *     pre-insert rows, so the peer will re-send if conditions change
 *     (credential lands, freeing the cap).
 *   - Duplicate: event_id already exists. INSERT OR IGNORE would skip
 *     it anyway; we surface the verdict so the caller can count it.
 *   - missing_signer_pubkey: wire schema gap. Caller should log a
 *     loud warning so a bad peer can be identified.
 *   - bad_signature_pre_ingest: signature didn't verify against the
 *     embedded pubkey. The pre-insert refusal vs tombstone choice for
 *     bad sig depends on whether we want to advance the head for it.
 *     For NOW: tombstone (advance head, never relay). bad_signature_
 *     pre_ingest is reserved for a future caller that wants the head
 *     NOT to advance (e.g. a sig-verification-must-precede-any-state-
 *     write policy).
 */
export type IngestVerdict =
  | { kind: "ingested" }
  | { kind: "tombstoned"; reason: TombstoneReason }
  | { kind: "refused_pre_insert"; reason: PreInsertRefusalReason };

export type PreInsertRefusalReason =
  | "quarantine_cap_hit"
  | "duplicate"
  | "missing_signer_pubkey"
  | "bad_signature_pre_ingest";

// ---------------------------------------------------------------------------
// Caps (Mythos round-3 Q3 refined)
// ---------------------------------------------------------------------------

/**
 * Cap on quarantine_reason='unknown_actor' rows per (vault, device).
 * This is the flood vector: an attacker who passes a handshake (Path C
 * TOFU) but doesn't pin a credential could otherwise stream unbounded
 * unknown_actor rows into our quarantine until disk runs out.
 *
 * 64 = ~2 days of legitimate event volume from a single device at
 * typical shopkeeper rates. Well above noise, well below storage
 * concern. Telemetry on hit so a recurring trip is investigated.
 */
export const UNKNOWN_ACTOR_CAP_PER_PEER = 64;

/**
 * Sanity ceiling on credentialed-but-quarantined rows per (vault,
 * device). Mythos point 3 — credentialed devices SHOULD NOT be capped
 * (the legitimate case is a staff phone returning from weeks offline),
 * so this is intentionally far above the realistic case. Trips only on
 * a runaway loop / corrupted state. Telemetry on hit so we know.
 */
export const CREDENTIALED_QUARANTINE_SANITY_CAP_PER_PEER = 10_000;

// ---------------------------------------------------------------------------
// verifyAndIngest
// ---------------------------------------------------------------------------

/**
 * Inputs needed by verifyAndIngest. Pulled out as an interface so the
 * function can be tested without wiring it to the full db module.
 */
export type IngestContext = {
  /** Check whether event_id already exists in event_log. */
  hasEventId: (eventId: string) => Promise<boolean>;
  /** Count unknown_actor quarantine rows for (vault_id, device_id). */
  countUnknownActorQuarantine: (vaultId: string, deviceId: string) => Promise<number>;
  /** INSERT the row. Caller wires this to event_log INSERT — see
   *  anti-entropy.ts's applyIncomingBatch refactor in commit 5. */
  insertIngested: (event: LedgerEvent, ingestedAtMs: number) => Promise<void>;
  /** INSERT the row as tombstoned with the given reason. Caller wires
   *  this to an event_log INSERT with tombstone_reason set. */
  insertTombstoned: (
    event: LedgerEvent,
    tombstoneReason: TombstoneReason,
    ingestedAtMs: number,
  ) => Promise<void>;
};

/**
 * verifyAndIngest. Called on every remote event arriving in a
 * DeltaMessage. Returns an IngestVerdict; caller updates counters /
 * logs / schedules the sweep accordingly.
 *
 * Order of checks matters and is documented inline.
 */
export async function verifyAndIngest(
  event: LedgerEvent,
  ctx: IngestContext,
): Promise<IngestVerdict> {
  const now = Date.now();

  // ---- 1. Required wire fields. Refuse pre-insert. ----
  //
  // We need an embedded pubkey to verify against, and a signature to
  // verify. Without both we can't bind the event to ANY identity and
  // it would be unsafe to durably acknowledge.
  if (typeof event.signer_device_pubkey !== "string" || event.signer_device_pubkey.length === 0) {
    return { kind: "refused_pre_insert", reason: "missing_signer_pubkey" };
  }
  if (typeof event.event_sig_b64 !== "string" || event.event_sig_b64.length === 0) {
    return { kind: "refused_pre_insert", reason: "missing_signer_pubkey" };
  }

  // ---- 2. Signature verify against the EMBEDDED pubkey. ----
  //
  // This proves the event is self-consistent: whoever holds the
  // private key matching signer_device_pubkey signed THIS event.
  // It does NOT prove they're a member of this vault — that's the
  // applyAlreadyIngestedEvent role-gate's job (commit 3).
  //
  // If verify FAILS: tombstone. The row is durably written with
  // tombstone_reason='bad_signature' so the summary head advances
  // (the peer never re-sends), but the row is never relayed.
  // Tombstoning here (vs refusing pre-insert) prevents the
  // resend-forever loop on a peer with one stuck bad event.
  const verifyResult: EventVerifyResult = verifyEventSignature(
    event,
    event.event_sig_b64,
    event.signer_device_pubkey,
  );
  if (!verifyResult.valid) {
    await ctx.insertTombstoned(event, "bad_signature", now);
    return { kind: "tombstoned", reason: "bad_signature" };
  }

  // ---- 3. Duplicate check. ----
  //
  // event_log has event_id as PRIMARY KEY so INSERT OR IGNORE would
  // skip the duplicate, but we surface the verdict explicitly so
  // applyIncomingBatch (commit 5) can count actual-duplicates vs
  // unexpected-not-applied separately. Mythos round-2 audit-item #3.
  if (await ctx.hasEventId(event.event_id)) {
    return { kind: "refused_pre_insert", reason: "duplicate" };
  }

  // ---- 4. unknown_actor cap. ----
  //
  // We don't yet know whether this event's signer is credentialed in
  // this vault — that's the apply-time check. But we can pre-empt the
  // flood vector by capping unknown_actor rows per (vault, device). If
  // adding ONE MORE would push us past the cap, refuse pre-insert.
  //
  // Note: this cap CAN refuse a legitimate event from a not-yet-
  // credentialed device. That's the explicit trade-off: bound storage
  // at the cost of needing the peer to re-send those events once the
  // credential lands. Since refusing pre-insert does NOT advance the
  // summary head, the peer's next round will re-send.
  if (event.vault_id != null) {
    const currentCount = await ctx.countUnknownActorQuarantine(event.vault_id, event.device_id);
    if (currentCount >= UNKNOWN_ACTOR_CAP_PER_PEER) {
      return { kind: "refused_pre_insert", reason: "quarantine_cap_hit" };
    }
  }

  // ---- 5. Ingest. ----
  //
  // Sets ingested_at=now. applied_at/quarantine_reason/tombstone_reason
  // all NULL — apply attempt happens later via the sweep
  // (scheduleSweep, commit 4). The state-machine trigger allows this
  // because none of the three mutually-exclusive flags is set.
  await ctx.insertIngested(event, now);
  return { kind: "ingested" };
}
