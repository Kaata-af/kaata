// apps/mobile/lib/projection/replay.ts
//
// Migration 014 (Mythos round-3 design). Replay-only path for events
// ALREADY ingested (row exists on disk with ingested_at set,
// applied_at/quarantine_reason/tombstone_reason NULL or quarantine_
// reason set but pending retry).
//
// Why this exists separately from projection/index.ts applyEvent:
//
//   1. applyEvent does INSERT OR IGNORE FIRST, then role-gate, then
//      applier dispatch. The INSERT detects an already-on-disk row as
//      a "duplicate" and exits with reason='duplicate' BEFORE reaching
//      apply — so calling applyEvent on a row already on disk silently
//      no-ops. Useless for the migration-time re-apply pass and for
//      the runtime sweep.
//
//   2. applyEvent calls recordRoleGateReject on the role-gate path,
//      which writes a plain (no OR IGNORE, no UNIQUE) row into
//      projection_conflicts. Re-invoking applyEvent on a role-gate-
//      refused row would write a DUPLICATE projection_conflicts row
//      every retry — projection_conflicts would grow unboundedly under
//      a stuck quarantined row.
//
// This module:
//   - Skips the INSERT entirely.
//   - Runs the role-gate check (read-only on credentials/role events).
//   - Runs the applier in a sub-transaction.
//   - Returns a typed verdict so the caller (sweep, runFullReapplyAfter
//     Migration) can drive the state-machine UPDATEs.
//   - Does NOT touch projection_conflicts. The original applyEvent
//     attempt wrote the row already; a recurring failure doesn't
//     surface as new conflict spam.

import * as SQLite from "expo-sqlite";

import type { LedgerEvent } from "../events";
import { getDb } from "../db";
import { APPLIERS } from "./index";
import { MissingPrereqError } from "./errors";
import { isKnownEventType, isUserLedgerEventType } from "../events";
import type { RoleGateResult } from "./role-gate";
import { checkRoleForEvent } from "./role-gate";
import type { QuarantineReason, TombstoneReason } from "../ingest-types";

type SQLiteTx = SQLite.SQLiteDatabase;

/**
 * Result of a replay attempt. Drives the caller's state-machine UPDATE
 * on event_log.
 *
 * "applied"  → set applied_at = now, quarantine_reason = NULL.
 * "quarantined" → set quarantine_reason = reason; clear applied_at,
 *                tombstone_reason.
 * "tombstoned"  → set tombstone_reason = reason; clear quarantine_
 *                reason, applied_at. Row stays in event_log; will not
 *                be retried.
 */
export type ApplyAlreadyIngestedVerdict =
  | { kind: "applied" }
  | { kind: "quarantined"; reason: QuarantineReason }
  | { kind: "tombstoned"; reason: TombstoneReason };

/**
 * Best-effort classification of an applier throw into a QUARANTINE
 * reason. Tombstoning is intentionally NOT a possible outcome here.
 *
 * Mythos round-4 hard rule: **a thrown error may never produce a
 * tombstone.** Tombstones are permanent, never-relay, never-retry
 * verdicts; the only place they should be set is where the code KNOWS
 * (ingest-time signature verification, ingest-time structural
 * validation in verifyAndIngest). By the time an applier runs, the
 * payload's structure was already validated; a schema-ish-looking
 * throw from an applier is either a programming bug or a disguised
 * prereq — neither warrants permanent data loss.
 *
 * The previous string-matcher had a middle branch that mapped
 * "unexpected"/"invalid"/"malformed"/"schema" substrings to
 * tombstoned — and "unexpected" appears in SQLite's standard error
 * vocabulary AND in half of generic JS error messages. Any transient
 * throw whose text happened to contain those substrings permanently
 * buried a ledger entry. In a "your entries never disappear" product
 * that's wrong-direction misclassification by substring.
 *
 * Worst case under the new rule: a genuinely-schema-invalid row
 * keeps retrying every sweep, generating log noise until a human
 * notices. Bounded annoyance with zero data loss. The label
 * (missing_prereq vs applier_throw) is cosmetic since both land in
 * quarantine — kept for telemetry, not for branching behavior.
 *
 * A future typed-error refactor (applier throws ProgrammingBugError /
 * MissingPrereqError / etc.) would make the labels precise; deferred
 * because the new rule already removes the safety risk and the
 * refactor touches every projection file.
 */
function classifyApplierThrow(err: unknown): ApplyAlreadyIngestedVerdict {
  // Typed prerequisite signal — the applier KNOWS the referenced row
  // (entry/person to mutate) isn't on disk yet. Authoritative, not
  // message-string-dependent. Cured by a later sweep once the create lands.
  if (err instanceof MissingPrereqError) {
    return { kind: "quarantined", reason: "missing_prereq" };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("missing") ||
    lower.includes("no such") ||
    lower.includes("foreign key")
  ) {
    return { kind: "quarantined", reason: "missing_prereq" };
  }
  // Unknown applier failure. Treat as transient; the next sweep
  // retries. Loud-log at the call site (sweep.ts catches and logs).
  return { kind: "quarantined", reason: "applier_throw" };
}

