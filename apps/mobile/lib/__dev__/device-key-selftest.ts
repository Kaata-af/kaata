// Run with: npm run selftest:device-key
// Synthetic fixtures only: never opens kaata.db, SecureStore, or a device.
//
// Exercises the ACTUAL lib/mesh/device-key.ts against an in-memory SecureStore
// and an in-memory app_meta, one branch of loadOrRepairDeviceKey per case:
// fresh install, healthy, missing seed (the restored-phone bug), corrupt seed,
// mismatched seed (adopt, never a third key), throwing read (no rotation),
// failing writes (convergence), concurrent cold callers (one keypair), an
// open transaction (no repair), identity resolution over retired keys, the
// retired-list cap, sign-out re-validation, and backend re-registration.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// The sync @noble API needs this shim; device-key.ts installs it at load, but
// the helpers below (pubOf) must not depend on case ordering.
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// --- stubs -----------------------------------------------------------------

const meta = new Map<string, string>();
const secure = {
  store: new Map<string, string>(),
  readMode: "ok" as "ok" | "throw",
  writeMode: "ok" as "ok" | "throw",
  reads: 0,
  writes: 0,
  delayMs: 0,
  // Flip the fake connection into "a transaction is open" in the middle of
  // a SecureStore write — the check-then-act window the repair must survive.
  openTransactionOnWrite: false,
};
let inTransaction = false;
let failMetaWrites = 0;
let vaultAnchors: string[] = [];
let anchorsQueryThrows = false;
let sessionJwt: string | null = null;
let fetchStatus = 200;
let fetchCalls = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function metaUpsert(args: unknown[]): void {
  if (failMetaWrites > 0) {
    failMetaWrites--;
    throw new Error("synthetic app_meta write failure");
  }
  for (let i = 0; i + 1 < args.length; i += 2) meta.set(String(args[i]), String(args[i + 1]));
}

const fakeDb = {
  isInTransactionSync: () => inTransaction,
  runAsync: async (sql: string, ...args: unknown[]) => {
    if (/INSERT INTO app_meta/i.test(sql)) {
      metaUpsert(args);
      return { changes: args.length / 2, lastInsertRowId: 0 };
    }
    throw new Error(`unexpected runAsync in device-key selftest: ${sql}`);
  },
  getFirstAsync: async (sql: string, ...args: unknown[]) => {
    if (/SELECT value FROM app_meta WHERE key = \?/i.test(sql)) {
      const k = String(args[0]);
      return meta.has(k) ? { value: meta.get(k) } : null;
    }
    if (/key = 'account_id'/i.test(sql)) {
      return meta.has("account_id") ? { value: meta.get("account_id") } : null;
    }
    throw new Error(`unexpected getFirstAsync in device-key selftest: ${sql}`);
  },
  getAllAsync: async (sql: string) => {
    if (/vault_trust_anchor_pubkey/i.test(sql)) {
      if (anchorsQueryThrows) throw new Error("synthetic SQLITE_BUSY on vaults");
      return vaultAnchors.map((k) => ({ k }));
    }
    return [];
  },
};

const savedModules = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: unknown): void {
  const filename = require.resolve(name);
  savedModules.set(filename, require.cache[filename]);
  // __esModule so a dynamic import() of the stubbed path sees the named
  // exports instead of wrapping the whole object as `default`.
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...(exports as object) },
  } as NodeJS.Module;
}

