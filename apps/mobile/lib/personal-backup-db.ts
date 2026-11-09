// Portable copies are data, never a login or permission grant. Only the copy
// is sanitized. Installation happens on the next boot, before getDb opens.
import { File } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { sha256 } from "@noble/hashes/sha256";
import { BACKEND_URL_FALLBACK } from "../constants/env";
import {
  captureCurrentSession,
  applyForUnchangedLocalSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import { DB_NAME, getDb } from "./db-tx";
import {
  BACKUP_DATABASE_LIMIT,
  DriveBackupTooLargeError,
  readDriveBackupTables,
} from "./drive-backup";
import {
  PERSONAL_BACKUP_EXPORT as EXPORT,
  PERSONAL_BACKUP_JOINED_RECOVERY_KEY,
  PERSONAL_BACKUP_RESTORE_STAGE as STAGE,
  PERSONAL_BACKUP_RESTORE_MARKER as RECEIPT,
  PERSONAL_BACKUP_RESTORE_MARKER_SCRATCH as RECEIPT_SCRATCH,
  PERSONAL_BACKUP_RESTORE_PARKED as PARKED,
} from "./db-backup";
import { buildLocalAccountId } from "./trust/account-id";
export type PersonalBackupErrorCode =
  | "ownership"
  | "ownershipUnavailable"
  | "noOwnedVaults"
  | "differentAccount"
  | "notEmpty"
  | "invalid"
  | "empty"
  | "unsupported"
  | "tooLarge"
  | "sessionChanged"
  | "busy";
export class PersonalBackupError extends Error {
  constructor(public readonly code: PersonalBackupErrorCode) {
    super(code);
    this.name = "PersonalBackupError";
  }
}
const INFO = "personal_backup_info";
const ORIGINAL_SCHEMA = "051_tally_removal_requests";
const TALLY_NOTES_SCHEMA = "052_tally_notes";
const TALLY_NOTE_NUMBERS_SCHEMA = "053_tally_note_number";
const SHARED_INVITATION_DECLINE_SCHEMA = "054_shared_invitation_decline";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMBER_ROLES = new Set(["manager", "editor", "clerk", "viewer"]);
const TABLES = new Set([
  "app_meta",
  "schema_migrations",
  "users",
  "shop_profile",
  "relationships",
  "entries",
  "tally_notes",
  "event_log",
  "vaults",
  "vault_members_mirror",
  "sync_state",
  "projection_conflicts",
  "pending_invitations",
  "vault_settings",
  "vault_credentials",
  "revocation_list",
  "mem_samples",
  "crash_outbox",
  "vault_device_registry",
  "settlements",
  "tab_links",
  "tab_entries",
  "tab_outbox",
  "tab_failed_ops",
  "tab_settlements",
  "vault_member_profiles",
  "customer_credit_limits",
  "credit_admission_intents",
  "customer_groups",
  "customer_reminders",
  "kaata_credit_defaults",
  "vault_member_credit_permissions",
  "credit_mutation_baselines",
  "credit_alert_policies",
  "customer_credit_limit_notifications",
  INFO,
]);
const KEEP_META = new Set([
  "account_id",
  "active_vault_id",
  "default_vault_id",
  "onboarding_step",
  "locale",
  "app_locale",
  "locale_pref",
  "calendar_pref",
  "qamari_offset",
  "default_currency",
  "share_lang_pref",
  "theme",
  "calendar",
  "calendar_mode",
  "number_style",
  "hlc_last",
  "mesh_device_ed25519_pubkey",
  "retired_device_pubkeys",
]);
const TARGET_META = [
  "install_id",
  "installed_at_unix_ms",
  "backend_url_override",
  "mesh_server_pubkey_primary",
  "mesh_server_pubkey_rotation",
  "mesh_server_pubkey_pinned_at_ms",
];
const CLEAR_TABLES = [
  "pending_invitations",
  "projection_conflicts",
  "vault_credentials",
  "mem_samples",
  "crash_outbox",
  "vault_member_profiles",
  "customer_reminders",
  "sync_state",
];
type DB = SQLite.SQLiteDatabase;
type Meta = Map<string, string>;
type Vault = {
  id: string;
  account_id: string | null;
  registered_with_server_at: number | null;
  vault_trust_anchor_pubkey: string | null;
  is_default: number;
  archived_at: number | null;
};
type CloudVault = { role: string; vault_trust_anchor_pubkey?: unknown };
export type PersonalBackupCoverage = {
  included: number;
  skipped: number;
  skippedPending: number;
};
type BackupInfo = {
  version: 1;
  accountId: string | null;
  createdAt: number;
};
type Receipt = {
  version: 1;
  hash: string;
  accountId: string | null;
  installId: string;
  installedAt: string;
};
type CatalogRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};
let running = false;
let exportHeld = false;
function fail(code: PersonalBackupErrorCode): never {
  throw new PersonalBackupError(code);
}
function file(name: string): File {
  const directory = SQLite.defaultDatabaseDirectory;
  return new File(directory.startsWith("file://") ? directory : `file://${directory}`, name);
}
function remove(name: string): void {
  const f = file(name);
  if (f.exists) f.delete();
}
function removeDatabase(name: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) remove(name + suffix);
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
}
function hashFile(name: string): string {
  return hex(sha256(file(name).bytesSync()));
}
function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
function sqlTokens(sql: string | null): string[] {
  // Preserve literal contents; whitespace or case inside a CHECK literal is
  // meaningful. Ignore only harmless identifier quoting/formatting.
  return (
    (sql ?? "").match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w]*|\d+|[^\s;]/g,
    ) ?? []
  ).map((token) =>
    token.startsWith("'") ? token : token.replace(/^["`\[]|["`\]]$/g, "").toLowerCase(),
  );
}
function normalizedSQL(sql: string | null): string {
  return sqlTokens(sql).join(" ");
}
function tableDefinition(sql: string | null, omittedColumn?: string): string {
  const tokens = sqlTokens(sql),
    start = tokens.indexOf("(");
  if (start < 0) fail("unsupported");
  const definitions: string[] = [];
  let depth = 1,
    part: string[] = [],
    end = start;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (depth === 0) {
      definitions.push(part.join(" "));
      end = index;
      break;
    }
    if (token === "," && depth === 1) {
      definitions.push(part.join(" "));
      part = [];
    } else part.push(token);
  }
  if (depth !== 0) fail("unsupported");
  // ALTER TABLE appends columns; fresh installs may declare those columns
  // earlier. Preserve every constraint/expression while ignoring that order.
  return JSON.stringify({
    definitions: definitions.filter((definition) => definition !== omittedColumn).sort(),
    options: tokens.slice(end + 1),
  });
}
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (running || exportHeld) fail("busy");
  running = true;
  try {
    return await work();
  } catch (error) {
    if (error instanceof PersonalBackupError) throw error;
    if (error instanceof SessionChangedError) fail("sessionChanged");
    const wrapped = new PersonalBackupError("invalid");
    (
      wrapped as Error & {
        cause?: unknown;
      }
    ).cause = error;
    throw wrapped;
  } finally {
    running = false;
  }
}
async function open(name: string): Promise<DB> {
  const db = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
  try {
    await db.execAsync("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
async function tables(db: DB): Promise<Set<string>> {
  return new Set(
    (
      await db.getAllAsync<{
        name: string;
      }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    ).map((row) => row.name),
  );
}
async function meta(db: DB): Promise<Meta> {
  if (!(await tables(db)).has("app_meta")) return new Map();
  return new Map(
    (
      await db.getAllAsync<{
        key: string;
        value: string;
      }>("SELECT key,value FROM app_meta")
    ).map((row) => [row.key, row.value]),
  );
}
async function setMeta(db: DB, key: string, value: string): Promise<void> {
  await db.runAsync(
    "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    key,
    value,
  );
}
async function count(db: DB, name: string): Promise<number> {
  if (!(await tables(db)).has(name)) return 0;
  return (
    (
      await db.getFirstAsync<{
        n: number;
      }>(`SELECT COUNT(*) AS n FROM ${quote(name)}`)
    )?.n ?? 0
  );
}
async function integrity(db: DB): Promise<void> {
  const result = await db.getAllAsync<Record<string, string>>("PRAGMA quick_check");
  if (result.length !== 1 || Object.values(result[0])[0] !== "ok") fail("invalid");
  if ((await db.getAllAsync("PRAGMA foreign_key_check")).length) fail("invalid");
}
async function catalog(db: DB): Promise<CatalogRow[]> {
  return db.getAllAsync<CatalogRow>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  );
}
async function validateSchema(db: DB, trusted?: DB): Promise<void> {
  const items = await catalog(db);
  const names = new Set(items.filter((r) => r.type === "table").map((r) => r.name));
  for (const required of [
    "app_meta",
    "schema_migrations",
    "users",
    "vaults",
    "vault_members_mirror",
    "event_log",
    "relationships",
    "entries",
  ])
    if (!names.has(required)) fail("unsupported");
  for (const item of items) {
    if (
      (!TABLES.has(item.tbl_name) && item.tbl_name !== "_old_shopkeeper") ||
      !["table", "index", "trigger"].includes(item.type) ||
      /\bVIRTUAL\s+TABLE\b/i.test(item.sql ?? "")
    )
      fail("unsupported");
    if (
      item.type === "trigger" &&
      ![
        "event_log_state_machine_insert",
        "event_log_state_machine_update",
        "vaults_freeze_legacy_currency",
      ].includes(item.name)
    )
      fail("unsupported");
  }
  const migrations = await db.getAllAsync<{
    name: string;
  }>("SELECT name FROM schema_migrations");
  const hasTallyNotes = migrations.some((row) => row.name === TALLY_NOTES_SCHEMA);
  const hasTallyNoteNumbers = migrations.some((row) => row.name === TALLY_NOTE_NUMBERS_SCHEMA);
  const hasSharedInvitationDecline = migrations.some(
    (row) => row.name === SHARED_INVITATION_DECLINE_SCHEMA,
  );
  const expectedMigrations = hasSharedInvitationDecline
    ? 54
    : hasTallyNoteNumbers
      ? 53
      : hasTallyNotes
        ? 52
        : 51;
  if (
    migrations.length !== expectedMigrations ||
    !migrations.some((row) => row.name === ORIGINAL_SCHEMA) ||
    (hasTallyNoteNumbers && !hasTallyNotes) ||
    (hasSharedInvitationDecline && !hasTallyNoteNumbers) ||
    names.has("tally_notes") !== hasTallyNotes ||
    new Set(migrations.map((r) => r.name.slice(0, 3))).size !== expectedMigrations ||
    migrations.some(
      (r) =>
        !/^\d{3}_/.test(r.name) ||
        Number(r.name.slice(0, 3)) < 1 ||
        Number(r.name.slice(0, 3)) > expectedMigrations,
    )
  )
    fail("unsupported");
  if (hasTallyNotes) {
    const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_xinfo(tally_notes)");
    if (columns.some((column) => column.name === "number_text") !== hasTallyNoteNumbers)
      fail("unsupported");
  }
  const tabLinkColumns = await db.getAllAsync<{ name: string }>("PRAGMA table_xinfo(tab_links)");
  if (
    tabLinkColumns.some((column) => column.name === "invitation_declined_at") !==
    hasSharedInvitationDecline
  )
    fail("unsupported");
  if (trusted) {
    // Older backups keep their original schema until initDb upgrades it.
    const known = (await catalog(trusted)).filter(
      (row) => hasTallyNotes || row.tbl_name !== "tally_notes",
    );
    const trustedMigrations = await trusted.getAllAsync<{
      name: string;
    }>("SELECT name FROM schema_migrations ORDER BY name");
    if (
      JSON.stringify(migrations.map((r) => r.name).sort()) !==
      JSON.stringify(
        trustedMigrations
          .map((row) => row.name)
          .filter((name) => hasTallyNotes || name !== TALLY_NOTES_SCHEMA)
          .filter((name) => hasTallyNoteNumbers || name !== TALLY_NOTE_NUMBERS_SCHEMA)
          .filter(
            (name) => hasSharedInvitationDecline || name !== SHARED_INVITATION_DECLINE_SCHEMA,
          ),
      )
    )
      fail("unsupported");
    const keys = (rows: CatalogRow[]) =>
      rows
        .filter((r) => r.tbl_name !== INFO && r.tbl_name !== "_old_shopkeeper")
        .map((r) => r.type + ":" + r.name)
        .sort();
    if (JSON.stringify(keys(items)) !== JSON.stringify(keys(known))) fail("unsupported");
    for (const item of items) {
      if (item.name === INFO) continue;
      const prior = known.find((r) => r.name === item.name && r.type === item.type);
      if (!prior) fail("unsupported");
      // Includes CHECK, FK, UNIQUE, STRICT and table options, not just columns.
      if (item.type === "table") {
        const omittedColumn =
          item.name === "tally_notes" && !hasTallyNoteNumbers
            ? { name: "number_text", definition: "number_text text" }
            : item.name === "tab_links" && !hasSharedInvitationDecline
              ? { name: "invitation_declined_at", definition: "invitation_declined_at integer" }
              : undefined;
        if (tableDefinition(prior.sql, omittedColumn?.definition) !== tableDefinition(item.sql))
          fail("unsupported");
        const shape = async (handle: DB, omittedName?: string) =>
          (
            await handle.getAllAsync<Record<string, unknown>>(
              `PRAGMA table_xinfo(${quote(item.name)})`,
            )
          )
            .filter((row) => row.name !== omittedName)
            .map(({ cid, ...row }) => row)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (
          JSON.stringify(await shape(db)) !==
          JSON.stringify(await shape(trusted, omittedColumn?.name))
        )
          fail("unsupported");
      } else if (normalizedSQL(prior.sql) !== normalizedSQL(item.sql)) fail("unsupported");
    }
  }
}
function accountFromJWT(jwt: string | null): string | null {
  if (!jwt) return null;
  try {
    const body = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const account = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, "="))).account_id;
    if (typeof account !== "string" || !UUID.test(account)) fail("differentAccount");
    return account;
  } catch {
    return fail("differentAccount");
  }
}
function matchSession(
  values: Meta,
  session: SessionSnapshot,
  expected?: string | null,
): string | null {
  const bound = values.get("account_id") || null;
  const jwtAccount = accountFromJWT(session.jwt);
  if (bound !== jwtAccount || (expected !== undefined && bound !== expected))
    fail("differentAccount");
  return bound;
}
async function selectBackupVaults(
  db: DB,
  accountId: string | null,
  cloud?: ReadonlyMap<string, CloudVault>,
) {
  const values = await meta(db);
  const publicKeys = [values.get("mesh_device_ed25519_pubkey")];
  try {
    const retired: unknown = JSON.parse(values.get("retired_device_pubkeys") ?? "[]");
    if (
      !Array.isArray(retired) ||
      retired.length > 100 ||
      retired.some((v) => typeof v !== "string")
    )
      fail("invalid");
    publicKeys.push(...retired);
  } catch {
    fail("invalid");
  }
  const keys = publicKeys.filter((v): v is string => !!v);
  const localOwners = keys.map((key) => {
    try {
      return buildLocalAccountId(key);
    } catch {
      return fail("invalid");
    }
  });
  const vaults = await db.getAllAsync<Vault>(
    `SELECT id, account_id, registered_with_server_at, vault_trust_anchor_pubkey,
            is_default, archived_at FROM vaults ORDER BY id`,
  );
  if (!vaults.length) fail("empty");
  const owned: Vault[] = [];
  const skipped: Vault[] = [];
  for (const vault of vaults) {
    if (!UUID.test(vault.id)) fail("ownership");
    const memberships = await db.getAllAsync<{
      account_id: string;
      role: string;
      accepted_at: number | null;
      revoked_at: number | null;
    }>(
      "SELECT account_id,role,accepted_at,revoked_at FROM vault_members_mirror WHERE vault_id=?",
      vault.id,
    );
    // A real account row wins over local sentinels, including an explicit
    // revocation. Untouched pre-sign-in books can still belong to the local key.
    const real = accountId ? memberships.find((row) => row.account_id === accountId) : undefined;
    const effective =
      real ??
      localOwners.map((id) => memberships.find((row) => row.account_id === id)).find(Boolean);
    const mine =
      effective?.role === "owner" &&
      effective.accepted_at !== null &&
      effective.revoked_at === null;
    const foreign = vault.account_id !== null && vault.account_id !== accountId;
    // A confirmed member seat (including a removed seat) is safe to exclude.
    // An otherwise owner book with ambiguous ownership must stop the upload
    // rather than replace the last good copy with an incomplete one.
    const cloudRole = cloud?.get(vault.id)?.role;
    const knownNonOwner =
      !mine &&
      (foreign ||
        effective?.revoked_at != null ||
        (effective?.accepted_at != null && MEMBER_ROLES.has(effective.role)));
    if (cloud && (cloudRole === undefined ? knownNonOwner : MEMBER_ROLES.has(cloudRole))) {
      skipped.push(vault);
      continue;
    }
    // An unregistered book has no server ownership proof. Its original anchor
    // must instead be one of this installation's own current/retired keys.
    if (
      !mine ||
      foreign ||
      (!accountId && vault.registered_with_server_at !== null) ||
      ((!real || !vault.account_id || vault.registered_with_server_at === null) &&
        !keys.includes(vault.vault_trust_anchor_pubkey ?? ""))
    )
      fail("ownership");
    owned.push(vault);
  }
  if (!owned.length) fail("noOwnedVaults");
  return { owned, skipped };
}

async function assertLedgerScope(db: DB, accountId: string | null): Promise<void> {
  const names = await tables(db);
  const self = await db.getAllAsync<{
    account_id: string | null;
  }>("SELECT account_id FROM users WHERE is_local_self=1");
  if (self.length !== 1 || (self[0].account_id !== null && self[0].account_id !== accountId))
    fail("ownership");
  for (const table of [
    "relationships",
    "entries",
    "tally_notes",
    "event_log",
    "shop_profile",
    "tab_links",
    "settlements",
    "customer_groups",
    "customer_credit_limits",
    "credit_admission_intents",
    "credit_mutation_baselines",
    "credit_alert_policies",
    "customer_credit_limit_notifications",
  ]) {
    if (!names.has(table)) continue;
    if (
      await db.getFirstAsync(
        `SELECT 1 FROM ${quote(table)} r WHERE r.vault_id IS NULL OR NOT EXISTS(SELECT 1 FROM vaults v WHERE v.id=r.vault_id) LIMIT 1`,
      )
    )
      fail("ownership");
  }
  for (const table of ["tab_entries", "tab_outbox", "tab_failed_ops", "tab_settlements"]) {
    if (!names.has(table)) continue;
    if (
      await db.getFirstAsync(
        `SELECT 1 FROM ${quote(table)} r WHERE NOT EXISTS(SELECT 1 FROM tab_links t WHERE t.tab_id=r.tab_id) LIMIT 1`,
      )
    )
      fail("ownership");
  }
}

async function ownedVaults(db: DB, accountId: string | null): Promise<Vault[]> {
  const { owned } = await selectBackupVaults(db, accountId);
  await assertLedgerScope(db, accountId);
  return owned;
}

async function pruneJoinedVaults(
  db: DB,
  { owned, skipped }: { owned: Vault[]; skipped: Vault[] },
): Promise<PersonalBackupCoverage> {
  const coverage = { included: owned.length, skipped: skipped.length, skippedPending: 0 };
  if (!skipped.length) return coverage;

  const names = await tables(db);
  const skippedIds = JSON.stringify(skipped.map(({ id }) => id));
  const excluded = "SELECT value FROM json_each(?)";
  const pending = [
    `EXISTS (SELECT 1 FROM event_log e WHERE e.vault_id=v.id
             AND e.server_acked_at IS NULL AND e.tombstone_reason IS NULL)`,
  ];
  for (const table of ["tab_outbox", "tab_failed_ops"]) {
    if (!names.has("tab_links") || !names.has(table)) continue;
    pending.push(`EXISTS (SELECT 1 FROM tab_links t JOIN ${quote(table)} o USING (tab_id)
                          WHERE t.vault_id=v.id)`);
  }
  for (const table of [
    "customer_credit_limits",
    "credit_alert_policies",
    "customer_credit_limit_notifications",
  ]) {
    if (!names.has(table)) continue;
    pending.push(`EXISTS (SELECT 1 FROM ${quote(table)} p WHERE p.vault_id=v.id AND p.sync_pending<>0)`);
  }
  coverage.skippedPending =
    (await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM vaults v WHERE v.id IN (${excluded}) AND (${pending.join(" OR ")})`,
      skippedIds,
    ))?.n ?? 0;

  // Work only on the private temporary copy. Disable cascades while removing
  // scoped rows explicitly, so a corrupt cross-book reference can't delete an
  // included row. The caller validates the surviving foreign keys afterward.
  await db.execAsync("PRAGMA secure_delete=ON; PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
  try {
    const columns = await db.getAllAsync<{ name: string; column_name: string }>(
      `SELECT t.name, p.name AS column_name FROM sqlite_master t
        JOIN pragma_table_info(t.name) p WHERE t.type='table'`,
    );
    const scoped = columns.filter(
      ({ name, column_name }) => TABLES.has(name) && column_name === "vault_id",
    );
    for (const { name } of scoped) {
      if (!columns.some((col) => col.name === name && col.column_name === "relationship_id")) continue;
      if (
        await db.getFirstAsync(
          `SELECT 1 FROM ${quote(name)} s JOIN relationships r ON r.id=s.relationship_id
            WHERE s.vault_id<>r.vault_id AND s.vault_id NOT IN (${excluded}) LIMIT 1`,
          skippedIds,
        )
      ) fail("ownership");
    }
    for (const table of ["tab_entries", "tab_outbox", "tab_failed_ops", "tab_settlements"]) {
      if (!names.has(table)) continue;
      await db.runAsync(
        `DELETE FROM ${quote(table)} WHERE tab_id IN (
           SELECT tab_id FROM tab_links WHERE vault_id IN (${excluded})
         )`,
        skippedIds,
      );
    }
    for (const { name } of scoped)
      await db.runAsync(`DELETE FROM ${quote(name)} WHERE vault_id IN (${excluded})`, skippedIds);
    await db.runAsync(`DELETE FROM vaults WHERE id IN (${excluded})`, skippedIds);

    // Contact identities are global and may belong to several books. Retain
    // local self and every identity still referenced by an included book.
    const references = await db.getAllAsync<{ name: string; column_name: string }>(
      `SELECT t.name, f."from" AS column_name FROM sqlite_master t
        JOIN pragma_foreign_key_list(t.name) f WHERE t.type='table' AND f."table"='users'`,
    );
    const referenced = references
      .filter(({ name }) => TABLES.has(name) && !CLEAR_TABLES.includes(name))
      .map(({ name, column_name }) =>
        `EXISTS (SELECT 1 FROM ${quote(name)} r WHERE r.${quote(column_name)}=users.id)`,
      );
    await db.execAsync(
      `DELETE FROM users WHERE COALESCE(is_local_self,0)<>1${referenced.map((sql) => ` AND NOT ${sql}`).join("")};`,
    );

    const values = await meta(db);
    const activeBooks = owned.filter((v) => v.archived_at === null);
    const defaultBook =
      activeBooks.find((v) => v.id === values.get("default_vault_id")) ??
      activeBooks.find((v) => v.is_default === 1) ??
      activeBooks[0];
    const activeBook = activeBooks.find((v) => v.id === values.get("active_vault_id")) ?? defaultBook;
    await setMeta(db, "active_vault_id", activeBook?.id ?? "");
    await setMeta(db, "default_vault_id", defaultBook?.id ?? "");
    await db.runAsync(
      "UPDATE vaults SET is_default=CASE WHEN id=? THEN 1 ELSE 0 END",
      defaultBook?.id ?? "",
    );
    await db.execAsync("COMMIT;");
  } catch (error) {
    await db.execAsync("ROLLBACK;");
    throw error;
  }
  return coverage;
}

// This request authenticates the scoped JWT on the server. The file's backend
// URL is NEVER used: only the existing installation's trusted configuration.
async function listCloudVaults(
  session: SessionSnapshot,
  values: Meta,
  accountId: string | null,
): Promise<Map<string, CloudVault>> {
  const result = new Map<string, CloudVault>();
  if (!accountId) return result;
  if (accountFromJWT(session.jwt) !== accountId) fail("differentAccount");
  const url = (values.get("backend_url_override") || BACKEND_URL_FALLBACK).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${url}/v1/vaults`, {
      headers: { Authorization: `Bearer ${session.jwt}` },
      signal: controller.signal,
    });
    if (!response.ok) fail("ownershipUnavailable");
    const body: unknown = await response.json();
    const listings =
      body && typeof body === "object" && "vaults" in body
        ? (
            body as {
              vaults: unknown;
            }
          ).vaults
        : null;
    if (!Array.isArray(listings)) fail("ownershipUnavailable");
    for (const row of listings) {
      if (
        !row ||
        typeof row.vault_id !== "string" ||
        !UUID.test(row.vault_id) ||
        (row.role !== "owner" && !MEMBER_ROLES.has(row.role)) ||
        result.has(row.vault_id)
      )
        fail("ownershipUnavailable");
      result.set(row.vault_id, row);
    }
    return result;
  } catch (error) {
    if (error instanceof PersonalBackupError) throw error;
    fail("ownershipUnavailable");
  } finally {
    clearTimeout(timer);
  }
}
function assertCloudOwnership(vaults: Vault[], cloud: ReadonlyMap<string, CloudVault>): void {
  for (const vault of vaults) {
    const remote = cloud.get(vault.id);
    if (vault.registered_with_server_at === null && !remote) continue;
    if (
      remote?.role !== "owner" ||
      (vault.vault_trust_anchor_pubkey &&
        remote.vault_trust_anchor_pubkey !== vault.vault_trust_anchor_pubkey)
    ) fail("ownership");
  }
}
async function verifyCloudOwnership(
  session: SessionSnapshot,
  values: Meta,
  vaults: Vault[],
  accountId: string | null,
): Promise<void> {
  assertCloudOwnership(vaults, await listCloudVaults(session, values, accountId));
}
async function assertEmpty(db: DB): Promise<void> {
  for (const table of [
    "relationships",
    "entries",
    "tally_notes",
    "tab_links",
    "tab_entries",
    "tab_outbox",
    "tab_failed_ops",
    "settlements",
    "customer_groups",
    "customer_reminders",
    "customer_credit_limits",
    "credit_alert_policies",
    "customer_credit_limit_notifications",
  ])
    if (await count(db, table)) fail("notEmpty");
  const names = await tables(db);
  const values = await meta(db);
  const account = values.get("account_id") || null;
  const publicKey = values.get("mesh_device_ed25519_pubkey");
  const localOwner = publicKey ? buildLocalAccountId(publicKey) : null;
  const ownIdentities = [account, localOwner].filter(Boolean);
  if (
    names.has("users") &&
    (await db.getFirstAsync("SELECT 1 FROM users WHERE is_local_self<>1 LIMIT 1"))
  )
    fail("notEmpty");
  const vaults = names.has("vaults")
    ? await db.getAllAsync<{
        id: string;
        is_default: number;
      }>("SELECT id,is_default FROM vaults")
    : [];
  if (vaults.length > 1 || vaults.some((v) => v.is_default !== 1)) fail("notEmpty");
  if (!names.has("event_log")) return;
  const events = await db.getAllAsync<{
    vault_id: string;
    event_type: string;
    payload_json: string;
  }>("SELECT vault_id,event_type,payload_json FROM event_log");
  const seen = new Set<string>();
  for (const event of events) {
    if (vaults.length !== 1 || event.vault_id !== vaults[0].id) fail("notEmpty");
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      return fail("notEmpty");
    }
    let key = event.event_type;
    if (key === "vault_member_added") {
      if (payload.role !== "owner" || !ownIdentities.includes(String(payload.account_id)))
        fail("notEmpty");
    } else if (key === "vault_setting_set") {
      if (
        !["enabled_currencies", "default_entry_currency", "currency"].includes(String(payload.key))
      )
        fail("notEmpty");
      key += ":" + payload.key;
    } else if (key === "vault_device_added") {
      if (
        !ownIdentities.includes(String(payload.account_id)) ||
        payload.device_id !== values.get("install_id") ||
        payload.device_pubkey !== publicKey
      )
        fail("notEmpty");
    } else if (key === "account_bound") {
      if (!account || payload.account_id !== account) fail("notEmpty");
    } else if (key !== "shop_profile_updated") fail("notEmpty");
    if (seen.has(key)) fail("notEmpty");
    seen.add(key);
  }
  if (names.has("vault_members_mirror")) {
    const members = await db.getAllAsync<{
      account_id: string;
      role: string;
      revoked_at: number | null;
    }>("SELECT account_id,role,revoked_at FROM vault_members_mirror");
    const boundOwner =
      account &&
      members.some(
        (row) => row.account_id === account && row.role === "owner" && row.revoked_at === null,
      );
    if (
      members.some(
        (row) =>
          row.role !== "owner" ||
          !ownIdentities.includes(row.account_id) ||
          (row.revoked_at !== null && !(boundOwner && row.account_id === localOwner)),
      )
    )
      fail("notEmpty");
  }
}
async function sanitize(db: DB, target?: Meta): Promise<void> {
  const names = await tables(db);
  await db.execAsync("PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE;");
  if (names.has("_old_shopkeeper")) await db.execAsync("DROP TABLE _old_shopkeeper;");
  for (const { key } of await db.getAllAsync<{
    key: string;
  }>("SELECT key FROM app_meta"))
    if (!KEEP_META.has(key)) await db.runAsync("DELETE FROM app_meta WHERE key=?", key);
  for (const table of CLEAR_TABLES)
    if (names.has(table)) await db.execAsync(`DELETE FROM ${quote(table)};`);
  if (names.has("tab_links"))
    await db.execAsync(
      "UPDATE tab_links SET party_token=NULL,invite_url=NULL,last_error=NULL,last_synced_at=NULL,rev=0;",
    );
  if (names.has("tab_outbox"))
    await db.execAsync("UPDATE tab_outbox SET attempts=0,next_at=NULL,last_error=NULL;");
  // Keep financial intent but not operational error text that may contain URLs.
  if (names.has("tab_failed_ops")) {
    const cols = await db.getAllAsync<{
      name: string;
    }>("PRAGMA table_info(tab_failed_ops)");
    if (cols.some((row) => row.name === "last_error"))
      await db.execAsync("UPDATE tab_failed_ops SET last_error=NULL;");
  }
  if (target) {
    for (const key of TARGET_META) {
      const value = target.get(key);
      if (value !== undefined) await setMeta(db, key, value);
    }
    await setMeta(db, "device_key_reregister_pending", "1");
    await setMeta(db, "device_key_rebind_pending", "1");
  }
  await db.execAsync("VACUUM;");
  await integrity(db);
}
async function info(db: DB): Promise<BackupInfo> {
  const rows = await db.getAllAsync<{
    value: string;
  }>(`SELECT value FROM ${INFO}`);
  if (rows.length !== 1) fail("invalid");
  let value: BackupInfo;
  try {
    value = JSON.parse(rows[0].value);
  } catch {
    return fail("invalid");
  }
  if (
    value.version !== 1 ||
    (value.accountId !== null && !UUID.test(value.accountId)) ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0
  )
    fail("invalid");
  return value;
}
function identity(values: Meta): {
  installId: string;
  installedAt: string;
} {
  const installId = values.get("install_id") ?? "",
    installedAt = values.get("installed_at_unix_ms") ?? "";
  if (!UUID.test(installId) || !/^\d+$/.test(installedAt) || Number(installedAt) <= 0)
    fail("invalid");
  return { installId, installedAt };
}
function validBytes(bytes: Uint8Array): void {
  if (bytes.byteLength > BACKUP_DATABASE_LIMIT) fail("tooLarge");
  const header = "SQLite format 3\0";
  if (
    bytes.byteLength < 100 ||
    !Array.from(header).every((char, index) => bytes[index] === char.charCodeAt(0))
  )
    fail("invalid");
}
export async function createPersonalBackupSnapshot(
  includeReadableTables = false,
  { requireData = false } = {},
): Promise<{
  file: File;
  readableTables: Awaited<ReturnType<typeof readDriveBackupTables>>;
  coverage: PersonalBackupCoverage;
  dispose: () => void;
}> {
  return exclusive(async () => {
    const session = await captureCurrentSession();
    const live = await getDb();
    removeDatabase(EXPORT);
    // A dedicated reader cannot accidentally join a transaction begun on the
    // singleton while the native online-backup operation is awaiting a lock.
    const source = await open(DB_NAME);
    let copy: DB | null = null;
    try {
      copy = await open(EXPORT);
      // Network I/O stays outside the session mutex. Validate the captured
      // scope again before copying, then authorize the exact resulting copy.
      const initialValues = await meta(source),
        initialAccount = matchSession(initialValues, session);
      const initialCloud = await listCloudVaults(session, initialValues, initialAccount);
      const initialScope = await selectBackupVaults(source, initialAccount, initialCloud);
      await assertLedgerScope(source, initialAccount);
      assertCloudOwnership(initialScope.owned, initialCloud);
      const coverage = await applyForUnchangedLocalSession(session, async () => {
        if (await live.isInTransactionAsync()) fail("busy");
        const values = await meta(source),
          accountId = matchSession(values, session);
        const currentScope = await selectBackupVaults(source, accountId, initialCloud);
        if (JSON.stringify(currentScope) !== JSON.stringify(initialScope)) fail("sessionChanged");
        const before =
          (await count(source, "event_log")) +
          (await count(source, "entries")) +
          (await count(source, "relationships"));
        await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: copy! });
        await validateSchema(copy!);
        await integrity(copy!);
        if (
          (await count(copy!, "event_log")) +
            (await count(copy!, "entries")) +
            (await count(copy!, "relationships")) <
          before
        )
          fail("invalid");
        matchSession(await meta(copy!), session);
        const copyScope = await selectBackupVaults(copy!, accountId, initialCloud);
        if (JSON.stringify(copyScope) !== JSON.stringify(initialScope)) fail("sessionChanged");
        await assertLedgerScope(copy!, accountId);
        const coverage = await pruneJoinedVaults(copy!, copyScope);
        if (requireData) {
          // A new installation may already have a default book. Do not publish
          // that shell as the latest copy when a real backup exists elsewhere.
          try {
            await assertEmpty(copy!);
            fail("empty");
          } catch (error) {
            if (!(error instanceof PersonalBackupError && error.code === "notEmpty")) throw error;
          }
        }
        await sanitize(copy!);
        await copy!.execAsync(
          `DROP TABLE IF EXISTS ${INFO};CREATE TABLE ${INFO}(value TEXT NOT NULL);`,
        );
        await copy!.runAsync(
          `INSERT INTO ${INFO}(value) VALUES(?)`,
          JSON.stringify({ version: 1, accountId, createdAt: Date.now() } satisfies BackupInfo),
        );
        return coverage;
      });
      const copyVaults = await ownedVaults(copy, initialAccount);
      const latestCloud = await listCloudVaults(session, initialValues, initialAccount);
      assertCloudOwnership(copyVaults, latestCloud);
      if (initialScope.skipped.some(({ id }) => latestCloud.get(id)?.role === "owner"))
        fail("sessionChanged");
      await applyForUnchangedLocalSession(session, async () => {
        matchSession(await meta(source), session, initialAccount);
      });
      if (file(EXPORT).size > BACKUP_DATABASE_LIMIT) fail("tooLarge");
      const readableTables = includeReadableTables ? await readDriveBackupTables(copy) : {};
      await copy.closeAsync();
      copy = null;
      exportHeld = true;
      let disposed = false;
      return {
        file: file(EXPORT),
        readableTables,
        coverage,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          try {
            removeDatabase(EXPORT);
          } finally {
            exportHeld = false;
          }
        },
      };
    } catch (error) {
      if (copy) await copy.closeAsync();
      removeDatabase(EXPORT);
      if (error instanceof DriveBackupTooLargeError) fail("tooLarge");
      throw error;
    } finally {
      await source.closeAsync();
    }
  });
}
/** Validates and prepares files only. The running ledger is never replaced. */
export async function stagePersonalBackupRestore(
  bytes: Uint8Array,
  expectedSession?: SessionSnapshot,
): Promise<void> {
  validBytes(bytes);
  const ownedBytes = bytes.slice();
  return exclusive(async () => {
    if (file(RECEIPT).exists || file(PARKED).exists) fail("busy");
    const session = expectedSession ?? (await captureCurrentSession()),
      live = await getDb();
    const target = await meta(live);
    const targetIdentity = identity(target);
    await assertEmpty(live);
    removeDatabase(STAGE);
    file(STAGE).writeSync(ownedBytes);
    let candidate: DB | null = null;
    try {
      candidate = await open(STAGE);
      await validateSchema(candidate, live);
      await integrity(candidate);
      const header = await info(candidate);
      matchSession(target, session, header.accountId);
      const sourceAccount = (await meta(candidate)).get("account_id") || null;
      if (sourceAccount !== header.accountId) fail("differentAccount");
      const vaults = await ownedVaults(candidate, header.accountId);
      await verifyCloudOwnership(session, target, vaults, header.accountId);
      await sanitize(candidate, target);
      // The restored ZIP contains only owned books. Schedule account-scoped
      // recovery of joined books after the staged DB is installed.
      if (header.accountId)
        await setMeta(candidate, PERSONAL_BACKUP_JOINED_RECOVERY_KEY, header.accountId);
      await candidate.closeAsync();
      candidate = null;
      const receipt: Receipt = {
        version: 1,
        hash: hashFile(STAGE),
        accountId: header.accountId,
        ...targetIdentity,
      };
      await applyForUnchangedLocalSession(session, async () => {
        const current = await meta(live);
        matchSession(current, session, header.accountId);
        if (JSON.stringify(identity(current)) !== JSON.stringify(targetIdentity))
          fail("sessionChanged");
        await assertEmpty(live);
        remove(RECEIPT_SCRATCH);
        file(RECEIPT_SCRATCH).writeSync(JSON.stringify(receipt));
        file(RECEIPT_SCRATCH).moveSync(file(RECEIPT));
      });
    } catch (error) {
      if (candidate) await candidate.closeAsync();
      removeDatabase(STAGE);
      remove(RECEIPT);
      remove(RECEIPT_SCRATCH);
      throw error;
    }
  });
}
function readReceipt(): Receipt {
  if (file(RECEIPT).size > 4096) fail("invalid");
  let receipt: Receipt;
  try {
    receipt = JSON.parse(file(RECEIPT).textSync());
  } catch {
    return fail("invalid");
  }
  if (
    receipt.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(receipt.hash) ||
    !UUID.test(receipt.installId) ||
    !/^\d+$/.test(receipt.installedAt) ||
    (receipt.accountId !== null && !UUID.test(receipt.accountId))
  )
    fail("invalid");
  return receipt;
}
function finishFiles(): void {
  // Keep the receipt until every prior step is complete. A crash during cleanup
  // can still recognize the installed hash without treating it as a new import.
  removeDatabase(STAGE);
  removeDatabase(PARKED);
  remove(RECEIPT_SCRATCH);
  remove(RECEIPT);
}
function moveSidecars(from: string, to: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (file(from + suffix).exists) file(from + suffix).moveSync(file(to + suffix));
}
function rollbackParked(): void {
  if (!file(PARKED).exists) return;
  if (file(DB_NAME).exists) {
    // Preserve an unexpected/partial landing as staging, never delete it to
    // make room for the original. The foreground gate prevented any app opens.
    removeDatabase(STAGE);
    file(DB_NAME).moveSync(file(STAGE));
    moveSidecars(DB_NAME, STAGE);
  }
  file(PARKED).moveSync(file(DB_NAME));
  moveSidecars(PARKED, DB_NAME);
  remove(RECEIPT_SCRATCH);
  remove(RECEIPT);
}
/** Called before the singleton DB is opened, including headless boot. No getDb. */
export async function finishPendingPersonalBackupRestore(): Promise<void> {
  return exclusive(async () => {
    removeDatabase(EXPORT);
    if (!file(RECEIPT).exists) {
      if (file(PARKED).exists) rollbackParked();
      else removeDatabase(STAGE);
      remove(RECEIPT_SCRATCH);
      return;
    }
    let receipt: Receipt;
    try {
      receipt = readReceipt();
    } catch (error) {
      if (file(PARKED).exists) rollbackParked();
      else {
        removeDatabase(STAGE);
        remove(RECEIPT_SCRATCH);
        remove(RECEIPT);
      }
      throw error;
    }
    // An interrupted rename is resolved before any code can create an empty
    // kaata.db. Never overwrite an unexpected live file during recovery.
    if (file(PARKED).exists) {
      if (!file(DB_NAME).exists) {
        rollbackParked();
        removeDatabase(STAGE);
        return;
      }
      if (hashFile(DB_NAME) !== receipt.hash) {
        rollbackParked();
        fail("invalid");
      }
      finishFiles();
      return;
    }
    if (!file(STAGE).exists && file(DB_NAME).exists && hashFile(DB_NAME) === receipt.hash) {
      finishFiles();
      return;
    }
    let live: DB | null = null,
      candidate: DB | null = null;
    try {
      if (!file(DB_NAME).exists || !file(STAGE).exists || hashFile(STAGE) !== receipt.hash)
        fail("invalid");
      const session = await captureCurrentSession();
      live = await open(DB_NAME);
      candidate = await open(STAGE);
      const target = await meta(live);
      matchSession(target, session, receipt.accountId);
      const targetIdentity = identity(target);
      if (
        targetIdentity.installId !== receipt.installId ||
        targetIdentity.installedAt !== receipt.installedAt
      )
        fail("sessionChanged");
      await assertEmpty(live);
      await validateSchema(candidate, live);
      await integrity(candidate);
      const header = await info(candidate);
      if (header.accountId !== receipt.accountId) fail("differentAccount");
      const vaults = await ownedVaults(candidate, receipt.accountId);
      await verifyCloudOwnership(session, target, vaults, receipt.accountId);
      await applyForUnchangedLocalSession(session, async () => {
        await live!.execAsync("BEGIN IMMEDIATE;");
        try {
          matchSession(await meta(live!), session, receipt.accountId);
          await assertEmpty(live!);
          await live!.execAsync("COMMIT;PRAGMA wal_checkpoint(TRUNCATE);");
        } catch (error) {
          try {
            await live!.execAsync("ROLLBACK;");
          } catch {}
          throw error;
        }
        await candidate!.closeAsync();
        candidate = null;
        await live!.closeAsync();
        live = null;
        // All filesystem changes below are synchronous. Do not introduce an
        // await between parking the original and installing the verified copy.
        if (hashFile(STAGE) !== receipt.hash) fail("invalid");
        file(DB_NAME).moveSync(file(PARKED));
        moveSidecars(DB_NAME, PARKED);
        try {
          file(STAGE).moveSync(file(DB_NAME));
        } catch (error) {
          rollbackParked();
          throw error;
        }
        finishFiles();
      });
    } catch (error) {
      if (candidate) await candidate.closeAsync();
      if (live) await live.closeAsync();
      if (!file(PARKED).exists) {
        remove(RECEIPT);
        remove(RECEIPT_SCRATCH);
        removeDatabase(STAGE);
      }
      throw error;
    }
  });
}
