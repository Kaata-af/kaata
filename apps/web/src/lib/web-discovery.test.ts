import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { clearWebSession, getWebSession, type WebSession } from "./web-auth";
import { getWebDiscovery, parseWebDiscovery, setWebDiscovery } from "./web-discovery";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
const browser = Object.assign(new EventTarget(), {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
function login(epoch = 1) {
  clearWebSession();
  const claims = {
    account_id: "account-a",
    install_id: "browser-a",
    provider: "email",
    ep: epoch,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const session: WebSession = {
    account_id: claims.account_id,
    install_id: claims.install_id,
    default_vault_id: null,
    user: { has_password: true },
    session_jwt: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`,
  };
  storage.set("kaata_web_session_v2", JSON.stringify(session));
  return getWebSession()!;
}
beforeEach(() => {
  clearWebSession();
  storage.clear();
});
after(() => {
  clearWebSession();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("visibility is a strict server boolean, including explicit false", () => {
  assert.equal(parseWebDiscovery({ discovery_enabled: false }), false);
  assert.equal(parseWebDiscovery({ discovery_enabled: true }), true);
  for (const value of [null, {}, { discovery_enabled: "false" }, { discovery_enabled: null }])
    assert.throws(() => parseWebDiscovery(value), /could not be confirmed/);
});

test("profile privacy uses authenticated GET and one independent PUT with explicit false", async () => {
  const session = login();
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init: init! });
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${session.session_jwt}`);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.cache, "no-store");
    return Response.json({ discovery_enabled: init?.method !== "PUT" });
  }) as typeof fetch;
  assert.equal(await getWebDiscovery(session), true);
  assert.equal(await setWebDiscovery(session, false), false);
  assert.ok(requests[0].url.endsWith("/v1/account/me"));
  assert.ok(requests[1].url.endsWith("/v1/account/discovery"));
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), { enabled: false });
  assert.equal(requests.length, 2);
});

test("an old profile cannot mutate a replacement session or accept its delayed response", async () => {
  const old = login();
  let reply!: (value: Response) => void;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return new Promise<Response>((resolve) => {
      reply = resolve;
    });
  }) as typeof fetch;
  const pending = getWebDiscovery(old);
  login(2);
  reply(Response.json({ discovery_enabled: true }));
  await assert.rejects(() => pending, /session has changed/);
  await assert.rejects(() => setWebDiscovery(old, false), /session has changed/);
  assert.equal(calls, 1);
});

test("a failed PUT is never retried by the request adapter", async () => {
  const session = login();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("connection lost");
  }) as typeof fetch;
  await assert.rejects(() => setWebDiscovery(session, false), /Cannot reach/);
  assert.equal(calls, 1);
});
