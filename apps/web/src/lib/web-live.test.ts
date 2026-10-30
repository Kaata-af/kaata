import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearWebSession,
  createWebAuthNonce,
  signInWithGoogle,
  WebApiError,
  type WebSession,
} from "./web-auth";
import {
  createWebLive,
  type WebLiveDependencies,
  type WebLiveSocket,
  type WebLiveState,
} from "./web-live";

const VAULT = "00000000-0000-4000-8000-000000000001";
const TAB = "00000000-0000-4000-8000-000000000002";
const session: WebSession = {
  account_id: "account-a",
  install_id: "browser-a",
  session_jwt: "header.private-session.signature",
  default_vault_id: VAULT,
  user: { has_password: true },
};

async function flush() {
  for (let n = 0; n < 12; n++) await Promise.resolve();
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

class Clock {
  now = 0;
  nextID = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, ms: number) => {
    const id = ++this.nextID;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };
  advance(ms: number) {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = until;
  }
  delays() {
    return [...this.timers.values()].map((timer) => timer.at - this.now).sort((a, b) => a - b);
  }
}

class Socket implements WebLiveSocket {
  opened: () => void = () => {};
  received: (data: unknown) => void = () => {};
  disconnected: () => void = () => {};
  sent: string[] = [];
  closed = 0;
  sendError = false;
  onOpen(handler: () => void) {
    this.opened = handler;
  }
  onMessage(handler: (data: unknown) => void) {
    this.received = handler;
  }
  onDisconnect(handler: () => void) {
    this.disconnected = handler;
  }
  send(data: string) {
    if (this.sendError) throw new Error("write failed");
    this.sent.push(data);
  }
  close() {
    this.closed++;
  }
  message(value: unknown) {
    this.received(JSON.stringify(value));
  }
}

function fixture(
  extra: Partial<WebLiveDependencies> = {},
  change?: (id: string | null) => void | Promise<unknown>,
) {
  const clock = new Clock();
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const states: WebLiveState[] = [];
  const changes: (string | null)[] = [];
  const signals: AbortSignal[] = [];
  let active: WebSession | null = { ...session };
  let sessionChanged = () => {};
  let unsubscribed = 0;
  let tickets = 0;
  const requestTicket =
    extra.requestTicket ??
    (async () => ({ ticket: `opaque-one-use-ticket-${tickets}`, expires_in: 30 }));
  const controller = createWebLive({
    session,
    backendUrl: "https://api.example.test",
    onChange: (id) => {
      changes.push(id);
      return change?.(id);
    },
    onState: (state) => {
      states.push(state);
    },
    dependencies: {
      createSocket: (url) => {
        urls.push(url);
        const socket = new Socket();
        sockets.push(socket);
        return socket;
      },
      getSession: () => active,
      subscribeSession: (handler) => {
        sessionChanged = handler;
        return () => {
          unsubscribed++;
        };
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      random: () => 0.5,
      ...extra,
      requestTicket: (signal) => {
        tickets++;
        signals.push(signal);
        return requestTicket(signal);
      },
    },
  });
  return {
    clock,
    sockets,
    urls,
    states,
    changes,
    signals,
    controller,
    tickets: () => tickets,
    unsubscribed: () => unsubscribed,
    switchSession: (next: WebSession | null, notify = true) => {
      active = next;
      if (notify) sessionChanged();
    },
  };
}

test("upgrade becomes live without a ready frame and every connection requests a catch-up", async () => {
  const f = fixture();
  await flush();
  assert.deepEqual(f.states, ["connecting"]);
  const firstURL = new URL(f.urls[0]);
  assert.equal(firstURL.protocol, "wss:");
  assert.equal(firstURL.pathname, "/v1/sync/web-live");
  assert.deepEqual([...firstURL.searchParams.keys()], ["ticket"]);
  assert.ok(!f.urls[0].includes(session.session_jwt));
  f.sockets[0].opened();
  assert.deepEqual(f.states, ["connecting", "live"]);
  assert.deepEqual(f.changes, [null]);
  f.sockets[0].disconnected();
  f.sockets[0].disconnected();
  assert.deepEqual(f.clock.delays(), [1000]);
  f.clock.advance(1000);
  await flush();
  assert.equal(f.tickets(), 2);
  assert.notEqual(f.urls[1], f.urls[0]);
  f.sockets[1].opened();
  assert.deepEqual(f.changes, [null, null]);
  f.controller.stop();
});

test("only validated hints refresh data; pings get pong and shared-link changes refresh all", async () => {
  const f = fixture();
  await flush();
  const socket = f.sockets[0];
  socket.opened();
  socket.message({ t: "poke", vault_id: VAULT });
  socket.message({ t: "tab_poke", tab_id: TAB });
  socket.message({ t: "ping" });
  assert.deepEqual(f.changes, [null, VAULT, null]);
  assert.deepEqual(socket.sent, ['{"t":"pong"}']);
  for (const value of [
    null,
    [],
    { t: "ready" },
    { t: "poke", vault_id: "../../private" },
    { t: "poke" },
    { t: "tab_poke", tab_id: 1 },
    { t: "balance", amount: 999 },
  ])
    socket.message(value);
  socket.received(new Uint8Array([1]));
  socket.received("not JSON");
  socket.received(" ".repeat(5000));
  assert.deepEqual(f.changes, [null, VAULT, null]);
  f.controller.stop();
});

test("pending or failed consumer refreshes cannot block pong or reconnect", async () => {
  const pending = deferred<void>();
  const f = fixture({}, () => pending.promise);
  await flush();
  f.sockets[0].opened();
  f.sockets[0].message({ t: "ping" });
  assert.deepEqual(f.sockets[0].sent, ['{"t":"pong"}']);
  f.sockets[0].disconnected();
  f.clock.advance(1000);
  await flush();
  assert.equal(f.sockets.length, 2);
  f.sockets[1].opened();
  pending.reject(new Error("HTTP read failed"));
  await flush();
  assert.equal(f.states.at(-1), "live");
  f.controller.stop();

  const throwing = fixture({}, () => {
    throw new Error("consumer bug");
  });
  await flush();
  throwing.sockets[0].opened();
  throwing.sockets[0].message({ t: "ping" });
  assert.equal(throwing.states.at(-1), "live");
  assert.equal(throwing.sockets[0].sent.length, 1);
  throwing.controller.stop();
});

test("stop aborts ticket retrieval and ignores late results without reconnecting", async () => {
  const request = deferred<unknown>();
  const f = fixture({ requestTicket: () => request.promise });
  f.controller.stop();
  f.controller.stop();
  assert.equal(f.signals[0].aborted, true);
  assert.equal(f.unsubscribed(), 1);
  request.resolve({ ticket: "opaque-late-result", expires_in: 30 });
  await flush();
  f.clock.advance(120_000);
  await flush();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.tickets(), 1);
  assert.equal(f.clock.timers.size, 0);
  assert.deepEqual(f.states, ["connecting", "stopped"]);
});

