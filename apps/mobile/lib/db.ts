import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
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

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("kaata.db");
  }
  return dbPromise;
}

const MIGRATION_001 = "001_v0_to_users_relationships";
const MIGRATION_002 = "002_add_updated_at";
const MIGRATION_003 = "003_unify_relationships_to_peer";

export async function initDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
    await runMigration001(db);
  }
  if (!(await hasRunMigration(db, MIGRATION_002))) {
    await runMigration002(db);
  }
  if (!(await hasRunMigration(db, MIGRATION_003))) {
    await runMigration003(db);
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
  // After migration_003 every active relationship is 'peer'. We don't filter by
  // context here so any straggler (customer/supplier rel that somehow survived)
  // still works — the migration is exhaustive but this query stays robust.
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM relationships
     WHERE user_b_id = ? AND archived_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    personId,
  );
  return row?.id ?? null;
}

// --- public API ---

export async function getLocalSelf(): Promise<Self | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Self>(
    `SELECT u.id           AS user_id,
            u.display_name AS name,
            sp.shop_name   AS shop_name
     FROM users u
     LEFT JOIN shop_profile sp ON sp.user_id = u.id AND sp.id = 1
     WHERE u.is_local_self = 1
     LIMIT 1`,
  );
  return row ?? null;
}

export async function createSelfProfile(name: string, shopName: string | null): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const userId = Crypto.randomUUID();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "INSERT INTO users (id, display_name, is_local_self, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
      userId,
      name,
      now,
      now,
    );
    if (shopName) {
      await db.runAsync(
        "INSERT INTO shop_profile (id, user_id, shop_name, owner_name, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
        userId,
        shopName,
        name,
        now,
        now,
      );
    }
  });
}

// Updates the local-self user's display name and shop name. Both can be edited
// independently from /settings after onboarding. Setting shopName to null clears
// any existing shop_profile row; setting it to a string upserts the row.
export async function updateSelfProfile(name: string, shopName: string | null): Promise<void> {
  const db = await getDb();
  const self = await getLocalSelfUserId(db);
  if (!self) throw new Error("local user not yet created");
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?",
      name,
      now,
      self,
    );
    if (shopName && shopName.length > 0) {
      await db.runAsync(
        `INSERT INTO shop_profile (id, user_id, shop_name, owner_name, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET shop_name = excluded.shop_name,
                                       owner_name = excluded.owner_name,
                                       updated_at = excluded.updated_at`,
        self,
        shopName,
        name,
        now,
        now,
      );
    } else {
      await db.runAsync("DELETE FROM shop_profile WHERE id = 1");
    }
  });
}

// Creates a person with a single 'peer' relationship — no direction needed.
// The balance and tab placement emerge from entries added later.
export async function createPerson(
  name: string,
  phone: string | null,
): Promise<CreatePersonResult> {
  const db = await getDb();
  const localSelf = await getLocalSelfUserId(db);
  if (!localSelf) throw new Error("local user not yet created");

  let phoneE164: string | null = null;
  if (phone && phone.length > 0) {
    const np = normalizePhone(phone);
    if (!np) {
      return { ok: false, error: "phone_invalid" };
    }
    const existing = await db.getFirstAsync<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE phone_e164 = ?",
      np,
    );
    if (existing) {
      return {
        ok: false,
        error: "phone_conflict",
        existing: { id: existing.id, name: existing.display_name },
      };
    }
    phoneE164 = np;
  }

  const id = Crypto.randomUUID();
  const now = Date.now();
  const relId = Crypto.randomUUID();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "INSERT INTO users (id, phone_e164, display_name, is_local_self, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
      id,
      phoneE164,
      name,
      now,
      now,
    );
    await db.runAsync(
      `INSERT INTO relationships (id, user_a_id, user_b_id, context, created_at, updated_at)
       VALUES (?, ?, ?, 'peer', ?, ?)`,
      relId,
      localSelf,
      id,
      now,
      now,
    );
  });
  await bumpUsageCounter("customers_added");
  return { ok: true, id };
}

