import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  clearWebSession,
  createWebAuthNonce,
  getWebSession,
  isSameWebSession,
  loadWebAuthProviders,
  parseWebSession,
  refreshWebSession,
  signInWithApple,
  signInWithEmail,
  signInWithGoogle,
  startWebEmailReset,
  startWebEmailSignup,
  verifyWebEmailReset,
  verifyWebEmailSignup,
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
const tabStorage = new Map<string, string>();
const events = new EventTarget();
let changes = 0;
events.addEventListener(WEB_SESSION_EVENT, () => changes++);
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    sessionStorage: {
      getItem: (key: string) => tabStorage.get(key) ?? null,
      setItem: (key: string, value: string) => tabStorage.set(key, value),
      removeItem: (key: string) => tabStorage.delete(key),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: (...args: Parameters<EventTarget["addEventListener"]>) =>
      events.addEventListener(...args),
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

function storageChanged(key: string | null = "kaata_web_session_v2") {
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: key });
  events.dispatchEvent(event);
}

function renewedSession(current: WebSession, changes: Record<string, unknown> = {}): WebSession {
  const claims = JSON.parse(Buffer.from(current.session_jwt.split(".")[1], "base64url").toString());
  const token = `header.${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 86_400, ...changes })).toString("base64url")}.renewed`;
  return { ...current, session_jwt: token };
}

