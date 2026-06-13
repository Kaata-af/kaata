import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import {
  _resetAccountIdCacheForReset,
  _resetActiveVaultIdCacheForReset,
  _resetDbHandleForReset,
  getAccountIdSync,
  getActiveVaultId,
  getActiveVaultIdSync,
  getActiveVaultIdSyncMaybe,
  getAppMetaInTx,
  getDb as getDbFromTx,
  refreshLocalSelfUserIdCache,
  setActiveVaultIdCache,
  setAppMetaInTx,
} from "./db-tx";
import {
  appendEntryAmended,
  appendEntryCreated,
  appendEntryDeleted,
  appendPersonAdded,
  appendPersonArchived,
  appendPersonPhoneChanged,
  appendPersonRenamed,
  appendShopProfileUpdated,
  appendVaultMemberAdded,
  findPhoneConflictInVault,
} from "./event-log";
import { buildLocalAccountId } from "./trust/account-id";
import { normalizePhone } from "./phone";
import type {
  CreatePersonResult,
  Direction,
  Entry,
  EntryType,
  PersonWithBalance,
  Self,
  UpdatePersonResult,
} from "./types";
import { KAATA_UUID_NAMESPACE, uuidv5 } from "./uuid-v5";
import { serializeHLC } from "./hlc";

// Re-exported from db-tx.ts so existing call sites (`import { getDb } from
// "./db"`) keep compiling unchanged. The handle/singleton lives in db-tx.ts
// to break the circular import between db.ts and event-log.ts.
export const getDb = getDbFromTx;

const MIGRATION_001 = "001_v0_to_users_relationships";
const MIGRATION_002 = "002_add_updated_at";
const MIGRATION_003 = "003_unify_relationships_to_peer";
const MIGRATION_004 = "004_onboarding_state_keys";
const MIGRATION_005 = "005_event_log_and_projection_cache";
const MIGRATION_006 = "006_backfill_synthetic_events";
const MIGRATION_007 = "007_vaults_and_account_binding";
const MIGRATION_008 = "008_sync_state_and_projection_conflicts";
const MIGRATION_009 = "009_phase4_invites_vault_settings_field_hlcs";
const MIGRATION_010 = "010_event_log_vault_type_target_index";
const MIGRATION_011 = "011_phase5_mesh_credentials";
const MIGRATION_012 = "012_vault_trust_anchor";
const MIGRATION_013 = "013_event_log_signature_and_revocation_lift";
const MIGRATION_014 = "014_event_log_ingest_apply_split";
const MIGRATION_015 = "015_vault_members_mirror_display_name";
const MIGRATION_016 = "016_mem_samples_diagnostics";
const MIGRATION_017 = "017_crash_outbox";
const MIGRATION_018 = "018_event_author_seq";
const MIGRATION_019 = "019_vault_device_registry";

// Phase 5 mesh: app_meta keys used by the lib/mesh package. They are NOT
// referenced from db.ts directly — the table itself is the generic key/value
// store created during initDb above — but they're listed here so a grep
// across the codebase always lands at a documented entry point.
//
//   'mesh_device_ed25519_pubkey'   — base64 of this device's Ed25519 public
//                                    key. The matching private key is stored
//                                    in expo-secure-store under the key
//                                    'kaata_mesh_device_privkey' and never
//                                    touches the SQLite database.
//   'mesh_server_pubkey_primary'   — base64 of the server's primary signing
//                                    pubkey, pinned on first /v1/check-in
//                                    that announces it. Used to verify every
//                                    VMC during mesh handshake.
//   'mesh_server_pubkey_rotation'  — base64 of the server's rotation pubkey
//                                    during a key-rotation window; absent
//                                    outside of one. VMCs are accepted if
//                                    signed by EITHER pinned key.
//   'shop_mode_enabled'            — '0' or '1'. Gates mDNS publish/browse
//                                    and WebRTC handshake. Off by default;
//                                    user toggles via Account screen.
//   'shop_mode_last_active_at'     — wall-clock ms of the most recent
//                                    successful mesh handshake. Used by the
//                                    12h auto-off timer to flip
//                                    shop_mode_enabled back to '0' after
//                                    inactivity.
//   'last_revocation_seen_at_ms'   — JSON object {vault_id: ms} of the
//                                    most recent revocation timestamp we
//                                    have ingested per vault. Sent on
//                                    /v1/check-in so the server only ships
//                                    deltas.
//   'mesh_per_device_salt'         — per-device salt reserved for a future
//                                    server-mediated rendezvous token. NOT
//                                    used by discovery.ts (mDNS rendezvous
//                                    requires a deterministic tag both
//                                    sides can compute).
//   'pending_pair_tokens'          — JSON array of one-time pairing nonces
//                                    issued by the owner-side QR-pair flow
//                                    (apps/mobile/app/vault/pair.tsx). Each
//                                    entry: {token, vault_id, expires_at_ms};
//                                    GC'd on every read.

// Sentinel HLC used as the floor for backfilled rows with NULL field_hlcs.
// Any real event has pms >= 1 so this is strictly less than every real HLC
// under compareHLC — the first real amend always wins. Exported so projection
// appliers can synthesize the floor without re-deriving the literal.
export const FIELD_HLC_INIT = { pms: 0, l: 0, did: "init" } as const;

