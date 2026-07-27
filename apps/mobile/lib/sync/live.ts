// Live-sync channel: a WebSocket to GET /v1/sync/live whose ONLY job is to
// tell us WHEN to pull. On connect the SERVER subscribes the socket to every
// vault the account is an active member of (no client-side vault list), then
// sends {"t":"poke","vault_id":...} whenever a vault gains committed events.
// The channel carries NO ledger data — a poke just triggers the existing
// authenticated pull, which is cursor-idempotent (a self-poke after our own
// push pulls nothing). The scheduler's polling stays untouched as the
// fallback whenever this socket is down.
//
// Wire contract (mirrored server-side):
//   - Auth: session JWT. Primary "Authorization: Bearer <jwt>" header (React
//     Native's WebSocket supports a headers option); "?token=<jwt>" query
//     param as fallback. Header wins server-side.
//   - Server → client: {"t":"poke","vault_id":"<uuid>"} and {"t":"ping"}
//     (keepalive every 30s).
//   - Client → server: {"t":"pong"} in reply to ping — nothing else. The
//     server drops the conn after 2 unanswered pings.
//
// Lifecycle: start()/stop() from the scheduler (foreground + signed-in only).
// Reconnect backoff 1s → 2 → 5 → 10 → 30s cap, jittered, reset on a
// successful open. Never throws into callers — every failure path is a
// silent retry (plus __DEV__ logs).

import { getBackendUrl } from "../api";

const BACKOFF_STEPS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// ±25% jitter so a fleet dropped by one server restart doesn't redial in
// lockstep.
const JITTER_FRACTION = 0.25;

// React Native's WebSocket takes a third options arg with custom headers
// (how we attach Authorization). The ambient TS declaration only types the
// two-arg DOM form, so we go through this narrowed constructor type.
type RNWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> } | null,
) => WebSocket;

export type LiveChannelOpts = {
  // Reads the current session JWT (null while signed out — treated as a
  // retryable condition, so a later sign-in gets picked up by the backoff
  // loop without a restart).
  getJwt: () => Promise<string | null>;
  // Called for every poke. Must not block: do debounce/coalesce work inside.
  // Exceptions are swallowed here so a listener bug can't kill the socket.
  onPoke: (vaultId: string) => void;
};

export type LiveChannel = {
  start: () => void;
  stop: () => void;
};

export function connectLiveChannel(opts: LiveChannelOpts): LiveChannel {
  // start() called and stop() not yet — the retry loop only runs while true.
  let desired = false;
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  // Guards the async dial: stop()+start() while a dial's awaits are pending
  // bumps this, and the stale dial bails instead of racing the fresh one.
  let generation = 0;
  let dialing = false;

  const clearRetryTimer = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleRetry = (): void => {
    if (!desired || retryTimer) return;
    const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
    attempt++;
    // Jitter in [1 - f, 1 + f) around the slot.
    const delay = Math.round(base * (1 - JITTER_FRACTION + Math.random() * 2 * JITTER_FRACTION));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void dial();
    }, delay);
  };

  // Detach handlers BEFORE close so the dying socket's onclose can't schedule
  // a retry after stop() (or fight a fresh socket after a restart).
  const teardownSocket = (): void => {
    const sock = ws;
    if (!sock) return;
    ws = null;
    try {
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      sock.close();
    } catch {
      // Already closed / never connected — nothing to do.
    }
  };

  const handleMessage = (data: unknown): void => {
    try {
      if (typeof data !== "string") return;
      const msg = JSON.parse(data) as { t?: string; vault_id?: string };
      if (msg?.t === "ping") {
        // Keepalive: the server drops us after 2 unanswered pings.
        ws?.send(JSON.stringify({ t: "pong" }));
      } else if (msg?.t === "poke" && typeof msg.vault_id === "string" && msg.vault_id) {
        opts.onPoke(msg.vault_id);
      }
      // Unknown t → ignore (forward-compatible with new server frames).
    } catch (err) {
      if (__DEV__) console.warn("[sync.live] message ignored", err);
    }
  };

  const dial = async (): Promise<void> => {
    if (!desired || ws || dialing) return;
    dialing = true;
    const gen = ++generation;
    try {
      let jwt: string | null = null;
      try {
        jwt = await opts.getJwt();
      } catch {
        jwt = null;
      }
      if (!desired || gen !== generation) return;
      if (!jwt) {
        // Signed out: retry on the backoff schedule (one cheap SecureStore
        // read per slot) so the channel comes up after the next sign-in.
        scheduleRetry();
        return;
      }

      const baseUrl = await getBackendUrl();
      if (!desired || gen !== generation) return;
      // http → ws, https → wss; the poke endpoint is a WebSocket upgrade.
      const wsBase = baseUrl.replace(/^http/, "ws").replace(/\/+$/, "");
      // ?token= is the fallback for stacks that strip the Authorization
      // header off upgrade requests; the server prefers the header.
      const url = `${wsBase}/v1/sync/live?token=${encodeURIComponent(jwt)}`;

      const sock = new (WebSocket as unknown as RNWebSocketCtor)(url, null, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      ws = sock;
      sock.onopen = () => {
        // Connected — future drops start the backoff ladder from the bottom.
        attempt = 0;
        if (__DEV__) console.log("[sync.live] connected");
      };
      sock.onmessage = (e) => handleMessage(e.data);
      sock.onerror = () => {
        // RN always follows onerror with onclose; reconnect is handled there.
      };
      sock.onclose = () => {
        ws = null;
        if (__DEV__) console.log("[sync.live] closed, will retry");
        scheduleRetry();
      };
    } catch (err) {
      // Constructor / URL resolution failure — same retry path as a drop.
      if (__DEV__) console.warn("[sync.live] dial failed", err);
      if (ws) teardownSocket();
      scheduleRetry();
    } finally {
      dialing = false;
    }
  };

  const start = (): void => {
    if (desired) return; // already connected or retrying
    desired = true;
    attempt = 0;
    void dial();
  };

  const stop = (): void => {
    desired = false;
    generation++; // invalidate any dial that's mid-await
    clearRetryTimer();
    attempt = 0;
    teardownSocket();
  };

  return { start, stop };
}