test("session switches stop an open transport and invalidate retained callbacks", async () => {
  const f = fixture();
  await flush();
  const old = f.sockets[0];
  old.opened();
  f.switchSession({ ...session, session_jwt: "new-session-token" });
  old.message({ t: "poke", vault_id: VAULT });
  old.opened();
  old.disconnected();
  f.clock.advance(120_000);
  await flush();
  assert.equal(old.closed, 1);
  assert.deepEqual(f.changes, [null]);
  assert.equal(f.tickets(), 1);
  assert.equal(f.states.at(-1), "stopped");
  assert.equal(f.clock.timers.size, 0);
});

test("a changed session is detected even when its event is missed during ticket retrieval", async () => {
  const request = deferred<unknown>();
  const f = fixture({ requestTicket: () => request.promise });
  f.switchSession({ ...session, account_id: "other-account" }, false);
  request.resolve({ ticket: "opaque-old-account-ticket", expires_in: 30 });
  await flush();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.states.at(-1), "stopped");
  assert.equal(f.clock.timers.size, 0);
});

test("401 is terminal; a missing endpoint backs off for 60 seconds", async () => {
  const ended = fixture({
    requestTicket: async () => {
      throw new WebApiError("ended", 401, "session_expired");
    },
  });
  await flush();
  assert.equal(ended.states.at(-1), "stopped");
  ended.clock.advance(180_000);
  await flush();
  assert.equal(ended.tickets(), 1);
  const missing = fixture({
    requestTicket: async () => {
      throw new WebApiError("old backend", 404, "missing");
    },
  });
  await flush();
  assert.equal(missing.states.at(-1), "polling");
  assert.deepEqual(missing.clock.delays(), [60_000]);
  missing.clock.advance(59_999);
  await flush();
  assert.equal(missing.tickets(), 1);
  missing.clock.advance(1);
  await flush();
  assert.equal(missing.tickets(), 2);
  missing.controller.stop();
});

test("repeated failed attempts use capped exponential jitter instead of a tight loop", async () => {
  const f = fixture({
    random: () => 1,
    requestTicket: async () => {
      throw new Error("offline");
    },
  });
  await flush();
  for (const delay of [1250, 2500, 5000, 10000, 20000, 30000, 30000]) {
    assert.deepEqual(f.clock.delays(), [delay]);
    f.clock.advance(delay);
    await flush();
  }
  f.controller.stop();
});

test("429 Retry-After is a minimum delay even beyond the normal 30-second reconnect cap", async () => {
  let attempts = 0;
  const f = fixture({
    requestTicket: async () => {
      attempts++;
      if (attempts <= 2)
        throw new WebApiError("quota", 429, "rate_limited", attempts === 1 ? 63 : 1);
      return { ticket: "opaque-after-quota-ticket", expires_in: 30 };
    },
  });
  await flush();
  assert.deepEqual(f.clock.delays(), [63_000]);
  f.clock.advance(62_999);
  await flush();
  assert.equal(f.tickets(), 1);
  f.clock.advance(1);
  await flush();
  assert.equal(f.tickets(), 2);
  assert.deepEqual(
    f.clock.delays(),
    [2000],
    "a shorter Retry-After does not defeat exponential backoff",
  );
  f.clock.advance(2000);
  await flush();
  assert.equal(f.sockets.length, 1);
  f.controller.stop();
});

