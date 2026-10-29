import { useSyncExternalStore } from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { getMotionHardware, type MotionHardware } from "../modules/kaata-save-file";

export type MotionMode = "auto" | "full" | "reduced";
export const MOTION_PREFERENCE_KEY = "motion_pref";
const GIB = 1024 ** 3;
const LOOKUP_TIMEOUT_MS = 750;

/** A conservative memory heuristic, not a benchmark or a device-model list. */
export function isLowEndMotionHardware(platform: string, hardware: MotionHardware | null): boolean {
  if (platform !== "android" && platform !== "ios") return false;
  if (platform === "android" && hardware?.lowRamDevice === true) return true;
  const bytes = hardware?.totalMemoryBytes;
  return (
    typeof bytes === "number" &&
    Number.isFinite(bytes) &&
    bytes > 0 &&
    bytes <= (platform === "android" ? 3 : 2) * GIB
  );
}

export const parseMotionMode = (value: unknown): MotionMode =>
  value === "full" || value === "reduced" ? value : "auto";

export type MotionPreferenceSnapshot = {
  mode: MotionMode;
  lowEndDevice: boolean;
  systemReducedMotion: boolean;
  effectiveReducedMotion: boolean;
  initialized: boolean;
  saving: boolean;
};

let snapshot: MotionPreferenceSnapshot = {
  mode: "auto",
  lowEndDevice: false,
  systemReducedMotion: false,
  effectiveReducedMotion: true,
  initialized: false,
  saving: false,
};
const listeners = new Set<() => void>();
let initialization: Promise<void> | null = null;
let osSubscription: { remove(): void } | null = null;
let osRevision = 0;
let osKnown = false;
let runtimeLease = 0;
let requestVersion = 0;
let confirmedMode: MotionMode = "auto";
let confirmedVersion = 0;
let pendingWrites = 0;
let writeQueue: Promise<void> = Promise.resolve();

function update(patch: Partial<MotionPreferenceSnapshot>) {
  const next = { ...snapshot, ...patch };
  next.effectiveReducedMotion =
    !next.initialized ||
    !osKnown ||
    next.systemReducedMotion ||
    next.mode === "reduced" ||
    (next.mode === "auto" && next.lowEndDevice);
  if (
    Object.keys(next).every((key) =>
      Object.is(next[key as keyof typeof next], snapshot[key as keyof typeof snapshot]),
    )
  )
    return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

async function bounded<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(read)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readSystemMotion(lease: number) {
  const revision = osRevision;
  const current = () => lease === runtimeLease && revision === osRevision;
  const read = Promise.resolve()
    .then(() => AccessibilityInfo.isReduceMotionEnabled())
    .then(
      (value) => {
        if (!current() || typeof value !== "boolean") return;
        osKnown = true;
        update({ systemReducedMotion: value });
      },
      () => {
        // An unavailable accessibility preference is not evidence that motion
        // is allowed. Keep the conservative state until an event or fresh read.
        if (!current()) return;
        osKnown = false;
        update({});
      },
    );
  // Bound startup waiting, not the preference's lifetime. A delayed successful
  // native response still applies if no newer event or subscription replaced it.
  await bounded(() => read, undefined);
}

function readMotionHardware() {
  const read = Promise.resolve()
    .then(getMotionHardware)
    .then(
      (hardware) => update({ lowEndDevice: isLowEndMotionHardware(Platform.OS, hardware) }),
      () => {},
    );
  // A busy low-memory device may answer late. Cache its eventual classification
  // without delaying startup or changing an explicit Full/Reduced choice.
  return bounded(() => read, undefined);
}

function readStoredMotionMode() {
  const version = requestVersion;
  const persistedVersion = confirmedVersion;
  const read = Promise.resolve()
    .then(async () => (await import("./db")).getAppMeta(MOTION_PREFERENCE_KEY))
    .then(
      (stored) => {
        // A late read still supplies the durable rollback target, unless a
        // successful write has already made this initial value obsolete.
        if (confirmedVersion !== persistedVersion) return;
        const mode = parseMotionMode(stored);
        confirmedMode = mode;
        if (requestVersion === version || pendingWrites === 0) update({ mode });
      },
      () => {},
    );
  return bounded(() => read, undefined);
}

/** One startup read for this device, shared by every motion consumer. */
export function initializeMotionPreference(): Promise<void> {
  if (initialization) return initialization;
  initialization = Promise.all([
    readStoredMotionMode(),
    readMotionHardware(),
    readSystemMotion(runtimeLease),
  ]).then(() => {
    update({ initialized: true });
  });
  return initialization;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const lease = ++runtimeLease;
    osSubscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      if (lease !== runtimeLease) return;
      osRevision++;
      osKnown = true;
      update({ systemReducedMotion: value });
    });
    if (initialization) void readSystemMotion(lease);
    else void initializeMotionPreference();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      runtimeLease++;
      osSubscription?.remove();
      osSubscription = null;
      // The system preference may change while no UI is subscribed. A later
      // mount stays quiet until its new bounded accessibility read completes.
      osKnown = false;
      update({});
    }
  };
}

/** Apply immediately; serialize durability and roll back only the latest intent. */
export function setMotionMode(mode: MotionMode): Promise<void> {
  if (mode !== "auto" && mode !== "full" && mode !== "reduced")
    return Promise.reject(new Error("Unsupported motion preference"));
  const ready = initializeMotionPreference();
  const version = ++requestVersion;
  pendingWrites++;
  update({ mode, saving: true });
  const write = writeQueue.then(async () => {
    await ready;
    await (await import("./db")).setAppMeta(MOTION_PREFERENCE_KEY, mode);
    confirmedMode = mode;
    confirmedVersion = version;
  });
  writeQueue = write.catch(() => {});
  const settled = (failed: boolean) => {
    // Settle visibility and pending state together so a late preference read
    // cannot land between a failed rollback and its pending-write decrement.
    pendingWrites--;
    update({
      ...(failed && requestVersion === version ? { mode: confirmedMode } : {}),
      saving: pendingWrites > 0,
    });
  };
  return write.then(
    () => settled(false),
    (error: unknown) => {
      settled(true);
      throw error;
    },
  );
}

export const getMotionPreferenceSnapshot = () => snapshot;

export function useMotionPreference() {
  const value = useSyncExternalStore(
    subscribe,
    getMotionPreferenceSnapshot,
    getMotionPreferenceSnapshot,
  );
  return { ...value, setMode: setMotionMode };
}
