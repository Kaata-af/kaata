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
import { getActiveVaultIdSyncMaybe, getDb } from "../db-tx";
import {
  PermissionRejectedError,
  SessionExpiredError,
  SyncTimeoutError,
  SyncTransientError,
  VaultNotRegisteredError,
} from "./errors";
import { pullEvents } from "./pull";
import { pushEvents } from "./push";
import { ensureVaultRegistered, fullBackupSweep } from "./reconcile";
import { onLedgerApplied } from "../ledger-events";

const FOREGROUND_INTERVAL_MS = 5_000;
const BACKGROUND_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
// The per-tick syncOnce only covers the ACTIVE vault. The full sweep
// (register-reconcile + pull/push EVERY vault) runs on mount, on foreground
// resume, and every SWEEP_EVERY_N successful ticks (~1 min at the 5s
// foreground interval) so unregistered / non-active vaults still back up.
const SWEEP_EVERY_N = 12;
// Push-on-write: after a LOCAL edit, run a sync cycle within ~1s instead of
// waiting out the poll interval — matches the mesh channel's latency so the
// cloud channel is near-real-time too. Debounced to coalesce edit bursts.
const KICK_DEBOUNCE_MS = 1_000;
// Advisory vector convergence check every N successful cycles (M1).
const CONVERGENCE_EVERY_N = 60;

export type SyncOnceResult = {
  pulled: number;
  pushed: number;
  rejected: number;
  duplicates: number;
};

