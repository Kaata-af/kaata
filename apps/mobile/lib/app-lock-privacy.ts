import { useSyncExternalStore } from "react";
import { getAppLockSnapshot, subscribeAppLock } from "./app-lock";

/** A shared boolean selector keeps unrelated auth/status changes out of modals. */
export function getAppLockPrivacy(): boolean {
  const state = getAppLockSnapshot();
  return !state.initialized || state.locked || (state.enabled && state.appState !== "active");
}

export function useAppLockPrivacy(): boolean {
  return useSyncExternalStore(subscribeAppLock, getAppLockPrivacy, getAppLockPrivacy);
}
