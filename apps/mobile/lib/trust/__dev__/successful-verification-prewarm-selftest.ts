import assert from "node:assert/strict";
import {
  createSuccessfulVerificationCache,
  type SignatureCheck,
  type BatchSignatureVerifier,
} from "../successful-verification-cache";

const check = (byte = 1): SignatureCheck => ({
  message: Uint8Array.of(byte),
  signature: "sig",
  publicKey: "key",
});
async function main() {
  for (const response of [null, [false], [], [true, true], ["true"], Array(1)]) {
    let noble = 0;
    const cache = createSuccessfulVerificationCache(
      () => {
        noble++;
        return true;
      },
      {},
      async () => response as boolean[] | null,
    );
    await cache.prewarm([check()]);
    assert.equal(cache(check().message, "sig", "key"), true);
    assert.equal(
      noble,
      1,
      "false, unavailable and malformed native responses fall back to the original verifier",
    );
  }
  for (const provider of [
    undefined,
    async () => {
      throw Error("native unavailable");
    },
  ] as (BatchSignatureVerifier | undefined)[]) {
    let noble = 0;
    const cache = createSuccessfulVerificationCache(
      () => {
        noble++;
        return false;
      },
      {},
      provider,
    );
    await cache.prewarm([check()]);
    assert.equal(cache(check().message, "sig", "key"), false);
    assert.equal(
      noble,
      1,
      "missing or rejected native provider cannot bypass the original verifier",
    );
  }
  let noble = 0,
    batches = 0;
  const cache = createSuccessfulVerificationCache(
    () => {
      noble++;
      return false;
    },
    {},
    async (checks) => {
      batches++;
      return checks.map(() => true);
    },
  );
  await cache.prewarm([check(), check()]);
  assert.equal(batches, 1);
  assert.equal(cache(check().message, "sig", "key"), true);
  assert.equal(noble, 0);
  assert.equal(cache(Uint8Array.of(2), "sig", "key"), false);
  assert.equal(cache(check().message, "different", "key"), false);
  assert.equal(cache(check().message, "sig", "different"), false);
  assert.equal(noble, 3, "native true warms only the exact bytes, signature and key");

  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = check(7);
  let work = 0;
  const concurrent = createSuccessfulVerificationCache(
    () => false,
    {},
    async (checks) => {
      work++;
      entered();
      await gate;
      assert.equal(checks[0].message[0], 7, "native batch owns a copy of its input bytes");
      return checks.map(() => true);
    },
  );
  const first = concurrent.prewarm([original]);
  const second = concurrent.prewarm([check(7)]);
  await started;
  original.message[0] = 8;
  release();
  await Promise.all([first, second]);
  assert.equal(work, 1, "concurrent prewarming shares successful work");
  assert.equal(concurrent(Uint8Array.of(7), "sig", "key"), true);
  assert.equal(concurrent(original.message, "sig", "key"), false);

  const boundary = Array.from({ length: 33 }, (_, i) => check(i));
  let boundaryCalls = 0;
  const boundaryCache = createSuccessfulVerificationCache(
    () => false,
    {},
    async (checks) => {
      if (++boundaryCalls === 1) boundary[32].message[0] = 99;
      else
        assert.equal(
          checks[0].message[0],
          32,
          "next-batch candidate was copied before awaiting the earlier batch",
        );
      return checks.map(() => true);
    },
  );
  await boundaryCache.prewarm(boundary);
  assert.equal(boundaryCache(Uint8Array.of(32), "sig", "key"), true);
  assert.equal(boundaryCache(Uint8Array.of(99), "sig", "key"), false);

  const chunks: { count: number; bytes: number }[] = [];
  const chunked = createSuccessfulVerificationCache(
    () => false,
    { maxEntries: 2048, maxKeyBytes: 4 * 1024 * 1024 },
    async (checks) => {
      chunks.push({
        count: checks.length,
        bytes: checks.reduce((n, item) => n + item.message.byteLength, 0),
      });
      return checks.map(() => true);
    },
  );
  const large = Array.from({ length: 70 }, (_, i) => ({
    ...check(),
    signature: `sig-${i}`,
    message: new Uint8Array(16 * 1024),
  }));
  let taskRan = false;
  const task = new Promise<void>((resolve) =>
    setTimeout(() => {
      taskRan = true;
      resolve();
    }, 0),
  );
  await chunked.prewarm(large);
  assert.equal(taskRan, true, "preprocessing yields real tasks before consuming a large history");
  await task;
  assert.equal(chunks.length, 9);
  assert.ok(chunks.every((batch) => batch.count <= 32 && batch.bytes <= 128 * 1024));
  const before = chunks.length;
  await chunked.prewarm(large);
  assert.equal(chunks.length, before, "already warmed inputs make no native requests");

  let oversizeNative = 0,
    oversizeNoble = 0;
  const oversized = createSuccessfulVerificationCache(
    () => {
      oversizeNoble++;
      return false;
    },
    {},
    async (checks) => {
      oversizeNative += checks.length;
      return checks.map(() => true);
    },
  );
  const huge = { ...check(), message: new Uint8Array(16 * 1024 + 1) };
  await oversized.prewarm([huge]);
  assert.equal(oversizeNative, 0);
  oversized(huge.message, huge.signature, huge.publicKey);
  assert.equal(oversizeNoble, 1, "oversized checks retain the ordinary verification path");
  console.log(
    "successful verification prewarm: exact positives, fallbacks, concurrent input safety, bounded chunks and task yielding passed",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
