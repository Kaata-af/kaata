import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scryptAsync } from "@noble/hashes/scrypt";

// Version 1 uses fixed KDF parameters. The whole header, including version,
// salt and nonce, is authenticated along with the database.
const MAGIC = Uint8Array.of(75, 65, 65, 84, 65, 66, 75, 1); // KAATABK + version
const SALT_LENGTH = 16;
const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + NONCE_LENGTH;

export const BACKUP_RANDOM_LENGTH = SALT_LENGTH + NONCE_LENGTH;
export const MAX_BACKUP_DATABASE_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = HEADER_LENGTH + MAX_BACKUP_DATABASE_BYTES + TAG_LENGTH;

export function validBackupPassword(password: string): boolean {
  const length = Array.from(password).length;
  return password.trim().length > 0 && length >= 12 && length <= 256;
}

function keyFor(password: string, header: Uint8Array) {
  return scryptAsync(password, header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH), {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
    asyncTick: 8,
  });
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
  file.set(random, MAGIC.length);
  const header = file.subarray(0, HEADER_LENGTH);
  const key = await keyFor(password, header);
  try {
    const nonce = header.subarray(HEADER_LENGTH - NONCE_LENGTH);
    xchacha20poly1305(key, nonce, header).encrypt(database, file.subarray(HEADER_LENGTH));
    return file;
  } finally {
    key.fill(0);
  }
}

export async function openBackup(file: Uint8Array, password: string): Promise<Uint8Array> {
  if (!validBackupPassword(password)) throw new Error("Invalid backup password");
  if (
    file.length <= HEADER_LENGTH + TAG_LENGTH ||
    file.length > MAX_BACKUP_FILE_BYTES ||
    !MAGIC.every((byte, index) => file[index] === byte)
  )
    throw new Error("Unsupported or malformed backup");
  const header = file.subarray(0, HEADER_LENGTH);
  const key = await keyFor(password, header);
  try {
    const nonce = header.subarray(HEADER_LENGTH - NONCE_LENGTH);
    return xchacha20poly1305(key, nonce, header).decrypt(file.subarray(HEADER_LENGTH));
  } finally {
    key.fill(0);
  }
}
