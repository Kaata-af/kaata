// Real router and HTTP dispatch with synthetic SQLite membership/session IO.
// The atomic append implementation has separate transaction/signature tests.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileUI } from "./ui-fixture";
import { Mutex } from "../util/mutex";
import type { SessionSnapshot } from "../auth";
import type { VaultRole } from "../events";

function fixture(local = true) {
  const store = new Database(":memory:");
  store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,revoked_at INTEGER);
    INSERT INTO vault_members_mirror VALUES('v','owner','owner',NULL),('v','target','editor',NULL);`);
  store.prepare("INSERT INTO vaults VALUES('v',?)").run(local ? "anchor" : null);
  let active = "v",
    account: string | null = "owner",
    binding = 1;
  let candidates = ["owner"],
    anchor = false,
    continuing = true;
  let signerReady = true;
  let beforeReadiness: (() => void) | null = null;
  let beforeAppend: (() => void) | null = null;
  let beforeDispatch: (() => void) | null = null;
  const appended: { self: string; target: string; role: string }[] = [];
  const requests: { url: string; body: any; authorization: string }[] = [];
  const session = (): SessionSnapshot => ({
    accountId: account,
    jwt: account ? `jwt-${account}` : null,
    bindingVersion: binding,
  });
  class SessionChangedError extends Error {}
  class OwnershipSignerNotReadyError extends Error {}
  const guarded = async <T>(before: SessionSnapshot, work: () => Promise<T>) => {
    if (before.accountId !== account || before.bindingVersion !== binding)
      throw new SessionChangedError();
    return work();
  };
  const auth = {
    captureCurrentSession: async () => session(),
    getSessionJWT: async () => session().jwt,
    applyForCurrentSession: guarded,
    applyForUnchangedLocalSession: guarded,
  };
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
  };
  const api = compileUI(
    "../vault-api",
    {
      "./api": {
        getBackendUrl: async () => {
          beforeDispatch?.();
          return "https://ownership.invalid";
        },
      },
      "./auth": auth,
      "./db": {},
      "./db-tx": {},
    },
    {
      fetch: async (url: string, init: any) => {
        requests.push({
          url,
          body: JSON.parse(init.body),
          authorization: init.headers.Authorization,
        });
        return new Response(null, { status: 204 });
      },
    },
  ) as typeof import("../vault-api");
  const mutex = new Mutex();
  const router = compileUI("../vault-router", {
    "./auth": auth,
    "./db-tx": { getDb: async () => db, getActiveVaultIdSyncMaybe: () => active },
    "./effective-account": { resolveAccountIdCandidates: async () => candidates },
    "./event-log": {
      appendVaultOwnershipTransfer: async (args: any) => {
        assert.equal(
          args.expectedSignerPubkey,
          "proven-key",
          "pins the verified key through the actual append",
        );
        beforeAppend?.();
        return mutex.runExclusive(async () => {
          await args.preflight(db);
          appended.push({
            self: args.selfAccountId,
            target: args.toAccountId,
            role: args.demoteSelfTo,
          });
          store
            .prepare(
              "UPDATE vault_members_mirror SET role='owner' WHERE vault_id=? AND account_id=?",
            )
            .run(args.targetVaultId, args.toAccountId);
          store
            .prepare("UPDATE vault_members_mirror SET role=? WHERE vault_id=? AND account_id=?")
            .run(args.demoteSelfTo, args.targetVaultId, args.selfAccountId);
          return { event_id: "demotion" };
        });
      },
    },
    "./vault-api": api,
    "./tabs/db": {},
    "./ownership-transfer-readiness": {
      OwnershipSignerNotReadyError,
      ensureOwnershipTransferSignerReady: async () => {
        beforeReadiness?.();
        if (!signerReady) throw new OwnershipSignerNotReadyError();
        return "proven-key";
      },
    },
    "./mesh/device-key": { ensureDeviceKey: async () => {}, isOwnDevicePubkey: async () => anchor },
  }) as typeof import("../vault-router");
  const transfer = () =>
    router.transferVaultOwnership("v", "target", "owner", "editor", {
      shouldContinue: () => continuing,
    });
  const role = (id: string) =>
    (
      store
        .prepare("SELECT role FROM vault_members_mirror WHERE vault_id='v' AND account_id=?")
        .get(id) as { role: VaultRole }
    ).role;
  return {
    store,
    appended,
    requests,
    router,
    transfer,
    role,
    session,
    SessionChangedError,
    setCandidates: (ids: string[]) => {
      candidates = ids;
    },
    trustAnchor: () => {
      anchor = true;
    },
    beforeAppend: (fn: () => void) => {
      beforeAppend = fn;
    },
    beforeDispatch: (fn: () => void) => {
      beforeDispatch = fn;
    },
    cancel: () => {
      continuing = false;
    },
    switchVault: () => {
      active = "other";
    },
    switchSession: () => {
      account = "other";
      binding++;
    },
    signOut: () => {
      account = null;
      binding++;
    },
    missingSignerProof: () => {
      signerReady = false;
    },
    beforeReadiness: (fn: () => void) => {
      beforeReadiness = fn;
    },
  };
}

async function run() {
  const happy = fixture();
  assert.deepEqual(await happy.transfer(), {
    ok: true,
    result: { kind: "local", eventId: "demotion" },
  });
  assert.equal(happy.role("owner"), "editor");
  assert.equal(happy.role("target"), "owner");
  assert.equal(happy.appended.length, 1);
  assert.equal(happy.requests.length, 0);

  const drift = fixture();
  drift.store
    .prepare("UPDATE vault_members_mirror SET account_id='local-owner' WHERE account_id='owner'")
    .run();
  drift.setCandidates(["owner", "local-owner"]);
  assert.equal((await drift.transfer()).ok, true);
  assert.equal(drift.appended[0].self, "local-owner", "demotes the existing local identity seat");

  const retired = fixture();
  retired.store
    .prepare("UPDATE vault_members_mirror SET account_id='retired-owner' WHERE account_id='owner'")
    .run();
  retired.trustAnchor();
  assert.equal((await retired.transfer()).ok, true);
  assert.equal(retired.appended[0].self, "retired-owner");

  const ambiguous = fixture();
  ambiguous.store
    .prepare("UPDATE vault_members_mirror SET account_id='unknown-owner' WHERE account_id='owner'")
    .run();
  ambiguous.store
    .prepare("INSERT INTO vault_members_mirror VALUES('v','third','editor',NULL)")
    .run();
  ambiguous.trustAnchor();
  assert.deepEqual(await ambiguous.transfer(), { ok: false, error: { kind: "not_owner" } });
  assert.equal(ambiguous.appended.length, 0);

  const self = fixture();
  self.setCandidates(["owner", "target"]);
  assert.deepEqual(await self.transfer(), { ok: false, error: { kind: "self_target" } });
  assert.equal(self.appended.length, 0);

  const unbound = fixture();
  unbound.missingSignerProof();
  assert.deepEqual(await unbound.transfer(), { ok: false, error: { kind: "sync_required" } });
  assert.equal(unbound.appended.length, 0, "a mirror Owner cannot transfer with an unproven key");
  assert.equal(unbound.role("owner"), "owner");
  assert.equal(unbound.role("target"), "editor");
  const switchedWhileRepairing = fixture();
  switchedWhileRepairing.beforeReadiness(() => switchedWhileRepairing.switchSession());
  await assert.rejects(
    switchedWhileRepairing.transfer(),
    switchedWhileRepairing.SessionChangedError,
  );
  assert.equal(switchedWhileRepairing.appended.length, 0);

  for (const change of [
    "revoke-target",
    "demote-self",
    "switch-vault",
    "cancel",
    "switch-session",
  ] as const) {
    const f = fixture();
    f.beforeAppend(() => {
      if (change === "revoke-target")
        f.store
          .prepare("UPDATE vault_members_mirror SET revoked_at=1 WHERE account_id='target'")
          .run();
      if (change === "demote-self")
        f.store
          .prepare("UPDATE vault_members_mirror SET role='editor' WHERE account_id='owner'")
          .run();
      if (change === "switch-vault") f.switchVault();
      if (change === "cancel") f.cancel();
      // Real auth serializes this change with local mutation. Test the guard
      // immediately before append separately below rather than inside its lock.
    });
    if (change === "switch-session") {
      const snapshot = f.session();
      f.switchSession();
      await assert.rejects(
        f.router.transferVaultOwnership("v", "target", "owner", "editor", {
          expectedSession: snapshot,
        }),
        f.SessionChangedError,
      );
    } else {
      const result = await f.transfer();
      assert.equal(result.ok, false, change);
      if (!result.ok)
        assert.equal(
          result.error.kind,
          change === "revoke-target"
            ? "not_member"
            : change === "demote-self"
              ? "not_owner"
              : "context_changed",
        );
    }
    assert.equal(f.appended.length, 0, `${change} must emit nothing`);
    assert.equal(f.role("target"), "editor");
  }

  const overlap = fixture();
  const results = await Promise.all([overlap.transfer(), overlap.transfer()]);
  assert.equal(
    results.filter((r) => r.ok).length,
    1,
    "second transfer rechecks owner under the transaction lock",
  );
  assert.equal(overlap.appended.length, 1);

  const oldPartial = fixture();
  oldPartial.store
    .prepare("UPDATE vault_members_mirror SET role='owner' WHERE account_id='target'")
    .run();
  assert.equal(
    (await oldPartial.transfer()).ok,
    true,
    "an older interrupted promotion can still finish",
  );
  assert.equal(oldPartial.role("owner"), "editor");

  const offline = fixture();
  offline.signOut();
  assert.equal((await offline.transfer()).ok, true, "a local handover can still work signed out");

  const server = fixture(false);
  assert.deepEqual(await server.transfer(), { ok: true, result: { kind: "server" } });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].authorization, "Bearer jwt-owner");
  assert.deepEqual(server.requests[0].body, { to_account_id: "target", demote_self_to: "editor" });
  for (const change of ["switch-vault", "switch-session", "cancel"] as const) {
    const f = fixture(false);
    f.beforeDispatch(() => {
      if (change === "switch-vault") f.switchVault();
      if (change === "switch-session") f.switchSession();
      if (change === "cancel") f.cancel();
    });
    if (change === "switch-session") await assert.rejects(f.transfer(), f.SessionChangedError);
    else assert.equal((await f.transfer()).ok, false);
    assert.equal(f.requests.length, 0, `${change} during HTTP setup cannot send the handover`);
  }
  console.log(
    "ownership-router-selftest: transfer identity, live preflight, overlap and request scope passed",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
