import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  completeAccountDeletion,
  requestAccountDeletion,
  requireAccountDeletionGrace,
  resumeConfirmedDeletion,
} from "../account-deletion";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function authDeletionFixture() {
  const SESSION = "kaata.session.jwt",
    ATTEMPT = "kaata.account.deletion-attempt",
    CONFIRMATION = "kaata.account.deletion-confirmation";
  const store = new Map<string, string>([[SESSION, "session-a"]]);
  const events: string[] = [];
  let account: string | null = "account-a",
    resets = 0;
  let read: ((key: string, value: string | null) => Promise<string | null>) | null = null;
  let backup: (() => Promise<void>) | null = null;
  let server: (() => Promise<void>) | null = null;
  let lateEdits = false,
    financialLock = false;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/deletion-policy")) {
      events.push("policy");
      return new Response('{"grace_days":30}');
    }
    events.push("DELETE:" + (init?.headers as Record<string, string>).Authorization);
    if (server) await server();
    return new Response('{"status":"deletion_scheduled","purge_at":"2026-11-11T00:00:00Z"}');
  }) as typeof fetch;
  const compiled = ts.transpileModule(readFileSync(require.resolve("../auth"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mocks: Record<string, unknown> = {
    "expo-constants": { __esModule: true, default: { executionEnvironment: "storeClient" } },
    "expo-secure-store": {
      getItemAsync: async (key: string) => {
        const value = store.get(key) ?? null;
        return read ? read(key, value) : value;
      },
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
      getDb: async () => ({}),
      setAppMetaInTx: async (_db: unknown, key: string, value: string) =>
        events.push(`${key}:${value}`),
      getAccountIdSync: () => account,
      setAccountIdCache: (id: string | null) => {
        account = id;
      },
      setLocalSelfUserIdCache: () => {},
      setInstallIdCache: () => {},
    },
    "./db": {
      resetAllLocalData: async () => {
        assert.ok(financialLock, "final financial guard and database reset share the writer mutex");
        resets++;
        events.push("reset");
      },
      initDb: async () => {
        assert.equal(financialLock, false, "schema rebuild never reenters the held writer mutex");
      },
    },
    "./effective-account": {},
    "./event-log": {},
    "./phone": {},
    "./install-id": { ensureInstallId: async () => "new-install" },
    "./mesh/device-key": { clearDeviceKey: () => {} },
    "./account-deletion": {
      completeAccountDeletion,
      resumeConfirmedDeletion,
      requestAccountDeletion: (jwt: string | null, base: string) =>
        requestAccountDeletion(jwt, base, request),
      requireAccountDeletionGrace: (jwt: string | null, base: string) =>
        requireAccountDeletionGrace(jwt, base, request),
    },
    "./account-deletion-backup": {
      captureDeletionCleanupBaseline: async () => ({ events: "none", tabs: "none" }),
      assertAccountDeletionCleanupSafe: async () => {
        assert.ok(financialLock);
        if (lateEdits) throw new Error("account_delete_late_edits");
      },
      prepareAccountDeletionBackup: async () => {
        events.push("backup");
        if (backup) await backup();
      },
    },
    "./projection": {
      applyEventMutex: {
        runExclusive: async (run: () => Promise<void>) => {
          assert.equal(financialLock, false);
          financialLock = true;
          try {
            await run();
          } finally {
            financialLock = false;
          }
        },
      },
    },
  };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, "unexpected auth dependency: " + name);
    return mocks[name];
  }, exports);
  const auth = exports as unknown as typeof import("../auth");
  return {
    SESSION,
    ATTEMPT,
    CONFIRMATION,
    store,
    events,
    auth,
    get resets() {
      return resets;
    },
    onRead: (fn: typeof read) => {
      read = fn;
    },
    onBackup: (fn: typeof backup) => {
      backup = fn;
    },
    onServer: (fn: typeof server) => {
      server = fn;
    },
    lateEdit: () => {
      lateEdits = true;
    },
    account: (id: string) => {
      account = id;
    },
  };
}

