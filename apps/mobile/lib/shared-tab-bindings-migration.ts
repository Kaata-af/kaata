import type { SQLiteDatabase } from "expo-sqlite";

/** A financial book can be visible through both participating Kaatas. Keep its
 * entries once, and store each Kaata's permissions and perspective separately.
 * Runs inside migration 055's transaction with foreign keys still enabled. */
export async function migrateSharedTabBindings(db: SQLiteDatabase): Promise<void> {
  const names = ["tab_links", "tab_entries", "tab_settlements", "tab_outbox", "tab_failed_ops"];
  const catalog = await db.getAllAsync<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL");
  await db.execAsync(`CREATE TABLE tab_books (tab_id TEXT PRIMARY KEY);
    INSERT INTO tab_books(tab_id) SELECT tab_id FROM tab_links;`);
  // An interrupted old operation may outlive its link. Preserve that intent,
  // but leave its vault empty so it cannot be submitted as the wrong party.
  await db.execAsync("INSERT OR IGNORE INTO tab_books(tab_id) SELECT tab_id FROM tab_outbox;");
  for (const name of names) {
    const original = catalog.find((row) => row.type === "table" && row.name === name);
    if (!original) throw new Error(`migration 055: missing ${name}`);
    let sql = original.sql.replace(
      /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?\w+["`\]]?/i,
      `CREATE TABLE _055_${name}`,
    );
    if (name === "tab_links") {
      sql = sql
        .replace(/tab_id\s+TEXT\s+PRIMARY KEY/i, "tab_id TEXT NOT NULL")
        .replace(/\)\s*$/, ", invitation_expires_at INTEGER, PRIMARY KEY(tab_id,vault_id))");
    } else {
      sql = sql.replace(
        /REFERENCES\s+["`\[]?tab_links["`\]]?\s*\(tab_id\)/gi,
        "REFERENCES tab_books(tab_id)",
      );
    }
    const scopedIntent = name === "tab_outbox" || name === "tab_failed_ops";
    if (scopedIntent) sql = sql.replace(/\)\s*$/, ", vault_id TEXT NOT NULL DEFAULT '')");
    await db.execAsync(sql);
    const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${name})`);
    const quoted = columns.map((column) => `"${column.name}"`).join(",");
    await db.execAsync(
      scopedIntent
        ? `INSERT INTO _055_${name} (${quoted},vault_id) SELECT ${columns.map((c) => `old."${c.name}"`).join(",")},
           COALESCE((SELECT vault_id FROM tab_links l WHERE l.tab_id=old.tab_id),'') FROM ${name} old;`
        : `INSERT INTO _055_${name} (${quoted}) SELECT ${quoted} FROM ${name};`,
    );
  }
  // Drop children first: no cascade may erase the newly copied shared book.
  for (const name of [...names.slice(1), names[0]]) await db.execAsync(`DROP TABLE ${name};`);
  for (const name of names) await db.execAsync(`ALTER TABLE _055_${name} RENAME TO ${name};`);
  for (const index of catalog.filter(
    (row) => row.type === "index" && names.includes(row.tbl_name),
  )) {
    const sql =
      index.name === "idx_tab_links_open_rel"
        ? "CREATE UNIQUE INDEX idx_tab_links_open_rel ON tab_links(vault_id,relationship_id,currency) WHERE closed_at IS NULL"
        : index.sql;
    await db.execAsync(sql);
  }
  await db.execAsync(`CREATE TRIGGER tab_links_insert_book BEFORE INSERT ON tab_links BEGIN
      INSERT OR IGNORE INTO tab_books(tab_id) VALUES(NEW.tab_id);
    END;
    CREATE TRIGGER tab_links_delete_book AFTER DELETE ON tab_links BEGIN
      DELETE FROM tab_books WHERE tab_id=OLD.tab_id
        AND NOT EXISTS(SELECT 1 FROM tab_links WHERE tab_id=OLD.tab_id);
    END;
    CREATE INDEX idx_tab_outbox_scope ON tab_outbox(tab_id,vault_id);
    CREATE INDEX idx_tab_failed_ops_scope ON tab_failed_ops(tab_id,vault_id);`);
  const violations = await db.getAllAsync("PRAGMA foreign_key_check");
  if (violations.length) throw new Error("migration 055: shared book foreign key check failed");
}
