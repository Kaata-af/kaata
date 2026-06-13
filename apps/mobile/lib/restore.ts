// Snapshot restore (download + tail-of-events + M5 membership chain).
//
// fetchSnapshot() + restoreFromSnapshot() — the device had a previous install
// on this account; the server has a snapshot of a vault. Download it + the
// events appended since the snapshot was generated, apply locally inside one
// transaction. The multi-vault recovery driver (lib/recovery.ts) calls these
// per vault; the in-app + onboarding restore screens go through that driver.
//
// The tail + membership events funnel through applyEvent({origin: 'remote'})
// so the HLC frontier advances correctly, the event_log accumulates the
// canonical history, and the projection appliers are the only thing touching
// the ledger tables. The only DB write that is NOT routed through applyEvent
// is the snapshot's prior projection-state seed (restoreFromSnapshot writes the
// snapshot rows directly inside the transaction before replaying post-snapshot
// events on top — see the long comment block in restoreFromSnapshot for why
// re-emitting every snapshot row as a synthetic event would be wrong).

import { getBackendUrl } from "./api";
import { getSessionJWT } from "./auth";
import {
  ACTIVE_VAULT_META_KEY,
  getAppMetaInTx,
  getDb,
  setActiveVaultIdCache,
  setAppMetaInTx,
} from "./db-tx";
import { applyEvent } from "./event-log";
import type { LedgerEvent } from "./events";
import { compareHLC, deserializeHLC, serializeHLC } from "./hlc";
import { setLastPulledServerSeq } from "./sync/cursor";

const SNAPSHOT_TIMEOUT_MS = 30_000;
const PAYLOAD_SCHEMA = 1;

// ---------- public types ----------

// Shape returned by GET /v1/sync/snapshot. Mirrors the backend response.
// `events` is the tail of events appended after the snapshot was generated —
// the server returns them so the client lands on the up-to-date projection
// without a follow-up pull round-trip.
export type Snapshot = {
  vault_id: string;
  // Per-vault server_seq of the LAST event included in the snapshot. The
  // client primes sync_state.last_pulled_server_seq to this value after
  // restore so the very next sync pull asks for events strictly greater
  // than this cursor.
  snapshot_server_seq: number;
  // Wall-clock ms when the snapshot was generated server-side. Display only.
  generated_at_ms: number;
  // Vault row + shop_profile row + every user / relationship / entry needed
  // to render the projection at the point-in-time of snapshot_server_seq.
  vault: SnapshotVault;
  shop_profile: SnapshotShopProfile | null;
  users: SnapshotUser[];
  relationships: SnapshotRelationship[];
  entries: SnapshotEntry[];
  // HLC frontier as of snapshot_server_seq. Used to seed app_meta.hlc_last
  // so the first locally-authored event on this device cannot sort before
  // any event captured in the snapshot.
  hlc_last: { pms: number; l: number; did: string };
  // Tail of events appended after snapshot_server_seq, in (server_seq ASC)
  // order. Replayed via applyEvent on top of the snapshot rows.
  events: LedgerEvent[];
  // M5: the vault's FULL membership chain (genesis + member/device add/remove/
  // role events), regardless of cursor, in HLC order. The ledger projection
  // collapses these, but a RECOVERED device needs them in its event_log to
  // fold its own membership (proof bundle) and MESH. Ingested idempotently by
  // event_id. Absent on pre-M5 server builds → treated as [].
  membership_events?: LedgerEvent[];
};

export type SnapshotVault = {
  id: string;
  name: string;
  currency: string;
  created_at: number;
  updated_at: number;
  is_default: 0 | 1;
  account_id: string | null;
  // M5: the ORIGINAL vault anchor (owner device pubkey, base64). A recovered
  // device PINS this to verify peers — it does NOT re-anchor as owner. Null on
  // legacy server-anchored vaults. (Reverts the M4 "adopt this device" hack.)
  vault_trust_anchor_pubkey?: string | null;
};

export type SnapshotShopProfile = {
  vault_id: string;
  owner_name: string | null;
  shop_name: string;
  created_at: number;
  updated_at: number;
};

