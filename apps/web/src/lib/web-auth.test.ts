import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearWebSession,
  createWebAuthNonce,
  getWebSession,
  loadWebAuthProviders,
  parseWebSession,
  signInWithApple,
  signInWithGoogle,
  signOut,
  webRequest,
  WEB_SESSION_EVENT,
  WebApiError,
  type WebSession,
} from "./web-auth";
import { BACKEND_URL } from "../env";

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

test("each login gets a new web install; provider credentials never enter session storage", async () => {
  const installs: string[] = [];
  loginFetch((body) => {
    assert.equal(body.platform, "web");
    assert.equal(body.id_token, "never-persist-this-provider-token");
    installs.push(body.install_id);
  });
  const first = await signInWithGoogle("never-persist-this-provider-token", createWebAuthNonce());
  const second = await signInWithGoogle("never-persist-this-provider-token", createWebAuthNonce());
  assert.notEqual(first.install_id, second.install_id);
  assert.equal(installs.length, 2);
  assert.equal(changes, 2);
  assert.equal(
    [...storage.values()].some((value) => value.includes("never-persist-this-provider-token")),
    false,
  );
});

test("authenticated requests use bearer headers and cannot redirect or send cookies", async () => {
  loginFetch();
  const current = await signInWithGoogle("fixture-google-token", createWebAuthNonce());
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
  await signInWithGoogle("fixture-google-token", createWebAuthNonce());
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
  await signInWithGoogle("fixture-google-token", createWebAuthNonce());
  let resolveOld!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      resolveOld = resolve;
    })) as typeof fetch;
  const pending = webRequest("/v1/vaults").catch((error: unknown) => error);
  loginFetch();
  const newSession = await signInWithGoogle("fixture-google-token", createWebAuthNonce());
  resolveOld(Response.json({ error: "revoked" }, { status: 401 }));
  await pending;
  assert.equal(getWebSession()?.install_id, newSession.install_id);
});

test("public invalid credentials preserve session; backend error_code and cooldown are retained", async () => {
  loginFetch();
  const current = await signInWithGoogle("fixture-google-token", createWebAuthNonce());
  globalThis.fetch = (async () =>
    Response.json(
      { error: "incorrect", error_code: "invalid_credentials" },
      { status: 401 },
    )) as typeof fetch;
  await assert.rejects(
    () => signInWithGoogle("invalid-google-token", createWebAuthNonce()),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_credentials",
  );
  assert.equal(getWebSession()?.install_id, current.install_id);
  globalThis.fetch = (async () =>
    Response.json(
      { error: "slow down", error_code: "too_many_attempts", retry_after_s: 63 },
      { status: 429 },
    )) as typeof fetch;
  await assert.rejects(
    () => signInWithGoogle("invalid-google-token", createWebAuthNonce()),
    (error: unknown) => error instanceof WebApiError && error.retryAfterSeconds === 63,
  );
});

test("sign-out preserves retry on network failure and clears only after server revocation", async () => {
  loginFetch();
  await signInWithGoogle("fixture-google-token", createWebAuthNonce());
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

test("runtime provider discovery is public, abortable, and uses the safe request options", async () => {
  loginFetch();
  const current = await signInWithGoogle("fixture-google-token", createWebAuthNonce());
  const providers = {
    google: { client_id: "fixture.apps.googleusercontent.com" },
    apple: { start_url: `${BACKEND_URL}/v1/auth/apple/browser/start` },
  };
  const controller = new AbortController();
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, `${BACKEND_URL}/v1/auth/providers`);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    return Response.json(providers);
  }) as typeof fetch;
  assert.deepEqual(await loadWebAuthProviders(controller.signal), providers);
  assert.equal(getWebSession()?.install_id, current.install_id);
  globalThis.fetch = ((_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  const pending = loadWebAuthProviders(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("provider discovery rejects malformed public IDs and untrusted Apple redirects", async () => {
  for (const body of [
    null,
    {},
    { google: false, apple: null },
    { google: { client_id: "bad client id" }, apple: null },
    { google: null, apple: { start_url: "https://attacker.invalid/v1/auth/apple/browser/start" } },
    {
      google: null,
      apple: { start_url: `${BACKEND_URL}/v1/auth/apple/browser/start?redirect=elsewhere` },
    },
    { google: null, apple: { start_url: `${BACKEND_URL}/v1/auth/apple/browser/start#token` } },
    { google: null, apple: { start_url: `${BACKEND_URL}/v1/auth/apple/web/start` } },
  ]) {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    await assert.rejects(
      loadWebAuthProviders,
      (error: unknown) => error instanceof WebApiError && error.code === "invalid_response",
    );
  }
  globalThis.fetch = (async () => Response.json({ google: null, apple: null })) as typeof fetch;
  assert.deepEqual(await loadWebAuthProviders(), { google: null, apple: null });
});

test("provider sign-in sends the attempt nonce and a fresh browser identity without persisting provider tokens", async () => {
  const nonce = createWebAuthNonce();
  const bodies: Record<string, string>[] = [];
  loginFetch((body) => bodies.push(body));
  await signInWithGoogle("secret-google-credential", nonce);
  await signInWithApple("secret-apple-credential", "Fixture Person", nonce);
  assert.equal(bodies[0].id_token, "secret-google-credential");
  assert.equal(bodies[1].identity_token, "secret-apple-credential");
  assert.equal(bodies[1].display_name, "Fixture Person");
  assert.notEqual(bodies[0].install_id, bodies[1].install_id);
  for (const body of bodies) {
    assert.equal(body.nonce, nonce);
    assert.equal(body.platform, "web");
  }
  assert.ok(
    [...storage.values()].every(
      (value) =>
        !value.includes("secret-google-credential") && !value.includes("secret-apple-credential"),
    ),
  );
  await assert.rejects(
    () => signInWithGoogle("token", ""),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_nonce",
  );
  await assert.rejects(
    () => signInWithApple("token", "Name", "invalid nonce"),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_nonce",
  );
  assert.equal(bodies.length, 2);
});

test("OAuth nonces contain 256 random bits represented by URL-safe characters", () => {
  const first = createWebAuthNonce();
  const second = createWebAuthNonce();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
});

test("a late provider response cannot overwrite a newer sign-in or restore a cleared session", async () => {
  const pending: { install: string; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((_url, init) =>
    new Promise<Response>((resolve) => {
      pending.push({ install: JSON.parse(init?.body as string).install_id, resolve });
    })) as typeof fetch;
  const older = signInWithGoogle("older-token", createWebAuthNonce());
  const newer = signInWithApple("newer-token", "Name", createWebAuthNonce());
  pending[1].resolve(Response.json(session(pending[1].install, "newer-account")));
  await newer;
  pending[0].resolve(Response.json(session(pending[0].install, "older-account")));
  await assert.rejects(
    older,
    (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
  );
  assert.equal(getWebSession()?.account_id, "newer-account");
  const cleared = signInWithGoogle("another-token", createWebAuthNonce());
  clearWebSession();
  pending[2].resolve(Response.json(session(pending[2].install, "cleared-account")));
  await assert.rejects(
    cleared,
    (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
  );
  assert.equal(getWebSession(), null);
});