// initDb is split into two implicit phases: schema bootstrap (always runs)
// and migrations 001..006 (run once each, tracked in schema_migrations).
// Pass installId so migration 006 has it without falling back to a zero
// UUID — call ensureInstallId() first, then initDb({installId}). If
// installId is omitted, migration 006 will read it from app_meta itself;
// if it's missing there too AND there are entries to backfill, the
// migration throws rather than silently using the zero UUID.
export async function initDb(opts: { installId?: string } = {}): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  if (!(await hasRunMigration(db, MIGRATION_001))) {
    try {
      await runMigration001(db);
    } catch (err) {
      console.error("[init] runMigration001 failed:", err);
      throw new Error("runMigration001 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_002))) {
    try {
      await runMigration002(db);
    } catch (err) {
      console.error("[init] runMigration002 failed:", err);
      throw new Error("runMigration002 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_003))) {
    try {
      await runMigration003(db);
    } catch (err) {
      console.error("[init] runMigration003 failed:", err);
      throw new Error("runMigration003 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_004))) {
    try {
      await runMigration004(db);
    } catch (err) {
      console.error("[init] runMigration004 failed:", err);
      throw new Error("runMigration004 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_005))) {
    try {
      await runMigration005(db);
    } catch (err) {
      console.error("[init] runMigration005 failed:", err);
      throw new Error("runMigration005 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_006))) {
    try {
      await runMigration006(db, opts.installId);
    } catch (err) {
      console.error("[init] runMigration006 failed:", err);
      throw new Error("runMigration006 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_007))) {
    try {
      await runMigration007(db);
    } catch (err) {
      console.error("[init] runMigration007 failed:", err);
      throw new Error("runMigration007 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_008))) {
    try {
      await runMigration008(db);
    } catch (err) {
      console.error("[init] runMigration008 failed:", err);
      throw new Error("runMigration008 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_009))) {
    try {
      await runMigration009(db);
    } catch (err) {
      console.error("[init] runMigration009 failed:", err);
      throw new Error("runMigration009 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_010))) {
    try {
      await runMigration010(db);
    } catch (err) {
      console.error("[init] runMigration010 failed:", err);
      throw new Error("runMigration010 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_011))) {
    try {
      await runMigration011(db);
    } catch (err) {
      console.error("[init] runMigration011 failed:", err);
      throw new Error("runMigration011 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_012))) {
    try {
      await runMigration012(db);
    } catch (err) {
      console.error("[init] runMigration012 failed:", err);
      throw new Error("runMigration012 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_013))) {
    try {
      await runMigration013(db);
    } catch (err) {
      console.error("[init] runMigration013 failed:", err);
      throw new Error("runMigration013 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_014))) {
    try {
      await runMigration014(db);
    } catch (err) {
      console.error("[init] runMigration014 failed:", err);
      throw new Error("runMigration014 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_015))) {
    try {
      await runMigration015(db);
    } catch (err) {
      console.error("[init] runMigration015 failed:", err);
      throw new Error("runMigration015 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_016))) {
    try {
      await runMigration016(db);
    } catch (err) {
      console.error("[init] runMigration016 failed:", err);
      throw new Error("runMigration016 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_017))) {
    try {
      await runMigration017(db);
    } catch (err) {
      console.error("[init] runMigration017 failed:", err);
      throw new Error("runMigration017 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_018))) {
    try {
      await runMigration018(db, opts.installId);
    } catch (err) {
      console.error("[init] runMigration018 failed:", err);
      throw new Error("runMigration018 failed: " + String(err));
    }
  }
  if (!(await hasRunMigration(db, MIGRATION_019))) {
    try {
      await runMigration019(db);
    } catch (err) {
      console.error("[init] runMigration019 failed:", err);
      throw new Error("runMigration019 failed: " + String(err));
    }
  }
}

async function hasRunMigration(db: SQLite.SQLiteDatabase, name: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?",
    name,
  );
  return (row?.count ?? 0) > 0;
}

async function tableExists(db: SQLite.SQLiteDatabase, name: string): Promise<boolean> {
  const row = await db.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    name,
  );
  return Boolean(row);
}

async function columnExists(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

// Migration 001: v0 (shopkeeper/customers/entries) -> v1 (users/shop_profile/relationships/entries-new).
async function runMigration001(db: SQLite.SQLiteDatabase): Promise<void> {
  const hasV0 = await tableExists(db, "customers");

  let oldShopkeeper: V0Shopkeeper | null = null;
  let oldCustomers: V0Customer[] = [];
  let oldEntries: V0Entry[] = [];

  if (hasV0) {
    if (await tableExists(db, "shopkeeper")) {
      oldShopkeeper =
        (await db.getFirstAsync<V0Shopkeeper>(
          "SELECT id, shop_name, owner_name, created_at FROM shopkeeper WHERE id = 1",
        )) ?? null;
    }
    oldCustomers = await db.getAllAsync<V0Customer>(
      "SELECT id, name, phone, created_at, archived_at FROM customers",
    );
    if (await tableExists(db, "entries")) {
      oldEntries = await db.getAllAsync<V0Entry>(
        "SELECT id, customer_id, type, amount_afn, note, created_at, deleted_at FROM entries",
      );
    }
  }

  await db.withTransactionAsync(async () => {
    if (hasV0) {
      await db.execAsync(`
        DROP TABLE IF EXISTS entries;
        DROP TABLE IF EXISTS customers;
      `);
      if (await tableExists(db, "shopkeeper")) {
        await db.execAsync("ALTER TABLE shopkeeper RENAME TO _old_shopkeeper");
      }
    }

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        phone_e164 TEXT UNIQUE,
        display_name TEXT NOT NULL,
        is_local_self INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS shop_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL REFERENCES users(id),
        shop_name TEXT NOT NULL,
        owner_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        user_a_id TEXT NOT NULL REFERENCES users(id),
        user_b_id TEXT NOT NULL REFERENCES users(id),
        context TEXT NOT NULL DEFAULT 'customer' CHECK (context IN ('customer', 'supplier', 'peer')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        UNIQUE (user_a_id, user_b_id, context)
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        relationship_id TEXT NOT NULL REFERENCES relationships(id),
        type TEXT NOT NULL CHECK (type IN ('debt', 'payment')),
        amount_afn INTEGER NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        proposed_by_user_id TEXT REFERENCES users(id),
        accepted_at INTEGER,
        disputed_at INTEGER,
        disputed_reason TEXT,
        settled_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_entries_relationship
        ON entries(relationship_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_users_phone
        ON users(phone_e164) WHERE phone_e164 IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_relationships_a
        ON relationships(user_a_id) WHERE archived_at IS NULL;
    `);

    if (oldShopkeeper) {
      const localSelfUserId = Crypto.randomUUID();
      const displayName = oldShopkeeper.owner_name?.trim() || oldShopkeeper.shop_name;

      await db.runAsync(
        "INSERT INTO users (id, display_name, is_local_self, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
        localSelfUserId,
        displayName,
        oldShopkeeper.created_at,
        oldShopkeeper.created_at,
      );
      await db.runAsync(
        "INSERT INTO shop_profile (id, user_id, shop_name, owner_name, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
        localSelfUserId,
        oldShopkeeper.shop_name,
        oldShopkeeper.owner_name,
        oldShopkeeper.created_at,
        oldShopkeeper.created_at,
      );

      const customerToRel = new Map<string, string>();
      const usedPhones = new Set<string>();
      let phonesInvalidCount = 0;
      let phonesConflictCount = 0;

      for (const c of oldCustomers) {
        let phoneE164: string | null = null;
        if (c.phone) {
          const np = normalizePhone(c.phone);
          if (!np) {
            phonesInvalidCount++;
          } else if (usedPhones.has(np)) {
            phonesConflictCount++;
          } else {
            phoneE164 = np;
            usedPhones.add(np);
          }
        }

        const newUserId = c.id;
        const newRelId = Crypto.randomUUID();
        await db.runAsync(
          "INSERT INTO users (id, phone_e164, display_name, is_local_self, created_at, updated_at, archived_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
          newUserId,
          phoneE164,
          c.name,
          c.created_at,
          c.created_at,
          c.archived_at,
        );
        await db.runAsync(
          "INSERT INTO relationships (id, user_a_id, user_b_id, context, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          newRelId,
          localSelfUserId,
          newUserId,
          "customer",
          c.created_at,
          c.created_at,
          c.archived_at,
        );
        customerToRel.set(c.id, newRelId);
      }

      for (const e of oldEntries) {
        const relId = customerToRel.get(e.customer_id);
        if (!relId) continue;
        await db.runAsync(
          "INSERT INTO entries (id, relationship_id, type, amount_afn, note, created_at, updated_at, deleted_at, proposed_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.id,
          relId,
          e.type,
          e.amount_afn,
          e.note,
          e.created_at,
          e.created_at,
          e.deleted_at,
          localSelfUserId,
        );
      }

      if (phonesInvalidCount > 0) {
        await db.runAsync(
          "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          "migration_001_phones_invalid_count",
          String(phonesInvalidCount),
        );
      }
      if (phonesConflictCount > 0) {
        await db.runAsync(
          "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          "migration_001_phones_conflict_count",
          String(phonesConflictCount),
        );
      }
    }

    await db.runAsync(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      MIGRATION_001,
      Date.now(),
    );
  });
}

async function runMigration002(db: SQLite.SQLiteDatabase): Promise<void> {
  const tables = ["users", "shop_profile", "relationships", "entries"] as const;
  await db.withTransactionAsync(async () => {
    for (const t of tables) {
      if (!(await tableExists(db, t))) continue;
      if (await columnExists(db, t, "updated_at")) continue;
      await db.execAsync(`ALTER TABLE ${t} ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`);
      await db.execAsync(`UPDATE ${t} SET updated_at = created_at WHERE updated_at = 0`);
    }
    await db.runAsync(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      MIGRATION_002,
      Date.now(),
    );
  });
}

// Migration 003: collapse all relationships to 'peer' context.
//
// v1 briefly split persons into customer/supplier with direction baked in at
// creation. v1.1 reverses that — direction is derived from the running net
// balance, not a property of the person. To get there:
//
//   1. For any (user_a, user_b) pair with BOTH a customer AND a supplier
//      relationship, re-point the supplier entries onto the customer rel
//      (flipping their type, since the supplier semantic was inverted), then
//      drop the now-empty supplier rel. This avoids hitting the UNIQUE
//      (user_a, user_b, context) constraint when we rename to peer.
//   2. For remaining supplier-only relationships: flip every entry's type
//      (debt ↔ payment) so the new "I gave"/"I received" semantic is correct.
//   3. Rename every customer/supplier relationship to context = 'peer'.
//
// Entries created under the old supplier semantic had:
//   debt    = "I took from supplier" → in new model this is "I received" (payment)
//   payment = "I paid supplier"      → in new model this is "I gave" (debt)
// So the flip is exact.
async function runMigration003(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    const now = Date.now();

    // Step 1: dual-context pairs
    const dual = await db.getAllAsync<{ customer_rel_id: string; supplier_rel_id: string }>(
      `SELECT c.id AS customer_rel_id, s.id AS supplier_rel_id
       FROM relationships c
       INNER JOIN relationships s
         ON c.user_a_id = s.user_a_id AND c.user_b_id = s.user_b_id
       WHERE c.context = 'customer' AND s.context = 'supplier'`,
    );
    for (const pair of dual) {
      // Re-point supplier entries to customer rel, flipping their type.
      await db.runAsync(
        `UPDATE entries
         SET relationship_id = ?,
             type = CASE type WHEN 'debt' THEN 'payment' WHEN 'payment' THEN 'debt' ELSE type END,
             updated_at = ?
         WHERE relationship_id = ?`,
        pair.customer_rel_id,
        now,
        pair.supplier_rel_id,
      );
      // Drop the supplier rel; its entries now live on the customer rel.
      await db.runAsync(`DELETE FROM relationships WHERE id = ?`, pair.supplier_rel_id);
    }

    // Step 2: remaining supplier-only rels — flip entry types in place.
    await db.runAsync(
      `UPDATE entries
       SET type = CASE type WHEN 'debt' THEN 'payment' WHEN 'payment' THEN 'debt' ELSE type END,
           updated_at = ?
       WHERE relationship_id IN (
         SELECT id FROM relationships WHERE context = 'supplier'
       )`,
      now,
    );

    // Step 3: rename all surviving customer + supplier rels to peer.
    await db.runAsync(
      `UPDATE relationships
       SET context = 'peer', updated_at = ?
       WHERE context IN ('customer', 'supplier')`,
      now,
    );

    await db.runAsync(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      MIGRATION_003,
      Date.now(),
    );
  });
}

// Migration 004: onboarding state keys + upgrade-path defaults.
//
// app_meta keys that the new onboarding state machine reads/writes (no DDL —
// app_meta is a generic k/v table, this just documents the contract):
//
//   onboarding_step  — values: 'language' | 'auth' | 'profile' | 'done'
//                       (null on fresh install is treated as 'language')
//   onboarding_pending_name   — email name returned by Google sign-in, NOT
//                                used to prefill any field (per UX call); kept
//                                only to render "Signed in as X" subtitle
//   onboarding_pending_email  — email from Google sign-in, used for the
//                                subtitle above
//   tour_completed   — '1' once the user has seen or skipped the home tour.
//                       Absence / '0' means show the tour on next home visit.
//
// SecureStore (NOT app_meta) holds the Google session JWT — see lib/auth.ts.
//
// Upgrade path: any install that already has a local_self user predates this
// migration, so they ARE onboarded. We mark them so:
//   - onboarding_step = 'done' (routing skips /onboarding/* for them)
// We deliberately do NOT set tour_completed for upgraders — they should see
// the tour on next launch, same as fresh installs. They can skip it if they
// already know the app.
async function runMigration004(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Detect whether this install already has a local_self user (i.e. they
    // onboarded under the old single-screen flow). Safer than querying
    // getLocalSelf() because we're inside a migration transaction.
    const selfRow = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM users WHERE is_local_self = 1 LIMIT 1`,
    );
    if (selfRow) {
      await db.runAsync(
        `INSERT INTO app_meta (key, value) VALUES ('onboarding_step', 'done')
         ON CONFLICT(key) DO UPDATE SET value = 'done'`,
      );
    }

    await db.runAsync(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      MIGRATION_004,
      Date.now(),
    );
  });
}

// Migration 005: event log table + projection cache columns on entries.
//
// The event_log is the append-only source of truth from Phase 1 onward. Every
// entry CRUD path goes through it (see lib/event-log.ts); legacy mutation of
// entries rows is gone. Projection cache columns (current_event_id, is_deleted,
// is_settled) speed up the home/balance queries without scanning the log.
//
// No FK constraints on event_log.relationship_id / target_id — intentional per
// the append-only event-sourcing model: events must remain valid even if a
// referenced row is later hard-deleted or arrives out of order during sync
// (Phase 2). Projection logic enforces referential integrity at apply time,
// not at insert time.
async function runMigration005(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS event_log (
        event_id                  TEXT PRIMARY KEY,
        event_type                TEXT NOT NULL,
        vault_id                  TEXT,
        target_id                 TEXT NOT NULL,
        relationship_id           TEXT,
        hlc_physical_ms           INTEGER NOT NULL,
        hlc_logical               INTEGER NOT NULL,
        hlc_device_id             TEXT    NOT NULL,
        device_id                 TEXT    NOT NULL,
        author_user_id_local_only TEXT NOT NULL,
        actor_account_id          TEXT,
        payload_json              TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_schema            INTEGER NOT NULL DEFAULT 1,
        appended_at               INTEGER NOT NULL,
        server_acked_at           INTEGER,
        rejected_at               INTEGER,
        origin                    TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','remote','backfill'))
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_target
        ON event_log(target_id, hlc_physical_ms, hlc_logical, hlc_device_id);

      CREATE INDEX IF NOT EXISTS idx_event_log_relationship
        ON event_log(relationship_id, hlc_physical_ms)
        WHERE relationship_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_event_log_unsynced
        ON event_log(appended_at)
        WHERE server_acked_at IS NULL AND rejected_at IS NULL;
    `);

    // ALTER TABLE ... ADD COLUMN is idempotent only via columnExists guard.
    // Migration 002 demonstrates the pattern; reuse it here.
    if (!(await columnExists(db, "entries", "current_event_id"))) {
      await db.execAsync(`ALTER TABLE entries ADD COLUMN current_event_id TEXT`);
    }
    if (!(await columnExists(db, "entries", "is_deleted"))) {
      await db.execAsync(`ALTER TABLE entries ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`);
    }
    if (!(await columnExists(db, "entries", "is_settled"))) {
      await db.execAsync(`ALTER TABLE entries ADD COLUMN is_settled INTEGER NOT NULL DEFAULT 0`);
    }

    // Backfill projection booleans from the existing legacy timestamp columns
    // so the cache is correct from day one — migration 006 then emits the
    // matching synthetic events.
    await db.runAsync(`UPDATE entries SET is_deleted = 1 WHERE deleted_at IS NOT NULL`);
    await db.runAsync(`UPDATE entries SET is_settled = 1 WHERE settled_at IS NOT NULL`);

    await db.runAsync(
      "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      MIGRATION_005,
      Date.now(),
    );
  });
}

// Migration 006: backfill synthetic events into event_log from existing entries.
//
// For every entry row that exists at the time of this migration, emit:
//   1. entry_created  at HLC (created_at, logical, install_id)
//   2. entry_amended  at HLC (updated_at, logical, install_id) — only if edited
//      (updated_at > created_at + 1000ms; the 1s threshold tolerates the
//      tiny jitter between INSERT and UPDATE in the legacy code path)
//   3. entry_deleted  at HLC (deleted_at, logical, install_id) — only if soft-deleted
//
// Logical counter assignment (cross-entry collision safe):
//   We bucket every emitted (physical_ms, kind) candidate by physical_ms and
//   then assign a strictly-increasing logical within each bucket using the
//   tuple (entry_id ASC, kind_priority ASC) as the deterministic order. This
//   way two entries created in the same millisecond don't collide on
//   (pms, l, did) — they get logical 0 and logical 1 respectively. The
//   intra-entry causal order (create < amend < delete) is preserved because
//   each step's physical_ms is monotonically increasing within an entry.
//
// Event IDs are deterministic UUIDv5 over (kind, entry_id, physical_ms), so
// re-running this migration on the same DB is a no-op (INSERT OR IGNORE).
//
// After events are inserted, projection cache column current_event_id is set
// to the latest synthetic event for that entry. is_deleted/is_settled were
// already set in migration 005 from the legacy timestamp columns.
//
// Brand-new installs with no entries: silent no-op (no events, no hlc_last seed).
async function runMigration006(db: SQLite.SQLiteDatabase, preInstallId?: string): Promise<void> {
  type EntryRow = {
    id: string;
    relationship_id: string;
    type: "debt" | "payment";
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
  };

  const rows = await db.getAllAsync<EntryRow>(`SELECT * FROM entries`);

  if (rows.length === 0) {
    // Fresh install — no entries to backfill. Record migration and return.
    // Crucially: do NOT seed hlc_last here. tickLocal on first real event
    // reads null and starts from epoch, which is correct. INSERT OR IGNORE
    // protects against a crash between the empty-no-op and the row commit:
    // on retry, this branch runs again and the IGNORE swallows the dup.
    await db.runAsync(
      `INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_006,
      Date.now(),
    );
    return;
  }

  // We have entries to backfill — install_id MUST be available. Prefer the
  // caller-provided id (passed by _layout.tsx via initDb), then fall back to
  // app_meta. If both are missing we throw — silently writing a zero-UUID
  // hlc.did permanently poisons HLC tiebreaks for these events and we'd
  // rather fail loudly on retry than ship corrupted history.
  let nodeId: string | null = preInstallId ?? null;
  if (!nodeId) {
    const installIdRow = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM app_meta WHERE key = 'install_id'`,
    );
    nodeId = installIdRow?.value ?? null;
  }
  if (!nodeId) {
    throw new Error(
      "migration 006: install_id missing — ensureInstallId() must run before initDb({installId})",
    );
  }

  // Author fallback: legacy entries created before proposed_by_user_id was
  // populated have NULL. Empty-string author would project to a non-FK-valid
  // users.id; fall back to the local-self user_id (every upgrader to v0.5
  // necessarily has one — they completed onboarding under v0.4).
  const localSelfRow = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  const localSelfUserId = localSelfRow?.id ?? null;

  // Compute per-physical_ms logical counters across ALL emitted events so two
  // entries that share a created_at don't collide on (pms, l, did). Order
  // within a bucket: (physical_ms, entry_id, kind_priority) ascending. Kind
  // priority enforces causal order for intra-entry collisions (create < amend
  // < delete).
  type Emit = {
    entryId: string;
    kind: "entry_created" | "entry_amended" | "entry_deleted";
    physical: number;
    kindPriority: 0 | 1 | 2;
  };
  const emissions: Emit[] = [];
  for (const r of rows) {
    emissions.push({
      entryId: r.id,
      kind: "entry_created",
      physical: r.created_at,
      kindPriority: 0,
    });
    if (r.updated_at > r.created_at + 1000) {
      emissions.push({
        entryId: r.id,
        kind: "entry_amended",
        physical: r.updated_at,
        kindPriority: 1,
      });
    }
    if (r.deleted_at !== null) {
      emissions.push({
        entryId: r.id,
        kind: "entry_deleted",
        physical: r.deleted_at,
        kindPriority: 2,
      });
    }
  }
  // Sort by (physical asc, entry_id asc, kindPriority asc) so logical
  // assignment is deterministic across migration re-runs.
  emissions.sort((a, b) => {
    if (a.physical !== b.physical) return a.physical - b.physical;
    if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
    return a.kindPriority - b.kindPriority;
  });
  // Walk the sorted list and assign logical = bucket-relative position.
  const logicalByKey = new Map<string, number>();
  let currentBucketPms = -1;
  let currentLogical = 0;
  for (const e of emissions) {
    if (e.physical !== currentBucketPms) {
      currentBucketPms = e.physical;
      currentLogical = 0;
    }
    logicalByKey.set(`${e.entryId}|${e.kind}`, currentLogical);
    currentLogical++;
  }

  await db.withTransactionAsync(async () => {
    for (const r of rows) {
      const author = r.proposed_by_user_id ?? localSelfUserId ?? "";

      // ---- 1. entry_created ----
      const createPhysical = r.created_at;
      const createLogical = logicalByKey.get(`${r.id}|entry_created`) ?? 0;
      const createEventId = uuidv5(
        KAATA_UUID_NAMESPACE,
        `backfill|entry_created|${r.id}|${createPhysical}`,
      );
      const createPayload = {
        entry_id: r.id,
        relationship_id: r.relationship_id,
        type: r.type,
        amount_afn: r.amount_afn,
        note: r.note,
        // occurred_at_ms is required on the entry_created payload type; use
        // created_at as the proxy (matches the v0.4 schema semantics).
        occurred_at_ms: r.created_at,
        // Carry the pre-existing accepted/disputed/settled flags into the
        // create payload so a future replay rebuilds full state from events
        // alone. The applier reads these on create — they're not lost on
        // wipe-and-replay (the central replay-test invariant).
        backfill_synthetic: true as const,
        backfill_accepted_at: r.accepted_at,
        backfill_disputed_at: r.disputed_at,
        backfill_disputed_reason: r.disputed_reason,
        backfill_settled_at: r.settled_at,
      };

      await db.runAsync(
        `INSERT OR IGNORE INTO event_log (
           event_id, event_type, vault_id, target_id, relationship_id,
           hlc_physical_ms, hlc_logical, hlc_device_id,
           device_id, author_user_id_local_only, actor_account_id,
           payload_json, payload_schema,
           appended_at, server_acked_at, rejected_at, origin
         ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?)`,
        createEventId,
        "entry_created",
        null,
        r.id,
        r.relationship_id,
        createPhysical,
        createLogical,
        nodeId,
        nodeId,
        author,
        null,
        JSON.stringify(createPayload),
        1,
        Date.now(),
        null,
        null,
        "backfill",
      );

      let latestEventId = createEventId;

      // ---- 2. entry_amended (only if meaningfully edited) ----
      if (r.updated_at > r.created_at + 1000) {
        const amendPhysical = r.updated_at;
        const amendLogical = logicalByKey.get(`${r.id}|entry_amended`) ?? 0;
        const amendEventId = uuidv5(
          KAATA_UUID_NAMESPACE,
          `backfill|entry_amended|${r.id}|${amendPhysical}`,
        );
        const amendPayload = {
          // We don't know what actually changed pre-migration — only the
          // current snapshot. Record current values as the post-amend state.
          changes: {
            amount_afn: r.amount_afn,
            note: r.note,
          },
          backfill_synthetic: true,
        };

        await db.runAsync(
          `INSERT OR IGNORE INTO event_log (
             event_id, event_type, vault_id, target_id, relationship_id,
             hlc_physical_ms, hlc_logical, hlc_device_id,
             device_id, author_user_id_local_only, actor_account_id,
             payload_json, payload_schema,
             appended_at, server_acked_at, rejected_at, origin
           ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?)`,
          amendEventId,
          "entry_amended",
          null,
          r.id,
          r.relationship_id,
          amendPhysical,
          amendLogical,
          nodeId,
          nodeId,
          author,
          null,
          JSON.stringify(amendPayload),
          1,
          Date.now(),
          null,
          null,
          "backfill",
        );

        latestEventId = amendEventId;
      }

      // ---- 3. entry_deleted (only if soft-deleted) ----
      if (r.deleted_at !== null) {
        const deletePhysical = r.deleted_at;
        const deleteLogical = logicalByKey.get(`${r.id}|entry_deleted`) ?? 0;
        const deleteEventId = uuidv5(
          KAATA_UUID_NAMESPACE,
          `backfill|entry_deleted|${r.id}|${deletePhysical}`,
        );
        const deletePayload = {
          backfill_synthetic: true,
        };

        await db.runAsync(
          `INSERT OR IGNORE INTO event_log (
             event_id, event_type, vault_id, target_id, relationship_id,
             hlc_physical_ms, hlc_logical, hlc_device_id,
             device_id, author_user_id_local_only, actor_account_id,
             payload_json, payload_schema,
             appended_at, server_acked_at, rejected_at, origin
           ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?)`,
          deleteEventId,
          "entry_deleted",
          null,
          r.id,
          r.relationship_id,
          deletePhysical,
          deleteLogical,
          nodeId,
          nodeId,
          author,
          null,
          JSON.stringify(deletePayload),
          1,
          Date.now(),
          null,
          null,
          "backfill",
        );

        latestEventId = deleteEventId;
      }

      // ---- Projection cache update ----
      // Point the entry at its latest synthetic event. is_deleted/is_settled
      // were set by migration 005 from the legacy timestamp columns.
      await db.runAsync(
        `UPDATE entries SET current_event_id = ? WHERE id = ?`,
        latestEventId,
        r.id,
      );
    }

    // Advance the HLC cursor to the max synthetic HLC we just emitted so the
    // next real event (post-migration) is guaranteed to sort after backfill.
    let maxPhysical = 0;
    let maxLogical = 0;
    for (const e of emissions) {
      const l = logicalByKey.get(`${e.entryId}|${e.kind}`) ?? 0;
      if (e.physical > maxPhysical || (e.physical === maxPhysical && l > maxLogical)) {
        maxPhysical = e.physical;
        maxLogical = l;
      }
    }
    await setAppMetaInTx(
      db,
      "hlc_last",
      serializeHLC({ pms: maxPhysical, l: maxLogical, did: nodeId }),
    );

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_006,
      Date.now(),
    );
  });
}

// Migration 007: Phase 2 — vaults, account binding, and per-vault scoping.
//
// This is the canonical Phase 2 schema move. ATOMIC: every DDL + backfill step
// runs inside a single withTransactionAsync block. On failure the entire
// migration rolls back and the next initDb() retries cleanly.
//
// What it does (in order):
//   1.  Create the multi-vault scaffolding: vaults + vault_members_mirror.
//   2.  Extend users with google_sub + account_id (Phase 2 auth binding).
//       Drop the global UNIQUE on users.phone_e164 — Phase 2 enforces phone
//       uniqueness per-vault in app code, not at the DB level. Dropping a
//       SQLite UNIQUE requires a table rewrite; we do it here.
//   3.  Add vault_id (nullable) to entries and relationships.
//   4.  Rebuild shop_profile so it's keyed by vault_id, not the fixed id=1
//       singleton row.
//   5.  Backfill: mint ONE default vault (UUIDv4), populate vault_id on every
//       existing entries / relationships / event_log row, and the rebuilt
//       shop_profile row. Write the default vault id to app_meta as both
//       active_vault_id and default_vault_id.
//   6.  Rewrite entries + relationships with vault_id NOT NULL + FK to
//       vaults(id). Done last so backfill in (5) had a nullable column to
//       populate first.
//   7.  Create Phase 2 indexes for the new vault-scoped read paths.
//
// PRAGMA defer_foreign_keys = ON defers FK checks until COMMIT, which is
// exactly what we need for multi-table rewrites in one tx. It resets at
// end-of-tx automatically.
//
// Edge cases:
//   - Brand-new install (no users, no shop_profile): SKIP minting a default
//     vault. The new tables exist with no rows; first sign-in / onboarding
//     mints the vault later.
//   - Mid-onboarding (local_self exists, no shop_profile): mint default vault
//     named "My ledger"; rebuild shop_profile with that name.
//   - Full upgrader (shop_profile row exists): vault inherits shop_name.
async function runMigration007(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    try {
      await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    } catch (err) {
      console.error('[mig007:step-0] failed at "PRAGMA defer_foreign_keys = ON":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 0.5. Defensive: drop any stale rewrite-helper tables from a prior
    // FAILED attempt of this migration. expo-sqlite rolls back DDL on
    // throw, but on a device that ran a partial migration before crashing
    // (e.g. OOM, app force-quit mid-flight) the rollback may not have
    // restored the schema cleanly; the next launch would then hit
    // "table _new already exists" or — worse — a leftover _old_shop_profile
    // whose FK to the recreated users table is in a dangling state and
    // surfaces only at COMMIT as a generic "FOREIGN KEY constraint failed".
    // Dropping them up-front guarantees a clean working set.
    // ------------------------------------------------------------------
    try {
      await db.execAsync(`
        DROP TABLE IF EXISTS users_new;
        DROP TABLE IF EXISTS relationships_new;
        DROP TABLE IF EXISTS entries_new;
        DROP TABLE IF EXISTS _old_shop_profile;
      `);
    } catch (err) {
      console.error('[mig007:step-0.5] failed at "drop stale rewrite-helper tables":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 1. New tables: vaults + vault_members_mirror
    // ------------------------------------------------------------------
    try {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS vaults (
          id                          TEXT PRIMARY KEY,
          name                        TEXT NOT NULL,
          currency                    TEXT NOT NULL DEFAULT 'AFN',
          created_at                  INTEGER NOT NULL,
          updated_at                  INTEGER NOT NULL,
          archived_at                 INTEGER,
          is_default                  INTEGER NOT NULL DEFAULT 0,
          account_id                  TEXT,
          registered_with_server_at   INTEGER,
          vault_epoch                 INTEGER NOT NULL DEFAULT 0,
          hlc_logical                 INTEGER NOT NULL DEFAULT 0,
          hlc_wall_ms                 INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS vault_members_mirror (
          vault_id    TEXT NOT NULL REFERENCES vaults(id),
          account_id  TEXT NOT NULL,
          role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
          accepted_at INTEGER,
          revoked_at  INTEGER,
          PRIMARY KEY (vault_id, account_id)
        );
      `);
    } catch (err) {
      console.error(
        '[mig007:step-1] failed at "vaults + vault_members_mirror table creation":',
        err,
      );
      throw err;
    }

    // ------------------------------------------------------------------
    // 2. users: add google_sub + account_id, drop UNIQUE(phone_e164).
    // ------------------------------------------------------------------
    type UserRow = {
      id: string;
      phone_e164: string | null;
      display_name: string;
      is_local_self: number;
      created_at: number;
      updated_at: number;
      archived_at: number | null;
    };
    let userRows: UserRow[];
    try {
      userRows = await db.getAllAsync<UserRow>(
        `SELECT id, phone_e164, display_name, is_local_self, created_at, updated_at, archived_at
         FROM users`,
      );
    } catch (err) {
      console.error('[mig007:step-2a] failed at "SELECT existing users rows":', err);
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE TABLE users_new (
          id            TEXT PRIMARY KEY,
          phone_e164    TEXT,
          display_name  TEXT NOT NULL,
          is_local_self INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          archived_at   INTEGER,
          google_sub    TEXT,
          account_id    TEXT
        );
      `);
    } catch (err) {
      console.error('[mig007:step-2b] failed at "CREATE TABLE users_new":', err);
      throw err;
    }
    try {
      for (const u of userRows) {
        await db.runAsync(
          `INSERT INTO users_new
             (id, phone_e164, display_name, is_local_self, created_at, updated_at, archived_at, google_sub, account_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          u.id,
          u.phone_e164,
          u.display_name,
          u.is_local_self,
          u.created_at,
          u.updated_at,
          u.archived_at,
        );
      }
    } catch (err) {
      console.error('[mig007:step-2c] failed at "INSERT INTO users_new from old users rows":', err);
      throw err;
    }

    try {
      await db.execAsync(`DROP TABLE users;`);
    } catch (err) {
      console.error('[mig007:step-2d] failed at "DROP TABLE users":', err);
      throw err;
    }
    try {
      await db.execAsync(`ALTER TABLE users_new RENAME TO users;`);
    } catch (err) {
      console.error('[mig007:step-2e] failed at "ALTER TABLE users_new RENAME TO users":', err);
      throw err;
    }

    // Re-create the partial index on phone_e164. The global UNIQUE is gone —
    // per-vault uniqueness lives in app code (createPerson/updatePerson).
    try {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_users_phone
          ON users(phone_e164) WHERE phone_e164 IS NOT NULL;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
          ON users(google_sub) WHERE google_sub IS NOT NULL;
      `);
    } catch (err) {
      console.error('[mig007:step-2f] failed at "recreate users indexes":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 3. entries + relationships: add nullable vault_id (will be made
    //    NOT NULL after backfill in step 6).
    // ------------------------------------------------------------------
    try {
      if (!(await columnExists(db, "entries", "vault_id"))) {
        await db.execAsync(`ALTER TABLE entries ADD COLUMN vault_id TEXT`);
      }
    } catch (err) {
      console.error('[mig007:step-3a] failed at "ALTER TABLE entries ADD COLUMN vault_id":', err);
      throw err;
    }
    try {
      if (!(await columnExists(db, "relationships", "vault_id"))) {
        await db.execAsync(`ALTER TABLE relationships ADD COLUMN vault_id TEXT`);
      }
    } catch (err) {
      console.error(
        '[mig007:step-3b] failed at "ALTER TABLE relationships ADD COLUMN vault_id":',
        err,
      );
      throw err;
    }

    // ------------------------------------------------------------------
    // 4. shop_profile rebuild: harvest old row, DROP old, create new keyed
    // by vault_id.
    //
    // Crucial: we DROP the old shop_profile (rather than rename to
    // _old_shop_profile and defer the drop) because the v1 shop_profile
    // schema has `user_id NOT NULL REFERENCES users(id)`. With users dropped
    // and re-renamed in step 2, that FK in a renamed _old_shop_profile is
    // in a dangling state until the table is dropped — and on some
    // SQLite builds the deferred FK pass at COMMIT can surface as a generic
    // "FOREIGN KEY constraint failed" with no row info. Harvesting + dropping
    // in one go sidesteps the issue entirely; we no longer need the
    // _old_shop_profile rename at all.
    // ------------------------------------------------------------------
    type OldShopProfileRow = {
      user_id: string;
      shop_name: string;
      owner_name: string | null;
      created_at: number;
      updated_at: number;
    };
    let oldShopProfile: OldShopProfileRow | null = null;
    try {
      if (await tableExists(db, "shop_profile")) {
        oldShopProfile =
          (await db.getFirstAsync<OldShopProfileRow>(
            `SELECT user_id, shop_name, owner_name, created_at, updated_at
             FROM shop_profile WHERE id = 1`,
          )) ?? null;
        await db.execAsync(`DROP TABLE shop_profile;`);
      }
    } catch (err) {
      console.error('[mig007:step-4a] failed at "harvest + drop old shop_profile":', err);
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE TABLE shop_profile (
          vault_id    TEXT PRIMARY KEY REFERENCES vaults(id),
          owner_name  TEXT,
          shop_name   TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `);
    } catch (err) {
      console.error('[mig007:step-4b] failed at "CREATE new shop_profile (vault-keyed)":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 5. Default vault provisioning + backfill of vault_id everywhere.
    // ------------------------------------------------------------------
    //
    // Mint a default vault iff this install has ledger state (any users
    // row OR an old shop_profile). Brand-new installs skip — onboarding
    // / first sign-in mints later.
    let anyUserRow: { id: string } | null;
    try {
      anyUserRow = await db.getFirstAsync<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    } catch (err) {
      console.error('[mig007:step-5a] failed at "SELECT id FROM users LIMIT 1 (mint check)":', err);
      throw err;
    }
    const shouldMintDefaultVault = anyUserRow !== null || oldShopProfile !== null;

    if (shouldMintDefaultVault) {
      const now = Date.now();
      const defaultVaultId = Crypto.randomUUID();
      const vaultName = oldShopProfile?.shop_name?.trim() || "My ledger";

      try {
        await db.runAsync(
          `INSERT INTO vaults
             (id, name, currency, created_at, updated_at, archived_at,
              is_default, account_id, registered_with_server_at,
              vault_epoch, hlc_logical, hlc_wall_ms)
           VALUES (?, ?, 'AFN', ?, ?, NULL, 1, NULL, NULL, 0, 0, 0)`,
          defaultVaultId,
          vaultName,
          now,
          now,
        );
      } catch (err) {
        console.error('[mig007:step-5b] failed at "INSERT default vault row":', err);
        throw err;
      }

      const spShopName = oldShopProfile?.shop_name?.trim() || vaultName;
      const spOwnerName = oldShopProfile?.owner_name ?? null;
      const spCreatedAt = oldShopProfile?.created_at ?? now;
      const spUpdatedAt = oldShopProfile?.updated_at ?? now;

      try {
        await db.runAsync(
          `INSERT INTO shop_profile
             (vault_id, owner_name, shop_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          defaultVaultId,
          spOwnerName,
          spShopName,
          spCreatedAt,
          spUpdatedAt,
        );
      } catch (err) {
        console.error('[mig007:step-5c] failed at "INSERT shop_profile (vault-keyed)":', err);
        throw err;
      }

      // Backfill vault_id on every existing row across the three tables
      // that gained the column. All existing ledger state belongs to the
      // default vault by definition.
      try {
        await db.runAsync(`UPDATE entries SET vault_id = ? WHERE vault_id IS NULL`, defaultVaultId);
      } catch (err) {
        console.error('[mig007:step-5d] failed at "UPDATE entries SET vault_id":', err);
        throw err;
      }
      try {
        await db.runAsync(
          `UPDATE relationships SET vault_id = ? WHERE vault_id IS NULL`,
          defaultVaultId,
        );
      } catch (err) {
        console.error('[mig007:step-5e] failed at "UPDATE relationships SET vault_id":', err);
        throw err;
      }
      try {
        await db.runAsync(
          `UPDATE event_log SET vault_id = ? WHERE vault_id IS NULL`,
          defaultVaultId,
        );
      } catch (err) {
        console.error('[mig007:step-5f] failed at "UPDATE event_log SET vault_id":', err);
        throw err;
      }
      // Defensive: enforce that NO event_log row escapes this migration with a
      // null vault_id. Without this, a future bug producing an event with
      // vault_id=null would silently land — and Phase 3 forward-sync would
      // reject it for that vault attribution gap. We don't add a CHECK
      // constraint on event_log itself (SQLite can't ALTER existing tables
      // to add CHECKs without a full rewrite, and event_log is large); the
      // post-backfill verification below catches drift at migration time and
      // every append helper is fixed in lib/event-log.ts to stamp the active
      // vault.
      let stragglerRow: { n: number } | null;
      try {
        stragglerRow = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM event_log WHERE vault_id IS NULL`,
        );
      } catch (err) {
        console.error(
          '[mig007:step-5g] failed at "verify event_log straggler vault_id=NULL count":',
          err,
        );
        throw err;
      }
      if ((stragglerRow?.n ?? 0) > 0) {
        throw new Error(
          `migration 007: ${stragglerRow?.n} event_log rows remain with vault_id IS NULL after backfill`,
        );
      }

      // Stamp app_meta with active + default vault.
      try {
        await setAppMetaInTx(db, "active_vault_id", defaultVaultId);
        await setAppMetaInTx(db, "default_vault_id", defaultVaultId);
      } catch (err) {
        console.error(
          '[mig007:step-5h] failed at "stamp app_meta active_vault_id / default_vault_id":',
          err,
        );
        throw err;
      }
    }

    // step 5i removed: _old_shop_profile no longer exists at this point —
    // step 4a now drops the old shop_profile directly after harvesting its
    // single row, so there is no rename-and-defer phase. Kept as a comment
    // so the step numbering with the inline log labels stays legible.
    // Defensive: tolerate stragglers from a prior installed-but-pre-fix
    // version of the app whose step 4a renamed (rather than dropped).
    try {
      if (await tableExists(db, "_old_shop_profile")) {
        await db.execAsync(`DROP TABLE _old_shop_profile;`);
      }
    } catch (err) {
      console.error('[mig007:step-5i] failed at "DROP TABLE _old_shop_profile":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 6. Rewrite entries + relationships to enforce vault_id NOT NULL
    //    with FK to vaults(id).
    // ------------------------------------------------------------------

    // ---- relationships ----
    type RelationshipRow = {
      id: string;
      user_a_id: string;
      user_b_id: string;
      context: string;
      created_at: number;
      updated_at: number;
      archived_at: number | null;
      vault_id: string | null;
    };
    let relRows: RelationshipRow[];
    try {
      relRows = await db.getAllAsync<RelationshipRow>(
        `SELECT id, user_a_id, user_b_id, context, created_at, updated_at, archived_at, vault_id
         FROM relationships`,
      );
    } catch (err) {
      console.error('[mig007:step-6a] failed at "SELECT existing relationships rows":', err);
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE TABLE relationships_new (
          id          TEXT PRIMARY KEY,
          vault_id    TEXT NOT NULL REFERENCES vaults(id),
          user_a_id   TEXT NOT NULL REFERENCES users(id),
          user_b_id   TEXT NOT NULL REFERENCES users(id),
          context     TEXT NOT NULL DEFAULT 'peer' CHECK (context IN ('customer','supplier','peer')),
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          archived_at INTEGER,
          UNIQUE (vault_id, user_a_id, user_b_id, context)
        );
      `);
    } catch (err) {
      console.error('[mig007:step-6b] failed at "CREATE TABLE relationships_new":', err);
      throw err;
    }
    try {
      for (const r of relRows) {
        if (r.vault_id == null) {
          // Defensive: this should be impossible — every row with relationships
          // is from an install that minted a default vault in step 5. Bail loudly
          // rather than silently corrupting via empty string.
          throw new Error(
            `migration 007: relationships row ${r.id} has no vault_id after backfill`,
          );
        }
        await db.runAsync(
          `INSERT INTO relationships_new
             (id, vault_id, user_a_id, user_b_id, context, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          r.id,
          r.vault_id,
          r.user_a_id,
          r.user_b_id,
          r.context,
          r.created_at,
          r.updated_at,
          r.archived_at,
        );
      }
    } catch (err) {
      console.error(
        '[mig007:step-6c] failed at "INSERT INTO relationships_new from old rows":',
        err,
      );
      throw err;
    }
    try {
      await db.execAsync(`DROP TABLE relationships;`);
    } catch (err) {
      console.error('[mig007:step-6d] failed at "DROP TABLE relationships":', err);
      throw err;
    }
    try {
      await db.execAsync(`ALTER TABLE relationships_new RENAME TO relationships;`);
    } catch (err) {
      console.error(
        '[mig007:step-6e] failed at "ALTER TABLE relationships_new RENAME TO relationships":',
        err,
      );
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_relationships_a
          ON relationships(user_a_id) WHERE archived_at IS NULL;
      `);
    } catch (err) {
      console.error('[mig007:step-6f] failed at "CREATE INDEX idx_relationships_a":', err);
      throw err;
    }

    // ---- entries ----
    type EntryRow = {
      id: string;
      relationship_id: string;
      type: "debt" | "payment";
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
      current_event_id: string | null;
      is_deleted: number;
      is_settled: number;
      vault_id: string | null;
    };
    let entryRows: EntryRow[];
    try {
      entryRows = await db.getAllAsync<EntryRow>(
        `SELECT id, relationship_id, type, amount_afn, note,
                created_at, updated_at, deleted_at, proposed_by_user_id,
                accepted_at, disputed_at, disputed_reason, settled_at,
                current_event_id, is_deleted, is_settled, vault_id
         FROM entries`,
      );
    } catch (err) {
      console.error('[mig007:step-7a] failed at "SELECT existing entries rows":', err);
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE TABLE entries_new (
          id                   TEXT PRIMARY KEY,
          vault_id             TEXT NOT NULL REFERENCES vaults(id),
          relationship_id      TEXT NOT NULL REFERENCES relationships(id),
          type                 TEXT NOT NULL CHECK (type IN ('debt','payment')),
          amount_afn           INTEGER NOT NULL,
          note                 TEXT,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL,
          deleted_at           INTEGER,
          proposed_by_user_id  TEXT REFERENCES users(id),
          accepted_at          INTEGER,
          disputed_at          INTEGER,
          disputed_reason      TEXT,
          settled_at           INTEGER,
          current_event_id     TEXT,
          is_deleted           INTEGER NOT NULL DEFAULT 0,
          is_settled           INTEGER NOT NULL DEFAULT 0
        );
      `);
    } catch (err) {
      console.error('[mig007:step-7b] failed at "CREATE TABLE entries_new":', err);
      throw err;
    }
    try {
      for (const e of entryRows) {
        if (e.vault_id == null) {
          throw new Error(`migration 007: entries row ${e.id} has no vault_id after backfill`);
        }
        await db.runAsync(
          `INSERT INTO entries_new
             (id, vault_id, relationship_id, type, amount_afn, note,
              created_at, updated_at, deleted_at, proposed_by_user_id,
              accepted_at, disputed_at, disputed_reason, settled_at,
              current_event_id, is_deleted, is_settled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          e.accepted_at,
          e.disputed_at,
          e.disputed_reason,
          e.settled_at,
          e.current_event_id,
          e.is_deleted,
          e.is_settled,
        );
      }
    } catch (err) {
      console.error('[mig007:step-7c] failed at "INSERT INTO entries_new from old rows":', err);
      throw err;
    }
    try {
      await db.execAsync(`DROP TABLE entries;`);
    } catch (err) {
      console.error('[mig007:step-7d] failed at "DROP TABLE entries":', err);
      throw err;
    }
    try {
      await db.execAsync(`ALTER TABLE entries_new RENAME TO entries;`);
    } catch (err) {
      console.error('[mig007:step-7e] failed at "ALTER TABLE entries_new RENAME TO entries":', err);
      throw err;
    }

    try {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_entries_relationship
          ON entries(relationship_id) WHERE deleted_at IS NULL;
      `);
    } catch (err) {
      console.error('[mig007:step-7f] failed at "CREATE INDEX idx_entries_relationship":', err);
      throw err;
    }

    // ------------------------------------------------------------------
    // 8. Phase 2 vault-scoped indexes.
    // ------------------------------------------------------------------
    try {
      await db.execAsync(`
        CREATE INDEX IF NOT EXISTS idx_entries_vault_created
          ON entries(vault_id, created_at DESC) WHERE deleted_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_relationships_vault
          ON relationships(vault_id, archived_at) WHERE archived_at IS NULL;

        CREATE INDEX IF NOT EXISTS idx_vaults_active
          ON vaults(archived_at) WHERE archived_at IS NULL;
      `);
    } catch (err) {
      console.error('[mig007:step-8] failed at "Phase 2 vault-scoped indexes":', err);
      throw err;
    }

    // Step 8.5: Pre-commit FK integrity check.
    //
    // Migration 007 runs with PRAGMA defer_foreign_keys = ON, which postpones
    // every FK constraint to COMMIT. If any of the table rewrites in steps 2,
    // 6, 7 (or the backfill in step 5) left a row with an FK pointing at a
    // non-existent parent, the violation surfaces only at the implicit COMMIT
    // at the end of `withTransactionAsync` — outside the try/catch blocks
    // above, so we'd just see a bare "FOREIGN KEY constraint failed" against
    // execAsync with no row info.
    //
    // PRAGMA foreign_key_check returns one row per violation: (table, rowid,
    // parent, fkid). Running it BEFORE the schema_migrations INSERT means a
    // violation throws explicitly here with the actionable table/rowid, and
    // the tx rolls back cleanly. On a healthy migration this is a single
    // O(rows) scan over the (mostly empty) child tables.
    try {
      const fkViolations = await db.getAllAsync<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>(`PRAGMA foreign_key_check;`);
      if (fkViolations.length > 0) {
        console.error(
          "[mig007:step-8.5] foreign_key_check found violations:",
          JSON.stringify(fkViolations),
        );
        throw new Error(
          `migration 007: foreign_key_check found ${fkViolations.length} violation(s): ${JSON.stringify(fkViolations)}`,
        );
      }
    } catch (err) {
      console.error('[mig007:step-8.5] failed at "PRAGMA foreign_key_check":', err);
      throw err;
    }

    try {
      await db.runAsync(
        `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
        MIGRATION_007,
        Date.now(),
      );
    } catch (err) {
      console.error('[mig007:step-9] failed at "INSERT INTO schema_migrations":', err);
      throw err;
    }
  });
}

// Migration 008: per-vault sync cursor + projection conflict ledger (Phase 3).
//
// Two new tables, both pure additions — no rewrites of event_log, entries,
// relationships, users, shop_profile, or vaults. Phase 1's event_log already
// has target_id from day one, no CHECK on event_type (validated in app code
// via isKnownEventType), and no supersedes_event_id column (per-field LWW by
// HLC handles ordering at apply time). Phase 3 does not need to touch
// event_log.
//
//   sync_state
//     One row per vault. Tracks the high-water mark of server_seq pulled from
//     the backend (last_pulled_server_seq), plus loose observability fields
//     (last_pull_at, last_push_at, last_error, last_error_at). The cursor is
//     advanced exclusively by lib/sync/pull.ts after applying a batch.
//     ON DELETE CASCADE off vaults(id): if a vault is hard-deleted locally
//     (only happens in dev reset today), its sync cursor goes with it.
//
//   projection_conflicts
//     Append-only diagnostic log of cases where push surfaced a server-side
//     rejection. detail_json is opaque to the schema; the sync worker logs
//     { kind, event_id, reason, detail } and similar shapes per kind.
//     resolved_at is nullable + currently unused — a Phase 4 admin UI may
//     stamp it when a human acknowledges the conflict; until then every row
//     is "open".
async function runMigration008(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Defensive: defer FK checks to COMMIT. CREATE TABLE statements with
    // REFERENCES don't normally trigger row-level checks, but a few SQLite
    // builds surface generic FK errors at COMMIT when a child table is
    // created whose parent was rewritten in the immediately-preceding
    // transaction (mig 007). Setting this here costs nothing on a healthy
    // run and keeps clean-DB boots from hitting "FOREIGN KEY constraint
    // failed" on the implicit COMMIT.
    await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sync_state (
        vault_id                TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
        last_pulled_server_seq  INTEGER NOT NULL DEFAULT 0,
        last_pull_at            INTEGER,
        last_push_at            INTEGER,
        last_error              TEXT,
        last_error_at           INTEGER,
        updated_at              INTEGER
      );

      CREATE TABLE IF NOT EXISTS projection_conflicts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        vault_id     TEXT,
        detail_json  TEXT NOT NULL CHECK (json_valid(detail_json)),
        created_at   INTEGER NOT NULL,
        resolved_at  INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_projection_conflicts_open
        ON projection_conflicts(created_at DESC)
        WHERE resolved_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_projection_conflicts_vault
        ON projection_conflicts(vault_id, created_at DESC)
        WHERE vault_id IS NOT NULL;
    `);

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_008,
      Date.now(),
    );
  });
}

// Migration 009: Phase 4 — pending_invitations cache, vault_settings table,
// and field_hlcs sidecar columns on entries / users / shop_profile.
//
// pending_invitations: cache of GET /v1/vaults/invites/pending so the
// invite-list screen + ProfileSettingsSheet-side badges render
// without a network roundtrip. The scheduler refreshes this opportunistically;
// the server remains the source of truth at accept-time.
//
// vault_settings: per-(vault_id, key) settings with per-key LWW HLC. Phase 4
// introduces vault_setting_set events carrying arbitrary (key, value) pairs
// scoped to a vault. Stored separately from app_meta because (a) app_meta is
// install-scoped while vault settings are vault-scoped and must sync across
// devices of every member, (b) per-key HLC lets the applier reject stale
// incoming events without an event_log join.
//
// field_hlcs: JSON sidecar column on mutable-field entities. The applier
// reads this column, compares each incoming field's event HLC against the
// stored field HLC via compareHLC, and only applies fields whose event is
// strictly greater. The same JSON is then re-written in the same UPDATE.
// NULL means "never written" → treated as FIELD_HLC_INIT by readers. No
// row-level backfill written: parseFieldHLCs(null) === {} which readFieldHLC
// resolves to the floor, so the first real amend on any backfilled row will
// always be applied.
async function runMigration009(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Defensive: defer FK checks to COMMIT (same rationale as mig 008).
    await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    // pending_invitations cache.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS pending_invitations (
        token             TEXT PRIMARY KEY,
        vault_id          TEXT NOT NULL,
        vault_name        TEXT NOT NULL,
        invited_by_email  TEXT,
        invited_by_name   TEXT,
        role              TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
        invite_email      TEXT NOT NULL,
        invited_at        INTEGER NOT NULL,
        expires_at        INTEGER NOT NULL,
        surfaced_at       INTEGER,
        declined_at       INTEGER,
        accepted_at       INTEGER,
        revoked_at        INTEGER,
        fetched_at        INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pending_invitations_active
        ON pending_invitations (expires_at)
        WHERE declined_at IS NULL AND accepted_at IS NULL AND revoked_at IS NULL;
    `);

    // vault_settings: per-key LWW HLC.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS vault_settings (
        vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        hlc_pms     INTEGER NOT NULL,
        hlc_l       INTEGER NOT NULL,
        hlc_did     TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (vault_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_vault_settings_vault
        ON vault_settings (vault_id);
    `);

    // field_hlcs sidecar columns. Each is nullable; parseFieldHLCs(null)
    // returns {} which readFieldHLC resolves to FIELD_HLC_INIT — strictly
    // less than every real HLC, so the first real amend always lands.
    if (!(await columnExists(db, "entries", "field_hlcs"))) {
      await db.execAsync(`
        ALTER TABLE entries ADD COLUMN field_hlcs TEXT
          CHECK (field_hlcs IS NULL OR json_valid(field_hlcs))
      `);
    }
    if (!(await columnExists(db, "shop_profile", "field_hlcs"))) {
      await db.execAsync(`
        ALTER TABLE shop_profile ADD COLUMN field_hlcs TEXT
          CHECK (field_hlcs IS NULL OR json_valid(field_hlcs))
      `);
    }
    if (!(await columnExists(db, "users", "field_hlcs"))) {
      await db.execAsync(`
        ALTER TABLE users ADD COLUMN field_hlcs TEXT
          CHECK (field_hlcs IS NULL OR json_valid(field_hlcs))
      `);
    }

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_009,
      Date.now(),
    );
  });
}

// Migration 010: composite event_log index for high-churn vault membership
// lookups (Phase 4.1 caveat closure).
//
// The Phase 4 baseline idx_event_log_target (target_id, hlc...) is sufficient
// at expected scale, but per-field LWW lookups that scan event_log filtered by
// (vault_id, event_type, target_id) — most prominently the entry_amended /
// shop_profile_updated appliers and the vault_member_* projection paths added
// in Phase 4.1 — degrade to a target_id index scan + filter as vault
// membership churn accumulates. This composite covers (vault_id, event_type,
// target_id) for the equality predicate and orders the trailing HLC tuple so
// the planner can satisfy ORDER BY (hlc_physical_ms, hlc_logical,
// hlc_device_id) DESC from the index alone — no sort step, no row visits for
// the LWW pick.
//
// ENG #12: HLC columns are indexed DESC. SQLite's query planner can walk
// an index in either direction for a single-column ORDER BY but only
// matches multi-column DESC orderings against indexes whose column
// directions match. The LWW queries we serve are uniformly ORDER BY
// hlc_physical_ms DESC, hlc_logical DESC, hlc_device_id DESC — so the
// index columns are declared DESC to let the planner skip the sort step
// entirely. Equality columns (vault_id, event_type, target_id) ignore
// direction so we leave them implicit (ASC).
//
// Partial WHERE rejected_at IS NULL: rejected events are never the LWW
// winner, so excluding them keeps the index small on installs that
// accumulate permission-rejected pulls.
//
// Purely additive — no behavior change. Re-running migration 010 is a no-op
// via CREATE INDEX IF NOT EXISTS; the schema_migrations row guard makes the
// run-once dispatch in initDb() short-circuit on the second launch.
async function runMigration010(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_event_log_vault_type_target
        ON event_log(
          vault_id,
          event_type,
          target_id,
          hlc_physical_ms DESC,
          hlc_logical DESC,
          hlc_device_id DESC
        )
        WHERE rejected_at IS NULL;
    `);

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_010,
      Date.now(),
    );
  });
}

// Migration 011: Phase 5 mesh credentials.
//
// Introduces two tables required for peer-to-peer mesh sync over WebRTC:
//
//   vault_credentials — Cache of server-signed Vault Membership Credentials
//     (VMCs) for this device. A VMC is a compact Ed25519-signed token that
//     proves "device D, owned by account A, has role R in vault V at epoch E,
//     valid until T". Two phones meeting in the same shop complete a mesh
//     handshake offline by exchanging and verifying each other's VMCs
//     against the pinned server pubkey (see app_meta keys above).
//     Refreshed via POST /v1/vaults/:vault_id/credential and on /v1/check-in
//     piggy-back (vmc_renewals). 60-day lifetime; expiry triggers refresh
//     on the next online check-in.
//
//   revocation_list — Tombstones for VMCs the server has revoked (device
//     unlinked, member revoked, role downgraded). Populated from
//     /v1/check-in response (revocations[]). Consulted during mesh handshake;
//     a peer presenting a revoked VMC is rejected. Sticky: rows are never
//     deleted, only added.
//
// The current vault_epoch is stored on vaults(vault_epoch) (mig 007). A VMC
// whose vault_epoch < vaults.vault_epoch is treated as stale by the
// handshake and forces a refresh.
//
// Purely additive — no rewrites, no backfill. Safe on fresh installs and
// upgraders alike; mesh stays dormant until shop_mode_enabled is flipped on.
async function runMigration011(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Defensive: defer FK checks to COMMIT (same rationale as mig 008).
    // vault_credentials / revocation_list have no FKs, but the PRAGMA is
    // a per-tx setting that resets at COMMIT, so setting it costs nothing
    // and keeps the migration set uniform.
    await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS vault_credentials (
        vault_id      TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        device_id     TEXT NOT NULL,
        device_pubkey TEXT NOT NULL,
        vmc_blob      TEXT NOT NULL,
        issued_at     INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        vault_epoch   INTEGER NOT NULL,
        PRIMARY KEY (vault_id, device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_vc_account
        ON vault_credentials(account_id);

      CREATE INDEX IF NOT EXISTS idx_vc_expiry
        ON vault_credentials(expires_at);

      CREATE TABLE IF NOT EXISTS revocation_list (
        vault_id   TEXT NOT NULL,
        device_id  TEXT NOT NULL,
        revoked_at INTEGER NOT NULL,
        PRIMARY KEY (vault_id, device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_rl_revoked
        ON revocation_list(revoked_at);
    `);

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_011,
      Date.now(),
    );
  });
}

// Migration 012: Phase 7 local-CA mesh trust anchor.
//
// The vault owner's device key (Ed25519, generated in Phase 5 for mesh
// handshake) doubles as the mesh trust anchor for this vault. Peers
// verify VMCs against this column instead of the pinned server pubkey
// when the column is non-NULL.
//
// Back-compat: NULL means "server-anchored" — the Phase 5 verification
// path against app_meta.mesh_server_pubkey_primary still applies. Phase
// 7 vault creation (vault/new.tsx + onboarding/profile.tsx) stamps the
// creator's device pubkey unconditionally, so vaults minted from this
// migration forward are always local-anchored even if the user is
// signed in. Pre-existing vaults keep NULL — they remain server-
// anchored until the owner runs a one-shot "claim" path (deferred,
// see backlog).
//
// Storage: base64-encoded 32-byte Ed25519 pubkey (44 chars). Same
// encoding used by app_meta.mesh_server_pubkey_primary and
// vault_credentials.device_pubkey so existing decoders in vmc.ts and
// device-key.ts apply unchanged.
async function runMigration012(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    // ALTER TABLE ... ADD COLUMN is purely additive; existing rows get
    // NULL (= server-anchored, back-compat).
    if (!(await columnExists(db, "vaults", "vault_trust_anchor_pubkey"))) {
      await db.execAsync(`ALTER TABLE vaults ADD COLUMN vault_trust_anchor_pubkey TEXT;`);
    }
    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_012,
      Date.now(),
    );
  });
}

// Migration 013: Phase 8 D-ROLE-ENFORCEMENT-MOBILE — event signing + revocation lift.
//
// Closes SECURITY #2/#3 in the offline-member-management threat model.
// Before this migration, ledger events on the mesh wire were unsigned —
// any verified peer (editor or viewer) could forge a vault_member_*
// event with actor_account_id set to the OWNER and the role-gate would
// accept it on the basis of the claimed string alone. This is now
// closed by:
//
//   1. Each event in event_log carries a 64-byte Ed25519 signature
//      (event_sig_b64, NULLABLE only for pre-013 backfilled rows; new
//      writes always populate it). The signing key is the local
//      device's mesh Ed25519 privkey (lib/mesh/device-key.ts), the same
//      key that mints VMCs in local-CA mode.
//
//   2. The signature covers a canonical encoding of the envelope +
//      payload (see lib/event-sig.ts canonicalizeEvent). Signer device
//      identity is bound via the event's device_id; the verifier looks
//      up vault_credentials by (vault_id, device_id) to retrieve the
//      authenticated device_pubkey and then verifies the signature
//      AND extracts the authenticated account_id + role for the role-
//      gate. The wire `actor_account_id` is treated as informational.
//
//   3. revocation_list gets a `lifted_at` column. When a previously-
//      removed account is re-paired and applyVaultMemberAdded sees a
//      fresh vault_member_added with newer HLC than the removal, the
//      applier sets lifted_at = appended_at so the mesh handshake
//      revocation check (lib/trust/revocation.ts isRevoked) treats the
//      row as inactive.
//      This closes ENG #8 — "removed-then-re-added device is
//      permanently rejected at mesh handshake."
//
// Pure ADD-COLUMN migration. event_sig_b64 stays NULL on every existing
// row (pre-013 events were authored locally with no signing scheme); the
// verifier accepts NULL for local-origin replay and remote-origin events
// whose envelope predates the schema version. New events authored after
// this migration always carry a signature.
async function runMigration013(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`PRAGMA defer_foreign_keys = ON;`);
    if (!(await columnExists(db, "event_log", "event_sig_b64"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN event_sig_b64 TEXT;`);
    }
    if (!(await columnExists(db, "event_log", "signer_device_pubkey"))) {
      // Snapshot of the signing pubkey at event-creation time. Bound here
      // (and not just looked up from vault_credentials) so an event that
      // outlives the credential row (e.g. cache eviction) can still be
      // re-verified during a replay test. NULL for pre-013 rows.
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN signer_device_pubkey TEXT;`);
    }
    if (!(await columnExists(db, "revocation_list", "lifted_at"))) {
      // ENG #8: when a removed device is re-paired, applyVaultMemberAdded
      // stamps this column so isRevoked() ignores the row. Sticky write
      // path: a later revocation OVERWRITES lifted_at back to NULL via
      // the applier in vault_members.ts.
      await db.execAsync(`ALTER TABLE revocation_list ADD COLUMN lifted_at INTEGER;`);
    }
    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_013,
      Date.now(),
    );
  });
}

// ---------------------------------------------------------------------------
// Migration 014 — INGEST / APPLY SPLIT
// ---------------------------------------------------------------------------
//
// THE BUG (Mythos round-2 audit):
//
// Events refused by role-gate are durably logged today (projection/
// index.ts:265-322 — INSERT OR IGNORE runs BEFORE the role-gate check at
// line 314). But:
//   1. They are never retried — the next sweep never runs because there
//      is no sweep.
//   2. The summary's `WHERE rejected_at IS NULL` filter at
//      anti-entropy.ts:1132 doesn't exclude them, so the head advances
//      past them on the next round.
//   3. Peers never re-send them — their (fetchNextBatch) floor is now
//      past the refused event's HLC.
//
// Net effect on a multi-phone ledger: a refused event is in the LOG
// but missing from the PROJECTION, and no peer in the mesh will ever
// re-deliver it. For a "your entries never disappear" product, this is
// the most important bug in the system. Same pathology, narrowly
// scoped: when a later event from the same device DOES apply, every
// previously-refused event from that device below its HLC drops into
// a permanent hole.
//
// THE FIX (Mythos round-3 design, two criticals folded in):
//
// Make ingest and apply EXPLICITLY separate states via four columns:
//
//   ingested_at: "durably received + (for remote) signature-verified"
//   applied_at:  "applied to projections successfully"
//   quarantine_reason: NULL or a QuarantineReason — apply was skipped
//                     for a curable reason; the sweep retries it on
//                     credential / prereq / role-change events.
//   tombstone_reason: NULL or a TombstoneReason — apply will NEVER
//                     happen; row stays for summary advancement and
//                     audit, but is never relayed or retried.
//
// RELAY FILTER (Mythos Critical 1 — the "gap-below-head" hole one hop
// out): the send filter is per-DEVICE-stream all-or-nothing, never
// per-event withholding. tombstone is per-event but cryptographically
// certain. unknown_actor is per-event but hole-free because the gate
// is "credential exists or not" — when it's absent, EVERY row from
// that device is unknown_actor, so the stream withhold is total. When
// the credential arrives, the sweep reclassifies the whole stream
// atomically. Other quarantine reasons (missing_prereq /
// role_insufficient / applier_throw) come from credentialed devices,
// are fully authenticated, and DO relay — a downstream peer might
// apply what we can't.
//
// rejected_at NOT REPURPOSED (Mythos Critical 2): server-authoritative
// rejection from push.ts:184 happens AFTER local apply. Folding it
// into tombstone_reason would crash the push path on the first server
// rejection because applied_at + tombstone_reason violates the
// state-machine. rejected_at stays orthogonal; the mesh relay filter
// excludes it independently. server_rejected is NOT a TombstoneReason.
//
// POLICY (written down so a future reader knows it was a choice):
//
//   - Upward healing only. A quarantined event applies when its
//     prereq lands.
//   - NO downward re-evaluation. A later-arriving role-change that
//     retroactively invalidates an already-applied event leaves the
//     projection as-is. Full retroactive enforcement requires
//     projection rebuilds; deferred.
//   - server-rejection-after-applied: rejected_at gets set on a row
//     whose projection effects are already live. Same downward
//     problem, same deferral.
//
// BACKFILL STRATEGY:
//
//   - Critical 2: rejected_at IS NOT NULL → applied_at = appended_at.
//     They WERE applied; we just relabel ingest and trust the
//     orthogonal rejected_at column to gate relay.
//   - Role-gate-refused under the old code → quarantine(role_insufficient).
//     Identified via projection_conflicts where kind =
//     'event_rejected_by_local_role_gate' (NOT the other kind which is
//     server-rejection mirror), with event_id extracted from
//     detail_json (no event_id column on that table).
//   - Everything else → applied_at = appended_at.
//   - The migration's classification can be ROUGHLY right because the
//     one-time re-apply pass at runFullReapplyAfterMigration (queued
//     for commit 6 in this PR series) runs applyAlreadyIngestedEvent
//     over every non-tombstoned row, oldest-HLC first. Idempotent
//     appliers cure any misclassification. Errors biased toward
//     "applied" here are corrected; errors biased toward "quarantined"
//     are also corrected (sweep applies them on the first pass).
//
// SCHEMA EVOLUTION:
//
//   - Enum membership is enforced in TRIGGERS, not column-level CHECKs.
//     CHECKs added via ALTER TABLE are frozen and require a 12-step
//     table rebuild to extend. Triggers can be dropped and recreated
//     in a one-line migration when a new reason (e.g. 'revocation_pending')
//     is added later.
//   - Triggers are CREATED LAST, after the backfill UPDATEs. Per-row
//     trigger overhead during the 5-statement backfill would be wasted
//     and a broken backfill is caught wholesale by aborting the txn.
async function runMigration014(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    // ---- 1. new columns (no column-level CHECKs) ----
    if (!(await columnExists(db, "event_log", "ingested_at"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN ingested_at INTEGER;`);
    }
    if (!(await columnExists(db, "event_log", "applied_at"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN applied_at INTEGER;`);
    }
    if (!(await columnExists(db, "event_log", "quarantine_reason"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN quarantine_reason TEXT;`);
    }
    if (!(await columnExists(db, "event_log", "tombstone_reason"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN tombstone_reason TEXT;`);
    }

    // ---- 2a. backfill — server-rejected rows are applied. ----
    await db.runAsync(`
      UPDATE event_log
         SET ingested_at = appended_at,
             applied_at  = appended_at
       WHERE rejected_at IS NOT NULL
         AND ingested_at IS NULL
    `);

    // ---- 2b. backfill — role-gate refused rows. ----
    //
    // Filter projection_conflicts on the correct kind discriminator;
    // event_id is INSIDE detail_json (no column on projection_conflicts).
    await db.runAsync(`
      UPDATE event_log
         SET ingested_at = appended_at,
             quarantine_reason = 'role_insufficient'
       WHERE event_id IN (
         SELECT json_extract(detail_json, '$.event_id')
           FROM projection_conflicts
          WHERE kind = 'event_rejected_by_local_role_gate'
       )
         AND ingested_at IS NULL
    `);

    // ---- 2c. backfill — everything else applied. ----
    await db.runAsync(`
      UPDATE event_log
         SET ingested_at = appended_at,
             applied_at  = appended_at
       WHERE ingested_at IS NULL
    `);

    // ---- 3. indexes ----
    //
    // Partial index for the sweep. The sweep's WHERE clause matches
    // this predicate exactly, so the planner picks it up.
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_event_log_quarantine
        ON event_log(vault_id, hlc_physical_ms, hlc_logical, hlc_device_id)
        WHERE applied_at IS NULL AND tombstone_reason IS NULL;
    `);
    // Full index (NOT predicated) for computeSummary's
    // GROUP BY device_id pattern. We don't predicate on ingested_at
    // IS NOT NULL because the trigger makes that an invariant; a
    // predicated index forces every consumer to repeat the predicate
    // in their WHERE clause for the planner to use it.
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_event_log_by_device_hlc
        ON event_log(vault_id, device_id, hlc_physical_ms, hlc_logical);
    `);

    // ---- 4. state-machine triggers (CREATED LAST) ----
    //
    // Enforced on BOTH insert and update:
    //   - ingested_at must be set (NOT NULL invariant — SQLite can't
    //     ADD NOT NULL via ALTER, so trigger-enforced).
    //   - applied_at + tombstone_reason mutually exclusive.
    //   - applied_at + quarantine_reason mutually exclusive.
    //   - tombstone_reason + quarantine_reason mutually exclusive.
    //   - quarantine_reason if non-NULL must be a known enum value.
    //   - tombstone_reason if non-NULL must be a known enum value.
    //
    // Future enum additions: DROP TRIGGER + CREATE TRIGGER in a
    // one-line migration. No table rebuild.
    await db.execAsync(`
      CREATE TRIGGER IF NOT EXISTS event_log_state_machine_insert
      BEFORE INSERT ON event_log
      WHEN
        (NEW.ingested_at IS NULL) OR
        (NEW.applied_at IS NOT NULL AND NEW.tombstone_reason IS NOT NULL) OR
        (NEW.applied_at IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
        (NEW.tombstone_reason IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
        (NEW.quarantine_reason IS NOT NULL AND NEW.quarantine_reason NOT IN
           ('unknown_actor', 'missing_prereq', 'role_insufficient', 'applier_throw')) OR
        (NEW.tombstone_reason IS NOT NULL AND NEW.tombstone_reason NOT IN
           ('bad_signature', 'unsigned_event', 'schema_invalid'))
      BEGIN
        SELECT RAISE(ABORT, 'event_log state machine violation on insert');
      END;
    `);
    await db.execAsync(`
      CREATE TRIGGER IF NOT EXISTS event_log_state_machine_update
      BEFORE UPDATE ON event_log
      WHEN
        (NEW.ingested_at IS NULL) OR
        (NEW.applied_at IS NOT NULL AND NEW.tombstone_reason IS NOT NULL) OR
        (NEW.applied_at IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
        (NEW.tombstone_reason IS NOT NULL AND NEW.quarantine_reason IS NOT NULL) OR
        (NEW.quarantine_reason IS NOT NULL AND NEW.quarantine_reason NOT IN
           ('unknown_actor', 'missing_prereq', 'role_insufficient', 'applier_throw')) OR
        (NEW.tombstone_reason IS NOT NULL AND NEW.tombstone_reason NOT IN
           ('bad_signature', 'unsigned_event', 'schema_invalid'))
      BEGIN
        SELECT RAISE(ABORT, 'event_log state machine violation on update');
      END;
    `);

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_014,
      Date.now(),
    );
  });

  // ---- 5. One-time full re-apply (Mythos round-3 commit 6). ----
  //
  // After migration commits, schedule a sweep for every vault that has
  // at least one quarantined row from the backfill. The sweep runs
  // 100ms later, picks up the quarantine_reason='role_insufficient'
  // rows that the backfill marked, and re-runs them through
  // applyAlreadyIngestedEvent. Rows whose role gate now permits them
  // (e.g. role was elevated since the original refusal) transition to
  // applied_at; rows that still fail update their reason; rows that
  // fail with a permanent reason tombstone.
  //
  // Why this is safe even though it runs AFTER schema_migrations
  // INSERT: scheduleSweep uses a timer; the migration function
  // returns synchronously, so the caller's next migration (or app
  // start) proceeds without blocking on the sweep. The sweep takes
  // the sweep mutex which is also held by applyIncomingBatch — so
  // even if a mesh round fires before the sweep finishes, they
  // serialize correctly.
  //
  // The "every non-tombstoned row" version Mythos originally proposed
  // is also safe but unnecessary: under the old code, applier throws
  // rolled back the INSERT atomically (projection/index.ts:197 wraps
  // INSERT + role-gate + applier in one withTransactionAsync), so
  // there are no orphan rows where the projection is missing despite
  // applied_at being set. The backfill in steps 2a-2c is complete
  // modulo what scheduleSweep cures.
  try {
    const quarantinedVaults = await db.getAllAsync<{ vault_id: string }>(
      `SELECT DISTINCT vault_id
         FROM event_log
        WHERE quarantine_reason IS NOT NULL
          AND vault_id IS NOT NULL`,
    );
    if (quarantinedVaults.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { scheduleSweep } = require("./projection/sweep") as {
        scheduleSweep: (vaultId: string) => void;
      };
      for (const v of quarantinedVaults) {
        scheduleSweep(v.vault_id);
      }
      console.log(
        `[migration 014] scheduled re-apply sweep for ${quarantinedVaults.length} vault(s) with quarantined rows`,
      );
    }
  } catch (err) {
    // Best-effort: if sweep scheduling fails the runtime sweep will
    // pick these up on the first mesh round after install.
    console.warn("[migration 014] post-migration re-apply schedule failed", err);
  }
}

// ---------------------------------------------------------------------------
// Migration 015 — vault_members_mirror.display_name (Mythos Issue 1)
// ---------------------------------------------------------------------------
//
// The Members tab showed the role label ("Owner"/"Editor") instead of a
// name because there was NOWHERE for a peer's display name to live:
// vault_members_mirror had only (vault_id, account_id, role, accepted_at,
// revoked_at), and the users LEFT JOIN only resolves for the Google-
// signed-in local-self. The QR carries issuer_display_name but it was
// thrown away at pair-scan time.
//
// This column lets pair-scan persist the owner's name, vault/new persist
// the owner's own name, and a future vault_member_added event payload
// carry the joiner's name. Purely additive; nullable; no backfill needed
// (existing rows just render via the old users-join / self-name fallback
// until the next pair refreshes them).
async function runMigration015(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    if (!(await columnExists(db, "vault_members_mirror", "display_name"))) {
      await db.execAsync(`ALTER TABLE vault_members_mirror ADD COLUMN display_name TEXT;`);
    }
    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_015,
      Date.now(),
    );
  });
}

// ---------------------------------------------------------------------------
// Migration 016 — mem_samples (Mythos crash-diagnosis instrumentation)
// ---------------------------------------------------------------------------
//
// A capped ring of per-minute memory/storage snapshots taken while shop
// mode is on. The Diagnostics screen renders the last ~15 rows as plain
// text the user can screenshot — so we get the native-vs-dalvik PSS slope
// over a crash window with NO adb. The mem-probe writer caps the table to
// 240 rows (~4 hours at 60s cadence).
async function runMigration016(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS mem_samples (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        at              INTEGER NOT NULL,
        native_pss_kb   INTEGER,
        dalvik_pss_kb   INTEGER,
        native_alloc_kb INTEGER,
        js_heap_kb      INTEGER,
        avail_mb        INTEGER,
        storage_free_mb INTEGER
      );
    `);
    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_016,
      Date.now(),
    );
  });
}

// ---------------------------------------------------------------------------
// Migration 017 — crash_outbox (Mythos crash-reporter)
// ---------------------------------------------------------------------------
//
// A durable SQLite outbox for crash/diagnostic items. The reporter queues
// here (so a crash that kills the process doesn't lose the report — the row
// is already committed), and the next check-in flushes a batch to the
// backend /v1/crash-reports endpoint, marking rows flushed_at on success.
//
// kind taxonomy matches the backend's CHECK constraint:
//   boot | mesh | sync | exit | memsample | js | native
//
// rss_kb / aux_kb carry numeric telemetry for exit + memsample rows
// (rss-at-death / pss, or native_pss / dalvik_pss). NULL for error rows.
async function runMigration017(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS crash_outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        stage       TEXT,
        name        TEXT,
        message     TEXT NOT NULL DEFAULT '',
        rss_kb      INTEGER,
        aux_kb      INTEGER,
        app_version TEXT NOT NULL DEFAULT 'unknown',
        created_at  INTEGER NOT NULL,
        flushed_at  INTEGER
      );
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_crash_outbox_unflushed
        ON crash_outbox(id) WHERE flushed_at IS NULL;
    `);
    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_017,
      Date.now(),
    );
  });
}

// Migration 018 — Sync v2 M1 (docs/sync-v2-architecture.md §5): per-author
// sequence numbers on the event log.
//
// `author_seq` is TRANSFER BOOKKEEPING, not authored content: it is NOT part
// of the signed envelope (see lib/event-sig.ts SIGNED_FIELDS) and never
// affects projection/merge order — HLC remains the merge order. It exists so
// replicas can describe their state of knowledge as a per-device version
// vector ({device_id → highest contiguous seq held}) and exchange exactly
// the missing events, resumably, over any transport.
//
// Backfill: every existing row gets a seq per (vault, device) in HLC order.
// This is deterministic — each device's HLC is strictly monotonic, so any
// replica holding the same prefix of a device's events computes identical
// numbers for them. The per-(vault,device) watermark of backfilled seqs is
// recorded in app_meta (JSON map) because backfilled numbers for OTHER
// devices' events are inferences, not author assignments — the LAN/BLE
// channels (M3/M4) must treat seqs at or below a foreign watermark as
// advisory. The server channel never relies on them (outbox flags remain
// push truth in M1).
async function runMigration018(db: SQLite.SQLiteDatabase, preInstallId?: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    // Same install-id resolution as migration 006: prefer the param,
    // fall back to app_meta (ensureInstallId persisted it pre-initDb).
    let installId: string | null = preInstallId ?? null;
    if (!installId) {
      const row = await db.getFirstAsync<{ value: string }>(
        `SELECT value FROM app_meta WHERE key = 'install_id'`,
      );
      installId = row?.value ?? null;
    }
    if (!installId) {
      throw new Error(
        "migration 018: install_id missing — ensureInstallId() must run before initDb({installId})",
      );
    }
    if (!(await columnExists(db, "event_log", "author_seq"))) {
      await db.execAsync(`ALTER TABLE event_log ADD COLUMN author_seq INTEGER;`);
    }

    // Deterministic backfill: ROW_NUMBER per (vault, device) in HLC order,
    // event_id as the final tiebreaker so the numbering stays total and
    // reproducible even if a pathological (pms, l) collision exists
    // (lost hlc_last + clock rollback). COALESCE(vault_id,'') groups the
    // pre-Phase-2 NULL-vault legacy rows into one stable partition instead
    // of NULL-isolating each row.
    await db.execAsync(`
      WITH ranked AS (
        SELECT event_id,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(vault_id, ''), device_id
                 ORDER BY hlc_physical_ms ASC, hlc_logical ASC, event_id ASC
               ) AS rn
          FROM event_log
      )
      UPDATE event_log
         SET author_seq = (SELECT rn FROM ranked WHERE ranked.event_id = event_log.event_id)
       WHERE author_seq IS NULL;
    `);

    // Record backfill watermarks: { "<vault>|<device>": <max backfilled seq> }.
    const watermarkRows = await db.getAllAsync<{
      vault_id: string | null;
      device_id: string;
      max_seq: number;
    }>(
      `SELECT vault_id, device_id, MAX(author_seq) AS max_seq
         FROM event_log
        WHERE author_seq IS NOT NULL
        GROUP BY COALESCE(vault_id, ''), device_id`,
    );
    const watermarks: Record<string, number> = {};
    for (const r of watermarkRows) {
      watermarks[`${r.vault_id ?? ""}|${r.device_id}`] = r.max_seq;
    }
    await db.runAsync(
      `INSERT INTO app_meta (key, value) VALUES ('author_seq_backfill_watermarks', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(watermarks),
    );

    // One-shot seq re-announce flags: for every vault where THIS device's
    // own history just got numbered, mark it pending. The next push for
    // that vault un-acks our own sequenced rows once so the server's
    // duplicate re-announce path can stamp author_seq onto its stored
    // copies (otherwise pre-M1 history stays seq-less server-side forever
    // and the vector never becomes provable). See lib/sync/push.ts.
    for (const r of watermarkRows) {
      if (r.device_id === installId && r.vault_id != null) {
        await db.runAsync(
          `INSERT INTO app_meta (key, value) VALUES (?, '1')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          `seq_reannounce_pending:${r.vault_id}`,
        );
      }
    }

    // UNIQUE per (vault, device, seq). Partial: legacy mesh-ingested rows
    // may legitimately remain NULL (their author never told us a seq).
    await db.execAsync(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_author_seq
        ON event_log(vault_id, device_id, author_seq)
        WHERE author_seq IS NOT NULL;
    `);

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_018,
      Date.now(),
    );
  });
}

// ---------------------------------------------------------------------------
// Migration 019 — vault_device_registry (M2 membership chain)
// ---------------------------------------------------------------------------
//
// Fold-target table for the M2 membership chain (docs/m2-membership-chain.md
// §6): the materialized device-binding state produced by folding
// vault_device_added / vault_device_removed events (appliers in
// lib/projection/vault_devices.ts). Lets the role-gate answer "which account
// does this signer pubkey belong to, and is the binding live?" without the
// legacy vault_credentials VMC cache. The event log remains the history for
// at-HLC queries; this table is current-state only.
//
// device_pubkey is base64 Ed25519 — the same encoding as
// event_log.signer_device_pubkey, so lookups join byte-for-byte.
//
// Also adds idx_event_log_membership: membership-chain folds scan "all
// membership events for a vault in HLC order". The existing
// idx_event_log_vault_type_target (migration 010) cannot serve that scan —
// it is PARTIAL (WHERE rejected_at IS NULL, and the chain fold must see every
// event regardless of server rejection) and orders target_id before the HLC
// columns. Purely additive; safe on fresh installs and upgraders alike.
async function runMigration019(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS vault_device_registry (
        vault_id      TEXT NOT NULL,
        device_pubkey TEXT NOT NULL,
        device_id     TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        added_at_ms   INTEGER NOT NULL,
        removed_at_ms INTEGER,
        -- Full removal HLC (logical + device-id components). The role-gate's
        -- device_removed verdict must compare the FULL HLC tuple against the
        -- signing event, not pms alone — a removed device can author an event
        -- at exactly removed_at_ms with a higher logical counter, which is
        -- post-removal in the chain fold's full-HLC order but ties on pms.
        -- (M2 security review.)
        removed_at_l   INTEGER,
        removed_at_did TEXT,
        PRIMARY KEY (vault_id, device_pubkey)
      );
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_vault_device_registry_device
        ON vault_device_registry(vault_id, device_id);
    `);
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_event_log_membership
        ON event_log(vault_id, event_type, hlc_physical_ms, hlc_logical);
    `);

    // M2 (review P1): rewind every per-vault pull cursor. A v0.5.x client
    // that pulled vault_device_added/removed events it didn't yet know
    // (HEAD added those types) dropped them per-event while ADVANCING the
    // cursor past them — they'd never be re-fetched, so the upgraded
    // client's chain would be permanently missing those bindings/removals
    // (handshake refusals + unsigned_event quarantines that never heal).
    // Reset to 0 so the next sync re-pulls the full log once; applyEvent is
    // idempotent (INSERT OR IGNORE on event_id) so already-held events are
    // no-ops and only the previously-dropped membership events land.
    if (await tableExists(db, "sync_state")) {
      await db.runAsync(`UPDATE sync_state SET last_pulled_server_seq = 0`);
    }

    await db.runAsync(
      `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
      MIGRATION_019,
      Date.now(),
    );
  });
}

// --- v0 row shapes (used only during migration) ---
type V0Shopkeeper = {
  id: number;
  shop_name: string;
  owner_name: string | null;
  created_at: number;
};

type V0Customer = {
  id: string;
  name: string;
  phone: string | null;
  created_at: number;
  archived_at: number | null;
};

type V0Entry = {
  id: string;
  customer_id: string;
  type: EntryType;
  amount_afn: number;
  note: string | null;
  created_at: number;
  deleted_at: number | null;
};

// --- internal helpers ---

async function getLocalSelfUserId(db: SQLite.SQLiteDatabase): Promise<string | null> {
  const row = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  return row?.id ?? null;
}

async function findRelationshipIdForPerson(
  db: SQLite.SQLiteDatabase,
  personId: string,
): Promise<string | null> {
  // After migration_003 every active relationship is 'peer'; after migration_007
  // every relationship has vault_id NOT NULL. Filter both so we never hand back
  // a relationship from a different vault than the active one.
  const vaultId = getActiveVaultIdSync();
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM relationships
     WHERE user_b_id = ?
       AND vault_id  = ?
       AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    personId,
    vaultId,
  );
  return row?.id ?? null;
}

// Dev-only: drops every kaata table so the next initDb() rebuilds them
// fresh. Used by the Settings "Reset all data" button to simulate a clean
// install without wiping all of Expo Go's storage. Reseting dbPromise to
// null closes the cached handle — next initDb() opens a fresh one.
//
// Lists both v0 (customers/shopkeeper) and v1 (users/relationships/etc)
// table names so the reset works against any historical schema state.
export async function resetAllLocalData(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    DROP TABLE IF EXISTS vault_device_registry;
    DROP TABLE IF EXISTS sync_state;
    DROP TABLE IF EXISTS projection_conflicts;
    DROP TABLE IF EXISTS pending_invitations;
    DROP TABLE IF EXISTS vault_settings;
    DROP TABLE IF EXISTS event_log;
    DROP TABLE IF EXISTS entries;
    DROP TABLE IF EXISTS entries_new;
    DROP TABLE IF EXISTS relationships;
    DROP TABLE IF EXISTS relationships_new;
    DROP TABLE IF EXISTS shop_profile;
    DROP TABLE IF EXISTS _old_shop_profile;
    DROP TABLE IF EXISTS vault_members_mirror;
    DROP TABLE IF EXISTS vaults;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS users_new;
    DROP TABLE IF EXISTS app_meta;
    DROP TABLE IF EXISTS schema_migrations;
    DROP TABLE IF EXISTS shopkeeper;
    DROP TABLE IF EXISTS _old_shopkeeper;
    DROP TABLE IF EXISTS customers;
  `);
  await db.closeAsync();
  _resetDbHandleForReset();
  _resetActiveVaultIdCacheForReset();
  _resetAccountIdCacheForReset();
}

// --- public API ---

export async function getLocalSelf(): Promise<Self | null> {
  const db = await getDb();
  // After migration 007 shop_profile is keyed by vault_id (no user_id).
  // Read the active vault's shop name when one exists; null otherwise.
  // The local-self user row is the device identity, shared across vaults.
  const vaultId = getActiveVaultIdSyncMaybe();
  if (vaultId) {
    const row = await db.getFirstAsync<Self>(
      `SELECT u.id           AS user_id,
              u.display_name AS name,
              sp.shop_name   AS shop_name
       FROM users u
       LEFT JOIN shop_profile sp ON sp.vault_id = ?
       WHERE u.is_local_self = 1
       LIMIT 1`,
      vaultId,
    );
    return row ?? null;
  }
  // No vault yet (brand-new install pre-onboarding). Return self user without
  // shop_name; onboarding will mint vault + shop_profile together.
  const row = await db.getFirstAsync<Self>(
    `SELECT u.id           AS user_id,
            u.display_name AS name,
            NULL           AS shop_name
     FROM users u
     WHERE u.is_local_self = 1
     LIMIT 1`,
  );
  return row ?? null;
}

export async function createSelfProfile(
  name: string,
  shopName: string,
  phone?: string | null,
): Promise<void> {
  // v0.5.3 Briar-style onboarding: shopName is now OPTIONAL (founder
  // reversed the Phase 7 "always required" stance — too many users want
  // to install Kaata to JOIN an existing kaata, not create one). When
  // shopName is empty we still mint a default vault (so the user has
  // somewhere to land if they DON'T pair into another kaata immediately)
  // but with a generic name they can rename later. The "Join an existing
  // kaata" path in profile.tsx routes the user straight to pair-scan
  // and the placeholder vault gets used or replaced based on whether
  // they pair into a remote vault or fall back to the local default.
  //
  // Phone is OPTIONAL — no OTP gate, no verification. It's stored in
  // users.phone_e164 for future "search your contacts to add a person"
  // matching but doesn't gate any flow.
  const trimmedName = name.trim();
  const trimmedShop = (shopName ?? "").trim();
  const trimmedPhone = (phone ?? "").trim();
  if (!trimmedName) {
    throw new Error("createSelfProfile: name is required");
  }
  // Empty shop name → mint a placeholder. The user sees this in the
  // home header as "My kaata" until they either rename it (vault/settings)
  // or pair into someone else's kaata (which becomes their active vault).
  const effectiveShopName = trimmedShop || "My kaata";
  const db = await getDb();
  const now = Date.now();
  const userId = Crypto.randomUUID();
  // Brand-new install: migration 007 skipped minting a default vault, so
  // onboarding completion mints it here in the same transaction that
  // creates the local-self user + shop_profile. Mid-onboarding upgraders
  // already have a vault (migration 007 minted it from the existing
  // local_self row); skip the vault mint in that case.
  const existingVaultId = await getActiveVaultId();
  let vaultId = existingVaultId;

  // M4: the owner's device pubkey is the mesh trust anchor for every
  // vault — there is NO server-anchored path anymore. Every live vault
  // MUST be chain-anchored (loadVaultTrustAnchor non-null), because the
  // membership chain is the sole trust path; an anchor-less vault would
  // have no verification at all. So ensureDeviceKey failure here is
  // FATAL — we refuse to create an anchor-less vault rather than fall
  // back to a (now non-existent) server-anchored path. ensureDeviceKey
  // runs OUTSIDE the txn so the throw aborts before any row is written.
  // (In practice it never fails after a fresh install — the only
  // realistic failure is the user wiping SecureStore mid-process, which
  // we can't recover from regardless.)
  let trustAnchorPubkey: string;
  {
    const deviceKey = await import("./mesh/device-key");
    await deviceKey.ensureDeviceKey();
    const pk = deviceKey.getDevicePubkey();
    if (!pk) {
      throw new Error(
        "createSelfProfile: device pubkey unavailable after ensureDeviceKey — cannot create an anchor-less vault",
      );
    }
    trustAnchorPubkey = pk;
  }

  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "INSERT INTO users (id, phone_e164, display_name, is_local_self, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
      userId,
      trimmedPhone || null,
      trimmedName,
      now,
      now,
    );

    if (!vaultId) {
      vaultId = Crypto.randomUUID();
      await db.runAsync(
        `INSERT INTO vaults
           (id, name, currency, created_at, updated_at, archived_at,
            is_default, account_id, registered_with_server_at,
            vault_epoch, hlc_logical, hlc_wall_ms,
            vault_trust_anchor_pubkey)
         VALUES (?, ?, 'AFN', ?, ?, NULL, 1, NULL, NULL, 0, 0, 0, ?)`,
        vaultId,
        effectiveShopName,
        now,
        now,
        trustAnchorPubkey, // always non-null (fatal if unavailable, above)
      );
      await setAppMetaInTx(db, "active_vault_id", vaultId);
      await setAppMetaInTx(db, "default_vault_id", vaultId);
    } else {
      // Backfill the trust anchor on a pre-existing vault row that was
      // minted before the anchor column existed (e.g. a mid-onboarding
      // upgrader from migration 007's bootstrap vault). COALESCE keeps an
      // existing non-NULL value so a re-run of onboarding doesn't clobber
      // an already-anchored vault.
      await db.runAsync(
        `UPDATE vaults
            SET vault_trust_anchor_pubkey = COALESCE(vault_trust_anchor_pubkey, ?)
          WHERE id = ?`,
        trustAnchorPubkey,
        vaultId,
      );
    }

    // shop_profile always has a row per vault — onboarding sets the
    // first one with the user-chosen name. Phase 7: no fallback to the
    // user's name (the field is required upstream).
    await db.runAsync(
      `INSERT OR REPLACE INTO shop_profile
         (vault_id, owner_name, shop_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      vaultId,
      trimmedName,
      effectiveShopName,
      now,
      now,
    );
  });

  // M4: no self-VMC issuance. Trust comes from the genesis
  // vault_member_added emitted below — the chain fold implicitly binds
  // this anchor device from it. The owner participates in the mesh
  // immediately via the chain handshake.

  // Prime the in-memory caches so the first event append works immediately.
  if (vaultId) setActiveVaultIdCache(vaultId);
  await refreshLocalSelfUserIdCache();

  // Emit a shop_profile_updated event so the initial shop_name + owner_name
  // are reconstructable from event_log alone. Without this a wipe-and-replay
  // (or a Phase 3 second-device restore-from-log) ends up with NO shop_profile
  // row for the vault, because the INSERT above is a direct projection write
  // outside the event log. The event projection applier UPDATEs the existing
  // row idempotently, so emitting this AFTER the initial INSERT is safe (the
  // event becomes the canonical write-history record; the INSERT is just the
  // initial value seed).
  //
  // The local-self person is intentionally NOT emitted as a person_added —
  // person_added events carry a relationship which the local-self has none of
  // (it's the "user_a" side of every relationship, not a customer). Phase 3
  // restore reconstructs the local self from app_meta.account_id + a fresh
  // onboarding pass (the device has to re-mint its own self user row anyway
  // because users.id is device-local for the self row).
  if (vaultId) {
    try {
      await appendShopProfileUpdated({
        vaultId,
        changes: { shop_name: effectiveShopName, owner_name: trimmedName },
      });
    } catch (err) {
      // Best-effort: a transient failure here means the event log is missing
      // the initial shop_name (recoverable on next updateSelfProfile call),
      // not a data-integrity disaster. Don't fail onboarding for this.
      console.warn("[db] createSelfProfile: shop_profile_updated emit failed", err);
    }
  }

  // M4: emit the genesis vault_member_added{owner} INLINE (matching
  // vault/new.tsx). This IS the membership-chain root
  // (docs/m2-membership-chain.md §3.1): it's authored + signed by THIS
  // device, and the chain fold implicitly binds the anchor device from
  // it, so no vault_device_added is emitted for the creator. The applier
  // (applyVaultMemberAdded) writes the owner's vault_members_mirror row,
  // so the owner's own Members tab + role-gate binding are correct
  // immediately, and the event propagates to peers via mesh so they can
  // authenticate the owner's ledger events. Best-effort: a transient
  // failure leaves the local user/vault intact; runGenesisBackfill is the
  // self-heal safety net that re-emits on a later launch.
  if (vaultId) {
    try {
      await appendVaultMemberAdded({
        targetVaultId: vaultId,
        accountId: getAccountIdSync() ?? buildLocalAccountId(trustAnchorPubkey),
        role: "owner",
      });
    } catch (err) {
      console.warn("[db] createSelfProfile: genesis vault_member_added emit failed", err);
    }
  }
}

