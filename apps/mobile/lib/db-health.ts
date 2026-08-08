// Database integrity: detect a corrupt ledger at boot instead of discovering it
// one broken query at a time.
//
// Before this existed, a damaged SQLite file surfaced as an ordinary migration
// or query failure — indistinguishable from a transient error — and the user
// was told to close the app and open it again, forever. Nothing detected the
// real state, nothing reported it, and there was no path back other than
// reinstalling (which destroys the ledger of anyone not signed in).
//
// TWO RULES this module exists to enforce, both learned the hard way:
//
//  1. Corruption often makes the CHECK ITSELF throw. On a truncated file, a
//     damaged header or a damaged sqlite_schema page, `PRAGMA quick_check`
//     can't even be prepared — SQLite returns SQLITE_NOTADB / SQLITE_CORRUPT
//     instead of a row saying what's wrong. Classifying only the row-returning
//     case would miss exactly the worst damage, so thrown SQLite errors are
//     inspected too.
//
//  2. NOT all damage is fatal. quick_check walks every table and index; damage
//     in an index page, or in a table the ledger never reads, does not stop a
//     shopkeeper from seeing their book. Refusing to boot on any complaint
//     would lock people out of a ledger that still works — worse than the bug
//     we set out to fix. So the boot path asks a narrower question: can the
//     LEDGER be read? Only that answer is allowed to stop the app.
import type { SQLiteDatabase } from "expo-sqlite";

/** Thrown when the database is damaged badly enough that the ledger can't be
 *  read. Distinct from a migration failure so the boot flow can offer recovery
 *  instead of "restart the app", which can never fix a broken file. */
export class DatabaseCorruptError extends Error {
  /** What quick_check (or SQLite itself) reported, for the support screen. */
  readonly details: string;
  constructor(details: string) {
    super(`database integrity check failed: ${details}`);
    this.name = "DatabaseCorruptError";
    this.details = details;
  }
}

// SQLite's own wording for structural damage, as it reaches JS through
// expo-sqlite (which stringifies the native error). Matched on the message
// because the numeric code isn't carried across the bridge.
const CORRUPTION_MARKERS = [
  "database disk image is malformed",
  "file is not a database",
  "file is encrypted",
  "malformed database schema",
  "database corruption",
  "corrupt",
];

function looksLikeCorruption(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const lower = msg.toLowerCase();
  return CORRUPTION_MARKERS.some((m) => lower.includes(m));
}

/**
 * Translate an arbitrary thrown error into a DatabaseCorruptError when SQLite's
 * own wording says the file is damaged, otherwise null.
 *
 * The boot sequence runs this over EVERY stage's failure, not just the
 * integrity check's. Corruption doesn't wait to be asked about: the first
 * casualty is usually whichever query happens to touch a damaged page —
 * ensureInstallId's read of app_meta, a cache prime, the local-self lookup —
 * and each of those otherwise surfaced as an unexplained boot error whose
 * advice ("close the app and open it again") can never work.
 */
export function asCorruptionError(err: unknown): DatabaseCorruptError | null {
  if (err instanceof DatabaseCorruptError) return err;
  if (!looksLikeCorruption(err)) return null;
  return new DatabaseCorruptError((err instanceof Error ? err.message : String(err)).slice(0, 240));
}

/**
 * Run `PRAGMA quick_check` and return what it said.
 *
 * Returns "ok" when healthy, the problems joined when it reported some, and
 * throws DatabaseCorruptError when the check could not run because the file is
 * damaged. Any other error (a dead handle, a closed database) propagates
 * untouched — that's a different failure the caller already handles.
 */
export async function runQuickCheck(db: SQLiteDatabase): Promise<string> {
  let rows: Record<string, string>[];
  try {
    rows = await db.getAllAsync<Record<string, string>>("PRAGMA quick_check(10)");
  } catch (err) {
    if (looksLikeCorruption(err)) {
      throw new DatabaseCorruptError(
        (err instanceof Error ? err.message : String(err)).slice(0, 240),
      );
    }
    throw err;
  }
  const messages = rows
    .map((r) => Object.values(r)[0])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (messages.length === 0) return "ok";
  if (messages.length === 1 && messages[0].toLowerCase() === "ok") return "ok";
  return messages.join("; ").slice(0, 240);
}

/**
 * Boot gate. Throws DatabaseCorruptError ONLY when the ledger itself cannot be
 * read — see rule 2 in the file header. A quick_check complaint that the
 * ledger survives is returned as a warning for the caller to log, not a reason
 * to refuse to start.
 *
 * The readability probe deliberately touches the tables the app cannot work
 * without, and tolerates their absence: on a fresh install or an install that
 * predates a table, "no such table" means "nothing to read yet", not damage.
 */
export async function assertLedgerReadable(db: SQLiteDatabase): Promise<string | null> {
  const verdict = await runQuickCheck(db);
  if (verdict === "ok") return null;

  for (const sql of [
    "SELECT COUNT(*) AS c FROM entries",
    "SELECT COUNT(*) AS c FROM relationships",
    "SELECT COUNT(*) AS c FROM event_log",
  ]) {
    try {
      await db.getFirstAsync<{ c: number }>(sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("no such table")) continue; // not yet created
      // Only SQLite's own word for structural damage may stop the app. A probe
      // can fail for reasons that have nothing to do with the file's integrity
      // — "database is locked" (the background catch-up task holds a write),
      // "disk I/O error", "database or disk is full" — and every one of those
      // is transient. Treating them as corruption would send a shopkeeper with
      // an intact ledger to a screen whose second button erases it.
      if (!looksLikeCorruption(err)) {
        return `${verdict} — probe failed: ${msg}`.slice(0, 240);
      }
      throw new DatabaseCorruptError(`${verdict} — ledger unreadable: ${msg}`.slice(0, 240));
    }
  }
  // Damaged somewhere, but every ledger table still reads. Let the app run and
  // let the caller report it: a rolling backup and a support ticket beat a
  // lockout.
  return verdict;
}

/** Non-throwing probe for the diagnostics screen. */
export async function probeDatabaseIntegrity(db: SQLiteDatabase): Promise<string | null> {
  try {
    return await runQuickCheck(db);
  } catch (err) {
    if (err instanceof DatabaseCorruptError) return err.details;
    return null;
  }
}