beforeEach(() => {
  clearWebSession();
  storage.clear();
  tabStorage.clear();
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

test("reopening a new tab restores the same browser credential without provider sign-in", async () => {
  loginFetch();
  const current = await signInWithGoogle("one-use-google-token", createWebAuthNonce());
  assert.deepEqual(JSON.parse(storage.get("kaata_web_session_v2")!), current);
  assert.equal(tabStorage.has("kaata_web_session_v2"), false);
  tabStorage.clear();
  const reopened = await import(`./web-auth.ts?reopened=${crypto.randomUUID()}`);
  assert.deepEqual(reopened.getWebSession(), current);
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++;
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${current.session_jwt}`);
    return Response.json({ vaults: [] });
  }) as typeof fetch;
  await reopened.webRequest("/v1/vaults");
  assert.equal(requests, 1);
});

test("an existing tab migrates only its matching signing identity and pending batch", () => {
  const current = session();
  const identity = JSON.stringify({
    installID: current.install_id,
    publicKey: "key",
    privateKey: "key",
  });
  const pending = JSON.stringify({
    installID: current.install_id,
    accountID: current.account_id,
    events: [{ event_id: "same-id-after-reopen" }],
  });
  tabStorage.set("kaata_web_session_v1", JSON.stringify(current));
  tabStorage.set("kaata_web_signing_v1", identity);
  tabStorage.set("kaata_web_pending_v1", pending);
  assert.deepEqual(getWebSession(), current);
  assert.equal(storage.get("kaata_web_signing_v1"), identity);
  assert.equal(storage.get("kaata_web_pending_v1"), pending);
  assert.equal(tabStorage.has("kaata_web_session_v1"), false);
  assert.equal(tabStorage.has("kaata_web_signing_v1"), false);
  assert.equal(tabStorage.has("kaata_web_pending_v1"), false);
  tabStorage.clear();
  assert.deepEqual(getWebSession(), current);
});

test("damaged or different-account legacy material cannot prevent durable session migration", () => {
  const current = session();
  tabStorage.set("kaata_web_session_v1", JSON.stringify(current));
  tabStorage.set("kaata_web_signing_v1", "damaged");
  tabStorage.set(
    "kaata_web_pending_v1",
    JSON.stringify({ installID: current.install_id, accountID: "someone-else" }),
  );
  assert.deepEqual(getWebSession(), current);
  assert.equal(storage.has("kaata_web_signing_v1"), false);
  assert.equal(storage.has("kaata_web_pending_v1"), false);
  tabStorage.clear();
  assert.deepEqual(getWebSession(), current);
});

test("a browser-wide logout takes precedence over stale tab-only sessions", async () => {
  loginFetch();
  const current = await signInWithGoogle("token", createWebAuthNonce());
  clearWebSession();
  tabStorage.set("kaata_web_session_v1", JSON.stringify(current));
  storageChanged();
  assert.equal(getWebSession(), null);
  assert.equal(tabStorage.has("kaata_web_session_v1"), false);
  assert.equal(storage.get("kaata_web_session_v2"), "null");
});

test("another tab's login or logout updates the current session and cancels a pending login", async () => {
  loginFetch();
  const old = await signInWithGoogle("token", createWebAuthNonce());
  let finish!: (response: Response) => void;
  let pendingInstall = "";
  globalThis.fetch = ((_url, init) =>
    new Promise<Response>((resolve) => {
      finish = resolve;
      pendingInstall = JSON.parse(init?.body as string).install_id;
    })) as typeof fetch;
  const pending = signInWithGoogle("slow-token", createWebAuthNonce());
  const other = session("another-browser-install", "another-account");
  storage.set("kaata_web_session_v2", JSON.stringify(other));
  const before = changes;
  storageChanged();
  assert.ok(changes > before);
  assert.deepEqual(getWebSession(), other);
  finish(Response.json(session(pendingInstall)));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
  );
  assert.deepEqual(getWebSession(), other);
  storage.set("kaata_web_session_v2", "null");
  storageChanged();
  assert.equal(getWebSession(), null);
  assert.notEqual(old.install_id, other.install_id);
});

test("rolling renewal preserves credential identity, rejects changed claims, and never revives logout", async () => {
  loginFetch();
  const current = await signInWithGoogle("token", createWebAuthNonce());
  const renewed = renewedSession(current);
  assert.equal(isSameWebSession(renewed, current), true);
  for (const claim of [
    { account_id: "other" },
    { install_id: "other" },
    { ep: 123 },
    { provider: "apple" },
    { provider_sub: "other" },
  ]) {
    const changed = renewedSession(current, claim);
    assert.equal(isSameWebSession(changed, current), false);
    assert.equal(refreshWebSession(current, changed.session_jwt), false);
  }
  assert.equal(refreshWebSession(current, current.session_jwt), false);
  assert.equal(refreshWebSession(current, renewed.session_jwt), true);
  assert.deepEqual(getWebSession(), renewed);
  assert.deepEqual(JSON.parse(storage.get("kaata_web_session_v2")!), renewed);
  assert.equal(refreshWebSession(current, renewedSession(renewed).session_jwt), false);
  clearWebSession();
  assert.equal(refreshWebSession(renewed, renewedSession(renewed).session_jwt), false);
  assert.equal(getWebSession(), null);
});

test("a delayed storage event cannot let an old sign-in overwrite another tab's login or logout", async () => {
  for (const next of [JSON.stringify(session("other-install", "other-account")), "null"]) {
    storage.clear();
    let finish!: (response: Response) => void;
    let install = "";
    globalThis.fetch = ((_url, init) =>
      new Promise<Response>((resolve) => {
        finish = resolve;
        install = JSON.parse(init?.body as string).install_id;
      })) as typeof fetch;
    const pending = signInWithGoogle("slow-token", createWebAuthNonce());
    storage.set("kaata_web_session_v2", next);
    finish(Response.json(session(install)));
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
    );
    assert.equal(storage.get("kaata_web_session_v2"), next);
  }
});

test("late sign-out cannot clear a newer sign-in made while revocation is in flight", async () => {
  loginFetch();
  await signInWithGoogle("token", createWebAuthNonce());
  let finish!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    })) as typeof fetch;
  const leaving = signOut();
  loginFetch();
  const newer = await signInWithGoogle("new-token", createWebAuthNonce());
  finish(new Response(null, { status: 204 }));
  await leaving;
  assert.deepEqual(getWebSession(), newer);
});

test("a stale 401 cannot erase a silently renewed credential, and expired saved sessions stay closed", async () => {
  loginFetch();
  const current = await signInWithGoogle("token", createWebAuthNonce());
  let finish!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    })) as typeof fetch;
  const pending = webRequest("/v1/vaults").catch(() => {});
  const renewed = renewedSession(current);
  assert.equal(refreshWebSession(current, renewed.session_jwt), true);
  finish(Response.json({ error: "old token rejected" }, { status: 401 }));
  await pending;
  assert.deepEqual(getWebSession(), renewed);
  storage.set(
    "kaata_web_session_v2",
    JSON.stringify(session("expired", "account", Date.now() - 1000)),
  );
  assert.equal(getWebSession(), null);
});

test("each explicit login gets a new web install; provider credentials are never stored", async () => {
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
  assert.equal(storage.get("kaata_web_session_v2"), "null");
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

test("email sign-in uses the mobile email-or-username contract and saves only the Kaata session", async () => {
  const installs: string[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/v1/auth/email/signin");
    assert.equal(new URL(String(url)).search, "");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.identifier, installs.length ? "@shopkeeper" : "owner@example.test");
    assert.equal(body.password, "do-not-store-this-password");
    assert.equal(body.platform, "web");
    installs.push(body.install_id);
    return Response.json(session(body.install_id));
  }) as typeof fetch;
  await signInWithEmail("  owner@example.test  ", "do-not-store-this-password");
  const current = await signInWithEmail("  @shopkeeper  ", "do-not-store-this-password");
  assert.notEqual(installs[0], installs[1]);
  assert.deepEqual(getWebSession(), current);
  assert.ok(storage.has("kaata_web_session_v2"));
  assert.ok(
    [...storage.values(), ...tabStorage.values()].every(
      (value) => !value.includes("do-not-store-this-password"),
    ),
  );
});

test("email code requests are public, generic, localized and do not alter a current sign-in", async () => {
  loginFetch();
  const current = await signInWithGoogle("token", createWebAuthNonce());
  const paths: string[] = [];
  globalThis.fetch = (async (url, init) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      email: "code-recipient@example.test",
      lang: "fa",
    });
    return Response.json({ status: "sent", resend_after_s: 73 });
  }) as typeof fetch;
  assert.deepEqual(await startWebEmailSignup("  code-recipient@example.test  ", "fa"), {
    resendAfterSeconds: 73,
  });
  assert.deepEqual(await startWebEmailReset("  code-recipient@example.test  ", "fa"), {
    resendAfterSeconds: 73,
  });
  assert.deepEqual(paths, ["/v1/auth/email/signup/start", "/v1/auth/email/reset/start"]);
  assert.deepEqual(getWebSession(), current);
  assert.ok(
    [...storage.values(), ...tabStorage.values()].every(
      (value) => !value.includes("code-recipient"),
    ),
  );
});

test("email code requests validate the sent response and use the server's default resend delay", async () => {
  for (const body of [null, {}, { status: "unknown" }]) {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    await assert.rejects(
      () => startWebEmailSignup("owner@example.test", "en"),
      (error: unknown) => error instanceof WebApiError && error.code === "invalid_response",
    );
  }
  for (const delay of [undefined, "60", -1, null]) {
    globalThis.fetch = (async () =>
      Response.json({ status: "sent", resend_after_s: delay })) as typeof fetch;
    assert.deepEqual(await startWebEmailReset("owner@example.test", "en"), {
      resendAfterSeconds: 60,
    });
  }
  globalThis.fetch = (async () =>
    Response.json({ status: "sent", resend_after_s: 0 })) as typeof fetch;
  assert.deepEqual(await startWebEmailReset("owner@example.test", "en"), { resendAfterSeconds: 0 });
});

test("email signup and reset verification use fresh web identities without storing codes or passwords", async () => {
  const bodies: Record<string, string>[] = [];
  const paths: string[] = [];
  globalThis.fetch = (async (url, init) => {
    paths.push(new URL(String(url)).pathname);
    assert.equal(new URL(String(url)).search, "");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return Response.json(session(body.install_id));
  }) as typeof fetch;
  await verifyWebEmailSignup({
    email: " signup@example.test ",
    code: "927461",
    password: "signup-password-private",
    lang: "ps",
  });
  await verifyWebEmailReset({
    email: " reset@example.test ",
    code: "381792",
    newPassword: "reset-password-private",
    lang: "fa",
  });
  assert.deepEqual(paths, ["/v1/auth/email/signup/verify", "/v1/auth/email/reset/verify"]);
  assert.equal(bodies[0].email, "signup@example.test");
  assert.equal(bodies[0].password, "signup-password-private");
  assert.equal(bodies[0].code, "927461");
  assert.equal(bodies[0].lang, "ps");
  assert.equal(bodies[1].email, "reset@example.test");
  assert.equal(bodies[1].new_password, "reset-password-private");
  assert.equal(bodies[1].password, undefined);
  assert.equal(bodies[1].newPassword, undefined);
  assert.equal(bodies[1].code, "381792");
  assert.equal(bodies[1].lang, "fa");
  assert.notEqual(bodies[0].install_id, bodies[1].install_id);
  assert.ok(bodies.every((body) => body.platform === "web"));
  const persisted = [...storage.values(), ...tabStorage.values()].join(" ");
  for (const secret of ["signup-password-private", "reset-password-private", "927461", "381792"])
    assert.ok(!persisted.includes(secret));
});

test("email refusals preserve the session and retain actionable code, reason and cooldown", async () => {
  loginFetch();
  const current = await signInWithGoogle("token", createWebAuthNonce());
  globalThis.fetch = (async () =>
    Response.json(
      { error: "incorrect", error_code: "invalid_credentials" },
      { status: 401 },
    )) as typeof fetch;
  await assert.rejects(
    () => signInWithEmail("owner@example.test", "wrong"),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_credentials",
  );
  assert.deepEqual(getWebSession(), current);
  globalThis.fetch = (async () =>
    Response.json(
      { error: "invalid email", error_code: "invalid_email", reason: "disposable" },
      { status: 400 },
    )) as typeof fetch;
  await assert.rejects(
    () => startWebEmailSignup("owner@example.test", "en"),
    (error: unknown) => error instanceof WebApiError && error.reason === "disposable",
  );
  globalThis.fetch = (async () =>
    Response.json(
      { error: "wait", error_code: "too_many_requests", retry_after_s: 84 },
      { status: 429 },
    )) as typeof fetch;
  await assert.rejects(
    () => startWebEmailReset("owner@example.test", "en"),
    (error: unknown) => error instanceof WebApiError && error.retryAfterSeconds === 84,
  );
  assert.deepEqual(getWebSession(), current);
});

test("an explicitly uncertain verification retry can reconcile a previously completed signup or reset", async () => {
  for (const reason of ["invalid_code", "account_exists"]) {
    const requests: { path: string; body: Record<string, string> }[] = [];
    globalThis.fetch = (async (url, init) => {
      const request = { path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) };
      requests.push(request);
      if (requests.length === 1)
        return Response.json({ error: "code already used", error_code: reason }, { status: 401 });
      return Response.json(session(request.body.install_id));
    }) as typeof fetch;
    const current =
      reason === "account_exists"
        ? await verifyWebEmailSignup(
            {
              email: "owner@example.test",
              code: "123456",
              password: "private-password",
              lang: "en",
            },
            { afterTimeout: true },
          )
        : await verifyWebEmailReset(
            {
              email: "owner@example.test",
              code: "123456",
              newPassword: "private-password",
              lang: "en",
            },
            { afterTimeout: true },
          );
    assert.equal(requests.length, 2);
    assert.equal(requests[1].path, "/v1/auth/email/signin");
    assert.equal(requests[1].body.identifier, "owner@example.test");
    assert.equal(requests[1].body.password, "private-password");
    assert.equal(requests[1].body.install_id, requests[0].body.install_id);
    assert.equal(requests[1].body.platform, "web");
    assert.equal(getWebSession()?.install_id, current.install_id);
  }
});

test("normal code refusals and throttles never trigger hidden password sign-in attempts", async () => {
  for (const [reason, afterTimeout] of [
    ["invalid_code", false],
    ["too_many_attempts", true],
  ] as const) {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ error: "refused", error_code: reason }, { status: 401 });
    }) as typeof fetch;
    await assert.rejects(
      () =>
        verifyWebEmailSignup(
          { email: "owner@example.test", code: "123456", password: "private-password", lang: "en" },
          { afterTimeout },
        ),
      (error: unknown) => error instanceof WebApiError && error.code === reason,
    );
    assert.equal(requests, 1);
  }
});

test("a failed retry reconciliation retains the original verification refusal", async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json(
      { error: "refused", error_code: requests === 1 ? "invalid_code" : "invalid_credentials" },
      { status: 401 },
    );
  }) as typeof fetch;
  await assert.rejects(
    () =>
      verifyWebEmailReset(
        {
          email: "owner@example.test",
          code: "123456",
          newPassword: "private-password",
          lang: "en",
        },
        { afterTimeout: true },
      ),
    (error: unknown) => error instanceof WebApiError && error.code === "invalid_code",
  );
  assert.equal(requests, 2);
  assert.equal(getWebSession(), null);
});

test("leaving an uncertain email verify prevents a late refusal from starting reconciliation", async () => {
  let finish!: (response: Response) => void;
  let requests = 0;
  globalThis.fetch = (() => {
    requests++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch;
  const pending = verifyWebEmailSignup(
    { email: "owner@example.test", code: "123456", password: "private-password", lang: "en" },
    { afterTimeout: true },
  );
  clearWebSession();
  finish(Response.json({ error: "code consumed", error_code: "invalid_code" }, { status: 401 }));
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
  );
  assert.equal(requests, 1);
  assert.equal(getWebSession(), null);
});

test("a late email login or reconciliation cannot restore a logged-out session", async () => {
  for (const reconcile of [false, true]) {
    let finish!: (response: Response) => void;
    let install = "";
    let requests = 0;
    globalThis.fetch = ((_url, init) => {
      install = JSON.parse(String(init?.body)).install_id;
      requests++;
      if (reconcile && requests === 1)
        return Promise.resolve(
          Response.json({ error: "code consumed", error_code: "invalid_code" }, { status: 401 }),
        );
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch;
    const pending = reconcile
      ? verifyWebEmailReset(
          {
            email: "owner@example.test",
            code: "123456",
            newPassword: "private-password",
            lang: "en",
          },
          { afterTimeout: true },
        )
      : signInWithEmail("owner@example.test", "private-password");
    for (let i = 0; i < 12 && !finish; i++) await Promise.resolve();
    assert.ok(finish);
    clearWebSession();
    finish(Response.json(session(install)));
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof WebApiError && error.code === "signin_cancelled",
    );
    assert.equal(getWebSession(), null);
  }
});