// Updates the local-self user's display name and shop name. Both can be
// edited independently. In Phase 2:
//   - Display name update routes through the person_renamed event applier
//     so the projection rebuild path stays consistent.
//   - Shop profile update routes through shop_profile_updated, keyed by
//     vault_id (migration 007 collapsed the singleton id=1 row).
//
// Setting shopName to null/"" is treated as "no change to shop_name" since
// shop_profile is now an always-present row per vault — clearing the name
// is not a user gesture the UI supports.
export async function updateSelfProfile(name: string, shopName: string | null): Promise<void> {
  const db = await getDb();
  const self = await getLocalSelfUserId(db);
  if (!self) throw new Error("local user not yet created");
  const vaultId = getActiveVaultIdSync();

  // Self display_name change goes through the event log (person_renamed
  // applier handles it — no special case for is_local_self).
  await appendPersonRenamed({ userId: self, vaultId, name });

  // Shop name update — only emit when non-empty AND different from current.
  if (shopName && shopName.length > 0) {
    const current = await db.getFirstAsync<{ shop_name: string | null }>(
      "SELECT shop_name FROM shop_profile WHERE vault_id = ?",
      vaultId,
    );
    if (!current) {
      // Migration 007 + onboarding both create a row for the active vault.
      // If somehow missing, insert a minimal row first so the event applier
      // has something to UPDATE — then ROUTE THROUGH THE EVENT LOG so a
      // replay/restore reconstructs the same shop_name. Skipping the event
      // here would break the "event log is the source of truth" contract.
      const now = Date.now();
      await db.runAsync(
        `INSERT INTO shop_profile (vault_id, owner_name, shop_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        vaultId,
        name,
        shopName,
        now,
        now,
      );
      await appendShopProfileUpdated({
        vaultId,
        changes: { shop_name: shopName, owner_name: name },
      });
    } else if ((current.shop_name ?? "") !== shopName) {
      await appendShopProfileUpdated({
        vaultId,
        changes: { shop_name: shopName, owner_name: name },
      });
    }
  }
}

// Creates a person with a single 'peer' relationship via event-sourced
// person_added (Phase 2). Public API + return type unchanged.
//
// Per-vault phone uniqueness check runs OUTSIDE the event append so we can
// return a structured CreatePersonResult error before burning an HLC tick.
export async function createPerson(
  name: string,
  phone: string | null,
  countryCode?: string,
): Promise<CreatePersonResult> {
  const db = await getDb();
  const localSelf = await getLocalSelfUserId(db);
  if (!localSelf) throw new Error("local user not yet created");
  const vaultId = getActiveVaultIdSync();

  let phoneE164: string | null = null;
  if (phone && phone.length > 0) {
    const np = normalizePhone(phone, countryCode);
    if (!np) {
      return { ok: false, error: "phone_invalid" };
    }
    const conflict = await findPhoneConflictInVault(np, vaultId, null);
    if (conflict) {
      return {
        ok: false,
        error: "phone_conflict",
        existing: conflict,
      };
    }
    phoneE164 = np;
  }

  const id = Crypto.randomUUID();
  const relId = Crypto.randomUUID();
  await appendPersonAdded({
    userId: id,
    relationshipId: relId,
    name,
    phoneE164,
    vaultId,
  });

  await bumpUsageCounter("customers_added");
  return { ok: true, id };
}

async function selectAllPeopleRaw(db: SQLite.SQLiteDatabase): Promise<PersonWithBalance[]> {
  // Vault filter on BOTH relationships and the LEFT-JOINed entries. The
  // entries filter goes in the ON clause (not WHERE) because this is a
  // LEFT JOIN; a person with zero entries must still appear.
  // Pre-onboarding (no vault yet) returns [] cleanly.
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return [];
  return db.getAllAsync<PersonWithBalance>(
    `SELECT u.id            AS id,
            u.display_name  AS name,
            u.phone_e164    AS phone,
            u.created_at    AS created_at,
            r.archived_at   AS archived_at,
            COALESCE(SUM(CASE
              WHEN e.deleted_at IS NULL AND e.type = 'debt' THEN e.amount_afn
              WHEN e.deleted_at IS NULL AND e.type = 'payment' THEN -e.amount_afn
              ELSE 0
            END), 0) AS balance,
            MAX(CASE WHEN e.deleted_at IS NULL THEN e.created_at END) AS last_entry_at
     FROM relationships r
     INNER JOIN users u ON u.id = r.user_b_id
     LEFT JOIN entries e
       ON e.relationship_id = r.id
      AND e.vault_id = ?
     WHERE r.vault_id   = ?
       AND r.archived_at IS NULL
     GROUP BY u.id`,
    vaultId,
    vaultId,
  );
}

// Returns every person with their signed net balance, filtered to one
// direction of the ledger.
//   balance > 0 → they owe me (To collect tab)
//   balance < 0 → I owe them   (To pay tab)
//   balance == 0 → settled or brand new — shown in collect by default so they're findable.
export async function listPeople(direction: Direction): Promise<PersonWithBalance[]> {
  const db = await getDb();
  const rows = await selectAllPeopleRaw(db);
  if (direction === "collect") {
    return rows
      .filter((p) => p.balance >= 0)
      .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  }
  return rows
    .filter((p) => p.balance < 0)
    .sort((a, b) => a.balance - b.balance || a.name.localeCompare(b.name));
}

// Returns every active person, regardless of which tab they'd land in.
// Used by the search-or-create flow where direction doesn't matter — the user
// just wants to find or add a contact. Sorted most-recently-active first so
// the quick-switcher pre-populates with familiar names.
export async function listAllPeople(): Promise<PersonWithBalance[]> {
  const db = await getDb();
  const rows = await selectAllPeopleRaw(db);
  rows.sort((a, b) => {
    const at = a.last_entry_at ?? 0;
    const bt = b.last_entry_at ?? 0;
    if (at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

export async function getPerson(id: string): Promise<PersonWithBalance | null> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return null;
  const row = await db.getFirstAsync<PersonWithBalance>(
    `SELECT u.id            AS id,
            u.display_name  AS name,
            u.phone_e164    AS phone,
            u.created_at    AS created_at,
            r.archived_at   AS archived_at,
            COALESCE(SUM(CASE
              WHEN e.deleted_at IS NULL AND e.type = 'debt' THEN e.amount_afn
              WHEN e.deleted_at IS NULL AND e.type = 'payment' THEN -e.amount_afn
              ELSE 0
            END), 0) AS balance,
            MAX(CASE WHEN e.deleted_at IS NULL THEN e.created_at END) AS last_entry_at
     FROM relationships r
     INNER JOIN users u ON u.id = r.user_b_id
     LEFT JOIN entries e
       ON e.relationship_id = r.id
      AND e.vault_id = ?
     WHERE u.id = ?
       AND r.vault_id = ?
       AND r.archived_at IS NULL
     GROUP BY u.id
     LIMIT 1`,
    vaultId,
    id,
    vaultId,
  );
  return row ?? null;
}

// Archives the person via event-sourced person_archived events — one per
// active relationship for the person in the ACTIVE vault. Same public
// signature as before (Promise<void>); the applier nulls the phone_e164
// inside the same transaction once no active relationships remain across
// any vault.
//
// In Phase 2 single-vault UI there's at most one active relationship; we
// walk the list defensively so a future multi-vault UI doesn't silently
// leave active rows behind.
export async function archivePerson(id: string): Promise<void> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSync();

  const rels = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM relationships
      WHERE user_b_id   = ?
        AND vault_id    = ?
        AND archived_at IS NULL`,
    id,
    vaultId,
  );

  for (const r of rels) {
    await appendPersonArchived({
      userId: id,
      relationshipId: r.id,
      vaultId,
    });
  }
}

export async function listEntries(personId: string): Promise<Entry[]> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return [];
  return db.getAllAsync<Entry>(
    `SELECT e.id, e.relationship_id, e.type, e.amount_afn, e.note,
            e.created_at, e.updated_at, e.deleted_at, e.proposed_by_user_id,
            e.accepted_at, e.disputed_at, e.disputed_reason, e.settled_at
     FROM entries e
     INNER JOIN relationships r ON r.id = e.relationship_id
     WHERE r.user_b_id  = ?
       AND e.vault_id   = ?
       AND r.vault_id   = ?
       AND r.archived_at IS NULL
       AND e.deleted_at IS NULL
     ORDER BY e.created_at DESC`,
    personId,
    vaultId,
    vaultId,
  );
}

// Public API preserved — same signature, same return type, same usage-counter
// side effect. Internals now route through the event log instead of writing
// to entries directly. The applier inside event-log.ts performs the actual
// INSERT into entries within the same transaction that writes the event_log
// row and advances hlc_last.
export async function createEntry(
  personId: string,
  type: EntryType,
  amountAfn: number,
  note: string | null,
): Promise<string> {
  const db = await getDb();
  const relId = await findRelationshipIdForPerson(db, personId);
  if (!relId) throw new Error(`no active relationship for person ${personId}`);
  const { entry_id } = await appendEntryCreated({
    relationshipId: relId,
    type,
    amountAfn,
    note,
  });
  await bumpUsageCounter("entries_created");
  return entry_id;
}

// Same public API. Internally we compute a minimal delta against the current
// row so we don't emit no-op amend events that would just churn the log on a
// "Save" press where the user didn't actually change anything.
export async function updateEntry(
  id: string,
  amountAfn: number,
  note: string | null,
): Promise<void> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSync();
  // Read the current row (vault-scoped) so we can compute a minimal delta.
  // A stale id from a different vault is treated as missing and no-ops.
  const current = await db.getFirstAsync<{
    amount_afn: number;
    note: string | null;
  }>("SELECT amount_afn, note FROM entries WHERE id = ? AND vault_id = ?", id, vaultId);
  if (!current) {
    // Mirror the old behavior: silently no-op on missing id. The previous
    // UPDATE would simply affect 0 rows.
    return;
  }
  const changes: { amount_afn?: number; note?: string | null } = {};
  if (current.amount_afn !== amountAfn) changes.amount_afn = amountAfn;
  // Normalize undefined / "" vs null so a no-op round-trip doesn't emit an event.
  if ((current.note ?? null) !== (note ?? null)) changes.note = note;
  if (Object.keys(changes).length === 0) {
    // No-op: nothing actually changed. Do not append an empty amend event.
    return;
  }
  await appendEntryAmended({ entryId: id, changes });
}

