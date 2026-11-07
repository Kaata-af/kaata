import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { clearWebSession, createWebAuthNonce, signInWithGoogle, WebApiError } from "./web-auth";
import { getWebVaultAudit, renameLegacyWebVault } from "./web-vault-settings";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const VAULT_ID = "10000000-0000-4000-8000-000000000001";

function fixtureStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

beforeEach(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      localStorage: fixtureStorage(),
      sessionStorage: fixtureStorage(),
    }),
  });
  globalThis.fetch = async (_url, init) => {
    const { install_id } = JSON.parse(String(init?.body));
    const claims = {
      account_id: "fixture-account",
      install_id,
      ep: 1,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    return Response.json({
      account_id: claims.account_id,
      default_vault_id: VAULT_ID,
      user: { has_password: false },
      session_jwt: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
    });
  };
  await signInWithGoogle("fixture-provider-token", createWebAuthNonce());
});

after(() => {
  clearWebSession();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const entry = {
  id: 7,
  vault_id: VAULT_ID,
  actor_id: "fixture-account",
  kind: "invite_issued",
  occurred_at_ms: 1760000000000,
};
const signal = new AbortController().signal;

test("legacy rename sends only the requested name to the selected kaata", async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, `/v1/vaults/${VAULT_ID}`);
    assert.equal(init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "New shop name" });
    assert.match(new Headers(init?.headers).get("Authorization") ?? "", /^Bearer /);
    return Response.json({ vault_id: VAULT_ID, name: "New shop name" });
  };
  await renameLegacyWebVault(VAULT_ID, "New shop name");
});

test("audit reads the older cursor and drops raw invite payloads", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, `/v1/vaults/${VAULT_ID}/audit-log`);
    assert.equal(url.searchParams.get("since_id"), "11");
    return Response.json({
      entries: [{ ...entry, payload: { target_email: "fixture@example.invalid" } }],
      next_since_id: 7,
      has_more: true,
    });
  };
  assert.deepEqual(await getWebVaultAudit(VAULT_ID, 11, signal), {
    entries: [entry],
    next_since_id: 7,
    has_more: true,
  });
});

test("audit rejects an entry from another kaata and a cursor that fails to advance", async () => {
  for (const page of [
    { entries: [{ ...entry, vault_id: "another-kaata" }], next_since_id: 7, has_more: true },
    { entries: [entry], next_since_id: 11, has_more: true },
  ]) {
    globalThis.fetch = async () => Response.json(page);
    await assert.rejects(
      getWebVaultAudit(VAULT_ID, 11, signal),
      (error) => error instanceof WebApiError && error.code === "invalid_response",
    );
  }
});

test("an audit response after sign-out cannot restore the old account's activity", async () => {
  let respond!: (response: Response) => void;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      respond = resolve;
    });
  const loading = getWebVaultAudit(VAULT_ID, null, signal);
  clearWebSession();
  respond(Response.json({ entries: [entry], next_since_id: 0, has_more: false }));
  await assert.rejects(
    loading,
    (error) => error instanceof WebApiError && error.code === "session_expired",
  );
});
