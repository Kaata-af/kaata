import { requireNativeModule } from "expo-modules-core";

type BackupCrypto = {
  derivePersonalBackupKey(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
};

export function derivePersonalBackupKey(
  password: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  return requireNativeModule<BackupCrypto>("KaataBackupCrypto").derivePersonalBackupKey(
    password,
    salt,
  );
}
