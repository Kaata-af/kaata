import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from "expo-crypto";
import { derivePersonalBackupKey } from "./personal-backup-format-kdf";
import { openLegacyBackup } from "./personal-backup-format-legacy";

const MAGIC = Uint8Array.of(75, 65, 65, 84, 65, 66, 75); // KAATABK
const VERSION = 2;
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_OFFSET = MAGIC.length + 1;
const NONCE_OFFSET = SALT_OFFSET + SALT_LENGTH;
const HEADER_LENGTH = NONCE_OFFSET + NONCE_LENGTH;
const LEGACY_HEADER_LENGTH = NONCE_OFFSET + 24;

export const BACKUP_RANDOM_LENGTH = SALT_LENGTH + NONCE_LENGTH;
export const MAX_BACKUP_DATABASE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = LEGACY_HEADER_LENGTH + MAX_BACKUP_DATABASE_BYTES + TAG_LENGTH;

export class LegacyBackupUnsupportedError extends Error {
  readonly code = "legacyUnsupported";

  constructor() {
    super("This encrypted backup version can only be restored on Android");
    this.name = "LegacyBackupUnsupportedError";
  }
}

export function validBackupPassword(password: string): boolean {
  const length = Array.from(password).length;
  return password.trim().length > 0 && length >= 12 && length <= 256;
}

async function keyFor(password: string, salt: Uint8Array): Promise<AESEncryptionKey> {
  // Encode the exact password, including spaces and non-ASCII characters.
  // Never pass a null-terminated string to a native derivation function.
  if (/[\uD800-\uDFFF]/u.test(password)) throw new Error("Invalid backup password");
  const encoded = new TextEncoder().encode(password);
  try {
    const bytes = await derivePersonalBackupKey(encoded, salt);
    try {
      if (bytes.length !== 32) throw new Error("Invalid backup key");
      return await AESEncryptionKey.import(bytes);
    } finally {
      bytes.fill(0);
    }
  } finally {
    encoded.fill(0);
  }
}

export async function sealBackup(
  database: Uint8Array,
  password: string,
  random: Uint8Array,
): Promise<Uint8Array> {
  if (!validBackupPassword(password)) throw new Error("Invalid backup password");
  if (!database.length || database.length > MAX_BACKUP_DATABASE_BYTES)
    throw new Error("Invalid backup database size");
  if (random.length !== BACKUP_RANDOM_LENGTH) throw new Error("Invalid backup salt or nonce");

  const file = new Uint8Array(HEADER_LENGTH + database.length + TAG_LENGTH);
  file.set(MAGIC);
  file[MAGIC.length] = VERSION;
  file.set(random, SALT_OFFSET);
  const header = file.subarray(0, HEADER_LENGTH);
  const key = await keyFor(password, header.subarray(SALT_OFFSET, NONCE_OFFSET));
  const sealed = await aesEncryptAsync(database, key, {
    nonce: { bytes: header.subarray(NONCE_OFFSET) },
    additionalData: header,
    tagLength: TAG_LENGTH,
  });
  const ciphertext = await sealed.ciphertext({ includeTag: true });
  if (ciphertext.length !== database.length + TAG_LENGTH)
    throw new Error("Invalid encrypted backup size");
  file.set(ciphertext, HEADER_LENGTH);
  return file;
}

export async function openBackup(file: Uint8Array, password: string): Promise<Uint8Array> {
  if (!validBackupPassword(password)) throw new Error("Invalid backup password");
  if (file.length > MAX_BACKUP_FILE_BYTES || !MAGIC.every((byte, index) => file[index] === byte))
    throw new Error("Unsupported or malformed backup");

  const version = file[MAGIC.length];
  if (version === 1 && file.length > LEGACY_HEADER_LENGTH + TAG_LENGTH) {
    const legacy = await openLegacyBackup(file, password);
    if (legacy === null) throw new LegacyBackupUnsupportedError();
    return legacy;
  }
  if (
    version !== VERSION ||
    file.length <= HEADER_LENGTH + TAG_LENGTH ||
    file.length > HEADER_LENGTH + MAX_BACKUP_DATABASE_BYTES + TAG_LENGTH
  )
    throw new Error("Unsupported or malformed backup");

  const header = file.subarray(0, HEADER_LENGTH);
  const key = await keyFor(password, header.subarray(SALT_OFFSET, NONCE_OFFSET));
  // The bytes starting at NONCE_OFFSET are nonce || ciphertext || tag, the
  // Expo AES combined representation. Keep the entire versioned header as AAD.
  const sealed = AESSealedData.fromCombined(file.subarray(NONCE_OFFSET), {
    ivLength: NONCE_LENGTH,
    tagLength: TAG_LENGTH,
  });
  return aesDecryptAsync(sealed, key, { additionalData: header });
}
