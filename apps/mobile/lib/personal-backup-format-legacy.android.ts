import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { scryptAsync } from "@noble/hashes/scrypt";

// Retain the original KDF, encoding and authenticated layout on Android.
// The caller checks the version and bounds before reading a v1 file here.
export async function openLegacyBackup(file: Uint8Array, password: string): Promise<Uint8Array> {
  const header = file.subarray(0, 48);
  const key = await scryptAsync(password, header.subarray(8, 24), {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
    asyncTick: 8,
  });
  try {
    return xchacha20poly1305(key, header.subarray(24), header).decrypt(file.subarray(48));
  } finally {
    key.fill(0);
  }
}
