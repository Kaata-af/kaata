// Synthetic hardware/storage/accessibility only. No real device or ledger IO.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

type Motion = typeof import("../motion-preference");
const GIB = 1024 ** 3;

function fixture({
  platform = "android",
  hardware = { totalMemoryBytes: 6 * GIB, lowRamDevice: false } as any,
  pref = null as string | null,
  hardwarePromise,
  prefPromise,
  osPromise,
  manualTimers = false,
}: {
  platform?: string;
  hardware?: unknown;
  pref?: string | null;
  hardwarePromise?: Promise<any>;
  prefPromise?: Promise<string | null>;
  osPromise?: Promise<boolean>;
  manualTimers?: boolean;
} = {}) {
  let subscribe!: (fn: () => void) => () => void;
  let hardwareReads = 0,
    prefReads = 0,
    osReads = 0,
    notifications = 0;
  const listeners = new Map<string, (value: boolean) => void>();
  const timers = new Set<() => void>();
  let systemPromise = osPromise;
  const writes: { mode: string; result: ReturnType<typeof deferred<void>> }[] = [];
  const api = compileUI(
    "../motion-preference",
    {
      react: {
        useSyncExternalStore: (sub: typeof subscribe, get: () => unknown) => {
          subscribe = sub;
          return get();
        },
      },
      "react-native": {
        Platform: { OS: platform },
        AccessibilityInfo: {
          isReduceMotionEnabled: () => {
            osReads++;
            return systemPromise ?? Promise.resolve(false);
          },
          addEventListener: (name: string, callback: (value: boolean) => void) => {
            assert.equal(listeners.size, 0, "One shared OS listener is sufficient");
            listeners.set(name, callback);
            return { remove: () => listeners.delete(name) };
          },
        },
      },
      "../modules/kaata-save-file": {
        getMotionHardware: () => {
          hardwareReads++;
          return hardwarePromise ?? Promise.resolve(hardware);
        },
      },
      "./db": {
        getAppMeta: (key: string) => {
          assert.equal(key, "motion_pref");
          prefReads++;
          return prefPromise ?? Promise.resolve(pref);
        },
        setAppMeta: (key: string, mode: string) => {
          assert.equal(key, "motion_pref");
          const result = deferred<void>();
          writes.push({ mode, result });
          return result.promise;
        },
      },
    },
    manualTimers
      ? {
          setTimeout: (callback: () => void, delay: number) => {
            assert.equal(delay, 750, "Optional lookups cannot hold startup indefinitely");
            timers.add(callback);
            return callback;
          },
          clearTimeout: (callback?: () => void) => {
            if (callback) timers.delete(callback);
          },
        }
      : {},
  ) as Motion;
  api.useMotionPreference();
  const start = () => subscribe(() => notifications++);
  return {
    api,
    start,
    listeners,
    writes,
    setOsPromise: (value: Promise<boolean>) => {
      systemPromise = value;
    },
    expireLookups: async () => {
      await settleUI();
      for (const callback of [...timers]) {
        timers.delete(callback);
        callback();
      }
      await settleUI();
    },
    get reads() {
      return { hardwareReads, prefReads, osReads };
    },
    get notifications() {
      return notifications;
    },
    snapshot: () => api.getMotionPreferenceSnapshot(),
  };
}

