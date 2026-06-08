// apps/mobile/lib/mesh/scheduler.ts
//
// Phase 5.1 dial scheduler: per-peer retry accounting wrapped around
// dialPeerWithRetry. Used by index.ts to back off cleanly when a peer
// can't be reached, rather than re-dialing on every discovery tick.
//
// LIFECYCLE
//   - reportSuccess(serviceName)  → clear retry state
//   - shouldAttempt(serviceName)  → false if last-failure window not yet expired
//   - reportFailure(serviceName)  → bump retry counter, set next-allowed time
//   - reset()                     → on shop_mode toggle off
//
// This module is purely in-memory. It is reset whenever startShopMode runs
// (a fresh discovery cycle); persistent backoff across app launches is
// intentionally NOT done — the founder will toggle Shop Mode on/off
// frequently in early field testing, and a sticky backoff would be
// frustrating ("why isn't this finding my other phone?").

import type { PeerHint } from "./transport";
import { dialPeerWithRetry, type MeshConnection } from "./transport";

// First failure → 30s wait. Doubles each subsequent failure up to a cap.
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
// Give-up entirely after this many failures in a row; next discovery
// cycle (after Shop Mode toggle) resets.
const FAILURE_GIVE_UP_AFTER = 6;

type PeerState = {
  failureCount: number;
  nextAllowedAt: number;
};

const state = new Map<string, PeerState>();

export function reset(): void {
  state.clear();
}

export function shouldAttempt(serviceName: string): boolean {
  const s = state.get(serviceName);
  if (!s) return true;
  if (s.failureCount >= FAILURE_GIVE_UP_AFTER) return false;
  return Date.now() >= s.nextAllowedAt;
}

export function reportSuccess(serviceName: string): void {
  state.delete(serviceName);
}

export function reportFailure(serviceName: string): void {
  const prev = state.get(serviceName);
  const failureCount = (prev?.failureCount ?? 0) + 1;
  const wait = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (failureCount - 1), FAILURE_BACKOFF_MAX_MS);
  state.set(serviceName, {
    failureCount,
    nextAllowedAt: Date.now() + wait,
  });
}

/**
 * dialPeerScheduled — gate dialPeerWithRetry through the scheduler so
 * repeated failures don't hammer a dead peer.
 */
export async function dialPeerScheduled(
  serviceName: string,
  peer: PeerHint,
): Promise<MeshConnection> {
  if (!shouldAttempt(serviceName)) {
    throw new Error(`dialPeerScheduled: backed off for ${serviceName}`);
  }
  try {
    const conn = await dialPeerWithRetry(peer);
    reportSuccess(serviceName);
    return conn;
  } catch (e) {
    reportFailure(serviceName);
    throw e;
  }
}
