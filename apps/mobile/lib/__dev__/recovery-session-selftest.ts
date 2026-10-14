// Execute real recovery/snapshot/pull/witness boundaries with a synthetic local
// store. No backend or persistent database is involved in these race checks.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

function fixture() {
  let accountId = "account-a",
    version = 0,
    locked = false;
  let tail = Promise.resolve();
  const writes: string[] = [],
    calls: string[] = [];
  const sqlWrites: { sql: string; args: unknown[] }[] = [];
  const meta = new Map<string, string>([["signin_default_vault_id", "vault-a"]]);
  class SessionChangedError extends Error {}
  const session = () => ({ accountId, jwt: `jwt-${accountId}`, bindingVersion: version });
  const auth = {
    SessionChangedError,
    getSessionJWT: async () => session().jwt,
    captureCurrentSession: async () => session(),
    applyForCurrentSession: async (before: any, work: () => Promise<any>) => {
      assert.equal(locked, false, "local callbacks must not call another session helper");
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (
          before.bindingVersion !== version ||
          before.accountId !== accountId ||
          before.jwt !== session().jwt
        )
          throw new SessionChangedError();
        locked = true;
        return await work();
      } finally {
        locked = false;
        release();
      }
    },
  };
  const write = (name: string) => {
    assert.ok(locked, `${name} must be session-serialized`);
    writes.push(name);
  };
  const remote = (name: string) => {
    assert.equal(locked, false, `${name} must not hold the session mutex`);
    calls.push(name);
  };
  let relationshipExists = true;
  const db = {
    runAsync: async (sql: string, ...args: unknown[]) => {
      sqlWrites.push({ sql, args });
      write(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      return { changes: 0 };
    },
    getFirstAsync: async (sql: string) =>
      sql.includes("is_local_self")
        ? { id: "self-a" }
        : sql.includes("FROM relationships") && relationshipExists
          ? { one: 1 }
          : null,
    withTransactionAsync: async (run: () => Promise<void>) => run(),
  };
  const dbTx = {
    getDb: async () => db,
    getAccountIdSync: () => accountId,
    refreshAccountIdCache: async () => accountId,
    getInstallIdSync: () => "install",
    ACTIVE_VAULT_META_KEY: "active_vault_id",
    setActiveVaultIdCache: () => write("active-cache"),
    setLocalSelfUserIdCache: () => write("self-cache"),
    getAppMetaInTx: async (_: any, key: string) => meta.get(key),
    setAppMetaInTx: async (_: any, key: string, value: string) => {
      write(key);
      meta.set(key, value);
    },
  };
  const dbModule = {
    getAppMeta: async (key: string) => meta.get(key) ?? null,
    getLocalSelf: async () => ({ name: "Ahmad" }),
    setAppMeta: async (key: string, value: string) => {
      write(key);
      meta.set(key, value);
    },
    healActiveVaultId: async () => write("heal-active"),
  };
  const ingest = {
    mapPulledWireToEvent: (value: any) => value,
    ingestPulledEvents: async (values: any[]) => {
      write(`ingest:${values.length}`);
      return values.length;
    },
  };
  const sweep = {
    sweepVaultNow: async () => write("sweep"),
    scheduleSweep: () => write("schedule-sweep"),
  };
  const cursor = {
    getLastPulledServerSeq: async () => 0,
    setLastPulledServerSeq: async () => write("cursor"),
  };
  const snapshot = {
    vault: {
      id: "vault-a",
      name: "Home",
      currency: "AFN",
      account_id: "account-a",
      created_at: 1,
      updated_at: 1,
      is_default: 1,
    },
    users: [],
    relationships: [],
    entries: [],
    events: [],
    membership_events: [],
    snapshot_server_seq: 3,
    generated_at_ms: 5,
    hlc_last: { pms: 1, l: 0, did: "d" },
  };
  const restore = compileUI("../restore", {
    "./credit-policy-cache": { cacheCreditPolicies: async () => write("credit") },
    "./api": { getBackendUrl: async () => "https://test.invalid" },
    "./auth": auth,
    "./db-tx": dbTx,
    "./hlc": { compareHLC: () => 0, deserializeHLC: JSON.parse, serializeHLC: JSON.stringify },
    "./projection/field-hlc": { serializeFieldHLCs: JSON.stringify },
    "./customer-group-restore": {
      seedSnapshotCustomerGroups: async () => write("groups"),
      restoredRelationshipFieldHLCs: () => "{}",
      restoredRelationshipGroupIds: () => "[]",
    },
    "./projection/ingest-row": ingest,
    "./projection/sweep": sweep,
    "./sync/cursor": cursor,
  });
  let listingGate: Promise<any> | null = null,
    snapshotGate: Promise<any> | null = null;
  let tabsGate: Promise<any> | null = null;
  let mineGate: Promise<any> | null = null,
    pullError: Error | null = null,
    mineError: Error | null = null;
  let mine = { tabs: [] as any[] };
  const links = new Map<string, any>();
  let tabTimeout: (() => void) | undefined;
  let snapshots = true;
  let listing: any[] = [
    {
      vault_id: "vault-a",
      name: "Home",
      currency: "AFN",
      role: "viewer",
      archived_at_ms: null,
      created_at_ms: 1,
      vault_epoch: 0,
    },
  ];
  const recovery = compileUI(
    "../recovery",
    {
      "react-native": { Platform: { OS: "android" } },
      "expo-constants": { default: { expoConfig: { version: "2.2.0" } } },
      "expo-crypto": { randomUUID: () => "self-a" },
      "./api": {
        checkIn: async () => {
          remote("check-in");
          return { mesh_server_pubkeys: { primary: "key" } };
        },
      },
      "./auth": auth,
      "./db": dbModule,
      "./db-tx": dbTx,
      "./i18n": { t: (s: string) => s, isPlaceholderSelfName: () => false },
      "./install-id": { ensureInstallId: async () => "install" },
      "./restore": {
        fetchSnapshot: async () => {
          remote("snapshot");
          return snapshotGate ? snapshotGate : snapshots ? snapshot : null;
        },
        restoreFromSnapshot: restore.restoreFromSnapshot,
      },
      "./vault-roles": { parseVaultRole: (role: string) => role },
      "./sync/pull": {
        pullEvents: async (_: string, before: any) => {
          remote("pull");
          if (pullError) throw pullError;
          await auth.applyForCurrentSession(before, async () => write("pull-apply"));
        },
      },
      "./mesh/device-key": {
        ensureDeviceKey: async () => write("device-key"),
        registerDeviceKey: async () => {
          remote("register");
        },
      },
      "./projection/sweep": sweep,
      "./tabs/sync": {
        syncAllTabs: async () => {
          remote("tabs");
          if (tabsGate) await tabsGate;
        },
      },
      "./tabs/api": {
        fetchMine: async () => {
          remote("mine");
          if (mineError) throw mineError;
          return mineGate ? mineGate : mine;
        },
      },
      "./tabs/db": { getTabLink: async (id: string) => links.get(id) ?? null },
      "./trust/backfill": {
        emitWitnessedSelfAdmission: async (_: string, opts: any) => {
          remote("witness");
          await auth.applyForCurrentSession(opts.session, async () => write("bind"));
        },
        witnessEmitPendingKey: (id: string) => `witness:${id}`,
      },
      "./trust/proof": { persistPinnedServerPubkeys: async () => write("pin") },
      "./vault-api": {
        listVaults: async () => {
          remote("list");
          return listingGate ? listingGate : listing;
        },
      },
      "./use-vault-role": { invalidateVaultRoleCache: () => {} },
      "./event-log": {
        appendVaultMemberAdded: async () => {
          write("owner-append");
          return { event_id: "owner-event" };
        },
      },
    },
    {
      __DEV__: false,
      setTimeout: (run: () => void) => {
        tabTimeout = run;
        return 1;
      },
      clearTimeout: () => {
        tabTimeout = undefined;
      },
    },
  );
  return {
    auth,
    restore,
    recovery,
    meta,
    writes,
    sqlWrites,
    calls,
    db,
    dbModule,
    dbTx,
    ingest,
    sweep,
    cursor,
    snapshot,
    SessionChangedError,
    session,
    remote,
    write,
    switchAccount: () => {
      assert.equal(locked, false);
      accountId = "account-b";
      version++;
    },
    setListingGate: (promise: Promise<any>) => {
      listingGate = promise;
    },
    setSnapshotGate: (promise: Promise<any>) => {
      snapshotGate = promise;
    },
    setTabsGate: (promise: Promise<any>) => {
      tabsGate = promise;
    },
    setMineGate: (promise: Promise<any>) => {
      mineGate = promise;
    },
    setMine: (tabs: any[]) => {
      mine = { tabs };
    },
    setListing: (value: any[]) => {
      listing = value;
    },
    setMineError: (error: Error) => {
      mineError = error;
    },
    setPullError: (error: Error) => {
      pullError = error;
    },
    setLink: (id: string, link: any) => {
      links.set(id, link);
    },
    missingRelationship: () => {
      relationshipExists = false;
    },
    expireTabSweep: () => {
      assert.ok(tabTimeout);
      tabTimeout!();
    },
    noSnapshot: () => {
      snapshots = false;
    },
  };
}

