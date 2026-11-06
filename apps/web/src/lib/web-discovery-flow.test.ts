import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSession } from "./web-auth";
import { createWebDiscoveryFlow } from "./web-discovery-flow";

function session(epoch = 1, expiry = 2234567890): WebSession {
  const account = "11111111-1111-4111-8111-111111111111";
  const install = "22222222-2222-4222-8222-222222222222";
  const claims = {
    account_id: account,
    install_id: install,
    provider: "google",
    provider_sub: "synthetic",
    ep: epoch,
    exp: expiry,
  };
  return {
    account_id: account,
    install_id: install,
    default_vault_id: null,
    user: { has_password: false },
    session_jwt: `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`,
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
  let online = true;
  const reads: { signal: AbortSignal; result: ReturnType<typeof deferred<boolean>> }[] = [];
  const writes: {
    enabled: boolean;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<boolean>>;
  }[] = [];
  const flow = createWebDiscoveryFlow(expected, {
    current: () => current,
    online: () => online,
    read: (signal) => {
      const result = deferred<boolean>();
      reads.push({ signal, result });
      return result.promise;
    },
    write: (enabled, signal) => {
      const result = deferred<boolean>();
      writes.push({ enabled, signal, result });
      return result.promise;
    },
  });
  return {
    flow,
    reads,
    writes,
    changeSession: (value: WebSession | null) => {
      current = value;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

test("opening reads actual visibility, never opts in; an explicit OFF remains OFF when reopened", async () => {
  const f = fixture();
  assert.equal(f.flow.getState().enabled, null);
  const loading = f.flow.load();
  await f.flow.save(false);
  assert.equal(f.writes.length, 0, "loading cannot accept a toggle");
  f.reads[0].result.resolve(true);
  await loading;
  const saving = f.flow.save(false);
  await f.flow.save(false);
  assert.equal(f.writes.length, 1, "rapid repeat activation submits once");
  assert.equal(f.writes[0].enabled, false);
  assert.equal(f.flow.getState().enabled, true, "do not claim success before the response");
  f.writes[0].result.resolve(false);
  await saving;
  assert.equal(f.flow.getState().enabled, false);
  f.flow.stop();
  f.flow.start();
  f.reads[1].result.resolve(false);
  await Promise.resolve();
  assert.equal(f.flow.getState().enabled, false);
  assert.equal(f.writes.length, 1, "mount/reload never rewrites visibility");
  f.flow.stop();
});

test("an ambiguous save hides unconfirmed state and retries by reading, never replaying PUT", async () => {
  const f = fixture();
  const loading = f.flow.load();
  f.reads[0].result.resolve(true);
  await loading;
  const saving = f.flow.save(false);
  f.writes[0].result.reject(new Error("response lost after server applied OFF"));
  await saving;
  assert.deepEqual(f.flow.getState(), {
    enabled: null,
    loading: false,
    saving: false,
    error: "save",
  });
  await f.flow.save(false);
  const retry = f.flow.load();
  f.flow.recover();
  assert.equal(f.reads.length, 2);
  assert.equal(f.writes.length, 1);
  f.reads[1].result.resolve(false);
  await retry;
  assert.equal(f.flow.getState().enabled, false);
  assert.equal(f.flow.getState().error, null);
});

test("offline and failed initial reads never paint a guessed setting; reconnect only reads", async () => {
  const f = fixture();
  f.setOnline(false);
  f.flow.start();
  await f.flow.save(true);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.flow.getState().enabled, null);
  f.setOnline(true);
  const loading = f.flow.load();
  f.reads[0].result.reject(new Error("network"));
  await loading;
  assert.equal(f.flow.getState().error, "load");
  f.flow.recover();
  f.flow.recover();
  assert.equal(f.reads.length, 2);
  f.reads[1].result.resolve(false);
  await Promise.resolve();
  f.setOnline(false);
  await f.flow.save(true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.flow.getState().enabled, false);
});

test("logout, credential replacement and close suppress late reads and saves", async () => {
  for (const operation of ["read", "write"] as const) {
    for (const change of ["logout", "epoch", "close"] as const) {
      const f = fixture();
      let pending = f.flow.load();
      if (operation === "write") {
        f.reads[0].result.resolve(true);
        await pending;
        pending = f.flow.save(false);
      }
      let publications = 0;
      f.flow.subscribe(() => {
        publications++;
      });
      if (change === "logout") f.changeSession(null);
      else if (change === "epoch") f.changeSession(session(2));
      else f.flow.stop();
      const request = operation === "read" ? f.reads[0] : f.writes[0];
      if (change === "close") assert.equal(request.signal.aborted, true);
      request.result.resolve(false);
      await pending;
      assert.equal(publications, 0, `${operation}/${change} cannot publish a stale reply`);
      await f.flow.save(true);
      assert.equal(f.writes.length, operation === "write" ? 1 : 0);
    }
  }
});

test("old reads from a closed panel cannot replace a reopened setting; rolling JWT renewal is allowed", async () => {
  const f = fixture();
  const oldRead = f.flow.load();
  f.flow.stop();
  f.flow.start();
  f.reads[1].result.resolve(false);
  await Promise.resolve();
  f.reads[0].result.resolve(true);
  await oldRead;
  assert.equal(f.flow.getState().enabled, false);
  const saving = f.flow.save(true);
  f.changeSession(session(1, 2334567890));
  f.writes[0].result.resolve(true);
  await saving;
  assert.equal(f.flow.getState().enabled, true);
});
