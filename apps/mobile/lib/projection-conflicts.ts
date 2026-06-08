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
import { getActiveVaultIdSyncMaybe, getDb } from "./db-tx";

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
  refresh: () => Promise<void>;
} {
  const limit = opts.limit ?? 50;
  const activeVaultId = opts.vaultId === undefined ? getActiveVaultIdSyncMaybe() : opts.vaultId;
  const [unresolvedCount, setUnresolvedCount] = useState(0);
  const [rows, setRows] = useState<ProjectionConflictRow[]>([]);
  const appStateRef = useRef(AppState.currentState);

  const refresh = useMemo(() => {
    return async () => {
      if (!activeVaultId) {
        setUnresolvedCount(0);
        setRows([]);
        return;
      }
      try {
        const db = await getDb();
        const countRow = await db.getFirstAsync<{ n: number }>(
          `SELECT COUNT(*) AS n FROM projection_conflicts
            WHERE vault_id = ? AND resolved_at IS NULL`,
          activeVaultId,
        );
        const count = countRow?.n ?? 0;
        setUnresolvedCount(count);

        if (limit > 0 && count > 0) {
          const raw = await db.getAllAsync<{
            id: number;
            kind: string;
            vault_id: string | null;
            detail_json: string;
            created_at: number;
            resolved_at: number | null;
          }>(
            `SELECT id, kind, vault_id, detail_json, created_at, resolved_at
               FROM projection_conflicts
              WHERE vault_id = ? AND resolved_at IS NULL
              ORDER BY created_at DESC
              LIMIT ?`,
            activeVaultId,
            limit,
          );
          setRows(
            raw.map((r) => ({
              id: r.id,
              kind: r.kind,
              vault_id: r.vault_id,
              detail: safeParseDetail(r.detail_json),
              created_at: r.created_at,
              resolved_at: r.resolved_at,
            })),
          );
        } else {
          setRows([]);
        }
      } catch (err) {
        // SQLite hiccup — don't blow up the caller; next poll tick retries.
        console.warn("[projection-conflicts] refresh failed", err);
      }
    };
  }, [activeVaultId, limit]);

  useEffect(() => {
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
      void refresh();
    };
    listeners.add(onNotify);

    const sub = AppState.addEventListener("change", (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if (prev !== "active" && next === "active") void refresh();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      listeners.delete(onNotify);
      sub.remove();
    };
  }, [refresh]);

  return { unresolvedCount, rows, refresh };
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
