import assert from "node:assert/strict";
import type { File } from "expo-file-system";
import { DRIVE_BACKUP_FILE_LIMIT } from "../drive-backup";
import { PersonalCloudProviderError, type PersonalCloudCopy, type PersonalCloudProvider } from "../personal-cloud-types";
import { compileUI } from "./ui-fixture";

async function main() {
  const target = { scope: "a".repeat(32), device: "b".repeat(32) };
  const file = { uri: "file:///cache/Kaata-backup.zip" } as File;
  const createdAt = 1_800_000_000_000;
  const pending = { id: target.device, name: "Kaata-backup.zip", createdAt, size: 512, pending: true };
  let available = false;
  let bridgeLoads = 0;
  let errorCode: string | undefined;
  let listCopy: PersonalCloudCopy = { ...pending, pending: false };
  const platform = { OS: "android" };
  const calls: unknown[][] = [];
  const native = {
    async connect() {
      return "local-iCloud-binding";
    },
    async upload(...args: unknown[]) {
      calls.push(args);
      return pending;
    },
    async list(...args: unknown[]) {
      calls.push(args);
      if (errorCode) throw { code: errorCode };
      return [listCopy];
    },
    async download(...args: unknown[]) {
      calls.push(args);
    },
  };
  const { icloudDriveBackupProvider: provider } = compileUI("../icloud-backup", {
    "react-native": { Platform: platform },
    "expo-modules-core": {
      requireOptionalNativeModule(name: string) {
        assert.equal(name, "KaataICloudBackup");
        bridgeLoads++;
        return available ? native : null;
      },
    },
    "./drive-backup": { DRIVE_BACKUP_FILE_LIMIT },
    "./personal-cloud-types": { PersonalCloudProviderError },
  }) as { icloudDriveBackupProvider: PersonalCloudProvider };

  assert.equal(provider.supported(), false);
  assert.equal(bridgeLoads, 0);
  platform.OS = "ios";
  assert.equal(provider.supported(), false);
  await assert.rejects(provider.connect(), { code: "providerFailed" });

  available = true;
  assert.equal(provider.supported(), true);
  const connection = await provider.connect();
  assert.deepEqual(connection, { id: "local-iCloud-binding" });
  assert.ok(connection);
  assert.deepEqual(await provider.upload(connection, target, file, createdAt), pending);
  const [uploaded] = await provider.list(connection, target.scope);
  assert.deepEqual(uploaded, { ...pending, pending: false });
  await provider.download(connection, target.scope, uploaded, file);
  assert.deepEqual(calls, [
    [connection.id, target.scope, target.device, file.uri, createdAt, DRIVE_BACKUP_FILE_LIMIT],
    [connection.id, target.scope],
    [connection.id, target.scope, target.device, file.uri, createdAt, pending.size, DRIVE_BACKUP_FILE_LIMIT],
  ]);

  listCopy = { ...pending, error: "providerFailed" };
  assert.deepEqual(await provider.list(connection, target.scope), [listCopy]);

  for (const [nativeCode, code] of [
    ["E_ICLOUD_RECONNECT", "reconnect"],
    ["E_ICLOUD_OFFLINE", "offline"],
    ["E_ICLOUD_TOO_LARGE", "tooLarge"],
    ["E_ICLOUD_PROVIDER", "providerFailed"],
  ]) {
    errorCode = nativeCode;
    await assert.rejects(provider.list(connection, target.scope), { code });
  }
  console.log("icloud-backup-selftest passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
