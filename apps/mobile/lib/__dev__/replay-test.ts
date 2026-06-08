// Phase 1 dev-only sanity check: prove the event_log is the source of truth.
//
// Steps:
//   1. Snapshot current `entries` rows (deterministic order: id ASC).
//   2. Inside a single transaction:
//        a. DELETE FROM entries
//        b. SELECT * FROM event_log ORDER BY HLC ASC
//        c. For each row, reconstruct the LedgerEvent and dispatch the
//           projection applier (skipping applyEvent's HLC machinery, which
//           would no-op on the existing event_ids).
//   3. After the tx commits, re-snapshot `entries`.
//   4. Byte-compare the two snapshots. Pass iff identical.
//
// Safety: the dispatcher runs inside withTransactionAsync. Any throw inside
// the callback rolls the whole thing back, so a half-applied projection can
// never escape. Even if every step succeeds, we still verify the result.
//
// NOT auto-run anywhere. Exported for the founder to call from a debug
// screen or the Metro console:
//
//   import { replayTest } from "@/lib/__dev__/replay-test";
//   replayTest().then(console.log);
//
// Doesn't import expo-sqlite directly — uses the same getDb() handle the
// rest of the app uses, so it operates on the live kaata.db.

import { getDb } from "../db-tx";
import {
  _dispatchProjectionApplier,
  // applyEvent is intentionally NOT imported — we want raw applier dispatch
  // here, see top-of-file comment.
} from "../projection";
import { type LedgerEvent, isKnownEventType } from "../events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReplayTestResult = {
  passed: boolean;
  before: number;
  after: number;
  events_replayed: number;
  // Per-table counts of pre-replay rows, for diagnostic context.
  users_before?: number;
  relationships_before?: number;
  shop_profile_before?: number;
  diff?: string;
};

// Mirror of the `entries` row shape we care about for byte-comparison.
// Listed columns are explicit so we don't accidentally include
// implementation-detail columns added later without thinking.
type EntryRow = {
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
  // Projection-cache columns added in migration 005.
  current_event_id: string | null;
  is_deleted: number;
  is_settled: number;
  // Phase 4 per-field LWW HLC sidecar. Included in the comparison so
  // replay-test catches drift in field-HLC bookkeeping (ENG #5). Stored
  // as JSON-encoded string; the byte-comparison treats unequal strings
  // as a mismatch even if the parsed maps would be equal — acceptable
  // because both branches serialize via the same serializeFieldHLCs path.
  field_hlcs: string | null;
};

// Phase 2 projection targets. The replay test wipes + rebuilds these too
// because person_*/shop_profile_updated events project to them. Excluding
// them would let a broken applier corrupt these tables silently while the
// entries-only replay still passes.
type UserRow = {
  id: string;
  phone_e164: string | null;
  display_name: string;
  is_local_self: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  google_sub: string | null;
  account_id: string | null;
  field_hlcs: string | null;
};

