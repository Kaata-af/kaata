// Rolling local backup of the ledger — and the restore that makes it worth
// having.
//
// Why this exists: roughly half of Kaata's users never sign in, so the server
// snapshot doesn't protect them at all, and before this there was NOTHING
// between "database is corrupt" and "reinstall the app", which erases the
// book. Even for signed-in users, corruption predating the last sync costs
// entries the server never saw.
//
// Mechanism is SQLite's own Online Backup API (expo-sqlite's
// backupDatabaseAsync), not a file copy: copying kaata.db behind SQLite's back
// can capture a torn page or miss the WAL entirely and yield a file that looks
// fine until you read the wrong page.
//
// Design rules, each of which is a bug this would otherwise have shipped with:
//
//  - TWO generations. One slot means a backup taken AFTER corruption
//    overwrites the last good copy.
//  - Verify the COPY before promoting it, and check it isn't EMPTY. The native
//    backup discards sqlite3_backup_step's return value, so a partial copy can
//    still "succeed" and pass quick_check while containing nothing.
//  - Never reuse a File object across a move(). expo-file-system rewrites the
//    receiver's uri to the destination, so a second move on the same object
//    silently targets the wrong path.
//  - The interval lives in app_meta, not memory: a module global resets on
//    every cold start, and these phones kill processes constantly.
import { Directory, File, Paths } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { runQuickCheck } from "./db-health";
import {
  DB_NAME,
  getAppMetaInTx,
  getDb,
  setAppMetaInTx,
  _resetAccountIdCacheForReset,
  _resetActiveVaultIdCacheForReset,
  _resetDbHandleForReset,
} from "./db-tx";

// expo-sqlite resolves database names against <documents>/SQLite.
const SQLITE_DIR = "SQLite";
const CURRENT = "kaata.backup.db";
const PREVIOUS = "kaata.backup.prev.db";
const SCRATCH = "kaata.backup.tmp.db";
const RESTORE_STAGING = "kaata.restore.tmp.db";
const CORRUPT_KEEP = "kaata.corrupt.db";
const LAST_BACKUP_KEY = "last_local_backup_at";

/** Every file expo-sqlite may create for a database, so wipes leave nothing. */
function sqliteSidecars(name: string): string[] {
  return [name, `${name}-wal`, `${name}-shm`, `${name}-journal`];
}

function sqliteFile(name: string): File {
  return new File(new Directory(Paths.document, SQLITE_DIR), name);
}

function deleteQuietly(name: string): void {
  try {
    const f = sqliteFile(name);
    if (f.exists) f.delete();
  } catch {
    /* best-effort */
  }
}

/**
 * Move a WAL/SHM sidecar to `to`, or delete it if `to` is already taken.
 *
 * Sidecars are never simply deleted when parking a damaged database. Under
 * `synchronous=FULL` in WAL mode the newest commits live in the `-wal` until a
 * checkpoint, and the clean close that would checkpoint them is precisely the
 * one that fails on a damaged file. Deleting it would cut today's entries out
 * of the only copy that still holds them.
 *
 * It must not be left behind either: a `-wal` sitting beside the restored
 * database belongs to the OLD file and would be replayed over the new one.
 */
function relocateSidecar(from: string, to: string): void {
  const src = sqliteFile(from);
  try {
    if (!src.exists) return;
    if (sqliteFile(to).exists) {
      // The destination already holds an older parked WAL; this one belongs to
      // a file we no longer need. It cannot stay where it is.
      src.delete();
      return;
    }
    src.move(sqliteFile(to));
    return;
  } catch {
    /* fall through to the copy attempt */
  }
  // A failed move (an Android file lock, a directory-entry write error) must
  // not become a delete — that would destroy the commits this whole function
  // exists to save. Try copying first, and only give up if that fails too.
  try {
    src.copy(sqliteFile(to));
  } catch {
    /* nothing else to try */
  }
  deleteQuietly(from);
}

export type BackupInfo = { name: string; modifiedAt: number | null; size: number | null };

