// apps/mobile/lib/mesh/presence.ts
//
// Per-peer-DEVICE presence (nearby reachability), Briar-style. A peer device is
// "online" if a mesh sync succeeded with it (over ANY proximity channel — BTC or
// LAN) within ONLINE_WINDOW_MS. We track the authenticated device_id
// (conn.remoteDeviceId, set by the membership handshake), NOT an unauthenticated
// discovery id, so presence can't be spoofed by a stranger.
//
// In-process only (a Set-of-callbacks notifier, same idiom as ledger-events.ts /
// projection-conflicts.ts) — presence is ephemeral runtime state, never
// persisted. The members UI resolves device_id → account_id via
// vault_device_registry to show a dot next to a member.

const ONLINE_WINDOW_MS = 45_000;

type Listener = () => void;
const lastSeen = new Map<string, number>(); // deviceId -> last successful-sync ms
const listeners = new Set<Listener>();

/** Record a successful sync with an authenticated peer device. Call from every
 *  transport's success path (btc-steady, handlePeerConnection). */
export function markPeerSeen(deviceId: string | null | undefined): void {
  if (!deviceId) return;
  lastSeen.set(deviceId, Date.now());
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a listener must never break presence fan-out */
    }
  }
}

/** True iff this device synced within the online window. */
export function isPeerOnline(deviceId: string, now: number = Date.now()): boolean {
  const ts = lastSeen.get(deviceId);
  return ts != null && now - ts < ONLINE_WINDOW_MS;
}

/** All device_ids currently considered online. */
export function onlineDeviceIds(now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [id, ts] of lastSeen) {
    if (now - ts < ONLINE_WINDOW_MS) out.push(id);
  }
  return out;
}

/** Subscribe to presence changes (fires when a peer is freshly seen). The UI
 *  should ALSO poll on an interval to age peers OUT of the window. */
export function subscribePresence(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