async function selectAllPeopleRaw(db: SQLite.SQLiteDatabase): Promise<PersonWithBalance[]> {
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
     LEFT JOIN entries e ON e.relationship_id = r.id
     WHERE r.archived_at IS NULL
     GROUP BY u.id`,
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
     LEFT JOIN entries e ON e.relationship_id = r.id
     WHERE u.id = ? AND r.archived_at IS NULL
     GROUP BY u.id
     LIMIT 1`,
    id,
  );
  return row ?? null;
}

// Archives every active relationship for the person and frees their phone
// number for re-use. We null out users.phone_e164 because of the UNIQUE
// constraint — without this, a shopkeeper who removes Ahmad and later
// re-adds him with the same number would hit phone_conflict and be unable
// to re-add anyone with that number ever again. Entries stay on disk
// attached to the (now archived) relationship, so the history isn't lost.
export async function archivePerson(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      "UPDATE relationships SET archived_at = ?, updated_at = ? WHERE user_b_id = ? AND archived_at IS NULL",
      now,
      now,
      id,
    );
    await db.runAsync("UPDATE users SET phone_e164 = NULL, updated_at = ? WHERE id = ?", now, id);
  });
}

export async function listEntries(personId: string): Promise<Entry[]> {
  const db = await getDb();
  return db.getAllAsync<Entry>(
    `SELECT e.id, e.relationship_id, e.type, e.amount_afn, e.note,
            e.created_at, e.updated_at, e.deleted_at, e.proposed_by_user_id,
            e.accepted_at, e.disputed_at, e.disputed_reason, e.settled_at
     FROM entries e
     INNER JOIN relationships r ON r.id = e.relationship_id
     WHERE r.user_b_id = ? AND r.archived_at IS NULL AND e.deleted_at IS NULL
     ORDER BY e.created_at DESC`,
    personId,
  );
}

export async function createEntry(
  personId: string,
  type: EntryType,
  amountAfn: number,
  note: string | null,
): Promise<string> {
  const db = await getDb();
  const relId = await findRelationshipIdForPerson(db, personId);
  if (!relId) throw new Error(`no active relationship for person ${personId}`);
  const localSelf = await getLocalSelfUserId(db);
  const id = Crypto.randomUUID();
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO entries (id, relationship_id, type, amount_afn, note, created_at, updated_at, proposed_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    relId,
    type,
    amountAfn,
    note,
    now,
    now,
    localSelf,
  );
  await bumpUsageCounter("entries_created");
  return id;
}

export async function updateEntry(
  id: string,
  amountAfn: number,
  note: string | null,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE entries SET amount_afn = ?, note = ?, updated_at = ? WHERE id = ?",
    amountAfn,
    note,
    Date.now(),
    id,
  );
}

export async function getEntry(id: string): Promise<Entry | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Entry>(
    `SELECT id, relationship_id, type, amount_afn, note,
            created_at, updated_at, deleted_at, proposed_by_user_id,
            accepted_at, disputed_at, disputed_reason, settled_at
     FROM entries WHERE id = ? AND deleted_at IS NULL`,
    id,
  );
  return row ?? null;
}

export async function softDeleteEntry(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync("UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?", now, now, id);
}

export async function updatePerson(
  id: string,
  name: string,
  phone: string | null,
): Promise<UpdatePersonResult> {
  const db = await getDb();

  let phoneE164: string | null = null;
  if (phone && phone.length > 0) {
    const np = normalizePhone(phone);
    if (!np) return { ok: false, error: "phone_invalid" };
    const conflict = await db.getFirstAsync<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE phone_e164 = ? AND id != ?",
      np,
      id,
    );
    if (conflict) {
      return {
        ok: false,
        error: "phone_conflict",
        existing: { id: conflict.id, name: conflict.display_name },
      };
    }
    phoneE164 = np;
  }

  await db.runAsync(
    "UPDATE users SET display_name = ?, phone_e164 = ?, updated_at = ? WHERE id = ?",
    name,
    phoneE164,
    Date.now(),
    id,
  );
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

export async function getAppMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function setAppMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}
