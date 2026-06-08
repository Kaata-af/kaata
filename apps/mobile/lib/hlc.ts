// Hybrid Logical Clock (HLC). Combines wall-clock physical_ms with a logical
// counter and a device id, so events from offline devices reconverging later
// can be totally ordered without a central coordinator.
//
// Shape:
//   pms — physical milliseconds at the originating device (Date.now())
//   l   — logical counter that increments when two events land in the same ms
//   did — device id (install_id) for the deterministic tiebreak when even the
//         counters collide
//
// Same family as CockroachDB / MongoDB's HLC. The single source of causal
// ordering across the entire system; UUIDs are random and carry no order.
//
// This file is pure functions only. Persistence and the "tick inside the
// same SQLite transaction as the event_log INSERT" rule lands in
// lib/event-log.ts alongside migration 005.

export type HLC = {
  pms: number;
  l: number;
  did: string;
};

// Cap on how far ahead of local wall-clock a peer's pms is allowed to drag
// our cursor. Without this, a single device with a wrong NTP setting
// permanently corrupts everyone's HLC frontier on first sync. 60s is enough
// to absorb realistic NTP-correction drift while rejecting clearly-broken
// clocks. Transport-layer rejects anything beyond a separate 24h hard cap.
export const MAX_FORWARD_DRIFT_MS = 60_000;

const initial = (deviceId: string): HLC => ({ pms: 0, l: 0, did: deviceId });

// Tick on locally-originated event. Most common path — called inside the
// same transaction as the event_log INSERT.
export function tickLocal(prev: HLC | null, nowMs: number, deviceId: string): HLC {
  const last = prev ?? initial(deviceId);
  if (nowMs > last.pms) {
    return { pms: nowMs, l: 0, did: deviceId };
  }
  // Wall clock equals or trails last seen — likely two events in the same ms,
  // or NTP correction pulled the clock backwards. Stay at last.pms and bump l.
  return { pms: last.pms, l: last.l + 1, did: deviceId };
}

// Tick on receiving an event from another device (via sync or mesh). Merges
// the remote frontier so the next local tick can't produce a timestamp that
// would sort before the event we just received.
export function tickReceive(prev: HLC | null, remote: HLC, nowMs: number, deviceId: string): HLC {
  const last = prev ?? initial(deviceId);

  // Forward-drift clamp — a peer whose clock is wildly ahead is treated as
  // arriving "now" rather than its claimed timestamp.
  const remotePms = remote.pms - nowMs > MAX_FORWARD_DRIFT_MS ? nowMs : remote.pms;

  const maxPms = Math.max(nowMs, last.pms, remotePms);

  if (maxPms > last.pms && maxPms > remotePms) {
    return { pms: maxPms, l: 0, did: deviceId };
  }
  if (maxPms === last.pms && maxPms === remotePms) {
    return { pms: maxPms, l: Math.max(last.l, remote.l) + 1, did: deviceId };
  }
  if (maxPms === last.pms) {
    return { pms: last.pms, l: last.l + 1, did: deviceId };
  }
  // maxPms === remotePms > last.pms
  return { pms: remotePms, l: remote.l + 1, did: deviceId };
}

// Total ordering of HLCs. Primary physical, secondary logical, tertiary device
// id lexicographic. Random UUIDv4 device ids give uniform tiebreak — there is
// no "owner wins" semantic by design.
//
// Returns < 0 if a < b, > 0 if a > b, 0 only if every component matches (which
// across devices is impossible because did differs).
export function compareHLC(a: HLC, b: HLC): number {
  if (a.pms !== b.pms) return a.pms - b.pms;
  if (a.l !== b.l) return a.l - b.l;
  if (a.did < b.did) return -1;
  if (a.did > b.did) return 1;
  return 0;
}

// Serialize for app_meta.hlc_last. Read/written on every event append, so
// keep it short.
export function serializeHLC(hlc: HLC): string {
  return JSON.stringify({ pms: hlc.pms, l: hlc.l, did: hlc.did });
}

export function deserializeHLC(raw: string): HLC | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as HLC).pms === "number" &&
      typeof (parsed as HLC).l === "number" &&
      typeof (parsed as HLC).did === "string"
    ) {
      return parsed as HLC;
    }
    return null;
  } catch {
    return null;
  }
}
