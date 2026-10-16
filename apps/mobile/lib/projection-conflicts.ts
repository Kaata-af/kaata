// projection_conflicts query API + React hook for the demotion-conflict
// surface (Phase 4).
//
// projection_conflicts rows are written by lib/sync/push.ts whenever the
// server returns a rejected[] item. kind='event_rejected_by_server' covers
// the demotion case: an event the local device authored as editor was
// rejected because the author's role was demoted (or revoked) before the
// event reached the server.
//
// UX contract:
//   1. As soon as new unresolved conflicts appear, surface a toast.
//   2. Tapping the toast routes to /projection-conflicts.
//   3. Each row exposes the rejected payload's salient values (amount, note)
//      for copy-paste recovery once the user's role is restored.
//   4. Marking resolved stamps resolved_at = Date.now() — rows aren't
//      deleted (audit + idempotency).
//
// ENG #11: reactive notification + AppState gating. lib/sync/push.ts calls
// notifyProjectionConflictsChanged() after inserting one or more rejected
// rows in its tx, which fires the in-process listener registry the hook
// subscribes to. We poll only as a safety net (60s, much slower than the
// pre-fix 5s) for the case where notifications were missed (cold-start
// race, AppState transition).

import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  getActiveVaultIdSyncMaybe,
  getDb,
  getSessionAccountIdSync,
  onAccountIdentityChanged,
} from "./db-tx";

// Lightweight in-process notifier. No emitter library — a Set of callbacks
// is enough for this single-event-type case. Callers (push.ts) invoke
// notifyProjectionConflictsChanged() AFTER their transaction commits so
// subscribers re-query and observe the new rows.
const listeners = new Set<() => void>();

export function notifyProjectionConflictsChanged(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn("[projection-conflicts] listener threw", err);
    }
  }
}

export type ProjectionConflictKind = "event_rejected_by_server" | string;

export type ProjectionConflictRow = {
  id: number;
  kind: ProjectionConflictKind;
  vault_id: string | null;
  detail: {
    event_id?: string;
    event_type?: string;
    reason?: string;
    current_role?: string | null;
    required_role?: string | null;
    [k: string]: unknown;
  };
  created_at: number;
  resolved_at: number | null;
};

// Slow-tick safety net. The hook is primarily driven by
// notifyProjectionConflictsChanged() — this interval only catches missed
// notifications (cold start, AppState background→active edge, etc).
// Pre-fix this was 5s which burned battery; 60s is plenty for a fallback.
const POLL_INTERVAL_MS = 60_000;

