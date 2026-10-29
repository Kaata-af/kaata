import { useEffect, useRef } from "react";
import { Platform, type AppStateStatus } from "react-native";

const CAPTURE_KEY = "kaata-app-lock";
let wanted = false;
let requested = false;
let iosEnabled = false;
let queue: Promise<void> = Promise.resolve();

/** Serialize native changes so a slow enable cannot undo a later disable. */
export function setAppLockScreenPrivacy(enabled: boolean): Promise<void> {
  wanted = enabled;
  if (enabled) requested = true;
  if (!requested) return Promise.resolve();
  const task = queue.then(async () => {
    if (wanted !== enabled || (Platform.OS !== "android" && Platform.OS !== "ios")) return;
    const capture = await import("expo-screen-capture");
    if (wanted !== enabled) return;
    if (Platform.OS === "android") {
      if (enabled) await capture.preventScreenCaptureAsync(CAPTURE_KEY);
      else await capture.allowScreenCaptureAsync(CAPTURE_KEY);
    } else if (enabled) {
      // SDK 58 registers native observers on every call; successful enable is
      // not idempotent. Retry failures, but never accumulate iOS observers.
      if (iosEnabled) return;
      await capture.enableAppSwitcherProtectionAsync(1);
      iosEnabled = true;
    } else {
      await capture.disableAppSwitcherProtectionAsync();
      iosEnabled = false;
    }
  });
  queue = task.catch(() => {});
  return task;
}

export function useAppLockScreenPrivacy(enabled: boolean, appState: AppStateStatus | null) {
  const previous = useRef<boolean | null>(null);
  useEffect(() => {
    const changed = previous.current !== enabled;
    previous.current = enabled;
    if (!changed && appState !== "active") return;
    // No photo permissions or screenshot listeners are needed to protect previews.
    // Retry on foreground if the native activity was unavailable during a write.
    void setAppLockScreenPrivacy(enabled).catch(() => {});
  }, [enabled, appState]);
  useEffect(() => {
    return () => {
      void setAppLockScreenPrivacy(false).catch(() => {});
    };
  }, []);
}
