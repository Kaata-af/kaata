// Metro's public cacheStores API accepts adapters or a lazy adapter factory.
// Keep Expo's configured stores; only bound their concurrent cache I/O.
const { AsyncResource } = require("node:async_hooks");

function limitCacheStores(cacheStores, concurrency = 32) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError("Cache concurrency must be a positive integer");

  let active = 0;
  let first = null;
  let last = null;
  const wrappers = new WeakMap();

  function drain() {
    while (active < concurrency && first) {
      const job = first;
      first = job.next;
      if (!first) last = null;
      active++;
      void (async () => {
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        } finally {
          active--;
          drain();
        }
      })();
    }
  }

  function schedule(run) {
    return new Promise((resolve, reject) => {
      // Expo's varying-cache dimensions use async context. A queued operation
      // must keep its caller's context when a different graph frees a slot.
      const job = { run: AsyncResource.bind(run), resolve, reject, next: null };
      if (last) last.next = job;
      else first = job;
      last = job;
      drain();
    });
  }

  function wrapStores(stores) {
    if (!Array.isArray(stores)) throw new TypeError("Metro cacheStores must resolve to an array");
    return stores.map((store) => {
      if (!store || !["get", "set", "clear"].every((method) => typeof store[method] === "function"))
        throw new TypeError("Metro cache store must implement get, set and clear");
      if (!wrappers.has(store)) {
        wrappers.set(store, {
          get name() {
            return store.name ?? store.constructor?.name ?? "CacheStore";
          },
          get(...args) {
            return schedule(() => Reflect.apply(store.get, store, args));
          },
          set(...args) {
            return schedule(() => Reflect.apply(store.set, store, args));
          },
          // Metro resets stores before bundling. Preserve clear's return type
          // and receiver instead of converting a synchronous reset to a queue.
          clear(...args) {
            return Reflect.apply(store.clear, store, args);
          },
        });
      }
      return wrappers.get(store);
    });
  }

  if (typeof cacheStores === "function") {
    return function boundedCacheStores(...args) {
      return wrapStores(Reflect.apply(cacheStores, this, args));
    };
  }
  return wrapStores(cacheStores);
}

module.exports = { limitCacheStores };
