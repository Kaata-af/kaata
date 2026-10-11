import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as schedule from "../reminder-schedule";
import { Mutex } from "../util/mutex";
import { compileUI, deferred, settleUI } from "./ui-fixture";

async function main() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,archived_at INTEGER,name TEXT);
    CREATE TABLE users(id TEXT PRIMARY KEY,display_name TEXT,archived_at INTEGER,is_local_self INTEGER);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_a_id TEXT,user_b_id TEXT,archived_at INTEGER);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,accepted_at INTEGER,revoked_at INTEGER);
    INSERT INTO vaults VALUES ('local',NULL,'House'),('shared',NULL,'Shop'),('archived',1,'Old');
    INSERT INTO users VALUES ('customer','Customer',NULL,0),('other','Other',NULL,0),('self','Me',NULL,1),('archived','Old',1,0);
    INSERT INTO relationships VALUES ('r1','local','self','customer',NULL),('r2','shared','self','customer',NULL),('r3','local','self','archived',NULL);
    INSERT INTO vault_members_mirror VALUES ('shared','account-a',1,NULL);`);
  let account: string | null = "account-a",
    appInstall = "cloned-db-install",
    physicalDevice = "phone-a",
    uuid = 0;
  let dbGate: Promise<void> | null = null,
    accessGate: Promise<void> | null = null;
  const db: any = {
    execAsync: async (sql: string) => {
      sqlite.exec(sql);
    },
    runAsync: async (sql: string, ...args: any[]) => sqlite.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: any[]) => sqlite.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) => sqlite.prepare(sql).all(...args),
    withTransactionAsync: async (fn: () => Promise<void>) => {
      sqlite.exec("BEGIN");
      try {
        await fn();
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const applyEventMutex = new Mutex();
  const service = compileUI("../customer-reminders", {
    "expo-crypto": { randomUUID: () => `reminder-${++uuid}` },
    "./db-tx": {
      getAccountIdSync: () => account,
      getInstallIdSync: () => appInstall,
      getDb: async () => {
        if (dbGate) await dbGate;
        return db;
      },
    },
    "./effective-account": {
      resolveAccountIdCandidates: async () => {
        const captured = account;
        if (accessGate) await accessGate;
        return captured ? [captured, "retired-device"] : [appInstall];
      },
    },
    "./reminder-device": {
      getReminderDeviceId: async () => physicalDevice,
      getReminderDeviceIdSync: () => physicalDevice,
    },
    "./reminder-schedule": schedule,
    "./projection": { applyEventMutex },
  });
  await service.migrateCustomerReminders(db);
  assert.equal(
    (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name=?")
        .get(service.REMINDER_MIGRATION) as any
    )?.n,
    1,
  );
  assert.ok(
    sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='customer_reminders_due'",
      )
      .get(),
  );
  const once = { kind: "once", at: Date.now() + 3600_000 };
  let changed = 0;
  const unsubscribe = service.onCustomerRemindersChanged(() => changed++);
  service.onCustomerRemindersChanged(() => {
    throw new Error("consumer failure");
  });
  const first = await service.saveCustomerReminder("shared", "customer", once);
  assert.equal((await service.listCustomerReminders())[0].install_id, "phone-a");
  assert.deepEqual(await service.readReminderCustomer("shared", "customer"), { name: "Customer" });
  assert.equal(await service.readReminderCustomer("shared", "self"), null);
  for (const [vault, person] of [
    ["shared", "self"],
    ["shared", "other"],
    ["local", "archived"],
    ["archived", "customer"],
  ]) {
    await assert.rejects(
      service.saveCustomerReminder(vault, person, once),
      /reminder_access_denied/,
    );
  }
  sqlite.prepare("UPDATE vault_members_mirror SET accepted_at=NULL").run();
  assert.deepEqual(
    await service.listCustomerReminders(),
    [],
    "pending member cannot read private reminders",
  );
  await assert.rejects(
    service.saveCustomerReminder("shared", "customer", once),
    /reminder_access_denied/,
  );
  sqlite.prepare("UPDATE vault_members_mirror SET accepted_at=1,revoked_at=1").run();
  assert.deepEqual(await service.listCustomerReminders(), []);
  sqlite.prepare("UPDATE vault_members_mirror SET revoked_at=NULL").run();
  const laneGate = deferred<void>();
  const incomingRevocation = applyEventMutex.runExclusive(async () => {
    await laneGate.promise;
    sqlite.prepare("UPDATE vault_members_mirror SET revoked_at=1").run();
  });
  const queuedSave = service.saveCustomerReminder("shared", "customer", once);
  await settleUI();
  laneGate.resolve();
  await incomingRevocation;
  await assert.rejects(
    queuedSave,
    /reminder_access_denied/,
    "queued save rechecks membership inside ledger mutation lane",
  );
  sqlite.prepare("UPDATE vault_members_mirror SET revoked_at=NULL").run();
  account = "account-b";
  assert.deepEqual(await service.listCustomerReminders(), []);
  await assert.rejects(
    service.saveCustomerReminder("local", "customer", once, first),
    /reminder_access_denied/,
    "another owner cannot edit by known id",
  );
  account = "account-a";
  physicalDevice = "phone-b";
  assert.deepEqual(
    await service.listCustomerReminders(),
    [],
    "OS database backup with cloned app_meta install does not expose phone-a reminders",
  );
  await service.dismissCustomerReminder(first);
  assert.equal(
    (sqlite.prepare("SELECT enabled FROM customer_reminders WHERE id=?").get(first) as any)
      ?.enabled,
    1,
  );
  await assert.rejects(
    service.saveCustomerReminder("shared", "customer", once, first),
    /reminder_access_denied/,
  );
  physicalDevice = "phone-a";
  assert.equal(
    (await service.listCustomerReminders()).length,
    1,
    "same phone rolling DB recovery retains reminders",
  );
  await service.saveCustomerReminder(
    "shared",
    "customer",
    { kind: "daily", hour: 9, minute: 30 },
    first,
  );
  await service.dismissCustomerReminder(first);
  const recurring = sqlite.prepare("SELECT * FROM customer_reminders WHERE id=?").get(first) as any;
  assert.equal(recurring.enabled, 1);
  assert.ok(recurring.next_due_at > Date.now());
  const second = await service.saveCustomerReminder("local", "customer", once);
  await service.dismissCustomerReminder(second);
  assert.equal(
    (sqlite.prepare("SELECT enabled FROM customer_reminders WHERE id=?").get(second) as any)
      ?.enabled,
    0,
    "one-off completion disables even if called before its future time",
  );
  await service.dismissCustomerReminder(first, true);
  assert.equal((await service.listCustomerReminders()).length, 0);
  const monthly = {
    kind: "monthly",
    day: 15,
    intervalMonths: 2,
    anchorMonth: 0,
    hour: 9,
    minute: 30,
  };
  const expensive: string[] = [];
  for (let i = 0; i < 8; i++)
    expensive.push(await service.saveCustomerReminder("local", "customer", monthly));
  const selected = await service.saveCustomerReminder("local", "customer", {
    kind: "weekdays",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    hour: 10,
    minute: 30,
  });
  const lastSlot = await service.saveCustomerReminder("local", "customer", once);
  await assert.rejects(
    service.saveCustomerReminder("local", "customer", once),
    /reminder_notification_limit/,
    "56 persistent native requests is an enforced budget",
  );
  await assert.rejects(
    service.saveCustomerReminder("local", "customer", monthly, lastSlot),
    /reminder_notification_limit/,
    "editing a cheap reminder cannot overrun the native budget",
  );
  await service.saveCustomerReminder("local", "customer", once, expensive[0]);
  const afterReplacement = await service.saveCustomerReminder("local", "customer", once);
  for (const id of [...expensive, selected, lastSlot, afterReplacement])
    await service.dismissCustomerReminder(id, true);
  const disabled = await service.saveCustomerReminder("local", "customer", once);
  await service.dismissCustomerReminder(disabled, true);
  for (let i = 0; i < service.MAX_ACTIVE_REMINDERS; i++)
    await service.saveCustomerReminder("local", "customer", once);
  await assert.rejects(service.saveCustomerReminder("local", "customer", once), /reminder_limit/);
  await assert.rejects(
    service.saveCustomerReminder("local", "customer", once, disabled),
    /reminder_limit/,
    "re-enabling a disabled task cannot exceed the 40-task limit",
  );
  const active = (await service.listCustomerReminders())[0];
  await service.saveCustomerReminder(
    "local",
    "customer",
    { kind: "daily", hour: 20, minute: 10 },
    active.id,
  );
  const gate = deferred<void>();
  dbGate = gate.promise;
  const pendingRead = service.listCustomerReminders();
  const pendingSave = service.saveCustomerReminder("local", "customer", once, active.id);
  await settleUI();
  account = "account-b";
  gate.resolve();
  assert.deepEqual(await pendingRead, [], "late read cannot paint previous account");
  await assert.rejects(pendingSave, /reminder_account_changed/);
  dbGate = null;
  account = "account-a";
  sqlite.prepare("UPDATE relationships SET archived_at=1 WHERE vault_id='local'").run();
  assert.equal(
    (await service.listCustomerReminders()).length,
    0,
    "archived ledger drops tasks from live list",
  );
  sqlite.prepare("DELETE FROM users WHERE id='customer'").run();
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) AS n FROM customer_reminders").get() as any)?.n,
    0,
    "customer deletion cascades private task cleanup",
  );
  assert.ok(changed > 40);
  unsubscribe();
  sqlite.close();
  console.log(
    "Customer reminders: real SQLite migration, access, account/device isolation, completion, limits and stale read/write checks passed.",
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