export function useProjectionConflicts(opts: { vaultId?: string | null; limit?: number } = {}): {
  unresolvedCount: number;
  rows: ProjectionConflictRow[];
  /** null until the first real database snapshot, never the initial empty render. */
  baselineId: number | null;
  scopeKey: string;
  refresh: () => Promise<void>;
} {
  const limit = opts.limit ?? 50;
  const activeVaultId = opts.vaultId === undefined ? getActiveVaultIdSyncMaybe() : opts.vaultId;
  const accountId = getSessionAccountIdSync();
  const [identityRevision, setIdentityRevision] = useState(0);
  const [, wakeScope] = useState(0);
  const scopeKey = JSON.stringify([accountId, activeVaultId, identityRevision]);
  const scopeRef = useRef({ key: scopeKey, generation: 0 });
  if (scopeRef.current.key !== scopeKey) {
    scopeRef.current = { key: scopeKey, generation: scopeRef.current.generation + 1 };
  }
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const baselineRef = useRef<{ scopeKey: string; promise: Promise<number> } | null>(null);
  const [snapshot, setSnapshot] = useState<{
    scopeKey: string;
    unresolvedCount: number;
    rows: ProjectionConflictRow[];
    baselineId: number;
  } | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const refresh = useMemo(() => {
    const generation = scopeRef.current.generation;
    return async () => {
      const sameScope = () =>
        mountedRef.current &&
        generation === scopeRef.current.generation &&
        scopeRef.current.key === scopeKey &&
        getSessionAccountIdSync() === accountId &&
        (opts.vaultId !== undefined || getActiveVaultIdSyncMaybe() === activeVaultId);
      if (!sameScope()) {
        if (
          mountedRef.current &&
          generation === scopeRef.current.generation &&
          scopeRef.current.key === scopeKey &&
          opts.vaultId === undefined &&
          getActiveVaultIdSyncMaybe() !== activeVaultId
        )
          wakeScope((value) => value + 1);
        return;
      }
      const request = ++requestRef.current;
      const current = () => request === requestRef.current && sameScope();
      try {
        if (!activeVaultId) {
          if (current()) setSnapshot({ scopeKey, unresolvedCount: 0, rows: [], baselineId: 0 });
          return;
        }
        const db = await getDb();
        if (!current()) return;
        if (baselineRef.current?.scopeKey !== scopeKey) {
          const promise: Promise<number> = db
            .getFirstAsync<{ max_id: number | null }>(
              "SELECT MAX(id) AS max_id FROM projection_conflicts WHERE vault_id = ?",
              activeVaultId,
            )
            .then((row) => row?.max_id ?? 0)
            .catch((error: unknown) => {
              if (baselineRef.current?.promise === promise) baselineRef.current = null;
              throw error;
            });
          baselineRef.current = { scopeKey, promise };
        }
        // Concurrent notifications share this first boundary. A new rejection
        // while the initial snapshot is loading must not become its baseline.
        const baselineId = await baselineRef.current.promise;
        if (!current()) return;
        const countRow = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM projection_conflicts
            WHERE vault_id = ? AND resolved_at IS NULL`,
          activeVaultId,
        );
        if (!current()) return;
        const count = countRow?.n ?? 0;
        let rows: ProjectionConflictRow[] = [];
        if (limit > 0 && count > 0) {
          const raw = await db.getAllAsync<{
            id: number;
            kind: string;
            vault_id: string | null;
            detail_json: string;
            created_at: number;
            resolved_at: number | null;
            event_type: string | null;
          }>(
            // Old push workers omitted event_type. Recover it from the exact
            // recorded event so internal membership churn is recognizable too.
            `SELECT c.id, c.kind, c.vault_id, c.detail_json, c.created_at, c.resolved_at,
                    e.event_type
               FROM projection_conflicts c
               LEFT JOIN event_log e ON e.vault_id = c.vault_id AND e.event_id =
                 CASE WHEN json_valid(c.detail_json) THEN json_extract(c.detail_json, '$.event_id') END
              WHERE c.vault_id = ? AND c.resolved_at IS NULL
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ?`,
            activeVaultId,
            limit,
          );
          rows = raw.map((r) => ({
            id: r.id,
            kind: r.kind,
            vault_id: r.vault_id,
            detail: {
              ...safeParseDetail(r.detail_json),
              ...(r.event_type ? { event_type: r.event_type } : {}),
            },
            created_at: r.created_at,
            resolved_at: r.resolved_at,
          }));
        }
        if (!current()) return;
        setSnapshot((previous) => ({
          scopeKey,
          unresolvedCount: count,
          rows,
          // MAX covers old rows outside the visible limit as well. Keep this
          // first snapshot's boundary through later refreshes and resolutions.
          baselineId: previous?.scopeKey === scopeKey ? previous.baselineId : baselineId,
        }));
      } catch (err) {
        // SQLite hiccup — don't blow up the caller; next poll tick retries.
        console.warn("[projection-conflicts] refresh failed", err);
      } finally {
        if (
          request === requestRef.current &&
          mountedRef.current &&
          opts.vaultId === undefined &&
          getActiveVaultIdSyncMaybe() !== activeVaultId
        )
          wakeScope((value) => value + 1);
      }
    };
  }, [activeVaultId, accountId, scopeKey, limit, opts.vaultId]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (appStateRef.current === "active") {
        await refresh();
      }
      if (cancelled) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();

    // Reactive path: push.ts notifies after committing rejected[] rows.
    const onNotify = () => {
      if (cancelled) return;
      if (appStateRef.current !== "active") return;
      if (opts.vaultId === undefined && getActiveVaultIdSyncMaybe() !== activeVaultId) {
        requestRef.current++;
        wakeScope((value) => value + 1);
        return;
      }
      void refresh();
    };
    listeners.add(onNotify);

    const sub = AppState.addEventListener("change", (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (prev !== "active" && next === "active") onNotify();
    });
    const stopIdentity = onAccountIdentityChanged(() => {
      // Invalidate synchronously: an account A -> B -> A switch can happen
      // before React renders, so comparing just the final account isn't enough.
      scopeRef.current.generation++;
      requestRef.current++;
      setIdentityRevision((value) => value + 1);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      requestRef.current++;
      if (timer) clearTimeout(timer);
      listeners.delete(onNotify);
      sub.remove();
      stopIdentity();
    };
  }, [refresh, activeVaultId, opts.vaultId]);

  const currentSnapshot = snapshot?.scopeKey === scopeKey ? snapshot : null;
  return {
    unresolvedCount: currentSnapshot?.unresolvedCount ?? 0,
    rows: currentSnapshot?.rows ?? [],
    baselineId: currentSnapshot?.baselineId ?? null,
    scopeKey,
    refresh,
  };
}

export async function markConflictResolved(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE projection_conflicts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL`,
    Date.now(),
    id,
  );
}

export async function markAllConflictsResolved(vaultId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE projection_conflicts SET resolved_at = ? WHERE vault_id = ? AND resolved_at IS NULL`,
    Date.now(),
    vaultId,
  );
}

function safeParseDetail(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
