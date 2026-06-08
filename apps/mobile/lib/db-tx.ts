// Low-level DB primitives shared by db.ts and event-log.ts.
//
// Exists for one reason: event-log.ts needs the bare db handle, transactional
// app_meta read/write, and the cached install_id + local-self user_id so the
// HLC tick + event_log INSERT + projection update + hlc_last write can all sit
// inside ONE withTransactionAsync() call. db.ts also needs every one of those
// primitives. Putting them here lets db.ts import the public appendEntry*
// helpers from event-log.ts without forming a cycle (db.ts -> event-log.ts ->
// db-tx.ts; event-log.ts -> db-tx.ts only).
//
// Anything in this file is intentionally small, sync-or-trivial, and free of
// business logic. Migrations, projection queries, person CRUD, etc. all stay
// in db.ts.

import * as SQLite from "expo-sqlite";

// ---------- db handle (singleton, lazy) ----------

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("kaata.db");
  }
  return dbPromise;
}

// Used by resetAllLocalData() in db.ts to drop the cached handle after closing.
export function _resetDbHandleForReset(): void {
  dbPromise = null;
}

// Re-export the database type for consumers that want to type a "tx" parameter.
// expo-sqlite's withTransactionAsync callback does NOT receive a separate tx
// object — the outer `db` handle IS the transaction inside the callback, which
// is fine because WAL mode + the single shared connection give us serial
// semantics. We just type any "must run inside a transaction" function as
// taking SQLiteDatabase, which both inside-tx and outside-tx callers can pass.
export type SQLiteTx = SQLite.SQLiteDatabase;

// ---------- transactional app_meta ----------
//
// The exported getAppMeta / setAppMeta in db.ts open their own implicit
// transaction (single runAsync / getFirstAsync). That's fine for the install
// banner UI but unsafe for hlc_last, which MUST be read at the start of the
// event-append transaction and written before commit. Callers inside a
// withTransactionAsync block use these variants instead, passing the same
// db handle so the read/write joins the parent transaction.

export async function getAppMetaInTx(tx: SQLiteTx, key: string): Promise<string | null> {
  const row = await tx.getFirstAsync<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

export async function setAppMetaInTx(tx: SQLiteTx, key: string, value: string): Promise<void> {
  await tx.runAsync(
    "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

// ---------- sync-cached identity (install_id + local-self users.id) ----------
//
// appendEvent runs on every entry write — at the worst on a tight burst from a
// shopkeeper banging in 12 entries during a customer's visit. We don't want to
// pay a SELECT on app_meta + a SELECT on users for each one. ensureInstallId()
// is awaited once during _layout.tsx boot, so install_id is guaranteed-loaded
// by the time the first user-driven write fires. getLocalSelf() is awaited in
// the same boot block. We cache both via setters called from those code paths
// and a synchronous getter for the hot path.
//
// If a caller hits the hot path before boot has primed the cache (e.g. a unit
// test, or a write-on-app-cold-start race), the sync getter throws — callers
// MUST await primeIdentityCache(...) first. We considered making the getter
// async, but that means the event-log transaction can't read it inside
// withTransactionAsync without a second await, which complicates the txn
// boundary.

let cachedInstallId: string | null = null;
let cachedLocalSelfUserId: string | null = null;

export function setInstallIdCache(id: string): void {
  cachedInstallId = id;
}

export function setLocalSelfUserIdCache(id: string | null): void {
  cachedLocalSelfUserId = id;
}

export function getInstallIdSync(): string {
  if (!cachedInstallId) {
    throw new Error(
      "install_id not cached — call ensureInstallId() and setInstallIdCache() during boot before any event append",
    );
  }
  return cachedInstallId;
}

// Returns null when no local-self user has been created yet (pre-onboarding).
// Event-log callers refuse to append in that case — there is no author to
// stamp on author_user_id_local_only.
export function getLocalSelfUserIdSync(): string | null {
  return cachedLocalSelfUserId;
}

// Async helper used during boot AND from db.ts's createSelfProfile() right
// after the first users row is inserted, so the cache is hot before the
// first event append fires.
export async function refreshLocalSelfUserIdCache(): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM users WHERE is_local_self = 1 LIMIT 1",
  );
  cachedLocalSelfUserId = row?.id ?? null;
  return cachedLocalSelfUserId;
}

// ---------- active vault cache ----------
//
// active_vault_id is the vault every read/write filters by. In Phase 2 the UI
// is single-vault — Migration 007 created a "default" vault per install and
// wrote its id to app_meta.active_vault_id during the same transaction that
// backfilled every existing entries.vault_id / relationships.vault_id row.
//
// Like install_id, this is hot-path: every listPeople / getPerson / listEntries
// needs it. We prime the cache once during boot (primeActiveVaultId, awaited
// from _layout.tsx right after initDb) and serve it synchronously thereafter.
//
// On a brand-new install before onboarding completes, the cache may legitimately
// be null — there's no vault yet, and listAllPeople()/etc shouldn't crash. The
// sync getter throws ONLY if a caller tries to use it before priming for an
// install that HAS a vault. For pre-vault state, callers use the maybe variant.

export const ACTIVE_VAULT_META_KEY = "active_vault_id";

let cachedActiveVaultId: string | null = null;

export function setActiveVaultIdCache(id: string | null): void {
  cachedActiveVaultId = id;
}

export function getActiveVaultIdSyncMaybe(): string | null {
  return cachedActiveVaultId;
}

export function getActiveVaultIdSync(): string {
  if (!cachedActiveVaultId) {
    throw new Error(
      "active_vault_id not cached — Migration 007 must have run and primeActiveVaultId() must have been awaited during boot",
    );
  }
  return cachedActiveVaultId;
}

export async function getActiveVaultId(): Promise<string | null> {
  if (cachedActiveVaultId) return cachedActiveVaultId;
  const db = await getDb();
  const value = await getAppMetaInTx(db, ACTIVE_VAULT_META_KEY);
  if (!value) return null;
  cachedActiveVaultId = value;
  return value;
}

// Primes the cache from app_meta. Called from _layout.tsx after initDb() so
// every subsequent sync read in db.ts / event-log.ts can rely on it. Safe
// to call multiple times. Returns null when no vault exists yet (pre-
// onboarding / pre-sign-in fresh install).
export async function primeActiveVaultId(): Promise<string | null> {
  return getActiveVaultId();
}

// Switches the active vault (Phase 4 vault picker; Phase 2 UI does not call
// this). Persists to app_meta AND updates the cache atomically. The cache
// update lives inside the awaited block of withTransactionAsync so it only
// runs after the SQLite txn commits — if the runAsync fails, the cache stays
// pointed at the previous (still-correct) vault id.
export async function setActiveVaultId(id: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await setAppMetaInTx(db, ACTIVE_VAULT_META_KEY, id);
    cachedActiveVaultId = id;
  });
}

