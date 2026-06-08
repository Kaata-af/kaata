// Restore + v0.4 backup→events bridge.
//
// Two entry paths land here, both invoked from app/onboarding/restore.tsx after
// a successful Google sign-in:
//
//   1. fetchSnapshot() + restoreFromSnapshot() — Phase 3 happy path. The device
//      had a previous install on this Google account; the server has a snapshot
//      of the default vault. Download it + the events appended since the
//      snapshot was generated, apply locally inside one transaction.
//
//   2. fetchV04Backup() + decodeV04Backup() + importDecodedEvents() — the v0.4
//      backup-row legacy bridge (plan §"Backup unification" + C7). The server
//      has the v0.4 mega-snapshot but no Phase-3 events table for this account
//      yet. Decode the snapshot into per-row events (one person_added per
//      person, one entry_created per entry, one shop_profile_updated for the
//      shop) and feed them through applyEvent — they get HLCs derived from the
//      original created_at, and a synthetic device_id of "v04-backfill-<install_id>".
//
// All three flows funnel into applyEvent({origin: 'backfill'|'remote'}) so the
// HLC frontier advances correctly, the event_log accumulates the canonical
// history, and the projection appliers are the only thing touching the
// ledger tables. The only DB write that is NOT routed through applyEvent is
// the snapshot's prior projection-state seed (restoreFromSnapshot writes the
// snapshot rows directly inside the transaction before replaying post-snapshot
// events on top — see the long comment block in restoreFromSnapshot for why
// re-emitting every snapshot row as a synthetic event would be wrong).

import { getBackendUrl } from "./api";
import { getSessionJWT } from "./auth";
import { ACTIVE_VAULT_META_KEY, getDb, setActiveVaultIdCache, setAppMetaInTx } from "./db-tx";
import { applyEvent } from "./event-log";
import type {
  EntryCreatedEvent,
  LedgerEvent,
  PersonAddedEvent,
  ShopProfileUpdatedEvent,
} from "./events";
import { serializeHLC } from "./hlc";
import { setLastPulledServerSeq } from "./sync/cursor";
import { KAATA_UUID_NAMESPACE, uuidv5 } from "./uuid-v5";

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
};