export type SnapshotUser = {
  id: string;
  phone_e164: string | null;
  display_name: string;
  is_local_self: 0 | 1;
  google_sub: string | null;
  account_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type SnapshotRelationship = {
  id: string;
  vault_id: string;
  user_a_id: string;
  user_b_id: string;
  context: "peer";
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

export type SnapshotEntry = {
  id: string;
  vault_id: string;
  relationship_id: string;
  type: "debt" | "payment";
  amount_afn: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  proposed_by_user_id: string | null;
  current_event_id: string | null;
  is_deleted: 0 | 1;
  is_settled: 0 | 1;
  accepted_at: number | null;
  disputed_at: number | null;
  disputed_reason: string | null;
  settled_at: number | null;
};

// ---------- errors ----------

export class RestoreSessionExpiredError extends Error {
  constructor() {
    super("restore_session_expired");
    this.name = "RestoreSessionExpiredError";
  }
}

export class RestoreTimeoutError extends Error {
  constructor() {
    super("restore_timeout");
    this.name = "RestoreTimeoutError";
  }
}

// ---------- network: snapshot fetch ----------

// Returns null when the backend has no snapshot for this default vault
// (HTTP 404). Throws on any other failure.
export async function fetchSnapshot(args: { defaultVaultId: string }): Promise<Snapshot | null> {
  const jwt = await getSessionJWT();
  if (!jwt) throw new RestoreSessionExpiredError();

  const baseUrl = await getBackendUrl();
  const url = `${baseUrl}/v1/sync/snapshot?vault_id=${encodeURIComponent(args.defaultVaultId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        // Gzip both directions — Phase 3 transport contract.
        "Accept-Encoding": "gzip",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RestoreTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return null;
  if (res.status === 401) throw new RestoreSessionExpiredError();
  if (!res.ok) {
    throw new Error(`restore_fetch_failed:${res.status}`);
  }
  return (await res.json()) as Snapshot;
}

// ---------- restore: snapshot + tail-of-events ----------

// Applies a snapshot + the post-snapshot event tail to local SQLite, all
// inside one transaction.
//
// Why the snapshot rows go in as direct INSERTs (not as synthetic events):
//
// The snapshot already represents the projection state at server_seq =
// snapshot_server_seq. Re-emitting every snapshot row as a synthetic event
// would (a) double the work of every projection rebuild forever and (b) need
// fake HLCs that we'd have to invent — those would conflict with the real
// events that ALREADY exist in the snapshot's vault history on the backend
// (the snapshot was generated by replaying them; they're still in the events
// table). On the next sync pull this device would receive every real event
// and project them on top of fake-synthetic projections of the same rows —
// undefined behavior territory. The clean model: snapshot = seed projection
// state; subsequent events ride on top.
//
// What MUST be set up before the tail events apply:
//   - app_meta.hlc_last seeded to snapshot.hlc_last so the first received
//     event's tickReceive() doesn't try to merge against a null frontier
//     and produce a clock anomaly.
//   - app_meta.active_vault_id set so getActiveVaultIdSync() works inside
//     applier code paths that read it (none in Phase 3, but defensive).
//
// Failure handling: any thrown applier rolls the WHOLE transaction back —
// snapshot rows, hlc_last seed, app_meta writes, all gone. Caller can retry
// from scratch. This is intentional: a partial restore is worse than no
// restore (the user would see a half-empty ledger and assume data loss).
export async function restoreFromSnapshot(
  snapshot: Snapshot,
  // M5: multi-vault recovery restores N vaults in a loop. `setActiveDefault`
  // (default true for the single-vault callers) controls whether this restore
  // claims active_vault_id/default_vault_id — the multi-vault driver passes
  // false per vault and picks ONE active/default after the loop (the snapshot's
  // is_default is server-hard-coded to 1 for every vault, so a naive loop would
  // make the last-restored vault active + mark them all default).
  opts: { setActiveDefault?: boolean } = {},
): Promise<{
  ok: true;
  applied_events: number;
  snapshot_server_seq: number;
}> {
  const setActiveDefault = opts.setActiveDefault ?? true;
  const db = await getDb();
  let appliedEvents = 0;

  // M5: PIN THE ORIGINAL ANCHOR. The INSERT OR REPLACE below would otherwise
  // drop vault_trust_anchor_pubkey to NULL. A recovered device verifies peers
  // against the OWNER's anchor and binds as a NEW DEVICE of the member account
  // (server-witnessed vault_device_added) — it MUST NOT re-anchor as owner.
  // (This reverts the M4 "adopt THIS device as anchor on fresh restore" hack,
  // which diverged the anchor from the original chain — peers verify against a
  // different anchor → handshake fails — and misfired runGenesisBackfill into
  // emitting a second genesis.) Source the anchor from the snapshot (the
  // server's recorded owner key); else preserve an existing local anchor
  // (in-place restore over our own vault). Null only for a legacy
  // server-anchored vault — the mesh dispatch gate excludes it (fail-safe;
  // server sync still works), and witnessed device-bind handles membership.
  let anchorToWrite: string | null = snapshot.vault.vault_trust_anchor_pubkey ?? null;
  if (!anchorToWrite) {
    const existing = await db.getFirstAsync<{ vault_trust_anchor_pubkey: string | null }>(
      `SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?`,
      snapshot.vault.id,
    );
    anchorToWrite = existing?.vault_trust_anchor_pubkey ?? null;
  }

  await db.withTransactionAsync(async () => {
    // 1. Seed the vault row. INSERT OR REPLACE so a previous half-restore
    //    or an offline-minted local vault on the same id gets overwritten.
    const v = snapshot.vault;
    await db.runAsync(
      `INSERT OR REPLACE INTO vaults
         (id, name, currency, created_at, updated_at, archived_at,
          is_default, account_id, registered_with_server_at,
          vault_epoch, hlc_logical, hlc_wall_ms, vault_trust_anchor_pubkey)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 0, ?)`,
      v.id,
      v.name,
      v.currency,
      v.created_at,
      v.updated_at,
      v.is_default,
      v.account_id,
      // Restored snapshots are by definition server-known.
      snapshot.generated_at_ms,
      anchorToWrite,
    );

    // 2. Seed users. is_local_self stays as-recorded in the snapshot —
    //    if this device's onboarding hasn't completed yet, a snapshot
    //    user with is_local_self=1 is fine; the next onboarding pass
    //    will NOT re-mint a self row because getLocalSelf() returns it.
    for (const u of snapshot.users) {
      await db.runAsync(
        `INSERT OR REPLACE INTO users (
           id, phone_e164, display_name, is_local_self,
           google_sub, account_id,
           created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?,  ?, ?,  ?, ?, ?)`,
        u.id,
        u.phone_e164,
        u.display_name,
        u.is_local_self,
        u.google_sub,
        u.account_id,
        u.created_at,
        u.updated_at,
        u.archived_at,
      );
    }

    // 3. Seed shop_profile (one row per vault per migration 007).
    if (snapshot.shop_profile) {
      const sp = snapshot.shop_profile;
      await db.runAsync(
        `INSERT OR REPLACE INTO shop_profile
           (vault_id, owner_name, shop_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        sp.vault_id,
        sp.owner_name,
        sp.shop_name,
        sp.created_at,
        sp.updated_at,
      );
    }

    // 4. Seed relationships.
    for (const r of snapshot.relationships) {
      await db.runAsync(
        `INSERT OR REPLACE INTO relationships (
           id, user_a_id, user_b_id, context, vault_id,
           created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?)`,
        r.id,
        r.user_a_id,
        r.user_b_id,
        r.context,
        r.vault_id,
        r.created_at,
        r.updated_at,
        r.archived_at,
      );
    }

    // 5. Seed entries.
    for (const e of snapshot.entries) {
      await db.runAsync(
        `INSERT OR REPLACE INTO entries (
           id, vault_id, relationship_id, type, amount_afn, note,
           created_at, updated_at, deleted_at, proposed_by_user_id,
           current_event_id, is_deleted, is_settled,
           accepted_at, disputed_at, disputed_reason, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?)`,
        e.id,
        e.vault_id,
        e.relationship_id,
        e.type,
        e.amount_afn,
        e.note,
        e.created_at,
        e.updated_at,
        e.deleted_at,
        e.proposed_by_user_id,
        e.current_event_id,
        e.is_deleted,
        e.is_settled,
        e.accepted_at,
        e.disputed_at,
        e.disputed_reason,
        e.settled_at,
      );
    }

    // 6. Seed app_meta — hlc_last always; active/default only when this
    //    restore owns the active-vault selection (single-vault callers; the
    //    multi-vault driver picks once after the loop). hlc_last is per-device
    //    global, so the MAX across restored vaults is what we want — merge
    //    rather than clobber so a later (smaller-frontier) vault doesn't
    //    regress it.
    const prevHlcRaw = await getAppMetaInTx(db, "hlc_last");
    const prevHlc = prevHlcRaw ? deserializeHLC(prevHlcRaw) : null;
    const mergedHlc =
      prevHlc && compareHLC(prevHlc, snapshot.hlc_last) >= 0 ? prevHlc : snapshot.hlc_last;
    await setAppMetaInTx(db, "hlc_last", serializeHLC(mergedHlc));
    if (setActiveDefault) {
      await setAppMetaInTx(db, ACTIVE_VAULT_META_KEY, v.id);
      await setAppMetaInTx(db, "default_vault_id", v.id);
    }
  });

  // Prime the in-memory cache (single-vault path only; the driver primes once).
  if (setActiveDefault) setActiveVaultIdCache(snapshot.vault.id);

  // M5: ingest the vault's full membership chain (genesis + member/device
  // events) so a RECOVERED device has them in event_log — its proof bundle is
  // then complete and it can fold its own membership to MESH (the ledger
  // projection collapses these; the tail only has post-cursor events).
  // Idempotent by event_id (applyEvent → INSERT OR IGNORE); HLC drives merge
  // order, so ingesting before the tail is fine even if they overlap.
  for (const ev of snapshot.membership_events ?? []) {
    try {
      await applyEvent(ev, { origin: "remote" });
    } catch (err) {
      console.warn("[restore] skipping bad membership event", ev.event_id, ev.event_type, err);
    }
  }

  // 7. Replay the post-snapshot event tail. Each event goes through
  //    applyEvent which opens its own transaction — we don't bundle them
  //    into the same tx as the snapshot seed because a single bad event
  //    in the tail (corrupt payload, unknown type from a newer server)
  //    shouldn't blow away the snapshot itself. Instead we accept what
  //    we can and surface the failure count to the caller.
  //
  //    Order: events are pre-sorted (server_seq ASC) by the backend. We
  //    don't re-sort here — the backend's order is authoritative.
  for (const ev of snapshot.events) {
    try {
      const { applied } = await applyEvent(ev, { origin: "remote" });
      if (applied) appliedEvents += 1;
    } catch (err) {
      // Skip unknown event types / projection errors. The sync worker
      // will re-fetch from the cursor we seed below; transient failures
      // get a second chance on the next sync tick.
      console.warn("[restore] skipping bad tail event", ev.event_id, ev.event_type, err);
    }
  }

  // 8. Seed the pull cursor to snapshot_server_seq. Without this, the
  //    very next sync tick starts pulling from after_server_seq=0 and
  //    replays every event already represented in the snapshot — wasted
  //    bandwidth + projection applier work on every fresh restore.
  //    Note: the tail events the server already shipped have server_seq
  //    > snapshot_server_seq, so they're NOT covered by this cursor;
  //    they're also already applied via the for-loop above. The next
  //    pull starts strictly after the highest tail event by reading
  //    the cursor we set here OR by walking forward to the last tail
  //    event's server_seq, whichever is higher.
  let cursor = snapshot.snapshot_server_seq;
  for (const ev of snapshot.events) {
    const seqRaw = (ev as unknown as { server_seq?: number }).server_seq;
    if (typeof seqRaw === "number" && seqRaw > cursor) {
      cursor = seqRaw;
    }
  }
  await setLastPulledServerSeq(snapshot.vault.id, cursor);

  return {
    ok: true,
    applied_events: appliedEvents,
    snapshot_server_seq: snapshot.snapshot_server_seq,
  };
}
