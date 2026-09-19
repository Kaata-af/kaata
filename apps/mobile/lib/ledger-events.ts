// apps/mobile/lib/ledger-events.ts
//
// In-process "a ledger event was applied" notifier. Mirrors the Set-of-callbacks
// idiom in lib/projection-conflicts.ts (no emitter library, no dependency).
//
// TWO producers fire it, together covering every path that turns an event into a
// visible projection:
//   - applyEvent's post-commit (lib/projection/index.ts) — the DIRECT-apply path
//     (local writes, pull-based remote, backfill).
//   - the projection sweep (lib/projection/sweep.ts) — where MESH-ingested events
//     actually become projections (applyIncomingBatch ingests, then sweeps).
//
// Consumers:
//   - UI screens (home, person) via useLedgerRefresh → re-query so a synced tally
//     appears WITHOUT pull-to-refresh.
//   - btc-steady (push-on-write) → on a LOCAL write, dial peers immediately so
//     sync latency is ~1-3s instead of waiting for the 30s backstop poll. It
//     filters origin==="local" so a remote-applied event never triggers a
//     re-dial (which would ping-pong between two phones).

import { useEffect, useRef } from "react";
import { AppState } from "react-native";

export type LedgerOrigin = "local" | "remote" | "backfill";
type Listener = (vaultId: string, origin: LedgerOrigin) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns an unsubscribe fn. */
export function onLedgerApplied(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fire after a ledger event has been applied + committed for `vaultId`. */
export function emitLedgerApplied(vaultId: string, origin: LedgerOrigin): void {
  for (const fn of listeners) {
    try {
      fn(vaultId, origin);
    } catch (err) {
      if (__DEV__) console.warn("[ledger-events] listener threw", err);
    }
  }
}

// Coalescing window for a burst of applies. emitLedgerApplied fires once PER
// EVENT, so a sync that lands two hundred tallies used to call `reload` two
// hundred times, each one a fresh round of screen queries against the same
// database. Trailing edge, so the reload always reads the state AFTER the last
// event in the burst rather than somewhere in the middle. Short enough that a
// single local write still feels immediate.
const REFRESH_COALESCE_MS = 150;

/**
 * Re-run `reload` whenever the ledger projection changes for the visible vault.
 * Bursts are coalesced, a reload owed from the background is paid on the next
 * foreground (see the AppState listener), and the subscription is
 * vault-filtered. Pass activeVaultId=null to refresh on any vault's change —
 * which is what a screen showing a CROSS-VAULT list must do, since a change to
 * a vault that isn't the active one still changes what it renders.
 *
 * `reload` is held in a ref and the subscription keys only on activeVaultId, so
 * an unstable callback no longer resubscribes. That is not just tidiness: with
 * `reload` in the dep array, a new callback identity tore down the effect, and
 * the cleanup would discard a coalesced reload that had not fired yet.
 */
export function useLedgerRefresh(activeVaultId: string | null, reload: () => void): void {
  const appState = useRef(AppState.currentState);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const missedWhileAway = useRef(false);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  });
  useEffect(() => {
    const schedule = () => {
      if (timer.current != null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        reloadRef.current();
      }, REFRESH_COALESCE_MS);
    };
    const sub = AppState.addEventListener("change", (next) => {
      const wasAway = appState.current !== "active";
      appState.current = next;
      // Catch up on anything applied while we were in the background.
      //
      // The foreground gate below used to be justified by "a backgrounded
      // screen re-queries on refocus anyway". That is not true of the screen
      // that was already focused when the app went away: expo-router fires a
      // focus effect on NAVIGATION, and returning from the background is not
      // navigation, so nothing re-ran. A sync that landed while the phone was
      // locked therefore stayed invisible until the user navigated somewhere
      // and came back.
      if (next === "active" && wasAway && missedWhileAway.current) {
        missedWhileAway.current = false;
        schedule();
      }
    });
    const unsub = onLedgerApplied((vaultId) => {
      if (activeVaultId && vaultId !== activeVaultId) return;
      if (appState.current !== "active") {
        // Still skip the reload itself — querying for a screen nobody is
        // looking at is wasted work — but remember that we owe one.
        missedWhileAway.current = true;
        return;
      }
      schedule();
    });
    return () => {
      sub.remove();
      unsub();
      // Drop a pending reload when the subscription goes away: firing it would
      // call back into a screen that is gone.
      if (timer.current != null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [activeVaultId]);
}
