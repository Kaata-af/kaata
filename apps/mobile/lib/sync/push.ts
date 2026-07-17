// Push the local outbox to the server. Reads every event_log row for the
// active vault that has neither server_acked_at nor rejected_at set, posts
// them as a single batch to /v1/sync/push, and on response:
//
//   accepted[]   → stamp server_acked_at = Date.now() on those rows
//   duplicates[] → same as accepted (the server already has them; our local
//                  flag is wrong and we're correcting it)
//   rejected[]   → depends on the reason: retryable reasons (seq_conflict,
//                  future_hlc) and user-ledger events stay unacked for retry
//                  with per-event bookkeeping (push_attempts /
//                  last_reject_reason / next_push_at backoff, migration 022);
//                  only non-user events with a permanent reason get
//                  rejected_at = Date.now() plus a projection_conflicts row
//
// pushEvents is called independently of pull: the scheduler's per-tick syncOnce
// runs push even when pull failed, and every local write fires an immediate
// pull-free pushVaultNow. The ack write-transaction therefore holds applyEventMutex
// (see below) to serialize against concurrent applyEvent / pull tx on the single
// shared SQLite connection.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { getAppMeta, setAppMeta } from "../db";
import { getDb, getInstallIdSync } from "../db-tx";
import { isUserLedgerEventType } from "../events";
import { applyEventMutex } from "../projection";
import { notifyProjectionConflictsChanged } from "../projection-conflicts";
import { markPushDone } from "./cursor";
import { markSelfMembershipRevoked, markVaultArchivedFromServer } from "./pull";
import {
  PermissionRejectedError,
  SessionExpiredError,
  SyncTimeoutError,
  SyncTransientError,
  VaultNotRegisteredError,
} from "./errors";

const PUSH_TIMEOUT_MS = 30_000;
// Max events per push request. The backend caps decompressed body at 16 MiB;
// the average event payload is well under 1 KiB so 500 is a safe ceiling.
const MAX_BATCH_SIZE = 500;

// Exponential backoff for rows the server keeps rejecting with a
// permanent-looking reason (insufficient_role / unauthored_pre_binding /
// unhandled): 30s, 1m, 2m, … capped at 1h. The row stays unacked — never
// rejected_at for user-ledger events (see the dd5c31f comments in the
// rejected loop) — but stops hot-looping through the HLC-ascending batch.
// Without this, ≥MAX_BATCH_SIZE stuck rows (by construction the OLDEST
// HLCs) fill the whole batch every cycle and starve every newer event,
// including the account_bound whose commit would cure the
// unauthored_pre_binding rejections in the first place.
const REJECT_BACKOFF_BASE_MS = 30_000;
const REJECT_BACKOFF_CAP_MS = 60 * 60_000;

