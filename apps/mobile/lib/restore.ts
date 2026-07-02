// Snapshot restore (download + tail-of-events + M5 membership chain).
//
// fetchSnapshot() + restoreFromSnapshot() — the device had a previous install
// on this account; the server has a snapshot of a vault. Download it + the
// events appended since the snapshot was generated, apply locally inside one
// transaction. The multi-vault recovery driver (lib/recovery.ts) calls these
// per vault; the in-app + onboarding restore screens go through that driver.
//
// The tail + membership events are DURABLY INGESTED via the shared ingest path
// (lib/projection/ingest-row.ts) — the same one server-pull uses — so the HLC
// frontier advances at ingest and event_log accumulates the canonical history,
// and then APPLIED by one sweep pass (quarantine-and-retry on any missing
// prerequisite). They are NOT applied directly: a tail entry whose person is
// itself in the tail used to throw inside applyEvent, roll the event_log row
// back, and let the cursor skip it forever — the restore data-loss bug this
// path now closes. The only DB write that is NOT an event is the snapshot's
// prior projection-state seed (restoreFromSnapshot writes the snapshot rows
// directly inside the transaction before the tail rides on top — see the long
// comment block in restoreFromSnapshot for why re-emitting every snapshot row
// as a synthetic event would be wrong).

import { getBackendUrl } from "./api";
import { getSessionJWT } from "./auth";
import {
  ACTIVE_VAULT_META_KEY,
  getAppMetaInTx,
  getDb,
  setActiveVaultIdCache,
  setAppMetaInTx,
} from "./db-tx";
import type { LedgerEvent } from "./events";
import { compareHLC, deserializeHLC, serializeHLC, type HLC } from "./hlc";
import { serializeFieldHLCs, type FieldHLCMap } from "./projection/field-hlc";
import {
  ingestPulledEvents,
  mapPulledWireToEvent,
  type PulledWireEvent,
} from "./projection/ingest-row";
import { sweepVaultNow } from "./projection/sweep";
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
  opts: { setActiveDefault?: boolean; localSelfId?: string | null } = {},
): Promise<{
  ok: true;
  applied_events: number;
  snapshot_server_seq: number;
}> {
  const setActiveDefault = opts.setActiveDefault ?? true;
  const db = await getDb();
  let appliedEvents = 0;

  // Snapshot rows carry NO per-field HLCs (the backend projection tracks
  // hlcAmount/hlcNote/… but marks them json:"-", so they never reach the wire).
  // A snapshot-seeded row left with field_hlcs=NULL collapses to an empty map →
  // every field floor is FIELD_HLC_INIT (below every real HLC) → ANY
  // post-snapshot amend, even one OLDER than the value baked into the snapshot,
  // wins LWW and corrupts the restored figure. We seed a CONSERVATIVE floor at
  // the row's updated_at as a partial mitigation.
  //
  // CAVEAT (this is a mitigation, NOT exact — see backlog): updated_at is a
  // single per-row timestamp, not the per-field winner HLC. For a never-amended
  // entry it is the backdated occurred_at (below the true create HLC); for an
  // amended entry it is the latest-writing event's HLC across ANY field (above
  // an individual field whose own winner is older). So the floor can be slightly
  // low (a narrow stale-amend window survives) or slightly high (a legitimately-
  // newer out-of-order amend for one field is skipped). BOTH require a
  // cross-device, out-of-order amend whose HLC lands in that gap — impossible
  // for a solo single-device user (monotonic HLC, in-order tail), and strictly
  // better than the pre-fix NULL (where every stale amend corrupted). The exact
  // fix is to serialize the four per-field HLCs in the snapshot wire and seed
  // them verbatim — deferred (backend change). l/did are zeroed.
  const floorFieldHLCs = (fields: string[], updatedAtMs: number): string => {
    const floor: HLC = { pms: updatedAtMs, l: 0, did: "" };
    const map: FieldHLCMap = {};
    for (const f of fields) map[f] = floor;
    return serializeFieldHLCs(map);
  };

  // The self user is never event-sourced, so the server stores every relationship
  // with user_a_id="" and every entry with proposed_by_user_id="" — both FK
  // columns that point at users(id). We remap those empty refs to the local self
  // (user_a is the self by construction in this data model) so the inserts don't
  // violate the foreign key (which would silently drop the contact/entry). Prefer
  // the id the caller resolved; else look up an existing self row.
  let localSelfId: string | null = opts.localSelfId ?? null;
  if (!localSelfId) {
    const selfRow = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
    );
    localSelfId = selfRow?.id ?? null;
  }
  // If we still have no self id AND there are relationships to remap, fail loudly
  // rather than inserting user_a_id=NULL (a cryptic FK/NOT NULL rollback of the
  // whole vault). Unreachable via recoverAllVaults (it mints the self first); this
  // guards a future direct caller that forgets to.
  if (!localSelfId && snapshot.relationships.length > 0) {
    throw new Error("restoreFromSnapshot: no local-self row to remap relationship user_a_id");
  }

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

    // 2. Seed users (the CONTACTS). The snapshot NEVER carries an is_local_self=1
    //    row — the self user is not event-sourced and the backend projection sets
    //    is_local_self=false for every user — so the local self is minted
    //    separately by recovery (lib/recovery.ts ensureLocalSelfForRestore) and the
    //    empty user_a_id below is remapped to it.
    for (const u of snapshot.users) {
      await db.runAsync(
        `INSERT OR REPLACE INTO users (
           id, phone_e164, display_name, is_local_self,
           google_sub, account_id,
           created_at, updated_at, archived_at, field_hlcs
         ) VALUES (?, ?, ?, ?,  ?, ?,  ?, ?, ?, ?)`,
        u.id,
        u.phone_e164,
        u.display_name,
        u.is_local_self,
        u.google_sub,
        u.account_id,
        u.created_at,
        u.updated_at,
        u.archived_at,
        floorFieldHLCs(["display_name", "phone_e164"], u.updated_at),
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

    // 4. Seed relationships. user_a is the self by construction; the server
    //    stores it empty (the self id never round-trips), so remap "" → the local
    //    self id to satisfy the NOT NULL REFERENCES users(id) FK. Without this the
    //    insert throws under foreign_keys=ON and the contact is dropped.
    for (const r of snapshot.relationships) {
      await db.runAsync(
        `INSERT OR REPLACE INTO relationships (
           id, user_a_id, user_b_id, context, vault_id,
           created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?)`,
        r.id,
        r.user_a_id || localSelfId,
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
           accepted_at, disputed_at, disputed_reason, settled_at, field_hlcs
         ) VALUES (?, ?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?)`,
        e.id,
        e.vault_id,
        e.relationship_id,
        e.type,
        e.amount_afn,
        e.note,
        e.created_at,
        e.updated_at,
        e.deleted_at,
        // The server stores the proposer as "" (FK to users(id), nullable). Map
        // "" → NULL, matching the pull-path entry applier (projection/entries.ts),
        // so the FK holds; readers coalesce a null proposer to the local self.
        e.proposed_by_user_id || null,
        e.current_event_id,
        e.is_deleted,
        e.is_settled,
        e.accepted_at,
        e.disputed_at,
        e.disputed_reason,
        e.settled_at,
        floorFieldHLCs(["amount_afn", "note", "type", "occurred_at_ms"], e.updated_at),
      );
    }

    // 6. Re-arm this vault's locally-authored, not-yet-server-acked events.
    //    Local events are stamped applied_at at append time, and the snapshot
    //    seed above just overwrote their projection effects with server-side
    //    values (an offline edit's tally, an offline archive's archived_at).
    //    The sweep only retries applied_at IS NULL rows, so without this
    //    reset those effects would silently vanish from THIS device forever —
    //    while the rows still sit in the push outbox and reach the server,
    //    i.e. permanent local/server divergence. Resetting applied_at (and
    //    any stale quarantine_reason) makes the post-restore sweepVaultNow
    //    below replay them in HLC order on top of the snapshot base; the
    //    snapshot's field-HLC floors sit at updated_at, below these events'
    //    HLCs, so LWW re-accepts them. Server-acked rows are already
    //    represented in the snapshot; rejected rows are server-refused and
    //    must NOT resurrect over server truth — both stay untouched.
    await db.runAsync(
      `UPDATE event_log
          SET applied_at = NULL, quarantine_reason = NULL
        WHERE vault_id = ?
          AND origin = 'local'
          AND server_acked_at IS NULL
          AND rejected_at IS NULL`,
      v.id,
    );

    // 7. Seed app_meta — hlc_last always; active/default only when this
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

  // 8. DURABLY INGEST the membership chain + the post-snapshot event tail, then
  //    apply them via one sweep pass. This is the restore-side half of the
  //    fundamental data-loss fix: events go in as durable event_log rows
  //    (applied_at=NULL) via the SAME ingest path as server-pull, so a tail
  //    event that can't apply yet (its person/relationship is itself in the
  //    tail, or the membership chain hasn't healed) is QUARANTINED and retried
  //    by the sweep — NOT swallowed by a try/catch while the cursor below
  //    advances past it forever (the old applyEvent-direct loop's silent-loss
  //    bug, which is exactly how "the latest tallies didn't come back").
  //
  //    Membership first (genesis + member/device adds) so a RECOVERED device's
  //    proof bundle is complete and the role-gate can authenticate the tail's
  //    signed entries during the sweep; both are idempotent by event_id and HLC
  //    drives merge order, so the split is safe even if they overlap.
  //
  //    Wire shape note: snapshot.{events,membership_events} arrive in the
  //    backend PulledEvent JSON shape (account_id / schema_version / nullable
  //    target_id), NOT the LedgerEvent shape — mapPulledWireToEvent normalizes
  //    them exactly as the pull path does (the old loop passed them raw to
  //    applyEvent, silently dropping actor_account_id / payload_schema).
  const now = Date.now();
  const membershipEvents = (snapshot.membership_events ?? []).map((ev) =>
    mapPulledWireToEvent(ev as unknown as PulledWireEvent, snapshot.vault.id),
  );
  const tailEvents = snapshot.events.map((ev) =>
    mapPulledWireToEvent(ev as unknown as PulledWireEvent, snapshot.vault.id),
  );
  await ingestPulledEvents(membershipEvents, now);
  appliedEvents += await ingestPulledEvents(tailEvents, now);

  // 9. Seed the pull cursor to snapshot_server_seq. Without this, the
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

  // Apply the durably-ingested membership + tail — plus the re-armed local
  // unpushed events from step 6 — now (one fixpoint sweep pass:
  // create-before-amend, membership-before-entry resolve in a single pass), so
  // the restored ledger is populated when this returns — not just the snapshot
  // base. Best-effort: the rows are durable, so a sweep failure here only defers
  // application to recoverAllVaults' end-of-loop scheduleSweep / the cold-launch
  // sweepAllQuarantinedVaults. Nothing can be lost.
  try {
    await sweepVaultNow(snapshot.vault.id);
  } catch (err) {
    console.warn("[restore] post-restore sweep failed", snapshot.vault.id.slice(0, 8), err);
  }

  return {
    ok: true,
    applied_events: appliedEvents,
    snapshot_server_seq: snapshot.snapshot_server_seq,
  };
}
