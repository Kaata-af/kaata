// apps/mobile/lib/tabs/events.ts
//
// In-process "a tab changed" notifier — the Set-of-callbacks idiom of
// lib/ledger-events.ts and lib/checkin-trigger.ts, kept in its own
// dependency-free module for one reason: lib/tabs/db.ts fires it and
// lib/tabs/sync.ts re-exports the subscribe half, and lib/db.ts imports
// lib/tabs/db.ts. If the emitter lived in sync.ts, loading lib/db.ts would
// drag in AppState / expo-network / the auth module — which breaks every
// Node selftest that loads the real lib/db.ts (person-save) and adds a
// db ↔ sync cycle for nothing.
//
// Consumers: the person screen (reload on origin "pull"), the UI wave's
// lib/tabs/notify.ts (local notification when counterparty activity lands
// while the app is not active) and the selftest.

import type { TabAppliedEvent } from "./types";

type Listener = (ev: TabAppliedEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns an unsubscribe fn. */
export function onTabApplied(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Fire AFTER the tab cache write committed, so subscribers read committed state. */
export function emitTabApplied(ev: TabAppliedEvent): void {
  // Snapshot so a listener that unsubscribes mid-iteration can't mutate the set
  // we're walking (checkin-trigger.ts precedent).
  for (const fn of [...listeners]) {
    try {
      fn(ev);
    } catch (err) {
      console.warn("[tabs] onTabApplied listener threw", err);
    }
  }
}
