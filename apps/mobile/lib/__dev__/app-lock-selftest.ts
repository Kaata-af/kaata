// Exercise real lock policy with synthetic storage, native prompts and lifecycle.
// No phone credentials, financial database, or actual authentication is accessed.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

type Lock = typeof import("../app-lock");
type AuthResult = { success: true } | { success: false; error: string };
function fixture({
  platform = "android",
  platformVersion = 31 as number | string,
  stored = null as string | null,
  initialState = "active" as string | null,
} = {}) {
  const os = { currentState: initialState };
  const listeners = new Set<(value: any) => void>();
  const retired: ((value: any) => void)[] = [];
  let read = () => Promise.resolve(stored);
  let write = () => Promise.resolve();
  let hardware = true,
    enrolled = true,
    level = 3;
  let capabilityFailure = false,
    nativeMissing = false;
  let levelRead = () => Promise.resolve(level);
  let reads = 0,
    imports = 0,
    hardwareReads = 0,
    cancels = 0;
  const prompts: { options: any; response: ReturnType<typeof deferred<AuthResult>> }[] = [];
  const writes: { value: string; options: any }[] = [];
  const mocks: Record<string, any> = {
    react: { useSyncExternalStore: (_sub: any, get: () => any) => get() },
    "react-native": {
      Platform: { OS: platform, Version: platformVersion },
      AppState: {
        get currentState() {
          return os.currentState;
        },
        addEventListener: (name: string, callback: (value: any) => void) => {
          assert.equal(name, "change");
          assert.equal(listeners.size, 0, "One shared lifecycle subscription");
          listeners.add(callback);
          return {
            remove: () => {
              listeners.delete(callback);
              retired.push(callback);
            },
          };
        },
      },
    },
    "expo-secure-store": {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 12,
      getItemAsync: (key: string) => {
        assert.equal(key, "kaata.app_lock.enabled.v1");
        reads++;
        return read();
      },
      setItemAsync: async (key: string, value: string, options: any) => {
        assert.equal(key, "kaata.app_lock.enabled.v1");
        writes.push({ value, options });
        await write();
        stored = value;
      },
    },
    "./i18n": { t: (key: string) => key },
  };
  Object.defineProperty(mocks, "expo-local-authentication", {
    get: () => {
      imports++;
      if (nativeMissing) throw Error("Native module missing from older binary");
      return {
        hasHardwareAsync: async () => {
          hardwareReads++;
          if (capabilityFailure) throw Error("synthetic capability failure");
          return hardware;
        },
        isEnrolledAsync: async () => enrolled,
        getEnrolledLevelAsync: () => levelRead(),
        authenticateAsync: (options: any) => {
          const response = deferred<AuthResult>();
          prompts.push({ options, response });
          return response.promise;
        },
        cancelAuthenticate: async () => {
          cancels++;
        },
      };
    },
  });
  let now = 0,
    timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const api = compileUI("../app-lock", mocks, {
    Date: { now: () => now },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  }) as Lock;
  return {
    api,
    prompts,
    writes,
    retired,
    listeners,
    snapshot: () => api.getAppLockSnapshot(),
    start: () => api.subscribeAppLock(() => {}),
    state: (value: string) => {
      os.currentState = value;
      for (const callback of [...listeners]) callback(value);
    },
    setCurrentState: (value: string | null) => {
      os.currentState = value;
    },
    advance: async (milliseconds: number) => {
      await settleUI();
      const target = now + milliseconds;
      let count = 0;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        assert.ok(count++ < 500, "Startup rechecks are bounded");
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settleUI();
      }
      now = target;
      await settleUI();
    },
    get pendingTimers() {
      return timers.size;
    },
    setRead: (value: () => Promise<string | null>) => {
      read = value;
    },
    setWrite: (value: () => Promise<void>) => {
      write = value;
    },
    setCapabilities: (value: {
      hardware?: boolean;
      enrolled?: boolean;
      level?: number;
      failure?: boolean;
      missing?: boolean;
    }) => {
      if (value.hardware !== undefined) hardware = value.hardware;
      if (value.enrolled !== undefined) enrolled = value.enrolled;
      if (value.level !== undefined) level = value.level;
      if (value.failure !== undefined) capabilityFailure = value.failure;
      if (value.missing !== undefined) nativeMissing = value.missing;
    },
    setLevelRead: (value: () => Promise<number>) => {
      levelRead = value;
    },
    get counts() {
      return { reads, imports, hardwareReads, cancels };
    },
    get stored() {
      return stored;
    },
  };
}
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 12 && !check(); i++) await settleUI();
  assert.ok(check(), "Expected asynchronous boundary reached");
}

