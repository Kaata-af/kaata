import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { effectiveEntryCurrencySql } from "./currency-scope";
import type { SQLiteTx } from "./db-tx";

export const BACKUP_DATABASE_LIMIT = 64 * 1024 * 1024;
const CSV_LIMIT = 24 * 1024 * 1024;
export const DRIVE_BACKUP_FILE_LIMIT = BACKUP_DATABASE_LIMIT + CSV_LIMIT + 4096;

const DATABASE = "Kaata.sqlite3";
const MANIFEST = "Kaata-backup-v1.sha256";
const README = `Kaata Google Drive backup

This ZIP is unencrypted. Keep it private.

Extract the CSV files and open them in any spreadsheet app. Contacts, private
tallies, shared tallies, settlements and staff notes are separate tables. All
dates shown are UTC. Amounts are in the listed currency's major units. Private
debt means you gave money or goods. Private payment means you received it.
Shared records show who gave, their status and whether they were voided or
still pending. Keep statuses and settlement history in mind when totaling rows.

Kaata.sqlite3 is the complete sanitized database. It can be opened with any
SQLite reader. To restore in Kaata, keep the original ZIP intact and select it
under Backups. Restoration uses the database, not edits to the CSV files.
`;

export class DriveBackupTooLargeError extends Error {}

type Cell = string | number | null;
type CsvTables = Record<string, Uint8Array>;

function utc(column: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${column}/1000.0, 'unixepoch')`;
}

const CONTACT = `JOIN relationships r ON r.id = e.relationship_id AND r.vault_id = e.vault_id
  JOIN users u ON u.id = r.user_b_id JOIN vaults v ON v.id = r.vault_id`;
const SHARED_CONTACT = `JOIN tab_links l ON l.tab_id = e.tab_id
  LEFT JOIN relationships r ON r.id = l.relationship_id AND r.vault_id = l.vault_id
  LEFT JOIN users u ON u.id = r.user_b_id JOIN vaults v ON v.id = l.vault_id`;

const TABLES = [
  {
    file: "Contacts.csv",
    columns: ["Kaata", "Contact", "Phone", "Customer note", "Archived at UTC", "Contact ID"],
    sql: `SELECT v.name, u.display_name, u.phone_e164, r.note, ${utc("r.archived_at")}, r.id
          FROM relationships r JOIN users u ON u.id = r.user_b_id JOIN vaults v ON v.id = r.vault_id
          ORDER BY v.name, u.display_name, r.id`,
  },
  {
    file: "Private tallies.csv",
    columns: [
      "Kaata",
      "Contact",
      "Date UTC",
      "Direction",
      "Amount",
      "Currency",
      "Note",
      "Tally ID",
    ],
    sql: `SELECT v.name, u.display_name, ${utc("e.created_at")},
            CASE e.type WHEN 'debt' THEN 'Gave' ELSE 'Received' END,
            e.amount_afn, ${effectiveEntryCurrencySql("e", "v")}, e.note, e.id
          FROM entries e ${CONTACT} WHERE e.is_deleted = 0
          ORDER BY v.name, e.created_at, e.id`,
  },
  {
    file: "Shared tallies.csv",
    columns: [
      "Kaata",
      "Contact",
      "Date UTC",
      "Direction",
      "Amount",
      "Currency",
      "Note",
      "Kind",
      "Status",
      "Voided",
      "Pending upload",
      "Tally ID",
    ],
    sql: `SELECT v.name, COALESCE(u.display_name, l.other_label), ${utc("e.occurred_at")},
            CASE WHEN (e.direction = 'a_to_b' AND l.role = 'a') OR
                      (e.direction = 'b_to_a' AND l.role = 'b') THEN 'Gave' ELSE 'Received' END,
            ROUND(e.amount_minor / 100.0, 2), l.currency, e.note, e.kind, e.status,
            CASE WHEN e.voided_by_entry_id IS NULL THEN 'No' ELSE 'Yes' END,
            CASE WHEN e.local_pending = 0 THEN 'No' ELSE 'Yes' END, e.id
          FROM tab_entries e ${SHARED_CONTACT} ORDER BY v.name, e.occurred_at, e.id`,
  },
  {
    file: "Settlements.csv",
    columns: ["Kaata", "Contact", "Date UTC", "Kind", "Settlement ID"],
    sql: `SELECT v.name, u.display_name, ${utc("e.settled_at_ms")}, 'Private', e.id
          FROM settlements e ${CONTACT}
          UNION ALL
          SELECT v.name, COALESCE(u.display_name, l.other_label), ${utc("e.settled_at_ms")}, 'Shared', e.id
          FROM tab_settlements e ${SHARED_CONTACT} ORDER BY 1, 3, 5`,
  },
  {
    file: "Tally notes.csv",
    columns: ["Kaata", "Contact", "Date UTC", "Note", "Number", "Note ID"],
    sql: `SELECT v.name, u.display_name, ${utc("e.created_at")}, e.note, e.number_text, e.id
          FROM tally_notes e ${CONTACT} WHERE e.removed_at IS NULL AND e.note IS NOT NULL
          ORDER BY v.name, e.created_at, e.id`,
  },
];

function csvLine(cells: readonly Cell[]): string {
  return (
    cells
      .map((cell) => {
        if (cell === null) return "";
        if (typeof cell === "number") return String(cell);
        // Keep user text and phone numbers from becoming spreadsheet formulas.
        const value = /^\s*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell) ? `'${cell}` : cell;
        return `"${value.replaceAll('"', '""')}"`;
      })
      .join(",") + "\r\n"
  );
}

