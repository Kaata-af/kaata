import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  createAdminLive,
  refreshAdminQueries,
  type AdminLiveSocket,
  type AdminLiveState,
  type TicketRequest,
  type TicketResponse,
} from "./live.ts";

const SECRET = "test-operator-secret-not-a-ticket";
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(
  status = 200,
  body: unknown = { ticket: "one-use+ticket/?", expires_in: 30 },
): TicketResponse {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}
class Clock {
  now = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number): number => {
    const id = ++this.next;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  async advance(delay: number) {
    const target = this.now + delay;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}
class Socket implements AdminLiveSocket {
  message?: (data: unknown) => void;
  disconnect?: () => void;
  closed = 0;
  sent: string[] = [];
  onMessage(handler: (data: unknown) => void) {
    this.message = handler;
  }
  onDisconnect(handler: () => void) {
    this.disconnect = handler;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed++;
  }
  emit(type: string) {
    this.message?.(JSON.stringify({ t: type }));
  }
}
function harness(
  overrides: {
    fetch?: (request: TicketRequest, count: number) => Promise<TicketResponse>;
    invalidate?: () => Promise<unknown>;
    random?: () => number;
    backendUrl?: string;
  } = {},
) {
  const clock = new Clock();
  const requests: { url: string; request: TicketRequest }[] = [];
  const socketUrls: string[] = [];
  const sockets: Socket[] = [];
  const states: AdminLiveState[] = [];
  let refreshes = 0;
  let unauthorized = 0;
  const controller = createAdminLive({
    token: SECRET,
    backendUrl: overrides.backendUrl ?? "https://api.example.test",
    onState: (state) => states.push(state),
    onUnauthorized: () => {
      unauthorized++;
    },
    invalidate: () => {
      refreshes++;
      return overrides.invalidate?.() ?? Promise.resolve();
    },
    dependencies: {
      fetchTicket: async (url, request) => {
        requests.push({ url, request });
        return overrides.fetch ? overrides.fetch(request, requests.length) : response();
      },
      createSocket: (url) => {
        socketUrls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: overrides.random ?? (() => 0.5),
    },
  });
  return {
    clock,
    controller,
    requests,
    socketUrls,
    sockets,
    states,
    get refreshes() {
      return refreshes;
    },
    get unauthorized() {
      return unauthorized;
    },
  };
}

test("ticket uses the authorization header; WebSocket uses only an encoded ephemeral ticket", async () => {
  const h = harness({ backendUrl: "https://api.example.test/backend/" });
  await flush();
  assert.equal(h.requests[0].url, "https://api.example.test/backend/v1/admin/live-ticket");
  assert.equal(h.requests[0].request.method, "POST");
  assert.equal(h.requests[0].request.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(h.requests[0].request.cache, "no-store");
  const socket = new URL(h.socketUrls[0]);
  assert.equal(socket.protocol, "wss:");
  assert.equal(socket.pathname, "/backend/v1/admin/live");
  assert.equal(socket.searchParams.get("ticket"), "one-use+ticket/?");
  assert.equal(
    h.socketUrls.some((url) => url.includes(SECRET)),
    false,
  );
  assert.equal(
    h.requests.some(({ url }) => url.includes(SECRET)),
    false,
  );
  assert.deepEqual(h.states, ["connecting"]);
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  assert.equal(h.states.at(-1), "live");
  assert.equal(h.refreshes, 1);
  h.controller.stop();
});

test("localhost HTTP becomes WS and an echoed admin key can never become a URL credential", async () => {
  const h = harness({ backendUrl: "http://localhost:8080" });
  await flush();
  assert.equal(new URL(h.socketUrls[0]).protocol, "ws:");
  h.controller.stop();
  const echoed = harness({ fetch: async () => response(200, { ticket: SECRET }) });
  await flush();
  assert.equal(echoed.sockets.length, 0);
  assert.equal(echoed.states.at(-1), "reconnecting");
  echoed.controller.stop();
});

test("a notification burst refreshes once at its leading deadline, without continuous-event starvation", async () => {
  const h = harness();
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  for (let index = 0; index < 25; index++) h.sockets[0].emit("invalidate");
  await h.clock.advance(400);
  h.sockets[0].emit("invalidate");
  await h.clock.advance(599);
  assert.equal(h.refreshes, 1);
  await h.clock.advance(1);
  assert.equal(h.refreshes, 2);
  h.sockets[0].emit("invalidate");
  await h.clock.advance(1_000);
  assert.equal(h.refreshes, 3);
  h.controller.stop();
});

test("changes arriving during an in-flight refresh are not lost or allowed to start parallel refreshes", async () => {
  const first = deferred<void>();
  let requests = 0;
  const h = harness({ invalidate: () => (++requests === 1 ? first.promise : Promise.resolve()) });
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  h.sockets[0].emit("invalidate");
  h.sockets[0].emit("invalidate");
  await h.clock.advance(5_000);
  assert.equal(h.refreshes, 1);
  first.resolve();
  await flush();
  await h.clock.advance(999);
  assert.equal(h.refreshes, 1);
  await h.clock.advance(1);
  assert.equal(h.refreshes, 2);
  await h.clock.advance(2_000);
  assert.equal(h.refreshes, 2);
  h.controller.stop();
});

test("a rejected HTTP refresh leaves subsequent notifications usable", async () => {
  let count = 0;
  const h = harness({
    invalidate: () => (++count === 1 ? Promise.reject(new Error("offline")) : Promise.resolve()),
  });
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  h.sockets[0].emit("invalidate");
  await h.clock.advance(1_000);
  assert.equal(h.refreshes, 2);
  h.controller.stop();
});

test("disconnect reconnects with a fresh ticket, ignores obsolete socket events, and refreshes on ready", async () => {
  const h = harness({
    fetch: async (_request, count) => response(200, { ticket: `ticket-${count}`, expires_in: 30 }),
  });
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  const old = h.sockets[0];
  old.disconnect?.();
  old.disconnect?.();
  assert.equal(h.states.at(-1), "reconnecting");
  await h.clock.advance(999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  assert.equal(new URL(h.socketUrls[1]).searchParams.get("ticket"), "ticket-2");
  old.emit("ready");
  old.emit("invalidate");
  assert.equal(h.states.at(-1), "reconnecting");
  h.sockets[1].emit("ready");
  await h.clock.advance(0);
  assert.equal(h.refreshes, 2);
  assert.equal(h.states.at(-1), "live");
  h.controller.stop();
});

test("failed ticket attempts back off exponentially with a bounded maximum", async () => {
  const h = harness({ fetch: async () => response(503) });
  await flush();
  for (const expected of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const count = h.requests.length;
    await h.clock.advance(expected - 1);
    assert.equal(h.requests.length, count);
    await h.clock.advance(1);
    assert.equal(h.requests.length, count + 1);
  }
  assert.equal(h.sockets.length, 0);
  h.controller.stop();
});

test("old-backend 404 uses polling fallback and a slower retry", async () => {
  const h = harness({ fetch: async () => response(404), random: () => 0 });
  await flush();
  assert.equal(h.states.at(-1), "polling");
  await h.clock.advance(59_999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  h.controller.stop();
});

test("401 invokes authorization handling once and permanently stops this controller", async () => {
  const h = harness({ fetch: async () => response(401) });
  await flush();
  assert.equal(h.unauthorized, 1);
  assert.equal(h.requests[0].request.signal.aborted, true);
  assert.equal(h.clock.timers.size, 0);
  await h.clock.advance(300_000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sockets.length, 0);
});

test("stopping during ticket fetch aborts it and ignores even a late successful response", async () => {
  const ticket = deferred<TicketResponse>();
  const h = harness({ fetch: () => ticket.promise });
  assert.equal(h.requests.length, 1);
  h.controller.stop();
  h.controller.stop();
  assert.equal(h.requests[0].request.signal.aborted, true);
  ticket.resolve(response());
  await flush();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.refreshes, 0);
});

test("stopping closes sockets and cancels refresh/reconnect work, including after an in-flight refresh", async () => {
  const pending = deferred<void>();
  const h = harness({ invalidate: () => pending.promise });
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  h.sockets[0].emit("invalidate");
  h.sockets[0].disconnect?.();
  h.controller.stop();
  pending.resolve();
  await flush();
  await h.clock.advance(300_000);
  assert.equal(h.refreshes, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
  assert.equal(h.sockets[0].closed, 1);
});

test("ping/pong resets the heartbeat, and a silent socket reconnects after the deadline", async () => {
  const h = harness();
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  await h.clock.advance(60_000);
  h.sockets[0].emit("ping");
  assert.deepEqual(h.sockets[0].sent, ['{"t":"pong"}']);
  await h.clock.advance(74_999);
  assert.equal(h.states.at(-1), "live");
  await h.clock.advance(1);
  assert.equal(h.states.at(-1), "reconnecting");
  assert.equal(h.sockets[0].closed, 1);
  await h.clock.advance(1_000);
  assert.equal(h.requests.length, 2);
  h.controller.stop();
});

test("connect timeout covers stalled tickets and sockets that never acknowledge ready", async () => {
  const ticket = deferred<TicketResponse>();
  const stalled = harness({ fetch: () => ticket.promise });
  await stalled.clock.advance(12_000);
  assert.equal(stalled.requests[0].request.signal.aborted, true);
  assert.equal(stalled.states.at(-1), "reconnecting");
  stalled.controller.stop();
  const socket = harness();
  await flush();
  await socket.clock.advance(12_000);
  assert.equal(socket.sockets[0].closed, 1);
  assert.equal(socket.states.at(-1), "reconnecting");
  socket.controller.stop();
});

test("malformed messages cannot invalidate queries or keep a broken connection alive", async () => {
  const h = harness();
  await flush();
  h.sockets[0].emit("ready");
  await h.clock.advance(0);
  for (const message of ["bad json", "null", "[]", '{"t":"unknown"}', 123])
    h.sockets[0].message?.(message);
  await h.clock.advance(75_000);
  assert.equal(h.refreshes, 1);
  assert.equal(h.states.at(-1), "reconnecting");
  h.controller.stop();
});

test("real query invalidation waits for an older in-flight read then fetches a fresh snapshot without cancelling", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const pending = deferred<string>();
  const key = ["admin", "stats", "test-key"];
  let reads = 0;
  let firstSignal: AbortSignal | undefined;
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: ({ signal }) => {
      reads++;
      if (reads === 1) {
        firstSignal = signal;
        return pending.promise;
      }
      return Promise.resolve("fresh-after-notification");
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const refreshing = refreshAdminQueries(client, () => true);
  assert.equal(reads, 1);
  assert.equal(firstSignal?.aborted, false);
  pending.resolve("old-before-notification");
  await refreshing;
  assert.equal(reads, 2);
  assert.equal(firstSignal?.aborted, false);
  assert.equal(client.getQueryData(key), "fresh-after-notification");
  unsubscribe();
  client.clear();
});

test("signout during an older HTTP read prevents the trailing refresh from starting", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const pending = deferred<string>();
  let active = true;
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["admin", "users", "test-key"],
    queryFn: () => {
      reads++;
      return pending.promise;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const refreshing = refreshAdminQueries(client, () => active);
  active = false;
  pending.resolve("old-session");
  await refreshing;
  assert.equal(reads, 1);
  unsubscribe();
  client.clear();
});
