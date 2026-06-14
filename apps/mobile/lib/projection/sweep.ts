// apps/mobile/lib/projection/sweep.ts
//
// Migration 014 (Mythos round-3 design). The quarantine sweep.
//
// PURPOSE: retry every event_log row where applied_at IS NULL AND
// tombstone_reason IS NULL, in HLC-ascending order per vault (causal
// order across devices — prereqs from different devices resolve in one
// pass because elevation/credential events sort before their dependent
// events by HLC).
//
// TRIGGERS (callers schedule a sweep):
//   (a) verifyAndIngest inserted a new row → maybe the new row is a
//       membership/prereq that cures something (e.g. an admission event
//       binding a signer's device → unknown_actor quarantines for that
//       signer may now be applyable).
//   (b) a role-changing event applied → role_insufficient quarantines
//       below the new role's HLC are now applyable.
//
// DEBOUNCE: per-vault Set<string>. Multiple triggers for the same
// vault within 100ms collapse to one sweep. Per-vault tracking
// (not a single global boolean) prevents the second vault from
// being silently dropped — Mythos round-3 sweep-bug #1.
//
// MUTEX: a single sweep mutex serializes all sweeps and prevents
// interleaving with applyIncomingBatch (which itself takes the same
// mutex — wired in commit 5). Both code paths mutate projections via
// the same applier dispatch; concurrent runs would interleave projection
// writes even if SQLite serialized the statements at the storage layer.
//
// VERDICT HANDLING (Mythos round-3 sweep-bug #2): explicit taxonomy.
// Unknown verdicts NEVER reach permanence — they go to quarantine
// (applier_throw) with a loud log.

import { Mutex } from "../util/mutex";

import { getDb } from "../db";
import type { LedgerEvent } from "../events";
import { applyAlreadyIngestedEvent } from "./replay";
import type { ApplyAlreadyIngestedVerdict } from "./replay";

// ---------------------------------------------------------------------------
// Per-vault debounced scheduling
// ---------------------------------------------------------------------------

const SWEEP_DEBOUNCE_MS = 100;

const pendingSweepVaults = new Set<string>();
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/** Exported so applyIncomingBatch (commit 5) can take the same mutex. */
export const sweepMutex = new Mutex();

/**
 * Schedule a sweep for a vault. Idempotent and debounced: multiple
 * calls inside SWEEP_DEBOUNCE_MS collapse to one sweep per vault, but
 * different vaults all run in the next batch.
 */
export function scheduleSweep(vaultId: string): void {
  pendingSweepVaults.add(vaultId);
  if (sweepTimer != null) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    const vaults = Array.from(pendingSweepVaults);
    pendingSweepVaults.clear();
    void runScheduledSweeps(vaults);
  }, SWEEP_DEBOUNCE_MS);
}