async function main() {
  const base = fixture();
  const low = base.api.isLowEndMotionHardware;
  for (const platform of ["android", "ios"]) {
    for (const memory of [null, 0, -1, NaN, Infinity, "2GB"]) {
      assert.equal(low(platform, { totalMemoryBytes: memory, lowRamDevice: null } as any), false);
    }
  }
  assert.equal(low("android", { totalMemoryBytes: 3 * GIB, lowRamDevice: false }), true);
  assert.equal(low("android", { totalMemoryBytes: 3 * GIB + 1, lowRamDevice: false }), false);
  assert.equal(low("android", { totalMemoryBytes: 8 * GIB, lowRamDevice: true }), true);
  assert.equal(low("ios", { totalMemoryBytes: 2 * GIB, lowRamDevice: null }), true);
  assert.equal(low("ios", { totalMemoryBytes: 3 * GIB, lowRamDevice: true }), false);
  assert.equal(low("web", { totalMemoryBytes: GIB, lowRamDevice: true }), false);
  for (const value of [null, undefined, "unknown", "FULL", 42, {}])
    assert.equal(base.api.parseMotionMode(value), "auto");
  assert.equal(
    base.snapshot().effectiveReducedMotion,
    true,
    "Before bounded startup checks, decorative motion stays quiet",
  );
  const stop = base.start(),
    stopSecond = base.start();
  await base.api.initializeMotionPreference();
  assert.equal(base.snapshot().effectiveReducedMotion, false);
  assert.equal(base.snapshot().initialized, true);
  assert.equal(base.reads.hardwareReads, 1);
  assert.equal(base.reads.prefReads, 1);
  assert.equal(base.listeners.size, 1);
  const stable = base.snapshot();
  await base.api.initializeMotionPreference();
  assert.equal(base.snapshot(), stable, "Unchanged external-store snapshots retain identity");
  assert.equal(base.reads.hardwareReads, 1);
  assert.equal(base.reads.prefReads, 1);
  stop();
  assert.equal(base.listeners.size, 1);
  stopSecond();
  assert.equal(base.listeners.size, 0);
  assert.equal(base.snapshot().effectiveReducedMotion, true);
  const stopRemount = base.start();
  await settleUI();
  assert.equal(base.snapshot().effectiveReducedMotion, false);
  assert.equal(base.reads.hardwareReads, 1);
  assert.equal(base.reads.prefReads, 1);
  stopRemount();

  const small = fixture({ hardware: { totalMemoryBytes: 2.8 * GIB, lowRamDevice: false } });
  const stopSmall = small.start();
  await small.api.initializeMotionPreference();
  assert.equal(small.snapshot().lowEndDevice, true);
  assert.equal(small.snapshot().effectiveReducedMotion, true);
  const full = small.api.setMotionMode("full");
  await settleUI();
  assert.equal(small.snapshot().mode, "full");
  assert.equal(small.snapshot().effectiveReducedMotion, false);
  small.writes[0].result.resolve();
  await full;
  small.listeners.get("reduceMotionChanged")!(true);
  assert.equal(
    small.snapshot().effectiveReducedMotion,
    true,
    "Full never overrides the user's system Reduce Motion",
  );
  small.listeners.get("reduceMotionChanged")!(false);
  assert.equal(small.snapshot().effectiveReducedMotion, false);
  stopSmall();

  const lateOs = deferred<boolean>();
  const raced = fixture({ osPromise: lateOs.promise });
  const stopRace = raced.start();
  raced.listeners.get("reduceMotionChanged")!(true);
  lateOs.resolve(false);
  await raced.api.initializeMotionPreference();
  assert.equal(
    raced.snapshot().systemReducedMotion,
    true,
    "Late OS read cannot overwrite a newer accessibility event",
  );
  stopRace();

  const pref = deferred<string | null>();
  const delayed = fixture({ prefPromise: pref.promise });
  const stopDelayed = delayed.start();
  const changed = delayed.api.setMotionMode("full");
  assert.equal(
    delayed.snapshot().mode,
    "full",
    "Mode changes immediately while startup IO is pending",
  );
  pref.resolve("reduced");
  await delayed.api.initializeMotionPreference();
  await settleUI();
  assert.equal(
    delayed.snapshot().mode,
    "full",
    "Late stored preference cannot replace a newer choice",
  );
  delayed.writes[0].result.reject(new Error("synthetic write failure"));
  await assert.rejects(changed);
  assert.equal(
    delayed.snapshot().mode,
    "reduced",
    "Failed choice returns to the actual persisted starting preference",
  );
  assert.equal(delayed.snapshot().saving, false);
  stopDelayed();

  const lateStored = deferred<string | null>();
  const storedAfterTimeout = fixture({ prefPromise: lateStored.promise, manualTimers: true });
  const stopStoredAfterTimeout = storedAfterTimeout.start();
  await storedAfterTimeout.expireLookups();
  await storedAfterTimeout.api.initializeMotionPreference();
  assert.equal(storedAfterTimeout.snapshot().initialized, true);
  assert.equal(storedAfterTimeout.snapshot().mode, "auto");
  lateStored.resolve("reduced");
  await settleUI();
  assert.equal(
    storedAfterTimeout.snapshot().mode,
    "reduced",
    "A stored Reduced choice still applies after the bounded startup wait",
  );
  assert.equal(storedAfterTimeout.snapshot().effectiveReducedMotion, true);
  assert.equal(storedAfterTimeout.reads.prefReads, 1);
  stopStoredAfterTimeout();

  const obsoleteStored = deferred<string | null>();
  const savedBeforeRead = fixture({ prefPromise: obsoleteStored.promise, manualTimers: true });
  const stopSavedBeforeRead = savedBeforeRead.start();
  await savedBeforeRead.expireLookups();
  const savedFull = savedBeforeRead.api.setMotionMode("full");
  await settleUI();
  savedBeforeRead.writes[0].result.resolve();
  await savedFull;
  obsoleteStored.resolve("reduced");
  await settleUI();
  assert.equal(
    savedBeforeRead.snapshot().mode,
    "full",
    "A late stored value cannot replace a successful explicit write",
  );
  assert.equal(savedBeforeRead.snapshot().effectiveReducedMotion, false);
  // A subsequent failure must also retain the successful write as its rollback
  // target, rather than the obsolete initial value that just finished reading.
  const failedAfterSaved = savedBeforeRead.api.setMotionMode("auto");
  const rejectedAfterSaved = assert.rejects(failedAfterSaved);
  await settleUI();
  savedBeforeRead.writes[1].result.reject(new Error("synthetic later write failure"));
  await rejectedAfterSaved;
  assert.equal(savedBeforeRead.snapshot().mode, "full");
  stopSavedBeforeRead();

  for (const readOrder of ["before failure", "after failure", "alongside failure"] as const) {
    const persisted = deferred<string | null>();
    const lateRollback = fixture({ prefPromise: persisted.promise, manualTimers: true });
    const stopLateRollback = lateRollback.start();
    await lateRollback.expireLookups();
    const optimisticFull = lateRollback.api.setMotionMode("full");
    const rejectedFull = assert.rejects(optimisticFull);
    await settleUI();
    if (readOrder === "before failure") {
      persisted.resolve("reduced");
      await settleUI();
      assert.equal(lateRollback.snapshot().mode, "full", "A pending explicit choice stays visible");
      assert.equal(lateRollback.snapshot().saving, true);
    }
    lateRollback.writes[0].result.reject(new Error("synthetic optimistic write failure"));
    if (readOrder === "alongside failure") persisted.resolve("reduced");
    await rejectedFull;
    if (readOrder === "after failure") {
      assert.equal(lateRollback.snapshot().mode, "auto");
      persisted.resolve("reduced");
    }
    await settleUI();
    assert.equal(
      lateRollback.snapshot().mode,
      "reduced",
      `Late persisted mode restores the durable choice when read ${readOrder}`,
    );
    assert.equal(lateRollback.snapshot().effectiveReducedMotion, true);
    assert.equal(lateRollback.snapshot().saving, false);
    stopLateRollback();
  }

  const queued = fixture();
  const stopQueued = queued.start();
  await queued.api.initializeMotionPreference();
  const first = queued.api.setMotionMode("full"),
    second = queued.api.setMotionMode("reduced");
  const failedFirst = assert.rejects(first),
    failedSecond = assert.rejects(second);
  await settleUI();
  assert.equal(queued.writes.length, 1);
  queued.writes[0].result.reject(new Error("first failed"));
  await failedFirst;
  await settleUI();
  assert.equal(queued.snapshot().mode, "reduced", "Older failure cannot undo the latest intent");
  assert.equal(queued.writes.length, 2);
  queued.writes[1].result.reject(new Error("second failed"));
  await failedSecond;
  assert.equal(
    queued.snapshot().mode,
    "auto",
    "Two failures return to last confirmed mode, not failed optimistic Full",
  );
  assert.equal(queued.snapshot().saving, false);
  const good = queued.api.setMotionMode("full");
  await settleUI();
  queued.writes[2].result.resolve();
  await good;
  const bad = queued.api.setMotionMode("auto");
  const failure = assert.rejects(bad);
  await settleUI();
  queued.writes[3].result.reject(new Error("latest failed"));
  await failure;
  assert.equal(
    queued.snapshot().mode,
    "full",
    "A successful earlier write is the durable rollback target",
  );
  const invalid = queued.api.setMotionMode("anything" as any);
  await assert.rejects(invalid);
  assert.equal(queued.writes.length, 4);
  stopQueued();

  for (const value of [true, false]) {
    const os = deferred<boolean>();
    const timed = fixture({ osPromise: os.promise, manualTimers: true });
    const stopTimed = timed.start();
    await timed.expireLookups();
    await timed.api.initializeMotionPreference();
    assert.equal(timed.snapshot().initialized, true, "OS timeout cannot block startup");
    assert.equal(
      timed.snapshot().effectiveReducedMotion,
      true,
      "An unresolved OS setting never means animations are allowed",
    );
    os.resolve(value);
    await settleUI();
    assert.equal(timed.snapshot().systemReducedMotion, value);
    assert.equal(
      timed.snapshot().effectiveReducedMotion,
      value,
      "A late boolean OS setting still applies within its subscription",
    );
    stopTimed();
  }

  const failedOs = deferred<boolean>();
  const failedRead = fixture({ osPromise: failedOs.promise, manualTimers: true });
  const stopFailed = failedRead.start();
  failedOs.reject(new Error("synthetic accessibility lookup failure"));
  await failedRead.api.initializeMotionPreference();
  assert.equal(failedRead.snapshot().initialized, true);
  assert.equal(
    failedRead.snapshot().effectiveReducedMotion,
    true,
    "An OS lookup error keeps animations reduced",
  );
  failedRead.listeners.get("reduceMotionChanged")!(false);
  assert.equal(failedRead.snapshot().effectiveReducedMotion, false);
  stopFailed();

  for (const eventValue of [true, false]) {
    const late = deferred<boolean>();
    const afterTimeout = fixture({ osPromise: late.promise, manualTimers: true });
    const stopAfterTimeout = afterTimeout.start();
    await afterTimeout.expireLookups();
    afterTimeout.listeners.get("reduceMotionChanged")!(eventValue);
    late.resolve(!eventValue);
    await settleUI();
    assert.equal(
      afterTimeout.snapshot().effectiveReducedMotion,
      eventValue,
      "An accessibility event supersedes a read even after its startup timeout",
    );
    stopAfterTimeout();
  }

  const obsoleteOs = deferred<boolean>();
  const remounted = fixture({ osPromise: obsoleteOs.promise, manualTimers: true });
  const stopBeforeRemount = remounted.start();
  const obsoleteEvent = remounted.listeners.get("reduceMotionChanged")!;
  await remounted.expireLookups();
  stopBeforeRemount();
  const currentOs = deferred<boolean>();
  remounted.setOsPromise(currentOs.promise);
  const stopAfterRemount = remounted.start();
  obsoleteOs.resolve(false);
  obsoleteEvent(false);
  await settleUI();
  assert.equal(
    remounted.snapshot().effectiveReducedMotion,
    true,
    "A removed subscription's event and lookup cannot enable motion after remount",
  );
  currentOs.resolve(false);
  await settleUI();
  assert.equal(remounted.snapshot().effectiveReducedMotion, false);
  obsoleteEvent(true);
  await settleUI();
  assert.equal(
    remounted.snapshot().effectiveReducedMotion,
    false,
    "A removed subscription cannot overwrite the current OS setting",
  );
  assert.equal(remounted.reads.osReads, 2);
  stopAfterRemount();

  for (const mode of ["auto", "full", "reduced"] as const) {
    const lateHardware = deferred<any>();
    const slowHardware = fixture({
      hardwarePromise: lateHardware.promise,
      pref: mode,
      manualTimers: true,
    });
    const stopSlowHardware = slowHardware.start();
    await slowHardware.expireLookups();
    await slowHardware.api.initializeMotionPreference();
    assert.equal(slowHardware.snapshot().initialized, true);
    assert.equal(slowHardware.snapshot().lowEndDevice, false);
    assert.equal(slowHardware.snapshot().effectiveReducedMotion, mode === "reduced");
    lateHardware.resolve({ totalMemoryBytes: 2 * GIB, lowRamDevice: false });
    await settleUI();
    assert.equal(slowHardware.snapshot().lowEndDevice, true);
    assert.equal(slowHardware.snapshot().mode, mode, "Late hardware cannot replace a chosen mode");
    assert.equal(slowHardware.snapshot().effectiveReducedMotion, mode !== "full");
    assert.equal(slowHardware.reads.hardwareReads, 1, "Hardware classification remains one-shot");
    stopSlowHardware();
  }

  const neverSettles = deferred<any>();
  const allUnavailable = fixture({
    hardwarePromise: neverSettles.promise,
    prefPromise: neverSettles.promise,
    osPromise: neverSettles.promise,
    manualTimers: true,
  });
  const stopUnavailable = allUnavailable.start();
  await allUnavailable.expireLookups();
  await allUnavailable.api.initializeMotionPreference();
  assert.equal(allUnavailable.snapshot().initialized, true);
  assert.equal(allUnavailable.snapshot().effectiveReducedMotion, true);
  assert.equal(allUnavailable.snapshot().mode, "auto");
  stopUnavailable();

  for (const [platform, native, expected] of [
    ["android", {}, null],
    [
      "ios",
      { getMotionHardware: async () => ({ totalMemoryBytes: 2 * GIB, lowRamDevice: null }) },
      { totalMemoryBytes: 2 * GIB, lowRamDevice: null },
    ],
    [
      "android",
      { getMotionHardware: async () => ({ totalMemoryBytes: NaN, lowRamDevice: "yes" }) },
      { totalMemoryBytes: null, lowRamDevice: null },
    ],
    [
      "web",
      {
        getMotionHardware: () => {
          throw Error("must not read");
        },
      },
      null,
    ],
  ] as const) {
    const wrapper = compileUI("../../modules/kaata-save-file/src/index", {
      "react-native": { Platform: { OS: platform } },
      "expo-modules-core": { requireNativeModule: () => native },
    }) as typeof import("../../modules/kaata-save-file");
    assert.deepEqual(await wrapper.getMotionHardware(), expected);
  }
  const missing = compileUI("../../modules/kaata-save-file/src/index", {
    "react-native": { Platform: { OS: "android" } },
    "expo-modules-core": {
      requireNativeModule: () => {
        throw Error("Expo Go missing custom native module");
      },
    },
  }) as typeof import("../../modules/kaata-save-file");
  assert.equal(await missing.getMotionHardware(), null);
  console.log(
    "PASS motion policy: bounded shared initialization, late hardware detection, conservative unknown/error OS settings, timeout/event/subscription races, coarse hardware thresholds, manual override, persisted startup races and durable rollback",
  );
}

void main();
