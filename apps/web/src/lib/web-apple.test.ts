import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKEND_URL } from "../env";
import { createWebAppleFlow } from "./web-apple";
import { createWebAuthNonce, type WebSession, WebApiError } from "./web-auth";

const START = `${BACKEND_URL}/v1/auth/apple/browser/start`;
const PENDING = "kaata_web_apple_pending_v1";
const NAME = "kaata_web_apple_name_v1";
const account = { account_id: "fixture" } as WebSession;

function token(subject = "fixture-apple-person") {
  return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function fixture() {
  const storage = new Map<string, string>();
  let now = 1_000_000;
  let url = "https://kaata.af/app?lang=en";
  const navigations: string[] = [];
  const calls: string[][] = [];
  let signIn = async (...args: string[]) => {
    calls.push(args);
    return account;
  };
  const environment = {
    storage: () => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    }),
    url: () => url,
    replaceURL: (next: string) => {
      url = new URL(next, url).href;
    },
    navigate: (next: string) => {
      navigations.push(next);
    },
    now: () => now,
    random: createWebAuthNonce,
    signIn: (...args: [string, string, string]) => signIn(...args),
  };
  let flow = createWebAppleFlow(environment);
  return {
    storage,
    navigations,
    calls,
    environment,
    get flow() {
      return flow;
    },
    get url() {
      return url;
    },
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    setSignIn: (implementation: typeof signIn) => {
      signIn = implementation;
    },
    reload: () => {
      flow = createWebAppleFlow(environment);
    },
    callback: (values: Record<string, string> = {}, includeDefaults = true) => {
      const pending = JSON.parse(storage.get(PENDING) ?? "null");
      const params = new URLSearchParams({
        ...(includeDefaults
          ? { kaata_apple: "1", state: pending?.state ?? "unknown", identity_token: token() }
          : {}),
        ...values,
      });
      url = `https://kaata.af/app?lang=en#${params}`;
    },
    setURL: (next: string) => {
      url = next;
    },
  };
}

test("Apple begins same-tab navigation with independent secure state and nonce, storing no credentials", () => {
  const f = fixture();
  f.flow.start(START);
  const pending = JSON.parse(f.storage.get(PENDING)!);
  const url = new URL(f.navigations[0]);
  assert.equal(url.origin, new URL(BACKEND_URL).origin);
  assert.equal(url.pathname, "/v1/auth/apple/browser/start");
  assert.match(pending.state, /^[a-f0-9]{64}$/);
  assert.match(pending.nonce, /^[a-f0-9]{64}$/);
  assert.notEqual(pending.state, pending.nonce);
  assert.equal(url.searchParams.get("state"), pending.state);
  assert.equal(url.searchParams.get("nonce"), pending.nonce);
  assert.equal(url.searchParams.get("return_origin"), "https://kaata.af");
  assert.deepEqual(Object.keys(pending).sort(), ["createdAt", "nonce", "state"]);
  assert.throws(() => f.flow.start("https://attacker.invalid/v1/auth/apple/browser/start"));
  assert.equal(f.navigations.length, 1);
});

test("Apple requests the initiating www origin and consumes its same-tab pending state there", async () => {
  const f = fixture();
  f.setURL("https://www.kaata.af/app?lang=fa");
  f.flow.start(START);
  assert.equal(new URL(f.navigations[0]).searchParams.get("return_origin"), "https://www.kaata.af");
  f.callback();
  f.setURL(f.url.replace("https://kaata.af", "https://www.kaata.af"));
  const result = f.flow.consume();
  assert.equal(f.url, "https://www.kaata.af/app?lang=en");
  assert.equal(f.storage.has(PENDING), false);
  if (result.status !== "ready") return assert.fail("same-origin return should be ready");
  await result.complete();
  assert.equal(f.calls.length, 1);
});

test("Apple allows local development return origins but rejects insecure non-local origins", () => {
  for (const origin of ["http://localhost:3004", "http://127.0.0.1:3004", "http://[::1]:3004"]) {
    const f = fixture();
    f.setURL(`${origin}/app?lang=fa`);
    f.flow.start(START);
    assert.equal(new URL(f.navigations[0]).searchParams.get("return_origin"), origin);
  }
  for (const origin of [
    "http://kaata.af",
    "http://www.kaata.af",
    "http://localhost.attacker.invalid",
    "file:///tmp",
  ]) {
    const f = fixture();
    f.setURL(`${origin}/app`);
    assert.throws(() => f.flow.start(START));
    assert.equal(f.navigations.length, 0);
    assert.equal(f.storage.size, 0);
  }
});

test("Apple refuses navigation when session storage cannot retain the pending attempt", () => {
  const f = fixture();
  f.environment.storage = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  f.reload();
  assert.throws(
    () => f.flow.start(START),
    (error: unknown) => error instanceof WebApiError && error.code === "apple_storage_unavailable",
  );
  assert.equal(f.navigations.length, 0);
});

