import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearWebSession,
  getWebSession,
  parseWebSession,
  signInWithPassword,
  signOut,
  webRequest,
  WEB_SESSION_EVENT,
  WebApiError,
  type WebSession,
} from "./web-auth";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const events = new EventTarget();
let changes = 0;
events.addEventListener(WEB_SESSION_EVENT, () => changes++);
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    localStorage: {
      setItem: () => assert.fail("An auth credential must never go in localStorage"),
    },
    dispatchEvent: (event: Event) => events.dispatchEvent(event),
  },
});

function session(
  install = "browser-install",
  account = "account-1",
  expires = Date.now() + 100_000,
): WebSession {
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), account_id: account, install_id: install })).toString("base64url")}.signature`;
  return {
    session_jwt: jwt,
    account_id: account,
    install_id: install,
    default_vault_id: null,
    user: { email: "fixture@example.com", has_password: true },
  };
}

function loginFetch(record?: (body: Record<string, string>) => void) {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    record?.(body);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return Response.json(session(body.install_id));
  }) as typeof fetch;
}

beforeEach(() => {
  clearWebSession();
  storage.clear();
  changes = 0;
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("cached auth rejects expiry, corruption, and a JWT bound to another account/install", () => {
  const valid = session();
  assert.deepEqual(parseWebSession(JSON.stringify(valid)), valid);
  assert.equal(
    parseWebSession(JSON.stringify(session("install", "account", Date.now() - 1000))),
    null,
  );
  assert.equal(parseWebSession("not json"), null);
  assert.equal(
    parseWebSession(JSON.stringify({ ...valid, user: { name: 42, has_password: true } })),
    null,
  );
  assert.equal(parseWebSession(JSON.stringify({ ...valid, account_id: "other-account" })), null);
  assert.equal(parseWebSession(JSON.stringify({ ...valid, install_id: "other-install" })), null);
});

test("each login gets a new web install; password never enters session storage", async () => {
  const installs: string[] = [];
  loginFetch((body) => {
    assert.equal(body.platform, "web");
    assert.equal(body.identifier, "fixture@example.com");
    installs.push(body.install_id);
  });
  const first = await signInWithPassword(" fixture@example.com ", "never-persist-this");
  const second = await signInWithPassword("fixture@example.com", "never-persist-this");
  assert.notEqual(first.install_id, second.install_id);
  assert.equal(installs.length, 2);
  assert.equal(changes, 2);
  assert.equal(
    [...storage.values()].some((value) => value.includes("never-persist-this")),
    false,
  );
});

test("authenticated requests use bearer headers and cannot redirect or send cookies", async () => {
  loginFetch();
  const current = await signInWithPassword("fixture@example.com", "password");
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${current.session_jwt}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json({ ok: true });
  }) as typeof fetch;
  assert.deepEqual(await webRequest("/v1/account/me"), { ok: true });
  await assert.rejects(() => webRequest("https://attacker.invalid/v1/account"), /Invalid API path/);
  await assert.rejects(() => webRequest("//attacker.invalid/v1/account"), /Invalid API path/);
});

test("401 ends the session, while permission errors preserve it", async () => {
  loginFetch();
  await signInWithPassword("fixture@example.com", "password");
  globalThis.fetch = (async () =>
    Response.json({ error: "forbidden" }, { status: 403 })) as typeof fetch;
  await assert.rejects(
    () => webRequest("/v1/vaults"),
    (error: unknown) => error instanceof WebApiError && error.status === 403,
  );
  assert.ok(getWebSession());
  globalThis.fetch = (async () =>
    Response.json({ error: "expired" }, { status: 401 })) as typeof fetch;
  await assert.rejects(() => webRequest("/v1/vaults"));
  assert.equal(getWebSession(), null);
  assert.equal(storage.size, 0);
});

test("late 401 from an older account cannot erase a newer sign-in", async () => {
  loginFetch();
  await signInWithPassword("fixture@example.com", "password");
  let resolveOld!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveOld = resolve;
    })) as typeof fetch;
  const pending = webRequest("/v1/vaults").catch((error: unknown) => error);
  loginFetch();
  const newSession = await signInWithPassword("fixture@example.com", "password");
  resolveOld(Response.json({ error: "revoked" }, { status: 401 }));
  await pending;
  assert.equal(getWebSession()?.install_id, newSession.install_id);
});

test("public invalid credentials preserve session; backend error_code and cooldown are retained", async () => {
  loginFetch();
  const current = await signInWithPassword("fixture@example.com", "password");
  globalThis.fetch = (async () =>
    Response.json(
      { error: "incorrect", error_code: "invalid_credentials" },
      { status: 401 },
    )) as typeof fetch;
  await assert.rejects(
    () => signInWithPassword("wrong", "wrong"),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_credentials",
  );
  assert.equal(getWebSession()?.install_id, current.install_id);
  globalThis.fetch = (async () =>
    Response.json(
      { error: "slow down", error_code: "too_many_attempts", retry_after_s: 63 },
      { status: 429 },
    )) as typeof fetch;
  await assert.rejects(
    () => signInWithPassword("wrong", "wrong"),
    (error: unknown) => error instanceof WebApiError && error.retryAfterSeconds === 63,
  );
});

test("sign-out preserves retry on network failure and clears only after server revocation", async () => {
  loginFetch();
  await signInWithPassword("fixture@example.com", "password");
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await assert.rejects(
    signOut,
    (error: unknown) => error instanceof WebApiError && error.code === "network",
  );
  assert.ok(getWebSession());
  globalThis.fetch = (async () => Response.json({ status: "ok" })) as typeof fetch;
  await signOut();
  assert.equal(getWebSession(), null);
});