function pullFixture(f: ReturnType<typeof fixture>, response: Promise<any>) {
  class SessionExpiredError extends Error {}
  class VaultNotRegisteredError extends Error {}
  const pull = compileUI(
    "../sync/pull",
    {
      "../api": { getBackendUrl: async () => "https://test.invalid" },
      "../auth": f.auth,
      "../db": f.dbModule,
      "../db-tx": f.dbTx,
      "../effective-account": { resolveAccountIdCandidates: async (id: string) => [id] },
      "../projection/ingest-row": f.ingest,
      "../projection/sweep": f.sweep,
      "../use-vault-role": { invalidateVaultRoleCache: () => {} },
      "./cursor": f.cursor,
      "./errors": {
        SessionExpiredError,
        SyncTimeoutError: class extends Error {},
        SyncTransientError: class extends Error {},
        VaultNotRegisteredError,
      },
    },
    {
      __DEV__: false,
      fetch: async () => {
        f.remote("page");
        return response;
      },
    },
  );
  return pull;
}
const page = (events: any[] = []) => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  json: async () => ({ vault_id: "vault-a", events, has_more: false, next_after_server_seq: 4 }),
});

function witnessFixture(f: ReturnType<typeof fixture>, response: Promise<any>) {
  let bound = false;
  return compileUI("../trust/backfill", {
    "../db-tx": f.dbTx,
    "../auth": f.auth,
    "../db": {
      ...f.dbModule,
      getAppMeta: async (key: string) =>
        key === "mesh_server_pubkey_primary" ? "pinned-key" : f.dbModule.getAppMeta(key),
    },
    "../i18n": { isPlaceholderSelfName: () => false },
    "../event-log": {
      RoleGateRejectionError: class extends Error {},
      appendVaultMemberAdded: async () => f.write("member-append"),
      appendVaultDeviceAdded: async () => {
        f.write("device-append");
        bound = true;
      },
    },
    "../vault-roles": { parseVaultRole: (role: string) => role },
    "../mesh/device-key": {
      ensureDeviceKey: async () => {},
      getDevicePubkey: () => "pubkey",
      META_REBIND_PENDING_KEY: "rebind",
      META_REREGISTER_PENDING_KEY: "reregister",
      registerDeviceKey: async () => {
        f.remote("register");
        return "registered";
      },
    },
    "./account-id": { buildLocalAccountId: () => "sentinel" },
    "../vault-api": {
      ApiError: class extends Error {},
      fetchMembershipWitness: async () => {
        f.remote("witness");
        return response;
      },
    },
    "./proof": {
      PROOF_BUNDLE_CAP: 500,
      getLocalMembershipState: async () => ({
        hasGenesis: true,
        members: new Map([["account-a", { removed: false }]]),
        devices: new Map(
          bound
            ? [["pubkey", { removed: false, account_id: "account-a", device_id: "install" }]]
            : [],
        ),
      }),
    },
    "./chain": { MEMBERSHIP_EVENT_TYPES: new Set(["vault_member_added", "vault_device_added"]) },
  });
}
const witness = { server_key_id: "key", device_witness: { sig_b64: "sig", issued_at_ms: 1 } };

