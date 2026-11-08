import assert from "node:assert/strict";
import { compileUI } from "./ui-fixture";

async function main() {
  let account: string | null = "account-a";
  let revision = 0;
  let chooseFile = false;
  let completeSave = false;
  let switchWhileSaving = false;
  const events: string[] = [];
  const receipts = new Map<string, string>();
  class PersonalBackupError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  class SessionChangedError extends Error {}
  class MockFile {
    static pickFileAsync = async () =>
      chooseFile ? { canceled: false, result: new MockFile() } : { canceled: true };
    size = 3;
    uri = "file:///mock/kaata-backup";
    create() {}
    async write(bytes: Uint8Array) {
      assert.deepEqual([...bytes], [91, 92, 93]);
      events.push("encrypted");
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
      saveFileToLocation: async () => {
        assert.equal(events.at(-1), "encrypted");
        events.push("picker");
        if (switchWhileSaving) {
          account = "account-b";
          revision++;
        }
        return completeSave ? { displayName: "Kaata backup.kaatabackup" } : null;
      },
    },
    "react-native": { Platform: { OS: "android" } },
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
    "./personal-backup-db": {
      PersonalBackupError,
      createPersonalBackupSnapshot: async () => ({
        file: new MockFile(),
        dispose: () => events.push("plain copy disposed"),
      }),
      stagePersonalBackupRestore: async () => events.push("staged"),
    },
    "./personal-backup-format": {
      BACKUP_RANDOM_LENGTH: 40,
      MAX_BACKUP_DATABASE_BYTES: 1024,
      MAX_BACKUP_FILE_BYTES: 1024,
      sealBackup: async () => Uint8Array.of(91, 92, 93),
      openBackup: async (_bytes: Uint8Array, password: string) => {
        if (password === "incorrect backup password") throw new Error("Invalid tag");
        return Uint8Array.of(1, 2, 3);
      },
      validBackupPassword: () => true,
    },
  });
  const password = "test backup password";
  assert.equal(await backup.savePersonalBackup(password), null);
  assert.deepEqual(events, ["plain copy disposed", "encrypted", "picker"]);
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  completeSave = true;
  const result = await backup.savePersonalBackup(password);
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  await assert.rejects(backup.recordPersonalBackup("googleDrive", { ...result }), {
    code: "sessionChanged",
  });
  await backup.recordPersonalBackup("googleDrive", result);
  assert.equal(
    (await backup.readPersonalBackupReceipts()).googleDrive.displayName,
    "Kaata backup.kaatabackup",
  );
  const another = await backup.savePersonalBackup(password);
  switchWhileSaving = true;
  await assert.rejects(backup.savePersonalBackup(password), { code: "sessionChanged" });
  await assert.rejects(backup.recordPersonalBackup("icloudDrive", another), {
    code: "sessionChanged",
  });
  assert.deepEqual(await backup.readPersonalBackupReceipts(), {});
  assert.equal(await backup.restorePersonalBackup(password), false);
  chooseFile = true;
  await assert.rejects(backup.restorePersonalBackup("incorrect backup password"), {
    code: "invalid",
  });
  assert.ok(!events.includes("staged"));
  assert.equal(await backup.restorePersonalBackup(password), true);
  assert.deepEqual(events.slice(-2), ["staged", "reload"]);
  console.log("PASS personal backup files: encrypted save, confirmed receipts, scope and restore");
}

void main();