async function main() {
  for (const stored of [null, "0"]) {
    const f = fixture({ stored });
    assert.equal(f.snapshot().initialized, false);
    assert.equal(f.snapshot().locked, true, "Never show content before reading the switch");
    const stop = f.start(),
      second = f.start();
    await f.api.initializeAppLock();
    assert.equal(f.snapshot().initialized, true);
    assert.equal(f.snapshot().enabled, false);
    assert.equal(f.snapshot().locked, false);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.counts.imports, 0, "Default Off never imports or prompts for biometrics");
    assert.equal(f.counts.reads, 1);
    assert.equal(f.listeners.size, 1);
    const snapshot = f.snapshot();
    await f.api.initializeAppLock();
    assert.equal(f.snapshot(), snapshot, "Unchanged snapshots retain identity");
    assert.equal(await f.api.unlockApp(), true);
    assert.equal(await f.api.setAppLockEnabled(false), true);
    assert.equal(f.writes.length, 0);
    stop();
    assert.equal(f.listeners.size, 1);
    second();
    assert.equal(f.listeners.size, 0);
  }

  for (const failure of ["rejected", "synchronous", "corrupt"] as const) {
    const f = fixture();
    f.setRead(() => {
      if (failure === "synchronous") throw Error("synthetic sync read error");
      return failure === "corrupt"
        ? Promise.resolve("garbled")
        : Promise.reject(Error("read error"));
    });
    const stop = f.start();
    await f.api.initializeAppLock();
    assert.equal(f.snapshot().initialized, false);
    assert.equal(f.snapshot().locked, true);
    assert.equal(f.snapshot().error, "storage");
    assert.equal(await f.api.setAppLockEnabled(false), false);
    assert.equal(f.prompts.length, 0);
    f.setRead(() => Promise.resolve(null));
    await f.api.initializeAppLock();
    assert.equal(f.snapshot().initialized, true);
    assert.equal(f.snapshot().locked, false);
    assert.equal(f.snapshot().error, null);
    stop();
  }

  const deferredRead = deferred<string | null>();
  const startup = fixture();
  startup.setRead(() => deferredRead.promise);
  const stopStartup = startup.start();
  const firstRead = startup.api.initializeAppLock();
  assert.equal(startup.api.initializeAppLock(), firstRead);
  deferredRead.resolve("1");
  await firstRead;
  assert.equal(startup.snapshot().enabled, true);
  assert.equal(startup.snapshot().locked, true);
  assert.equal(startup.prompts.length, 0, "Only the gate initiates an automatic unlock");
  stopStartup();

  for (const stateBecomesKnown of ["during-read", "after-read"] as const) {
    const read = deferred<string | null>();
    const f = fixture({ initialState: null });
    f.setRead(() => read.promise);
    const stop = f.start();
    assert.equal(f.snapshot().appState, null);
    if (stateBecomesKnown === "during-read") f.setCurrentState("active");
    read.resolve("1");
    await f.api.initializeAppLock();
    if (stateBecomesKnown === "after-read") {
      assert.equal(f.snapshot().appState, null);
      f.setCurrentState("active");
      await f.advance(50);
    }
    assert.equal(
      f.snapshot().appState,
      "active",
      "RN's cached initial state need not emit a change",
    );
    assert.equal(f.snapshot().locked, true);
    assert.equal(f.snapshot().foregroundVersion, 0);
    assert.equal(f.prompts.length, 0);
    stop();
    assert.equal(
      f.pendingTimers,
      0,
      "Resolved startup reads and initial-state rechecks are cleaned up",
    );
  }

  const unknownState = fixture({ initialState: null, stored: "1" });
  const stopUnknownState = unknownState.start();
  await unknownState.api.initializeAppLock();
  await unknownState.advance(10_000);
  assert.equal(unknownState.snapshot().appState, null);
  assert.equal(unknownState.snapshot().locked, true);
  assert.equal(
    unknownState.pendingTimers,
    0,
    "Initial-state sampling never becomes a recurring poll",
  );
  unknownState.setCurrentState("active");
  await unknownState.api.initializeAppLock();
  assert.equal(
    unknownState.snapshot().appState,
    "active",
    "An explicit retry resamples a later native state",
  );
  stopUnknownState();

  for (const value of ["0", "1", "garbled"] as const) {
    const read = deferred<string | null>();
    const f = fixture();
    f.setRead(() => read.promise);
    const stop = f.start();
    const loading = f.api.initializeAppLock();
    await f.advance(4_999);
    assert.equal(f.snapshot().error, null);
    assert.equal(f.snapshot().initialized, false);
    await f.advance(1);
    await loading;
    assert.equal(f.snapshot().initialized, false, "A read timeout is not a default-Off value");
    assert.equal(f.snapshot().locked, true);
    assert.equal(
      f.snapshot().error,
      "storage",
      "A hung read presents a retryable error instead of an endless spinner",
    );
    read.resolve(value);
    await settleUI();
    if (value === "garbled") {
      assert.equal(f.snapshot().initialized, false);
      assert.equal(f.snapshot().locked, true);
      assert.equal(f.snapshot().error, "storage");
    } else {
      assert.equal(
        f.snapshot().initialized,
        true,
        "A valid late result may resolve the current read attempt",
      );
      assert.equal(f.snapshot().enabled, value === "1");
      assert.equal(f.snapshot().locked, value === "1");
      assert.equal(f.snapshot().error, null);
    }
    assert.equal(f.prompts.length, 0);
    stop();
  }

  for (const oldResult of ["0", "1", "reject"] as const) {
    const first = deferred<string | null>();
    const f = fixture();
    f.setRead(() => first.promise);
    const stop = f.start();
    await f.advance(5_000);
    f.setRead(() => Promise.resolve("1"));
    await f.api.initializeAppLock();
    const accepted = f.snapshot();
    if (oldResult === "reject") first.reject(Error("obsolete read error"));
    else first.resolve(oldResult);
    await settleUI();
    assert.equal(
      f.snapshot(),
      accepted,
      "A retired read cannot override a successful retry or error state",
    );
    assert.equal(f.snapshot().enabled, true);
    assert.equal(f.counts.reads, 2);
    stop();
  }

  const oldPreference = deferred<string | null>();
  const savedAfterRetry = fixture();
  savedAfterRetry.setRead(() => oldPreference.promise);
  const stopSavedAfterRetry = savedAfterRetry.start();
  await savedAfterRetry.advance(5_000);
  savedAfterRetry.setRead(() => Promise.resolve(null));
  await savedAfterRetry.api.initializeAppLock();
  const savedChoice = savedAfterRetry.api.setAppLockEnabled(true);
  await waitFor(() => savedAfterRetry.prompts.length === 1);
  savedAfterRetry.prompts[0].response.resolve({ success: true });
  assert.equal(await savedChoice, true);
  oldPreference.resolve("0");
  await settleUI();
  assert.equal(
    savedAfterRetry.snapshot().enabled,
    true,
    "A saved enable cannot be undone by a pre-timeout read",
  );
  assert.equal(savedAfterRetry.snapshot().locked, false);
  stopSavedAfterRetry();

  const web = fixture({ platform: "web", stored: "1" });
  web.setCapabilities({ missing: true });
  const stopWeb = web.start();
  await web.api.initializeAppLock();
  await web.api.refreshAppLockCapability();
  assert.equal(web.snapshot().initialized, true);
  assert.equal(web.snapshot().locked, false);
  assert.equal(web.snapshot().enabled, false);
  assert.equal(web.snapshot().capability, "no_hardware");
  assert.equal(await web.api.setAppLockEnabled(true), false);
  assert.equal(web.counts.reads + web.counts.imports, 0);
  stopWeb();

  const change = fixture();
  const stopChange = change.start();
  await change.api.initializeAppLock();
  const enabling = change.api.setAppLockEnabled(true);
  assert.equal(change.api.setAppLockEnabled(true), enabling, "Duplicate intent shares one prompt");
  assert.equal(
    await change.api.unlockApp(),
    false,
    "Another operation cannot adopt enable success",
  );
  await waitFor(() => change.prompts.length === 1);
  assert.equal(change.snapshot().busy, true);
  assert.equal(change.snapshot().enabled, false);
  assert.equal(change.writes.length, 0, "Never persist an enable before native success");
  assert.deepEqual(change.prompts[0].options, {
    promptMessage: "appLock.auth.enable",
    cancelLabel: "common.cancel",
    fallbackLabel: "appLock.auth.passcode",
    disableDeviceFallback: false,
    biometricsSecurityLevel: "strong",
    requireConfirmation: true,
  });
  change.prompts[0].response.resolve({ success: true });
  assert.equal(await enabling, true);
  assert.equal(change.snapshot().enabled, true);
  assert.equal(change.snapshot().locked, false);
  assert.equal(change.snapshot().busy, false);
  assert.equal(change.stored, "1");
  assert.deepEqual(change.writes[0], { value: "1", options: { keychainAccessible: 12 } });
  const cancelledDisable = change.api.setAppLockEnabled(false);
  await waitFor(() => change.prompts.length === 2);
  change.prompts[1].response.resolve({ success: false, error: "user_cancel" });
  assert.equal(await cancelledDisable, false);
  assert.equal(change.snapshot().enabled, true);
  assert.equal(change.snapshot().error, null);
  assert.equal(change.writes.length, 1);
  const disabling = change.api.setAppLockEnabled(false);
  await waitFor(() => change.prompts.length === 3);
  change.prompts[2].response.resolve({ success: true });
  assert.equal(await disabling, true);
  assert.equal(change.stored, "0");
  assert.equal(change.snapshot().locked, false);
  stopChange();

  for (const [platform, platformVersion, fallback] of [
    ["android", 29, false],
    ["android", 30, true],
    ["android", 31, true],
    ["android", "29", false],
    ["android", "unknown", false],
    ["android", NaN, false],
    ["android", Infinity, false],
    ["ios", "16.4", true],
  ] as const) {
    const f = fixture({ platform, platformVersion, stored: "1" });
    const stop = f.start();
    await f.api.initializeAppLock();
    assert.equal(f.api.supportsAppLockDeviceFallback(), fallback);
    const auth = f.api.unlockApp();
    await waitFor(() => f.prompts.length === 1);
    assert.equal(f.prompts[0].options.biometricsSecurityLevel, "strong");
    assert.equal(f.prompts[0].options.disableDeviceFallback, !fallback);
    f.state("background");
    assert.equal(await auth, false);
    f.prompts[0].response.resolve({ success: true });
    await settleUI();
    assert.equal(
      f.snapshot().locked,
      true,
      "Every OS rejects an obsolete success after background",
    );
    stop();
  }

  for (const [capabilities, capability, error] of [
    [{ hardware: false }, "no_hardware", "unavailable"],
    [{ enrolled: false }, "not_enrolled", "not_enrolled"],
    [{ level: 2 }, "weak", "weak"],
    [{ level: NaN }, "weak", "weak"],
    [{ level: Infinity }, "weak", "weak"],
    [{ level: 4 }, "weak", "weak"],
    [{ failure: true }, "unavailable", "unavailable"],
    [{ missing: true }, "unavailable", "unavailable"],
  ] as const) {
    const f = fixture();
    const stop = f.start();
    await f.api.initializeAppLock();
    f.setCapabilities(capabilities);
    assert.equal(await f.api.setAppLockEnabled(true), false);
    assert.equal(f.snapshot().capability, capability);
    assert.equal(f.snapshot().error, error);
    assert.equal(f.snapshot().enabled, false);
    assert.equal(f.prompts.length + f.writes.length, 0);
    stop();
  }

  const capabilities = fixture();
  const level = deferred<number>();
  capabilities.setLevelRead(() => level.promise);
  const stopCapabilities = capabilities.start();
  await capabilities.api.initializeAppLock();
  const cap = capabilities.api.refreshAppLockCapability();
  assert.equal(capabilities.api.refreshAppLockCapability(), cap);
  await waitFor(() => capabilities.counts.hardwareReads === 1);
  level.resolve(3);
  await cap;
  assert.equal(capabilities.snapshot().capability, "available");
  assert.equal(capabilities.prompts.length, 0);
  stopCapabilities();

  for (const enabling of [true, false]) {
    const f = fixture({ stored: enabling ? null : "1" });
    const stop = f.start();
    await f.api.initializeAppLock();
    f.setWrite(() => Promise.reject(Error("synthetic write failure")));
    const action = f.api.setAppLockEnabled(enabling);
    await waitFor(() => f.prompts.length === 1);
    f.prompts[0].response.resolve({ success: true });
    assert.equal(await action, false);
    assert.equal(f.snapshot().enabled, !enabling);
    assert.equal(f.snapshot().error, "storage");
    assert.equal(f.snapshot().busy, false);
    f.state("background");
    assert.equal(f.snapshot().locked, !enabling);
    stop();
  }

  const unlock = fixture({ stored: "1", platform: "ios" });
  const stopUnlock = unlock.start();
  await unlock.api.initializeAppLock();
  const failed = unlock.api.unlockApp();
  await waitFor(() => unlock.prompts.length === 1);
  unlock.prompts[0].response.resolve({ success: false, error: "authentication_failed" });
  assert.equal(await failed, false);
  assert.equal(unlock.snapshot().locked, true);
  assert.equal(unlock.snapshot().error, "authentication");
  const valid = unlock.api.unlockApp();
  await waitFor(() => unlock.prompts.length === 2);
  unlock.state("inactive");
  unlock.prompts[1].response.resolve({ success: true });
  await settleUI();
  assert.equal(unlock.snapshot().locked, true, "Inactive prompt success waits for foreground");
  assert.equal(unlock.snapshot().busy, true);
  unlock.state("active");
  assert.equal(await valid, true);
  assert.equal(unlock.snapshot().locked, false);
  assert.equal(
    unlock.snapshot().foregroundVersion,
    0,
    "Own prompt inactivity is not a resume cycle",
  );
  unlock.state("inactive");
  assert.equal(unlock.snapshot().appState, "inactive", "The gate can hide previews independently");
  unlock.state("background");
  assert.equal(unlock.snapshot().locked, true);
  unlock.state("inactive");
  unlock.state("active");
  assert.equal(unlock.snapshot().foregroundVersion, 1);
  assert.equal(
    unlock.prompts.length,
    2,
    "Store never re-prompts automatically after cancellation/resume",
  );
  stopUnlock();

  const stale = fixture({ stored: "1" });
  const stopStale = stale.start();
  await stale.api.initializeAppLock();
  const old = stale.api.unlockApp();
  await waitFor(() => stale.prompts.length === 1);
  stale.state("background");
  assert.equal(await old, false);
  assert.equal(stale.snapshot().busy, false);
  stale.state("active");
  const fresh = stale.api.unlockApp();
  await settleUI();
  assert.equal(
    stale.prompts.length,
    1,
    "Wait for an old native prompt to drain before replacing it",
  );
  stale.prompts[0].response.resolve({ success: true });
  await waitFor(() => stale.prompts.length === 2);
  assert.equal(stale.snapshot().locked, true, "A late success after background cannot unlock");
  assert.equal(stale.counts.cancels, 1);
  stale.prompts[1].response.resolve({ success: true });
  assert.equal(await fresh, true);
  assert.equal(stale.snapshot().locked, false);
  const oldCallback = [...stale.listeners][0];
  stopStale();
  assert.equal(stale.snapshot().locked, true, "Unmounted gates do not retain an unlocked session");
  const stopRemount = stale.start();
  const beforeStaleEvent = stale.snapshot();
  oldCallback("background");
  assert.equal(
    stale.snapshot(),
    beforeStaleEvent,
    "Removed lifecycle callbacks cannot mutate the new session",
  );
  stopRemount();

  const setup = fixture();
  const pendingLevel = deferred<number>();
  setup.setLevelRead(() => pendingLevel.promise);
  const stopSetup = setup.start();
  await setup.api.initializeAppLock();
  const pendingEnable = setup.api.setAppLockEnabled(true);
  await waitFor(() => setup.counts.hardwareReads === 1);
  setup.state("background");
  assert.equal(await pendingEnable, false);
  pendingLevel.resolve(3);
  await settleUI();
  assert.equal(
    setup.prompts.length + setup.writes.length,
    0,
    "A late preflight cannot open auth in the background",
  );
  stopSetup();

  const persistence = fixture();
  const pendingWrite = deferred<void>();
  persistence.setWrite(() => pendingWrite.promise);
  const stopPersistence = persistence.start();
  await persistence.api.initializeAppLock();
  const savingEnable = persistence.api.setAppLockEnabled(true);
  await waitFor(() => persistence.prompts.length === 1);
  persistence.prompts[0].response.resolve({ success: true });
  await waitFor(() => persistence.writes.length === 1);
  persistence.state("background");
  persistence.state("active");
  pendingWrite.resolve();
  assert.equal(await savingEnable, true);
  assert.equal(persistence.snapshot().enabled, true);
  assert.equal(
    persistence.snapshot().locked,
    true,
    "An authenticated save completing after leaving does not unlock",
  );
  stopPersistence();

  const recovery = fixture({ stored: "1" });
  const stopRecovery = recovery.start();
  await recovery.api.initializeAppLock();
  recovery.setCapabilities({ hardware: false, enrolled: false, level: 1 });
  await recovery.api.refreshAppLockCapability();
  assert.equal(
    recovery.snapshot().enabled,
    true,
    "Removing biometrics never disables an existing lock",
  );
  const credentialUnlock = recovery.api.unlockApp();
  await waitFor(() => recovery.prompts.length === 1);
  recovery.prompts[0].response.resolve({ success: true });
  assert.equal(await credentialUnlock, true);
  const credentialDisable = recovery.api.setAppLockEnabled(false);
  await waitFor(() => recovery.prompts.length === 2);
  recovery.prompts[1].response.resolve({ success: true });
  assert.equal(await credentialDisable, true);
  assert.equal(recovery.stored, "0");
  stopRecovery();

  for (const error of ["user_cancel", "app_cancel", "system_cancel", "lockout", "not_available"]) {
    const f = fixture({ stored: "1" });
    const stop = f.start();
    await f.api.initializeAppLock();
    const action = f.api.unlockApp();
    await waitFor(() => f.prompts.length === 1);
    f.prompts[0].response.resolve({ success: false, error });
    assert.equal(await action, false);
    assert.equal(f.snapshot().locked, true);
    assert.equal(
      f.snapshot().error,
      error === "lockout" ? "lockout" : error === "not_available" ? "unavailable" : null,
    );
    assert.equal(f.snapshot().busy, false);
    assert.equal(f.prompts.length, 1);
    stop();
  }
  console.log(
    "PASS app lock: default Off and device-only durability, fail-closed startup/retry, strong enrollment, authenticated enable/disable, single-flight prompts, cancellation/error recovery, inactive privacy, foreground/background/unmount races, stale native results and credential fallback",
  );
}

void main();
