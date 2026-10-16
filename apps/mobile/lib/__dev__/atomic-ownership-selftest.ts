// Real SQLite, event append/projection/role gate/appliers and role notifications.
// Only native key storage, React mounting and transport edges are replaced.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import * as ed from "@noble/ed25519";
import type { SQLiteTx } from "../db-tx";
import type { LedgerEvent, VaultMemberRoleChangedEvent, VaultRole } from "../events";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const OWNER = "owner",
  TARGET = "target",
  VAULT = "vault",
  DEVICE = "device";

function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  const js = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(required, exports);
  return exports as T;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_epoch INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,PRIMARY KEY(vault_id,account_id));
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,device_id TEXT,author_user_id_local_only TEXT,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,appended_at INTEGER,server_acked_at INTEGER,rejected_at INTEGER,origin TEXT,event_sig_b64 TEXT,signer_device_pubkey TEXT,ingested_at INTEGER,applied_at INTEGER,author_seq INTEGER,quarantine_reason TEXT);
    CREATE UNIQUE INDEX seq_slot ON event_log(vault_id,device_id,author_seq);
    CREATE TABLE projection_conflicts(id INTEGER PRIMARY KEY,kind TEXT,vault_id TEXT,detail_json TEXT,created_at INTEGER);
    CREATE TABLE vault_device_registry(vault_id TEXT,device_pubkey TEXT,device_id TEXT,account_id TEXT,added_at_ms INTEGER,removed_at_ms INTEGER);
    CREATE TABLE vault_credentials(vault_id TEXT,device_id TEXT,account_id TEXT);
    CREATE TABLE revocation_list(vault_id TEXT,device_id TEXT,lifted_at INTEGER);
    INSERT INTO vaults VALUES('vault',1,'other-anchor');
    INSERT INTO vault_members_mirror VALUES('vault','owner','owner',1,NULL,NULL),('vault','target','editor',1,NULL,NULL);
  `);
  const seed = sql.prepare(
    `INSERT INTO event_log(event_id,event_type,vault_id,target_id,hlc_physical_ms,hlc_logical,hlc_device_id,payload_json,applied_at)VALUES(?,'vault_member_added','vault',?,1,0,'genesis',?,1)`,
  );
  seed.run("genesis-owner", OWNER, JSON.stringify({ account_id: OWNER, role: "owner" }));
  seed.run("genesis-target", TARGET, JSON.stringify({ account_id: TARGET, role: "editor" }));
  let transactions = 0,
    signerReads = 0,
    sweeps = 0,
    emits = 0,
    conflicts = 0;
  const roles = () =>
    sql.prepare("SELECT account_id,role FROM vault_members_mirror ORDER BY account_id").all();
  const externalReads: { transaction: boolean; roles: unknown }[] = [];
  const committedEffects: { kind: string; transaction: boolean; roles: unknown }[] = [];
  let nextMirrorReadPause: {
    entered: ReturnType<typeof deferred>;
    released: ReturnType<typeof deferred>;
  } | null = null;
  const db = {
    getFirstAsync: async (query: string, ...args: unknown[]) =>
      sql.prepare(query).get(...args) ?? null,
    getAllAsync: async (query: string, ...args: unknown[]) => {
      const rows = sql.prepare(query).all(...args);
      if (nextMirrorReadPause && query.includes("FROM vault_members_mirror")) {
        const pause = nextMirrorReadPause;
        nextMirrorReadPause = null;
        pause.entered.resolve();
        await pause.released.promise;
      }
      return rows;
    },
    runAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      transactions++;
      assert.equal(sql.inTransaction, false, "never nest projection transactions");
      sql.exec("BEGIN");
      try {
        await work();
        sql.exec("COMMIT");
      } catch (err) {
        sql.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as SQLiteTx;
  const dbModule = {
    getDb: async () => db,
    getInstallIdSync: () => DEVICE,
    getAccountIdSync: () => OWNER,
    getActiveVaultIdSync: () => VAULT,
    getLocalSelfUserIdSync: () => "self",
    getAppMetaInTx: async (_: unknown, key: string) =>
      (
        sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as
          | { value: string }
          | undefined
      )?.value ?? null,
    setAppMetaInTx: async (_: unknown, key: string, value: string) => {
      sql.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(key, value);
    },
  };
  const nativeCrypto = { getRandomBytes: (size: number) => randomBytes(size), randomUUID };
  const signature = compile<typeof import("../event-sig")>("../event-sig", (name) =>
    name === "expo-crypto" ? nativeCrypto : require(name),
  );
  let secret = new Uint8Array(32).fill(7);
  let pub = Buffer.from(ed.getPublicKey(secret)).toString("base64");
  class DeviceKeyUnavailableError extends Error {
    reason = "test";
  }
  const deviceKey = {
    DeviceKeyUnavailableError,
    getDeviceSigner: async () => {
      signerReads++;
      assert.equal(sql.inTransaction, false, "prepare key outside transaction");
      const signerSecret = secret;
      return { pubkey_b64: pub, sign: async (bytes: Uint8Array) => ed.sign(bytes, signerSecret) };
    },
    isOwnDevicePubkey: async () => false,
  };
  const gate = compile<typeof import("../projection/role-gate")>(
    "../projection/role-gate",
    (name) => {
      if (name === "../db-tx") return dbModule;
      if (name === "../effective-account")
        return { resolveAccountIdCandidates: async (account: string) => [account] };
      if (name === "../event-sig") return signature;
      if (name === "../hlc") return require("../hlc");
      if (name === "../trust/chain" || name === "../trust/crypto-runtime") return {};
      if (name === "../trust/ownership-transfer") return require("../trust/ownership-transfer");
      if (name === "../mesh/device-key") return deviceKey;
      throw Error(`Unexpected gate import ${name}`);
    },
  );
  const roleHooks = compile<typeof import("../use-vault-role")>("../use-vault-role", (name) => {
    if (name === "expo-router") return { useFocusEffect: () => {} };
    if (name === "react")
      return {
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => void) => effect(),
        useRef: (current: unknown) => ({ current }),
        useState: (value: unknown) => [value, () => {}],
      };
    if (name === "react-native")
      return { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
    if (name === "./db-tx") return dbModule;
    if (name === "./effective-account")
      return {
        resolveAccountIdCandidates: async (account: string) => {
          externalReads.push({ transaction: sql.inTransaction, roles: roles() });
          return [account];
        },
      };
    if (name === "./ledger-events") return { useLedgerRefresh: () => {} };
    if (name === "./projection/role-gate") return gate;
    if (name === "./vault-roles") return require("../vault-roles");
    throw Error(`Unexpected hook import ${name}`);
  });
  const members = compile<typeof import("../projection/vault_members")>(
    "../projection/vault_members",
    (name) => {
      if (name === "../hlc") return require("../hlc");
      if (name === "../use-vault-role") return roleHooks;
      throw Error(`Unexpected member applier import ${name}`);
    },
  );
  const projection = compile<typeof import("../projection")>("../projection", (name) => {
    if (name === "../db-tx") return dbModule;
    if (name === "../events") return require("../events");
    if (name === "../event-sig") return signature;
    if (name === "../mesh/device-key") return deviceKey;
    if (name === "../hlc") return require("../hlc");
    if (name === "./role-gate") return gate;
    if (name === "./vault_members") return members;
    if (name === "../use-vault-role") return roleHooks;
    if (name === "../util/mutex") return require("../util/mutex");
    if (name === "../projection-conflicts")
      return {
        notifyProjectionConflictsChanged: () => {
          conflicts++;
          assert.equal(sql.inTransaction, false);
        },
      };
    if (name === "../credit-admission")
      return {
        captureCreditMutationBaseline: async () => {},
        requiresCreditAdmission: async () => false,
      };
    if (name === "./sweep")
      return {
        scheduleSweep: () => {
          sweeps++;
          committedEffects.push({ kind: "sweep", transaction: sql.inTransaction, roles: roles() });
        },
      };
    if (name === "../ledger-events")
      return {
        emitLedgerApplied: () => {
          emits++;
          committedEffects.push({ kind: "ledger", transaction: sql.inTransaction, roles: roles() });
        },
      };
    if (name.startsWith("./")) return {};
    throw Error(`Unexpected projection import ${name}`);
  });
  const append = compile<typeof import("../event-log")>("../event-log", (name) => {
    if (name === "expo-crypto") return nativeCrypto;
    if (name === "./db-tx") return dbModule;
    if (name === "./mesh/device-key") return deviceKey;
    if (name === "./event-sig") return signature;
    if (name === "./projection") return projection;
    if (name === "./money" || name === "./money-sql" || name === "./tabs/errors") return {};
    throw Error(`Unexpected append import ${name}`);
  });
  roleHooks.useVaultRole(VAULT, OWNER);
  externalReads.length = 0;
  const transfer = (preflight?: (tx: SQLiteTx) => Promise<void>) =>
    append.appendVaultOwnershipTransfer({
      targetVaultId: VAULT,
      toAccountId: TARGET,
      selfAccountId: OWNER,
      demoteSelfTo: "editor",
      preflight,
    });
  const counts = () => ({ transactions, signerReads, sweeps, emits, conflicts });
  const pendingEvents = () =>
    sql
      .prepare("SELECT * FROM event_log WHERE event_id NOT LIKE 'genesis-%' ORDER BY author_seq")
      .all() as Record<string, any>[];
  return {
    sql,
    db,
    gate,
    projection,
    append,
    transfer,
    counts,
    roles,
    externalReads,
    committedEffects,
    pendingEvents,
    pub,
    signature,
    roleHooks,
    rotateKey: () => {
      secret = new Uint8Array(32).fill(8);
      pub = Buffer.from(ed.getPublicKey(secret)).toString("base64");
    },
    pauseNextMirrorRead: () => {
      nextMirrorReadPause = { entered: deferred(), released: deferred() };
      return nextMirrorReadPause;
    },
  };
}

async function tests() {
  {
    const f = fixture();
    const provenSigner = f.pub;
    f.rotateKey();
    await assert.rejects(
      f.append.appendVaultOwnershipTransfer({
        targetVaultId: VAULT,
        toAccountId: TARGET,
        selfAccountId: OWNER,
        demoteSelfTo: "editor",
        expectedSignerPubkey: provenSigner,
      }),
      (err) =>
        err instanceof f.projection.EventSigningUnavailableError && /key changed/.test(err.message),
    );
    assert.equal(
      f.pendingEvents().length,
      0,
      "key replacement between proof and append emits neither ownership event",
    );
    assert.deepEqual(f.roles(), [
      { account_id: OWNER, role: "owner" },
      { account_id: TARGET, role: "editor" },
    ]);
    assert.deepEqual(f.counts(), {
      transactions: 0,
      signerReads: 1,
      sweeps: 0,
      emits: 0,
      conflicts: 0,
    });
    f.sql.close();
  }
  {
    const f = fixture();
    let preflight = false;
    const result = await f.transfer(async () => {
      assert.equal(f.sql.inTransaction, true);
      assert.equal(f.pendingEvents().length, 0);
      preflight = true;
    });
    assert.equal(preflight, true);
    assert.deepEqual(f.roles(), [
      { account_id: OWNER, role: "editor" },
      { account_id: TARGET, role: "owner" },
    ]);
    assert.deepEqual(f.counts(), {
      transactions: 1,
      signerReads: 1,
      sweeps: 1,
      emits: 1,
      conflicts: 0,
    });
    const events = f.pendingEvents();
    assert.equal(events.length, 2);
    assert.equal(result.event_id, events[1].event_id);
    assert.ok(events[0].author_seq < events[1].author_seq);
    assert.ok(
      events[0].hlc_physical_ms < events[1].hlc_physical_ms ||
        events[0].hlc_logical < events[1].hlc_logical,
    );
    for (const event of events) {
      assert.equal(event.signer_device_pubkey, f.pub);
      assert.equal(
        f.signature.verifyEventSignature(
          {
            ...event,
            hlc: { pms: event.hlc_physical_ms, l: event.hlc_logical, did: event.hlc_device_id },
            payload: JSON.parse(event.payload_json),
          } as Parameters<typeof f.signature.verifyEventSignature>[0],
          event.event_sig_b64,
          f.pub,
        ).valid,
        true,
        "both events retain valid signatures over their final HLCs",
      );
    }
    assert.ok(f.externalReads.length > 0);
    assert.equal(f.committedEffects.length, 2);
    for (const effect of f.committedEffects) {
      assert.equal(
        effect.transaction,
        false,
        "post-commit effects never run inside a batch transaction",
      );
      assert.deepEqual(effect.roles, f.roles());
    }
    for (const read of f.externalReads) {
      assert.equal(read.transaction, false, "role consumers never read an unfinished handover");
      assert.deepEqual(read.roles, f.roles());
    }
    f.sql.close();
  }
  {
    const f = fixture();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pause = f.pauseNextMirrorRead();
    const read = f.roleHooks.readVaultRole(VAULT, TARGET);
    await pause.entered.promise;
    await f.transfer();
    pause.released.resolve();
    assert.equal(
      await read,
      "owner",
      "a pre-transfer role read retries instead of publishing its stale snapshot",
    );
    f.sql.close();
  }
  for (const rollback of [false, true]) {
    const f = fixture();
    const promoted = deferred(),
      finish = deferred();
    const original = f.projection.APPLIERS.vault_member_role_changed!;
    f.projection.APPLIERS.vault_member_role_changed = async (tx, event) => {
      if (rollback && event.target_id === OWNER) throw Error("late demotion failure");
      await original(tx, event);
      if (event.target_id === TARGET) {
        promoted.resolve();
        await finish.promise;
      }
    };
    const write = f.transfer();
    const completion = rollback ? assert.rejects(write, /late demotion failure/) : write;
    await promoted.promise;
    let published = false;
    const read = f.roleHooks.readVaultRole(VAULT, TARGET).then((role) => {
      published = true;
      return role;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      published,
      false,
      "external role reader waits while only the promotion is written",
    );
    finish.resolve();
    await completion;
    assert.equal(
      await read,
      rollback ? "editor" : "owner",
      "role reader receives only the final committed or rolled-back authority",
    );
    f.sql.close();
  }
  {
    const f = fixture();
    f.sql.exec(
      "CREATE TRIGGER fail_demotion BEFORE UPDATE ON vault_members_mirror WHEN NEW.account_id='owner' AND NEW.role='editor' BEGIN SELECT RAISE(ABORT,'simulated interrupted demotion'); END;",
    );
    await assert.rejects(f.transfer(), /simulated interrupted demotion/);
    assert.deepEqual(f.roles(), [
      { account_id: OWNER, role: "owner" },
      { account_id: TARGET, role: "editor" },
    ]);
    assert.equal(f.pendingEvents().length, 0);
    assert.equal(
      f.sql.prepare<[], { n: number }>("SELECT COUNT(*) n FROM app_meta").get()!.n,
      0,
      "HLC rollback accompanies log/projection rollback",
    );
    assert.deepEqual(f.counts(), {
      transactions: 1,
      signerReads: 1,
      sweeps: 0,
      emits: 0,
      conflicts: 0,
    });
    for (const read of f.externalReads) {
      assert.equal(read.transaction, false);
      assert.deepEqual(read.roles, f.roles());
    }
    f.sql.exec("DROP TRIGGER fail_demotion");
    await f.transfer();
    assert.equal(
      f.pendingEvents().length,
      2,
      "retry has one complete handover, no orphaned promotion",
    );
    f.sql.close();
  }
  {
    const f = fixture();
    await assert.rejects(
      f.transfer(async () => {
        throw Error("membership changed before save");
      }),
      /membership changed/,
    );
    assert.equal(f.pendingEvents().length, 0);
    assert.deepEqual(f.counts(), {
      transactions: 1,
      signerReads: 1,
      sweeps: 0,
      emits: 0,
      conflicts: 0,
    });
    f.sql.close();
  }
  {
    const f = fixture();
    // A true gate refusal on event two must roll event one back, including its
    // audit trail. Demoting the target first would leave no successor owner.
    const make = (account: string, role: VaultRole): VaultMemberRoleChangedEvent => ({
      event_id: randomUUID(),
      event_type: "vault_member_role_changed",
      vault_id: VAULT,
      target_id: account,
      relationship_id: null,
      hlc: { pms: 0, l: 0, did: DEVICE },
      device_id: DEVICE,
      author_user_id_local_only: "self",
      actor_account_id: OWNER,
      payload_schema: 1,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "local",
      payload: { account_id: account, role },
    });
    await assert.rejects(
      f.projection.applyLocalEventsAtomically([make(TARGET, "viewer"), make(OWNER, "editor")]),
      (err) =>
        err instanceof f.projection.AtomicEventRejectionError &&
        err.index === 1 &&
        err.result.reason === "role_gate",
    );
    assert.equal(f.pendingEvents().length, 0);
    assert.equal(
      f.sql.prepare<[], { n: number }>("SELECT COUNT(*) n FROM projection_conflicts").get()!.n,
      0,
    );
    assert.equal(f.counts().conflicts, 0);
    // Single events keep the existing committed refusal audit contract.
    const result = await f.projection.applyEvent(make(OWNER, "editor"), { origin: "local" });
    assert.equal(result.applied, false);
    assert.equal(f.pendingEvents().length, 1);
    assert.equal(f.pendingEvents()[0].applied_at, null);
    assert.equal(
      f.sql.prepare<[], { n: number }>("SELECT COUNT(*) n FROM projection_conflicts").get()!.n,
      1,
    );
    assert.equal(f.counts().conflicts, 1);
    f.sql.close();
  }
  {
    const f = fixture();
    const original = f.projection.APPLIERS.vault_member_role_changed!;
    const probe = {
      event_id: "cache-probe",
      event_type: "vault_member_role_changed",
      vault_id: VAULT,
      target_id: OWNER,
      relationship_id: null,
      hlc: { pms: Date.now() + 10000, l: 0, did: DEVICE },
      device_id: DEVICE,
      author_user_id_local_only: "self",
      actor_account_id: TARGET,
      payload_schema: 1,
      appended_at: 0,
      server_acked_at: null,
      rejected_at: null,
      origin: "local",
      payload: { account_id: OWNER, role: "owner" },
    } as LedgerEvent;
    f.projection.APPLIERS.vault_member_role_changed = async (tx, event) => {
      if (event.target_id === OWNER) throw Error("second applier failed after cached promotion");
      await original(tx, event);
      assert.equal(
        (await f.gate.checkRoleForEvent(tx, probe)).ok,
        true,
        "prime gate cache with intermediate target owner authority",
      );
    };
    await assert.rejects(f.transfer(), /second applier failed/);
    const after = await f.gate.checkRoleForEvent(f.db, probe);
    assert.equal(
      after.ok,
      false,
      "rollback clears cached owner authority from the abandoned promotion",
    );
    assert.deepEqual(f.roles(), [
      { account_id: OWNER, role: "owner" },
      { account_id: TARGET, role: "editor" },
    ]);
    f.sql.close();
  }
  console.log(
    "PASS atomic ownership: commit, interruption rollback/retry, fresh preflight, gate refusal, single-event audit, notifications and rollback authority cache",
  );
}

tests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
