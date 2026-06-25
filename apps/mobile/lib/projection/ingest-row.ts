// lib/projection/ingest-row.ts
//
// The DURABLE INGEST primitive shared by the mesh anti-entropy path and the
// server-pull + restore paths. This is the load-bearing half of the
// fundamental sync data-loss fix (2026-06-25):
//
//   THE BUG: the server-pull (lib/sync/pull.ts) and restore-tail
//   (lib/restore.ts) paths called applyEvent() directly. applyEvent does
//   INSERT-OR-IGNORE(event_log) + role-gate + projection-applier in ONE
//   transaction. When an applier THROWS (e.g. entry_created's relationship_id
//   FOREIGN KEY constraint, because the person hasn't applied yet) the whole
//   transaction rolls back — INCLUDING the event_log row — and the caller then
//   advances the pull cursor past the now-traceless event. The server never
//   re-ships it (cursor moved past its server_seq) and there is no row to
//   sweep: PERMANENT, silent loss of a tally.
//
//   THE FIX: pull/restore now INGEST every event durably first (this module),
//   exactly like the mesh path's insertIngested — the event_log row lands with
//   ingested_at set and applied_at=NULL, in a transaction that contains NO
//   applier, so it CANNOT throw on a missing prerequisite. The pull cursor is
//   therefore a "durably-ingested" watermark, never an "applied" one. Apply is
//   a separate, retrying, loss-free step driven by the sweep
//   (sweep.ts → replay.ts applyAlreadyIngestedEvent), which QUARANTINES (not
//   loses) on any applier throw and retries on the next sweep pass.
//
// This unifies the two replication paths onto one durability model: "the
// server is the replica that never sleeps." The actual INSERT (ingestRowInTx)
// is shared so the mesh and pull paths can never silently diverge again.

import type { LedgerEvent } from "../events";
import { isKnownEventType } from "../events";
import { getAppMetaInTx, getDb, getInstallIdSync, setAppMetaInTx, type SQLiteTx } from "../db-tx";
import { deserializeHLC, serializeHLC, tickReceive, type HLC } from "../hlc";
import { applyEventMutex } from "./index";

// app_meta key for the persisted HLC frontier (kept in sync with
// projection/index.ts + anti-entropy.ts — JSON-encoded {pms,l,did}).
const HLC_LAST_KEY = "hlc_last";