stub("expo-crypto", {
  randomUUID,
  getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)),
});
stub("expo-secure-store", {
  getItemAsync: async (key: string) => {
    secure.reads++;
    if (secure.delayMs) await sleep(secure.delayMs);
    if (secure.readMode === "throw") throw new Error("synthetic keystore read failure");
    return secure.store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    secure.writes++;
    if (secure.delayMs) await sleep(secure.delayMs);
    if (secure.writeMode === "throw") throw new Error("synthetic keystore write failure");
    secure.store.set(key, value);
    if (secure.openTransactionOnWrite) inTransaction = true;
  },
  deleteItemAsync: async (key: string) => {
    secure.store.delete(key);
  },
});
stub("../db-tx", {
  getDb: async () => fakeDb,
  getAppMetaInTx: async (_db: unknown, key: string) => meta.get(key) ?? null,
  setAppMetaInTx: async (_db: unknown, key: string, value: string) => {
    metaUpsert([key, value]);
  },
});
stub("../db", {
  getAppMeta: async (key: string) => meta.get(key) ?? null,
  setAppMeta: async (key: string, value: string) => {
    metaUpsert([key, value]);
  },
});
stub("../api", { getBackendUrl: async () => "http://backend.invalid" });
stub("../auth", { getSessionJWT: async () => sessionJwt });

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchCalls++;
  return { ok: fetchStatus < 400, status: fetchStatus } as Response;
}) as typeof fetch;

// --- helpers ---------------------------------------------------------------

const PRIVKEY_KEY = "kaata_mesh_device_privkey";
const PUBKEY_KEY = "mesh_device_ed25519_pubkey";

type DeviceKeyModule = typeof import("../mesh/device-key");

