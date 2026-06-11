// Push the local outbox to the server. Reads every event_log row for the
// active vault that has neither server_acked_at nor rejected_at set, posts
// them as a single batch to /v1/sync/push, and on response:
//
//   accepted[]   → stamp server_acked_at = Date.now() on those rows
//   duplicates[] → same as accepted (the server already has them; our local
//                  flag is wrong and we're correcting it)
//   rejected[]   → stamp rejected_at = Date.now() AND insert a
//                  projection_conflicts row so the local projection can be
//                  reconciled (or surfaced to the user) on next read
//
// Per plan: pull-then-push ordering is enforced by the scheduler.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { getDb, getInstallIdSync } from "../db-tx";
import { notifyProjectionConflictsChanged } from "../projection-conflicts";
import { markPushDone } from "./cursor";
import {
  PermissionRejectedError,
  SessionExpiredError,
  SyncTimeoutError,
  SyncTransientError,
} from "./errors";

const PUSH_TIMEOUT_MS = 30_000;
// Max events per push request. The backend caps decompressed body at 16 MiB;
// the average event payload is well under 1 KiB so 500 is a safe ceiling.
const MAX_BATCH_SIZE = 500;

type EventRow = {
  event_id: string;
  event_type: string;
  vault_id: string | null;
  target_id: string;
  relationship_id: string | null;
  hlc_physical_ms: number;
  hlc_logical: number;
  hlc_device_id: string;
  device_id: string;
  author_user_id_local_only: string;
  actor_account_id: string | null;
  payload_json: string;
  payload_schema: number;
  appended_at: number;
};

type WireEvent = {
  event_id: string;
  event_type: string;
  schema_version: number;
  target_id: string | null;
  relationship_id: string | null;
  hlc: { physical_ms: number; logical: number; device_id: string };
  actor_account_id: string | null;
  payload: unknown;
};

type PushResponse = {
  accepted: Array<{ event_id: string; server_seq: number }>;
  duplicates: string[];
  rejected: Array<{
    event_id: string;
    reason: string;
    current_role?: string;
    required_role?: string;
  }>;
  vault_server_seq_high: number;
};

export type PushResult = {
  pushed: number;
  duplicates: number;
  rejected: number;
};

export async function pushEvents(vaultId: string): Promise<PushResult> {
  const jwt = await getSessionJWT();
  if (!jwt) {
    // Local-only user. Silent no-op — sync only runs after Google sign-in.
    return { pushed: 0, duplicates: 0, rejected: 0 };
  }

  const db = await getDb();
  const rows = await db.getAllAsync<EventRow>(
    // Migration 014 (Mythos round-3): also exclude tombstoned rows.
    // Tombstoned events are locally-believed-bad-signature or schema-
    // invalid; pushing them is wasteful and surfaces noise to the
    // server. The idx_event_log_unsynced partial index (migration 005)
    // doesn't include tombstone_reason yet, so the planner picks up
    // the index then filters in memory. A follow-up index migration
    // could fold tombstone_reason into the partial predicate.
    `SELECT event_id, event_type, vault_id, target_id, relationship_id,
            hlc_physical_ms, hlc_logical, hlc_device_id,
            device_id, author_user_id_local_only, actor_account_id,
            payload_json, payload_schema, appended_at
       FROM event_log
      WHERE vault_id = ?
        AND server_acked_at IS NULL
        AND rejected_at IS NULL
        AND tombstone_reason IS NULL
      ORDER BY hlc_physical_ms ASC, hlc_logical ASC, hlc_device_id ASC
      LIMIT ?`,
    vaultId,
    MAX_BATCH_SIZE,
  );

  if (rows.length === 0) {
    return { pushed: 0, duplicates: 0, rejected: 0 };
  }

  const events: WireEvent[] = rows.map((r) => ({
    event_id: r.event_id,
    event_type: r.event_type,
    schema_version: r.payload_schema,
    target_id: r.target_id,
    relationship_id: r.relationship_id,
    hlc: {
      physical_ms: r.hlc_physical_ms,
      logical: r.hlc_logical,
      device_id: r.hlc_device_id,
    },
    actor_account_id: r.actor_account_id,
    payload: safeParseJSON(r.payload_json),
  }));

  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        vault_id: vaultId,
        device_id: getInstallIdSync(),
        events,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new SyncTimeoutError("push request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new SessionExpiredError();
  }
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    throw new SyncTransientError(res.status, retryAfter);
  }
  if (!res.ok) {
    throw new Error(`push failed: ${res.status}`);
  }

  const body = (await res.json()) as PushResponse;
  const acceptedSet = new Set((body.accepted ?? []).map((a) => a.event_id));
  const duplicatesSet = new Set(body.duplicates ?? []);
  const rejectedList = body.rejected ?? [];

  const now = Date.now();
  let hadPermissionRejection = false;

  await db.withTransactionAsync(async () => {
    for (const eventId of acceptedSet) {
      await db.runAsync(
        "UPDATE event_log SET server_acked_at = ? WHERE event_id = ?",
        now,
        eventId,
      );
    }
    for (const eventId of duplicatesSet) {
      await db.runAsync(
        "UPDATE event_log SET server_acked_at = ? WHERE event_id = ?",
        now,
        eventId,
      );
    }
    for (const r of rejectedList) {
      await db.runAsync("UPDATE event_log SET rejected_at = ? WHERE event_id = ?", now, r.event_id);
      await db.runAsync(
        `INSERT INTO projection_conflicts (kind, detail_json, vault_id, created_at)
         VALUES (?, ?, ?, ?)`,
        "event_rejected_by_server",
        JSON.stringify({
          event_id: r.event_id,
          reason: r.reason,
          current_role: r.current_role ?? null,
          required_role: r.required_role ?? null,
        }),
        vaultId,
        now,
      );
      if (r.reason === "insufficient_role") {
        hadPermissionRejection = true;
      }
    }
  });

  // Stamp last_push_at for the indicator widget.
  await markPushDone(vaultId);

  // ENG #11: reactively notify subscribers after the tx commits so the
  // UI (badge / toast / conflicts list) updates without waiting for a
  // poll tick. We notify only when rejected[] is non-empty to avoid
  // burning a re-render on every routine push.
  if (rejectedList.length > 0) {
    notifyProjectionConflictsChanged();
  }

  if (hadPermissionRejection) {
    throw new PermissionRejectedError("one or more events rejected with insufficient_role");
  }

  return {
    pushed: acceptedSet.size,
    duplicates: duplicatesSet.size,
    rejected: rejectedList.length,
  };
}

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
