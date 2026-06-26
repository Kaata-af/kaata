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
import { clearLastSyncError, recordLastSyncError } from "./last-error";
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

  // Pull-then-push, BUT push is NOT gated behind a successful pull. Previously a
  // transient pull failure (30s timeout, 5xx, offline blip) threw before push
  // ran, so the just-saved edits' push was dropped and the active kaata's newest
  // tally/contact never left the device. Push is append-only + idempotent and
  // needs no fresh pull cursor, so we ALWAYS push, then re-raise any pull error
  // afterward (preserving the scheduler's backoff / SessionExpired handling).
  let pullErr: unknown = null;
  let pulled = 0;
  try {
    pulled = (await pullEvents(vaultId)).pulled;
  } catch (err) {
    pullErr = err;
  }
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

  // Surface a pull error only now that push has run, so the scheduler still
  // backs off / handles SessionExpired but the data made it out first.
  if (pullErr) throw pullErr;

  return {
    pulled,
    pushed: pushRes.pushed,
    rejected: pushRes.rejected,
    duplicates: pushRes.duplicates,
  };
}

// Immediate, PULL-FREE push of one vault's outbox. The write-kick and the
// boot/resume/background drains call this so a just-saved edit reaches the server
// within a single round-trip — no 1s debounce, no pull-then-push gate, and
// OUTSIDE the scheduler tick's inFlight guard so it can never be swallowed.
// Best-effort + idempotent (pushEvents dedups server-side); a failure just leaves
// the rows unacked for the next attempt. Safe to call after the scheduler stops.
//
// Per-vault coalescing: a burst of rapid writes ("add a tally AND a contact")
// would otherwise fan out N concurrent full-batch pushes for the same vault. We
// keep ONE push in flight per vault and set a dirty flag instead; when it
// finishes, a single trailing push drains whatever arrived meanwhile. Collapses a
// K-write burst to ~2 pushes while still capturing every edit (pushEvents always
// reads the current unacked outbox).
const pushInFlight = new Set<string>();
const pushDirty = new Set<string>();
async function pushVaultNow(vaultId: string): Promise<void> {
  if (pushInFlight.has(vaultId)) {
    pushDirty.add(vaultId);
    return;
  }
  pushInFlight.add(vaultId);
  try {
    if (!(await getSessionJWT())) return;
    const net = await Network.getNetworkStateAsync();
    if (!net.isConnected) return;
    await ensureVaultRegistered(vaultId);
    await pushEvents(vaultId);
  } catch (err) {
    if (__DEV__) console.warn("[sync] pushVaultNow failed", vaultId.slice(0, 8), err);
  } finally {
    pushInFlight.delete(vaultId);
    // A write arrived while this push was in flight — drain it once more so the
    // tail of a burst is never left unacked.
    if (pushDirty.delete(vaultId)) void pushVaultNow(vaultId);
  }
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
  // Whether the previous tick failed — so we clear the persisted last-sync-error
  // exactly once on recovery instead of writing app_meta every successful tick.
  let lastTickFailed = false;
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

  // One-time historical cleanup: null the phone on any CONTACT that wrongly
  // carries the shopkeeper's own number (the pre-guard "first self-numbered
  // contact" leak). Emits a real person_phone_changed event so the fix is
  // durable + pushes — see lib/self-phone-scrub.ts for why this can't be a
  // db.ts migration. Fire-and-forget, app_meta-gated, non-fatal by contract.
  void (async () => {
    const { ensureSelfPhoneContactsScrubbed } = await import("../self-phone-scrub");
    await ensureSelfPhoneContactsScrubbed();
  })().catch((err) => {
    console.warn("[sync] self-phone scrub kickoff failed (non-fatal)", err);
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

  // Push-only drain of EVERY vault that has unacked events. Runs on boot-mount,
  // foreground-resume, app-background, and scheduler teardown so any leftover
  // unacked rows (active AND non-active vaults) reach the server within ~one
  // round-trip instead of waiting up to the ~60s sweep. PUSH-ONLY (no pull) so a
  // scarce launch/background window is spent UPLOADING, not pulling. Parallel +
  // best-effort with per-vault isolation; safe to call during teardown.
  const drainAllOutboxes = async (): Promise<void> => {
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
      await Promise.allSettled(rows.map((r) => pushVaultNow(r.vault_id)));
    } catch (err) {
      if (__DEV__) console.warn("[sync] drain-all-outboxes failed", err);
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
      void drainAllOutboxes(); // catch up any leftover unacked rows immediately
    } else if (wasActive && s !== "active") {
      // Going to background/inactive: push every vault with pending events so
      // recent edits survive an imminent app kill.
      void drainAllOutboxes();
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
    if (vaultId) {
      // Fire an IMMEDIATE pull-free push so the just-saved edit is durable within
      // ~one round-trip — before the 1s debounce, and outside the tick's inFlight
      // guard, so it can't be swallowed. This is the load-bearing "back up every
      // edit, fast" fix: each write pushes individually, so a burst's tail (e.g.
      // "add a tally AND a contact") is never dropped. The kick below stays as a
      // coalescing backstop + the active-vault pull cadence.
      void pushVaultNow(vaultId);
      pendingKickVaults.add(vaultId);
    }
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
      // Recovered — drop any persisted last-sync-error from the App-health report.
      if (lastTickFailed) {
        lastTickFailed = false;
        void clearLastSyncError();
      }
      // Periodic full sweep so non-active / not-yet-registered vaults back up.
      if (++cyclesSinceSweep >= SWEEP_EVERY_N) runSweep();
      scheduleNext(currentInterval());
    } catch (err) {
      // Persist the failure for the App-health report (user copies + sends it to
      // us). Best-effort, fire-and-forget; cleared on the next successful tick.
      lastTickFailed = true;
      void recordLastSyncError(err);

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
  // this fix ships — not just newly-created ones. And drain every outbox so any
  // edits left unacked by a previously-killed session catch up at once.
  scheduleNext(0);
  runSweep();
  void drainAllOutboxes();

  return () => {
    // Best-effort flush before teardown. The scheduler restarts when the active
    // vault switches (AutoSync), and stop() must not silently drop a pending
    // edit for the kaata that was just active. pushVaultNow is safe post-stop.
    void drainAllOutboxes();
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