type RelationshipRow = {
  id: string;
  vault_id: string;
  user_a_id: string;
  user_b_id: string;
  context: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

type ShopProfileRow = {
  vault_id: string;
  owner_name: string | null;
  shop_name: string;
  created_at: number;
  updated_at: number;
  field_hlcs: string | null;
};

type EventLogRow = {
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
  server_acked_at: number | null;
  rejected_at: number | null;
  origin: string;
};

// Column list used by both the snapshot SELECT and the serializer.
// Keep these two in sync.
const ENTRY_COLUMNS = [
  "id",
  "relationship_id",
  "type",
  "amount_afn",
  "note",
  "created_at",
  "updated_at",
  "deleted_at",
  "proposed_by_user_id",
  "accepted_at",
  "disputed_at",
  "disputed_reason",
  "settled_at",
  "current_event_id",
  "is_deleted",
  "is_settled",
  // ENG #5 (Phase 4): include the per-field LWW HLC sidecar in the
  // byte-comparison so a divergence in field-HLC bookkeeping (e.g. a
  // dispatch reorder that writes a different pms tiebreak) is caught.
  "field_hlcs",
] as const;

const USER_COLUMNS = [
  "id",
  "phone_e164",
  "display_name",
  "is_local_self",
  "created_at",
  "updated_at",
  "archived_at",
  "google_sub",
  "account_id",
  "field_hlcs",
] as const;

const RELATIONSHIP_COLUMNS = [
  "id",
  "vault_id",
  "user_a_id",
  "user_b_id",
  "context",
  "created_at",
  "updated_at",
  "archived_at",
] as const;

const SHOP_PROFILE_COLUMNS = [
  "vault_id",
  "owner_name",
  "shop_name",
  "created_at",
  "updated_at",
  "field_hlcs",
] as const;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function replayTest(): Promise<ReplayTestResult> {
  const db = await getDb();

  // 1. Snapshot pre-replay state for every projection target.
  //
  // entries are wiped (DELETE FROM entries) and rebuilt entirely from the
  // event_log. users/relationships/shop_profile are wiped EXCEPT for the
  // local-self user — that row is created by direct INSERT in
  // createSelfProfile (it's the device's own identity, not a peer added
  // via person_added), and the relationships FK against it means we'd
  // have to suspend FK checks just to clear it. Phase 3 cross-device
  // restore handles local-self differently (the new device mints its own
  // self user from fresh onboarding); the replay test mirrors that.
  const beforeEntries = await db.getAllAsync<EntryRow>(
    `SELECT ${ENTRY_COLUMNS.join(", ")} FROM entries ORDER BY id ASC`,
  );
  const beforeUsers = await db.getAllAsync<UserRow>(
    `SELECT ${USER_COLUMNS.join(", ")} FROM users ORDER BY id ASC`,
  );
  const beforeRelationships = await db.getAllAsync<RelationshipRow>(
    `SELECT ${RELATIONSHIP_COLUMNS.join(", ")} FROM relationships ORDER BY id ASC`,
  );
  const beforeShopProfile = await db.getAllAsync<ShopProfileRow>(
    `SELECT ${SHOP_PROFILE_COLUMNS.join(", ")} FROM shop_profile ORDER BY vault_id ASC`,
  );

  const beforeEntriesSerialized = serializeRows(beforeEntries, ENTRY_COLUMNS);
  const beforeUsersSerialized = serializeRows(beforeUsers, USER_COLUMNS);
  const beforeRelsSerialized = serializeRows(beforeRelationships, RELATIONSHIP_COLUMNS);
  const beforeShopSerialized = serializeRows(beforeShopProfile, SHOP_PROFILE_COLUMNS);

  // 2. Wipe + replay inside a single transaction. We deliberately throw a
  //    sentinel error inside the callback at the end if the rebuilt
  //    projection doesn't match the snapshot — that rolls the tx back so a
  //    failing replay never leaves the user's live projection corrupted.
  //    Successful replay commits (the rebuilt rows are byte-identical to
  //    the original, so the commit is a no-op).
  let eventsReplayed = 0;
  let afterEntries: EntryRow[] = [];
  let afterUsers: UserRow[] = [];
  let afterRelationships: RelationshipRow[] = [];
  let afterShopProfile: ShopProfileRow[] = [];
  let mismatchTable = "";

  class ReplayMismatchError extends Error {
    constructor() {
      super("replay mismatch — rolling back to preserve live projection");
    }
  }

  try {
    await db.withTransactionAsync(async () => {
      // Wipe order matters for FK integrity (FKs are ON unless explicitly
      // toggled, and we don't touch the PRAGMA inside a transaction). Drop
      // child rows first: entries → relationships → non-self users →
      // shop_profile. Local-self stays so user_a_id has a target.
      await db.runAsync("DELETE FROM entries");
      await db.runAsync("DELETE FROM relationships");
      await db.runAsync("DELETE FROM users WHERE is_local_self = 0");
      await db.runAsync("DELETE FROM shop_profile");

      const eventRows = await db.getAllAsync<EventLogRow>(
        `SELECT event_id, event_type, vault_id, target_id, relationship_id,
                hlc_physical_ms, hlc_logical, hlc_device_id, device_id,
                author_user_id_local_only, actor_account_id,
                payload_json, payload_schema,
                appended_at, server_acked_at, rejected_at, origin
         FROM event_log
         ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC`,
      );

      // shop_profile_updated appliers UPDATE rather than INSERT — they
      // expect a row to already exist for the vault. createSelfProfile
      // emits a shop_profile_updated as part of onboarding, but the
      // INSERT is direct (not event-sourced). Replay therefore needs to
      // seed an empty shop_profile row per vault before the events run.
      // We use the active_vault_id and any vault referenced by events.
      const vaultIds = new Set<string>();
      for (const row of eventRows) {
        if (row.vault_id) vaultIds.add(row.vault_id);
      }
      for (const vaultId of vaultIds) {
        const vaultMeta = await db.getFirstAsync<{
          name: string;
          created_at: number;
        }>("SELECT name, created_at FROM vaults WHERE id = ?", vaultId);
        if (vaultMeta) {
          await db.runAsync(
            `INSERT OR IGNORE INTO shop_profile
               (vault_id, owner_name, shop_name, created_at, updated_at)
             VALUES (?, NULL, ?, ?, ?)`,
            vaultId,
            vaultMeta.name,
            vaultMeta.created_at,
            vaultMeta.created_at,
          );
        }
      }

      for (const row of eventRows) {
        const event = reconstructEvent(row);
        if (!event) {
          // Unknown / malformed events are skipped, matching the
          // forward-compat contract in events.ts. They don't count toward
          // events_replayed.
          continue;
        }
        await _dispatchProjectionApplier(db, event);
        eventsReplayed += 1;
      }

      // Snapshot the rebuilt projection while still inside the tx so we
      // can compare before deciding whether to commit or roll back.
      afterEntries = await db.getAllAsync<EntryRow>(
        `SELECT ${ENTRY_COLUMNS.join(", ")} FROM entries ORDER BY id ASC`,
      );
      afterUsers = await db.getAllAsync<UserRow>(
        `SELECT ${USER_COLUMNS.join(", ")} FROM users ORDER BY id ASC`,
      );
      afterRelationships = await db.getAllAsync<RelationshipRow>(
        `SELECT ${RELATIONSHIP_COLUMNS.join(", ")} FROM relationships ORDER BY id ASC`,
      );
      afterShopProfile = await db.getAllAsync<ShopProfileRow>(
        `SELECT ${SHOP_PROFILE_COLUMNS.join(", ")} FROM shop_profile ORDER BY vault_id ASC`,
      );

      const afterEntriesSerialized = serializeRows(afterEntries, ENTRY_COLUMNS);
      const afterUsersSerialized = serializeRows(afterUsers, USER_COLUMNS);
      const afterRelsSerialized = serializeRows(afterRelationships, RELATIONSHIP_COLUMNS);
      const afterShopSerialized = serializeRows(afterShopProfile, SHOP_PROFILE_COLUMNS);

      if (beforeEntriesSerialized !== afterEntriesSerialized) {
        mismatchTable = "entries";
        throw new ReplayMismatchError();
      }
      if (beforeUsersSerialized !== afterUsersSerialized) {
        mismatchTable = "users";
        throw new ReplayMismatchError();
      }
      if (beforeRelsSerialized !== afterRelsSerialized) {
        mismatchTable = "relationships";
        throw new ReplayMismatchError();
      }
      if (beforeShopSerialized !== afterShopSerialized) {
        mismatchTable = "shop_profile";
        throw new ReplayMismatchError();
      }
    });
  } catch (err) {
    if (!(err instanceof ReplayMismatchError)) throw err;
    // Mismatch path — projection is rolled back, fall through to report.
  }

  const passed = mismatchTable === "";

  const result: ReplayTestResult = {
    passed,
    before: beforeEntries.length,
    after: afterEntries.length,
    events_replayed: eventsReplayed,
    users_before: beforeUsers.length,
    relationships_before: beforeRelationships.length,
    shop_profile_before: beforeShopProfile.length,
  };

  if (!passed) {
    if (mismatchTable === "entries") {
      result.diff = "entries: " + computeDiff(beforeEntries, afterEntries);
    } else if (mismatchTable === "users") {
      result.diff = `users mismatch (${beforeUsers.length} before, ${afterUsers.length} after)`;
    } else if (mismatchTable === "relationships") {
      result.diff = `relationships mismatch (${beforeRelationships.length} before, ${afterRelationships.length} after)`;
    } else if (mismatchTable === "shop_profile") {
      result.diff = `shop_profile mismatch (${beforeShopProfile.length} before, ${afterShopProfile.length} after)`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Reconstruct a LedgerEvent from an event_log row. Returns null if the
// event_type is unknown to this client build, so old clients reading newer
// events stay forward-compatible (matches the events.ts contract).
function reconstructEvent(row: EventLogRow): LedgerEvent | null {
  if (!isKnownEventType(row.event_type)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    // Malformed payload — skip rather than crash the whole replay.
    return null;
  }

  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  // The persisted payload is the event's `payload` field. Rebuild the full
  // envelope from the row columns + payload so the applier signature matches
  // exactly what appendEntry* originally constructed.
  const event = {
    event_id: row.event_id,
    event_type: row.event_type,
    vault_id: row.vault_id,
    target_id: row.target_id,
    relationship_id: row.relationship_id,
    hlc: {
      pms: row.hlc_physical_ms,
      l: row.hlc_logical,
      did: row.hlc_device_id,
    },
    device_id: row.device_id,
    author_user_id_local_only: row.author_user_id_local_only,
    actor_account_id: row.actor_account_id,
    payload_schema: row.payload_schema,
    appended_at: row.appended_at,
    server_acked_at: row.server_acked_at,
    rejected_at: row.rejected_at,
    origin: row.origin,
    payload: payload as Record<string, unknown>,
  } as unknown as LedgerEvent;

  return event;
}

// Deterministic, byte-stable JSON of any projection-table row set. Rows are
// already ordered by primary key at the SQL level; we serialize each row with
// a fixed key order (driven by the column list) so JSON.stringify produces
// the same bytes across runs regardless of how SQLite reports column order.
function serializeRows<R extends Record<string, unknown>>(
  rows: R[],
  columns: ReadonlyArray<keyof R>,
): string {
  const normalized = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    for (const col of columns) {
      obj[col as string] = r[col];
    }
    return obj;
  });
  return JSON.stringify(normalized);
}

// Short line-by-line diff: which entry ids differ and on which fields.
// No external diff library. Caps output so we don't return megabytes of
// text if the projection is wildly out of sync.
function computeDiff(before: EntryRow[], after: EntryRow[]): string {
  const MAX_LINES = 50;

  const beforeById = new Map<string, EntryRow>();
  for (const r of before) beforeById.set(r.id, r);
  const afterById = new Map<string, EntryRow>();
  for (const r of after) afterById.set(r.id, r);

  const allIds = new Set<string>([...beforeById.keys(), ...afterById.keys()]);
  const sortedIds = Array.from(allIds).sort();

  const lines: string[] = [];

  for (const id of sortedIds) {
    if (lines.length >= MAX_LINES) {
      lines.push(`... (truncated; ${sortedIds.length - lines.length} more ids may differ)`);
      break;
    }

    const b = beforeById.get(id);
    const a = afterById.get(id);

    if (b && !a) {
      lines.push(`- ${id}: present before, missing after`);
      continue;
    }
    if (!b && a) {
      lines.push(`+ ${id}: missing before, present after`);
      continue;
    }
    if (!b || !a) continue;

    const differingFields: string[] = [];
    for (const col of ENTRY_COLUMNS) {
      const bv = b[col];
      const av = a[col];
      if (bv !== av) {
        differingFields.push(`${col}(before=${formatValue(bv)}, after=${formatValue(av)})`);
      }
    }
    if (differingFields.length > 0) {
      lines.push(`~ ${id}: ${differingFields.join(", ")}`);
    }
  }

  if (lines.length === 0) {
    // Snapshots differed at the JSON level but per-field comparison found
    // nothing — almost certainly a key-ordering or whitespace bug in this
    // helper rather than a real projection drift.
    return "byte mismatch with no per-field differences (serializer bug?)";
  }

  return lines.join("\n");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