/**
 * Map a role-gate refusal into the quarantine/tombstone taxonomy.
 *
 *   insufficient_role / unknown_actor → quarantine (curable by role-
 *      change or credential-arrival events).
 *   unsigned_event → tombstone (NEVER cured — even if the credential
 *      arrives, we still have no signature to verify).
 *   bad_signature → tombstone (signature doesn't verify against the
 *      pinned credential; this row should never have been ingested
 *      under the new pipeline, but legacy rows may exist).
 *
 * CRITICAL CARVE-OUT (tallies never disappear): a tombstone is a PERMANENT,
 * never-retried, never-cleared terminal state. For USER LEDGER DATA (the entry,
 * person, and shop_profile event families) we must NEVER reach it on a
 * signature condition. The server itself accepts and re-ships unsigned legacy
 * user events (pre-Phase-8 rows pushed before signing was wired); routing those
 * to a tombstone on the server-pull → sweep path would permanently bury exactly
 * the tallies this whole fix exists to save. The OLD applyEvent pull path
 * always quarantined a role-gate refusal (retryable) regardless of reason —
 * preserve that for user data here. Membership/device/vault events still
 * tombstone on a bad/absent signature: those are an attack surface, the server
 * holds their canonical copy, and a forged one must never apply.
 */
function classifyRoleGateRefusal(
  result: Extract<RoleGateResult, { ok: false }>,
  eventType: string,
): ApplyAlreadyIngestedVerdict {
  switch (result.reason) {
    case "insufficient_role":
      return { kind: "quarantined", reason: "role_insufficient" };
    case "unknown_actor":
      return { kind: "quarantined", reason: "unknown_actor" };
    case "unsigned_event":
    case "bad_signature":
      // User data → quarantine (retryable / never permanently buried). The
      // reason label is cosmetic; role_insufficient matches the old pull path.
      if (isUserLedgerEventType(eventType)) {
        return { kind: "quarantined", reason: "role_insufficient" };
      }
      return { kind: "tombstoned", reason: result.reason };
  }
}

/**
 * Replay a single already-ingested event. The row is assumed to exist
 * in event_log already; this function does NOT call INSERT and does
 * NOT touch projection_conflicts. The caller updates the row's
 * state-machine columns based on the returned verdict.
 *
 * Note: this function does NOT bump the HLC frontier. Frontier is
 * advanced at INGEST time (verifyAndIngest's caller calls tickReceive
 * before the INSERT — see anti-entropy.ts commit 5). Replay does not
 * change frontier state.
 */
export async function applyAlreadyIngestedEvent(
  event: LedgerEvent,
): Promise<ApplyAlreadyIngestedVerdict> {
  if (!isKnownEventType(event.event_type)) {
    // Unknown event_type means the local code doesn't know what to do
    // with this payload. Tombstone permanently — no future credential
    // or prereq will help. Schema-version drift handled by a separate
    // migration if/when needed.
    return { kind: "tombstoned", reason: "schema_invalid" };
  }
  if (event.vault_id == null) {
    // Migration 007 invariant: every event has vault_id. A row without
    // vault_id is pre-migration backfill — those are all already
    // backfilled as applied at migration time, so we shouldn't reach
    // this path. If we do: tombstone, because the role-gate needs
    // vault_id to resolve actor role.
    return { kind: "tombstoned", reason: "schema_invalid" };
  }
  const applier = APPLIERS[event.event_type];
  if (!applier) {
    return { kind: "tombstoned", reason: "schema_invalid" };
  }

  const db = await getDb();
  let verdict: ApplyAlreadyIngestedVerdict | null = null;

  await db
    .withTransactionAsync(async () => {
      // 1. role-gate. Read-only on credentials and role-events.
      const gate = await checkRoleForEvent(db as SQLiteTx, event);
      if (!gate.ok) {
        verdict = classifyRoleGateRefusal(gate, event.event_type);
        return; // commit the txn — gate doesn't mutate state.
      }

      // 2. applier dispatch. Throws roll the sub-txn back; we classify
      // the throw outside the await so the verdict survives the rollback.
      try {
        await applier(db as SQLiteTx, event);
      } catch (err) {
        verdict = classifyApplierThrow(err);
        // Re-throw so the txn rolls back — we don't want a half-applied
        // projection. The verdict is captured already.
        throw new Error("__replay_rollback__");
      }
      verdict = { kind: "applied" };
    })
    .catch((err) => {
      // Filter our sentinel rollback. Any OTHER throw is a SQLite-level
      // failure (e.g., trigger violation, busy) — surface as applier_
      // throw quarantine so the sweep retries.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "__replay_rollback__") return;
      // Unexpected txn-layer error. Bias to quarantine for retry; loud
      // log so the next sweep's log shows it.
      console.warn(`[replay] txn-layer failure for ${event.event_id}`, err);
      verdict = { kind: "quarantined", reason: "applier_throw" };
    });

  // Defensive: if verdict is somehow still null (shouldn't happen),
  // quarantine for retry rather than asserting. The state machine NEVER
  // accepts an unknown verdict reaching permanence.
  if (verdict == null) {
    console.warn(
      `[replay] verdict was unset after txn for ${event.event_id} — defaulting to applier_throw`,
    );
    return { kind: "quarantined", reason: "applier_throw" };
  }
  return verdict;
}