export async function getEntry(id: string): Promise<Entry | null> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return null;
  const row = await db.getFirstAsync<Entry>(
    `SELECT id, relationship_id, type, amount_afn, note,
            created_at, updated_at, deleted_at, proposed_by_user_id,
            accepted_at, disputed_at, disputed_reason, settled_at
     FROM entries
     WHERE id = ?
       AND vault_id = ?
       AND deleted_at IS NULL`,
    id,
    vaultId,
  );
  return row ?? null;
}

// Same public API. Sticky tombstone — already-deleted rows short-circuit at
// the event-log layer; missing rows mirror the old "0 rows affected" no-op.
export async function softDeleteEntry(id: string): Promise<void> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSync();
  const current = await db.getFirstAsync<{ is_deleted: number | null }>(
    "SELECT is_deleted FROM entries WHERE id = ? AND vault_id = ?",
    id,
    vaultId,
  );
  if (!current) return;
  if (current.is_deleted === 1) return;
  await appendEntryDeleted({ entryId: id });
}

export async function updatePerson(
  id: string,
  name: string,
  phone: string | null,
  countryCode?: string,
): Promise<UpdatePersonResult> {
  const db = await getDb();
  const vaultId = getActiveVaultIdSync();

  // Cross-vault safety: a stale UI passing a user_id from a different vault
  // must not silently mutate that user globally. Verify the user has at
  // least one active relationship IN THE ACTIVE VAULT before reading their
  // current row.
  const current = await db.getFirstAsync<{
    display_name: string;
    phone_e164: string | null;
  }>(
    `SELECT u.display_name, u.phone_e164
       FROM users u
      INNER JOIN relationships r
         ON r.user_b_id = u.id
        AND r.vault_id  = ?
        AND r.archived_at IS NULL
      WHERE u.id = ?
      LIMIT 1`,
    vaultId,
    id,
  );
  if (!current) {
    // Mirror the pre-rewrite silent no-op on missing id (or id from
    // another vault, which is now indistinguishable from missing).
    return { ok: true };
  }

  let nextPhone: string | null = current.phone_e164;
  let phoneChanged = false;

  if (phone && phone.length > 0) {
    const np = normalizePhone(phone, countryCode);
    if (!np) return { ok: false, error: "phone_invalid" };
    if (np !== (current.phone_e164 ?? null)) {
      const conflict = await findPhoneConflictInVault(np, vaultId, id);
      if (conflict) {
        return {
          ok: false,
          error: "phone_conflict",
          existing: conflict,
        };
      }
      nextPhone = np;
      phoneChanged = true;
    }
  } else if (current.phone_e164 != null) {
    nextPhone = null;
    phoneChanged = true;
  }

  const nameChanged = name !== current.display_name;

  // Emit as separate events when both changed — each event has a single
  // semantic, which is what the backend projection + Phase 4 ACL want.
  if (nameChanged) {
    await appendPersonRenamed({ userId: id, vaultId, name });
  }
  if (phoneChanged) {
    await appendPersonPhoneChanged({
      userId: id,
      vaultId,
      phoneE164: nextPhone,
    });
  }

  return { ok: true };
}

