import { useSyncExternalStore } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import * as SecureStore from "expo-secure-store";
import { t } from "./i18n";
import {
  supportsDevicePasscode,
  authenticateWithDevicePasscode,
  cancelDevicePasscode,
} from "./device-passcode";

export const APP_LOCK_KEY = "kaata.app_lock.enabled.v1";
export type AppLockCapability =
  | "unknown"
  | "available"
  | "no_hardware"
  | "not_enrolled"
  | "weak"
  | "unavailable";
export type AppLockError =
  | "storage"
  | "unavailable"
  | "not_enrolled"
  | "weak"
  | "authentication"
  | "lockout";
export type AppLockSnapshot = {
  initialized: boolean;
  enabled: boolean;
  locked: boolean;
  busy: boolean;
  error: AppLockError | null;
  capability: AppLockCapability;
  appState: AppStateStatus | null;
  /** Only an actual background/foreground cycle permits another automatic try. */
  foregroundVersion: number;
};

const mobile = Platform.OS === "android" || Platform.OS === "ios";
const INITIAL_READ_TIMEOUT_MS = 5_000;
const INITIAL_STATE_RECHECK_MS = 50;
/** Older Android cannot combine strong biometrics with a credential fallback. */
export function supportsAppLockDeviceFallback() {
  const sdk = Number(Platform.Version);
  return Platform.OS === "ios" || (Platform.OS === "android" && Number.isInteger(sdk) && sdk >= 30);
}
/** A dedicated iPhone passcode prompt needs the installed native adapter. */
export function canUseAppLockPasscode() {
  return Platform.OS === "ios" && supportsDevicePasscode();
}
const normalizeAppState = (value: unknown): AppStateStatus | null =>
  value === "active" || value === "inactive" || value === "background" ? value : null;
let snapshot: AppLockSnapshot = {
  initialized: !mobile,
  enabled: false,
  locked: mobile,
  busy: false,
  error: null,
  capability: mobile ? "unknown" : "no_hardware",
  appState: normalizeAppState(AppState.currentState),
  foregroundVersion: 0,
};
const listeners = new Set<() => void>();
let initialization: Promise<void> | null = null;
let readVersion = 0;
let subscription: { remove(): void } | null = null;
let subscriptionVersion = 0;
let initialStateTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleVersion = 0;
let wasBackground = AppState.currentState === "background";
let localModule: Promise<typeof import("expo-local-authentication")> | null = null;
let capabilityTask: Promise<void> | null = null;
type AuthResult = { success: true } | { success: false; error: string };
type OperationKind = "enable" | "disable" | "unlock";
type Operation = {
  id: string;
  kind: OperationKind;
  version: number;
  phase: "preflight" | "authenticate" | "foreground" | "persist";
  promise: Promise<boolean>;
  resolve: (result: boolean) => void;
  settled: boolean;
  resume: ((active: boolean) => void) | null;
};
let operation: Operation | null = null;
let operationSequence = 0;
let nativeFlight: {
  owner: Operation;
  method: "biometric" | "passcode";
  promise: Promise<AuthResult>;
} | null = null;

