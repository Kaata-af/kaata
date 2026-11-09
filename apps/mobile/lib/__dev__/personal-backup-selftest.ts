import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";

async function main() {
  let account: string | null = "account-a";
  let revision = 0;
  let chooseFile = false;
  let invalidArchive = false;
  let fileSize = 3;
  let cacheExists = true;
  let expoGo = false;
  let unsupportedDownloads = false;
  let cancelSave = false;
  let onSave: (() => void) | undefined;
  const platform = { OS: "ios" };
  const events: string[] = [];
  const nativeSaves: string[] = [];
  const snapshotOptions: Record<string, unknown>[] = [];
  const coverage = { included: 1, skipped: 1, skippedPending: 0 };
  class PersonalBackupError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class SessionChangedError extends Error {}
  class MockFile {
    static pickFileAsync = async () =>
      chooseFile ? { canceled: false, result: new MockFile() } : { canceled: true };
    constructor(
      _directory?: unknown,
      readonly name = "Kaata-backup.zip",
    ) {}
    size = fileSize;
    get uri() {
      return `file:///mock/${this.name}`;
    }
    create() {}
    async write(bytes: Uint8Array) {
      assert.equal(bytes[0], 81);
      events.push("zip");
    }
    open() {
      let read = false;
      return {
        readBytes: async () => {
          if (read) return new Uint8Array();
          read = true;
          return Uint8Array.of(1, 2, 3);
        },
        close() {},
      };
    }
  }
  class MockDirectory {
    get exists() {
      return cacheExists;
    }
    create() {
      cacheExists = true;
    }
    delete() {
      cacheExists = false;
    }
  }
  function assertNativeSource(uri: string, name: string, mimeType: string) {
    assert(cacheExists, "the archive must exist while the OS is saving it");
    assert.equal(uri, `file:///mock/${name}`);
    assert.match(name, /^Kaata-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
    assert.equal(mimeType, "application/zip");
  }
  const saved = { displayName: "Kaata-backup (1).zip", uri: "content://backup" };
  const backup = compileUI("../personal-backup", {
    expo: {
      reloadAppAsync: async () => events.push("reload"),
      isRunningInExpoGo: () => expoGo,
    },
    "expo-file-system": {
      Directory: MockDirectory,
      File: MockFile,
      FileMode: { ReadOnly: "r" },
      Paths: { cache: {} },
    },
    "react-native": { Platform: platform },
    "kaata-save-file": {
      SAVE_FILE_ERR: { UNSUPPORTED: "E_UNSUPPORTED" },
      saveFileToPhone: async (...args: Parameters<typeof assertNativeSource>) => {
        assertNativeSource(...args);
        nativeSaves.push("phone");
        onSave?.();
        if (unsupportedDownloads) throw Object.assign(new Error(), { code: "E_UNSUPPORTED" });
        return cancelSave ? null : saved;
      },
      saveFileToLocation: async (...args: Parameters<typeof assertNativeSource>) => {
        assertNativeSource(...args);
        nativeSaves.push("location");
        return cancelSave ? null : saved;
      },
    },
    "./auth": {
      captureCurrentSession: async () => ({ accountId: account, bindingVersion: revision }),
      applyForUnchangedLocalSession: async (
        session: { accountId: string | null; bindingVersion: number },
        work: () => unknown,
      ) => {
        if (session.accountId !== account || session.bindingVersion !== revision)
          throw new SessionChangedError();
        return work();
      },
      SessionChangedError,
    },
    "./drive-backup": {
      BACKUP_DATABASE_LIMIT: 1024,
      DRIVE_BACKUP_FILE_LIMIT: 1024,
      DriveBackupTooLargeError: class extends Error {},
      createDriveBackup: () => Uint8Array.of(81, 82, 83),
      openDriveBackup: () => {
        if (invalidArchive) throw new Error("Invalid Kaata ZIP backup");
        return Uint8Array.of(1, 2, 3);
      },
    },
    "./personal-backup-db": {
      PersonalBackupError,
      createPersonalBackupSnapshot: async (readable: boolean, options: Record<string, unknown>) => {
        assert.equal(readable, true);
        snapshotOptions.push(options);
        return {
          file: new MockFile(),
          readableTables: {},
          dispose: () => events.push("plain copy disposed"),
          coverage,
        };
      },
      stagePersonalBackupRestore: async () => events.push("staged"),
    },
  });
  const session = { accountId: account, bindingVersion: revision };
  await backup.withReadablePersonalBackup(session, async () => events.push("uploaded"));
  assert.deepEqual(events, ["plain copy disposed", "zip", "uploaded"]);
  assert.deepEqual(snapshotOptions[0], {
    requireData: true,
    localOnly: false,
    expectedSession: session,
  });
  await assert.rejects(backup.restoreDownloadedPersonalBackup(session, async () => {
    account = "account-b";
    revision++;
  }), { code: "sessionChanged" });
  assert.ok(!events.includes("staged"));
  assert.equal(await backup.restoreDownloadedPersonalBackup(
    { accountId: account, bindingVersion: revision }, async () => events.push("downloaded"),
  ), true);
  assert.deepEqual(events.splice(3), ["downloaded", "staged", "reload"]);
  assert.equal(await backup.restorePersonalBackup(), false);
  chooseFile = true;
  invalidArchive = true;
  await assert.rejects(backup.restorePersonalBackup(), {
    code: "invalid",
  });
  assert.ok(!events.includes("staged"));
  invalidArchive = false;
  fileSize = 1025;
  await assert.rejects(backup.restorePersonalBackup(), { code: "tooLarge" });
  assert.ok(!events.includes("staged"));
  fileSize = 3;
  assert.equal(await backup.restorePersonalBackup(), true);
  assert.deepEqual(events.slice(-2), ["staged", "reload"]);

  assert.deepEqual(await backup.savePersonalBackupToPhone(), {
    displayName: saved.displayName,
    coverage,
  });
  assert.deepEqual(snapshotOptions.at(-1), {
    requireData: true,
    localOnly: true,
    expectedSession: { accountId: account, bindingVersion: revision },
  });
  assert.deepEqual(nativeSaves, ["phone"]);
  assert.equal(cacheExists, false);

  platform.OS = "android";
  unsupportedDownloads = true;
  cancelSave = true;
  assert.equal(await backup.savePersonalBackupToPhone(), null);
  assert.deepEqual(nativeSaves.slice(-2), ["phone", "location"]);
  assert.equal(cacheExists, false, "cancelled save removes the staging ZIP");

  onSave = () => revision++;
  await assert.rejects(backup.savePersonalBackupToPhone(), { code: "sessionChanged" });
  assert.deepEqual(
    nativeSaves.slice(-2),
    ["location", "phone"],
    "a stale session cannot open the fallback picker",
  );
  assert.equal(cacheExists, false);

  const snapshotsBeforeExpoGo = snapshotOptions.length;
  expoGo = true;
  await assert.rejects(backup.savePersonalBackupToPhone(), { code: "saveUnavailable" });
  assert.equal(snapshotOptions.length, snapshotsBeforeExpoGo);
  console.log(
    "PASS personal backup files: cloud ZIP, offline phone save, picker fallback, account binding, file restore, and invalid/oversized archives",
  );
}

void main();