// Each case gets a cold module (fresh caches, no in-flight promise).
function freshModule(): DeviceKeyModule {
  delete require.cache[require.resolve("../mesh/device-key")];
  return require("../mesh/device-key") as DeviceKeyModule;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const seedOf = (fill: number) => new Uint8Array(32).fill(fill);
const pubOf = (seed: Uint8Array) => b64(ed.getPublicKey(seed));
const storedSeed = () => {
  const raw = secure.store.get(PRIVKEY_KEY);
  return raw ? new Uint8Array(Buffer.from(raw, "base64")) : null;
};
const retired = () => JSON.parse(meta.get("retired_device_pubkeys") ?? "[]") as string[];

function reset(): void {
  meta.clear();
  secure.store.clear();
  secure.readMode = "ok";
  secure.writeMode = "ok";
  secure.reads = 0;
  secure.writes = 0;
  secure.delayMs = 0;
  secure.openTransactionOnWrite = false;
  inTransaction = false;
  failMetaWrites = 0;
  vaultAnchors = [];
  anchorsQueryThrows = false;
  sessionJwt = null;
  fetchStatus = 200;
  fetchCalls = 0;
}

function seedHealthy(fill = 1): { seed: Uint8Array; pub: string } {
  const seed = seedOf(fill);
  const pub = pubOf(seed);
  secure.store.set(PRIVKEY_KEY, b64(seed));
  meta.set(PUBKEY_KEY, pub);
  return { seed, pub };
}

async function assertSignsWith(mod: DeviceKeyModule, expectedPub: string): Promise<void> {
  const signer = await mod.getDeviceSigner();
  assert.equal(signer.pubkey_b64, expectedPub);
  const message = new TextEncoder().encode("synthetic canonical event bytes");
  const sig = await signer.sign(message);
  assert.equal(sig.length, 64);
  assert.ok(ed.verify(sig, message, new Uint8Array(Buffer.from(expectedPub, "base64"))));
  assert.equal(mod.getDevicePubkey(), expectedPub);
  assert.ok(mod.isDeviceKeyReady());
}

function assertRotationBookkeeping(oldPub: string, count: number, prior: string[] = []): void {
  assert.deepEqual(retired(), [...prior.filter((p) => p !== oldPub), oldPub]);
  assert.equal(meta.get("device_key_rotation_count"), String(count));
  assert.equal(meta.get("device_key_read_failures"), "0");
  assert.ok(Number(meta.get("device_key_rotated_at")) > 0);
  assert.equal(meta.get("device_key_reregister_pending"), "1");
  assert.equal(meta.get("device_key_rebind_pending"), "1");
}

let passed = 0;
let failed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  reset();
  try {
    await run();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`, error);
  }
}

// --- cases -----------------------------------------------------------------

async function main(): Promise<void> {
  await test("fresh install generates one keypair and mirrors only the pubkey", async () => {
    const mod = freshModule();
    const { pubkey_b64 } = await mod.ensureDeviceKey();
    const seed = storedSeed();
    assert.ok(seed && seed.length === 32);
    assert.equal(pubOf(seed), pubkey_b64);
    assert.equal(meta.get(PUBKEY_KEY), pubkey_b64);
    assert.equal(secure.writes, 1);
    assert.equal(meta.has("retired_device_pubkeys"), false);
    assert.equal(meta.has("device_key_reregister_pending"), false);
    assert.equal(meta.has("device_key_rebind_pending"), false);
    await assertSignsWith(mod, pubkey_b64);
    assert.deepEqual(await mod.readOwnDevicePubkeys(), { current: pubkey_b64, retired: [] });
  });

  await test("healthy device warms both halves with one read and no writes", async () => {
    const { pub } = seedHealthy();
    const mod = freshModule();
    assert.equal(mod.isDeviceKeyReady(), false);
    const first = await mod.ensureDeviceKey();
    assert.equal(first.pubkey_b64, pub);
    assert.equal(secure.reads, 1);
    assert.equal(secure.writes, 0);
    await mod.ensureDeviceKey();
    await mod.ensureDeviceKey();
    assert.equal(secure.reads, 1, "warm calls are cache hits");
    await assertSignsWith(mod, pub);
    assert.equal(secure.reads, 1, "signing never re-reads SecureStore");
    assert.deepEqual(retired(), []);
  });

  await test("restored phone: pubkey mirror without a seed rotates, retires, and signs again", async () => {
    // The Android backup-rules shape: kaata.db (with the mirror) came back,
    // the Keystore-wrapped SecureStore value did not.
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    const mod = freshModule();
    const { pubkey_b64: newPub } = await mod.ensureDeviceKey();
    assert.notEqual(newPub, oldPub);
    const seed = storedSeed();
    assert.ok(seed && pubOf(seed) === newPub, "SecureStore holds the seed for the new pubkey");
    assert.equal(meta.get(PUBKEY_KEY), newPub);
    assert.equal(secure.writes, 1);
    assertRotationBookkeeping(oldPub, 1);
    await assertSignsWith(mod, newPub);
    assert.deepEqual(await mod.readOwnDevicePubkeys(), { current: newPub, retired: [oldPub] });
    assert.equal(await mod.isOwnDevicePubkey(oldPub), true);
    assert.equal(await mod.isOwnDevicePubkey(newPub), true);
    assert.equal(await mod.isOwnDevicePubkey(pubOf(seedOf(7))), false);
    const status = await mod.getDeviceKeyStatus();
    assert.equal(status.ready, true);
    assert.equal(status.rotations, 1);
    assert.equal(status.retiredCount, 1);
    assert.equal(status.reregisterPending, true);
    assert.equal(status.rebindPending, true);
    // A second launch on the repaired device is healthy: no further rotation.
    const relaunch = freshModule();
    assert.equal((await relaunch.ensureDeviceKey()).pubkey_b64, newPub);
    assert.equal(secure.writes, 1);
    assert.equal(meta.get("device_key_rotation_count"), "1");
  });

  await test("corrupt seed behind a live mirror is treated as missing", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    secure.store.set(PRIVKEY_KEY, b64(new Uint8Array(16).fill(3)));
    const mod = freshModule();
    const { pubkey_b64: newPub } = await mod.ensureDeviceKey();
    assert.notEqual(newPub, oldPub);
    assert.equal(storedSeed()?.length, 32);
    assert.equal(secure.writes, 1);
    assertRotationBookkeeping(oldPub, 1);
    await assertSignsWith(mod, newPub);
  });

  await test("mismatched seed is ADOPTED: no new key, SecureStore untouched, old mirror retired", async () => {
    const stale = pubOf(seedOf(1));
    const seedB = seedOf(2);
    meta.set(PUBKEY_KEY, stale);
    secure.store.set(PRIVKEY_KEY, b64(seedB));
    const mod = freshModule();
    const { pubkey_b64 } = await mod.ensureDeviceKey();
    assert.equal(pubkey_b64, pubOf(seedB));
    assert.equal(secure.writes, 0, "adopting never writes SecureStore");
    assert.equal(b64(storedSeed()!), b64(seedB));
    assert.equal(meta.get(PUBKEY_KEY), pubOf(seedB));
    assertRotationBookkeeping(stale, 1);
    await assertSignsWith(mod, pubOf(seedB));
  });

  await test("a SecureStore read that throws repairs nothing and is retried later", async () => {
    // A locked iOS keychain / Keystore hiccup must never rotate a good key.
    const { pub } = seedHealthy();
    secure.readMode = "throw";
    const mod = freshModule();
    await assert.rejects(
      mod.ensureDeviceKey(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "read_failed",
    );
    await assert.rejects(
      mod.getDeviceSigner(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "read_failed",
    );
    assert.equal(secure.writes, 0);
    assert.equal(meta.get(PUBKEY_KEY), pub);
    assert.deepEqual(retired(), []);
    assert.equal(mod.isDeviceKeyReady(), false);
    // Keystore back: the SAME module instance recovers (in-flight was cleared).
    secure.readMode = "ok";
    assert.equal((await mod.ensureDeviceKey()).pubkey_b64, pub);
    await assertSignsWith(mod, pub);
    assert.equal(secure.writes, 0);
  });

  await test("a refused SecureStore write leaves both halves untouched; the next attempt succeeds", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    secure.writeMode = "throw";
    const mod = freshModule();
    await assert.rejects(
      mod.ensureDeviceKey(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "write_failed",
    );
    assert.equal(secure.store.has(PRIVKEY_KEY), false);
    assert.equal(meta.get(PUBKEY_KEY), oldPub);
    assert.deepEqual(retired(), []);
    assert.equal(meta.has("device_key_reregister_pending"), false);
    secure.writeMode = "ok";
    const { pubkey_b64: newPub } = await mod.ensureDeviceKey();
    assert.notEqual(newPub, oldPub);
    assertRotationBookkeeping(oldPub, 1);
    await assertSignsWith(mod, newPub);
  });

  await test("an app_meta write that fails after the seed landed converges by adopting", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    failMetaWrites = 1;
    const mod = freshModule();
    await assert.rejects(
      mod.ensureDeviceKey(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "write_failed",
    );
    const newSeed = storedSeed();
    assert.ok(newSeed, "SecureStore already holds the new seed");
    assert.equal(meta.get(PUBKEY_KEY), oldPub, "mirror still stale");
    assert.equal(mod.isDeviceKeyReady(), false);
    // Next cold path: mismatch → adopt the seed on disk. Exactly one SecureStore
    // write across both attempts, and the pubkey is the one whose seed exists.
    const again = freshModule();
    const { pubkey_b64 } = await again.ensureDeviceKey();
    assert.equal(pubkey_b64, pubOf(newSeed!));
    assert.equal(secure.writes, 1);
    assertRotationBookkeeping(oldPub, 1);
    await assertSignsWith(again, pubkey_b64);
  });

  await test("concurrent cold callers on a fresh install share one generation", async () => {
    secure.delayMs = 5;
    const mod = freshModule();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0 ? mod.ensureDeviceKey() : mod.getDeviceSigner(),
      ),
    );
    const pubs = new Set(results.map((r) => r.pubkey_b64));
    assert.equal(pubs.size, 1);
    assert.equal(secure.writes, 1, "exactly one keypair was persisted");
    assert.equal(secure.reads, 1, "exactly one SecureStore probe");
    assert.equal(meta.get(PUBKEY_KEY), [...pubs][0]);
    assert.equal(pubOf(storedSeed()!), [...pubs][0]);
  });

  await test("inside an open transaction: healthy warms, a needed repair is refused and deferred", async () => {
    const { pub } = seedHealthy();
    inTransaction = true;
    const healthy = freshModule();
    assert.equal((await healthy.ensureDeviceKey()).pubkey_b64, pub);
    assert.equal(secure.writes, 0);

    reset();
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    inTransaction = true;
    const mod = freshModule();
    await assert.rejects(
      mod.ensureDeviceKey(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "in_transaction",
    );
    assert.equal(secure.writes, 0);
    assert.equal(meta.get(PUBKEY_KEY), oldPub);
    assert.deepEqual(retired(), []);
    // Identity is still answerable in-transaction, read-only, and still says
    // the mirrored key is ours (that is what the vaults are keyed by).
    assert.deepEqual(await mod.readOwnDevicePubkeys(), { current: oldPub, retired: [] });
    assert.equal(await mod.isOwnDevicePubkey(oldPub), true);
    // Transaction closed (applyEvent's pre-warm, the boot check): repair runs.
    inTransaction = false;
    const { pubkey_b64: newPub } = await mod.ensureDeviceKey();
    assert.notEqual(newPub, oldPub);
    assertRotationBookkeeping(oldPub, 1);
  });

  await test("readOwnDevicePubkeys on a cold module never touches SecureStore", async () => {
    const oldPub = pubOf(seedOf(1));
    const cur = pubOf(seedOf(2));
    meta.set(PUBKEY_KEY, cur);
    meta.set("retired_device_pubkeys", JSON.stringify([oldPub, "not a key", oldPub]));
    const mod = freshModule();
    assert.deepEqual(await mod.readOwnDevicePubkeys(), { current: cur, retired: [oldPub] });
    assert.equal(await mod.isOwnDevicePubkey(oldPub), true);
    assert.equal(secure.reads, 0);
    assert.equal(secure.writes, 0);
    assert.equal(mod.getDevicePubkey(), null, "the read-only view does not claim readiness");
  });

  await test("identity candidates include the retired sentinel after the live one", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    meta.set("account_id", "google-account");
    const mod = freshModule();
    const { pubkey_b64: newPub } = await mod.ensureDeviceKey();
    const { resolveAccountIdCandidates } =
      require("../effective-account") as typeof import("../effective-account");
    const { buildLocalAccountId } =
      require("../trust/account-id") as typeof import("../trust/account-id");
    assert.deepEqual(await resolveAccountIdCandidates("passed-id"), [
      "passed-id",
      "google-account",
      buildLocalAccountId(newPub),
      buildLocalAccountId(oldPub),
    ]);
    // Never signed in, straight after the repair: the old sentinel — the id
    // every pre-rotation membership row is keyed by — is still "me", and the
    // live one stays first so primary-id preference is unchanged. A persisted
    // id that equals a sentinel is not duplicated.
    meta.set("account_id", buildLocalAccountId(oldPub));
    assert.deepEqual(await resolveAccountIdCandidates(null), [
      buildLocalAccountId(oldPub),
      buildLocalAccountId(newPub),
    ]);
    meta.delete("account_id");
    assert.deepEqual(await resolveAccountIdCandidates(null), [
      buildLocalAccountId(newPub),
      buildLocalAccountId(oldPub),
    ]);
  });

  await test("a corrupt mirror string is treated as absent: a valid seed is re-mirrored, nothing retired", async () => {
    const seed = seedOf(4);
    secure.store.set(PRIVKEY_KEY, b64(seed));
    meta.set(PUBKEY_KEY, "not a pubkey");
    const mod = freshModule();
    assert.equal((await mod.ensureDeviceKey()).pubkey_b64, pubOf(seed));
    assert.equal(secure.writes, 0);
    assert.equal(meta.get(PUBKEY_KEY), pubOf(seed));
    assert.deepEqual(retired(), []);
    assert.equal(meta.has("device_key_rotation_count"), false);
    assert.equal(meta.has("device_key_reregister_pending"), false);
    // ...and with no seed either, a fresh pair with no bookkeeping.
    reset();
    meta.set(PUBKEY_KEY, "garbage");
    const again = freshModule();
    const { pubkey_b64 } = await again.ensureDeviceKey();
    assert.equal(pubOf(storedSeed()!), pubkey_b64);
    assert.deepEqual(retired(), []);
    assert.equal(meta.has("device_key_reregister_pending"), false);
  });

  await test("a transaction opening during the SecureStore write refuses the mirror write; the next call adopts", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    secure.openTransactionOnWrite = true;
    const mod = freshModule();
    await assert.rejects(
      mod.ensureDeviceKey(),
      (e: unknown) => e instanceof mod.DeviceKeyUnavailableError && e.reason === "in_transaction",
    );
    assert.ok(storedSeed(), "the seed is already on disk");
    assert.equal(meta.get(PUBKEY_KEY), oldPub, "the mirror was not written into a foreign tx");
    assert.deepEqual(retired(), []);
    assert.equal(mod.isDeviceKeyReady(), false, "caches stay cold");
    assert.equal(mod.getDevicePubkey(), null);
    // Transaction gone: the adopt branch converges without a second seed.
    inTransaction = false;
    secure.openTransactionOnWrite = false;
    const { pubkey_b64 } = await mod.ensureDeviceKey();
    assert.equal(pubkey_b64, pubOf(storedSeed()!));
    assert.equal(secure.writes, 1);
    assertRotationBookkeeping(oldPub, 1);
  });

  await test("three consecutive foreground read failures rotate; background failures never count", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    secure.readMode = "throw";
    // Background callers (no interactive flag) never advance the counter.
    for (let i = 0; i < 5; i++) {
      const bg = freshModule();
      await assert.rejects(
        bg.ensureDeviceKey(),
        (e: unknown) => (e as { reason: string }).reason === "read_failed",
      );
    }
    assert.equal(meta.has("device_key_read_failures"), false);
    // Two foreground launches: still transient, still no rotation. A second
    // interactive call in the same process must not count twice.
    for (let launch = 1; launch <= 2; launch++) {
      const fg = freshModule();
      await assert.rejects(fg.ensureDeviceKey({ interactive: true }));
      await assert.rejects(fg.getDeviceSigner({ interactive: true }));
      assert.equal(meta.get("device_key_read_failures"), String(launch));
      assert.equal(secure.writes, 0);
      assert.equal(meta.get(PUBKEY_KEY), oldPub);
      const status = await fg.getDeviceKeyStatus();
      assert.equal(status.ready, false);
      assert.equal(status.lastFailure, "read_failed");
      assert.equal(status.readFailures, launch);
    }
    // Third foreground launch: the seed is treated as lost and repaired.
    const third = freshModule();
    const { pubkey_b64: newPub } = await third.ensureDeviceKey({ interactive: true });
    assert.notEqual(newPub, oldPub);
    assert.equal(secure.writes, 1);
    assertRotationBookkeeping(oldPub, 1);
    assert.ok(third.isDeviceKeyReady());
    // A healthy read afterwards resets the counter.
    reset();
    seedHealthy();
    meta.set("device_key_read_failures", "2");
    await freshModule().ensureDeviceKey({ interactive: true });
    await sleep(0);
    assert.equal(meta.get("device_key_read_failures"), "0");
  });

  await test("a failing anchors query never evicts; concurrent cold callers share a rejection", async () => {
    const anchor = pubOf(seedOf(200));
    const filler = Array.from({ length: 64 }, (_, i) => pubOf(seedOf(100 + i)));
    meta.set("retired_device_pubkeys", JSON.stringify([anchor, ...filler]));
    anchorsQueryThrows = true;
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    const mod = freshModule();
    await mod.ensureDeviceKey();
    const list = retired();
    assert.equal(list.length, 66, "nothing evicted while the anchors are unreadable");
    assert.equal(list[0], anchor);

    reset();
    seedHealthy();
    secure.readMode = "throw";
    secure.delayMs = 5;
    const shared = freshModule();
    const outcomes = await Promise.allSettled([
      shared.ensureDeviceKey(),
      shared.getDeviceSigner(),
      shared.ensureDeviceKey(),
    ]);
    assert.ok(outcomes.every((o) => o.status === "rejected"));
    assert.equal(secure.reads, 1, "one probe shared by every waiter");
    secure.readMode = "ok";
    assert.equal(await shared.registerDeviceKey(), "no_session");
    await assertSignsWith(shared, pubOf(seedOf(1)));
  });

  await test("retired list cap evicts the oldest non-anchor entry, never a live vault anchor", async () => {
    const anchor = pubOf(seedOf(200));
    const filler = Array.from({ length: 63 }, (_, i) => pubOf(seedOf(100 + i)));
    meta.set("retired_device_pubkeys", JSON.stringify([anchor, ...filler]));
    vaultAnchors = [anchor];
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    const mod = freshModule();
    await mod.ensureDeviceKey();
    const list = retired();
    assert.equal(list.length, 64);
    assert.equal(list[0], anchor, "anchor survives at the head");
    assert.equal(list.includes(filler[0]), false, "oldest non-anchor evicted");
    assert.equal(list[list.length - 1], oldPub);
  });

  await test("clearDeviceKey (sign-out) forces re-validation without rewriting a healthy key", async () => {
    const { pub } = seedHealthy();
    const mod = freshModule();
    await mod.ensureDeviceKey();
    mod.clearDeviceKey();
    assert.equal(mod.isDeviceKeyReady(), false);
    assert.equal(mod.getDevicePubkey(), null);
    assert.deepEqual(mod.getRetiredDevicePubkeysSync(), []);
    await assertSignsWith(mod, pub);
    assert.equal(secure.reads, 2);
    assert.equal(secure.writes, 0);
  });

  await test("registerDeviceKey reports the outcome and clears the pending flag only on success", async () => {
    const oldPub = pubOf(seedOf(1));
    meta.set(PUBKEY_KEY, oldPub);
    const mod = freshModule();
    await mod.ensureDeviceKey();
    assert.equal(meta.get("device_key_reregister_pending"), "1");
    assert.equal(await mod.registerDeviceKey(), "no_session");
    assert.equal(fetchCalls, 0);
    assert.equal(meta.get("device_key_reregister_pending"), "1");
    sessionJwt = "jwt";
    // A key that cannot be read right now is reported as failed, flag intact.
    mod.clearDeviceKey();
    secure.readMode = "throw";
    assert.equal(await mod.registerDeviceKey(), "failed");
    assert.equal(fetchCalls, 0);
    assert.equal(meta.get("device_key_reregister_pending"), "1");
    secure.readMode = "ok";
    fetchStatus = 503;
    assert.equal(await mod.registerDeviceKey(), "failed");
    assert.equal(meta.get("device_key_reregister_pending"), "1");
    fetchStatus = 200;
    assert.equal(await mod.registerDeviceKey(), "registered");
    assert.equal(fetchCalls, 2);
    assert.equal(meta.get("device_key_reregister_pending"), "");
    assert.equal((await mod.getDeviceKeyStatus()).reregisterPending, false);
  });

  console.log(`\n${passed} device-key regressions passed; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    for (const [filename, previous] of savedModules) {
      if (previous) require.cache[filename] = previous;
      else delete require.cache[filename];
    }
  });