test("Apple strips secrets immediately, consumes state once, and completes only once across StrictMode remounts", async () => {
  const f = fixture();
  f.flow.start(START);
  const nonce = JSON.parse(f.storage.get(PENDING)!).nonce;
  f.callback({
    user: JSON.stringify({
      name: { firstName: " Fixture ", lastName: "Person" },
      email: "private@example.test",
    }),
  });
  const first = f.flow.consume();
  assert.equal(f.url, "https://kaata.af/app?lang=en");
  assert.equal(f.storage.has(PENDING), false);
  assert.equal(f.calls.length, 0);
  assert.strictEqual(f.flow.consume(), first);
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  assert.ok(
    [...f.storage.values()].every(
      (value) => !value.includes(token()) && !value.includes("private@example.test"),
    ),
  );
  const one = first.complete();
  assert.strictEqual(first.complete(), one);
  assert.strictEqual(await one, account);
  assert.deepEqual(f.calls, [[token(), "Fixture Person", nonce]]);
  assert.equal(f.storage.size, 0);
  assert.deepEqual(f.flow.consume(), { status: "none" });
  assert.strictEqual(first.complete(), one);
  assert.equal(f.calls.length, 1);
  f.reload();
  f.callback({ state: "a".repeat(64) });
  assert.deepEqual(f.flow.consume(), { status: "error", code: "apple_callback_invalid" });
});

test("Apple rejects missing, mismatched, expired, future, corrupted, and duplicate callback state", () => {
  for (const corruption of [
    "missing",
    "mismatch",
    "expired",
    "future",
    "corrupted",
    "duplicate",
  ] as const) {
    const f = fixture();
    f.flow.start(START);
    f.callback();
    if (corruption === "missing") f.storage.delete(PENDING);
    if (corruption === "mismatch") f.callback({ state: "z".repeat(64) });
    if (corruption === "expired") f.advance(600_001);
    if (corruption === "future") f.advance(-1);
    if (corruption === "corrupted") f.storage.set(PENDING, "not JSON");
    if (corruption === "duplicate") f.setURL(`${f.url}&state=duplicate`);
    assert.deepEqual(
      f.flow.consume(),
      {
        status: "error",
        code:
          corruption === "expired" || corruption === "future"
            ? "apple_callback_expired"
            : "apple_callback_invalid",
      },
      corruption,
    );
    assert.equal(new URL(f.url).hash, "");
    assert.equal(f.storage.has(PENDING), false);
    assert.equal(f.calls.length, 0);
  }
});

test("Apple cancellation is quiet, cached during render, and dismissible", () => {
  const f = fixture();
  f.flow.start(START);
  const state = JSON.parse(f.storage.get(PENDING)!).state;
  f.callback({ kaata_apple: "1", state, error: "user_cancelled_authorize" }, false);
  const result = f.flow.consume();
  assert.deepEqual(result, { status: "cancelled" });
  assert.strictEqual(f.flow.consume(), result);
  f.flow.dismiss();
  assert.deepEqual(f.flow.consume(), { status: "none" });
  assert.equal(f.calls.length, 0);
});

test("Apple rejects malformed tokens, names, mixed success/error, and unexpected fields after scrubbing", () => {
  const malformed: Record<string, string>[] = [
    { identity_token: "not-a-token" },
    { user: "{" },
    { user: "" },
    { user: JSON.stringify({ name: { firstName: 123 } }) },
    { error: "user_cancelled_authorize" },
    { redirect: "https://attacker.invalid" },
  ];
  for (const values of malformed) {
    const f = fixture();
    f.flow.start(START);
    f.callback(values);
    assert.deepEqual(f.flow.consume(), { status: "error", code: "apple_callback_invalid" });
    assert.equal(new URL(f.url).hash, "");
    assert.equal(f.calls.length, 0);
  }
});

test("Apple keeps the first-consent name for a failed exchange retry only for that same subject", async () => {
  const f = fixture();
  f.flow.start(START);
  f.callback({ user: JSON.stringify({ name: { firstName: "First", lastName: "Consent" } }) });
  f.setSignIn(async () => {
    throw new Error("temporary network failure");
  });
  const first = f.flow.consume();
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  const completion = first.complete();
  await assert.rejects(completion);
  assert.strictEqual(first.complete(), completion);
  assert.deepEqual(f.flow.consume(), { status: "none" });
  assert.equal(JSON.parse(f.storage.get(NAME)!).name, "First Consent");
  f.reload();
  f.flow.start(START);
  f.callback();
  f.setSignIn(async (...args) => {
    f.calls.push(args);
    return account;
  });
  const retry = f.flow.consume();
  if (retry.status !== "ready") return assert.fail("retry should be ready");
  await retry.complete();
  assert.equal(f.calls[0][1], "First Consent");
  assert.equal(f.storage.has(NAME), false);

  for (const [subject, advance] of [
    ["different-subject", 0],
    ["fixture-apple-person", 600_001],
  ] as const) {
    f.storage.set(
      NAME,
      JSON.stringify({ subject: "fixture-apple-person", name: "Wrong name", createdAt: 1_000_000 }),
    );
    f.advance(advance);
    f.flow.start(START);
    f.callback({ identity_token: token(subject) });
    const next = f.flow.consume();
    if (next.status !== "ready") return assert.fail("next attempt should be ready");
    await next.complete();
    assert.equal(f.calls.at(-1)?.[1], "");
  }
});

test("a dismissed Apple completion cannot sign in after another action takes ownership", async () => {
  const f = fixture();
  f.flow.start(START);
  f.callback();
  const result = f.flow.consume();
  if (result.status !== "ready") return assert.fail("expected ready");
  f.flow.dismiss();
  await assert.rejects(
    result.complete(),
    (error: unknown) => error instanceof WebApiError && error.code === "apple_callback_invalid",
  );
  assert.equal(f.calls.length, 0);
});
