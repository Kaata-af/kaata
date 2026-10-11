import * as Crypto from "expo-crypto";
import { getAccountIdSync, getDb, getInstallIdSync, type SQLiteTx } from "./db-tx";
import { resolveAccountIdCandidates } from "./effective-account";
import { getReminderDeviceId, getReminderDeviceIdSync } from "./reminder-device";
import {
  nextReminderOccurrence,
  validReminderSchedule,
  type ReminderSchedule,
} from "./reminder-schedule";

export const REMINDER_MIGRATION = "036_customer_reminders";
export const MAX_ACTIVE_REMINDERS = 40;
export type CustomerReminder = {
  id: string;
  owner_scope: string;
  install_id: string;
  vault_id: string;
  person_id: string;
  schedule_json: string;
  next_due_at: number;
  enabled: number;
  updated_at: number;
  timezone: string;
  person_name: string;
  vault_name?: string;
};

/** Personal/device state: never a ledger event or a shared reminder for peers. */
export async function migrateCustomerReminders(db: SQLiteTx): Promise<void> {
  await db.withTransactionAsync(async () => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS customer_reminders (
      id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, install_id TEXT NOT NULL,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      person_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      schedule_json TEXT NOT NULL, next_due_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      updated_at INTEGER NOT NULL, timezone TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_reminders_due
      ON customer_reminders(owner_scope, install_id, enabled, next_due_at);`);
    await db.runAsync(
      "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
      REMINDER_MIGRATION,
      Date.now(),
    );
  });
}

export function reminderOwnerScope(): string {
  const account = getAccountIdSync();
  return account ? `account:${account}` : `local:${getInstallIdSync()}`;
}
export function reminderTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}
export function readReminderSchedule(
  row: Pick<CustomerReminder, "schedule_json">,
): ReminderSchedule | null {
  try {
    const value = JSON.parse(row.schedule_json) as ReminderSchedule;
    return value && validReminderSchedule(value) ? value : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
export function onCustomerRemindersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function changed() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* Isolate consumers. */
    }
  }
}

/** Read gate distinguishes a revoked membership from a never-shared local
 * kaata. Use all current/retired device identities, like ledger role checks. */
export async function canReadReminderVault(db: SQLiteTx, vaultId: string): Promise<boolean> {
  const vault = await db.getFirstAsync<{ archived_at: number | null }>(
    "SELECT archived_at FROM vaults WHERE id = ?",
    vaultId,
  );
  if (!vault || vault.archived_at != null) return false;
  const ids = await resolveAccountIdCandidates(getAccountIdSync());
  if (!ids.length) return false;
  const own = await db.getAllAsync<{ revoked_at: number | null; accepted_at: number | null }>(
    `SELECT revoked_at, accepted_at FROM vault_members_mirror WHERE vault_id = ? AND account_id IN (${ids.map(() => "?").join(",")})`,
    vaultId,
    ...ids,
  );
  if (own.length) return own.some((m) => m.revoked_at == null && m.accepted_at != null);
  const any = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM vault_members_mirror WHERE vault_id = ?",
    vaultId,
  );
  return (any?.n ?? 0) === 0;
}

export async function listCustomerReminders(
  vaultId?: string,
  personId?: string,
): Promise<CustomerReminder[]> {
  const owner = reminderOwnerScope();
  const accountInstall = getInstallIdSync();
  const install = await getReminderDeviceId();
  const db = await getDb();
  const rows = await db.getAllAsync<CustomerReminder>(
    `SELECT cr.*, u.display_name AS person_name, v.name AS vault_name FROM customer_reminders cr
    JOIN users u ON u.id = cr.person_id JOIN vaults v ON v.id = cr.vault_id
    WHERE cr.owner_scope = ? AND cr.install_id = ? AND cr.enabled = 1
      AND u.archived_at IS NULL AND u.is_local_self = 0 AND v.archived_at IS NULL
      AND (? IS NULL OR cr.vault_id = ?) AND (? IS NULL OR cr.person_id = ?)
      AND EXISTS (SELECT 1 FROM relationships r WHERE r.vault_id = cr.vault_id
        AND r.archived_at IS NULL AND (r.user_a_id = cr.person_id OR r.user_b_id = cr.person_id))
    ORDER BY cr.next_due_at, cr.id`,
    owner,
    install,
    vaultId ?? null,
    vaultId ?? null,
    personId ?? null,
    personId ?? null,
  );
  const access = new Map<string, boolean>();
  const available: CustomerReminder[] = [];
  for (const row of rows) {
    if (!access.has(row.vault_id))
      access.set(row.vault_id, await canReadReminderVault(db, row.vault_id));
    if (access.get(row.vault_id)) available.push(row);
  }
  return owner === reminderOwnerScope() &&
    accountInstall === getInstallIdSync() &&
    install === getReminderDeviceIdSync()
    ? available
    : [];
}

export async function saveCustomerReminder(
  vaultId: string,
  personId: string,
  schedule: ReminderSchedule,
  id?: string,
): Promise<string> {
  const owner = reminderOwnerScope();
  const accountInstall = getInstallIdSync();
  const install = await getReminderDeviceId();
  if (nextReminderOccurrence(schedule, Date.now()) == null)
    throw new Error("invalid_reminder_schedule");
  const db = await getDb();
  const reminderId = id ?? Crypto.randomUUID();
  const { applyEventMutex } = await import("./projection");
  await applyEventMutex.runExclusive(() =>
    db.withTransactionAsync(async () => {
      if (
        owner !== reminderOwnerScope() ||
        accountInstall !== getInstallIdSync() ||
        install !== getReminderDeviceIdSync()
      )
        throw new Error("reminder_account_changed");
      const due = nextReminderOccurrence(schedule, Date.now());
      if (due == null) throw new Error("invalid_reminder_schedule");
      if (!(await canReadReminderVault(db, vaultId))) throw new Error("reminder_access_denied");
      const relation = await db.getFirstAsync<{ id: string }>(
        `SELECT r.id FROM relationships r JOIN users u ON u.id = ?
      WHERE r.vault_id = ? AND r.archived_at IS NULL AND u.archived_at IS NULL
        AND u.is_local_self = 0 AND (r.user_a_id = u.id OR r.user_b_id = u.id) LIMIT 1`,
        personId,
        vaultId,
      );
      if (!relation) throw new Error("reminder_access_denied");
      if (id) {
        const existing = await db.getFirstAsync<{ id: string }>(
          "SELECT id FROM customer_reminders WHERE id = ? AND owner_scope = ? AND install_id = ? AND vault_id = ? AND person_id = ?",
          id,
          owner,
          install,
          vaultId,
          personId,
        );
        if (!existing) throw new Error("reminder_access_denied");
      } else {
        const active = await db.getFirstAsync<{ n: number }>(
          "SELECT COUNT(*) AS n FROM customer_reminders WHERE owner_scope = ? AND install_id = ? AND enabled = 1",
          owner,
          install,
        );
        if ((active?.n ?? 0) >= MAX_ACTIVE_REMINDERS) throw new Error("reminder_limit");
      }
      if (
        owner !== reminderOwnerScope() ||
        accountInstall !== getInstallIdSync() ||
        install !== getReminderDeviceIdSync()
      )
        throw new Error("reminder_account_changed");
      await db.runAsync(
        `INSERT INTO customer_reminders(id,owner_scope,install_id,vault_id,person_id,schedule_json,next_due_at,enabled,updated_at,timezone)
      VALUES (?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET schedule_json=excluded.schedule_json,
      next_due_at=excluded.next_due_at,enabled=1,updated_at=excluded.updated_at,timezone=excluded.timezone`,
        reminderId,
        owner,
        install,
        vaultId,
        personId,
        JSON.stringify(schedule),
        due,
        Date.now(),
        reminderTimezone(),
      );
    }),
  );
  changed();
  return reminderId;
}

export async function dismissCustomerReminder(id: string, remove = false): Promise<void> {
  const owner = reminderOwnerScope();
  const accountInstall = getInstallIdSync();
  const install = await getReminderDeviceId();
  const db = await getDb();
  const { applyEventMutex } = await import("./projection");
  const updated = await applyEventMutex.runExclusive(async () => {
    const row = await db.getFirstAsync<CustomerReminder>(
      "SELECT * FROM customer_reminders WHERE id = ? AND owner_scope = ? AND install_id = ?",
      id,
      owner,
      install,
    );
    if (!row) return false;
    const schedule = readReminderSchedule(row);
    const next =
      !remove && schedule && schedule.kind !== "once"
        ? nextReminderOccurrence(schedule, Date.now())
        : null;
    if (
      owner !== reminderOwnerScope() ||
      accountInstall !== getInstallIdSync() ||
      install !== getReminderDeviceIdSync()
    )
      throw new Error("reminder_account_changed");
    await db.runAsync(
      "UPDATE customer_reminders SET enabled=?, next_due_at=?, updated_at=? WHERE id=? AND owner_scope=? AND install_id=?",
      next == null ? 0 : 1,
      next ?? row.next_due_at,
      Date.now(),
      id,
      owner,
      install,
    );
    return true;
  });
  if (updated) changed();
}

/** Setup reads the customer through the same access gate as private reminders. */
export async function readReminderCustomer(
  vaultId: string,
  personId: string,
): Promise<{ name: string } | null> {
  const owner = reminderOwnerScope();
  const accountInstall = getInstallIdSync();
  const db = await getDb();
  if (!(await canReadReminderVault(db, vaultId))) return null;
  const row = await db.getFirstAsync<{ name: string }>(
    `SELECT u.display_name AS name FROM users u
    WHERE u.id = ? AND u.is_local_self = 0 AND u.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM relationships r WHERE r.vault_id = ? AND r.archived_at IS NULL
        AND (r.user_a_id = u.id OR r.user_b_id = u.id))`,
    personId,
    vaultId,
  );
  return owner === reminderOwnerScope() && accountInstall === getInstallIdSync() ? row : null;
}
