import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { PersonalCloudProviderError, type PersonalCloudCopy } from "../personal-cloud-types";
import { compileUI } from "./ui-fixture";

async function main() {
  let now = 1_700_000_000_000;
  let install = "original-device";
  let account = "account-a";
  let bindingVersion = 1;
  let revision = 1;
  let online = true;
  let pending = true;
  let failWrite = false;
  let empty = false;
  let uploads = 0;
  let downloads = 0;
  let changedDuringConnect = false;
  const meta = new Map<string, string>();
  const backups = new Map<string, PersonalCloudCopy>();
  const connections: boolean[] = [];
  class PersonalBackupError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  class SessionChangedError extends Error {}
  const check = (session: { accountId: string; bindingVersion: number }) => {
    if (session.accountId !== account || session.bindingVersion !== bindingVersion)
      throw new PersonalBackupError("sessionChanged");
  };
  const provider = (type: string) => ({
    supported: () => true,
    connect: async (options?: { temporary?: boolean }) => {
      connections.push(options?.temporary === true);
      if (changedDuringConnect) {
        account = "account-b";
        bindingVersion++;
      }
      return { id: `${type}-connection` };
    },
    upload: async (_connection: unknown, target: { scope: string; device: string }, file: unknown, createdAt: number) => {
      assert.match(target.scope, /^[a-f0-9]{32}$/);
      assert.match(target.device, /^[a-f0-9]{32}$/);
      assert.equal(file, "private archive");
      if (failWrite) throw new PersonalCloudProviderError("providerFailed");
      uploads++;
      const copy = { id: target.device, name: "Kaata Backup.zip", createdAt, size: 20, pending: type === "icloud" && pending };
      backups.set(`${type}:${target.scope}:${target.device}`, copy);
      return copy;
    },
    list: async (_connection: unknown, scope: string) => [...backups]
      .filter(([key]) => key.startsWith(`${type}:${scope}:`))
      .map(([, copy]) => ({ ...copy, pending: type === "icloud" && pending })),
    download: async () => { downloads++; },
  });
  const makeController = () => compileUI("../personal-cloud-backup", {
    "@noble/hashes/sha256": { sha256 },
    "@noble/hashes/utils": { bytesToHex, utf8ToBytes },
    "expo-network": { getNetworkStateAsync: async () => ({ isConnected: online }) },
    "./auth": {
      captureCurrentSession: async () => ({ accountId: account, bindingVersion, jwt: "session" }),
      SessionChangedError,
    },
    "./db-tx": {
      getDb: async () => ({ getFirstAsync: async () => ({ revision }) }),
      getSessionAccountIdSync: () => account,
      getAppMetaInTx: async (_db: unknown, key: string) => key === "install_id" ? install : meta.get(key),
      setAppMetaInTx: async (_db: unknown, key: string, value: string) => meta.set(key, value),
    },
    "./drive-backup": { DRIVE_BACKUP_FILE_LIMIT: 1024 },
    "./personal-cloud-types": { PersonalCloudProviderError },
    "./google-drive-backup": { googleDriveBackupProvider: provider("google") },
    "./icloud-backup": { icloudDriveBackupProvider: provider("icloud") },
    "./personal-backup": {
      PersonalBackupError,
      withPersonalBackupSession: async (session: Parameters<typeof check>[0], work: () => unknown) => {
        check(session);
        return work();
      },
      withReadablePersonalBackup: async (_session: unknown, work: (file: string, coverage: unknown) => unknown) => {
        if (empty) throw new PersonalBackupError("empty");
        return work("private archive", { included: 2, skipped: 1, skippedPending: 1 });
      },
      restoreDownloadedPersonalBackup: async (session: Parameters<typeof check>[0], download: (file: string) => Promise<void>) => {
        check(session);
        await download("private destination");
        return true;
      },
    },
  }, { Date: { now: () => now } });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const cloud = makeController();
  await cloud.runPersonalCloudBackupIfDue();
  assert.equal(uploads, 0);
  assert.equal(await cloud.enablePersonalCloudBackup("googleDrive"), true);
  await settle();
  assert.equal(uploads, 1);
  assert.deepEqual((await cloud.readPersonalCloudBackupStatuses()).googleDrive.coverage, {
    included: 2, skipped: 1, skippedPending: 1,
  });
  const saved = now;
  await cloud.runPersonalCloudBackupIfDue();
  assert.equal(uploads, 1);

  revision++;
  now += 16 * 60_000;
  online = false;
  await cloud.runPersonalCloudBackupIfDue();
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).googleDrive.error, "offline");
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).googleDrive.savedAt, saved);
  online = true;
  now += 5 * 60_000;
  failWrite = true;
  await assert.rejects(cloud.backUpToPersonalCloudNow("googleDrive"), { code: "providerFailed" });
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).googleDrive.savedAt, saved);
  now += 5 * 60_000;
  failWrite = false;
  await cloud.runPersonalCloudBackupIfDue();
  assert.equal(uploads, 2);
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).googleDrive.savedAt, now);

  await cloud.enablePersonalCloudBackup("icloudDrive");
  await settle();
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).icloudDrive.pending, true);
  now += 16 * 60_000;
  pending = false;
  await cloud.runPersonalCloudBackupIfDue();
  assert.equal((await cloud.readPersonalCloudBackupStatuses()).icloudDrive.pending, false);
  assert.equal(uploads, 3);

  // Another phone can read the latest copy without consenting to automatic uploads.
  install = "new-phone";
  meta.clear();
  const fresh = makeController();
  const choice = await fresh.findLatestPersonalCloudBackup("googleDrive");
  assert.equal(choice.name, "Kaata Backup.zip");
  assert.equal(connections.at(-1), true);
  assert.deepEqual(await fresh.readPersonalCloudBackupStatuses(), {});
  assert.equal(await fresh.restoreLatestPersonalCloudBackup(choice), true);
  assert.equal(downloads, 1);
  const anotherChoice = await fresh.findLatestPersonalCloudBackup("googleDrive");
  bindingVersion++;
  await assert.rejects(fresh.restoreLatestPersonalCloudBackup(anotherChoice), { code: "sessionChanged" });
  assert.equal(downloads, 1);
  empty = true;
  await fresh.enablePersonalCloudBackup("googleDrive");
  await settle();
  assert.equal((await fresh.readPersonalCloudBackupStatuses()).googleDrive.error, "empty");
  assert.equal(uploads, 3);
  await fresh.disablePersonalCloudBackup("googleDrive");
  changedDuringConnect = true;
  await assert.rejects(fresh.enablePersonalCloudBackup("icloudDrive"), { code: "sessionChanged" });
  assert.deepEqual(await fresh.readPersonalCloudBackupStatuses(), {});
  console.log("PASS automatic personal backups: consent, retries, pending upload, and fresh-device restore");
}

void main();
