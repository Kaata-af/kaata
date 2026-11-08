import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";

async function main() {
  let account: string | null = "account-a";
  let revision = 0;
  let chooseFile = false;
  let invalidArchive = false;
  let fileSize = 3;
  const events: string[] = [];
  class PersonalBackupError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class SessionChangedError extends Error {}
  class MockFile {
    static pickFileAsync = async () =>
      chooseFile ? { canceled: false, result: new MockFile() } : { canceled: true };
    size = fileSize;
    uri = "file:///mock/kaata-backup";
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
    exists = true;
    create() {}
    delete() {}
  }
  const backup = compileUI("../personal-backup", {
    expo: { reloadAppAsync: async () => events.push("reload") },
    "expo-file-system": {
      Directory: MockDirectory,
      File: MockFile,
      FileMode: { ReadOnly: "r" },
      Paths: { cache: {} },
    },
    "react-native": { Platform: { OS: "ios" } },
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
      createPersonalBackupSnapshot: async () => ({
        file: new MockFile(),
        readableTables: {},
        dispose: () => events.push("plain copy disposed"),
      }),
      stagePersonalBackupRestore: async () => events.push("staged"),
    },
  });
  const session = { accountId: account, bindingVersion: revision };
  await backup.withReadablePersonalBackup(session, async () => events.push("uploaded"));
  assert.deepEqual(events, ["plain copy disposed", "zip", "uploaded"]);
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
  console.log(
    "PASS personal backup files: cloud ZIP, account binding, file restore, and invalid/oversized archives",
  );
}

void main();
