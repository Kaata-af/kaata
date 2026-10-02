// Execute the shipped settlement orchestration with native/network boundaries
// stubbed. A failed preflight or an unconfirmed POST must never fold local history.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as errors from "../tabs/errors";
import * as roles from "../vault-roles";
import type { TabLink, TabResponse, SettlementResponse } from "../tabs/types";
import type { VaultRole } from "../vault-roles";

const source = readFileSync(require.resolve("../tabs/link"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const displayed: TabLink = {
  tab_id: "shared-tab",
  vault_id: "vault",
  relationship_id: "relationship",
  role: "b",
  currency: "AFN",
  party_token: null,
  my_label: "Customer",
  other_label: "Shop",
  other_joined_at: 100,
  invite_url: null,
  rev: 9,
  closed_at: null,
  linked_at: 100,
  last_synced_at: 200,
  last_error: null,
};
const ack: SettlementResponse = {
  settlement: {
    id: "settlement-request",
    rev: 10,
    through_seq: 7,
    settled_at_ms: 800,
    created_by: "b",
    actor_account_id: "account",
    actor_name: "Actual actor",
    actor_member_role: "editor",
    semantics_version: "tally-settlement-v1",
  },
  tab: {
    id: displayed.tab_id,
    currency: "AFN",
    rev: 10,
    created_at_ms: 100,
    closed_at_ms: null,
    closed_by: null,
    you: "b",
    balance: { a: "0", b: "0" },
    parties: {
      a: { label: "Shop", joined_at_ms: 100, bound: true },
      b: { label: "Customer", joined_at_ms: 100, bound: true },
    },
    pending_for_you: 0,
  },
};
type SyncOutcome = { ok: boolean; error: string | null };
class SessionChangedError extends Error {
  constructor() {
    super("session_changed");
    this.name = "SessionChangedError";
  }
}
type Options = {
  role?: VaultRole;
  fresh?: TabLink | null;
  pending?: number;
  syncOutcome?: SyncOutcome;
  syncError?: Error;
  syncGate?: Promise<SyncOutcome>;
  authError?: Error;
  postError?: Error;
  postGate?: Promise<SettlementResponse>;
  captureError?: Error;
  sessionChanged?: boolean;
};

function harness(options: Options = {}) {
  const trace: string[] = [];
  const posts: Array<{ auth: unknown; tabId: string; id: string; revision: number }> = [];
  const cache: Array<{ link: TabLink; response: TabResponse; options: unknown }> = [];
  const firstSync = deferred<void>();
  const posted = deferred<void>();
  const fresh =
    options.fresh === undefined ? { ...displayed, other_label: "Refreshed shop" } : options.fresh;
  let syncCalls = 0;
  let unexpectedWrites = 0;
  let sessionGuardDepth = 0;
  const sessionSnapshot = Object.freeze({ opaque: "captured-session" });
  const forbiddenWrite = () => {
    unexpectedWrites++;
    throw new Error("Settlement must not write an optimistic marker or outbox operation");
  };
  const nativeDb = {
    getFirstAsync: async (sql: string, tabId: string) => {
      trace.push("outbox");
      assert.match(sql, /COUNT\(\*\).*tab_outbox/s);
      assert.equal(tabId, displayed.tab_id);
      return { n: options.pending ?? 0 };
    },
    runAsync: forbiddenWrite,
    execAsync: forbiddenWrite,
  };
  const mocks: Record<string, unknown> = {
    "expo-crypto": {
      randomUUID: () => {
        throw new Error("Caller owns the stable request ID");
      },
    },
    "expo-network": {},
    "react-native": {},
    "../currency": {},
    "../db": {},
    "../event-log": {},
    "../money": {},
    "../sync/push": {},
    "../types": {},
    "../vault-router": {},
    "./direction": {},
    "./inbox-reads": {},
    "./wire": {},
    "../db-tx": { getAccountIdSync: () => "account", getDb: async () => nativeDb },
    "../auth": {
      SessionChangedError,
      captureCurrentSession: async () => {
        trace.push("session:capture");
        if (options.captureError) throw options.captureError;
        return sessionSnapshot;
      },
      applyForCurrentSession: async <T>(snapshot: unknown, work: () => Promise<T>) => {
        trace.push("session:apply");
        assert.equal(
          snapshot,
          sessionSnapshot,
          "ack must be tied to the session captured before sync",
        );
        if (options.sessionChanged) throw new SessionChangedError();
        sessionGuardDepth++;
        try {
          return await work();
        } finally {
          sessionGuardDepth--;
        }
      },
    },
    "../use-vault-role": {
      readVaultRole: async (vaultId: string, accountId: string) => {
        trace.push("role");
        assert.equal(vaultId, displayed.vault_id);
        assert.equal(accountId, "account");
        return options.role ?? "editor";
      },
    },
    "../vault-roles": roles,
    "./errors": errors,
    "./sync": {
      syncTab: async (tabId: string) => {
        assert.equal(sessionGuardDepth, 0, "network sync must not hold the session mutation lock");
        trace.push("sync:start");
        assert.equal(tabId, displayed.tab_id);
        syncCalls++;
        firstSync.resolve();
        if (options.syncError) throw options.syncError;
        const result =
          syncCalls === 1 && options.syncGate
            ? await options.syncGate
            : (options.syncOutcome ?? { ok: true, error: null });
        trace.push("sync:done");
        return result;
      },
    },
    "./db": {
      getTabLink: async (id: string) => {
        trace.push("link");
        assert.equal(id, displayed.tab_id);
        return fresh;
      },
      queueTabMutation: forbiddenWrite,
      upsertTabLink: forbiddenWrite,
      upsertTabFromWire: async (link: TabLink, response: TabResponse, opts: unknown) => {
        assert.equal(
          sessionGuardDepth,
          1,
          "ack cache write must be protected by its captured session",
        );
        trace.push("cache");
        cache.push({ link, response, options: opts });
      },
    },
    "./api": {
      resolveTabAuth: async (link: TabLink) => {
        trace.push("auth");
        assert.equal(link, fresh, "authenticate using the freshly read link");
        if (options.authError) throw options.authError;
        return { jwt: "current-session" };
      },
      settleTab: async (auth: unknown, tabId: string, id: string, revision: number) => {
        assert.equal(sessionGuardDepth, 0, "POST must not hold the session mutation lock");
        trace.push("post");
        posts.push({ auth, tabId, id, revision });
        posted.resolve();
        if (options.postError) throw options.postError;
        const response = options.postGate ? await options.postGate : ack;
        trace.push("ack");
        return response;
      },
    },
  };
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, "unexpected dependency: " + name);
    return mocks[name];
  }, exports);
  const settle = exports.settleSharedTab as typeof import("../tabs/link").settleSharedTab;
  return {
    settle,
    trace,
    posts,
    cache,
    fresh,
    firstSync,
    posted,
    get unexpectedWrites() {
      return unexpectedWrites;
    },
  };
}

