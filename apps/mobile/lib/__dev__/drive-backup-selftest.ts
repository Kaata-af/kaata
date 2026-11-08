import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createDriveBackup, openDriveBackup, readDriveBackupTables } from "../drive-backup";

async function main() {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE vaults(id, name, currency, legacy_currency);
      INSERT INTO vaults VALUES('shop','Demo shop','USD','AFN');
      CREATE TABLE users(id, display_name, phone_e164);
      INSERT INTO users VALUES('user','احمد', '+93700000000');
      CREATE TABLE relationships(id, vault_id, user_b_id, note, archived_at);
      INSERT INTO relationships VALUES('contact','shop','user',' =1+1',NULL);
      CREATE TABLE entries(id, vault_id, relationship_id, type, amount_afn, currency, note, created_at, is_deleted);
      INSERT INTO entries VALUES('private','shop','contact','debt',25.75,NULL,'Tea',1700000000000,0);
      INSERT INTO entries VALUES('deleted','shop','contact','debt',99,NULL,'Hidden',1700000000000,1);
      CREATE TABLE tab_links(tab_id, relationship_id, vault_id, role, currency, other_label);
      INSERT INTO tab_links VALUES('tab','contact','shop','b','USD','Ahmad');
      CREATE TABLE tab_entries(id, tab_id, direction, amount_minor, note, kind, occurred_at, status, voided_by_entry_id, local_pending);
      INSERT INTO tab_entries VALUES('shared','tab','b_to_a',1075,'Bread','entry',1700000000000,'accepted',NULL,0);
      CREATE TABLE settlements(id, vault_id, relationship_id, settled_at_ms);
      INSERT INTO settlements VALUES('paid','shop','contact',1700000000000);
      CREATE TABLE tab_settlements(id, tab_id, settled_at_ms);
      INSERT INTO tab_settlements VALUES('cleared','tab',1700000000000);
      CREATE TABLE tally_notes(id, vault_id, relationship_id, note, created_at, removed_at, number_text);
      INSERT INTO tally_notes VALUES('note','shop','contact','Check with Ahmad',1700000000000,NULL,'5.00');
    `);
    const files = await readDriveBackupTables({
      async *getEachAsync<T>(sql: string) {
        yield* db.prepare<[], T>(sql).iterate();
      },
    });
    const database = db.serialize();
    const zip = createDriveBackup(database, files);
    const members = unzipSync(zip);
    assert.deepEqual(Buffer.from(openDriveBackup(zip)), database);
    assert.match(strFromU8(members["Contacts.csv"]), /احمد.*'\+93700000000.*' =1\+1/);
    assert.match(strFromU8(members["Private tallies.csv"]), /"Gave",25.75,"AFN","Tea"/);
    assert.doesNotMatch(strFromU8(members["Private tallies.csv"]), /Hidden/);
    assert.match(strFromU8(members["Shared tallies.csv"]), /"Gave",10.75,"USD","Bread"/);
    assert.match(strFromU8(members["Settlements.csv"]), /"Shared","cleared"/);
    assert.match(strFromU8(members["Tally notes.csv"]), /"Check with Ahmad","5\.00"/);
    assert.match(strFromU8(members["Read me.txt"]), /unencrypted/);
    const rawDb = new Database(Buffer.from(members["Kaata.sqlite3"]));
    try {
      assert.deepEqual(rawDb.prepare("SELECT amount_afn FROM entries WHERE id='private'").get(), {
        amount_afn: 25.75,
      });
    } finally {
      rawDb.close();
    }
    members["Kaata-backup-v1.sha256"] = strToU8("0".repeat(64));
    assert.throws(() => openDriveBackup(zipSync(members, { level: 0 })), /checksum/);
    assert.throws(() => openDriveBackup(zipSync(members)), /Invalid Kaata ZIP member/);
    assert.throws(() => openDriveBackup(zipSync({ "unrelated.txt": strToU8("other") })));
    console.log(
      "PASS Google Drive backup: standard ZIP, readable CSVs, SQLite restore and bounded validation",
    );
  } finally {
    db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
