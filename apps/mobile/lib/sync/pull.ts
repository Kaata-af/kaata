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
import { applyEvent, applyEventMutex } from "../projection";
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
      author_seq: sanitizeAuthorSeq(w.author_seq),
      // M2: carry the signature so the role-gate can authenticate membership
      // events pulled over HTTPS (and the chain verifier can fold them).
      event_sig_b64: typeof w.event_sig_b64 === "string" ? w.event_sig_b64 : null,
      signer_device_pubkey:
        typeof w.signer_device_pubkey === "string" ? w.signer_device_pubkey : null,
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
  // row), patch server_acked_at so they don't get pushed again. Same pass
  // backfills author_seq onto rows that pre-exist WITHOUT one (a mesh-
  // ingested copy arrived before the author's seq reached us via the
  // server) — the author's assignment is authoritative, and without this
  // the row stays invisible to the version vector forever. UPDATE OR
  // IGNORE: if another row already holds that (vault, device, seq) slot
  // (legacy backfill divergence), keep ours NULL rather than corrupt the
  // unique index — the advisory vector simply keeps understating until M3
  // gap-repair.
  // Serialized behind the same mutex as applyEvent — expo-sqlite's
  // withTransactionAsync is non-exclusive and this patch tx must not
  // interleave with a concurrent user-save transaction.
  await applyEventMutex.runExclusive(() =>
    db.withTransactionAsync(async () => {
      for (const w of wireEvents) {
        await db.runAsync(
          `UPDATE event_log SET server_acked_at = ?
            WHERE event_id = ? AND server_acked_at IS NULL`,
          now,
          w.event_id,
        );
        const wireSeq = sanitizeAuthorSeq(w.author_seq);
        if (wireSeq != null) {
          await db.runAsync(
            `UPDATE OR IGNORE event_log SET author_seq = ?
              WHERE event_id = ? AND author_seq IS NULL`,
            wireSeq,
            w.event_id,
          );
        }
      }
    }),
  );
}

// Author seqs are positive integers by contract. The M1 backend enforces
// this on push, but this replica must not trust any wire blindly — M3's
// untrusted mesh peers feed the same envelope path, and computeContiguous
// is only defined over 1..n.
function sanitizeAuthorSeq(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