// --- usage counters ---
//
// Local, lifetime-of-pending counts of things the user has done. Mobile
// increments these on every action; on each successful check-in the values
// are sent as DELTAS and then decremented by the snapshot that was sent.
// Subtracting (rather than zeroing) means a concurrent increment between
// the read and the clear isn't lost — it just rides the next check-in.

export type UsageCounter = "entries_created" | "customers_added" | "shares_sent";

const usageKey = (k: UsageCounter) => `usage_pending_${k}`;

export async function bumpUsageCounter(k: UsageCounter): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO app_meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    usageKey(k),
  );
}

export type PendingUsage = Record<UsageCounter, number>;

export async function readPendingUsage(): Promise<PendingUsage> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    `SELECT key, value FROM app_meta WHERE key IN (?, ?, ?)`,
    usageKey("entries_created"),
    usageKey("customers_added"),
    usageKey("shares_sent"),
  );
  const get = (k: UsageCounter): number => {
    const r = rows.find((x) => x.key === usageKey(k));
    return r ? Number(r.value) || 0 : 0;
  };
  return {
    entries_created: get("entries_created"),
    customers_added: get("customers_added"),
    shares_sent: get("shares_sent"),
  };
}

export async function decrementPendingUsage(snapshot: PendingUsage): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const k of ["entries_created", "customers_added", "shares_sent"] as const) {
      const n = snapshot[k];
      if (n <= 0) continue;
      await db.runAsync(
        `UPDATE app_meta SET value = CAST(MAX(0, CAST(value AS INTEGER) - ?) AS TEXT) WHERE key = ?`,
        n,
        usageKey(k),
      );
    }
  });
}