/** Newest-first list of the backups that currently exist. */
export function listLocalBackups(): BackupInfo[] {
  const out: BackupInfo[] = [];
  for (const name of [CURRENT, PREVIOUS]) {
    try {
      const f = sqliteFile(name);
      if (f.exists)
        out.push({ name, modifiedAt: f.modificationTime ?? null, size: f.size ?? null });
    } catch {
      // A backup we can't stat is a backup we can't offer — skip it.
    }
  }
  return out;
}

/** Delete every backup generation. Called by the local wipe so "delete my
 *  account" doesn't leave a full plaintext ledger copy sitting on disk. */
export function deleteLocalBackups(): void {
  for (const name of [CURRENT, PREVIOUS, SCRATCH, RESTORE_STAGING, CORRUPT_KEEP]) {
    for (const f of sqliteSidecars(name)) deleteQuietly(f);
  }
}

/**
 * Delete the live database and every sidecar it may have.
 *
 * The caller MUST close the handle first. This exists because
 * `SQLite.deleteDatabaseAsync` throws while a connection is open — precisely
 * the state the recovery screen is in — and because it leaves `-wal` / `-shm`
 * behind, so the next open can replay a stale WAL over the fresh file.
 */
export function deleteLiveDatabaseFiles(): void {
  for (const f of sqliteSidecars(DB_NAME)) deleteQuietly(f);
}

