import { reloadAppAsync } from "expo";
import * as Crypto from "expo-crypto";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { saveFileToLocation } from "kaata-save-file";
import { Platform } from "react-native";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import { getAppMetaInTx, getDb, setAppMetaInTx } from "./db-tx";
import { createDriveBackup, DRIVE_BACKUP_FILE_LIMIT, openDriveBackup } from "./drive-backup";
import {
  createPersonalBackupSnapshot,
  PersonalBackupError,
  stagePersonalBackupRestore,
} from "./personal-backup-db";
import {
  BACKUP_RANDOM_LENGTH,
  MAX_BACKUP_DATABASE_BYTES,
  MAX_BACKUP_FILE_BYTES,
  LegacyBackupUnsupportedError,
  openBackup,
  sealBackup,
  validBackupPassword,
} from "./personal-backup-format";

export { PersonalBackupError } from "./personal-backup-db";

export type PersonalBackupDestination = "googleDrive" | "icloudDrive";
export type PersonalBackupRestoreFormat = "zip" | "encrypted";
type SavedCopy = { displayName: string };
type Receipt = SavedCopy & { savedAt: number };

const DESTINATIONS = ["googleDrive", "icloudDrive"] as const;
const savedCopies = new WeakMap<
  SavedCopy,
  {
    session: SessionSnapshot;
    destination: PersonalBackupDestination;
    savedAt: number;
  }
>();
let busy = false;

function exportCache() {
  return new Directory(Paths.cache, "kaata-personal-backup");
}

export function clearInterruptedPersonalBackupExport(): void {
  try {
    const directory = exportCache();
    if (directory.exists) directory.delete();
  } catch {
    // Private cache cleanup must not prevent boot or database recovery.
  }
}

function receiptKey(accountId: string | null, destination: PersonalBackupDestination) {
  return `personal_backup_receipt:${accountId ?? "ninja"}:${destination}`;
}

async function current<T>(session: SessionSnapshot, work: () => Promise<T>): Promise<T> {
  try {
    return await applyForUnchangedLocalSession(session, work);
  } catch (error) {
    if (error instanceof SessionChangedError) throw new PersonalBackupError("sessionChanged");
    throw error;
  }
}

function requirePassword(password: string | undefined): string {
  if (password === undefined || !validBackupPassword(password))
    throw new PersonalBackupError("password");
  return password;
}

async function runExclusive<T>(work: () => Promise<T>): Promise<T> {
  if (busy) throw new PersonalBackupError("busy");
  if (Platform.OS !== "ios" && Platform.OS !== "android")
    throw new PersonalBackupError("unsupported");
  busy = true;
  try {
    return await work();
  } finally {
    busy = false;
  }
}

async function readBounded(file: File, max: number): Promise<Uint8Array> {
  const expectedSize = file.size;
  if (expectedSize > max) throw new PersonalBackupError("tooLarge");
  const buffer = expectedSize > 0 ? new Uint8Array(expectedSize) : null;
  const handle = file.open(FileMode.ReadOnly);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await handle.readBytes(Math.min(256 * 1024, max - size + 1));
      if (!chunk.length) break;
      if (size + chunk.length > max) {
        chunk.fill(0);
        throw new PersonalBackupError("tooLarge");
      }
      if (buffer) {
        if (size + chunk.length > buffer.length) {
          chunk.fill(0);
          throw new PersonalBackupError("invalid");
        }
        buffer.set(chunk, size);
        chunk.fill(0);
      } else {
        chunks.push(chunk);
      }
      size += chunk.length;
    }
    if (buffer) return buffer.subarray(0, size);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (error) {
    buffer?.fill(0);
    throw error;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    handle.close();
  }
}

