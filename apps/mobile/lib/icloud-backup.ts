import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { DRIVE_BACKUP_FILE_LIMIT } from "./drive-backup";
import {
  PersonalCloudProviderError,
  type PersonalCloudCopy,
  type PersonalCloudProvider,
} from "./personal-cloud-types";

type NativeICloudBackup = {
  connect(): Promise<string>;
  upload(
    connection: string,
    scope: string,
    device: string,
    sourceUri: string,
    createdAt: number,
    limit: number,
  ): Promise<PersonalCloudCopy>;
  list(connection: string, scope: string): Promise<PersonalCloudCopy[]>;
  download(
    connection: string,
    scope: string,
    device: string,
    destinationUri: string,
    createdAt: number,
    expectedSize: number,
    limit: number,
  ): Promise<void>;
};

function nativeModule() {
  return Platform.OS === "ios"
    ? requireOptionalNativeModule<NativeICloudBackup>("KaataICloudBackup")
    : null;
}

async function useICloud<T>(operation: (native: NativeICloudBackup) => Promise<T>): Promise<T> {
  const native = nativeModule();
  if (!native) throw new PersonalCloudProviderError("providerFailed");
  try {
    return await operation(native);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    switch (code) {
      case "E_ICLOUD_RECONNECT":
        throw new PersonalCloudProviderError("reconnect");
      case "E_ICLOUD_OFFLINE":
        throw new PersonalCloudProviderError("offline");
      case "E_ICLOUD_TOO_LARGE":
        throw new PersonalCloudProviderError("tooLarge");
      default:
        throw new PersonalCloudProviderError("providerFailed");
    }
  }
}

export const icloudDriveBackupProvider: PersonalCloudProvider = {
  supported: () => nativeModule() !== null,
  connect: () => useICloud(async (native) => ({ id: await native.connect() })),
  upload: (connection, target, file, createdAt) =>
    useICloud((native) =>
      native.upload(connection.id, target.scope, target.device, file.uri, createdAt, DRIVE_BACKUP_FILE_LIMIT),
    ),
  list: (connection, scope) => useICloud((native) => native.list(connection.id, scope)),
  download: (connection, scope, copy, destination) =>
    useICloud((native) =>
      native.download(connection.id, scope, copy.id, destination.uri, copy.createdAt, copy.size, DRIVE_BACKUP_FILE_LIMIT),
    ),
};
