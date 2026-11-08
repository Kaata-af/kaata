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
  PERSONAL_BACKUP_EXPORT as EXPORT,
  PERSONAL_BACKUP_RESTORE_STAGE as STAGE,
  PERSONAL_BACKUP_RESTORE_MARKER as RECEIPT,
  PERSONAL_BACKUP_RESTORE_MARKER_SCRATCH as RECEIPT_SCRATCH,
  PERSONAL_BACKUP_RESTORE_PARKED as PARKED,
} from "./db-backup";
import { buildLocalAccountId } from "./trust/account-id";
export type PersonalBackupErrorCode =
  | "ownership"
  | "differentAccount"
  | "notEmpty"
  | "invalid"
  | "empty"
  | "unsupported"
  | "tooLarge"
  | "password"
  | "sessionChanged"
  | "busy";
export class PersonalBackupError extends Error {
  constructor(public readonly code: PersonalBackupErrorCode) {
    super(code);
    this.name = "PersonalBackupError";
  }
}
export const PERSONAL_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const INFO = "personal_backup_info";
const ORIGINAL_SCHEMA = "051_tally_removal_requests";
const TALLY_NOTES_SCHEMA = "052_tally_notes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
function tableDefinition(sql: string | null): string {
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
  return JSON.stringify({ definitions: definitions.sort(), options: tokens.slice(end + 1) });
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
  const expectedMigrations = hasTallyNotes ? 52 : 51;
  if (
    migrations.length !== expectedMigrations ||
    !migrations.some((row) => row.name === ORIGINAL_SCHEMA) ||
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
  if (trusted) {
    // Migration 052 only adds the note projection. An older backup can keep
    // its original schema until initDb upgrades it after installation.
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
          .filter((name) => hasTallyNotes || name !== TALLY_NOTES_SCHEMA),
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
      const definition = item.type === "table" ? tableDefinition : normalizedSQL;
      if (definition(prior.sql) !== definition(item.sql)) fail("unsupported");
      if (item.type === "table") {
        const shape = async (handle: DB) =>
          (
            await handle.getAllAsync<Record<string, unknown>>(
              `PRAGMA table_xinfo(${quote(item.name)})`,
            )
          )
            .map(({ cid, ...row }) => row)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (JSON.stringify(await shape(db)) !== JSON.stringify(await shape(trusted)))
          fail("unsupported");
      }
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
async function ownedVaults(db: DB, accountId: string | null): Promise<Vault[]> {
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
    "SELECT id,account_id,registered_with_server_at,vault_trust_anchor_pubkey,is_default FROM vaults",
  );
  if (!vaults.length) fail("empty");
  for (const vault of vaults) {
    if (!UUID.test(vault.id) || (vault.account_id !== null && vault.account_id !== accountId))
      fail("ownership");
    if (!accountId && vault.registered_with_server_at !== null) fail("ownership");
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
    // An unregistered book has no server ownership proof. Its original anchor
    // must instead be one of this installation's own current/retired keys.
    if (
      !mine ||
      ((!real || !vault.account_id || vault.registered_with_server_at === null) &&
        !keys.includes(vault.vault_trust_anchor_pubkey ?? ""))
    )
      fail("ownership");
  }
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
    if (!(await tables(db)).has(table)) continue;
    if (
      await db.getFirstAsync(
        `SELECT 1 FROM ${quote(table)} r WHERE r.vault_id IS NULL OR NOT EXISTS(SELECT 1 FROM vaults v WHERE v.id=r.vault_id) LIMIT 1`,
      )
    )
      fail("ownership");
  }
  for (const table of ["tab_entries", "tab_outbox", "tab_failed_ops", "tab_settlements"]) {
    if (!(await tables(db)).has(table)) continue;
    if (
      await db.getFirstAsync(
        `SELECT 1 FROM ${quote(table)} r WHERE NOT EXISTS(SELECT 1 FROM tab_links t WHERE t.tab_id=r.tab_id) LIMIT 1`,
      )
    )
      fail("ownership");
  }
  return vaults;
}
// This request authenticates the scoped JWT on the server. The file's backend
// URL is NEVER used: only the existing installation's trusted configuration.
async function verifyCloudOwnership(
  session: SessionSnapshot,
  values: Meta,
  vaults: Vault[],
  accountId: string | null,
): Promise<void> {
  if (!accountId) return;
  if (accountFromJWT(session.jwt) !== accountId) fail("differentAccount");
  const url = (values.get("backend_url_override") || BACKEND_URL_FALLBACK).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${url}/v1/vaults`, {
      headers: { Authorization: `Bearer ${session.jwt}` },
      signal: controller.signal,
    });
    if (!response.ok) fail("ownership");
    const body: unknown = await response.json();
    const listings =
      body && typeof body === "object" && "vaults" in body
        ? (
            body as {
              vaults: unknown;
            }
          ).vaults
        : null;
    if (!Array.isArray(listings)) fail("ownership");
    for (const vault of vaults) {
      const remote = listings.find(
        (row) => row && row.vault_id === vault.id && row.role === "owner",
      );
      const registered = listings.find((row) => row && row.vault_id === vault.id);
      if (vault.registered_with_server_at === null && !registered) continue;
      if (
        !remote ||
        (vault.vault_trust_anchor_pubkey &&
          remote.vault_trust_anchor_pubkey !== vault.vault_trust_anchor_pubkey)
      )
        fail("ownership");
    }
  } catch (error) {
    if (error instanceof PersonalBackupError) throw error;
    fail("ownership");
  } finally {
    clearTimeout(timer);
  }
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
  if (bytes.byteLength > PERSONAL_BACKUP_MAX_BYTES) fail("tooLarge");
  const header = "SQLite format 3\0";
  if (
    bytes.byteLength < 100 ||
    !Array.from(header).every((char, index) => bytes[index] === char.charCodeAt(0))
  )
    fail("invalid");
}
export async function createPersonalBackupSnapshot(): Promise<{
  file: File;
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
      const initialVaults = await ownedVaults(source, initialAccount);
      await verifyCloudOwnership(session, initialValues, initialVaults, initialAccount);
      await applyForUnchangedLocalSession(session, async () => {
        if (await live.isInTransactionAsync()) fail("busy");
        const values = await meta(source),
          accountId = matchSession(values, session);
        const currentVaults = await ownedVaults(source, accountId);
        if (JSON.stringify(currentVaults) !== JSON.stringify(initialVaults)) fail("sessionChanged");
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
        await ownedVaults(copy!, accountId);
        await sanitize(copy!);
        await copy!.execAsync(
          `DROP TABLE IF EXISTS ${INFO};CREATE TABLE ${INFO}(value TEXT NOT NULL);`,
        );
        await copy!.runAsync(
          `INSERT INTO ${INFO}(value) VALUES(?)`,
          JSON.stringify({ version: 1, accountId, createdAt: Date.now() } satisfies BackupInfo),
        );
      });
      const copyVaults = await ownedVaults(copy, initialAccount);
      await verifyCloudOwnership(session, initialValues, copyVaults, initialAccount);
      await applyForUnchangedLocalSession(session, async () => {
        matchSession(await meta(source), session, initialAccount);
      });
      await copy.closeAsync();
      copy = null;
      if (file(EXPORT).size > PERSONAL_BACKUP_MAX_BYTES) fail("tooLarge");
      exportHeld = true;
      let disposed = false;
      return {
        file: file(EXPORT),
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
      throw error;
    } finally {
      await source.closeAsync();
    }
  });
}
/** Validates and prepares files only. The running ledger is never replaced. */
export async function stagePersonalBackupRestore(bytes: Uint8Array): Promise<void> {
  validBytes(bytes);
  const ownedBytes = bytes.slice();
  return exclusive(async () => {
    if (file(RECEIPT).exists || file(PARKED).exists) fail("busy");
    const session = await captureCurrentSession(),
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
