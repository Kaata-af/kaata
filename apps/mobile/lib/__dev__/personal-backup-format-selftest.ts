import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  BACKUP_RANDOM_LENGTH,
  openBackup,
  sealBackup,
  validBackupPassword,
} from "../personal-backup-format";

async function main() {
  const password = "my recovery password 🧾";
  const source = new TextEncoder().encode("SQLite format 3\0private synthetic ledger data");
  const random = () => Uint8Array.from(randomBytes(BACKUP_RANDOM_LENGTH));
  assert.equal(validBackupPassword("short"), false);
  assert.equal(validBackupPassword(" ".repeat(12)), false);
  assert.equal(validBackupPassword("📘".repeat(12)), true);

  const archive = await sealBackup(source, password, random());
  assert.equal(Buffer.from(archive).includes(Buffer.from(source)), false);
  assert.deepEqual(await openBackup(archive, password), source);
  assert.notDeepEqual(await sealBackup(source, password, random()), archive);
  await assert.rejects(openBackup(archive, "a different password"));
  await assert.rejects(openBackup(archive.subarray(0, archive.length - 1), password));

  const forged = archive.slice();
  forged[forged.length - 18] ^= 1;
  await assert.rejects(openBackup(forged, password));
  const unknownVersion = archive.slice();
  unknownVersion[7] = 2;
  await assert.rejects(openBackup(unknownVersion, password));
  await assert.rejects(sealBackup(source, password, new Uint8Array(1)));
  console.log(
    "PASS personal backup format: round trip, randomized seal, password and tamper checks",
  );
}

void main();
