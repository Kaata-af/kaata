// Pull events from the server. Loops with the cursor (sync_state.
// last_pulled_server_seq) until the server returns has_more=false, applying
// each batch via applyEvent({origin: 'remote'}). After each batch commits,
// we advance the cursor.
//
// applyEvent is idempotent by event_id, so a crash between "batch applied"
// and "cursor advanced" just re-applies the batch on next pull — the
// projection is unchanged.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { getDb } from "../db-tx";
import type { LedgerEvent } from "../events";
import { isKnownEventType } from "../events";
import { applyEvent } from "../projection";
import { getLastPulledServerSeq, setLastPulledServerSeq } from "./cursor";
import { SessionExpiredError, SyncTimeoutError, SyncTransientError } from "./errors";

const PULL_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 200;

type WirePulledEvent = {
  event_id: string;
  hlc: { pms: number; l: number; did: string };
  device_id: string;
  account_id: string | null;
  target_id: string | null;
  relationship_id: string | null;
  event_type: string;
  schema_version: number;
  payload: unknown;
  server_seq: number;
  server_received_at: string;
};

type PullResponse = {
  vault_id: string;
  events: WirePulledEvent[];
  has_more: boolean;
  next_after_server_seq: number;
  server_time: string;
};

export type PullResult = { pulled: number };

export async function pullEvents(vaultId: string): Promise<PullResult> {
  const jwt = await getSessionJWT();
  if (!jwt) {
    return { pulled: 0 };
  }

  const baseUrl = await getBackendUrl();
  let cursor = await getLastPulledServerSeq(vaultId);
  let totalPulled = 0;

  // Drain to has_more=false. The scheduler will catch SessionExpired /
  // transient errors and back off.
  for (;;) {
    const batch = await fetchOnePage(baseUrl, jwt, vaultId, cursor, DEFAULT_BATCH_LIMIT);

    if (batch.events.length > 0) {
      await applyBatch(vaultId, batch.events);
      totalPulled += batch.events.length;
    }

    if (batch.next_after_server_seq > cursor) {
      cursor = batch.next_after_server_seq;
      await setLastPulledServerSeq(vaultId, cursor);
    }

    if (!batch.has_more) break;
  }

  return { pulled: totalPulled };
}

async function fetchOnePage(
  baseUrl: string,
  jwt: string,
  vaultId: string,
  afterServerSeq: number,
  limit: number,
): Promise<PullResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PULL_TIMEOUT_MS);

  const url =
    `${baseUrl}/v1/sync/pull` +
    `?vault_id=${encodeURIComponent(vaultId)}` +
    `&after_server_seq=${afterServerSeq}` +
    `&limit=${limit}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        Authorization: `Bearer ${jwt}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new SyncTimeoutError("pull request timed out");
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
    throw new Error(`pull failed: ${res.status}`);
  }

  const body = (await res.json()) as PullResponse;
  return {
    vault_id: body.vault_id,
    events: Array.isArray(body.events) ? body.events : [],
    has_more: Boolean(body.has_more),
    next_after_server_seq:
      typeof body.next_after_server_seq === "number" ? body.next_after_server_seq : afterServerSeq,
    server_time: body.server_time,
  };
}

async function applyBatch(vaultId: string, wireEvents: WirePulledEvent[]): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  for (const w of wireEvents) {
    if (!isKnownEventType(w.event_type)) {
      // Unknown event types from a future client build land here.
      continue;
    }

    // Server returns target_id / relationship_id as top-level envelope
    // fields (added in the Phase 3 schema migration that introduced the
    // columns). Every applier keyed off envelope target_id —
    // entry_amended / entry_deleted / person_renamed / person_archived /
    // person_phone_changed / shop_profile_updated — silently no-ops if
    // these are empty, so the projection would diverge from the server's
    // view. Trust the wire here.
    const event = {
      event_id: w.event_id,
      event_type: w.event_type,
      vault_id: vaultId,
      target_id: w.target_id ?? "",
      relationship_id: w.relationship_id ?? null,
      hlc: w.hlc,
      device_id: w.device_id,
      author_user_id_local_only: "",
      actor_account_id: w.account_id ?? null,
      payload: w.payload,
      payload_schema: w.schema_version,
      appended_at: now,
      server_acked_at: now,
      rejected_at: null,
      origin: "remote" as const,
    } as unknown as LedgerEvent;

    try {
      await applyEvent(event, { origin: "remote" });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[sync.pull] applyEvent failed for ${w.event_id} (${w.event_type})`, err);
    }
  }

  // For pulled events that ended up in event_log without a stamp (e.g. a
  // duplicate INSERT OR IGNORE matched an already-existing locally-authored
  // row), patch server_acked_at so they don't get pushed again.
  await db.withTransactionAsync(async () => {
    for (const w of wireEvents) {
      await db.runAsync(
        `UPDATE event_log SET server_acked_at = ?
          WHERE event_id = ? AND server_acked_at IS NULL`,
        now,
        w.event_id,
      );
    }
  });
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
