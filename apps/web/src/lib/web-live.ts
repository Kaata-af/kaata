import { BACKEND_URL } from "../env";
import {
  getWebSession,
  webRequest,
  WEB_SESSION_EVENT,
  WebApiError,
  type WebSession,
} from "./web-auth";

// Socket messages are only hints. The workspace always reads balances and
// permissions from the authenticated HTTP API after receiving one.
export type WebLiveState = "connecting" | "live" | "reconnecting" | "polling" | "stopped";

export interface WebLiveSocket {
  onOpen(handler: () => void): void;
  onMessage(handler: (data: unknown) => void): void;
  onDisconnect(handler: () => void): void;
  send(data: string): void;
  close(): void;
}

export type WebLiveDependencies = {
  requestTicket(signal: AbortSignal): Promise<unknown>;
  createSocket(url: string): WebLiveSocket;
  getSession(): WebSession | null;
  subscribeSession(handler: () => void): () => void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
  random(): number;
};

export type WebLiveOptions = {
  session: WebSession;
  /** null requests a full catch-up, including changed memberships/shared links. */
  onChange(vaultID: string | null): void | Promise<unknown>;
  onState?(state: WebLiveState): void | Promise<unknown>;
  backendUrl?: string;
  dependencies?: Partial<WebLiveDependencies>;
};

const CONNECT_TIMEOUT = 12_000;
const HEARTBEAT_TIMEOUT = 75_000;
const MAX_RETRY_DELAY = 30_000;
const FALLBACK_RETRY_DELAY = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function browserSocket(url: string): WebLiveSocket {
  const socket = new WebSocket(url);
  return {
    onOpen(handler) {
      socket.onopen = handler;
    },
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
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    },
  };
}