export function savePersonalBackup(
  destination: PersonalBackupDestination,
  password?: string,
): Promise<SavedCopy | null> {
  return runExclusive(async () => {
    const plaintext = destination === "googleDrive";
    if (!plaintext && (destination !== "icloudDrive" || Platform.OS !== "ios"))
      throw new PersonalBackupError("unsupported");
    const secret = plaintext ? null : requirePassword(password);
    const session = await captureCurrentSession();
    const snapshot = await createPersonalBackupSnapshot(plaintext);
    let database: Uint8Array | undefined;
    let archive: Uint8Array;
    try {
      try {
        database = await readBounded(snapshot.file, MAX_BACKUP_DATABASE_BYTES);
      } finally {
        snapshot.dispose();
      }
      archive =
        secret === null
          ? createDriveBackup(database, snapshot.readableTables)
          : await sealBackup(
              database,
              secret,
              await Crypto.getRandomBytesAsync(BACKUP_RANDOM_LENGTH),
            );
    } finally {
      database?.fill(0);
      for (const table of Object.values(snapshot.readableTables)) table.fill(0);
    }
    const temporary = exportCache();
    try {
      if (temporary.exists) temporary.delete();
      temporary.create();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `Kaata-backup-${timestamp}.${plaintext ? "zip" : "kaatabackup"}`;
      const file = new File(temporary, name);
      file.create();
      await file.write(archive);
      archive.fill(0);
      await current(session, async () => {});
      const result = await saveFileToLocation(
        file.uri,
        name,
        plaintext ? "application/zip" : "application/octet-stream",
      );
      if (!result) return null;
      const saved = { displayName: result.displayName };
      await current(session, async () => {
        savedCopies.set(saved, { session, destination, savedAt: Date.now() });
      });
      return saved;
    } finally {
      archive.fill(0);
      try {
        if (temporary.exists) temporary.delete();
      } catch {
        // The OS can also clear its private cache after an interrupted save.
      }
    }
  });
}

export async function readPersonalBackupReceipts(): Promise<
  Partial<Record<PersonalBackupDestination, Receipt>>
> {
  const session = await captureCurrentSession();
  return current(session, async () => {
    const receipts: Partial<Record<PersonalBackupDestination, Receipt>> = {};
    const db = await getDb();
    for (const destination of DESTINATIONS) {
      const raw = await getAppMetaInTx(db, receiptKey(session.accountId, destination));
      if (!raw) continue;
      try {
        const receipt = JSON.parse(raw) as Partial<Receipt>;
        if (
          typeof receipt.displayName === "string" &&
          typeof receipt.savedAt === "number" &&
          Number.isSafeInteger(receipt.savedAt) &&
          receipt.savedAt > 0
        )
          receipts[destination] = receipt as Receipt;
      } catch {
        // A damaged receipt does not imply a successful file save.
      }
    }
    return receipts;
  });
}

export async function recordPersonalBackup(
  destination: PersonalBackupDestination,
  result: SavedCopy,
): Promise<void> {
  const saved = savedCopies.get(result);
  if (!saved || saved.destination !== destination) throw new PersonalBackupError("sessionChanged");
  await current(saved.session, async () => {
    if (savedCopies.get(result) !== saved) throw new PersonalBackupError("sessionChanged");
    await setAppMetaInTx(
      await getDb(),
      receiptKey(saved.session.accountId, destination),
      JSON.stringify({ displayName: result.displayName, savedAt: saved.savedAt } satisfies Receipt),
    );
    savedCopies.delete(result);
  });
}

export function restorePersonalBackup(
  format: PersonalBackupRestoreFormat,
  password?: string,
): Promise<boolean> {
  return runExclusive(async () => {
    const secret = format === "zip" ? null : requirePassword(password);
    const session = await captureCurrentSession();
    const pick = await File.pickFileAsync({ multipleFiles: false });
    if (pick.canceled) return false;
    const file = await readBounded(
      pick.result,
      secret === null ? DRIVE_BACKUP_FILE_LIMIT : MAX_BACKUP_FILE_BYTES,
    );
    let database: Uint8Array;
    try {
      database = secret === null ? openDriveBackup(file) : await openBackup(file, secret);
    } catch (error) {
      if (error instanceof LegacyBackupUnsupportedError)
        throw new PersonalBackupError("legacyUnsupported");
      throw new PersonalBackupError("invalid");
    } finally {
      file.fill(0);
    }
    try {
      await current(session, async () => {});
      await stagePersonalBackupRestore(database);
    } finally {
      database.fill(0);
    }
    await reloadAppAsync("Restore personal backup");
    return true;
  });
}
