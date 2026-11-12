import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { SQLiteDatabase } from "expo-sqlite";
import { migrateSharedTabBindings } from "../shared-tab-bindings-migration";

async function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE tab_links(tab_id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,
    relationship_id TEXT NOT NULL,currency TEXT NOT NULL,role TEXT NOT NULL,
    closed_at INTEGER,party_token TEXT,rev INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX idx_tab_links_open_rel ON tab_links(relationship_id,currency) WHERE closed_at IS NULL;
    CREATE TABLE tab_entries(id TEXT PRIMARY KEY,tab_id TEXT NOT NULL REFERENCES tab_links(tab_id) ON DELETE CASCADE,
      amount_minor INTEGER NOT NULL,note TEXT,local_pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tab_settlements(id TEXT PRIMARY KEY,tab_id TEXT NOT NULL REFERENCES tab_links(tab_id) ON DELETE CASCADE,
      through_seq INTEGER NOT NULL,UNIQUE(tab_id,through_seq));
    CREATE TABLE tab_outbox(id TEXT PRIMARY KEY,tab_id TEXT NOT NULL,op TEXT NOT NULL,payload TEXT CHECK(json_valid(payload)));
    CREATE TABLE tab_failed_ops(id TEXT PRIMARY KEY,tab_id TEXT NOT NULL REFERENCES tab_links(tab_id) ON DELETE CASCADE,reason TEXT);
    INSERT INTO tab_links VALUES('tab','own','contact','AFN','a',NULL,'capability',23);
    INSERT INTO tab_entries VALUES('entry','tab',50000,'preserve me',1);
    INSERT INTO tab_settlements VALUES('settlement','tab',2);
    INSERT INTO tab_outbox VALUES('queued','tab','append','{"amount_minor":50000}');
    INSERT INTO tab_outbox VALUES('orphan','lost-tab','append','{"amount_minor":700}');
    INSERT INTO tab_failed_ops VALUES('refused','tab','permission_denied');`);
  const adapter = {
    execAsync: async (sql: string) => db.exec(sql),
    getAllAsync: async (sql: string) => db.prepare(sql).all(),
  } as unknown as SQLiteDatabase;
  const before = db.prepare("SELECT * FROM tab_entries").all();
  db.exec("BEGIN");
  await migrateSharedTabBindings(adapter);
  db.exec("COMMIT");
  assert.deepEqual(db.prepare("SELECT * FROM tab_entries").all(), before);
  assert.equal(db.prepare("SELECT party_token FROM tab_links").pluck().get(), "capability");
  assert.equal(db.prepare("SELECT rev FROM tab_links").pluck().get(), 23);
  assert.equal(
    db.prepare("SELECT vault_id FROM tab_outbox WHERE id='queued'").pluck().get(),
    "own",
  );
  assert.equal(db.prepare("SELECT vault_id FROM tab_failed_ops").pluck().get(), "own");
  assert.equal(db.prepare("SELECT vault_id FROM tab_outbox WHERE id='orphan'").pluck().get(), "");
  db.exec(`INSERT INTO tab_links(tab_id,vault_id,relationship_id,currency,role) VALUES('tab','joined','other-contact','AFN','b');
    DELETE FROM tab_links WHERE vault_id='own';`);
  assert.deepEqual(
    db.prepare("SELECT * FROM tab_entries").all(),
    before,
    "deleting one perspective retains the shared book",
  );
  assert.equal(db.prepare("SELECT COUNT(*) FROM tab_settlements").pluck().get(), 1);
  db.exec("DELETE FROM tab_links WHERE vault_id='joined'");
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM tab_entries").pluck().get(),
    0,
    "last binding cleans child cache",
  );
  assert.equal(db.prepare("SELECT COUNT(*) FROM tab_settlements").pluck().get(), 0);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  db.close();
  console.log(
    "PASS: shared binding upgrade retains money, notes, settlements, capabilities and offline intent; dual-view deletion is safe",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