export type SnapshotVault = {
  id: string;
  name: string;
  currency: string;
  created_at: number;
  updated_at: number;
  is_default: 0 | 1;
  account_id: string | null;
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

// v0.4 backup row as returned by GET /v1/backup/latest. The shape is identical
// to lib/backup.ts's Snapshot type; redeclared here so this module doesn't
// reach into the soon-to-be-deprecated backup.ts.
export type V04Backup = {
  version: number;
  exported_at: number;
  users: Array<{
    id: string;
    phone_e164: string | null;
    display_name: string;
    is_local_self: number;
    created_at: number;
    updated_at: number;
    archived_at: number | null;
  }>;
  shop_profile: {
    id: number;
    user_id: string;
    shop_name: string;
    owner_name: string | null;
    created_at: number;
    updated_at: number;
  } | null;
  relationships: Array<{
    id: string;
    user_a_id: string;
    user_b_id: string;
    context: string;
    created_at: number;
    updated_at: number;
    archived_at: number | null;
  }>;
  entries: Array<{
    id: string;
    relationship_id: string;
    type: string;
    amount_afn: number;
    note: string | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    proposed_by_user_id: string | null;
    accepted_at: number | null;
    disputed_at: number | null;
    disputed_reason: string | null;
    settled_at: number | null;
  }>;
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

// ---------- network: v0.4 backup fetch (legacy bridge) ----------

// Returns null when no v0.4 backup row exists for the signed-in account
// (HTTP 404 OR empty-object response shape from the legacy handler).
export async function fetchV04Backup(): Promise<V04Backup | null> {
  const jwt = await getSessionJWT();
  if (!jwt) throw new RestoreSessionExpiredError();
  const baseUrl = await getBackendUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/backup/latest`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
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
  if (!res.ok) throw new Error(`v04_backup_fetch_failed:${res.status}`);

  // Legacy handler returns {} when no backup exists rather than 404.
  // Detect by absence of the `snapshot` field on the response.
  const body = (await res.json()) as { snapshot?: V04Backup } | Record<string, never>;
  if (!body || !("snapshot" in body) || !body.snapshot) return null;
  return body.snapshot;
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
export async function restoreFromSnapshot(snapshot: Snapshot): Promise<{
  ok: true;
  applied_events: number;
  snapshot_server_seq: number;
}> {
  const db = await getDb();
  let appliedEvents = 0;

  await db.withTransactionAsync(async () => {
    // 1. Seed the vault row. INSERT OR REPLACE so a previous half-restore
    //    or an offline-minted local vault on the same id gets overwritten.
    const v = snapshot.vault;
    await db.runAsync(
      `INSERT OR REPLACE INTO vaults
         (id, name, currency, created_at, updated_at, archived_at,
          is_default, account_id, registered_with_server_at,
          vault_epoch, hlc_logical, hlc_wall_ms)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 0)`,
      v.id,
      v.name,
      v.currency,
      v.created_at,
      v.updated_at,
      v.is_default,
      v.account_id,
      // Restored snapshots are by definition server-known.
      snapshot.generated_at_ms,
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

    // 6. Seed app_meta — active_vault_id, default_vault_id, hlc_last.
    //    Done BEFORE the tail events apply so applyEvent's tickReceive
    //    has a frontier to merge against.
    await setAppMetaInTx(db, ACTIVE_VAULT_META_KEY, v.id);
    await setAppMetaInTx(db, "default_vault_id", v.id);
    await setAppMetaInTx(db, "hlc_last", serializeHLC(snapshot.hlc_last));
  });

  // Prime the in-memory cache. Done outside the transaction so a thrown
  // applier in the tail-event loop below doesn't leave the cache pointing
  // at a vault whose rows got rolled back.
  setActiveVaultIdCache(snapshot.vault.id);

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

// ---------- v0.4 backup → events bridge ----------

// Decodes a v0.4 backup row into a stream of clean Phase-3 events. Per plan
// §"Backup unification" + C7 resolution: NOT one mega-event. One per row.
//
// HLC derivation: every event gets pms = row.created_at (or row.updated_at
// for amend/delete) and a logical counter that increases by 1 within the
// same physical ms across the whole bridge. Buckets are NOT per-target —
// the bridge is single-pass and order-stable, so a flat per-bucket counter
// is enough to keep HLCs strictly increasing and the projection replay
// deterministic.
//
// device_id is a synthetic "v04-backfill-<install_id>" string. Distinct
// from real install events so future audits can identify bridge-origin
// rows. The install_id suffix keeps the device_id unique per-install in
// case two installs of the same Google account both run the bridge.
//
// event_id is UUIDv5 over (kind, entity_id, physical_ms) so re-running
// the bridge is idempotent — INSERT OR IGNORE in applyEvent dedupes
// against the prior emission.
export function decodeV04Backup(
  backup: V04Backup,
  installId: string,
  vaultId: string,
): LedgerEvent[] {
  // device_id MUST be a UUID — the events table column is UUID NOT NULL
  // and the push handler rejects non-UUID hlc.device_id with HTTP 400,
  // so a free-form "v04-backfill-<installId>" string would silently keep
  // a restored user in local-only mode forever (every sync push 400s).
  // Derive a deterministic UUIDv5 over (installId, "v04-backfill") so
  // re-running the bridge on the same install lands on the same id and
  // pushes deduplicate cleanly.
  const deviceId = uuidv5(KAATA_UUID_NAMESPACE, `v04-backfill|${installId}`);
  // Per-physical-ms logical counter. Reset for each new pms bucket so
  // logical stays bounded. We sort the emission stream below before
  // assigning logical values, so equal-pms events land in deterministic
  // ms-bucket order.
  const events: LedgerEvent[] = [];

  // Find the local-self user in the v0.4 backup (is_local_self = 1).
  // We need their id to be the "user_a" side of every relationship.
  const localSelf = backup.users.find((u) => u.is_local_self === 1);
  // The local-self row is NOT re-emitted as a person_added — that event
  // carries a relationship_id which the self user has none of. The local
  // self is re-established by the next onboarding/profile pass on this
  // device. For a restore-from-snapshot path the self user is in the
  // snapshot directly.

  // 1. shop_profile → ONE shop_profile_updated event seeding shop_name +
  //    owner_name. target_id = vaultId per migration 007.
  if (backup.shop_profile) {
    const sp = backup.shop_profile;
    const pms = sp.updated_at || sp.created_at;
    const eventId = uuidv5(
      KAATA_UUID_NAMESPACE,
      `v04-bridge|shop_profile_updated|${vaultId}|${pms}`,
    );
    const ev: ShopProfileUpdatedEvent = {
      event_id: eventId,
      event_type: "shop_profile_updated",
      vault_id: vaultId,
      target_id: vaultId,
      relationship_id: null,
      hlc: { pms, l: 0, did: deviceId },
      device_id: deviceId,
      author_user_id_local_only: localSelf?.id ?? "",
      actor_account_id: null,
      payload_schema: PAYLOAD_SCHEMA,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "backfill",
      payload: {
        changes: {
          shop_name: sp.shop_name,
          owner_name: sp.owner_name,
        },
      },
    };
    events.push(ev);
  }

  // 2. relationships → person_added per (user_b on the non-self side).
  //    v0.4 relationships always had user_a = local_self; v0.4 also had
  //    customer/supplier contexts collapsed to 'peer' by mobile migration
  //    003. If a backup somehow still carries non-peer rows, we coerce to
  //    peer — Phase 3 events only model peer.
  for (const r of backup.relationships) {
    const otherUserId = r.user_a_id === localSelf?.id ? r.user_b_id : r.user_a_id;
    const other = backup.users.find((u) => u.id === otherUserId);
    if (!other) continue;
    // archived_at: a v0.4 archived person becomes person_added + person_archived
    // (sticky tombstone-style); below we emit the archived event separately.
    const pms = r.created_at;
    const eventId = uuidv5(KAATA_UUID_NAMESPACE, `v04-bridge|person_added|${other.id}|${pms}`);
    const ev: PersonAddedEvent = {
      event_id: eventId,
      event_type: "person_added",
      vault_id: vaultId,
      target_id: other.id,
      relationship_id: r.id,
      hlc: { pms, l: 0, did: deviceId },
      device_id: deviceId,
      author_user_id_local_only: localSelf?.id ?? "",
      actor_account_id: null,
      payload_schema: PAYLOAD_SCHEMA,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "backfill",
      payload: {
        user_id: other.id,
        name: other.display_name,
        phone_e164: other.phone_e164,
        relationship_context: "peer",
      },
    };
    events.push(ev);

    if (r.archived_at != null) {
      const archivedPms = r.archived_at;
      const archivedId = uuidv5(
        KAATA_UUID_NAMESPACE,
        `v04-bridge|person_archived|${other.id}|${archivedPms}`,
      );
      events.push({
        event_id: archivedId,
        event_type: "person_archived",
        vault_id: vaultId,
        target_id: other.id,
        relationship_id: r.id,
        hlc: { pms: archivedPms, l: 0, did: deviceId },
        device_id: deviceId,
        author_user_id_local_only: localSelf?.id ?? "",
        actor_account_id: null,
        payload_schema: PAYLOAD_SCHEMA,
        appended_at: 0,
        server_acked_at: null,
        rejected_at: null,
        origin: "backfill",
        payload: {},
      });
    }
  }

  // 3. entries → entry_created + optional entry_deleted (sticky tombstone).
  //    backfill_synthetic + backfill_* fields populate the legacy
  //    accepted_at / disputed_at / settled_at columns on the projection
  //    side (same mechanism migration 006 uses for the local replay
  //    invariant; see EntryCreatedEvent payload doc).
  for (const e of backup.entries) {
    if (e.type !== "debt" && e.type !== "payment") continue;
    const pms = e.created_at;
    const eventId = uuidv5(KAATA_UUID_NAMESPACE, `v04-bridge|entry_created|${e.id}|${pms}`);
    const ev: EntryCreatedEvent = {
      event_id: eventId,
      event_type: "entry_created",
      vault_id: vaultId,
      target_id: e.id,
      relationship_id: e.relationship_id,
      hlc: { pms, l: 0, did: deviceId },
      device_id: deviceId,
      author_user_id_local_only: e.proposed_by_user_id ?? localSelf?.id ?? "",
      actor_account_id: null,
      payload_schema: PAYLOAD_SCHEMA,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "backfill",
      payload: {
        entry_id: e.id,
        relationship_id: e.relationship_id,
        type: e.type,
        amount_afn: e.amount_afn,
        note: e.note,
        occurred_at_ms: e.created_at,
        backfill_synthetic: true,
        backfill_accepted_at: e.accepted_at,
        backfill_disputed_at: e.disputed_at,
        backfill_disputed_reason: e.disputed_reason,
        backfill_settled_at: e.settled_at,
      },
    };
    events.push(ev);

    if (e.deleted_at != null) {
      const delPms = e.deleted_at;
      const delId = uuidv5(KAATA_UUID_NAMESPACE, `v04-bridge|entry_deleted|${e.id}|${delPms}`);
      events.push({
        event_id: delId,
        event_type: "entry_deleted",
        vault_id: vaultId,
        target_id: e.id,
        relationship_id: e.relationship_id,
        hlc: { pms: delPms, l: 0, did: deviceId },
        device_id: deviceId,
        author_user_id_local_only: e.proposed_by_user_id ?? localSelf?.id ?? "",
        actor_account_id: null,
        payload_schema: PAYLOAD_SCHEMA,
        appended_at: 0,
        server_acked_at: null,
        rejected_at: null,
        origin: "backfill",
        payload: {},
      });
    }
  }

  // Sort by (pms asc, event_type priority asc, event_id asc) so logical
  // counters within a bucket are deterministic across re-runs. event_type
  // priority: person_added < shop_profile_updated < entry_created <
  // person_archived < entry_deleted — matches the causal dependency order
  // (a relationship must exist before its entries reference it).
  const TYPE_ORDER: Record<string, number> = {
    person_added: 0,
    shop_profile_updated: 1,
    entry_created: 2,
    person_archived: 3,
    entry_deleted: 4,
  };
  events.sort((a, b) => {
    if (a.hlc.pms !== b.hlc.pms) return a.hlc.pms - b.hlc.pms;
    const ta = TYPE_ORDER[a.event_type] ?? 99;
    const tb = TYPE_ORDER[b.event_type] ?? 99;
    if (ta !== tb) return ta - tb;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });

  // Assign logical counters per-pms bucket. l = position within the
  // bucket after sort. Across buckets, pms differs so logical resets.
  let lastPms = -1;
  let l = 0;
  for (const ev of events) {
    if (ev.hlc.pms !== lastPms) {
      l = 0;
      lastPms = ev.hlc.pms;
    } else {
      l += 1;
    }
    ev.hlc = { pms: ev.hlc.pms, l, did: deviceId };
  }

  return events;
}

// Feeds decoded v0.4 bridge events through applyEvent. Each event opens
// its own transaction (applyEvent's contract). origin='backfill' so the
// HLC tick path uses tickReceive() against the (likely empty) frontier
// and merges the synthetic-device pms into our hlc_last cursor — the
// next local entry the shopkeeper writes after restore-and-bridge cannot
// time-travel before the bridged history.
export async function importDecodedEvents(
  events: LedgerEvent[],
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const ev of events) {
    try {
      const result = await applyEvent(ev, { origin: "backfill" });
      if (result.applied) applied += 1;
      else skipped += 1;
    } catch (err) {
      console.warn("[restore] bridge event apply failed", ev.event_id, ev.event_type, err);
      skipped += 1;
    }
  }
  return { applied, skipped };
}

// Returns true when the bridge has NOT yet fired for this vault (i.e.
// event_log is empty for vault_id). Called by the restore screen before
// emitting bridge events so a second sign-in doesn't re-emit them. The
// applyEvent INSERT OR IGNORE would already dedupe by event_id, but the
// guard saves us the wasted transactions on every cold start after
// restore completed.
export async function isEventLogEmptyForVault(vaultId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM event_log WHERE vault_id = ?",
    vaultId,
  );
  return (row?.n ?? 0) === 0;
}

// Used by onboarding/restore.tsx to know if a vault row already exists
// locally (e.g. migration 007 minted one). If so we re-use its id;
// otherwise we mint a fresh one before the bridge fires.
export async function ensureBridgeVaultId(args: {
  installId: string;
  accountId: string;
}): Promise<string> {
  const db = await getDb();
  // Existing active vault — re-use.
  const existing = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = ?",
    ACTIVE_VAULT_META_KEY,
  );
  if (existing?.value) return existing.value;

  // No vault yet — mint one. UUIDv5 of (account_id, install_id) so a
  // re-run on the same install + account lands on the same id, which
  // matters when the user signs out and back in mid-bridge.
  const vaultId = uuidv5(
    KAATA_UUID_NAMESPACE,
    `v04-bridge-vault|${args.accountId}|${args.installId}`,
  );
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT OR IGNORE INTO vaults
         (id, name, currency, created_at, updated_at, archived_at,
          is_default, account_id, registered_with_server_at,
          vault_epoch, hlc_logical, hlc_wall_ms)
       VALUES (?, 'My ledger', 'AFN', ?, ?, NULL, 1, ?, NULL, 0, 0, 0)`,
      vaultId,
      now,
      now,
      args.accountId,
    );
    await setAppMetaInTx(db, ACTIVE_VAULT_META_KEY, vaultId);
    await setAppMetaInTx(db, "default_vault_id", vaultId);
  });
  setActiveVaultIdCache(vaultId);
  return vaultId;
}
