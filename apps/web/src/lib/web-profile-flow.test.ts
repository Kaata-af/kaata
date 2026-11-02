import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSession } from "./web-auth";
import type { WebProfile } from "./web-profile";
import { createWebProfileFlow } from "./web-profile-flow";

const partial: WebProfile = {
  name: "Provider name",
  phone: "",
  shop_name: "",
  needs_setup: true,
  has_onboarded: false,
};
const complete: WebProfile = {
  name: "Confirmed owner",
  phone: "+93700123456",
  shop_name: "My kaata",
  needs_setup: false,
  has_onboarded: true,
};
function session(epoch = 1, expiry = 1234567890): WebSession {
  const account = "11111111-1111-4111-8111-111111111111";
  const install = "22222222-2222-4222-8222-222222222222";
  const payload = {
    account_id: account,
    install_id: install,
    provider: "google",
    provider_sub: "owner",
    ep: epoch,
    exp: expiry,
  };
  return {
    account_id: account,
    install_id: install,
    session_jwt: `fixture.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`,
    default_vault_id: null,
    user: { has_password: false },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const expected = session();
  let current: WebSession | null = expected;
  const reads: { signal: AbortSignal; result: ReturnType<typeof deferred<WebProfile>> }[] = [];
  const writes: { signal: AbortSignal; result: ReturnType<typeof deferred<WebProfile>> }[] = [];
  const applied: WebProfile[] = [];
  const flow = createWebProfileFlow(expected, {
    current: () => current,
    read: (signal) => {
      const result = deferred<WebProfile>();
      reads.push({ signal, result });
      return result.promise;
    },
    write: (_values, signal) => {
      const result = deferred<WebProfile>();
      writes.push({ signal, result });
      return result.promise;
    },
    apply: (_session, profile) => {
      applied.push(profile);
      return true;
    },
  });
  return {
    flow,
    reads,
    writes,
    applied,
    changeSession: (next: WebSession | null) => {
      current = next;
    },
  };
}

test("web setup waits for saved own details; an existing mobile profile enters directly", async () => {
  const f = fixture();
  const loading = f.flow.load();
  assert.equal(f.flow.getState().admitted, false);
  f.reads[0].result.resolve(partial);
  await loading;
  assert.equal(f.flow.getState().admitted, false, "an OAuth name alone cannot complete setup");
  const saving = f.flow.save({ name: complete.name, phone: complete.phone });
  f.writes[0].result.resolve({ ...complete, shop_name: "", has_onboarded: false });
  await saving;
  assert.equal(f.flow.getState().admitted, true, "the next step can create the first kaata");

  const existing = fixture();
  const restore = existing.flow.load();
  existing.reads[0].result.resolve(complete);
  await restore;
  assert.equal(
    existing.flow.getState().admitted,
    true,
    "reuse the account's existing mobile identity",
  );
  assert.equal(existing.writes.length, 0);
});

test("a slow read cannot undo a saved profile or discard an admitted ledger", async () => {
  const f = fixture();
  const loading = f.flow.load();
  const saving = f.flow.save({ name: complete.name, phone: complete.phone });
  assert.equal(f.reads[0].signal.aborted, true);
  f.writes[0].result.resolve(complete);
  await saving;
  f.reads[0].result.resolve(partial);
  await loading;
  assert.deepEqual(f.flow.getState().profile, complete);
  const refresh = f.flow.load();
  assert.equal(f.flow.getState().admitted, true, "an editor read does not remount the ledger");
  f.reads[1].result.reject(new Error("offline"));
  await refresh;
  assert.equal(f.flow.getState().failed, true);
  assert.equal(f.flow.getState().admitted, true);
});

test("reconnect recovers initial failure once and does not replace a profile form draft", async () => {
  const f = fixture();
  const loading = f.flow.load();
  f.reads[0].result.reject(new Error("offline"));
  await loading;
  f.flow.recover();
  f.flow.recover();
  assert.equal(f.reads.length, 2, "one shared reconnect request");
  f.reads[1].result.resolve(partial);
  await Promise.resolve();
  f.flow.recover();
  assert.equal(f.reads.length, 2, "a known incomplete profile keeps its typed draft");
});

test("logout, credential replacement and unmount suppress late save side effects", async () => {
  for (const change of ["logout", "epoch", "stop"] as const) {
    const f = fixture();
    const saving = f.flow.save({ name: complete.name, phone: complete.phone });
    if (change === "logout") f.changeSession(null);
    else if (change === "epoch") f.changeSession(session(2));
    else f.flow.stop();
    f.writes[0].result.resolve(complete);
    assert.equal(await saving, null);
    assert.equal(f.flow.getState().admitted, false);
    assert.deepEqual(f.applied, []);
  }
});

test("rolling session renewal preserves a live profile save", async () => {
  const f = fixture();
  const saving = f.flow.save({ name: complete.name, phone: complete.phone });
  f.changeSession(session(1, 2234567890));
  f.writes[0].result.resolve(complete);
  assert.deepEqual(await saving, complete);
  assert.equal(f.flow.getState().admitted, true);
});