function socketURL(backendUrl: string, ticket: string): string {
  const url = new URL(backendUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid live backend URL");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/sync/web-live`;
  url.searchParams.set("ticket", ticket);
  return url.href;
}

/** Start one session-bound socket. The caller owns read coalescing and polling. */
export function createWebLive(options: WebLiveOptions): { stop(): void } {
  const deps: WebLiveDependencies = {
    requestTicket: (signal) => webRequest("/v1/sync/live-ticket", { method: "POST", signal }),
    createSocket: browserSocket,
    getSession: getWebSession,
    subscribeSession: (handler) => {
      window.addEventListener(WEB_SESSION_EVENT, handler);
      return () => window.removeEventListener(WEB_SESSION_EVENT, handler);
    },
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: Math.random,
    ...options.dependencies,
  };
  // Copy identity values so mutating the supplied object cannot rebind a socket.
  const { account_id: accountID, install_id: installID, session_jwt: token } = options.session;
  let stopped = false;
  let generation = 0;
  let failures = 0;
  let state: WebLiveState | undefined;
  let connection: WebLiveSocket | undefined;
  let ticketAbort: AbortController | undefined;
  let connectTimer: unknown;
  let heartbeatTimer: unknown;
  let retryTimer: unknown;
  let unsubscribe: (() => void) | undefined;

  // Consumers may refresh asynchronously. A slow or rejected refresh must not
  // delay pong responses or turn a healthy transport into a reconnect loop.
  function notify(callback: (() => void | Promise<unknown>) | undefined) {
    try {
      void Promise.resolve(callback?.()).catch(() => {});
    } catch {
      /* Consumer owns its errors. */
    }
  }
  function setState(next: WebLiveState) {
    if (state === next) return;
    state = next;
    notify(() => options.onState?.(next));
  }
  function clear(timer: unknown) {
    if (timer !== undefined) deps.clearTimeout(timer);
  }
  function closeTransport() {
    clear(connectTimer);
    connectTimer = undefined;
    clear(heartbeatTimer);
    heartbeatTimer = undefined;
    ticketAbort?.abort();
    ticketAbort = undefined;
    const old = connection;
    connection = undefined;
    try {
      old?.close();
    } catch {
      /* It is already unusable. */
    }
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    generation++;
    closeTransport();
    clear(retryTimer);
    retryTimer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    setState("stopped");
  }
  function sameSession(): boolean {
    let current: WebSession | null;
    try {
      current = deps.getSession();
    } catch {
      current = null;
    }
    return (
      !!current &&
      current.account_id === accountID &&
      current.install_id === installID &&
      current.session_jwt === token
    );
  }
  function current(attempt: number): boolean {
    if (stopped || attempt !== generation) return false;
    if (!sameSession()) {
      stop();
      return false;
    }
    return true;
  }
  function changed(attempt: number, vaultID: string | null) {
    if (current(attempt)) notify(() => options.onChange(vaultID));
  }
  function retry(attempt: number, fallback = false, retryAfterSeconds?: number) {
    if (!current(attempt)) return;
    generation++;
    closeTransport();
    clear(retryTimer);
    const random = deps.random();
    const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
    const backoff = fallback
      ? FALLBACK_RETRY_DELAY
      : Math.min(MAX_RETRY_DELAY, 1000 * 2 ** Math.min(failures++, 6) * (0.75 + jitter / 2));
    // Quotas can ask for longer than the normal reconnect cap. Bound browser
    // timers to their signed 32-bit limit so a huge value cannot overflow.
    const retryAfter =
      typeof retryAfterSeconds === "number" &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
        ? Math.min(2_147_483_647, retryAfterSeconds * 1000)
        : 0;
    const delay = Math.max(backoff, retryAfter);
    setState(fallback ? "polling" : "reconnecting");
    // onState may synchronously stop the controller.
    if (stopped) return;
    retryTimer = deps.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  }
  function heartbeat(attempt: number) {
    clear(heartbeatTimer);
    heartbeatTimer = deps.setTimeout(() => retry(attempt), HEARTBEAT_TIMEOUT);
  }

  async function connect() {
    if (stopped) return;
    if (!sameSession()) {
      stop();
      return;
    }
    const attempt = ++generation;
    const abort = new AbortController();
    ticketAbort = abort;
    connectTimer = deps.setTimeout(() => retry(attempt), CONNECT_TIMEOUT);
    try {
      const response = await deps.requestTicket(abort.signal);
      if (!current(attempt)) return;
      const body = response as { ticket?: unknown; expires_in?: unknown } | null;
      // Accept only an opaque token, never an echoed bearer/JWT or a URL.
      // A JWT contains dots, which this alphabet deliberately excludes.
      if (
        !body ||
        typeof body.ticket !== "string" ||
        !/^[A-Za-z0-9_-]{16,512}$/.test(body.ticket) ||
        body.ticket === token ||
        typeof body.expires_in !== "number" ||
        !Number.isFinite(body.expires_in) ||
        body.expires_in <= 0 ||
        body.expires_in > 300
      ) {
        retry(attempt);
        return;
      }
      const socket = deps.createSocket(socketURL(options.backendUrl ?? BACKEND_URL, body.ticket));
      connection = socket;
      let opened = false;
      socket.onDisconnect(() => retry(attempt));
      socket.onOpen(() => {
        if (!current(attempt) || opened) return;
        opened = true;
        failures = 0;
        clear(connectTimer);
        connectTimer = undefined;
        heartbeat(attempt);
        setState("live");
        // The mobile protocol has no ready frame; a completed upgrade is live.
        // Catch up each time, including changes missed while disconnected.
        changed(attempt, null);
      });
      socket.onMessage((data) => {
        if (!current(attempt) || !opened || typeof data !== "string" || data.length > 4096) return;
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object" || !("t" in message)) return;
        if (message.t === "ping") {
          heartbeat(attempt);
          try {
            socket.send('{"t":"pong"}');
          } catch {
            retry(attempt);
          }
        } else if (
          message.t === "poke" &&
          "vault_id" in message &&
          typeof message.vault_id === "string" &&
          UUID.test(message.vault_id)
        ) {
          heartbeat(attempt);
          changed(attempt, message.vault_id);
        } else if (
          message.t === "tab_poke" &&
          "tab_id" in message &&
          typeof message.tab_id === "string" &&
          UUID.test(message.tab_id)
        ) {
          heartbeat(attempt);
          changed(attempt, null);
        }
      });
    } catch (error) {
      if (!current(attempt)) return;
      if (error instanceof WebApiError && error.status === 401) {
        stop();
        return;
      }
      retry(
        attempt,
        error instanceof WebApiError && error.status === 404,
        error instanceof WebApiError && error.status === 429 ? error.retryAfterSeconds : undefined,
      );
    }
  }

  unsubscribe = deps.subscribeSession(() => {
    if (!sameSession()) stop();
  });
  if (sameSession()) {
    setState("connecting");
    void connect();
  } else stop();
  return { stop };
}
