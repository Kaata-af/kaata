import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";

async function main() {
  let account: string | null = "account-a";
  let revision = 0;
  let chooseFile = false;
  let completeSave = false;
  let switchWhileSaving = false;
  let lastFileName = "";
  const events: string[] = [];
  const receipts = new Map<string, string>();
  class PersonalBackupError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class SessionChangedError extends Error {}
  class LegacyBackupUnsupportedError extends Error {}
  class MockFile {
    static pickFileAsync = async () =>
      chooseFile ? { canceled: false, result: new MockFile() } : { canceled: true };
    size = 3;
    uri = "file:///mock/kaata-backup";
    create() {}
    async write(bytes: Uint8Array) {
      assert.ok(bytes[0] === 81 || bytes[0] === 91);
      events.push(bytes[0] === 81 ? "zip" : "encrypted");
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
  const db = {};
  const backup = compileUI("../personal-backup", {
    expo: { reloadAppAsync: async () => events.push("reload") },
    "expo-crypto": {
      randomUUID: () => "fixture",
      getRandomBytesAsync: async (length: number) => new Uint8Array(length),
    },
    "expo-file-system": {
      Directory: MockDirectory,
      File: MockFile,
      FileMode: { ReadOnly: "r" },
      Paths: { cache: {} },
    },
    "kaata-save-file": {
      saveFileToLocation: async (_uri: string, name: string, mime: string) => {
        lastFileName = name;
        assert.equal(events.at(-1), mime === "application/zip" ? "zip" : "encrypted");
        assert.equal(name.endsWith(mime === "application/zip" ? ".zip" : ".kaatabackup"), true);
        events.push("picker");
        if (switchWhileSaving) {
          account = "account-b";
          revision++;
        }
        return completeSave ? { displayName: name } : null;
      },
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
    "./db-tx": {
      getDb: async () => db,
      getAppMetaInTx: async (_db: unknown, key: string) => receipts.get(key),
      setAppMetaInTx: async (_db: unknown, key: string, value: string) => receipts.set(key, value),
    },
    "./drive-backup": {
      DRIVE_BACKUP_FILE_LIMIT: 1024,
      createDriveBackup: () => Uint8Array.of(81, 82, 83),
      openDriveBackup: () => Uint8Array.of(1, 2, 3),
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
    "./personal-backup-format": {
      LegacyBackupUnsupportedError,
      BACKUP_RANDOM_LENGTH: 40,
      MAX_BACKUP_DATABASE_BYTES: 1024,
      MAX_BACKUP_FILE_BYTES: 1024,
      sealBackup: async () => Uint8Array.of(91, 92, 93),
      openBackup: async (_bytes: Uint8Array, password: string) => {
        if (password === "incorrect backup password") throw new Error("Invalid tag");
        if (password === "old backup password") throw new LegacyBackupUnsupportedError();
        return Uint8Array.of(1, 2, 3);
      },
      validBackupPassword: () => true,
    },
  });
  const password = "test backup password";
  assert.equal(await backup.savePersonalBackup("googleDrive"), null);
  assert.deepEqual(events, ["plain copy disposed", "zip", "picker"]);
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  completeSave = true;
  const result = await backup.savePersonalBackup("googleDrive");
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  await assert.rejects(backup.recordPersonalBackup("googleDrive", { ...result }), {
    code: "sessionChanged",
  });
  await assert.rejects(backup.recordPersonalBackup("icloudDrive", result), {
    code: "sessionChanged",
  });
  await backup.recordPersonalBackup("googleDrive", result);
  assert.equal((await backup.readPersonalBackupReceipts()).googleDrive.displayName, lastFileName);
  await assert.rejects(backup.savePersonalBackup("icloudDrive"), { code: "password" });
  const another = await backup.savePersonalBackup("icloudDrive", password);
  switchWhileSaving = true;
  await assert.rejects(backup.savePersonalBackup("googleDrive"), { code: "sessionChanged" });
  await assert.rejects(backup.recordPersonalBackup("icloudDrive", another), {
    code: "sessionChanged",
  });
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  assert.equal(await backup.restorePersonalBackup("zip"), false);
  chooseFile = true;
  await assert.rejects(backup.restorePersonalBackup("encrypted", "incorrect backup password"), {
    code: "invalid",
  });
  assert.ok(!events.includes("staged"));
  await assert.rejects(backup.restorePersonalBackup("encrypted", "old backup password"), {
    code: "legacyUnsupported",
  });
  assert.equal(await backup.restorePersonalBackup("encrypted", password), true);
  assert.deepEqual(events.slice(-2), ["staged", "reload"]);
  assert.equal(await backup.restorePersonalBackup("zip"), true);
  assert.deepEqual(events.slice(-2), ["staged", "reload"]);
  console.log(
    "PASS personal backup files: ZIP and encrypted save/restore, provider receipts, scope and legacy errors",
  );
}

void main();