async function main() {
  const syncGate = deferred<SyncOutcome>();
  const postGate = deferred<SettlementResponse>();
  const success = harness({ syncGate: syncGate.promise, postGate: postGate.promise });
  const completion = success.settle(displayed, ack.settlement.id);
  await success.firstSync.promise;
  assert.equal(success.posts.length, 0, "POST waits for sync to finish");
  assert.equal(success.cache.length, 0);
  syncGate.resolve({ ok: true, error: null });
  await success.posted.promise;
  assert.equal(success.cache.length, 0, "in-flight POST cannot hide the shared chapter");
  assert.deepEqual(success.posts, [
    {
      auth: { jwt: "current-session" },
      tabId: displayed.tab_id,
      id: ack.settlement.id,
      revision: success.fresh!.rev,
    },
  ]);
  assert.ok(success.trace.indexOf("sync:done") < success.trace.indexOf("post"));
  assert.ok(success.trace.indexOf("session:capture") < success.trace.indexOf("sync:start"));
  postGate.resolve(ack);
  await completion;
  assert.deepEqual(success.cache, [
    {
      link: success.fresh,
      response: { tab: ack.tab, entries: [], settlements: [ack.settlement], full: false },
      options: { advanceCursor: false },
    },
  ]);
  assert.ok(success.trace.indexOf("ack") < success.trace.indexOf("cache"));
  assert.equal(
    success.trace.filter((step) => step === "sync:start").length,
    2,
    "pull again after the ack",
  );
  assert.equal(success.unexpectedWrites, 0);

  const blocked: Array<{
    label: string;
    options: Options;
    link?: TabLink;
    error: (e: unknown) => boolean;
  }> = [
    {
      label: "session unavailable at start",
      options: { captureError: new SessionChangedError() },
      error: (e) => e instanceof SessionChangedError,
    },
    {
      label: "failed sync",
      options: { syncOutcome: { ok: false, error: null } },
      error: (e) => e instanceof errors.TabAuthUnavailableError,
    },
    {
      label: "sync reports an error",
      options: { syncOutcome: { ok: true, error: "offline" } },
      error: (e) => e instanceof errors.TabAuthUnavailableError,
    },
    {
      label: "thrown sync failure",
      options: { syncError: new Error("sync transport failed") },
      error: (e) => e instanceof Error && e.message === "sync transport failed",
    },
    {
      label: "missing auth",
      options: { authError: new errors.TabAuthUnavailableError() },
      error: (e) => e instanceof errors.TabAuthUnavailableError,
    },
    {
      label: "stale displayed history",
      options: { fresh: { ...displayed, rev: 10 } },
      error: (e) => e instanceof errors.TabApiError && e.code === "stale_settlement",
    },
    {
      label: "queued outbox",
      options: { pending: 1 },
      error: (e) => e instanceof errors.TabApiError && e.code === "settlement_pending",
    },
    {
      label: "viewer",
      options: { role: "viewer" },
      error: (e) => e instanceof errors.TabPermissionError,
    },
    {
      label: "append-only clerk",
      options: { role: "clerk" },
      error: (e) => e instanceof errors.TabPermissionError,
    },
    {
      label: "already closed",
      options: {},
      link: { ...displayed, closed_at: 300 },
      error: (e) => e instanceof errors.TabClosedError,
    },
    {
      label: "closed during sync",
      options: { fresh: { ...displayed, closed_at: 300 } },
      error: (e) => e instanceof errors.TabClosedError,
    },
    {
      label: "link disappeared",
      options: { fresh: null },
      error: (e) => e instanceof errors.TabClosedError,
    },
  ];
  for (const scenario of blocked) {
    const h = harness(scenario.options);
    await assert.rejects(
      h.settle(scenario.link ?? displayed, ack.settlement.id),
      scenario.error,
      scenario.label,
    );
    assert.equal(h.posts.length, 0, scenario.label + " must not POST");
    assert.equal(h.cache.length, 0, scenario.label + " must not cache a marker");
    assert.equal(h.unexpectedWrites, 0, scenario.label + " must not write optimistically");
  }

  for (const failure of [
    new errors.TabApiError(0, "network", "offline"),
    new errors.TabApiError(409, "not_zero", "balance changed"),
    new errors.TabApiError(403, "forbidden", "access revoked"),
  ]) {
    const h = harness({ postError: failure });
    await assert.rejects(h.settle(displayed, ack.settlement.id), (e) => e === failure);
    assert.equal(h.posts.length, 1);
    assert.equal(h.cache.length, 0, "unconfirmed/rejected settlement cannot fold history");
    assert.equal(h.unexpectedWrites, 0);
  }

  const retryOptions: Options = { postError: new errors.TabApiError(0, "network", "ack lost") };
  const retry = harness(retryOptions);
  await assert.rejects(retry.settle(displayed, ack.settlement.id));
  retryOptions.postError = undefined;
  await retry.settle(displayed, ack.settlement.id);
  assert.deepEqual(
    retry.posts.map((p) => p.id),
    [ack.settlement.id, ack.settlement.id],
    "retry preserves the caller's idempotency key",
  );
  assert.equal(retry.cache.length, 1, "only the confirmed attempt adds a marker");
  assert.equal(retry.unexpectedWrites, 0);

  const delayedAck = deferred<SettlementResponse>();
  const changedOptions: Options = { postGate: delayedAck.promise };
  const changed = harness(changedOptions);
  const late = changed.settle(displayed, ack.settlement.id);
  await changed.posted.promise;
  changedOptions.sessionChanged = true; // Sign-out/account deletion/account switch while HTTP is in flight.
  delayedAck.resolve(ack);
  await assert.rejects(late, (e) => e instanceof SessionChangedError);
  assert.ok(changed.trace.includes("ack"), "server response really did succeed");
  assert.ok(changed.trace.includes("session:apply"), "late ack reaches the session guard");
  assert.equal(
    changed.cache.length,
    0,
    "late ack cannot recreate another or deleted account's cache",
  );
  assert.equal(
    changed.trace.filter((step) => step === "sync:start").length,
    1,
    "session refusal must not start a follow-up sync",
  );
  assert.equal(changed.unexpectedWrites, 0);
  console.log(
    `PASS: sync-before-POST, fresh revision, stable request ID, confirmed marker only, no cursor advance, ${blocked.length} preflight refusals, transport/server failures, retry and late-session ack refusal`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
