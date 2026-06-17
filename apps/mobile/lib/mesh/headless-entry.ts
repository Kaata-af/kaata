// apps/mobile/lib/mesh/headless-entry.ts
//
// #43 P2 Phase 2 — registers the headless JS task that KaataMeshHeadlessService
// (native) spins up after a swipe-kill to run a bounded real-time mesh window.
// Imported from index.js AFTER the crypto polyfills so the headless ReactContext
// (which re-enters this bundle) has crypto installed before any @noble/* loads.
import "./_crypto-polyfill";
import "./_ed25519-setup";

import { AppRegistry, Platform } from "react-native";

import { runBackgroundCatchup } from "./bg-catchup";

// MUST match KaataMeshHeadlessService.TASK_NAME.
export const HEADLESS_MESH_TASK = "KaataMeshBg";
// Bounded window per headless spawn — well under the native TASK_TIMEOUT_MS.
const WINDOW_MS = 30_000;

if (Platform.OS === "android") {
  // The factory returns the async task. runBackgroundCatchup is fully self-guarded
  // (kill-switch, cross-VM heartbeat, schema-guard, busy_timeout, cache-prime,
  // single-mesh) and clears the crash-loop breaker on a clean window. We swallow
  // any throw so the headless task can NEVER crash-loop the process — the breaker
  // (native incremented it before spawn) self-disables the path after MAX_FAILS if
  // windows keep failing, and a foreground launch resets it.
  AppRegistry.registerHeadlessTask(HEADLESS_MESH_TASK, () => async () => {
    try {
      await runBackgroundCatchup(WINDOW_MS);
    } catch {
      /* fail-closed: leave the breaker incremented; never rethrow */
    }
  });
}