test("12-second connect deadline aborts an unresponsive ticket and ignores its late success", async () => {
  const slow = deferred<unknown>();
  let calls = 0;
  const f = fixture({
    requestTicket: () =>
      ++calls === 1
        ? slow.promise
        : Promise.resolve({ ticket: "opaque-fresh-ticket", expires_in: 30 }),
  });
  f.clock.advance(12_000);
  await flush();
  assert.equal(f.signals[0].aborted, true);
  assert.equal(f.states.at(-1), "reconnecting");
  f.clock.advance(1000);
  await flush();
  assert.equal(f.sockets.length, 1);
  slow.resolve({ ticket: "opaque-obsolete-ticket", expires_in: 30 });
  await flush();
  assert.equal(f.sockets.length, 1);
  assert.ok(f.urls[0].includes("opaque-fresh-ticket"));
  f.controller.stop();
});

test("a socket that never opens times out and old-generation hints cannot extend the new connection", async () => {
  const f = fixture();
  await flush();
  const old = f.sockets[0];
  f.clock.advance(12_000);
  await flush();
  assert.equal(old.closed, 1);
  f.clock.advance(1000);
  await flush();
  f.sockets[1].opened();
  old.opened();
  old.message({ t: "poke", vault_id: VAULT });
  old.disconnected();
  assert.deepEqual(f.changes, [null]);
  assert.equal(f.states.at(-1), "live");
  assert.deepEqual(f.clock.delays(), [75_000]);
  f.controller.stop();
});

test("75-second heartbeat silence reconnects; only valid protocol messages extend liveness", async () => {
  const f = fixture();
  await flush();
  f.sockets[0].opened();
  f.clock.advance(74_000);
  f.sockets[0].message({ t: "ping" });
  f.clock.advance(74_000);
  assert.equal(f.states.at(-1), "live");
  f.sockets[0].message({ t: "poke", vault_id: "malformed" });
  f.clock.advance(1000);
  assert.equal(f.states.at(-1), "reconnecting");
  assert.equal(f.sockets[0].closed, 1);
  f.controller.stop();
});

test("malformed/expired tickets and echoed JWTs never become websocket URLs", async () => {
  for (const ticket of [
    session.session_jwt,
    "https://attacker.test",
    "short",
    "opaque-but-expired-ticket",
    "opaque-unknown-expiry",
  ]) {
    const f = fixture({
      requestTicket: async () => ({
        ticket,
        expires_in: ticket.includes("expired") ? 0 : ticket.includes("unknown") ? undefined : 30,
      }),
    });
    await flush();
    assert.equal(f.sockets.length, 0);
    assert.equal(f.states.at(-1), "reconnecting");
    f.controller.stop();
  }
});

test("pong send failure reconnects and stop removes every scheduled operation", async () => {
  const f = fixture();
  await flush();
  f.sockets[0].opened();
  f.sockets[0].sendError = true;
  f.sockets[0].message({ t: "ping" });
  assert.equal(f.states.at(-1), "reconnecting");
  f.controller.stop();
  assert.equal(f.clock.timers.size, 0);
  assert.equal(f.unsubscribed(), 1);
});

test("the browser adapter exchanges a bearer by POST through webRequest without cookies or redirects", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  const clock = new Clock();
  const socket = new Socket();
  let controller: { stop(): void } | undefined;
  let bearer = "";
  let ticketRequests = 0;
  const urls: string[] = [];
  try {
    clearWebSession();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/auth/google") {
        const body = JSON.parse(String(init?.body));
        const claims = {
          account_id: "adapter-account",
          install_id: body.install_id,
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
        bearer = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
        return Response.json({
          session_jwt: bearer,
          account_id: claims.account_id,
          default_vault_id: null,
          user: { has_password: true },
        });
      }
      assert.equal(pathname, "/v1/sync/live-ticket");
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${bearer}`);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal instanceof AbortSignal);
      ticketRequests++;
      return Response.json({ ticket: "opaque-browser-adapter-ticket", expires_in: 30 });
    }) as typeof fetch;
    const signedIn = await signInWithGoogle("fixture-google-token", createWebAuthNonce());
    controller = createWebLive({
      session: signedIn,
      backendUrl: "https://api.example.test",
      onChange: () => {},
      dependencies: {
        createSocket: (url) => {
          urls.push(url);
          return socket;
        },
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
    });
    await flush();
    assert.equal(ticketRequests, 1);
    assert.equal(urls.length, 1);
    assert.equal(new URL(urls[0]).search, "?ticket=opaque-browser-adapter-ticket");
    assert.ok(!urls[0].includes(bearer));
    socket.opened();
    clearWebSession();
    assert.equal(socket.closed, 1, "default session-event subscription closes on sign-out");
    assert.equal(clock.timers.size, 0);
  } finally {
    controller?.stop();
    clearWebSession();
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
