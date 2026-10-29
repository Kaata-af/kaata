import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

// Animations are enabled unless the phone requests reduced motion. There is
// no app-level preference, persistence or device-performance classification.
let reducedMotion = false;
const listeners = new Set<() => void>();
let subscription: { remove(): void } | null = null;
let generation = 0;
let revision = 0;

function update(value: unknown) {
  if (typeof value !== "boolean" || value === reducedMotion) return;
  reducedMotion = value;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const lease = ++generation;
    subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      if (lease !== generation || typeof value !== "boolean") return;
      revision++;
      update(value);
    });
    const beforeRead = revision;
    void Promise.resolve()
      .then(() => (lease === generation ? AccessibilityInfo.isReduceMotionEnabled() : undefined))
      .then((value) => {
        // A live accessibility event or a new subscription owns any newer state.
        if (lease === generation && beforeRead === revision) update(value);
      })
      .catch(() => {
        // Unavailable system information leaves the last known preference in
        // place. A future event or remount can still supply the current value.
      });
  }
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    generation++;
    subscription?.remove();
    subscription = null;
  };
}

/** Cached OS preference for imperative scroll commands outside React renders. */
export const getReducedMotion = () => reducedMotion;

/** Share one live system accessibility subscription across all app surfaces. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getReducedMotion, getReducedMotion);
}
