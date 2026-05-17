import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { normalizePhone } from "./phone";
import type {
  CreateCustomerResult,
  CustomerWithBalance,
  Entry,
  EntryType,
  Self,
  Shopkeeper,
  UpdateCustomerResult,
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
  // PRAGMA doesn't accept bound parameters; table name comes from a const, not user input.
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

// Migration 001: v0 (shopkeeper/customers/entries) -> v1 (users/shop_profile/relationships/entries-new).
// Atomic via a single transaction. Old data is preserved by migration; `_old_shopkeeper`
// is retained as a safety copy for one release.
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

        // Reuse the v0 customer.id as the new user.id so any retained
        // reference (deep link, cached route param) still resolves.
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
        if (!relId) continue; // orphan entry — skip
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

      // Persist phone-drop counters for the next check-in to telemetry.
      // Only write the keys when a count is non-zero so app_meta stays
      // empty when there's nothing to report.
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

// Migration 002: add `updated_at` to users, shop_profile, relationships, entries.
// Idempotent — checks each table for the column first, ALTERs only if missing,
// then backfills updated_at = created_at. Fresh installs (where 001 already
// created the column) skip the ALTERs and just record the migration.
async function runMigration002(db: SQLite.SQLiteDatabase): Promise<void> {
  const tables = ["users", "shop_profile", "relationships", "entries"] as const;
  await db.withTransactionAsync(async () => {
    for (const t of tables) {
      if (!(await tableExists(db, t))) continue;
      if (await columnExists(db, t, "updated_at")) continue;
      // SQLite ALTER TABLE ADD COLUMN with NOT NULL requires a constant default.
      // We seed with 0 and immediately backfill from created_at.
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

async function findRelationshipIdForCustomer(
  db: SQLite.SQLiteDatabase,
  customerUserId: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM relationships
     WHERE user_b_id = ? AND context = 'customer'
     LIMIT 1`,
    customerUserId,
  );
  return row?.id ?? null;
}

// --- public API (signatures preserved from v0) ---

export async function getShopkeeper(): Promise<Shopkeeper | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Shopkeeper>(
    "SELECT id, shop_name, owner_name, created_at FROM shop_profile WHERE id = 1",
  );
  return row ?? null;
}

// The local user's identity (always present once onboarded). Shop is optional —
// when the user didn't enter a store name, shop_name is null.
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

// Creates the local user (name required) and optionally a shop_profile
// (only when shopName is provided).
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

// Returns a discriminated result so the screen can surface targeted errors
// for unparseable phones and phone collisions instead of silently dropping
// the phone to NULL.
export async function createCustomer(
  name: string,
  phone: string | null,
): Promise<CreateCustomerResult> {
  const db = await getDb();
  const localSelf = await getLocalSelfUserId(db);
  if (!localSelf) throw new Error("local user not yet created");

  let phoneE164: string | null = null;
  if (phone && phone.length > 0) {
    const np = normalizePhone(phone);
    if (!np) {
      return { ok: false, error: "phone_invalid" };
    }
    const conflict = await db.getFirstAsync<{ id: string; display_name: string }>(
      "SELECT id, display_name FROM users WHERE phone_e164 = ?",
      np,
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
       VALUES (?, ?, ?, 'customer', ?, ?)`,
      relId,
      localSelf,
      id,
      now,
      now,
    );
  });
  return { ok: true, id };
}

export async function listCustomersWithBalances(): Promise<CustomerWithBalance[]> {
  const db = await getDb();
  return db.getAllAsync<CustomerWithBalance>(`
    SELECT u.id            AS id,
           u.display_name  AS name,
           u.phone_e164    AS phone,
           u.created_at    AS created_at,
           r.archived_at   AS archived_at,
           COALESCE(SUM(CASE
             WHEN e.deleted_at IS NULL AND e.type = 'debt' THEN -e.amount_afn
             WHEN e.deleted_at IS NULL AND e.type = 'payment' THEN e.amount_afn
             ELSE 0
           END), 0) AS balance
    FROM relationships r
    INNER JOIN users u ON u.id = r.user_b_id
    LEFT JOIN entries e ON e.relationship_id = r.id
    WHERE r.context = 'customer' AND r.archived_at IS NULL
    GROUP BY u.id
    ORDER BY balance ASC, u.display_name ASC
  `);
}

// `id` is the user_id (what screens think of as the customer id).
export async function getCustomer(id: string): Promise<CustomerWithBalance | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<CustomerWithBalance>(
    `SELECT u.id            AS id,
            u.display_name  AS name,
            u.phone_e164    AS phone,
            u.created_at    AS created_at,
            r.archived_at   AS archived_at,
            COALESCE(SUM(CASE
              WHEN e.deleted_at IS NULL AND e.type = 'debt' THEN -e.amount_afn
              WHEN e.deleted_at IS NULL AND e.type = 'payment' THEN e.amount_afn
              ELSE 0
            END), 0) AS balance
     FROM relationships r
     INNER JOIN users u ON u.id = r.user_b_id
     LEFT JOIN entries e ON e.relationship_id = r.id
     WHERE r.context = 'customer' AND u.id = ?
     GROUP BY u.id`,
    id,
  );
  return row ?? null;
}

// Archives the relationship (not the user), since a user may have multiple
// relationships in Phase 2+.
export async function archiveCustomer(id: string): Promise<void> {
  const db = await getDb();
  const relId = await findRelationshipIdForCustomer(db, id);
  if (!relId) return;
  const now = Date.now();
  await db.runAsync(
    "UPDATE relationships SET archived_at = ?, updated_at = ? WHERE id = ?",
    now,
    now,
    relId,
  );
}

// `customerId` is the user_id (the "customer id" from the screen's perspective).
export async function listEntries(customerId: string): Promise<Entry[]> {
  const db = await getDb();
  return db.getAllAsync<Entry>(
    `SELECT e.id, e.relationship_id, e.type, e.amount_afn, e.note,
            e.created_at, e.deleted_at, e.proposed_by_user_id,
            e.accepted_at, e.disputed_at, e.disputed_reason, e.settled_at
     FROM entries e
     INNER JOIN relationships r ON r.id = e.relationship_id
     WHERE r.user_b_id = ? AND r.context = 'customer' AND e.deleted_at IS NULL
     ORDER BY e.created_at DESC`,
    customerId,
  );
}

// Generates a fresh entry id internally. `customerId` is the user_id.
export async function createEntry(
  customerId: string,
  type: EntryType,
  amountAfn: number,
  note: string | null,
): Promise<string> {
  const db = await getDb();
  const relId = await findRelationshipIdForCustomer(db, customerId);
  if (!relId) throw new Error(`no relationship for customer ${customerId}`);
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
  return id;
}

// Edits an existing entry's amount and/or note. Type cannot change — wrong
// type means delete and recreate.
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

// Edits a customer's name and/or phone. Returns the same Result shape as
// createCustomer so the screen can render the same phone errors.
export async function updateCustomer(
  id: string,
  name: string,
  phone: string | null,
): Promise<UpdateCustomerResult> {
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
