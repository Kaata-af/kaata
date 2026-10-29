// Additive upgrade of a synthetic old database; no phone or user records.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compile, declaration } from "./person-currency-selftest";

const migrations = compile(
  `const MIGRATION_048="048_customer_notes";
   ${declaration("../db", "columnExists")}
   export ${declaration("../db", "hasRunMigration")}
   export ${declaration("../db", "runMigration048")}`,
  (name) => {
    throw new Error(`Unexpected migration dependency: ${name}`);
  },
);

async function main() {
  for (const alreadyHasColumn of [false, true]) {
    const sql = new Database(":memory:");
    try {
      sql.exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
        CREATE TABLE relationships(id TEXT PRIMARY KEY,field_hlcs TEXT${alreadyHasColumn ? ",note TEXT" : ""});
        CREATE TABLE sync_state(vault_id TEXT,last_pulled_server_seq INTEGER);
        CREATE TABLE entries(id TEXT,amount_afn INTEGER,created_at INTEGER);
        CREATE TABLE event_log(event_id TEXT,applied_at INTEGER,quarantine_reason TEXT);
        INSERT INTO relationships(id,field_hlcs) VALUES('contact','{"default_entry_currency":{"pms":7,"l":0,"did":"old"}}');
        INSERT INTO sync_state VALUES('book',777);
        INSERT INTO entries VALUES('money',12345,456);
        INSERT INTO event_log VALUES('signed-event',789,NULL);`);
      if (alreadyHasColumn) sql.exec("UPDATE relationships SET note='Keep existing instructions'");
      const moneyBefore = sql.prepare("SELECT * FROM entries").all();
      const eventsBefore = sql.prepare("SELECT * FROM event_log").all();
      const cursorsBefore = sql.prepare("SELECT * FROM sync_state").all();
      const clocksBefore = sql.prepare("SELECT field_hlcs FROM relationships").get();
      const db = {
        execAsync: async (query: string) => sql.exec(query),
        getAllAsync: async (query: string, ...args: any[]) => sql.prepare(query).all(...args),
        getFirstAsync: async (query: string, ...args: any[]) => sql.prepare(query).get(...args),
        runAsync: async (query: string, ...args: any[]) => sql.prepare(query).run(...args),
        withTransactionAsync: async (work: () => Promise<void>) => {
          sql.exec("BEGIN");
          try {
            await work();
            sql.exec("COMMIT");
          } catch (error) {
            sql.exec("ROLLBACK");
            throw error;
          }
        },
      };
      assert.equal(await migrations.hasRunMigration(db, "048_customer_notes"), false);
      await migrations.runMigration048(db);
      assert.equal(await migrations.hasRunMigration(db, "048_customer_notes"), true);
      assert.deepEqual(sql.prepare("SELECT * FROM entries").all(), moneyBefore);
      assert.deepEqual(sql.prepare("SELECT * FROM event_log").all(), eventsBefore);
      assert.deepEqual(sql.prepare("SELECT * FROM sync_state").all(), cursorsBefore);
      assert.deepEqual(sql.prepare("SELECT field_hlcs FROM relationships").get(), clocksBefore);
      assert.equal(
        (sql.prepare("SELECT note FROM relationships").get() as any).note,
        alreadyHasColumn ? "Keep existing instructions" : null,
      );
    } finally {
      sql.close();
    }
  }
  console.log(
    "PASS customer note upgrade preserves records, signatures, clocks, sync positions and existing notes",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
