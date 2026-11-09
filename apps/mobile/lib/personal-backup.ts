import { isRunningInExpoGo, reloadAppAsync } from "expo";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import {
  SAVE_FILE_ERR,
  saveFileToLocation,
  saveFileToPhone,
  type SaveFileResult,
} from "kaata-save-file";
import { Platform } from "react-native";
import {
  applyForUnchangedLocalSession,
  captureCurrentSession,
  SessionChangedError,
  type SessionSnapshot,
} from "./auth";
import {
  BACKUP_DATABASE_LIMIT,
  createDriveBackup,
  DRIVE_BACKUP_FILE_LIMIT,
  DriveBackupTooLargeError,
  openDriveBackup,
} from "./drive-backup";
import {
  createPersonalBackupSnapshot,
  PersonalBackupError,
  stagePersonalBackupRestore,
  type PersonalBackupCoverage,
} from "./personal-backup-db";

export { PersonalBackupError } from "./personal-backup-db";

let busy = false;

function exportCache() {
  return new Directory(Paths.cache, "kaata-personal-backup");
}

export function clearInterruptedPersonalBackupExport(): void {
  if (busy) return;
  try {
    const directory = exportCache();
    if (directory.exists) directory.delete();
  } catch {
    // Private cache cleanup must not prevent boot or database recovery.
  }
}

export async function withPersonalBackupSession<T>(session: SessionSnapshot, work: () => Promise<T>): Promise<T> {
  try {
    return await applyForUnchangedLocalSession(session, work);
  } catch (error) {
    if (error instanceof SessionChangedError) throw new PersonalBackupError("sessionChanged");
    throw error;
  }
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

async function withTemporaryArchive<T>(
  work: (file: File) => Promise<T>,
  fileName = "Kaata-backup.zip",
): Promise<T> {
  const temporary = exportCache();
  if (temporary.exists) temporary.delete();
  temporary.create();
  try {
    return await work(new File(temporary, fileName));
  } finally {
    try {
      if (temporary.exists) temporary.delete();
    } catch {
      // Boot also clears the private cache after interrupted backup work.
    }
  }
}

export function withReadablePersonalBackup<T>(
  session: SessionSnapshot,
  useArchive: (file: File, coverage: PersonalBackupCoverage) => Promise<T>,
  { localOnly = false } = {},
): Promise<T> {
  return runExclusive(async () => {
    await withPersonalBackupSession(session, async () => {});
    const snapshot = await createPersonalBackupSnapshot(true, {
      requireData: true,
      localOnly,
      expectedSession: session,
    });
    let database: Uint8Array | undefined;
    let archive: Uint8Array;
    try {
      try {
        database = await readBounded(snapshot.file, BACKUP_DATABASE_LIMIT);
      } finally {
        snapshot.dispose();
      }
      archive = createDriveBackup(database, snapshot.readableTables);
    } catch (error) {
      if (error instanceof DriveBackupTooLargeError) throw new PersonalBackupError("tooLarge");
      throw error;
    } finally {
      database?.fill(0);
      for (const table of Object.values(snapshot.readableTables)) table.fill(0);
    }
    try {
      const fileName = localOnly
        ? `Kaata-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.zip`
        : undefined;
      return await withTemporaryArchive(async (file) => {
        file.create();
        await file.write(archive);
        archive.fill(0);
        await withPersonalBackupSession(session, async () => {});
        return useArchive(file, snapshot.coverage);
      }, fileName);
    } finally {
      archive.fill(0);
    }
  });
}

export async function savePersonalBackupToPhone(): Promise<{
  displayName: string;
  coverage: PersonalBackupCoverage;
} | null> {
  if (isRunningInExpoGo()) throw new PersonalBackupError("saveUnavailable");
  const session = await captureCurrentSession();
  return withReadablePersonalBackup(
    session,
    async (file, coverage) => {
      const mimeType = "application/zip";
      let saved: SaveFileResult | null;
      try {
        saved = await saveFileToPhone(file.uri, file.name, mimeType);
      } catch (error) {
        // Older Android versions use a single-file picker instead of MediaStore Downloads.
        if (
          Platform.OS !== "android" ||
          (error as { code?: unknown } | null)?.code !== SAVE_FILE_ERR.UNSUPPORTED
        )
          throw error;
        await withPersonalBackupSession(session, async () => {});
        saved = await saveFileToLocation(file.uri, file.name, mimeType);
      }
      return saved ? { displayName: saved.displayName, coverage } : null;
    },
    { localOnly: true },
  );
}

async function restoreFile(session: SessionSnapshot, input: File): Promise<boolean> {
  const bytes = await readBounded(input, DRIVE_BACKUP_FILE_LIMIT);
  let database: Uint8Array;
  try {
    database = openDriveBackup(bytes);
  } catch {
    throw new PersonalBackupError("invalid");
  } finally {
    bytes.fill(0);
  }
  try {
    await stagePersonalBackupRestore(database, session);
  } finally {
    database.fill(0);
  }
  await reloadAppAsync("Restore personal backup");
  return true;
}

export function restoreDownloadedPersonalBackup(
  session: SessionSnapshot,
  download: (file: File) => Promise<void>,
): Promise<boolean> {
  return runExclusive(() =>
    withTemporaryArchive(async (file) => {
      await withPersonalBackupSession(session, async () => {});
      await download(file);
      await withPersonalBackupSession(session, async () => {});
      return restoreFile(session, file);
    }),
  );
}

export function restorePersonalBackup(): Promise<boolean> {
  return runExclusive(async () => {
    const session = await captureCurrentSession();
    const pick = await File.pickFileAsync({ multipleFiles: false });
    if (pick.canceled) return false;
    await withPersonalBackupSession(session, async () => {});
    return restoreFile(session, pick.result);
  });
}