function update(patch: Partial<AppLockSnapshot>) {
  const next = { ...snapshot, ...patch };
  // An unreadable preference never silently turns a previously enabled lock off.
  if (!next.initialized) next.locked = mobile;
  if (
    Object.keys(next).every((key) =>
      Object.is(next[key as keyof AppLockSnapshot], snapshot[key as keyof AppLockSnapshot]),
    )
  )
    return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function authenticationModule() {
  if (localModule) return localModule;
  const pending = import("expo-local-authentication");
  localModule = pending;
  void pending.catch(() => {
    if (localModule === pending) localModule = null;
  });
  return pending;
}

/** This device-only switch is intentionally outside ledger backups and sync. */
export function initializeAppLock(): Promise<void> {
  resampleAppState();
  if (snapshot.initialized) return Promise.resolve();
  if (initialization) return initialization;
  const version = ++readVersion;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  initialization = pending;
  update({ error: null });
  const complete = () => {
    clearTimeout(timer);
    if (initialization === pending) initialization = null;
    finish();
  };
  const timer = setTimeout(() => {
    if (version === readVersion && !snapshot.initialized) {
      resampleAppState();
      if (version === readVersion) update({ initialized: false, locked: true, error: "storage" });
    }
    complete();
  }, INITIAL_READ_TIMEOUT_MS);
  void Promise.resolve()
    .then(() => SecureStore.getItemAsync(APP_LOCK_KEY))
    .then((stored) => {
      if (version !== readVersion) return;
      if (stored !== null && stored !== "0" && stored !== "1") throw Error("Invalid app-lock flag");
      const enabled = stored === "1";
      resampleAppState();
      if (version !== readVersion) return;
      update({ initialized: true, enabled, locked: enabled, error: null });
      recheckInitialAppState();
    })
    .catch(() => {
      if (version !== readVersion) return;
      resampleAppState();
      if (version === readVersion) update({ initialized: false, locked: true, error: "storage" });
    })
    .finally(complete);
  return pending;
}

/** Capability checks never display a native authentication prompt. */
export function refreshAppLockCapability(): Promise<void> {
  if (!mobile) return Promise.resolve();
  if (capabilityTask) return capabilityTask;
  const pending = authenticationModule()
    .then(async (auth) => {
      const [hardware, enrolled, level] = await Promise.all([
        auth.hasHardwareAsync(),
        auth.isEnrolledAsync(),
        Platform.OS === "android" ? auth.getEnrolledLevelAsync() : Promise.resolve(3),
      ]);
      update({
        capability: !hardware
          ? "no_hardware"
          : !enrolled
            ? "not_enrolled"
            : level !== 3
              ? "weak"
              : "available",
      });
    })
    .catch(() => update({ capability: "unavailable" }));
  capabilityTask = pending;
  void pending.finally(() => {
    if (capabilityTask === pending) capabilityTask = null;
  });
  return pending;
}

function current(job: Operation) {
  return operation === job && !job.settled && job.version === lifecycleVersion;
}

function settle(job: Operation, result: boolean) {
  if (job.settled) return;
  job.settled = true;
  job.resume?.(false);
  job.resume = null;
  if (operation === job) {
    operation = null;
    update({ busy: false });
  }
  job.resolve(result);
}

function retireAuthentication() {
  const job = operation;
  if (!job || job.phase === "persist") return;
  const ownsNativePrompt = nativeFlight?.owner === job;
  const method = ownsNativePrompt ? nativeFlight?.method : null;
  settle(job, false);
  if (method === "passcode") void cancelDevicePasscode(job.id).catch(() => {});
  else if (ownsNativePrompt && Platform.OS === "android")
    void authenticationModule()
      .then((auth) => auth.cancelAuthenticate())
      .catch(() => {});
}

function handleAppState(next: AppStateStatus | null) {
  if (next === "background") {
    lifecycleVersion++;
    wasBackground = true;
    if (snapshot.enabled) update({ locked: true });
    retireAuthentication();
  }
  const resumed = next === "active" && wasBackground;
  if (resumed) wasBackground = false;
  update({
    appState: next,
    ...(resumed ? { foregroundVersion: snapshot.foregroundVersion + 1 } : {}),
  });
  if (next === "active") operation?.resume?.(true);
}

function resampleAppState() {
  const now = normalizeAppState(AppState.currentState);
  if (now !== snapshot.appState) handleAppState(now);
}

/** RN can fill its cached initial state without emitting a change event. */
function recheckInitialAppState() {
  if (!mobile || snapshot.appState !== null || listeners.size === 0 || initialStateTimer !== null)
    return;
  const version = subscriptionVersion;
  const started = Date.now();
  const check = () => {
    initialStateTimer = null;
    if (version !== subscriptionVersion || listeners.size === 0) return;
    resampleAppState();
    if (
      version === subscriptionVersion &&
      listeners.size > 0 &&
      snapshot.appState === null &&
      Date.now() - started < INITIAL_READ_TIMEOUT_MS
    )
      initialStateTimer = setTimeout(check, INITIAL_STATE_RECHECK_MS);
  };
  initialStateTimer = setTimeout(check, INITIAL_STATE_RECHECK_MS);
}

export function subscribeAppLock(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const now = normalizeAppState(AppState.currentState);
    if (now !== snapshot.appState) handleAppState(now);
    const version = ++subscriptionVersion;
    subscription = AppState.addEventListener("change", (next) => {
      if (version === subscriptionVersion) handleAppState(normalizeAppState(next));
    });
    void initializeAppLock();
    recheckInitialAppState();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size !== 0) return;
    subscriptionVersion++;
    if (initialStateTimer !== null) clearTimeout(initialStateTimer);
    initialStateTimer = null;
    subscription?.remove();
    subscription = null;
    lifecycleVersion++;
    if (snapshot.enabled) update({ locked: true });
    retireAuthentication();
  };
}

function authError(error: string): AppLockError | null {
  if (["user_cancel", "app_cancel", "system_cancel", "user_fallback"].includes(error)) return null;
  if (error === "lockout") return "lockout";
  if (error === "not_enrolled") return "not_enrolled";
  if (["not_available", "passcode_not_set", "no_space"].includes(error)) return "unavailable";
  return "authentication";
}

