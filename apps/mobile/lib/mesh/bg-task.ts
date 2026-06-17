// apps/mobile/lib/mesh/bg-task.ts
//
// #43 P2 Phase 1 — periodic background catch-up via expo-background-task
// (WorkManager-scheduled, ~15min OS minimum). Turns "never syncs after swipe-kill"
// into "syncs within ~15min of being near a peer", with a mechanism that PHYSICALLY
// CANNOT crash-loop (WorkManager backs off exponentially; a thrown task is caught
// by expo-task-manager and never crashes the app). All actual work + every
// data-safety guard lives in runBackgroundCatchup(); this file is just the task
// definition + register/unregister, gated by the Phase 0 kill-switch.
//
// MUST be imported from index.js AFTER the crypto polyfills so the task is
// registered in BOTH the foreground and headless contexts with crypto ready.
import "./_crypto-polyfill";
import "./_ed25519-setup";

import { Platform } from "react-native";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

import { markJsAlive } from "../../modules/kaata-bt-classic";
import { getAppMeta } from "../db";
import { runBackgroundCatchup } from "./bg-catchup";

export const BG_CATCHUP_TASK = "kaata-bg-catchup";
// OS minimum is 15min; the system treats this as a floor and batches wakeups.
const MIN_INTERVAL_MIN = 15;
// Bounded window. On Android the OS limiter is WorkManager (~10min worker limit),
// NOT a 30s wall — so this short window is a deliberate battery / self-bound
// choice, not an OS constraint. Raise it if periodic catch-up must clear a backlog.
const WINDOW_MS = 25_000;

// Defined at module top-level (import order via index.js) so it's registered when
// the JS bundle loads in EITHER context. The executor is fail-closed: any throw is
// returned as Failed (caught by expo-task-manager; WorkManager backs off) — it can
// never crash the app or loop.
TaskManager.defineTask(BG_CATCHUP_TASK, async () => {
  try {
    await runBackgroundCatchup(WINDOW_MS);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (err) {
    if (__DEV__) console.warn("[bg-task] catch-up failed", err);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Register/unregister the periodic catch-up to match the live flags. Registers
 * ONLY when the remote kill-switch (bg_mesh_enabled) AND offline sync
 * (shop_mode_enabled) are both on — so the default-OFF live fleet never schedules
 * it until the backend flips the flag for a cohort. Idempotent + never throws.
 */
/**
 * Cross-VM single-mesh heartbeat: stamp "foreground JS mesh alive" so the headless
 * background entry stays out while the live mesh owns the radio. Call ~every 10s
 * from the foreground while shop mode is on. Best-effort; never throws.
 */
export async function heartbeatJsAlive(): Promise<void> {
  try {
    await markJsAlive();
  } catch {
    /* best-effort */
  }
}

export async function reconcileBgCatchup(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    const [bgOn, shopOn] = await Promise.all([
      getAppMeta("bg_mesh_enabled"),
      getAppMeta("shop_mode_enabled"),
    ]);
    const want = bgOn === "1" && shopOn === "1";
    const registered = await TaskManager.isTaskRegisteredAsync(BG_CATCHUP_TASK);
    if (want && !registered) {
      await BackgroundTask.registerTaskAsync(BG_CATCHUP_TASK, {
        minimumInterval: MIN_INTERVAL_MIN,
      });
      if (__DEV__) console.log("[bg-task] registered periodic catch-up");
    } else if (!want && registered) {
      await BackgroundTask.unregisterTaskAsync(BG_CATCHUP_TASK);
      if (__DEV__) console.log("[bg-task] unregistered periodic catch-up");
    }
  } catch (err) {
    if (__DEV__) console.warn("[bg-task] reconcile failed", err);
  }
}
