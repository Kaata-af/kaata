const assert = require("node:assert/strict");
const { AsyncLocalStorage } = require("node:async_hooks");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { limitCacheStores } = require("./metro-cache-limit.cjs");

test("all stores share the read/write limit and preserve receivers, keys and values", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const value = { code: Buffer.from("unchanged transform") };
  class Store {
    #id;
    constructor(id) {
      this.#id = id;
    }
    async operation(kind, key, received) {
      assert.equal(received, value);
      started.push([this.#id, kind, key]);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return value;
    }
    get(key) {
      return this.operation("get", key, value);
    }
    set(key, received) {
      return this.operation("set", key, received);
    }
    clear() {
      return this.#id;
    }
  }
  const original = [new Store("first"), new Store("second")];
  const stores = limitCacheStores(original);
  const keys = Array.from({ length: 2048 }, (_, n) => Buffer.from(String(n)));
  const results = await Promise.all(
    keys.map((key, n) => (n % 2 ? stores[n % 2].set(key, value) : stores[n % 2].get(key))),
  );
  assert.equal(peak, 32, "limit applies across get, set and separate stores");
  assert.equal(active, 0);
  assert.ok(results.every((result) => result === value));
  assert.deepEqual(
    started.map(([, , key]) => key),
    keys,
    "queued work starts in FIFO order",
  );
  assert.ok(
    started.every(([, , key], n) => key === keys[n]),
    "the exact Buffer keys reach Expo's store",
  );
  assert.equal(stores[0].name, "Store", "Metro diagnostics keep the underlying store name");
  assert.equal(stores[0].clear(), "first", "private-field methods keep their original receiver");
  assert.notEqual(stores, original);
  assert.equal(original[0].constructor, Store, "original configuration objects remain intact");
});

test("synchronous throws and rejected promises release the queue without swallowing errors", async () => {
  const syncError = new Error("sync cache failure");
  const asyncError = new Error("async cache failure");
  const store = Object.freeze({
    name: "test-cache",
    get(key) {
      if (key === "sync") throw syncError;
      if (key === "async") return Promise.reject(asyncError);
      return key === "miss" ? null : key;
    },
    set(_key, value) {
      return value;
    },
    clear() {
      return undefined;
    },
  });
  const [limited] = limitCacheStores([store], 1);
  const results = await Promise.allSettled([
    limited.get("sync"),
    limited.get("async"),
    limited.get("miss"),
    limited.set("key", "saved"),
  ]);
  assert.equal(results[0].reason, syncError);
  assert.equal(results[1].reason, asyncError);
  assert.deepEqual(results.slice(2), [
    { status: "fulfilled", value: null },
    { status: "fulfilled", value: "saved" },
  ]);
  assert.equal(await limited.get("after failures"), "after failures");
  assert.equal(limited.name, "test-cache");
  assert.equal(limited.clear(), undefined);
});

test("queued operations retain their graph's async context", async () => {
  const context = new AsyncLocalStorage();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const [store] = limitCacheStores(
    [
      {
        async get(key) {
          if (key === "first") await gate;
          return context.getStore();
        },
        set() {},
        clear() {},
      },
    ],
    1,
  );
  const first = context.run("first graph", () => store.get("first"));
  const second = context.run("second graph", () => store.get("second"));
  release();
  assert.deepEqual(await Promise.all([first, second]), ["first graph", "second graph"]);
});

test("lazy factories retain this and arguments, store order, clear behavior and empty configuration", async () => {
  const reset = Promise.resolve();
  const original = {
    get: () => null,
    set() {},
    clear() {
      assert.equal(this, original);
      return reset;
    },
  };
  const other = { get: () => null, set() {}, clear() {} };
  const context = {};
  const metroCache = {};
  let calls = 0;
  const factory = limitCacheStores(function (argument) {
    assert.equal(this, context);
    assert.equal(argument, metroCache);
    calls++;
    return [original, other];
  });
  assert.equal(calls, 0, "Metro controls when its factory runs");
  const stores = factory.call(context, metroCache);
  assert.equal(calls, 1);
  assert.equal(stores[0].clear(), reset, "async clear promise is returned unchanged");
  assert.equal(
    factory.call(context, metroCache)[0],
    stores[0],
    "one underlying store keeps one adapter identity",
  );
  assert.deepEqual(limitCacheStores([]), []);
  const error = new Error("factory error");
  assert.throws(
    () =>
      limitCacheStores(() => {
        throw error;
      })(),
    (received) => received === error,
  );
  for (const value of [0, -1, NaN, 1.5])
    assert.throws(() => limitCacheStores([], value), RangeError);
});

test("actual Metro config applies the limiter only on Windows and retains existing bounds", async () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    let active = 0;
    let peak = 0;
    const originals = [
      {
        async get() {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setImmediate(resolve));
          active--;
          return null;
        },
        set() {},
        clear() {},
      },
    ];
    const config = {
      watchFolders: [],
      cacheStores: originals,
      maxWorkers: 8,
      transformer: { unstable_workerThreads: true },
      watcher: { unstable_lazySha1: true },
      resolver: { blockList: /existing-block/ },
    };
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(path.join(__dirname, "../metro.config.js"), "utf8"), {
      module,
      __dirname: path.resolve(__dirname, ".."),
      process: { platform },
      require(name) {
        if (name === "expo/metro-config") return { getDefaultConfig: () => config };
        if (name === "node:path") return path;
        if (name === "./scripts/metro-cache-limit.cjs") return { limitCacheStores };
        throw new Error("Unexpected config dependency: " + name);
      },
    });
    await Promise.all(
      Array.from({ length: 96 }, () => config.cacheStores[0].get(Buffer.from("key"))),
    );
    if (platform === "win32") {
      assert.equal(peak, 32);
      assert.notEqual(config.cacheStores, originals);
      assert.equal(config.maxWorkers, 2);
      assert.equal(config.transformer.unstable_workerThreads, false);
      assert.equal(config.watcher.unstable_lazySha1, false);
    } else {
      assert.equal(config.cacheStores, originals);
      assert.equal(peak, 96);
      assert.equal(config.maxWorkers, 8);
    }
    assert.equal(config.resolver.blockList[0].source, "existing-block");
    assert.ok(config.watchFolders.some((folder) => folder.endsWith("_shared")));
  }
});