/** Rows in the tables that matter, used to reject an empty/partial copy. */
async function ledgerRowCount(db: SQLite.SQLiteDatabase): Promise<number> {
  let total = 0;
  for (const table of ["event_log", "entries", "relationships", "users"]) {
    try {
      const row = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`);
      total += row?.c ?? 0;
    } catch {
      // Missing table on an early-migration database — counts as zero.
    }
  }
  return total;
}

// Serialises concurrent callers onto one run. Two backups at once would both
// open and write the same scratch file — the app-background trigger and the
// background catch-up task can genuinely overlap on Android.
let inFlight: Promise<boolean> | null = null;

/**
 * Take a verified backup, rotating the previous one aside.
 *
 * Best-effort by contract: never throws into a lifecycle caller, never leaves
 * the live database worse off. Returns true only when a VERIFIED, non-empty
 * copy landed.
 */
export function backupNow(): Promise<boolean> {
  if (!inFlight) {
    inFlight = runBackup().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runBackup(): Promise<boolean> {
  let dest: SQLite.SQLiteDatabase | null = null;
  // False until we've decided there is something worth copying — see the
  // interval stamp in the finally block.
  let attempted = false;
  try {
    const source = await getDb();
    const sourceRows = await ledgerRowCount(source);
    // Nothing to protect yet, and — more importantly — DON'T start the 6-hour
    // clock. A fresh install that "backed up" its empty database at first
    // launch would then not back up again until six hours in, which is exactly
    // the window where a new shopkeeper enters their whole customer list.
    if (sourceRows === 0) return false;
    attempted = true;

    // Write to a scratch name so a crash mid-backup can't destroy the last
    // good copy — only a fully written, verified file is promoted.
    for (const f of sqliteSidecars(SCRATCH)) deleteQuietly(f);

    dest = await SQLite.openDatabaseAsync(SCRATCH);
    await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: dest });

    // Verify the COPY, not the original: the point is knowing this file is
    // restorable later, when the original may not be. A copy so damaged that
    // quick_check can't even run makes runQuickCheck THROW, which the outer
    // catch turns into "don't promote".
    //
    // A copy that merely REPORTS damage is still promoted, and that is
    // deliberate. The Online Backup API copies pages verbatim, so a
    // damaged-but-readable database — which lib/db-health.ts lets the app boot
    // on — produces a backup carrying the same complaint. Refusing it would
    // mean the users whose databases are visibly degrading, i.e. the ones most
    // likely to go fatally corrupt, are the only ones with no backup at all.
    // The row count below is the real gate: a copy holding every row is worth
    // keeping whatever quick_check thinks of its indexes.
    const verdict = await runQuickCheck(dest);
    if (verdict !== "ok") {
      console.warn("[db-backup] copy carries the source's damage, promoting anyway:", verdict);
    }
    // sqlite3_backup_step's return value is discarded natively, so a partial
    // copy passes every other check — count the rows and compare.
    const destRows = await ledgerRowCount(dest);
    await dest.closeAsync();
    dest = null;
    if (destRows < sourceRows) {
      console.warn(`[db-backup] copy has ${destRows} rows vs source ${sourceRows} — not promoting`);
      return false;
    }

    // Promote. Re-derive every File handle: move() rewrites the receiver's uri,
    // so reusing one silently retargets the next move. CURRENT's own sidecars
    // are dropped rather than carried across — a -wal left behind by an
    // interrupted probe belongs to the file being demoted, and pairing it with
    // the newly promoted CURRENT is the same hazard the restore guards against
    // for the live database.
    if (sqliteFile(CURRENT).exists) {
      for (const f of sqliteSidecars(PREVIOUS)) deleteQuietly(f);
      sqliteFile(CURRENT).move(sqliteFile(PREVIOUS));
    }
    deleteQuietly(`${CURRENT}-wal`);
    deleteQuietly(`${CURRENT}-shm`);
    sqliteFile(SCRATCH).move(sqliteFile(CURRENT));

    return true;
  } catch (err) {
    console.warn("[db-backup] backup failed", err);
    return false;
  } finally {
    // Stamp the ATTEMPT, not the success. A backup that keeps failing (a
    // source too damaged to copy) would otherwise re-run a full database copy
    // plus a quick_check on every single background transition, forever. The
    // 6-hour interval is the right retry cadence for a failure too. Skipped
    // when there was nothing to copy, so an empty install doesn't start the
    // clock.
    if (attempted) await markBackedUpNow();
    if (dest) {
      try {
        await dest.closeAsync();
      } catch {
        /* already closing */
      }
    }
  }
}

async function markBackedUpNow(): Promise<void> {
  try {
    const db = await getDb();
    await setAppMetaInTx(db, LAST_BACKUP_KEY, String(Date.now()));
  } catch {
    /* the backup still happened; the timestamp is only an optimisation */
  }
}

// Bound the worst case to a few hours of entries without copying the database
// every time a shopkeeper flicks to WhatsApp. Persisted, because a module
// global resets on every process launch — and these phones kill processes
// constantly, which would have meant a full copy almost every session.
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Rate-limited entry point for lifecycle callers. Never throws. */
export async function backupIfDue(): Promise<void> {
  try {
    const db = await getDb();
    const raw = await getAppMetaInTx(db, LAST_BACKUP_KEY);
    const last = raw ? Number(raw) : 0;
    if (Number.isFinite(last) && last > 0 && Date.now() - last < MIN_INTERVAL_MS) return;
    await backupNow();
  } catch (err) {
    console.warn("[db-backup] backupIfDue failed", err);
  }
}

export type RestoreResult = "restored" | "no_backup" | "backup_damaged" | "failed";

export type RestoreCandidate = {
  name: string;
  clean: boolean;
  rows: number;
  modifiedAt: number | null;
};

/**
 * The generation a restore would actually use, or null if none is usable.
 *
 * Exported so the recovery screen can offer the button ONLY when a restore
 * will work, and quote the age of the file it will really use. Before this,
 * the screen keyed off "a backup file exists" and always displayed CURRENT's
 * timestamp — so it could promise a one-hour-old backup and then silently
 * restore a seven-hour-old one, or offer a restore that immediately failed.
 *
 * Selection is simply the NEWEST usable generation. Not the cleanest, and not
 * the one with the most rows — both of those were tried and both are wrong:
 *
 *  - Preferring a clean quick_check would pass over a newer backup that merely
 *    reports damage, and the app itself boots on such a database (see
 *    lib/db-health.ts) while backupNow deliberately keeps copies of them. That
 *    trades real ledger entries for a tidy index.
 *  - Preferring more rows sounds safer and is worse: row count is not a
 *    measure of relevance. After a recovery that ends in a different account
 *    signing in, the retained older generation belongs to the PREVIOUS
 *    account and can easily be the larger of the two — "most rows" would then
 *    quietly install someone else's ledger.
 *
 * Newest wins. It is the only ordering that always answers "the state closest
 * to what the user last saw".
 */
export async function findRestoreCandidate(): Promise<RestoreCandidate | null> {
  const generations = [CURRENT, PREVIOUS].filter((n) => {
    try {
      return sqliteFile(n).exists;
    } catch {
      return false;
    }
  });

  // Grade every generation, and let a failure fall through to the next one.
  // runQuickCheck THROWS on the worst damage rather than returning a verdict,
  // so a newest-backup that is itself unreadable must not abort the whole
  // restore — that would strand the user on a broken database while a
  // perfectly good older generation sat on disk untouched.
  const graded: RestoreCandidate[] = [];
  for (const generation of generations) {
    let probe: SQLite.SQLiteDatabase | null = null;
    try {
      probe = await SQLite.openDatabaseAsync(generation);
      const verdict = await runQuickCheck(probe);
      const rows = await ledgerRowCount(probe);
      if (rows > 0) {
        graded.push({
          name: generation,
          clean: verdict === "ok",
          rows,
          modifiedAt: sqliteFile(generation).modificationTime ?? null,
        });
      }
    } catch (err) {
      console.warn(`[db-backup] backup ${generation} is not usable`, err);
    } finally {
      if (probe) {
        try {
          await probe.closeAsync();
        } catch {
          /* ignore */
        }
      }
      // Probing opened the file in WAL mode; a clean close checkpoints it, but
      // drop the sidecars anyway so a later copy can't pick one up.
      deleteQuietly(`${generation}-wal`);
      deleteQuietly(`${generation}-shm`);
    }
  }

  // `generations` is ordered CURRENT then PREVIOUS — newest first — and only
  // usable candidates were pushed, so the first entry is the answer. No sort:
  // any reordering here is a way to pick an older ledger than the user had.
  return graded[0] ?? null;
}

/**
 * Restore the newest usable backup over the live database.
 *
 * This is the half the feature was missing: a backup nothing can read is not a
 * backup. It works for signed-OUT users, which is the entire point — they have
 * no server copy to fall back on.
 *
 * The damaged database is kept as kaata.corrupt.db rather than deleted. It
 * costs one file, and it is the only remaining copy of anything the backup
 * predates; support (or a later recovery tool) can still mine it.
 *
 * The backup is COPIED into place, never moved. If the restored file turns out
 * to be damaged in a way quick_check didn't catch, the user lands back on the
 * recovery screen with the backup still there to try again — moving it would
 * spend their last copy on a single attempt.
 */
export async function restoreFromLocalBackup(): Promise<RestoreResult> {
  const hasAnyFile = [CURRENT, PREVIOUS].some((n) => {
    try {
      return sqliteFile(n).exists;
    } catch {
      return false;
    }
  });
  if (!hasAnyFile) return "no_backup";

  const candidate = await findRestoreCandidate();
  if (!candidate) return "backup_damaged";
  const chosen = candidate.name;
  if (!candidate.clean) {
    console.warn(`[db-backup] restoring ${chosen}, which reports damage but reads`);
  }

  try {
    // Stage the copy BEFORE touching the live file. If the device is out of
    // space — likely, on the phones this runs on — the copy fails here, with
    // the (damaged, but present) original still in place. Doing it the obvious
    // way round would move the original aside first and, on a failed copy,
    // leave NO database at all: the next getDb() would silently create an
    // empty one and the user would open the app to a blank ledger.
    for (const f of sqliteSidecars(RESTORE_STAGING)) deleteQuietly(f);
    sqliteFile(chosen).copy(sqliteFile(RESTORE_STAGING));

    // Close the live handle: replacing a file out from under an open SQLite
    // connection turns one corrupt database into two.
    //
    // getDb() is called ONLY when the file is actually there. On a retry after
    // an interrupted restore there is no kaata.db, and getDb() would CREATE an
    // empty one — which the parking step below would then dutifully save as
    // "the damaged original", overwriting the real one.
    if (sqliteFile(DB_NAME).exists) {
      try {
        const live = await getDb();
        await live.closeAsync();
      } catch {
        /* it may already be unusable — that's why we're here */
      }
    }
    // Drop the handle AND the id caches. getActiveVaultId() returns its cached
    // value without touching the database when one is set, so without this the
    // re-boot after a restore would keep pointing at the active vault id read
    // out of the damaged file — a vault the restored database may not contain,
    // leaving every list query filtered to nothing.
    _resetDbHandleForReset();
    _resetActiveVaultIdCacheForReset();
    _resetAccountIdCacheForReset();

    // Two renames. The live sidecars must go too: a stale -wal belongs to the
    // OLD file and would be replayed over the restored one.
    //
    // The parked original is only ever replaced when there is a real live file
    // to replace it WITH. Clearing it unconditionally would, on a retry after
    // an interrupted restore, throw away the sole copy of everything the user
    // wrote since the backup was taken.
    // Park the damaged original — but NEVER over an existing one.
    //
    // Pressing Restore a second time is the expected flow when the first
    // attempt doesn't fix boot, and at that point the live file IS the copy we
    // restored last time: we still hold it as a backup, so it is worth
    // nothing, while the file already parked is the sole record of everything
    // written before the first corruption that no backup ever captured. Even
    // days later the trade holds — by then a backup from the last six hours
    // covers the live file, and nothing covers the original.
    if (sqliteFile(CORRUPT_KEEP).exists) {
      for (const f of sqliteSidecars(DB_NAME)) deleteQuietly(f);
    } else {
      if (sqliteFile(DB_NAME).exists) sqliteFile(DB_NAME).move(sqliteFile(CORRUPT_KEEP));
      // The sidecars travel WITH the parked file instead of being deleted —
      // see relocateSidecar.
      relocateSidecar(`${DB_NAME}-wal`, `${CORRUPT_KEEP}-wal`);
      relocateSidecar(`${DB_NAME}-shm`, `${CORRUPT_KEEP}-shm`);
      // A hot rollback journal is not worth parking and must not survive: it
      // would be played back over the restored file before SQLite even reads
      // the WAL.
      deleteQuietly(`${DB_NAME}-journal`);
    }
    sqliteFile(RESTORE_STAGING).move(sqliteFile(DB_NAME));
    return "restored";
  } catch (err) {
    console.warn(`[db-backup] restore from ${chosen} failed`, err);
    // Leave the staged copy in place when the live file is gone: the process
    // may have died between the two renames, and finishLandingRestore() on the
    // next launch is what turns that half-done state back into a database.
    if (sqliteFile(DB_NAME).exists) {
      for (const f of sqliteSidecars(RESTORE_STAGING)) deleteQuietly(f);
    }
    return "failed";
  }
}

/**
 * Complete a restore that died between its two renames, leaving the staged
 * copy on disk and no live database.
 *
 * MUST run before anything opens the database: `getDb()` on a missing file
 * creates an empty one, after which this can no longer tell "the restore never
 * finished" from "the app has no data", and the user boots into a blank ledger
 * with their real one sitting right there under a temp name.
 *
 * Returns true when it put a database back.
 */
export function finishInterruptedRestore(): boolean {
  try {
    if (!sqliteFile(RESTORE_STAGING).exists) return false;
    if (sqliteFile(DB_NAME).exists) {
      // The live file is present, so the restore either completed or never got
      // as far as touching it. Either way the staged copy is now garbage.
      for (const f of sqliteSidecars(RESTORE_STAGING)) deleteQuietly(f);
      return false;
    }
    relocateSidecar(`${DB_NAME}-wal`, `${CORRUPT_KEEP}-wal`);
    relocateSidecar(`${DB_NAME}-shm`, `${CORRUPT_KEEP}-shm`);
    deleteQuietly(`${DB_NAME}-journal`);
    sqliteFile(RESTORE_STAGING).move(sqliteFile(DB_NAME));
    console.warn("[db-backup] completed a restore that was interrupted last launch");
    return true;
  } catch (err) {
    console.warn("[db-backup] could not finish the interrupted restore", err);
    return false;
  }
}