// Thin wrappers around the transaction-aware primitives in db-tx.ts. These
// versions open their own implicit autocommit transaction per call — fine for
// UI banner state, NOT safe for the hlc_last cursor (which uses the *InTx
// variants inside withTransactionAsync).
export async function getAppMeta(key: string): Promise<string | null> {
  const db = await getDb();
  return getAppMetaInTx(db, key);
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  return setAppMetaInTx(db, key, value);
}

// ---------------------------------------------------------------------------
// Vault list helpers — D-ARCHIVED-VAULT-FILTER
//
// Two distinct entry points, never one with a flag:
//
//   listActiveVaults()                 → archived_at IS NULL
//   listAllVaultsIncludingArchived()   → no filter
//
// Returning a flagged-union with `archived: boolean` would push the filter
// to every call site (the v0 mistake we just cleaned up in
// VaultPickerSheet / ProfileSettingsSheet). The split forces the call site
// to declare intent at compile time: "I want the picker list" vs "I want
// the archived-sub-section list". Adding a third surface (e.g. the
// archived-only view) means a third helper, not a third call-site filter.
// ---------------------------------------------------------------------------

export type VaultListRow = {
  id: string;
  name: string;
  archived: boolean;
  archived_at: number | null;
};

export async function listActiveVaults(): Promise<VaultListRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    name: string;
    archived_at: number | null;
  }>(
    `SELECT id, name, archived_at
       FROM vaults
      WHERE archived_at IS NULL
      ORDER BY name COLLATE NOCASE`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    archived: false,
    archived_at: null,
  }));
}

