// Pull events from the server. Loops with the cursor (sync_state.
// last_pulled_server_seq) until the server returns has_more=false. Each page is
// DURABLY INGESTED into event_log (applied_at=NULL) via the shared ingest path
// (lib/projection/ingest-row.ts), THEN — after the full drain — applied by one
// sweep pass. The cursor advances on DURABLE INGESTION, never on apply success,
// so an event that can't apply yet (missing person/relationship, un-healed
// membership chain) is quarantined-and-retried by the sweep instead of being
// rolled back and skipped (the old applyEvent-direct path's permanent-loss bug).
//
// Ingestion is idempotent by event_id (INSERT OR IGNORE), so a crash between
// "page ingested" and "cursor advanced" just re-ingests the page on next pull —
// the projection is unchanged.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import {
  ingestPulledEvents,
  mapPulledWireToEvent,
  type PulledWireEvent,
} from "../projection/ingest-row";
import { sweepVaultNow } from "../projection/sweep";
import { getLastPulledServerSeq, setLastPulledServerSeq } from "./cursor";
import {
  SessionExpiredError,
  SyncTimeoutError,
  SyncTransientError,
  VaultNotRegisteredError,
} from "./errors";

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
  // Sync v2 M1: author-assigned sequence; null for legacy rows the server
  // stored before migration. Stored verbatim — never recomputed for
  // remote-origin events (the author is the only assignment authority).
  author_seq?: number | null;
  // M2 (review P0): the Ed25519 envelope signature the server now persists
  // and returns. The chain verifier + role-gate need it to verify and honor
  // membership events on the HTTPS channel. Null for pre-M2 legacy rows.
  event_sig_b64?: string | null;
  signer_device_pubkey?: string | null;
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
  //
  // Each page is DURABLY INGESTED (ingestBatch → event_log rows, applied_at
  // NULL) before the cursor advances — so the cursor is a "durably-ingested"
  // watermark and can never skip an event that isn't on disk. The actual apply
  // happens via the sweep AFTER the full drain (one fixpoint pass that resolves
  // create-before-amend / membership-before-entry ordering at once), so a page
  // whose person hasn't arrived yet doesn't block the entries that depend on it.
  let ingestedAny = false;
  for (;;) {
    const batch = await fetchOnePage(baseUrl, jwt, vaultId, cursor, DEFAULT_BATCH_LIMIT);

    if (batch.events.length > 0) {
      await ingestBatch(vaultId, batch.events);
      ingestedAny = true;
      totalPulled += batch.events.length;
    }

    if (batch.next_after_server_seq > cursor) {
      cursor = batch.next_after_server_seq;
      await setLastPulledServerSeq(vaultId, cursor);
    }

    if (!batch.has_more) break;
  }

  // Apply everything we just ingested. Best-effort: the rows are durable, so a
  // sweep failure here only defers application to the next debounced /
  // cold-launch / foreground sweepAllQuarantinedVaults — never loses data.
  if (ingestedAny) {
    try {
      await sweepVaultNow(vaultId);
    } catch (err) {
      console.warn(`[sync.pull] post-pull sweep failed for ${vaultId.slice(0, 8)}`, err);
    }
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
  // 403 = the server has no accepted owner membership for this vault yet (it was
  // never registered via POST /v1/vaults). Type it so the scheduler kicks a
  // registration sweep + retries on the normal cadence instead of treating it as
  // an "unexpected" error (blind backoff + a crash report every tick) — and so a
  // pre-registration tick doesn't bury the cycle before push can stamp the
  // backup indicator. The scheduler registers the active vault before pulling
  // (see syncOnce → ensureVaultRegistered), so this is the residual safety net.
  if (res.status === 403) {
    throw new VaultNotRegisteredError();
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

// Durably INGEST one pulled page into event_log (applied_at=NULL). NO apply
// here — apply is the sweep's job after the full drain. This is the crux of the
// data-loss fix: an event that can't apply yet (its person/relationship hasn't
// arrived, the membership chain hasn't healed) still lands as a durable row and
// is retried by the sweep, instead of throwing inside applyEvent — which used
// to roll back the event_log INSERT and let the cursor skip it forever.
//
// ingestPulledEvents serializes the whole page in one transaction under
// applyEventMutex, marks each row server_acked (it IS on the server — we just
// pulled it) so it never re-pushes, and back-fills author_seq onto any
// pre-existing duplicate row.
async function ingestBatch(vaultId: string, wireEvents: WirePulledEvent[]): Promise<void> {
  const now = Date.now();
  const events = wireEvents.map((w) =>
    mapPulledWireToEvent(w as unknown as PulledWireEvent, vaultId),
  );
  await ingestPulledEvents(events, now);
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
