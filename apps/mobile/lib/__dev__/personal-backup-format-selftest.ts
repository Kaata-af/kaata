import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { derivePersonalBackupKey } from "../personal-backup-format-kdf";
import { openLegacyBackup } from "../personal-backup-format-legacy.android";
import * as legacyUnavailable from "../personal-backup-format-legacy";
import { compileUI } from "./ui-fixture";

const password = "  Kaata ژباړه\0🧾 e\u0301  ";
const source = new TextEncoder().encode("SQLite format 3\0private synthetic ledger data");
const fixedRandom = Uint8Array.from({ length: 28 }, (_, index) => index);
const v1 = Uint8Array.from(
  Buffer.from(
    "4b41415441424b01000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262740af244e1e77d187cb8e6cb5fd3e075f9ba0acb3960a35605721ec2b6c2d7599b60db1e6c236f72632f4a3bf44fe48ca922d113ea207857bdfa25dc55e",
    "hex",
  ),
);
// Independently derived with node:crypto PBKDF2 and AES-GCM.
const v2 = Uint8Array.from(
  Buffer.from(
    "4b41415441424b02000102030405060708090a0b0c0d0e0f101112131415161718191a1b2565d08a95745c76022689c299a33e4ea5561b44d729573299c1efe551f4dcd36cfb231e6b969d1b606ad570c15c61811fdbbd5543fef435e4c7ef29ef",
    "hex",
  ),
);

// Exercise the real archive code while implementing the native AES boundary
// with Node OpenSSL. This also asserts the Expo Crypto arguments and layout.
const aes = {
  AESEncryptionKey: {
    import: async (bytes: Uint8Array) => {
      assert.equal(bytes.length, 32);
      return Uint8Array.from(bytes);
    },
  },
  AESSealedData: {
    fromCombined: (bytes: Uint8Array, { ivLength, tagLength }: Record<string, number>) => {
      assert.equal(ivLength, 12);
      assert.equal(tagLength, 16);
      return {
        iv: bytes.subarray(0, ivLength),
        ciphertext: bytes.subarray(ivLength, -tagLength),
        tag: bytes.subarray(-tagLength),
      };
    },
  },
  aesEncryptAsync: async (
    bytes: Uint8Array,
    key: Uint8Array,
    {
      nonce,
      additionalData,
      tagLength,
    }: {
      nonce: { bytes: Uint8Array };
      additionalData: Uint8Array;
      tagLength: number;
    },
  ) => {
    assert.equal(nonce.bytes.length, 12);
    assert.equal(additionalData.length, 36);
    assert.equal(tagLength, 16);
    const cipher = createCipheriv("aes-256-gcm", key, nonce.bytes);
    cipher.setAAD(additionalData);
    const result = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    return {
      ciphertext: async ({ includeTag }: { includeTag: boolean }) => {
        assert.equal(includeTag, true);
        return result;
      },
    };
  },
  aesDecryptAsync: async (
    sealed: { iv: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array },
    key: Uint8Array,
    { additionalData }: { additionalData: Uint8Array },
  ) => {
    assert.equal(additionalData.length, 36);
    const cipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
    cipher.setAAD(additionalData);
    cipher.setAuthTag(sealed.tag);
    return Uint8Array.from(Buffer.concat([cipher.update(sealed.ciphertext), cipher.final()]));
  },
};

const iosKdf = compileUI("../personal-backup-format-kdf.ios", {
  "expo-modules-core": {
    requireNativeModule: (name: string) => {
      assert.equal(name, "KaataBackupCrypto");
      return {
        derivePersonalBackupKey: async (bytes: Uint8Array, salt: Uint8Array) => {
          assert.deepEqual(bytes, new TextEncoder().encode(password));
          return Uint8Array.from(pbkdf2Sync(bytes, salt, 600_000, 32, "sha256"));
        },
      };
    },
  },
});

function loadFormat(ios: boolean): typeof import("../personal-backup-format") {
  return compileUI("../personal-backup-format", {
    "expo-crypto": aes,
    "./personal-backup-format-kdf": ios ? iosKdf : { derivePersonalBackupKey },
    "./personal-backup-format-legacy": ios ? legacyUnavailable : { openLegacyBackup },
  });
}

async function main() {
  const android = loadFormat(false);
  const ios = loadFormat(true);
  const { BACKUP_RANDOM_LENGTH, MAX_BACKUP_DATABASE_BYTES, MAX_BACKUP_FILE_BYTES } = android;
  assert.equal(BACKUP_RANDOM_LENGTH, fixedRandom.length);
  assert.equal(MAX_BACKUP_FILE_BYTES, MAX_BACKUP_DATABASE_BYTES + 64);
  assert.equal(android.validBackupPassword("short"), false);
  assert.equal(android.validBackupPassword(" ".repeat(12)), false);
  assert.equal(android.validBackupPassword("📘".repeat(12)), true);

  const archive = await android.sealBackup(source, password, fixedRandom);
  assert.deepEqual(archive, v2);
  assert.deepEqual(await ios.sealBackup(source, password, fixedRandom), v2);
  assert.equal(Buffer.from(archive).includes(Buffer.from(source)), false);
  assert.deepEqual(await android.openBackup(archive, password), source);
  assert.deepEqual(await ios.openBackup(archive, password), source);
  const randomized = Uint8Array.from(randomBytes(BACKUP_RANDOM_LENGTH));
  assert.notDeepEqual(await ios.sealBackup(source, password, randomized), archive);
  await assert.rejects(android.openBackup(archive, "a different password"));
  await assert.rejects(android.openBackup(archive, password.normalize("NFC")));
  await assert.rejects(android.openBackup(archive.subarray(0, archive.length - 1), password));

  for (const offset of [8, 24, 36, archive.length - 1]) {
    const forged = archive.slice();
    forged[offset] ^= 1;
    await assert.rejects(ios.openBackup(forged, password));
  }
  const unknownVersion = archive.slice();
  unknownVersion[7] = 3;
  await assert.rejects(android.openBackup(unknownVersion, password));
  await assert.rejects(android.sealBackup(source, password, new Uint8Array(1)));
  await assert.rejects(ios.sealBackup(source, `${password}\uD800`, fixedRandom));

  assert.deepEqual(await android.openBackup(v1, password), source);
  await assert.rejects(ios.openBackup(v1, password), ios.LegacyBackupUnsupportedError);
  await assert.rejects(android.openBackup(v1, "a different password"));
  console.log("PASS personal backup format: native AES contract, V2 vectors, and Android-only V1");
}

void main();
