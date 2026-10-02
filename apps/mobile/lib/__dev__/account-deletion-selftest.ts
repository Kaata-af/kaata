import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  completeAccountDeletion,
  requestAccountDeletion,
  resumeConfirmedDeletion,
} from "../account-deletion";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function testCurrentSessionResponseGuard() {
  const store = new Map<string, string>([["kaata.session.jwt", "session-a"]]);
  let account: string | null = "account-a";
  const resetStarted = deferred();
  const finishReset = deferred();
  const cache: string[] = [];
  const compiled = ts.transpileModule(readFileSync(require.resolve("../auth"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mocks: Record<string, unknown> = {
    "expo-constants": { __esModule: true, default: { executionEnvironment: "storeClient" } },
    "expo-secure-store": {
      getItemAsync: async (key: string) => store.get(key) ?? null,
      setItemAsync: async (key: string, value: string) => {
        store.set(key, value);
      },
      deleteItemAsync: async (key: string) => {
        store.delete(key);
      },
    },
    "react-native": { Platform: { OS: "android" } },
    "../constants/env": {},
    "./api": { getBackendUrl: async () => "https://example.test" },
    "./db-tx": {
      getAccountIdSync: () => account,
      setAccountIdCache: (id: string | null) => {
        account = id;
      },
      setLocalSelfUserIdCache: () => {},
      setInstallIdCache: () => {},
    },
    "./db": {
      resetAllLocalData: async () => {
        resetStarted.resolve();
        await finishReset.promise;
        cache.length = 0;
      },
      initDb: async () => {},
    },
    "./effective-account": {},
    "./event-log": {},
    "./phone": {},
    "./install-id": { ensureInstallId: async () => "new-install" },
    "./mesh/device-key": { clearDeviceKey: () => {} },
    "./account-deletion": {
      completeAccountDeletion,
      requestAccountDeletion,
      resumeConfirmedDeletion,
    },
  };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, "unexpected auth dependency: " + name);
    return mocks[name];
  }, exports);
  const auth = exports as unknown as typeof import("../auth");
  const beforeDeletion = await auth.captureCurrentSession();
  assert.equal(await auth.applyForCurrentSession(beforeDeletion, async () => 42), 42);

  // Exercise the actual confirmed-deletion flow while a response arrives.
  // Cache work queues behind cleanup, then rejects before recreating data.
  store.set("kaata.account.deletion-confirmation", "session-a");
  const deleting = auth.resumeConfirmedAccountDeletion();
  await resetStarted.promise;
  let appliedAfterDelete = false;
  const late = assert.rejects(
    auth.applyForCurrentSession(beforeDeletion, async () => {
      appliedAfterDelete = true;
      cache.push("old shared tally");
    }),
    auth.SessionChangedError,
  );
  await Promise.resolve();
  assert.equal(appliedAfterDelete, false);
  finishReset.resolve();
  await deleting;
  await late;
  assert.equal(cache.length, 0);

  const signedOut = await auth.captureCurrentSession();
  await assert.rejects(
    auth.applyForCurrentSession(signedOut, async () => cache.push("anonymous")),
    auth.SessionChangedError,
  );

  store.set("kaata.session.jwt", "session-b");
  account = "account-b";
  const beforeSwitch = await auth.captureCurrentSession();
  account = "account-c";
  await assert.rejects(
    auth.applyForCurrentSession(beforeSwitch, async () => cache.push("wrong account")),
    auth.SessionChangedError,
  );
  account = "account-b";
  await auth.rotateSessionJWT("session-b-refreshed");
  await assert.rejects(
    auth.applyForCurrentSession(beforeSwitch, async () => cache.push("old token")),
    auth.SessionChangedError,
  );

  // Generation prevents an ABA reuse even when account and JWT are identical.
  const beforeClear = await auth.captureCurrentSession();
  await auth.clearLocalSession();
  store.set("kaata.session.jwt", "session-b-refreshed");
  account = "account-b";
  await assert.rejects(
    auth.applyForCurrentSession(beforeClear, async () => cache.push("old generation")),
    auth.SessionChangedError,
  );

  // In the other ordering, an accepted local apply finishes before cleanup.
  const current = await auth.captureCurrentSession();
  const entered = deferred();
  const finishApply = deferred();
  const applying = auth.applyForCurrentSession(current, async () => {
    entered.resolve();
    await finishApply.promise;
    assert.equal(store.get("kaata.session.jwt"), "session-b-refreshed");
  });
  await entered.promise;
  const clearing = auth.clearLocalSession();
  await Promise.resolve();
  assert.equal(account, "account-b", "cleanup cannot interleave inside guarded cache work");
  finishApply.resolve();
  await applying;
  await clearing;
  assert.equal(account, null);
}