/** Read the same sanitized snapshot that the ZIP will restore. */
export async function readDriveBackupTables(
  db: Pick<SQLiteTx, "getEachAsync">,
): Promise<CsvTables> {
  const files: CsvTables = {};
  let total = 0;
  for (const { file, columns, sql } of TABLES) {
    const lines = ["\uFEFF" + csvLine(columns)];
    for await (const row of db.getEachAsync<Record<string, Cell>>(sql)) {
      const line = csvLine(Object.values(row));
      total += strToU8(line).length;
      if (total > CSV_LIMIT)
        throw new DriveBackupTooLargeError("Backup spreadsheets are too large");
      lines.push(line);
    }
    files[file] = strToU8(lines.join(""));
  }
  return files;
}

export function createDriveBackup(database: Uint8Array, tables: CsvTables): Uint8Array {
  if (database.length > BACKUP_DATABASE_LIMIT) throw new DriveBackupTooLargeError();
  return zipSync(
    {
      ...tables,
      "Read me.txt": strToU8(README),
      [MANIFEST]: strToU8(bytesToHex(sha256(database))),
      [DATABASE]: database,
    },
    { level: 0 },
  );
}

/** Only extract our two bounded, uncompressed members. CSVs are never imported. */
export function openDriveBackup(archive: Uint8Array): Uint8Array {
  if (archive.length > DRIVE_BACKUP_FILE_LIMIT) throw new DriveBackupTooLargeError();
  const selected = new Set<string>();
  const files = unzipSync(archive, {
    filter({ name, compression, size, originalSize }) {
      if (name !== DATABASE && name !== MANIFEST) return false;
      const limit = name === DATABASE ? BACKUP_DATABASE_LIMIT : 64;
      if (
        selected.has(name) ||
        compression !== 0 ||
        size !== originalSize ||
        size < 1 ||
        size > limit
      )
        throw new Error("Invalid Kaata ZIP member");
      selected.add(name);
      return true;
    },
  });
  const database = files[DATABASE];
  const digest = files[MANIFEST];
  if (!database || !digest || strFromU8(digest) !== bytesToHex(sha256(database))) {
    database?.fill(0);
    throw new Error("Invalid Kaata ZIP checksum");
  }
  return database;
}