async function main() {
  const good = fixture();
  const result = await good.recovery.recoverAllVaults();
  assert.deepEqual(result.recovered, ["vault-a"]);
  assert.equal(result.activeVaultId, "vault-a");
  assert.equal(good.meta.get("default_vault_id"), "vault-a");
  assert.ok(good.writes.includes("bind") && good.writes.includes("cursor"));
  assert.ok(
    !good.calls.includes("mine"),
    "ordinary recovery keeps its best-effort shared-account contract",
  );
  const seeded = fixture();
  seeded.noSnapshot();
  await seeded.recovery.recoverAllVaults();
  assert.ok(
    seeded.writes.includes("INSERT OR IGNORE"),
    "no-snapshot recovery keeps its bare seed behavior",
  );

  for (const stage of ["list", "snapshot", "tabs"] as const) {
    const f = fixture(),
      gate = deferred<any>();
    if (stage === "list") f.setListingGate(gate.promise);
    if (stage === "snapshot") f.setSnapshotGate(gate.promise);
    if (stage === "tabs") f.setTabsGate(gate.promise);
    const restore = f.recovery.recoverAllVaults();
    for (let i = 0; i < 10 && !f.calls.includes(stage); i++) await settleUI();
    assert.ok(f.calls.includes(stage), `recovery reached ${stage}`);
    const before = [...f.writes];
    f.switchAccount();
    gate.resolve(
      stage === "list" ? [{ vault_id: "vault-a" }] : stage === "snapshot" ? f.snapshot : undefined,
    );
    await assert.rejects(restore, f.SessionChangedError);
    assert.deepEqual(
      f.writes,
      before,
      `no old-account local writes occur after ${stage} completes`,
    );
  }

  const snapshot = fixture(),
    old = snapshot.session();
  snapshot.switchAccount();
  await assert.rejects(
    snapshot.restore.restoreFromSnapshot(snapshot.snapshot, { session: old }),
    snapshot.SessionChangedError,
  );
  assert.deepEqual(
    snapshot.writes,
    [],
    "snapshot rejects before its projection/ingest/cursor writes",
  );

  const joined = fixture(),
    joinedGate = deferred<any>();
  joined.setSnapshotGate(joinedGate.promise);
  const pendingJoin = joined.recovery.recoverJoinedVault("vault-a");
  for (let i = 0; i < 10 && !joined.calls.includes("snapshot"); i++) await settleUI();
  const joinedBefore = [...joined.writes];
  joined.switchAccount();
  joinedGate.resolve(null);
  await assert.rejects(pendingJoin, joined.SessionChangedError);
  assert.deepEqual(
    joined.writes,
    joinedBefore,
    "joined-vault bare fallback cannot bypass the account guard",
  );

  const normalPull = fixture();
  await pullFixture(normalPull, Promise.resolve(page([{ event_id: "event" }]))).pullEvents(
    "vault-a",
    normalPull.session(),
  );
  assert.ok(
    normalPull.writes.includes("ingest:1") &&
      normalPull.writes.includes("cursor") &&
      normalPull.writes.includes("sweep"),
  );
  for (const status of [200, 403]) {
    const f = fixture(),
      response = deferred<any>();
    const pending = pullFixture(f, response.promise).pullEvents("vault-a", f.session());
    await settleUI();
    assert.ok(f.calls.includes("page"));
    f.switchAccount();
    response.resolve(
      status === 200
        ? page([{ event_id: "old-event" }])
        : {
            status: 403,
            ok: false,
            json: async () => ({ error_code: "not_member" }),
            headers: { get: () => null },
          },
    );
    await assert.rejects(pending, f.SessionChangedError);
    assert.deepEqual(f.writes, [], "late page or membership refusal cannot mutate the new account");
  }

  const bound = fixture();
  await witnessFixture(bound, Promise.resolve(witness)).emitWitnessedSelfAdmission("vault-a", {
    session: bound.session(),
  });
  assert.ok(bound.writes.includes("device-append"));
  const changed = fixture(),
    witnessGate = deferred<any>();
  const lateBind = witnessFixture(changed, witnessGate.promise).emitWitnessedSelfAdmission(
    "vault-a",
    { session: changed.session() },
  );
  for (let pass = 0; pass < 5 && !changed.calls.includes("witness"); pass++) await settleUI();
  assert.ok(changed.calls.includes("witness"));
  changed.switchAccount();
  witnessGate.resolve(witness);
  await assert.rejects(lateBind, changed.SessionChangedError);
  assert.deepEqual(changed.writes, [], "old witness cannot admit the new account or device");

  const boundTab = {
    vault_id: "vault-a",
    relationship_id: "person-a",
    role: "a",
    tab: {
      id: "tab-a",
      rev: 5,
      closed_at_ms: null,
      closed_reason: null,
    },
  };
  const currentLink = {
    tab_id: "tab-a",
    vault_id: "vault-a",
    relationship_id: "person-a",
    role: "a",
    rev: 5,
    closed_at: null,
    closed_reason: null,
    last_synced_at: 5,
  };
  const complete = fixture();
  complete.setMine([boundTab]);
  complete.setLink("tab-a", currentLink);
  const completed = await complete.recovery.recoverAllVaults({ requireComplete: true });
  assert.deepEqual(completed.failed, []);
  assert.ok(
    complete.calls.includes("mine"),
    "strict completion re-reads server revisions after the sweep",
  );
  const bestEffort = fixture();
  bestEffort.setPullError(new Error("offline"));
  const ordinary = await bestEffort.recovery.recoverAllVaults();
  assert.deepEqual(ordinary.recovered, ["vault-a"]);
  const strictPull = fixture();
  strictPull.setPullError(new Error("offline"));
  const notPulled = await strictPull.recovery.recoverAllVaults({ requireComplete: true });
  assert.deepEqual(notPulled.recovered, []);
  assert.equal(notPulled.failed[0].vaultId, "vault-a");
  for (const fault of [
    "missing-link",
    "missing-person",
    "stale-rev",
    "wrong-person",
    "wrong-vault",
    "wrong-role",
    "never-pulled",
    "closed",
    "close-reason",
    "api-failed",
  ]) {
    const f = fixture();
    f.setMine([boundTab]);
    let link: any = { ...currentLink };
    if (fault === "missing-person") f.missingRelationship();
    if (fault === "stale-rev") link.rev = 4;
    if (fault === "wrong-person") link.relationship_id = "other-person";
    if (fault === "wrong-vault") link.vault_id = "other-vault";
    if (fault === "wrong-role") link.role = "b";
    if (fault === "never-pulled") link.last_synced_at = null;
    if (fault === "closed") link.closed_at = 10;
    if (fault === "close-reason") link.closed_reason = "account_deleted";
    if (fault === "api-failed") f.setMineError(new Error("network"));
    if (fault !== "missing-link") f.setLink("tab-a", link);
    const unfinished = await f.recovery.recoverAllVaults({ requireComplete: true });
    assert.ok(
      unfinished.failed.some((failure: any) => failure.vaultId === "*tabs*"),
      `${fault} leaves deletion recovery retryable`,
    );
  }
  const irrelevant = fixture();
  irrelevant.setMine([
    { ...boundTab, vault_id: "archived-vault" },
    { ...boundTab, relationship_id: null },
  ]);
  assert.deepEqual(
    (await irrelevant.recovery.recoverAllVaults({ requireComplete: true })).failed,
    [],
    "archived/unbound tabs do not create impossible restore requirements",
  );
  const timeout = fixture(),
    never = deferred<any>();
  timeout.setTabsGate(never.promise);
  const timed = timeout.recovery.recoverAllVaults({ requireComplete: true });
  for (let i = 0; i < 10 && !timeout.calls.includes("tabs"); i++) await settleUI();
  timeout.expireTabSweep();
  assert.ok(
    (await timed).failed.some((failure: any) => failure.vaultId === "*tabs*"),
    "expired shared-account budget keeps the retry marker",
  );
  const mineRace = fixture(),
    mineGate = deferred<any>();
  mineRace.setMineGate(mineGate.promise);
  const readingMine = mineRace.recovery.recoverAllVaults({ requireComplete: true });
  for (let i = 0; i < 10 && !mineRace.calls.includes("mine"); i++) await settleUI();
  const beforeMine = [...mineRace.writes];
  mineRace.switchAccount();
  mineGate.resolve({ tabs: [boundTab] });
  await assert.rejects(readingMine, mineRace.SessionChangedError);
  assert.deepEqual(mineRace.writes, beforeMine);

  const archived = {
    vault_id: "vault-a",
    name: "Archive",
    role: "owner",
    archived_at_ms: 123,
    created_at_ms: 1,
    vault_epoch: 0,
  };
  const excluded = fixture();
  excluded.setListing([archived]);
  assert.deepEqual(
    (await excluded.recovery.recoverAllVaults()).recovered,
    [],
    "ordinary restore still excludes archives",
  );
  assert.ok(!excluded.calls.includes("snapshot"));
  const archivedOwner = fixture();
  archivedOwner.setListing([archived]);
  const restoredArchive = await archivedOwner.recovery.recoverAllVaults({
    includeArchived: true,
    requireComplete: true,
  });
  assert.deepEqual(restoredArchive.failed, []);
  assert.deepEqual(restoredArchive.recovered, ["vault-a"]);
  assert.equal(
    restoredArchive.activeVaultId,
    null,
    "restored archives never become the active kaata",
  );
  assert.ok(archivedOwner.calls.includes("snapshot") && archivedOwner.calls.includes("pull"));
  assert.ok(
    archivedOwner.sqlWrites.some(
      (row) => row.sql.startsWith("UPDATE vaults SET archived_at") && row.args[0] === 123,
    ),
    "snapshot/tail restore preserves the authoritative archive timestamp",
  );
  const archivedMember = fixture();
  archivedMember.setListing([{ ...archived, role: "viewer" }]);
  archivedMember.setMine([boundTab]);
  const metadata = await archivedMember.recovery.recoverAllVaults({
    includeArchived: true,
    requireComplete: true,
  });
  assert.deepEqual(metadata.failed, []);
  assert.deepEqual(metadata.recovered, ["vault-a"]);
  assert.ok(
    !archivedMember.calls.includes("snapshot") && !archivedMember.calls.includes("pull"),
    "member archive metadata does not bypass stop-sharing access",
  );
  assert.ok(
    archivedMember.sqlWrites.some(
      (row) => row.sql.includes("INSERT OR IGNORE INTO vaults") && row.args[5] === 123,
    ),
  );
  const archivedStale = fixture();
  archivedStale.setListing([archived]);
  archivedStale.setMine([boundTab]);
  assert.ok(
    (
      await archivedStale.recovery.recoverAllVaults({
        includeArchived: true,
        requireComplete: true,
      })
    ).failed.some((failure: any) => failure.vaultId === "*tabs*"),
    "strict recovery also verifies readable archived-owner shared history",
  );
  console.log(
    "Recovery session: ordinary/seed restore, remote-boundary races, snapshot/pull/cursor and witnessed binding guards passed.",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
