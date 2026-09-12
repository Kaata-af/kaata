// Notifications only accelerate the existing HTTP queries. Counts and user
// data always come from the authenticated admin endpoints, never this socket.
export type AdminLiveState = "connecting" | "live" | "reconnecting" | "polling";

export interface AdminLiveSocket {
  onMessage(handler: (data: unknown) => void): void;
  onDisconnect(handler: () => void): void;
  send(data: string): void;
  close(): void;
}
export type TicketResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
export type TicketRequest = {
  method: "POST";
  headers: { Authorization: string };
  signal: AbortSignal;
  cache: "no-store";
};
export type AdminLiveDependencies = {
  fetchTicket(url: string, request: TicketRequest): Promise<TicketResponse>;
  createSocket(url: string): AdminLiveSocket;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
  random(): number;
};
export type AdminLiveOptions = {
  backendUrl: string;
  token: string;
  invalidate(): Promise<unknown>;
  onState(state: AdminLiveState): void;
  onUnauthorized(): void;
  dependencies?: Partial<AdminLiveDependencies>;
};

type AdminQueryClient = {
  isFetching(filters: { queryKey: string[] }): number;
  invalidateQueries(
    filters: { queryKey: string[] },
    options: { cancelRefetch: false },
  ): Promise<unknown>;
};

export async function refreshAdminQueries(client: AdminQueryClient, isActive: () => boolean) {
  if (!isActive()) return;
  const filters = { queryKey: ["admin"] };
  const alreadyFetching = client.isFetching(filters) > 0;
  await client.invalidateQueries(filters, { cancelRefetch: false });
  // Joining an existing read may return a snapshot from before the signal.
  // Fetch once after it settles, while preserving useful in-flight requests.
  if (isActive() && alreadyFetching) {
    await client.invalidateQueries(filters, { cancelRefetch: false });
  }
}

const CONNECT_TIMEOUT = 12_000;
const HEARTBEAT_TIMEOUT = 75_000;
const COALESCE_DELAY = 1_000;
const MAX_RETRY_DELAY = 30_000;
const FALLBACK_RETRY_DELAY = 60_000;

function browserSocket(url: string): AdminLiveSocket {
  const socket = new WebSocket(url);
  return {
    onMessage(handler) {
      socket.onmessage = (event) => handler(event.data);
    },
    onDisconnect(handler) {
      socket.onclose = handler;
      socket.onerror = handler;
    },
    send(data) {
      socket.send(data);
    },
    close() {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    },
  };
}

