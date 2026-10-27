// Execute recovery/reconciliation against real, isolated SQLite. Native and
// network boundaries are synthetic; no phone database or live account is used.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileUI, deferred } from "./ui-fixture";
import { MEMBERSHIP_EVENT_TYPES } from "../trust/chain";

function fixture() {
  const storage = new Database(":memory:");
  storage.exec(`
    CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT,created_at INTEGER,
      updated_at INTEGER,archived_at INTEGER,is_default INTEGER,account_id TEXT,
      registered_with_server_at INTEGER,vault_epoch INTEGER,hlc_logical INTEGER,
      hlc_wall_ms INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,
      accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,
      PRIMARY KEY(vault_id,account_id));
    CREATE TABLE users(id TEXT PRIMARY KEY,is_local_self INTEGER);
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,applied_at INTEGER,
      quarantine_reason TEXT,tombstone_reason TEXT,event_type TEXT DEFAULT 'vault_member_added');
    INSERT INTO users VALUES('self',1);
    INSERT INTO event_log(event_id,vault_id,applied_at,quarantine_reason)
      VALUES('genesis','joined',NULL,'unknown_actor');
    INSERT INTO app_meta VALUES('test-pull-cursor','20');
  `);
  let accountId = "joiner",
    jwt: string | null = "session-a",
    bindingVersion = 0;
  let online = true,
    sessionLocked = false,
    transactionLocked = false;
  let sessionTail = Promise.resolve();
  class SessionChangedError extends Error {}
  const currentSession = () => ({ accountId, jwt, bindingVersion });
  const auth = {
    SessionChangedError,
    getSessionJWT: async () => jwt,
    captureCurrentSession: async () => {
      assert.equal(sessionLocked, false, "capture must not nest in a guarded callback");
      return currentSession();
    },
    applyForCurrentSession: async (before: any, work: () => Promise<any>) => {
      assert.equal(sessionLocked, false, "session mutex must not be nested");
      const previous = sessionTail;
      let release!: () => void;
      sessionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (
          !before.jwt ||
          before.jwt !== jwt ||
          before.accountId !== accountId ||
          before.bindingVersion !== bindingVersion
        )
          throw new SessionChangedError();
        sessionLocked = true;
        return await work();
      } finally {
        sessionLocked = false;
        release();
      }
    },
  };
  const local = () => assert.ok(sessionLocked, "listing writes must be session guarded");
  const network = () => assert.equal(sessionLocked, false, "network must release session mutex");
  const db = {
    runAsync: async (sql: string, ...args: unknown[]) => {
      local();
      return storage.prepare(sql).run(...args);
    },
    getFirstAsync: async (sql: string, ...args: unknown[]) =>
      storage.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: unknown[]) => storage.prepare(sql).all(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      assert.ok(transactionLocked, "pin transaction must own projection write mutex");
      storage.exec("BEGIN");
      try {
        await work();
        storage.exec("COMMIT");
      } catch (err) {
        storage.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const meta = (key: string): string | null =>
    (storage.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as any)?.value ?? null;
  const setMeta = async (key: string, value: string) => {
    await db.runAsync("INSERT OR REPLACE INTO app_meta VALUES(?,?)", key, value);
  };
  const listing = {
    vault_id: "joined",
    name: "Shared",
    currency: "AFN",
    created_at_ms: 1,
    vault_epoch: 0,
    archived_at_ms: null,
    role: "editor",
    vault_trust_anchor_pubkey: "server-anchor",
  };
  let listings: any[] = [listing];
  let listingGate: Promise<any> | null = null,
    emissionGate: Promise<void> | null = null;
  let emissionFailure = false,
    removedDevice = false,
    removedMember = false,
    selfAdmitted = false,
    selfPublished = false,
    hasGenesis = true;
  const sweeps: string[] = [],
    emissions: string[] = [],
    registrations: string[] = [];
  let listingRequests = 0,
    zeroEventPulls = 0;
  const dbTx = {
    getDb: async () => db,
    getAccountIdSync: () => accountId,
    refreshAccountIdCache: async () => accountId,
    getInstallIdSync: () => "install",
    setAppMetaInTx: async (_: unknown, key: string, value: string) => setMeta(key, value),
    ACTIVE_VAULT_META_KEY: "active_vault_id",
    setActiveVaultIdCache: () => {},
    setLocalSelfUserIdCache: () => {},
  };
  const vaultApi = {
    listVaults: async () => {
      network();
      listingRequests++;
      return listingGate ? listingGate : listings;
    },
    createVaultOnServer: async (value: any) => {
      network();
      registrations.push(value.vault_id);
    },
    markVaultMaterializePending: async (vaultId: string) => {
      await setMeta(`materialize:${vaultId}`, "1");
    },
  };
  const pull = {
    pullEvents: async (_: string, before: any) => {
      network();
      zeroEventPulls++;
      await auth.applyForCurrentSession(before, async () => {});
      return { pulled: 0 };
    },
  };
  const recovery = compileUI("../recovery", {
    "./currency-metadata": require("../currency-metadata"),
    "react-native": { Platform: { OS: "android" } },
    "expo-constants": { default: { expoConfig: { version: "2.2.0" } } },
    "expo-crypto": { randomUUID: () => "self" },
    "./api": { checkIn: async () => ({}) },
    "./auth": auth,
    "./db": {
      getLocalSelf: async () => ({ name: "Member" }),
      getAppMeta: async (key: string) => meta(key),
      setAppMeta: setMeta,
    },
    "./db-tx": dbTx,
    "./i18n": { isPlaceholderSelfName: () => false },
    "./install-id": { ensureInstallId: async () => "install" },
    "./restore": {
      fetchSnapshot: async () => {
        network();
        return null;
      },
    },
    "./vault-roles": { parseVaultRole: (role: string) => role },
    "./sync/pull": pull,
    "./mesh/device-key": {
      ensureDeviceKey: async () => {
        network();
      },
      getDevicePubkey: () => "own-key",
    },
    "./projection": {
      applyEventMutex: {
        runExclusive: async (work: () => Promise<any>) => {
          assert.equal(transactionLocked, false);
          transactionLocked = true;
          try {
            return await work();
          } finally {
            transactionLocked = false;
          }
        },
      },
    },
    "./projection/sweep": {
      scheduleSweep: () => {},
      sweepVaultNow: async (vaultId: string) => {
        local();
        assert.equal(transactionLocked, false, "sweep starts after the write transaction");
        assert.equal(meta(`witness:${vaultId}`), "1", "marker durable before sweeping");
        const anchor = (
          storage
            .prepare("SELECT vault_trust_anchor_pubkey AS pin FROM vaults WHERE id=?")
            .get(vaultId) as any
        )?.pin;
        assert.ok(anchor, "the sweep sees the new pin");
        sweeps.push(vaultId);
        // The verifier is covered separately; model its now-valid genesis apply
        // to verify these real orchestration functions retry already-held rows.
        await db.runAsync(
          "UPDATE event_log SET applied_at=1,quarantine_reason=NULL WHERE vault_id=?",
          vaultId,
        );
      },
    },
    "./tabs/sync": {},
    "./tabs/api": {},
    "./tabs/db": {},
    "./trust/backfill": {
      witnessEmitPendingKey: (id: string) => `witness:${id}`,
      emitWitnessedSelfAdmission: async (id: string, opts: any) => {
        network();
        emissions.push(id);
        assert.equal(meta(`witness:${id}`), "1", "marker exists before the request");
        if (emissionGate) await emissionGate;
        if (emissionFailure) throw new Error("synthetic witness failure");
        await auth.applyForCurrentSession(opts.session, async () => {});
        selfAdmitted = selfPublished = true;
      },
    },
    "./trust/proof": {
      PROOF_BUNDLE_CAP: 500,
      getLocalMembershipState: async (_: string, publishedOnly = false) => {
        const admitted = publishedOnly ? selfPublished : selfAdmitted;
        return {
          hasGenesis,
          members: removedMember
            ? new Map([[accountId, { removed: true }]])
            : admitted
              ? new Map([[accountId, { removed: false }]])
              : new Map(),
          devices: removedDevice
            ? new Map([["own-key", { removed: true }]])
            : admitted
              ? new Map([
                  ["own-key", { removed: false, account_id: accountId, device_id: "install" }],
                ])
              : new Map(),
        };
      },
    },
    "./trust/chain": { MEMBERSHIP_EVENT_TYPES },
    "./vault-api": vaultApi,
    "./use-vault-role": { invalidateVaultRoleCache: () => {} },
  });
  const reconcile = compileUI("../sync/reconcile", {
    "expo-network": { getNetworkStateAsync: async () => ({ isConnected: online }) },
    "../auth": auth,
    "../effective-account": {},
    "../db-tx": dbTx,
    "../vault-api": vaultApi,
    "./pull": pull,
    "./push": {},
    "../recovery": recovery,
  });
  const pin = () =>
    (
      storage
        .prepare("SELECT vault_trust_anchor_pubkey AS pin FROM vaults WHERE id='joined'")
        .get() as any
    )?.pin ?? null;
  const seed = () =>
    auth.applyForCurrentSession(currentSession(), () =>
      recovery.seedJoinedVaultMinimal("joined", "Shared", "editor"),
    );
  return {
    storage,
    recovery,
    reconcile,
    seed,
    pin,
    meta,
    sweeps,
    emissions,
    registrations,
    currentSession,
    auth,
    listing,
    get listingRequests() {
      return listingRequests;
    },
    get zeroEventPulls() {
      return zeroEventPulls;
    },
    setListings: (values: any[]) => {
      listings = values;
    },
    setListingGate: (gate: Promise<any>) => {
      listingGate = gate;
    },
    setEmissionGate: (gate: Promise<void>) => {
      emissionGate = gate;
    },
    failEmission: () => {
      emissionFailure = true;
    },
    removeDevice: () => {
      removedDevice = true;
    },
    removeMember: () => {
      removedMember = true;
    },
    admitLocally: () => {
      selfAdmitted = true;
    },
    publishAdmission: () => {
      selfAdmitted = selfPublished = true;
    },
    loseGenesis: () => {
      hasGenesis = false;
    },
    goOffline: () => {
      online = false;
    },
    signOut: () => {
      jwt = null;
      bindingVersion++;
    },
    switchABA: () => {
      accountId = "other";
      bindingVersion++;
      accountId = "joiner";
      bindingVersion++;
    },
  };
}

async function main() {
  const fresh = fixture();
  await fresh.seed();
  assert.equal(fresh.pin(), null);
  assert.equal(await fresh.recovery.recoverJoinedVault("joined"), true);
  assert.equal(fresh.pin(), "server-anchor", "no snapshot enriches the existing minimal seed");
  assert.equal(fresh.zeroEventPulls, 1);
  assert.deepEqual(fresh.sweeps, ["joined"], "caught-up zero-event pull still gets a local sweep");
  assert.equal(
    (fresh.storage.prepare("SELECT applied_at FROM event_log").get() as any).applied_at,
    1,
  );
  assert.deepEqual(fresh.emissions, ["joined"]);
  assert.equal(fresh.meta("witness:joined"), "");
  await fresh.reconcile.healMissingServerAnchors();
  assert.deepEqual(fresh.emissions, ["joined"], "healthy pins do not retry admission");
  fresh.storage.close();

  const upgrade = fixture();
  await upgrade.seed();
  await upgrade.reconcile.healMissingServerAnchors();
  assert.equal(
    upgrade.pin(),
    "server-anchor",
    "periodic sweep repairs old installs without a materialization flag",
  );
  assert.deepEqual(upgrade.sweeps, ["joined"]);
  assert.deepEqual(upgrade.emissions, ["joined"]);
  assert.deepEqual(upgrade.registrations, [], "a joined vault never registers as owned");
  upgrade.storage.close();

  const pinned = fixture();
  await pinned.seed();
  pinned.storage.prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'").run();
  await pinned.recovery.recoverJoinedVault("joined");
  await pinned.reconcile.healMissingServerAnchors();
  assert.equal(pinned.pin(), "original-pin", "an existing pin is never overwritten");
  assert.deepEqual(pinned.sweeps, []);
  assert.deepEqual(pinned.emissions, []);
  assert.equal(
    pinned.meta("witness:joined"),
    "1",
    "an upgrade discovers a visible joined vault whose old client never wrote its witness flag",
  );
  pinned.storage.close();

  const alreadyPublished = fixture();
  await alreadyPublished.seed();
  alreadyPublished.storage
    .prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'")
    .run();
  alreadyPublished.publishAdmission();
  await alreadyPublished.reconcile.healMissingServerAnchors();
  assert.equal(
    alreadyPublished.meta("witness:joined"),
    null,
    "a complete join needs no new marker",
  );
  alreadyPublished.storage.close();

  const locallyAdmitted = fixture();
  await locallyAdmitted.seed();
  locallyAdmitted.storage
    .prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'")
    .run();
  locallyAdmitted.admitLocally();
  await locallyAdmitted.reconcile.healMissingServerAnchors();
  assert.equal(
    locallyAdmitted.meta("witness:joined"),
    "1",
    "a pre-fix client may have cleared its marker before the host received its local proof",
  );
  locallyAdmitted.storage.close();

  const genesisMissing = fixture();
  await genesisMissing.seed();
  genesisMissing.storage
    .prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'")
    .run();
  genesisMissing.loseGenesis();
  await genesisMissing.reconcile.healMissingServerAnchors();
  assert.equal(genesisMissing.meta("witness:joined"), "1");
  assert.equal(
    genesisMissing.meta("materialize:joined"),
    "1",
    "a caught-up cursor missing owner proof also queues snapshot materialization",
  );
  genesisMissing.storage.close();

  for (const removedKind of ["member", "device"] as const) {
    const blockedUpgrade = fixture();
    await blockedUpgrade.seed();
    blockedUpgrade.storage
      .prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'")
      .run();
    if (removedKind === "member") blockedUpgrade.removeMember();
    else blockedUpgrade.removeDevice();
    await blockedUpgrade.reconcile.healMissingServerAnchors();
    assert.equal(
      blockedUpgrade.meta("witness:joined"),
      null,
      `unchanged-anchor upgrade must not retry a removed ${removedKind}`,
    );
    assert.deepEqual(blockedUpgrade.emissions, []);
    blockedUpgrade.storage.close();
  }

  const oversizedProof = fixture();
  await oversizedProof.seed();
  oversizedProof.storage
    .prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'")
    .run();
  const insertProof = oversizedProof.storage.prepare(
    "INSERT INTO event_log(event_id,vault_id) VALUES(?,'joined')",
  );
  for (let i = 0; i < 500; i++) insertProof.run(`proof-${i}`);
  await oversizedProof.reconcile.healMissingServerAnchors();
  assert.equal(
    oversizedProof.meta("witness:joined"),
    null,
    "a capped proof prefix cannot authorize automatic re-admission",
  );
  assert.deepEqual(oversizedProof.emissions, []);
  oversizedProof.storage.close();

  const remoteMissing = fixture();
  await remoteMissing.seed();
  remoteMissing.storage.prepare("UPDATE vaults SET vault_trust_anchor_pubkey='original-pin'").run();
  remoteMissing.setListings([
    { ...remoteMissing.listing, role: "owner", vault_trust_anchor_pubkey: null },
  ]);
  await remoteMissing.reconcile.healMissingServerAnchors();
  assert.deepEqual(
    remoteMissing.registrations,
    ["joined"],
    "the existing owner-only remote NULL repair is preserved",
  );
  assert.equal(remoteMissing.pin(), "original-pin");
  assert.deepEqual(remoteMissing.emissions, []);
  remoteMissing.setListings([{ ...remoteMissing.listing, vault_trust_anchor_pubkey: null }]);
  await remoteMissing.reconcile.healMissingServerAnchors();
  assert.deepEqual(
    remoteMissing.registrations,
    ["joined"],
    "a member cannot register the remote anchor",
  );
  remoteMissing.storage.close();

  for (const gate of [
    "offline",
    "signed-out",
    "not-in-listing",
    "revoked",
    "other-private",
    "archived-member",
  ] as const) {
    const blocked = fixture();
    await blocked.seed();
    if (gate === "offline") blocked.goOffline();
    if (gate === "signed-out") blocked.signOut();
    if (gate === "not-in-listing") blocked.setListings([]);
    if (gate === "archived-member")
      blocked.setListings([{ ...blocked.listing, archived_at_ms: 2 }]);
    if (gate === "revoked")
      blocked.storage.prepare("UPDATE vault_members_mirror SET revoked_at=1").run();
    if (gate === "other-private") {
      blocked.storage.prepare("UPDATE vaults SET account_id='other'").run();
      blocked.storage.prepare("DELETE FROM vault_members_mirror").run();
    }
    await blocked.reconcile.healMissingServerAnchors();
    assert.equal(blocked.pin(), null, gate);
    assert.deepEqual(blocked.emissions, [], gate);
    if (gate === "offline" || gate === "signed-out") assert.equal(blocked.listingRequests, 0);
    blocked.storage.close();
  }

  const failed = fixture();
  await failed.seed();
  failed.failEmission();
  await failed.reconcile.healMissingServerAnchors();
  assert.equal(failed.pin(), "server-anchor");
  assert.equal(failed.meta("witness:joined"), "1", "a witness failure retains the retry marker");
  failed.storage.close();

  const removed = fixture();
  await removed.seed();
  removed.removeDevice();
  await removed.reconcile.healMissingServerAnchors();
  assert.deepEqual(
    removed.emissions,
    [],
    "a removed device is never re-admitted by anchor healing",
  );
  removed.storage.close();

  const aba = fixture();
  await aba.seed();
  const lateListing = deferred<any>();
  aba.setListingGate(lateListing.promise);
  const repairing = aba.reconcile.healMissingServerAnchors();
  while (!aba.listingRequests) await new Promise((resolve) => setImmediate(resolve));
  aba.switchABA();
  lateListing.resolve([aba.listing]);
  await repairing;
  assert.equal(aba.pin(), null, "account ABA prevents stale listing writes");
  assert.deepEqual(aba.emissions, []);
  aba.storage.close();

  const midRequest = fixture();
  await midRequest.seed();
  const lateEmission = deferred<void>();
  midRequest.setEmissionGate(lateEmission.promise);
  const admission = midRequest.reconcile.healMissingServerAnchors();
  while (!midRequest.emissions.length) await new Promise((resolve) => setImmediate(resolve));
  midRequest.switchABA();
  lateEmission.resolve();
  await admission;
  assert.equal(
    midRequest.meta("witness:joined"),
    "1",
    "account ABA cannot clear another session's pending flag",
  );
  midRequest.storage.close();
  console.log(
    "PASS real SQLite invite minimal-seed enrichment, immutable pins, caught-up sweep, installed-copy repair, authorization/offline/revocation gates, durable witness retry and account ABA",
  );
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