// Author seqs are positive integers by contract. The server enforces this on
// push, but a replica must not trust a wire blindly — sanitize at the boundary
// so the version-vector planner (defined over 1..n) and the (vault,device,seq)
// UNIQUE index can never be fed garbage.
export function sanitizeAuthorSeq(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

/**
 * author_seq slot pre-check (mirrors projection/index.ts + the mesh path's
 * former resolveMeshAuthorSeq). Returns the event's author_seq, or null when a
 * DIFFERENT event_id already occupies the (vault, author_device, seq) slot — in
 * which case we sacrifice the SEQ, never the event. Honest relays/servers
 * forward the author's verbatim seq, so in a fresh system this never fires; if
 * it does, the event still ingests (event_id PK) but is invisible to the
 * version vector until the conflict resolves.
 */
export async function resolveAuthorSeqSlot(
  tx: SQLiteTx,
  event: LedgerEvent,
): Promise<number | null> {
  const seq = event.author_seq ?? null;
  if (seq == null || event.vault_id == null) return null;
  const slot = await tx.getFirstAsync<{ event_id: string }>(
    `SELECT event_id FROM event_log
      WHERE vault_id = ? AND device_id = ? AND author_seq = ?`,
    event.vault_id,
    event.device_id,
    seq,
  );
  if (slot && slot.event_id !== event.event_id) return null;
  return seq;
}

/**
 * Durably INGEST one remote event into event_log inside the CALLER'S
 * transaction. Sets ingested_at + leaves applied_at / quarantine_reason /
 * tombstone_reason NULL so the sweep owns the apply attempt. Bumps the HLC
 * frontier via tickReceive so "I have received this" is true the moment the
 * row is durable, even before it applies. NO role-gate, NO projection applier,
 * NO FK risk (event_log carries no FK constraints) — so this cannot throw on a
 * missing prerequisite.
 *
 * `serverAckedAt`: pass the ingest timestamp for SERVER-pulled events (they are
 * by definition already on the server, so they must never re-enter the push
 * outbox); pass null for mesh-relayed events (not necessarily server-confirmed).
 *
 * Returns true iff a new row was inserted (false = event_id already on disk).
 * Idempotent by event_id (INSERT OR IGNORE).
 */
export async function ingestRowInTx(
  tx: SQLiteTx,
  event: LedgerEvent,
  ingestedAtMs: number,
  serverAckedAt: number | null,
): Promise<boolean> {
  const authorSeq = await resolveAuthorSeqSlot(tx, event);
  const res = await tx.runAsync(
    `INSERT OR IGNORE INTO event_log (
       event_id, event_type, vault_id, target_id, relationship_id,
       hlc_physical_ms, hlc_logical, hlc_device_id,
       device_id, author_user_id_local_only, actor_account_id,
       payload_json, payload_schema,
       appended_at, server_acked_at, rejected_at, origin,
       event_sig_b64, signer_device_pubkey,
       ingested_at, applied_at, quarantine_reason, tombstone_reason, author_seq
     ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, NULL, NULL, NULL, ?)`,
    event.event_id,
    event.event_type,
    event.vault_id,
    event.target_id,
    event.relationship_id,
    event.hlc.pms,
    event.hlc.l,
    event.hlc.did,
    event.device_id,
    event.author_user_id_local_only ?? "",
    event.actor_account_id,
    JSON.stringify(event.payload),
    event.payload_schema,
    ingestedAtMs,
    serverAckedAt,
    null,
    "remote",
    event.event_sig_b64 ?? null,
    event.signer_device_pubkey ?? null,
    ingestedAtMs,
    authorSeq,
  );

  // HLC frontier bump (same txn as the INSERT). Unconditional, matching the
  // mesh path: re-merging an already-seen HLC is idempotent under tickReceive
  // and keeps the frontier >= every event we've durably received.
  const prevRaw = await getAppMetaInTx(tx, HLC_LAST_KEY);
  const prev: HLC | null = prevRaw ? deserializeHLC(prevRaw) : null;
  const merged = tickReceive(prev, event.hlc, Date.now(), getInstallIdSync());
  await setAppMetaInTx(tx, HLC_LAST_KEY, serializeHLC(merged));

  return (res?.changes ?? 0) > 0;
}

// The wire shape of a server-pulled / snapshot-tail / membership-chain event.
// Mirrors the backend sync.PulledEvent JSON (apps/backend/internal/sync/
// service.go) — note account_id (not actor_account_id) and schema_version
// (not payload_schema), which is exactly why this mapping must exist and be
// shared by BOTH pull and restore (restore.ts historically passed these raw to
// applyEvent, silently dropping actor_account_id / payload_schema).
export type PulledWireEvent = {
  event_id: string;
  event_type: string;
  hlc: { pms: number; l: number; did: string };
  device_id: string;
  account_id: string | null;
  target_id: string | null;
  relationship_id: string | null;
  schema_version: number;
  payload: unknown;
  author_seq?: number | null;
  event_sig_b64?: string | null;
  signer_device_pubkey?: string | null;
  server_seq?: number;
};

/**
 * Map a pulled wire event onto a remote-origin LedgerEvent the ingest path can
 * persist. Trusts the wire's envelope target_id / relationship_id (the appliers
 * key off them) and carries the signature material so the sweep's role-gate can
 * authenticate membership events end-to-end. author_user_id_local_only is
 * device-local and never crosses the wire → forced to "".
 */
export function mapPulledWireToEvent(w: PulledWireEvent, vaultId: string): LedgerEvent {
  return {
    event_id: w.event_id,
    event_type: w.event_type,
    vault_id: vaultId,
    target_id: w.target_id ?? "",
    relationship_id: w.relationship_id ?? null,
    hlc: w.hlc,
    device_id: w.device_id,
    author_user_id_local_only: "",
    actor_account_id: w.account_id ?? null,
    payload: w.payload,
    payload_schema: typeof w.schema_version === "number" ? w.schema_version : 1,
    appended_at: 0, // stamped at ingest (ingested_at)
    server_acked_at: null,
    rejected_at: null,
    origin: "remote",
    author_seq: sanitizeAuthorSeq(w.author_seq),
    event_sig_b64: typeof w.event_sig_b64 === "string" ? w.event_sig_b64 : null,
    signer_device_pubkey:
      typeof w.signer_device_pubkey === "string" ? w.signer_device_pubkey : null,
  } as unknown as LedgerEvent;
}

/**
 * Durably ingest a batch of SERVER-pulled / restore events (one transaction,
 * serialized under applyEventMutex like every other event_log writer on the
 * single shared SQLite connection). Every event lands as a durable row
 * (applied_at=NULL) — apply is deferred to the sweep. The caller advances the
 * pull cursor only AFTER this resolves, so the cursor can never skip an event
 * that isn't on disk.
 *
 * Pre-existing-row patch (the INSERT-OR-IGNORE no-ops on a duplicate event_id):
 *   - stamp server_acked_at so a locally-authored event that round-trips back
 *     from the server is never re-pushed;
 *   - back-fill author_seq onto a row that pre-exists WITHOUT one (a mesh copy
 *     arrived before the author's seq reached us). UPDATE OR IGNORE: if another
 *     row already holds that (vault,device,seq) slot, keep ours NULL rather
 *     than corrupt the UNIQUE index.
 *
 * Returns the count of newly-inserted rows (telemetry only).
 */
export async function ingestPulledEvents(
  events: LedgerEvent[],
  ingestedAtMs: number,
): Promise<number> {
  if (events.length === 0) return 0;
  const db = await getDb();
  let inserted = 0;
  // One mutex acquisition for the whole batch, but a PER-EVENT transaction so a
  // single failing row can never roll back its siblings (their txns already
  // committed). Mirrors the mesh path, which ingests one event per txn.
  //
  // Two failure classes, handled differently to be BOTH loss-free AND
  // non-stalling:
  //   - STRUCTURALLY UNSTORABLE (non-numeric HLC, missing id/vault/device): it
  //     would violate a NOT NULL column and could never ingest. Pre-skip-and-log
  //     ONE row (the cursor advancing past it loses nothing — it was unstorable)
  //     rather than throwing the whole page into an infinite zero-progress retry.
  //     This is the reviewer's "poison event stalls the vault" case.
  //   - ANY OTHER throw (a genuine transient — SQLite busy from a concurrent
  //     sweep, etc.): let it PROPAGATE. The caller then does NOT advance the
  //     cursor, so the page re-pulls and re-ingests idempotently once the
  //     transient clears — never silently dropped. (A structurally-valid event
  //     cannot deterministically fail the INSERT: event_log has no FK, event_id
  //     is INSERT OR IGNORE, the author_seq slot is sacrificed not collided, and
  //     the migration-014 state-machine trigger accepts ingested_at-set/rest-NULL.)
  await applyEventMutex.runExclusive(async () => {
    for (const ev of events) {
      if (!isKnownEventType(ev.event_type)) {
        // Unknown type from a future server build — no applier exists. Match
        // the legacy pull behaviour (skip) rather than ingest-then-tombstone.
        continue;
      }
      if (!isIngestableEvent(ev)) {
        console.warn(
          `[ingest] skipping structurally-invalid event ${safeId(ev)} (${String(ev.event_type)})`,
        );
        continue;
      }
      let didInsert = false;
      await db.withTransactionAsync(async () => {
        didInsert = await ingestRowInTx(db, ev, ingestedAtMs, ingestedAtMs);
        // Pre-existing-row patch (INSERT OR IGNORE no-op'd on a duplicate
        // event_id): a SERVER-pulled event IS on the server, so mark it acked
        // (never re-push); back-fill author_seq if the dup row lacked one.
        await db.runAsync(
          `UPDATE event_log SET server_acked_at = ?
            WHERE event_id = ? AND server_acked_at IS NULL`,
          ingestedAtMs,
          ev.event_id,
        );
        const seq = ev.author_seq ?? null;
        if (seq != null) {
          await db.runAsync(
            `UPDATE OR IGNORE event_log SET author_seq = ?
              WHERE event_id = ? AND author_seq IS NULL`,
            seq,
            ev.event_id,
          );
        }
      });
      if (didInsert) inserted += 1;
    }
  });
  return inserted;
}

// Structural validity of a pulled envelope before it touches the NOT NULL
// event_log columns. Guards specifically against a non-numeric HLC (NaN →
// hlc_physical_ms NOT NULL violation → whole-txn abort) and a missing
// id/vault/device, which the trusted server should never send but a wire/schema
// drift could.
function isIngestableEvent(ev: LedgerEvent): boolean {
  if (typeof ev.event_id !== "string" || ev.event_id.length === 0) return false;
  if (ev.vault_id == null) return false;
  if (typeof ev.device_id !== "string" || ev.device_id.length === 0) return false;
  const h = ev.hlc as { pms?: unknown; l?: unknown; did?: unknown } | null | undefined;
  if (h == null) return false;
  if (!Number.isInteger(h.pms) || !Number.isInteger(h.l)) return false;
  if (typeof h.did !== "string") return false;
  // payload_json is NOT NULL: JSON.stringify(undefined) === undefined → expo-
  // sqlite binds SQL NULL → constraint abort. A present `null` payload is fine
  // (JSON.stringify(null) === "null"). Every current backend feeder sends at
  // least "null", so this only guards future wire drift — but completes the
  // "pre-skip, never stall the page" contract.
  if (ev.payload === undefined) return false;
  return true;
}

function safeId(ev: LedgerEvent): string {
  return typeof ev.event_id === "string" ? ev.event_id.slice(0, 8) : "<no-id>";
}