function endpoint(backendUrl: string, path: string): URL {
  const url = new URL(path, `${backendUrl.replace(/\/+$/, "")}/`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid backend URL");
  return url;
}

export function createAdminLive(options: AdminLiveOptions): { stop(): void } {
  const dependencies: AdminLiveDependencies = {
    fetchTicket: (url, request) => fetch(url, request),
    createSocket: browserSocket,
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: Math.random,
    ...options.dependencies,
  };
  let stopped = false;
  let generation = 0;
  let failures = 0;
  let state: AdminLiveState | undefined;
  let socket: AdminLiveSocket | undefined;
  let ticketAbort: AbortController | undefined;
  let connectTimer: unknown;
  let heartbeatTimer: unknown;
  let reconnectTimer: unknown;
  let refreshTimer: unknown;
  let refreshing = false;
  let dirty = false;

  function setState(next: AdminLiveState) {
    if (!stopped && state !== next) {
      state = next;
      options.onState(next);
    }
  }
  function clear(timer: unknown) {
    if (timer !== undefined) dependencies.clearTimeout(timer);
  }
  function closeTransport() {
    clear(connectTimer);
    connectTimer = undefined;
    clear(heartbeatTimer);
    heartbeatTimer = undefined;
    ticketAbort?.abort();
    ticketAbort = undefined;
    const previous = socket;
    socket = undefined;
    try {
      previous?.close();
    } catch {
      /* A failed socket is already unusable. */
    }
  }
  function current(attempt: number): boolean {
    return !stopped && attempt === generation;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    closeTransport();
    clear(reconnectTimer);
    reconnectTimer = undefined;
    clear(refreshTimer);
    refreshTimer = undefined;
    dirty = false;
  }

  // A leading deadline coalesces a burst without postponing forever under a
  // steady stream. Events during a fetch schedule one trailing refresh.
  function requestRefresh(delay = COALESCE_DELAY) {
    if (stopped) return;
    dirty = true;
    if (refreshing || refreshTimer !== undefined) return;
    refreshTimer = dependencies.setTimeout(() => {
      void refresh();
    }, delay);
  }
  async function refresh() {
    refreshTimer = undefined;
    if (stopped || !dirty) return;
    dirty = false;
    refreshing = true;
    try {
      await options.invalidate();
    } catch {
      /* HTTP queries own their error UI and polling retry. */
    } finally {
      refreshing = false;
      if (!stopped && dirty) requestRefresh();
    }
  }

  function retry(attempt: number, fallback = false) {
    if (!current(attempt)) return;
    generation++;
    closeTransport();
    clear(reconnectTimer);
    const jitter = Math.max(0, Math.min(1, dependencies.random()));
    const delay = fallback
      ? FALLBACK_RETRY_DELAY * (1 + jitter / 2)
      : Math.min(MAX_RETRY_DELAY, 1_000 * 2 ** Math.min(failures++, 5) * (0.75 + jitter / 2));
    setState(fallback ? "polling" : "reconnecting");
    reconnectTimer = dependencies.setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delay);
  }
  function resetHeartbeat(attempt: number) {
    clear(heartbeatTimer);
    heartbeatTimer = dependencies.setTimeout(() => retry(attempt), HEARTBEAT_TIMEOUT);
  }

  async function connect() {
    if (stopped) return;
    const attempt = ++generation;
    ticketAbort = new AbortController();
    connectTimer = dependencies.setTimeout(() => retry(attempt), CONNECT_TIMEOUT);
    try {
      const response = await dependencies.fetchTicket(
        endpoint(options.backendUrl, "v1/admin/live-ticket").href,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${options.token}` },
          signal: ticketAbort.signal,
          cache: "no-store",
        },
      );
      if (!current(attempt)) return;
      if (response.status === 401) {
        stop();
        options.onUnauthorized();
        return;
      }
      if (response.status === 404) {
        retry(attempt, true);
        return;
      }
      if (!response.ok) {
        retry(attempt);
        return;
      }
      const body = await response.json();
      if (!current(attempt)) return;
      const ticket = body && typeof body === "object" && "ticket" in body ? body.ticket : undefined;
      // A ticket is opaque and short-lived. Never fall back to the admin key,
      // including if a malformed server response accidentally echoes it.
      if (
        typeof ticket !== "string" ||
        !ticket.trim() ||
        ticket.length > 4_096 ||
        ticket === options.token
      ) {
        retry(attempt);
        return;
      }
      const url = endpoint(options.backendUrl, "v1/admin/live");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("ticket", ticket);
      const connection = dependencies.createSocket(url.href);
      socket = connection;
      let ready = false;
      connection.onDisconnect(() => retry(attempt));
      connection.onMessage((data) => {
        if (!current(attempt) || typeof data !== "string") return;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object" || !("t" in message)) return;
        if (message.t === "ready") {
          if (ready) return;
          ready = true;
          failures = 0;
          clear(connectTimer);
          connectTimer = undefined;
          resetHeartbeat(attempt);
          setState("live");
          requestRefresh(0);
        } else if (ready && message.t === "invalidate") {
          resetHeartbeat(attempt);
          requestRefresh();
        } else if (message.t === "ping") {
          if (ready) resetHeartbeat(attempt);
          try {
            connection.send(JSON.stringify({ t: "pong" }));
          } catch {
            retry(attempt);
          }
        }
      });
    } catch {
      // Aborts caused by cleanup/timeouts belong to an obsolete generation.
      retry(attempt);
    }
  }

  if (options.token) {
    setState("connecting");
    void connect();
  } else {
    setState("polling");
  }
  return { stop };
}