async function main() {
  let requests = 0;
  let resets = 0;
  const attempt = async (jwt: string | null, status: number, body: string) => {
    await requestAccountDeletion(jwt, "https://example.test", (async (_url, init) => {
      requests++;
      assert.equal(init?.method, "DELETE");
      return new Response(body, { status });
    }) as typeof fetch);
    resets++;
  };
  await assert.rejects(attempt(null, 200, '{"status":"deleted"}'), /auth_required/);
  assert.equal(requests, 0);
  for (const status of [401, 403, 500]) {
    await assert.rejects(attempt("expired", status, '{"status":"deleted"}'));
  }
  await assert.rejects(attempt("session", 200, '{"status":"ok"}'), /unconfirmed/);
  await assert.rejects(attempt("session", 200, "invalid json"));
  assert.equal(resets, 0, "unconfirmed deletion must preserve the local ledger");
  await attempt("session", 200, '{"status":"deleted"}');
  assert.equal(resets, 1);

  let confirmation: string | null = null;
  let pendingAttempt: string | null = null;
  let serverCalls = 0;
  let cleanupCalls = 0;
  const recovery = {
    jwt: "deleted-session" as string | null,
    readAttempt: async () => pendingAttempt,
    saveAttempt: async (jwt: string) => {
      pendingAttempt = jwt;
    },
    clearAttempt: async () => {
      pendingAttempt = null;
    },
    readConfirmation: async () => confirmation,
    saveConfirmation: async (jwt: string) => {
      confirmation = jwt;
    },
    clearConfirmation: async () => {
      confirmation = null;
    },
    confirmServer: async () => {
      serverCalls++;
    },
    clearLocalData: async () => {
      cleanupCalls++;
      if (cleanupCalls === 1) throw new Error("device cleanup interrupted");
    },
  };
  await assert.rejects(completeAccountDeletion(recovery), /interrupted/);
  assert.equal(confirmation, "deleted-session", "server confirmation survives failed cleanup");
  recovery.jwt = null; // SecureStore session cleanup may already have succeeded.
  await completeAccountDeletion(recovery);
  assert.equal(serverCalls, 1, "confirmed cleanup retries without a now-revoked session");
  assert.equal(cleanupCalls, 2);
  assert.equal(confirmation, null);
  assert.equal(pendingAttempt, null);

  confirmation = "old-session";
  recovery.jwt = "different-account-session";
  recovery.confirmServer = async () => {
    throw new Error("server refused");
  };
  await assert.rejects(completeAccountDeletion(recovery), /server refused/);
  assert.equal(cleanupCalls, 2, "old receipt cannot authorize erasing a new account");
  confirmation = null;
  recovery.jwt = "session";
  recovery.confirmServer = async () => {};
  recovery.saveConfirmation = async () => {
    throw new Error("keychain unavailable");
  };
  await assert.rejects(completeAccountDeletion(recovery), /keychain unavailable/);
  assert.equal(cleanupCalls, 2, "keep local records if confirmation could not be persisted");

  pendingAttempt = null;
  recovery.jwt = "lost-response-session";
  recovery.confirmServer = async () => {
    throw new Error("response lost");
  };
  recovery.saveConfirmation = async (jwt) => {
    confirmation = jwt;
  };
  await assert.rejects(completeAccountDeletion(recovery), /response lost/);
  assert.equal(pendingAttempt, "lost-response-session");
  recovery.jwt = null; // The sync loop cleared the active session after a 401.
  recovery.confirmServer = async () => {
    throw new Error("still unconfirmed");
  };
  await assert.rejects(completeAccountDeletion(recovery), /still unconfirmed/);
  assert.equal(cleanupCalls, 2, "a saved attempt alone never permits a local wipe");
  recovery.confirmServer = async () => {};
  await completeAccountDeletion(recovery);
  assert.equal(cleanupCalls, 3);
  assert.equal(pendingAttempt, null);

  confirmation = "account-a-confirmed";
  recovery.jwt = "account-b-current";
  recovery.confirmServer = async () => {
    throw new Error("must not call server during boot");
  };
  await resumeConfirmedDeletion(recovery);
  assert.equal(cleanupCalls, 3, "startup must not delete a different account locally or remotely");
  assert.equal(confirmation, null);
  confirmation = "account-a-confirmed";
  recovery.jwt = null;
  pendingAttempt = "account-a-confirmed";
  await resumeConfirmedDeletion(recovery);
  assert.equal(cleanupCalls, 4, "confirmed partial cleanup resumes locally without a session");
  assert.equal(confirmation, null);
  await testCurrentSessionResponseGuard();
  console.log("account-deletion: confirmed cleanup and session-serialized response guards passed");
}

void main();
