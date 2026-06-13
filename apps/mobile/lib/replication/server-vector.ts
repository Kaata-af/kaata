// Server-channel adapter for the replication engine (Sync v2 M1).
//
// M1 ROLE — ADVISORY ONLY (docs/sync-v2-architecture.md §5, §9-M1): the
// per-row outbox flags (server_acked_at IS NULL) remain the push truth and
// the server_seq cursor remains the pull truth. This module fetches the
// server's per-author vector and reports divergence so we can (a) watch the
// new bookkeeping converge in the field before M3 makes it load-bearing,
// and (b) catch relay holes the moment they exist instead of when a user
// notices missing entries.

import { getBackendUrl } from "../api";
import { getSessionJWT } from "../auth";
import { SessionExpiredError, SyncTimeoutError, SyncTransientError } from "../sync/errors";
import { diffVectors, type PeerVector } from "./planner";
import { localFrontierReport } from "./store";

const VECTOR_TIMEOUT_MS = 15_000;

export type ServerVectorResponse = {
  device_vectors: PeerVector;
  vault_server_seq_high: number;
};

export async function fetchServerVector(vaultId: string): Promise<ServerVectorResponse> {
  const jwt = await getSessionJWT();
  if (!jwt) throw new SessionExpiredError();

  const baseUrl = await getBackendUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VECTOR_TIMEOUT_MS);

  // Body read stays INSIDE the abort window — on a stalled connection the
  // headers can arrive and then the body trickle forever; the timer must
  // cover both (the AbortSignal cancels an in-flight body read too).
  try {
    const res = await fetch(`${baseUrl}/v1/sync/vector?vault_id=${encodeURIComponent(vaultId)}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      signal: controller.signal,
    });

    if (res.status === 401) throw new SessionExpiredError();
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      throw new SyncTransientError(res.status, null);
    }
    if (!res.ok) throw new Error(`vector failed: ${res.status}`);

    const body = (await res.json()) as ServerVectorResponse;
    return {
      device_vectors: body.device_vectors ?? {},
      vault_server_seq_high:
        typeof body.vault_server_seq_high === "number" ? body.vault_server_seq_high : 0,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new SyncTimeoutError("vector request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type ConvergenceReport = {
  /** Authors where we hold more than the server can prove — normal when the
   *  outbox has unpushed rows; suspicious if it persists across cycles. */
  localAhead: number;
  /** Authors where the server provably holds more than us AFTER a completed
   *  pull — indicates a pull-path hole; always worth a warning. */
  peerAhead: number;
  /** Authors whose server aggregate can't prove a contiguous prefix
   *  (legacy NULL-seq rows / relay gaps) — expected during M1→M3. */
  unprovable: number;
  /** Local non-contiguous author ranges (relay died mid-stream). */
  localGapCount: number;
};

/**
 * Best-effort convergence check, run AFTER a completed pull+push cycle.
 * Never throws into the sync loop — sync correctness must not depend on an
 * advisory endpoint.
 */
export async function checkConvergence(vaultId: string): Promise<ConvergenceReport | null> {
  try {
    const [server, localReport] = await Promise.all([
      fetchServerVector(vaultId),
      localFrontierReport(vaultId),
    ]);
    const { vector: local, gaps } = localReport;
    const diff = diffVectors(local, server.device_vectors);
    const report: ConvergenceReport = {
      localAhead: diff.localAhead.length,
      peerAhead: diff.peerAhead.length,
      unprovable: diff.unprovable.length,
      localGapCount: gaps.length,
    };
    // Only peerAhead is alarm-worthy in M1: the server provably holds
    // events our completed pull didn't deliver. Local gaps are EXPECTED on
    // snapshot-bootstrapped replicas (they hold projection + tail, not the
    // full log — history below the snapshot floor looks like a "gap" to
    // the vector until M3's history-bootstrap defines the epoch boundary),
    // so they log at dev level only.
    if (report.peerAhead > 0) {
      console.warn(
        `[replication] divergence vault=${vaultId} peerAhead=${JSON.stringify(diff.peerAhead)}`,
      );
    } else if (__DEV__ && report.localGapCount > 0) {
      console.log(`[replication] local gaps (expected post-restore) vault=${vaultId}`, gaps);
    }
    return report;
  } catch (err) {
    if (__DEV__) console.warn("[replication] convergence check failed", err);
    return null;
  }
}
