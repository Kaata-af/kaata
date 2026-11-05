import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { getWebSession, signOut } from "./web-auth";
import {
  captureSharedInvitation,
  clearSharedInvitation,
  pendingSharedInvitation,
  sharedInvitationToken,
} from "./web-shared-invite";

const KEY = "kaata_web_shared_invitation_v1";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const stored = new Map<string, string>();
const local = new Map<string, string>();
const operations: string[] = [];
let now = 1_800_000_000_000;
const browser = Object.assign(new EventTarget(), {
  location: { pathname: "/app", search: "", hash: "" },
  history: {
    state: { route: "synthetic" },
    replaceState(_state: unknown, _unused: string, path: string) {
      operations.push(`scrub:${path}`);
      browser.location.hash = "";
    },
  },
  sessionStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      operations.push(`write:${key}`);
      stored.set(key, value);
    },
    removeItem: (key: string) => stored.delete(key),
  },
  localStorage: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: browser.sessionStorage,
});
Date.now = () => now;
beforeEach(() => {
  clearSharedInvitation();
  stored.clear();
  local.clear();
  operations.length = 0;
  browser.location.hash = "";
  browser.location.search = "";
  now = 1_800_000_000_000;
});
after(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

test("shared invitations accept Kaata links and opaque tokens without accepting unrelated URLs", () => {
  const token = "g_abcdefghijklmnopqrstuvwx";
  assert.equal(sharedInvitationToken(`https://kaata.af/t/${token}`), token);
  assert.equal(sharedInvitationToken(token), token);
  assert.equal(sharedInvitationToken(`https://kaata.af.evil.test/t/${token}`), null);
  assert.equal(sharedInvitationToken(`http://kaata.af/t/${token}`), null);
  assert.equal(sharedInvitationToken(`https://evil@kaata.af/t/${token}`), null);
  assert.equal(sharedInvitationToken("https://kaata.af/t/short"), null);
});

test("invitation fragments are scrubbed before caching and survive the auth-route handoff", () => {
  const token = "g_abcdefghijklmnopqrstuvwx";
  browser.location.hash = `#shared_invite=${encodeURIComponent(token)}`;
  captureSharedInvitation();
  assert.equal(operations[0], "scrub:/app");
  assert.equal(browser.location.hash, "");
  assert.equal(pendingSharedInvitation(), token);
  captureSharedInvitation();
  assert.equal(
    pendingSharedInvitation(),
    token,
    "an ordinary route change keeps the intended invitation",
  );
  assert.equal(local.size, 0, "the token stays in this tab's temporary storage");
});

test("an explicit malformed or ambiguous invitation cannot reuse an older cached token", () => {
  for (const fragment of [
    "#shared_invite=short",
    "#shared_invite=abcdefghijklmnop&shared_invite=qrstuvwxyzabcdef",
  ]) {
    browser.location.hash = "#shared_invite=g_abcdefghijklmnopqrstuvwx";
    captureSharedInvitation();
    browser.location.hash = fragment;
    captureSharedInvitation();
    assert.equal(browser.location.hash, "");
    assert.equal(pendingSharedInvitation(), null);
  }
});

test("temporary invitations expire at fifteen minutes and reject future or malformed cache data", () => {
  browser.location.hash = "#shared_invite=g_abcdefghijklmnopqrstuvwx";
  captureSharedInvitation();
  now += 15 * 60_000 - 1;
  assert.equal(pendingSharedInvitation(), "g_abcdefghijklmnopqrstuvwx");
  now++;
  assert.equal(pendingSharedInvitation(), null);
  assert.equal(stored.has(KEY), false);
  for (const value of [
    JSON.stringify({ token: "g_abcdefghijklmnopqrstuvwx", at: now + 1 }),
    JSON.stringify({ token: ["g_abcdefghijklmnopqrstuvwx"], at: now }),
    JSON.stringify({ token: "g_abcdefghijklmnopqrstuvwx", at: "recent" }),
    "malformed JSON",
  ]) {
    clearSharedInvitation();
    stored.set(KEY, value);
    assert.equal(pendingSharedInvitation(), null);
    assert.equal(stored.has(KEY), false);
  }
});

test("explicit sign-out clears its pending invitation", async () => {
  const account = "11111111-1111-4111-8111-111111111111";
  const install = "22222222-2222-4222-8222-222222222222";
  const claims = {
    account_id: account,
    install_id: install,
    provider: "google",
    provider_sub: "fixture",
    ep: 1,
    exp: Math.floor(now / 1000) + 3600,
  };
  local.set(
    "kaata_web_session_v2",
    JSON.stringify({
      account_id: account,
      install_id: install,
      user: { has_password: false },
      default_vault_id: null,
      session_jwt: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`,
    }),
  );
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  browser.location.hash = "#shared_invite=g_abcdefghijklmnopqrstuvwx";
  captureSharedInvitation();
  await signOut();
  assert.equal(pendingSharedInvitation(), null);
  assert.equal(stored.has(KEY), false);
});

test("an expired saved session keeps a newly captured invitation for sign-in", () => {
  local.set(
    "kaata_web_session_v2",
    JSON.stringify({
      account_id: "expired-account",
      install_id: "expired-install",
      default_vault_id: null,
      user: { has_password: false },
      session_jwt: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) - 1 })).toString("base64url")}.fixture`,
    }),
  );
  browser.location.hash = "#shared_invite=g_abcdefghijklmnopqrstuvwx";
  captureSharedInvitation();
  assert.equal(getWebSession(), null);
  assert.equal(pendingSharedInvitation(), "g_abcdefghijklmnopqrstuvwx");
});

test("an invitation remains usable in memory when temporary storage is unavailable", () => {
  const write = browser.sessionStorage.setItem;
  browser.sessionStorage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  try {
    browser.location.hash = "#shared_invite=g_abcdefghijklmnopqrstuvwx";
    captureSharedInvitation();
    assert.equal(pendingSharedInvitation(), "g_abcdefghijklmnopqrstuvwx");
    assert.equal(stored.size, 0);
    clearSharedInvitation();
    assert.equal(pendingSharedInvitation(), null);
  } finally {
    browser.sessionStorage.setItem = write;
  }
});