// Clears the active vault pointer. Used by the archive-last-vault flow
// (vault/settings.tsx onArchive) when no surviving non-archived vault
// exists, so subsequent reads of active_vault_id resolve to null and the
// UI prompts the user to create / restore a Kaata. Deletes the row from
// app_meta — leaving an explicit `("active_vault_id", "")` would leak a
// confusing sentinel into debugging tools and the next migration; the
// next call to getActiveVaultId() correctly returns null on a missing
// row. Cache is nulled inside the same txn-callback so it commits in
// lockstep with the persisted state.
export async function clearActiveVaultId(): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM app_meta WHERE key = ?", ACTIVE_VAULT_META_KEY);
    cachedActiveVaultId = null;
  });
}

// Used by resetAllLocalData() after dropping tables so the next initDb()
// + primeActiveVaultId() picks up the fresh state.
export function _resetActiveVaultIdCacheForReset(): void {
  cachedActiveVaultId = null;
}

// ---------- account_id cache ----------
//
// After a successful Google sign-in we cache the account_id (server's UUID
// for the Google identity) so that every event_log INSERT can stamp
// actor_account_id directly, instead of relying on the post-hoc
// account_bound retroactive re-stamping. The retroactive event still ships
// for the events authored BEFORE sign-in; events authored AFTER sign-in
// carry their own actor_account_id and don't need re-attribution.

let cachedAccountId: string | null = null;

export function setAccountIdCache(id: string | null): void {
  cachedAccountId = id;
}

// Returns null when the user has not signed in yet — every event append
// stamps actor_account_id with this value (null pre-sign-in, the account
// UUID afterwards). Pre-sign-in events are retroactively re-stamped by
// the account_bound event on the backend.
export function getAccountIdSync(): string | null {
  return cachedAccountId;
}

// Async helper: primes the cache from app_meta. Called from boot AND from
// auth.ts postSignInHousekeeping after a successful sign-in.
export async function refreshAccountIdCache(): Promise<string | null> {
  const db = await getDb();
  const v = await getAppMetaInTx(db, "account_id");
  cachedAccountId = v;
  return v;
}

// Used by resetAllLocalData().
export function _resetAccountIdCacheForReset(): void {
  cachedAccountId = null;
}