async function testDeletionSessionRaces() {
  const f = authDeletionFixture();
  const atBindingRead = deferred(),
    finishBindingRead = deferred();
  let backedUp = false,
    blocked = false;
  f.onBackup(async () => {
    backedUp = true;
  });
  f.onRead(async (key, captured) => {
    if (key === f.SESSION && backedUp && !blocked) {
      blocked = true;
      atBindingRead.resolve();
      await finishBindingRead.promise;
    }
    return captured;
  });
  const oldDeletion = f.auth.deleteAccount();
  const rejected = assert.rejects(oldDeletion, /account_delete_session_changed/);
  await atBindingRead.promise;
  // A fresh sign-in serializes local mutation and advances the same generation
  // used by actual auth deletion. The held read returns the earlier JWT.
  await f.auth.clearLocalSession();
  f.store.set(f.SESSION, "session-b");
  f.account("account-b");
  finishBindingRead.resolve();
  await rejected;
  assert.equal(
    f.store.has(f.ATTEMPT),
    false,
    "stale A continuation cannot persist an attempt after B signs in",
  );
  assert.equal(
    f.events.some((event) => event.startsWith("DELETE:")),
    false,
  );
  assert.equal(f.resets, 0);
  f.onRead(null);
  // Even a historical leftover from a previous app must not bypass B's backup.
  f.store.set(f.ATTEMPT, "session-a");
  f.events.length = 0;
  await f.auth.deleteAccount();
  assert.deepEqual(f.events.slice(0, 3), ["policy", "backup", "DELETE:Bearer session-b"]);
  assert.equal(f.resets, 1);

  const boot = authDeletionFixture();
  boot.store.set(boot.SESSION, "session-b");
  boot.account("account-b");
  boot.store.set(boot.CONFIRMATION, "session-a");
  let confirmationReads = 0;
  boot.onRead(async (key, captured) => {
    if (key === boot.CONFIRMATION && ++confirmationReads === 3)
      boot.store.set(boot.CONFIRMATION, "session-b");
    return captured;
  });
  await boot.auth.resumeConfirmedAccountDeletion();
  assert.equal(boot.resets, 0, "stale proof cannot wipe the current different account during boot");
  assert.equal(
    boot.store.get(boot.CONFIRMATION),
    "session-b",
    "stale proof cleanup must leave a replacement account's receipt intact",
  );
  assert.equal(boot.events.length, 0, "boot cleanup never requests remote deletion or backup");

  const late = authDeletionFixture(),
    serverReached = deferred(),
    finishServer = deferred();
  late.onServer(async () => {
    serverReached.resolve();
    await finishServer.promise;
  });
  const deleting = late.auth.deleteAccount();
  const refused = assert.rejects(deleting, /account_delete_session_changed/);
  await serverReached.promise;
  await late.auth.clearLocalSession();
  late.store.set(late.SESSION, "session-b");
  late.account("account-b");
  late.store.set(late.ATTEMPT, "session-b");
  late.store.set(late.CONFIRMATION, "session-b");
  finishServer.resolve();
  await refused;
  assert.equal(late.resets, 0);
  assert.equal(late.store.get(late.CONFIRMATION), "session-b");
  assert.equal(late.store.get(late.ATTEMPT), "session-b");

  const financial = authDeletionFixture(),
    acknowledgement = deferred(),
    release = deferred();
  financial.onServer(async () => {
    acknowledgement.resolve();
    await release.promise;
  });
  const deletingFinancial = financial.auth.deleteAccount();
  const retained = assert.rejects(deletingFinancial, /account_delete_late_edits/);
  await acknowledgement.promise;
  financial.lateEdit();
  release.resolve();
  await retained;
  assert.equal(
    financial.resets,
    0,
    "a financial edit created during DELETE survives its acknowledgement",
  );
  assert.equal(
    financial.store.get(financial.CONFIRMATION),
    "session-a",
    "the server receipt survives refused local cleanup",
  );
  assert.equal(financial.store.get(financial.SESSION), "session-a");
  await financial.auth.resumeConfirmedAccountDeletion();
  assert.equal(
    financial.resets,
    0,
    "boot keeps late edits accessible without a fatal cleanup loop",
  );
  assert.equal(financial.store.get(financial.CONFIRMATION), "session-a");
}

async function testGracePolicy() {
  let requests = 0;
  await assert.rejects(
    requireAccountDeletionGrace(null, "https://example.test", (async () => {
      requests++;
      return new Response('{"grace_days":30}');
    }) as typeof fetch),
    /auth_required/,
  );
  assert.equal(requests, 0);
  for (const [status, body, error] of [
    [401, '{"grace_days":30}', /auth_required/],
    [404, '{"error":"not found"}', /grace_unavailable/],
    [500, '{"grace_days":30}', /grace_unavailable/],
    [200, '{"grace_days":0}', /grace_unavailable/],
    [200, '{"grace_days":"30"}', /grace_unavailable/],
    [200, "{}", /grace_unavailable/],
  ] as const) {
    await assert.rejects(
      requireAccountDeletionGrace(
        "session",
        "https://example.test",
        (async () => new Response(body, { status })) as typeof fetch,
      ),
      error,
    );
  }
  await requireAccountDeletionGrace("session", "https://example.test", (async (url, init) => {
    assert.equal(url, "https://example.test/v1/account/deletion-policy");
    assert.deepEqual(init?.headers, { Authorization: "Bearer session" });
    assert.notEqual(init?.method, "DELETE", "policy preflight is read-only");
    return new Response('{"grace_days":30}');
  }) as typeof fetch);
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
    "./account-deletion-backup": { assertAccountDeletionCleanupSafe: async () => {} },
    "./projection": { applyEventMutex: { runExclusive: (run: () => Promise<void>) => run() } },
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

  // Boot runs resumeConfirmedAccountDeletion on EVERY launch, and a throw there
  // fails boot. Without a receipt it must read nothing else: a signed-in
  // Android user whose session blob no longer decrypts would otherwise be
  // locked out of the whole ledger on every launch.
  const secureStore = mocks["expo-secure-store"] as {
    getItemAsync: (key: string) => Promise<string | null>;
  };
  const storedRead = secureStore.getItemAsync;
  const keysRead: string[] = [];
  secureStore.getItemAsync = async (key: string) => {
    keysRead.push(key);
    if (key === "kaata.session.jwt") throw new Error("DecryptException");
    return storedRead(key);
  };
  await auth.resumeConfirmedAccountDeletion();
  assert.deepEqual(
    keysRead,
    ["kaata.account.deletion-confirmation"],
    "a launch without a deletion receipt must not read the session",
  );
  assert.equal(store.get("kaata.session.jwt"), "session-a", "no receipt, nothing cleared");
  secureStore.getItemAsync = storedRead;

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
      assert.equal((init?.headers as Record<string, string>)["X-Kaata-Deletion-Grace"], "30");
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
  await attempt(
    "session",
    200,
    '{"status":"deletion_scheduled","purge_at":"2026-11-11T00:00:00Z"}',
  );
  assert.equal(resets, 2, "scheduled deletion explicitly acknowledges safe local cleanup");

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
  await testGracePolicy();
  await testDeletionSessionRaces();
  console.log("account-deletion: confirmed cleanup and session-serialized response guards passed");
}

void main();