// Runs one pull-then-push cycle for the given vault (or the active vault if
// not specified). Exposed for the "Sync now" row in ProfileSettingsSheet and
// for the dev replay-test harness.
export async function syncOnce(
  opts: { vaultId?: string; verifyConvergence?: boolean } = {},
): Promise<SyncOnceResult> {
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

  // Register the active vault server-side BEFORE pulling it (when it's an OWNED,
  // not-yet-registered vault). An unregistered owned vault 403s on pull, which
  // aborts this cycle before push can stamp last_push_at — the "Not backed up yet
  // while online" bug (the backup status reads max(last_pull_at, last_push_at)
  // and both stay 0). Doing it here (eager + awaited) brings the vault up on the
  // first online tick instead of depending on the periodic fullBackupSweep (which
  // also skips the active vault's own push, so it could never stamp the
  // indicator). Joined vaults are left untouched and pull/push normally.
  await ensureVaultRegistered(vaultId);

  // Pull-then-push. Non-negotiable per plan C1.
  const pullRes = await pullEvents(vaultId);
  const pushRes = await pushEvents(vaultId);

  // Sync v2 M1: advisory convergence check (docs/sync-v2-architecture.md
  // §9-M1). Compares our author-seq vector with the server's AFTER the
  // cycle; logs divergence (relay holes, pull gaps) while the new
  // bookkeeping earns trust ahead of M3. Fire-and-forget by contract —
  // checkConvergence never throws — so it cannot affect sync results,
  // ordering, or the scheduler's backoff.
  if (opts.verifyConvergence) {
    const { checkConvergence } = await import("../replication");
    void checkConvergence(vaultId);
  }

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

  // M2 membership chain: one-shot chain-genesis backfill (+ pending
  // witness emission retry) across ALL non-archived vaults — not just the
  // active one (review P2: a multi-vault owner's other vaults must get
  // their chain, and a stranded witness_emit_pending must retry). Fire-
  // and-forget, non-fatal by contract — each per-vault run catches its own
  // emission errors and self-guards with an in-session Set, so this can
  // never affect the sync loop. Lazy import keeps the scheduler module
  // free of the trust/event-log dependency at load time.
  void (async () => {
    const { ensureChainBackfillAllVaults } = await import("../trust/backfill");
    await ensureChainBackfillAllVaults();
  })().catch((err) => {
    console.warn("[sync] chain backfill kickoff failed (non-fatal)", err);
  });

  let kickTimer: ReturnType<typeof setTimeout> | null = null;

  // Full backup sweep (register-reconcile + all-vault pull/push). Self-guarded
  // and best-effort: it swallows its own per-vault errors so it can run
  // fire-and-forget alongside the active-vault tick without touching the
  // scheduler's backoff state. cyclesSinceSweep paces the periodic run.
  let sweepInFlight = false;
  let cyclesSinceSweep = 0;
  const runSweep = (): void => {
    if (stopped || sweepInFlight) return;
    sweepInFlight = true;
    void (async () => {
      try {
        await fullBackupSweep();
      } catch (err) {
        console.warn("[sync] backup sweep failed (non-fatal)", err);
      } finally {
        sweepInFlight = false;
        cyclesSinceSweep = 0;
      }
    })();
  };

  // Best-effort flush of EVERY vault that has unacked events, used when the app
  // goes to background/inactive. Without it, a recent edit in a NON-active vault
  // (only drained by the ~60s sweep) is lost if the OS kills the app before the
  // next sweep — the exact data-loss the user hit (a tally + note edits made in
  // vaults he'd navigated away from, then closed the app). Fire-and-forget: the
  // OS may suspend us mid-flush, but combined with the per-write kick below most
  // events are already pushed, so this only needs to catch the last ~1s.
  const flushAllPendingVaults = async (): Promise<void> => {
    try {
      if (!(await getSessionJWT())) return;
      const net = await Network.getNetworkStateAsync();
      if (!net.isConnected) return;
      const db = await getDb();
      const rows = await db.getAllAsync<{ vault_id: string }>(
        `SELECT DISTINCT vault_id FROM event_log
          WHERE server_acked_at IS NULL AND rejected_at IS NULL
            AND tombstone_reason IS NULL AND vault_id IS NOT NULL`,
      );
      // Flush vaults in PARALLEL (allSettled) — the OS grants only a short
      // background window, and awaiting serially lets one slow vault starve the
      // rest. Each per-vault failure is swallowed so one can't reject the batch.
      await Promise.allSettled(
        rows.map((r) => (stopped ? Promise.resolve() : syncOnce({ vaultId: r.vault_id }))),
      );
    } catch (err) {
      if (__DEV__) console.warn("[sync] background flush failed", err);
    }
  };

  const appStateSub = AppState.addEventListener("change", (s) => {
    const wasActive = currentAppState === "active";
    currentAppState = s;
    // Foreground kick: sync immediately on resume instead of waiting out the
    // in-flight background interval (up to 30s of stale data after unlock).
    if (!wasActive && s === "active") {
      scheduleNext(0);
      runSweep(); // also reconcile/back up non-active vaults on resume
    } else if (wasActive && s !== "active") {
      // Going to background/inactive: flush every vault with pending events so
      // recent non-active-vault edits survive an imminent app kill.
      void flushAllPendingVaults();
    }
  });

  const scheduleNext = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delayMs);
  };

  // Push-on-write: a LOCAL ledger edit schedules a near-immediate sync of the
  // AUTHORING vault — NOT just the active one. The old code kicked only when the
  // write hit the active vault, so an edit in any other vault waited up to ~60s
  // for the sweep and was lost if the app closed first (the user's missing tally
  // + note edits, authored in vaults he'd navigated away from). We now collect
  // every locally-written vault and drain them ~1s later: the active vault via
  // the normal tick (pull-then-push), the rest via a targeted syncOnce each.
  const pendingKickVaults = new Set<string>();
  const drainKickVaults = async (): Promise<void> => {
    const active = getActiveVaultIdSyncMaybe();
    const vaults = Array.from(pendingKickVaults);
    pendingKickVaults.clear();
    for (const vid of vaults) {
      if (stopped) return;
      if (vid === active) continue; // covered by the tick scheduled below
      try {
        await syncOnce({ vaultId: vid });
      } catch (err) {
        if (__DEV__) console.warn("[sync] kick drain failed", vid.slice(0, 8), err);
      }
    }
  };
  const scheduleKick = (): void => {
    if (stopped || kickTimer) return; // coalesce a burst into one cycle
    kickTimer = setTimeout(() => {
      kickTimer = null;
      if (stopped) return;
      scheduleNext(0); // active vault: tick guards inFlight, collapses into a run
      void drainKickVaults(); // non-active authoring vaults
    }, KICK_DEBOUNCE_MS);
  };
  const unsubLedger = onLedgerApplied((vaultId, origin) => {
    if (origin !== "local") return;
    if (vaultId) pendingKickVaults.add(vaultId);
    scheduleKick();
  });

  const currentInterval = (): number => {
    return currentAppState === "active" ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
  };

  // Convergence-check cadence: every CONVERGENCE_EVERY_N successful cycles
  // (~5 min at the 5s foreground interval) rather than every tick — the
  // check is advisory observability and shouldn't double request volume.
  let cyclesSinceConvergenceCheck = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return;

    inFlight = true;
    try {
      cyclesSinceConvergenceCheck++;
      const verifyConvergence = cyclesSinceConvergenceCheck >= CONVERGENCE_EVERY_N;
      await syncOnce({ verifyConvergence });
      // Reset only after the designated cycle RESOLVED — a throw above
      // keeps the counter past threshold so the next successful cycle
      // runs the (advisory) check instead of waiting another full window.
      if (verifyConvergence) cyclesSinceConvergenceCheck = 0;
      backoffAttempt = 0;
      // Periodic full sweep so non-active / not-yet-registered vaults back up.
      if (++cyclesSinceSweep >= SWEEP_EVERY_N) runSweep();
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

      if (err instanceof VaultNotRegisteredError) {
        // The active vault has no server membership yet (registration POST hasn't
        // landed — e.g. a transient 5xx during this tick's ensureVaultRegistered).
        // syncOnce retries the registration on the next tick, so treat this as a
        // soft state: normal cadence, no backoff escalation, no crash report
        // (it's expected for a freshly-created vault or one whose registration
        // was reset by migration 020).
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
        // Mythos crash-reporter: an UNEXPECTED sync error (not session-
        // expired / permission / transient / timeout) is worth seeing in
        // the backend. Best-effort, never throws.
        void import("../crash-report").then((cr) =>
          cr.queueCrashReport({
            kind: "sync",
            name: err instanceof Error ? err.name : "unknown",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }

      backoffAttempt = Math.min(backoffAttempt + 1, 16);
      scheduleNext(nextDelay);
    } finally {
      inFlight = false;
    }
  };

  // Kick off immediately on mount. Also run a full sweep right away so any
  // vault that never registered (created offline, or whose create-time POST
  // failed) gets registered + backed up on the first signed-in session after
  // this fix ships — not just newly-created ones.
  scheduleNext(0);
  runSweep();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (kickTimer) {
      clearTimeout(kickTimer);
      kickTimer = null;
    }
    unsubLedger();
    appStateSub.remove();
  };
}

function backoffSlot(attempt: number): number {
  // 1s, 2s, 4s, 8s, ..., capped at 60s.
  const slot = BACKOFF_BASE_MS * Math.pow(2, attempt);
  return Math.min(slot, BACKOFF_MAX_MS);
}