function rejectBackoffMs(attempts: number): number {
  // 2 ** large is Infinity; Math.min clamps it to the cap.
  return Math.min(REJECT_BACKOFF_CAP_MS, REJECT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

type EventRow = {
  event_id: string;
  event_type: string;
  vault_id: string | null;
  target_id: string;
  relationship_id: string | null;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  device_id: string;
  author_user_id_local_only: string;
  actor_account_id: string | null;
  payload_json: string;
  payload_schema: number;
  appended_at: number;
  author_seq: number | null;
  event_sig_b64: string | null;
  signer_device_pubkey: string | null;
  push_attempts: number;
};

type WireEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  target_id: string | null;
  relationship_id: string | null;
  hlc: { physical_ms: number; logical: number; device_id: string };
  actor_account_id: string | null;
  payload: unknown;
  // Sync v2 M1: per-author sequence (migration 018). Optional on the wire —
  // legacy mesh-ingested rows may not carry one.
  author_seq?: number;
  // M2 (review P0): the Ed25519 envelope signature MUST cross the HTTPS
  // channel. Without it, server-synced replicas store membership events
  // with NULL signatures — the chain verifier (lib/trust) refuses them
  // (missing_signature), the role-gate quarantines them (unsigned_event),
  // and HTTPS-only members can never verify the chain or honor a removal.
  event_sig_b64?: string | null;
  signer_device_pubkey?: string | null;
};

type PushResponse = {
  accepted: Array<{ event_id: string; server_seq: number }>;
  duplicates: string[];
  rejected: Array<{
    event_id: string;
    reason: string;
    current_role?: string;
    required_role?: string;
  }>;
  vault_server_seq_high: number;
};

export type PushResult = {
  pushed: number;
  duplicates: number;
  rejected: number;
};

export async function pushEvents(vaultId: string): Promise<PushResult> {
  const jwt = await getSessionJWT();
  if (!jwt) {
    // Local-only user. Silent no-op — sync only runs after Google sign-in.
    return { pushed: 0, duplicates: 0, rejected: 0 };
  }

  const db = await getDb();

  // One-shot seq re-announce (Sync v2 M1). Migration 018 numbered our own
  // pre-M1 history, but those rows are already server-acked and would
  // never be re-pushed — leaving the server permanently seq-less for this
  // device's history and the vector permanently unprovable. Un-ack our own
  // sequenced rows ONCE; the normal push machinery re-sends them, the
  // server treats them as duplicates and back-fills author_seq onto its
  // stored rows (duplicate re-announce path, backend service.go).
  const reannounceKey = `seq_reannounce_pending:${vaultId}`;
  if ((await getAppMeta(reannounceKey)) === "1") {
    await db.runAsync(
      `UPDATE event_log SET server_acked_at = NULL
        WHERE vault_id = ? AND device_id = ?
          AND author_seq IS NOT NULL
          AND server_acked_at IS NOT NULL
          AND rejected_at IS NULL
          AND tombstone_reason IS NULL`,
      vaultId,
      getInstallIdSync(),
    );
    // Clear immediately — the rows now sit in the outbox and drain over
    // the next cycles; a crash mid-drain loses nothing (they stay unacked
    // until the server acks them again).
    await setAppMeta(reannounceKey, "");
  }
  const rows = await db.getAllAsync<EventRow>(
    // Migration 014 (Mythos round-3): also exclude tombstoned rows.
    // Tombstoned events are locally-believed-bad-signature or schema-
    // invalid; pushing them is wasteful and surfaces noise to the
    // server. The idx_event_log_unsynced partial index (migration 005)
    // doesn't include tombstone_reason yet, so the planner picks up
    // the index then filters in memory. A follow-up index migration
    // could fold tombstone_reason into the partial predicate.
    // next_push_at (migration 022) is the reject-backoff gate: rows the server
    // keeps rejecting sit out until their backoff elapses instead of hogging
    // the oldest-HLC slots of every batch. NULL = never rejected = eligible.
    `SELECT event_id, event_type, vault_id, target_id, relationship_id,
            hlc_physical_ms, hlc_logical, hlc_device_id,
            device_id, author_user_id_local_only, actor_account_id,
            payload_json, payload_schema, appended_at, author_seq,
            event_sig_b64, signer_device_pubkey, push_attempts
       FROM event_log
      WHERE vault_id = ?
        AND server_acked_at IS NULL
        AND rejected_at IS NULL
        AND tombstone_reason IS NULL
        AND (next_push_at IS NULL OR next_push_at <= ?)
      ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC
      LIMIT ?`,
    vaultId,
    Date.now(),
    MAX_BATCH_SIZE,
  );

  if (rows.length === 0) {
    // Empty outbox = every event we've authored is already server-acked, so
    // this vault is fully backed up. Stamp last_push_at so the status reads
    // "Backed up" instead of a permanent "Not backed up yet". Without this, a
    // fully-synced vault (steady state, or one restored on sign-in) reads
    // max(last_pull_at=0, last_push_at=0) = "never" forever even while online.
    //
    // This is honest, not optimistic: an empty outbox means every locally
    // authored event for this vault is already server-acked (unacked rows keep
    // rows.length > 0 until the server confirms them), so we never claim "backed
    // up" for data the server doesn't have. (The backup-status UI was since
    // removed — backup is now automatic — so this timestamp is informational.)
    //
    // One wrinkle since migration 022: the SELECT above also excludes rows
    // sitting out a reject backoff, and those are NOT on the server — so an
    // empty BATCH no longer implies an empty OUTBOX. Re-check without the
    // backoff gate before stamping, keeping the honest-semantics contract.
    const backedOff = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM event_log
        WHERE vault_id = ?
          AND server_acked_at IS NULL
          AND rejected_at IS NULL
          AND tombstone_reason IS NULL
        LIMIT 1`,
      vaultId,
    );
    if (backedOff == null) {
      await markPushDone(vaultId);
    }
    return { pushed: 0, duplicates: 0, rejected: 0 };
  }

  // Seq claims are only ever transmitted for rows WE authored. A relayed
  // (mesh-ingested, foreign-authored) row's local author_seq may be a
  // migration-018 backfill INFERENCE — announcing someone else's numbering
  // as authoritative poisons their partition server-side and triggers
  // spurious seq_conflict strips. The author announces their own seqs;
  // relays carry the event seq-less until M3 puts author-asserted seqs on
  // the mesh wire.
  const ownDeviceId = getInstallIdSync();
  const events: WireEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    event_type: r.event_type,
    schema_version: r.payload_schema,
    target_id: r.target_id,
    relationship_id: r.relationship_id,
    hlc: {
      physical_ms: r.hlc_physical_ms,
      logical: r.hlc_logical,
      device_id: r.hlc_device_id,
    },
    actor_account_id: r.actor_account_id,
    payload: safeParseJSON(r.payload_json),
    ...(r.author_seq != null && r.device_id === ownDeviceId ? { author_seq: r.author_seq } : {}),
    ...(r.event_sig_b64 != null ? { event_sig_b64: r.event_sig_b64 } : {}),
    ...(r.signer_device_pubkey != null ? { signer_device_pubkey: r.signer_device_pubkey } : {}),
  }));

  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        vault_id: vaultId,
        device_id: getInstallIdSync(),
        events,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new SyncTimeoutError("push request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new SessionExpiredError();
  }
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    throw new SyncTransientError(res.status, retryAfter);
  }
  // 403 has the same two meanings as pull's (see pull.ts for the full
  // contract): error_code "not_member" = the server revoked OUR membership —
  // mirror it locally so the UI flips read-only and the scheduler stops
  // targeting the vault; anything else (vault_unknown / legacy bodyless) =
  // not registered yet, so the scheduler kicks a registration sweep.
  // Push can hit not_member before pull does (a removed editor's first
  // action is usually a write), so both paths must converge the mirror.
  if (res.status === 403) {
    let code = "";
    try {
      const parsed = (await res.json()) as { error?: string; error_code?: string };
      code = parsed.error_code ?? "";
    } catch {
      // Legacy backend / non-JSON body — keep the registration-pending read.
    }
    if (code === "not_member") {
      await markSelfMembershipRevoked(vaultId).catch((err) => {
        if (__DEV__) console.warn("[sync.push] self-revoke mirror write failed", err);
      });
      throw new VaultNotRegisteredError("membership revoked on server");
    }
    if (code === "vault_archived") {
      // Owner archived the kaata; we're still a member. Archive locally —
      // never self-revoke (see pull.ts markVaultArchivedFromServer).
      await markVaultArchivedFromServer(vaultId).catch((err) => {
        if (__DEV__) console.warn("[sync.push] local archive mirror write failed", err);
      });
      throw new VaultNotRegisteredError("vault archived on server");
    }
    throw new VaultNotRegisteredError();
  }
  if (!res.ok) {
    throw new Error(`push failed: ${res.status}`);
  }

  const body = (await res.json()) as PushResponse;
  const acceptedSet = new Set((body.accepted ?? []).map((a) => a.event_id));
  const duplicatesSet = new Set(body.duplicates ?? []);
  const rejectedList = body.rejected ?? [];

  const now = Date.now();
  let hadPermissionRejection = false;
  const rowById = new Map(rows.map((row) => [row.event_id, row]));

  // Serialize the ack/reject/conflict WRITE TRANSACTION under the same mutex as
  // applyEvent + pull's patch tx. expo-sqlite's withTransactionAsync is
  // NON-exclusive on the single shared connection, so a push BEGIN that interleaves
  // with a concurrent applyEvent BEGIN tears one of them into autocommit (silent
  // corruption). This was latently safe while push ran serially under the
  // scheduler's inFlight guard; now that writes fire an immediate, un-debounced
  // pushVaultNow (and drainAllOutboxes runs pushes in parallel), the tx MUST hold
  // the mutex. Only the DB tx is wrapped — the network round-trip above stays
  // outside, so the parallel-drain latency goal is preserved.
  await applyEventMutex.runExclusive(() =>
    db.withTransactionAsync(async () => {
      for (const eventId of acceptedSet) {
        await db.runAsync(
          "UPDATE event_log SET server_acked_at = ? WHERE event_id = ?",
          now,
          eventId,
        );
      }
      for (const eventId of duplicatesSet) {
        await db.runAsync(
          "UPDATE event_log SET server_acked_at = ? WHERE event_id = ?",
          now,
          eventId,
        );
      }
      for (const r of rejectedList) {
        // seq_conflict is NOT a verdict on the event — only on its seq claim
        // (a different event_id already holds that (vault, device, seq) slot
        // on the server; pathological — install-id clone or local reset).
        // Stamping rejected_at would permanently exile a valid event from
        // the server. Instead: drop our seq claim and let the next cycle
        // re-push the event seq-less. Also advance the per-vault assignment
        // floor past the contested slot — without it, nextAuthorSeqInTx's
        // MAX()+1 would re-mint the same seq for every future append and
        // loop a rejection round-trip per event forever.
        if (r.reason === "seq_conflict") {
          const strippedSeq = rowById.get(r.event_id)?.author_seq ?? null;
          // Count the attempt but no backoff — the strip cures the rejection,
          // so the seq-less re-push next cycle should be accepted.
          await db.runAsync(
            `UPDATE event_log
                SET author_seq = NULL,
                    push_attempts = push_attempts + 1,
                    last_reject_reason = ?
              WHERE event_id = ?`,
            r.reason,
            r.event_id,
          );
          if (strippedSeq != null) {
            const floorKey = `author_seq_floor:${vaultId}`;
            const existing = Number((await getAppMeta(floorKey)) ?? "0");
            const nextFloor = Math.max(Number.isFinite(existing) ? existing : 0, strippedSeq + 1);
            await setAppMeta(floorKey, String(nextFloor));
          }
          continue;
        }
        // future_hlc is NOT a verdict on the event — only on the device clock
        // being implausibly far ahead of server time. Stamping rejected_at would
        // permanently drop a valid event over a clock skew. Leave it unacked (no
        // rejected_at, no conflict row) so it re-pushes on later cycles and is
        // accepted once server time catches up to the device's (ratchet-forward)
        // HLC. A gross skew delays this vault's sync but never drops the event.
        if (r.reason === "future_hlc") {
          // Count the attempt but keep hot-retrying — the rejection cures
          // itself as server time advances toward the device's HLC.
          await db.runAsync(
            `UPDATE event_log
                SET push_attempts = push_attempts + 1,
                    last_reject_reason = ?
              WHERE event_id = ?`,
            r.reason,
            r.event_id,
          );
          continue;
        }
        // unauthored_pre_binding is NOT a verdict on the event — it's a transient
        // batch-ordering miss. Events authored BEFORE Google sign-in carry
        // actor_account_id=NULL; the server attributes them via a covering
        // account_bound, but account_bound has a LATER HLC and is processed later
        // in the same HLC-ordered push batch, so an early entry is rejected before
        // its binding commits server-side. Stamping rejected_at would PERMANENTLY
        // exile the entry from backup (the outbox excludes rejected_at rows and it
        // is never cleared) → "half my entries went missing on restore". Leave it
        // unacked so the NEXT push — after account_bound is committed — re-attempts
        // and is accepted. Same treatment for insufficient_role on our OWN
        // pre-binding edits, which is the post-restore account/owner-key drift, not
        // a real authorization failure; a permanent drop there is silent data loss.
        if (r.reason === "unauthored_pre_binding" || r.reason === "insufficient_role") {
          // Surface insufficient_role to the scheduler (soft failure, lands in
          // the App-health report) — a vault rejected every cycle must not look
          // identical to a healthy one.
          if (r.reason === "insufficient_role") {
            hadPermissionRejection = true;
          }
          // Still no rejected_at — but back off exponentially so these rows
          // can't monopolize the oldest-HLC batch slots. For pre-binding rows
          // the sit-out is also the CURE: it lets the later-HLC account_bound
          // into the next batch, whose commit makes the retry succeed.
          const attempts = (rowById.get(r.event_id)?.push_attempts ?? 0) + 1;
          await db.runAsync(
            `UPDATE event_log
                SET push_attempts = ?,
                    last_reject_reason = ?,
                    next_push_at = ?
              WHERE event_id = ?`,
            attempts,
            r.reason,
            now + rejectBackoffMs(attempts),
            r.event_id,
          );
          continue;
        }
        // SAFETY NET (tallies never disappear): never PERMANENTLY reject a
        // user-ledger event over an UNHANDLED reason. Leave it unacked so it
        // re-pushes next cycle rather than vanishing from backup. Only
        // non-user events fall through to the permanent rejected_at below.
        const rejectedRow = rowById.get(r.event_id);
        if (rejectedRow != null && isUserLedgerEventType(rejectedRow.event_type)) {
          if (__DEV__) {
            console.warn(
              `[sync.push] user-ledger event ${r.event_id} rejected (${r.reason}) — leaving unacked for retry, not exiling`,
            );
          }
          // Unhandled reasons look permanent — same backoff as above so a
          // never-accepted row can't hot-loop or starve the batch.
          const attempts = rejectedRow.push_attempts + 1;
          await db.runAsync(
            `UPDATE event_log
                SET push_attempts = ?,
                    last_reject_reason = ?,
                    next_push_at = ?
              WHERE event_id = ?`,
            attempts,
            r.reason,
            now + rejectBackoffMs(attempts),
            r.event_id,
          );
          continue;
        }
        await db.runAsync(
          "UPDATE event_log SET rejected_at = ?, last_reject_reason = ? WHERE event_id = ?",
          now,
          r.reason,
          r.event_id,
        );
        await db.runAsync(
          `INSERT INTO projection_conflicts (kind, detail_json, vault_id, created_at)
         VALUES (?, ?, ?, ?)`,
          "event_rejected_by_server",
          JSON.stringify({
            event_id: r.event_id,
            reason: r.reason,
            current_role: r.current_role ?? null,
            required_role: r.required_role ?? null,
          }),
          vaultId,
          now,
        );
      }
    }),
  );

  // Stamp last_push_at only when the WHOLE batch is on the server (accepted or
  // already-there duplicate). A batch with rejected / deliberately-unacked rows
  // left data behind, and a fresh timestamp would misread as "backed up seconds
  // ago" on the diagnostics report — the exact surface used to triage backup
  // complaints. The empty-outbox stamp above keeps its honest semantics.
  const fullyAcked = rows.every(
    (row) => acceptedSet.has(row.event_id) || duplicatesSet.has(row.event_id),
  );
  if (fullyAcked) {
    // A fully-acked BATCH no longer implies a fully-acked OUTBOX: migration
    // 022's backoff gate excludes reject-backoff rows from the batch SELECT,
    // and those are NOT on the server. Re-check without the gate (same guard
    // as the empty-outbox path above) so we never stamp "backed up" while
    // backed-off rows are still pending.
    const remaining = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM event_log
        WHERE vault_id = ?
          AND server_acked_at IS NULL
          AND rejected_at IS NULL
          AND tombstone_reason IS NULL
        LIMIT 1`,
      vaultId,
    );
    if (remaining == null) {
      await markPushDone(vaultId);
    }
  }

  // ENG #11: reactively notify subscribers after the tx commits so the
  // UI (badge / toast / conflicts list) updates without waiting for a
  // poll tick. We notify only when rejected[] is non-empty to avoid
  // burning a re-render on every routine push.
  if (rejectedList.length > 0) {
    notifyProjectionConflictsChanged();
  }

  if (hadPermissionRejection) {
    throw new PermissionRejectedError("one or more events rejected with insufficient_role");
  }

  return {
    pushed: acceptedSet.size,
    duplicates: duplicatesSet.size,
    rejected: rejectedList.length,
  };
}

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
