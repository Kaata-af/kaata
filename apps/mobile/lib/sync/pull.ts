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
import { healActiveVaultId } from "../db";
import { getAccountIdSync, getDb } from "../db-tx";
import { resolveAccountIdCandidates } from "../effective-account";
import {
  ingestPulledEvents,
  mapPulledWireToEvent,
  type PulledWireEvent,
} from "../projection/ingest-row";
import { invalidateVaultRoleCache } from "../use-vault-role";
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
  // 403 has TWO distinct meanings, disambiguated by the body's error_code:
  //
  //   "vault_unknown" (or a legacy bodyless 403) → the server has no accepted
  //     owner membership for this vault yet (never registered via POST
  //     /v1/vaults). Typed so the scheduler kicks a registration sweep +
  //     retries on the normal cadence instead of treating it as "unexpected"
  //     (blind backoff + a crash report every tick) — and so a pre-registration
  //     tick doesn't bury the cycle before push can stamp the backup indicator.
  //     The scheduler registers the active vault before pulling (see syncOnce →
  //     ensureVaultRegistered), so this is the residual safety net.
  //
  //   "not_member" → the vault EXISTS server-side and OUR membership is
  //     revoked. This is the only channel by which a removed member's device
  //     can learn of its own removal: the server revokes the ACL row in the
  //     same tx that stores the vault_member_removed event, so this device
  //     403s before it could ever pull that event. Without local handling the
  //     app kept showing editor role and accepted writes that could never sync
  //     — silent permanent divergence. Mark our own mirror row revoked (flag
  //     only, ZERO ledger-data deletion) so the existing left-vault
  //     affordances take over, then fall through to the same soft error so
  //     the scheduler stays on the normal cadence (no hot retry, no crash
  //     report).
  if (res.status === 403) {
    let code = "";
    try {
      const parsed = (await res.json()) as { error?: string; error_code?: string };
      code = parsed.error_code ?? "";
    } catch {
      // Legacy backend / non-JSON body — indistinguishable, keep the
      // registration-pending interpretation.
    }
    if (code === "not_member") {
      await markSelfMembershipRevoked(vaultId).catch((err) => {
        // Best-effort: a failed mirror write must not mask the 403 flow —
        // the next pull of this vault retries the revoke.
        if (__DEV__) console.warn("[sync.pull] self-revoke mirror write failed", err);
      });
      throw new VaultNotRegisteredError("membership revoked on server");
    }
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

// Server said "not_member": revoke OUR OWN vault_members_mirror row so the
// device converges with the server's ACL. Guarded to rows that exist and are
// still active — a vault we never had a local membership row for (shouldn't
// happen for a not_member 403, but stay conservative) is left untouched. The
// write matches applyVaultMemberRemoved's mirror semantics (set revoked_at,
// never delete), and reuses the existing left-vault affordances end-to-end:
// listActiveVaults excludes revoked-membership vaults from the switcher, and
// healActiveVaultId moves the active pointer off the vault (so the scheduler's
// per-tick pull stops targeting it — back to syncing the surviving vaults).
// All ledger rows, events, and the vaults row itself are preserved.
export async function markSelfMembershipRevoked(vaultId: string): Promise<void> {
  const candidates = await resolveAccountIdCandidates(getAccountIdSync());
  if (candidates.length === 0) return;
  const db = await getDb();
  const placeholders = candidates.map(() => "?").join(",");
  const result = await db.runAsync(
    `UPDATE vault_members_mirror
        SET revoked_at = ?
      WHERE vault_id = ?
        AND account_id IN (${placeholders})
        AND revoked_at IS NULL`,
    Date.now(),
    vaultId,
    ...candidates,
  );
  if (result.changes === 0) return; // no active local membership — nothing to flip
  console.warn(`[sync.pull] server revoked our membership for ${vaultId.slice(0, 8)} — mirrored`);
  // Flip role-gated UI (useVaultRole / useActiveVaultCanWrite) on next render,
  // then repair the active-vault pointer immediately instead of waiting for
  // the next launch's heal pass.
  invalidateVaultRoleCache(vaultId);
  await healActiveVaultId();
}

function parseRetryAfter(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  return null;
}