async function runScheduledSweeps(vaultIds: string[]): Promise<void> {
  // The mutex protects all sweeps + applyIncomingBatch from
  // interleaving. We hold it for the WHOLE batch (one acquisition,
  // all vaults) so a vault-2 trigger that arrives mid-vault-1-sweep
  // doesn't double-acquire.
  await sweepMutex.runExclusive(async () => {
    for (const vaultId of vaultIds) {
      try {
        await sweepQuarantine(vaultId);
      } catch (err) {
        // A sweep should never throw — sweepQuarantine catches per-row.
        // If it does, log loud and continue to the next vault rather
        // than aborting the whole batch.
        console.error(`[sweep] sweepQuarantine threw for vault=${vaultId}`, err);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sweep implementation
// ---------------------------------------------------------------------------

type EventLogRow = {
  event_id: string;
  event_type: string;
  vault_id: string | null;
  target_id: string | null;
  relationship_id: string | null;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  device_id: string;
  author_user_id_local_only: string | null;
  actor_account_id: string | null;
  payload_json: string;
  payload_schema: number;
  appended_at: number;
  server_acked_at: number | null;
  rejected_at: number | null;
  origin: string;
  event_sig_b64: string | null;
  signer_device_pubkey: string | null;
  ingested_at: number;
};

/**
 * One pass over all quarantined rows for a vault. HLC-ascending
 * interleaves devices, which is what we want for causal-order healing:
 * a credential from device Y at HLC 50 sorts before a dependent event
 * from device X at HLC 100, so the credential applies first and the
 * dependent event no longer fails role-gate on the second try.
 */
async function sweepQuarantine(vaultId: string): Promise<void> {
  const db = await getDb();
  // Uses idx_event_log_quarantine partial index (predicate matches
  // exactly).
  const rows = await db.getAllAsync<EventLogRow>(
    `SELECT
       event_id, event_type, vault_id, target_id, relationship_id,
       hlc_physical_ms, hlc_logical, hlc_device_id,
       device_id, author_user_id_local_only, actor_account_id,
       payload_json, payload_schema,
       appended_at, server_acked_at, rejected_at, origin,
       event_sig_b64, signer_device_pubkey, ingested_at
     FROM event_log
     WHERE vault_id = ?
       AND applied_at IS NULL
       AND tombstone_reason IS NULL
     ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC`,
    vaultId,
  );

  if (rows.length === 0) return;
  console.log(`[sweep] vault=${vaultId.slice(0, 8)} rows=${rows.length}`);

  let applied = 0;
  let stillQuarantined = 0;
  let tombstoned = 0;

  for (const row of rows) {
    const event = rowToLedgerEvent(row);
    if (event == null) {
      // payload_json parse failed at sweep time. Tombstone as schema_
      // invalid — the row will never apply with a corrupt payload.
      // (Loud-log at row level so logcat surfaces which event_id.)
      console.error(
        `[sweep] payload parse failed event=${row.event_id} type=${row.event_type} — tombstoning as schema_invalid`,
      );
      await applyVerdict(row.event_id, { kind: "tombstoned", reason: "schema_invalid" });
      tombstoned++;
      continue;
    }
    let verdict: ApplyAlreadyIngestedVerdict;
    try {
      verdict = await applyAlreadyIngestedEvent(event);
    } catch (err) {
      // applyAlreadyIngestedEvent is supposed to catch and classify
      // internally; an escape here is itself a bug. Log loud and
      // bias to applier_throw quarantine so the next sweep retries.
      console.error(`[sweep] applyAlreadyIngestedEvent threw for ${row.event_id}`, err);
      verdict = { kind: "quarantined", reason: "applier_throw" };
    }
    await applyVerdict(row.event_id, verdict);
    if (verdict.kind === "applied") applied++;
    else if (verdict.kind === "tombstoned") tombstoned++;
    else stillQuarantined++;
  }

  console.log(
    `[sweep] vault=${vaultId.slice(0, 8)} applied=${applied} stillQuarantined=${stillQuarantined} tombstoned=${tombstoned}`,
  );

  // Mesh-ingested events become visible projections HERE (applyIncomingBatch
  // ingests, then this sweep applies). Notify the UI so a synced tally appears
  // without pull-to-refresh. origin="remote": these are peer events, never the
  // local user's writes, so this must NOT trigger the mesh push loop.
  if (applied > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { emitLedgerApplied } = require("../ledger-events") as {
        emitLedgerApplied: (vaultId: string, origin: "local" | "remote" | "backfill") => void;
      };
      emitLedgerApplied(vaultId, "remote");
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Apply a verdict to a single row's state-machine columns. The state-
 * machine triggers enforce mutual-exclusion on writes; the SET clauses
 * here are structured so the resulting row state is always valid.
 *
 * Mythos round-3 sweep-bug #2 hardening: switch is exhaustive over the
 * union; the type checker enforces that an unhandled verdict shape
 * would be caught at compile time, not at runtime UPDATE.
 */
async function applyVerdict(eventId: string, verdict: ApplyAlreadyIngestedVerdict): Promise<void> {
  const db = await getDb();
  switch (verdict.kind) {
    case "applied": {
      await db.runAsync(
        `UPDATE event_log
            SET applied_at = ?, quarantine_reason = NULL, tombstone_reason = NULL
          WHERE event_id = ?`,
        Date.now(),
        eventId,
      );
      return;
    }
    case "quarantined": {
      await db.runAsync(
        `UPDATE event_log
            SET quarantine_reason = ?, tombstone_reason = NULL
          WHERE event_id = ?
            AND applied_at IS NULL`,
        verdict.reason,
        eventId,
      );
      return;
    }
    case "tombstoned": {
      await db.runAsync(
        `UPDATE event_log
            SET tombstone_reason = ?, quarantine_reason = NULL
          WHERE event_id = ?
            AND applied_at IS NULL`,
        verdict.reason,
        eventId,
      );
      return;
    }
  }
}

function rowToLedgerEvent(row: EventLogRow): LedgerEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    vault_id: row.vault_id,
    target_id: row.target_id ?? "",
    relationship_id: row.relationship_id,
    hlc: {
      pms: row.hlc_physical_ms,
      l: row.hlc_logical,
      did: row.hlc_device_id,
    },
    device_id: row.device_id,
    author_user_id_local_only: row.author_user_id_local_only ?? "",
    actor_account_id: row.actor_account_id,
    payload,
    payload_schema: row.payload_schema,
    appended_at: row.appended_at,
    server_acked_at: row.server_acked_at,
    rejected_at: row.rejected_at,
    origin: row.origin,
    event_sig_b64: row.event_sig_b64,
    signer_device_pubkey: row.signer_device_pubkey,
  } as unknown as LedgerEvent;
}
