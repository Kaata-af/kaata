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

/**
 * Re-run `reload` whenever the ledger projection changes for the visible vault.
 * Foreground-gated (a backgrounded screen re-queries on refocus anyway) and
 * vault-filtered. Pass activeVaultId=null to refresh on any vault's change.
 * `reload` should be a stable useCallback so the effect doesn't churn.
 */
export function useLedgerRefresh(activeVaultId: string | null, reload: () => void): void {
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      appState.current = next;
    });
    const unsub = onLedgerApplied((vaultId) => {
      if (appState.current !== "active") return;
      if (activeVaultId && vaultId !== activeVaultId) return;
      reload();
    });
    return () => {
      sub.remove();
      unsub();
    };
  }, [activeVaultId, reload]);
}