export async function listAllVaultsIncludingArchived(): Promise<VaultListRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    name: string;
    archived_at: number | null;
  }>(
    `SELECT id, name, archived_at
       FROM vaults
      ORDER BY (archived_at IS NULL) DESC, name COLLATE NOCASE`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    archived: r.archived_at != null,
    archived_at: r.archived_at,
  }));
}

// D-ACTIVE-VAULT-REACTIVE: cheap 1-row read for the home-screen safety
// net. Returns the archived_at timestamp (null = active) for one vault
// id. Returns Date.now() (a "treat as archived" sentinel) if the row
// doesn't exist — the caller's fallback path is identical for archived
// and missing rows, so we collapse both into one signal.
export async function getActiveVaultArchivedAt(vaultId: string): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ archived_at: number | null }>(
    `SELECT archived_at FROM vaults WHERE id = ?`,
    vaultId,
  );
  if (!row) return Date.now(); // row missing → treat as archived
  return row.archived_at;
}

// D-DEFENSIVE-ARCHIVED-GUARD: cheap status check used by create-flows
// (entry/new, person/new, home FAB) to refuse writes when the active
// vault has been archived out from under the user — e.g. a remote
// vault_setting_set landed via mesh between the screen load and the
// user tap. Returns:
//   - { state: "none" }       → no active vault id at all
//   - { state: "archived" }   → active vault exists but archived_at is set
//   - { state: "ok" }         → active vault is writable
// Resolves to "none" if the vault row is missing (e.g. ledger reset).
export async function getActiveVaultArchivedState(): Promise<
  { state: "none" } | { state: "archived" } | { state: "ok" }
> {
  const vaultId = getActiveVaultIdSyncMaybe();
  if (!vaultId) return { state: "none" };
  const db = await getDb();
  const row = await db.getFirstAsync<{ archived_at: number | null }>(
    `SELECT archived_at FROM vaults WHERE id = ?`,
    vaultId,
  );
  if (!row) return { state: "none" };
  return row.archived_at != null ? { state: "archived" } : { state: "ok" };
}