async function authenticate(
  job: Operation,
  method: "biometric" | "passcode" = "biometric",
): Promise<boolean> {
  // A retired native prompt must finish cancelling before its replacement starts.
  if (nativeFlight) await nativeFlight.promise.catch(() => {});
  if (!current(job) || !isForeground()) return false;
  if (method === "passcode" && !canUseAppLockPasscode()) {
    update({ error: "unavailable" });
    return false;
  }
  const auth = method === "biometric" ? await authenticationModule() : null;
  if (!current(job) || !isForeground()) return false;
  job.phase = "authenticate";
  const promise = Promise.resolve().then<AuthResult>(() => {
    if (!current(job) || !isForeground()) return { success: false, error: "app_cancel" };
    if (method === "passcode")
      return authenticateWithDevicePasscode(
        job.id,
        t(`appLock.auth.${job.kind}`),
        t("common.cancel"),
      );
    return auth!.authenticateAsync({
      promptMessage: t(`appLock.auth.${job.kind}`),
      cancelLabel: t("common.cancel"),
      fallbackLabel: t("appLock.auth.passcode"),
      disableDeviceFallback: !supportsAppLockDeviceFallback(),
      biometricsSecurityLevel: "strong",
      requireConfirmation: true,
    });
  });
  nativeFlight = { owner: job, method, promise };
  let result: AuthResult;
  try {
    result = await promise;
  } finally {
    if (nativeFlight?.promise === promise) nativeFlight = null;
  }
  if (!current(job)) return false;
  if (result?.success !== true) {
    update({ error: authError(typeof result?.error === "string" ? result.error : "unknown") });
    return false;
  }
  // iOS may resolve Face ID just before its own inactive→active event.
  if (getAppLockSnapshot().appState === "inactive") {
    job.phase = "foreground";
    const active = await new Promise<boolean>((resolve) => {
      job.resume = resolve;
    });
    job.resume = null;
    if (!active) return false;
  }
  return current(job) && isForeground();
}

const isForeground = () => snapshot.appState === "active";

function run(kind: OperationKind, work: (job: Operation) => Promise<boolean>): Promise<boolean> {
  if (operation) return operation.kind === kind ? operation.promise : Promise.resolve(false);
  if (!mobile || snapshot.appState !== "active") return Promise.resolve(false);
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  const job: Operation = {
    id: `app-lock-${++operationSequence}`,
    kind,
    version: lifecycleVersion,
    phase: "preflight",
    promise,
    resolve,
    settled: false,
    resume: null,
  };
  operation = job;
  update({ busy: true, error: null });
  void work(job).then(
    (result) => settle(job, result),
    () => {
      if (current(job)) update({ error: job.phase === "persist" ? "storage" : "unavailable" });
      settle(job, false);
    },
  );
  return promise;
}

/** Successful enabling/disabling is authenticated before the durable flag changes. */
export function setAppLockEnabled(enabled: boolean): Promise<boolean> {
  if (snapshot.initialized && snapshot.enabled === enabled && !operation)
    return Promise.resolve(true);
  return run(enabled ? "enable" : "disable", async (job) => {
    await initializeAppLock();
    if (!current(job) || !snapshot.initialized) return false;
    if (snapshot.enabled === enabled) return true;
    if (enabled) {
      await refreshAppLockCapability();
      if (!current(job)) return false;
      if (snapshot.capability !== "available") {
        update({
          error:
            snapshot.capability === "not_enrolled" || snapshot.capability === "weak"
              ? snapshot.capability
              : "unavailable",
        });
        return false;
      }
    }
    // Supported OSes may use a device credential if enrollment was removed.
    // Older Android users can re-enroll a fingerprint in system security settings.
    if (!(await authenticate(job))) return false;
    job.phase = "persist";
    await SecureStore.setItemAsync(APP_LOCK_KEY, enabled ? "1" : "0", {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    readVersion++;
    update({
      enabled,
      locked: enabled && (job.version !== lifecycleVersion || snapshot.appState !== "active"),
      error: null,
    });
    return true;
  });
}

export function unlockApp(): Promise<boolean> {
  if (snapshot.initialized && !snapshot.enabled && !operation) return Promise.resolve(true);
  return run("unlock", async (job) => {
    await initializeAppLock();
    if (!current(job) || !snapshot.initialized) return false;
    if (!snapshot.enabled) return true;
    if (!(await authenticate(job))) return false;
    update({ locked: false, error: null });
    return true;
  });
}

/** Explicit device passcode, without restarting Face ID or accepting an app PIN. */
export function unlockAppWithPasscode(): Promise<boolean> {
  if (!canUseAppLockPasscode()) return Promise.resolve(false);
  return run("unlock", async (job) => {
    await initializeAppLock();
    if (!current(job) || !snapshot.initialized || !snapshot.enabled) return false;
    if (!(await authenticate(job, "passcode"))) return false;
    update({ locked: false, error: null });
    return true;
  });
}

export const getAppLockSnapshot = () => snapshot;
export const clearAppLockError = () => update({ error: null });

export function useAppLock(): AppLockSnapshot {
  return useSyncExternalStore(subscribeAppLock, getAppLockSnapshot, getAppLockSnapshot);
}
