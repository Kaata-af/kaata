import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";

// Android 7 (API 24) doesn't guarantee PBKDF2withHmacSHA256 through JCA.
// Accept the same exact UTF-8 bytes as the iOS CommonCrypto implementation.
export function derivePersonalBackupKey(
  password: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  return pbkdf2Async(sha256, password, salt, { c: 600_000, dkLen: 32 });
}
