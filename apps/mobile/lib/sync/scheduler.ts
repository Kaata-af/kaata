// The sync polling loop. Mounted reactively from _layout.tsx whenever
// account_id flips from null to non-null (i.e. after Google sign-in), and
// torn down on sign-out.
//
// Loop contract per plan C1:
//   1. Skip if offline.
//   2. Skip if no JWT (local-only mode).
//   3. Pull to has_more=false.
//   4. Then push.
//   5. Wait the configured interval (foreground or background), then repeat.
//
// On error:
//   - SessionExpiredError → clear JWT, stop the worker.
//   - SyncTransientError / SyncTimeoutError / network error → exponential
//     backoff (1s, 2s, 4s, ..., capped 60s). Reset on first success.
//   - PermissionRejectedError → log, treat as soft failure.
//   - Anything else → log, treat as transient.

import { AppState, type AppStateStatus } from "react-native";
import * as Network from "expo-network";

import { clearLocalSession, getSessionJWT } from "../auth";
import { getActiveVaultIdSyncMaybe } from "../db-tx";
import {
  PermissionRejectedError,
  SessionExpiredError,
  SyncTimeoutError,
  SyncTransientError,
} from "./errors";
import { pullEvents } from "./pull";
import { pushEvents } from "./push";

const FOREGROUND_INTERVAL_MS = 5_000;
const BACKGROUND_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export type SyncOnceResult = {
  pulled: number;
  pushed: number;
  rejected: number;
  duplicates: number;
};

// Runs one pull-then-push cycle for the given vault (or the active vault if
// not specified). Exposed for the "Sync now" row in ProfileSettingsSheet and
// for the dev replay-test harness.
export async function syncOnce(opts: { vaultId?: string } = {}): Promise<SyncOnceResult> {
  const vaultId = opts.vaultId ?? getActiveVaultIdSyncMaybe();
  if (!vaultId) {
    return { pulled: 0, pushed: 0, rejected: 0, duplicates: 0 };
  }

  const jwt = await getSessionJWT();
  if (!jwt) {
    return { pulled: 0, pushed: 0, rejected: 0, duplicates: 0 };
  }

  const net = await Network.getNetworkStateAsync();
  if (!net.isConnected) {
    return { pulled: 0, pushed: 0, rejected: 0, duplicates: 0 };
  }

  // Pull-then-push. Non-negotiable per plan C1.
  const pullRes = await pullEvents(vaultId);
  const pushRes = await pushEvents(vaultId);

  return {
    pulled: pullRes.pulled,
    pushed: pushRes.pushed,
    rejected: pushRes.rejected,
    duplicates: pushRes.duplicates,
  };
}

export type StartSyncSchedulerOpts = {
  accountId: string;
};

// Returns a stop function. Calling it cancels any pending timer and prevents
// the next iteration from firing. The currently-in-flight syncOnce (if any)
// is allowed to complete.
export function startSyncScheduler(_opts: StartSyncSchedulerOpts): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let backoffAttempt = 0;
  let inFlight = false;
  let currentAppState: AppStateStatus = AppState.currentState;

  const appStateSub = AppState.addEventListener("change", (s) => {
    currentAppState = s;
  });

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  };

  const currentInterval = (): number => {
    return currentAppState === "active" ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return;

    inFlight = true;
    try {
      await syncOnce();
      backoffAttempt = 0;
      scheduleNext(currentInterval());
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await clearLocalSession().catch(() => {});
        stopped = true;
        return;
      }

      if (err instanceof PermissionRejectedError) {
        backoffAttempt = 0;
        scheduleNext(currentInterval());
        return;
      }

      let nextDelay: number;
      if (err instanceof SyncTransientError && err.retryAfterMs != null) {
        const slot = backoffSlot(backoffAttempt);
        nextDelay = Math.max(err.retryAfterMs, slot);
      } else if (err instanceof SyncTransientError || err instanceof SyncTimeoutError) {
        nextDelay = backoffSlot(backoffAttempt);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[sync] unexpected error, backing off", err);
        nextDelay = backoffSlot(backoffAttempt);
      }

      backoffAttempt = Math.min(backoffAttempt + 1, 16);
      scheduleNext(nextDelay);
    } finally {
      inFlight = false;
    }
  };

  // Kick off immediately on mount.
  scheduleNext(0);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    appStateSub.remove();
  };
}

function backoffSlot(attempt: number): number {
  // 1s, 2s, 4s, 8s, ..., capped at 60s.
  const slot = BACKOFF_BASE_MS * Math.pow(2, attempt);
  return Math.min(slot, BACKOFF_MAX_MS);
}
