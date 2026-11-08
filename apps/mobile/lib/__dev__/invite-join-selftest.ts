// Actual acceptance API, durable journal, append helpers, Ed25519 signatures,
// membership SQL loader and chain fold. Isolated SQLite; no user data/network.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import * as chain from "../trust/chain";
import * as defaultDevWitness from "../trust/dev-witness-key";
import * as verificationCache from "../trust/successful-verification-cache";
import * as ownershipTransfer from "../trust/ownership-transfer";
import { compileUI, deferred, settleUI, uiHooks, jsx, nodes } from "./ui-fixture";

const eventSig = compileUI("../event-sig", {
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  "@noble/ed25519": ed,
  "expo-crypto": { getRandomBytes: randomBytes },
});
const runtime = compileUI("../trust/crypto-runtime", {
  "../event-sig": eventSig,
  "./successful-verification-cache": verificationCache,
  "./chain": chain,
  "./ownership-transfer": ownershipTransfer,
  "kaata-bt-classic": { verifyEd25519BatchAsync: async () => null },
});
const ownerSeed = new Uint8Array(32).fill(4),
  peerSeed = new Uint8Array(32).fill(5),
  serverSeed = new Uint8Array(32).fill(6);
const key = (seed: Uint8Array) => Buffer.from(ed.getPublicKey(seed)).toString("base64");
const ownerKey = key(ownerSeed),
  peerKey = key(peerSeed),
  serverKey = key(serverSeed);

async function fixture(devWitness = defaultDevWitness) {
  const store = new Database(":memory:");
  store.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE pending_invitations(token TEXT,accepted_at INTEGER,declined_at INTEGER);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_trust_anchor_pubkey TEXT,archived_at INTEGER);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,
      accepted_at INTEGER,revoked_at INTEGER,display_name TEXT);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,
      relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,
      device_id TEXT,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,event_sig_b64 TEXT,
      signer_device_pubkey TEXT,author_seq INTEGER,tombstone_reason TEXT,rejected_at INTEGER,server_acked_at INTEGER,
      applied_at INTEGER,quarantine_reason TEXT);
    INSERT INTO pending_invitations VALUES('invite',NULL,NULL);
  `);
  store.prepare("INSERT INTO vaults VALUES('vault',?,NULL)").run(ownerKey);
  let account = "peer",
    version = 0,
    locked = false,
    now = 1000000,
    attempts = 0,
    offline = false,
    refuse = false,
    nextWitnessStatus = 0,
    omitMemberWitness = false;
  let tail = Promise.resolve();
  const calls: string[] = [];
  class SessionChangedError extends Error {}
  const session = () => ({ accountId: account, jwt: `jwt-${account}`, bindingVersion: version });
  const auth = {
    SessionChangedError,
    captureCurrentSession: async () => session(),
    getSessionJWT: async () => session().jwt,
    applyForCurrentSession: async (before: any, work: () => Promise<any>) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      if (before.accountId !== account || before.bindingVersion !== version) {
        release();
        throw new SessionChangedError();
      }
      locked = true;
      try {
        return await work();
      } finally {
        locked = false;
        release();
      }
    },
  };
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
    withTransactionAsync: async (work: () => Promise<any>) => {
      store.exec("BEGIN");
      try {
        const result = await work();
        store.exec("COMMIT");
        return result;
      } catch (err) {
        store.exec("ROLLBACK");
        throw err;
      }
    },
  };
  const getMeta = async (name: string) =>
    (store.prepare("SELECT value FROM app_meta WHERE key=?").get(name) as any)?.value ?? null;
  const setMeta = async (name: string, value: string) => {
    store.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(name, value);
  };
  await setMeta("mesh_server_pubkey_primary", serverKey);
  const dbModule = {
    getDb: async () => db,
    getAppMeta: getMeta,
    setAppMeta: setMeta,
    getLocalSelf: async () => ({ name: "Ahmad" }),
  };
  const dbTx = {
    getDb: async () => db,
    getAccountIdSync: () => account,
    getInstallIdSync: () => "peer-device",
    getLocalSelfUserIdSync: () => "self",
    getActiveVaultIdSync: () => "vault",
    getAppMetaInTx: async (_: any, name: string) => getMeta(name),
    setAppMetaInTx: async (_: any, name: string, value: string) => setMeta(name, value),
  };
  const proof = compileUI("../trust/proof", {
    "../db": dbModule,
    "./chain": chain,
    "./crypto-runtime": runtime,
    "./dev-witness-key": devWitness,
  });
  let seq = 0,
    dropNext = false;
  async function append(event: any, seed = peerSeed, ack = false) {
    event.relationship_id = null;
    event.hlc = { pms: now, l: seq++, did: event.device_id };
    event.event_sig_b64 = Buffer.from(ed.sign(eventSig.canonicalizeEvent(event), seed)).toString(
      "base64",
    );
    event.signer_device_pubkey = key(seed);
    store
      .prepare(
        `INSERT INTO event_log(event_id,event_type,vault_id,target_id,relationship_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,actor_account_id,payload_json,payload_schema,event_sig_b64,signer_device_pubkey,author_seq,tombstone_reason,rejected_at,server_acked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
      )
      .run(
        event.event_id,
        event.event_type,
        "vault",
        event.target_id,
        null,
        event.hlc.pms,
        event.hlc.l,
        event.device_id,
        event.device_id,
        event.actor_account_id,
        JSON.stringify(event.payload),
        event.payload_schema,
        event.event_sig_b64,
        event.signer_device_pubkey,
        seq,
        ack ? now : null,
      );
  }
  await append(
    {
      event_id: "genesis",
      event_type: "vault_member_added",
      vault_id: "vault",
      target_id: "owner",
      device_id: "owner-device",
      actor_account_id: "owner",
      payload_schema: 1,
      payload: { account_id: "owner", role: "owner" },
    },
    ownerSeed,
    true,
  );
  const device = {
    ensureDeviceKey: async () => ({ pubkey_b64: peerKey }),
    getDevicePubkey: () => peerKey,
    META_REBIND_PENDING_KEY: "rebind",
    META_REREGISTER_PENDING_KEY: "reregister",
    registerDeviceKey: async () => {
      calls.push("register-key");
      await setMeta("reregister", "");
      return "registered";
    },
    signWithDeviceKey: async (msg: Uint8Array) => ed.sign(msg, peerSeed),
  };
  let currentPubkey = peerKey;
  device.ensureDeviceKey = async () => ({ pubkey_b64: currentPubkey });
  device.getDevicePubkey = () => currentPubkey;
  const events = compileUI("../event-log", {
    "expo-crypto": { randomUUID },
    "./db-tx": dbTx,
    "./mesh/device-key": device,
    "./event-sig": eventSig,
    "./projection": {
      applyEvent: async (event: any) => {
        assert.ok(locked, "join appends must own the original session guard");
        if (dropNext) {
          dropNext = false;
          return { applied: false };
        }
        await append(event);
        const folded = await proof.getLocalMembershipState("vault");
        const conflict = folded.conflicts.find((c: any) => c.event_id === event.event_id);
        return conflict
          ? {
              applied: false,
              reason: "role_gate",
              role_gate: { reason: "unknown_actor", current_role: null, required_role: "owner" },
            }
          : { applied: true };
      },
    },
    "./money": {},
    "./money-sql": {},
    "./entry-date": require("../entry-date"),
    "./currency-scope": require("../currency-scope"),
    "./customer-note": require("../customer-note"),
    "./tabs/errors": { TabLinkedEntryError: class extends Error {} },
    "./tabs/history": require("../tabs/history"),
  });
  class ApiError extends Error {
    constructor(public status: number) {
      super("refused");
    }
  }
  const witness = () => {
    const sig = (tuple: any) =>
      Buffer.from(
        ed.sign(new TextEncoder().encode(eventSig.canonicalize(tuple)), serverSeed),
      ).toString("base64");
    return {
      server_key_id: "key",
      member_witness: omitMemberWitness
        ? null
        : {
            role: "viewer",
            inviter_account_id: "owner",
            issued_at_ms: now,
            sig_b64: sig(
              chain.memberWitnessTuple({
                vault_id: "vault",
                account_id: "peer",
                inviter_account_id: "owner",
                role: "viewer",
                issued_at_ms: now,
              }),
            ),
          },
      device_witness: {
        issued_at_ms: now,
        sig_b64: sig(
          chain.deviceWitnessTuple({
            vault_id: "vault",
            account_id: "peer",
            device_id: "peer-device",
            device_pubkey_b64: peerKey,
            issued_at_ms: now,
          }),
        ),
      },
    };
  };
  const witnessGate = deferred<any>();
  let holdWitness = false;
  const backfill = compileUI(
    "../trust/backfill",
    {
      "../auth": auth,
      "../db": dbModule,
      "../db-tx": dbTx,
      "../i18n": { isPlaceholderSelfName: () => false },
      "../event-log": events,
      "../vault-roles": { parseVaultRole: (role: string) => role },
      "../mesh/device-key": device,
      "./account-id": { buildLocalAccountId: () => "local" },
      "./proof": proof,
      "./chain": chain,
      "./crypto-runtime": runtime,
      "../recovery": {
        pinServerWitnessKeys: async (before: any) => {
          assert.equal(locked, false, "key check-in must not hold session mutex");
          calls.push("pin-keys");
          await auth.applyForCurrentSession(before, () =>
            setMeta("mesh_server_pubkey_primary", serverKey),
          );
        },
      },
      "../projection/sweep": {
        sweepVaultNow: async () => {
          assert.ok(locked);
          calls.push("sweep-after-pin");
        },
      },
      "../vault-api": {
        ApiError,
        fetchMembershipWitness: async () => {
          assert.equal(locked, false, "HTTP cannot hold session mutex");
          attempts++;
          if (nextWitnessStatus) {
            const status = nextWitnessStatus;
            nextWitnessStatus = 0;
            throw new ApiError(status);
          }
          if (offline) throw Error("offline");
          if (refuse) throw new ApiError(403);
          return holdWitness ? witnessGate.promise : witness();
        },
      },
    },
    { Date: { now: () => now } },
  );
  let responseMode = "ok";
  let readmissionResult: Record<string, any> | undefined;
  let recoveryPublished = false;
  let skipReturnProjection = false;
  const readmission = compileUI("../member-readmission-guest", {
    "./auth": auth,
    "./db-tx": dbTx,
    "./mesh/device-key": device,
    "./trust/proof": proof,
    "./recovery": {
      prepareMemberReadmissionVault: async () => {
        calls.push("return-metadata");
        return true;
      },
    },
    "./sync/pull": {
      pullEvents: async (_: any, saved: any, options: any) => {
        assert.equal(locked, false, "return pull releases session mutex");
        assert.equal(saved.accountId, account);
        assert.equal(options.deferProjection, true);
        calls.push("return-pull");
      },
    },
    "./projection/sweep": {
      sweepVaultNow: async () => {
        assert.ok(locked);
        calls.push("return-sweep");
        recoveryPublished = true;
        if (!skipReturnProjection) {
          store.exec(
            "UPDATE event_log SET applied_at=1; UPDATE vault_members_mirror SET revoked_at=NULL",
          );
        }
      },
    },
  });
  let timeoutCallback: (() => void) | undefined;
  const requestGate = deferred<any>();
  const requestStarted = deferred<void>();
  const memberRequests: Record<string, any> = {};
  const directCalls: { method: string; path: string; session: any }[] = [];
  const api = compileUI(
    "../vault-api",
    {
      "./api": { getBackendUrl: async () => "https://test.invalid" },
      "./auth": auth,
      "./db": dbModule,
      "./db-tx": dbTx,
      "./vault-member-requests": memberRequests,
      "./mesh/device-key": device,
      "./member-readmission-guest": readmission,
      "./projection": { applyEventMutex: { runExclusive: (work: any) => work() } },
      "./recovery": {
        recoverJoinedVault: async () => {
          calls.push("recover");
          return false;
        },
      },
    },
    {
      __DEV__: false,
      AbortController,
      clearTimeout: () => {
        timeoutCallback = undefined;
      },
      setTimeout: (fn: () => void) => {
        timeoutCallback = fn;
        return 1;
      },
      fetch: async (url: string, opts: any) => {
        if (url.endsWith("/v1/devices/register-key")) {
          calls.push("return-register-key");
          assert.equal(JSON.parse(opts.body).ed25519_pubkey, currentPubkey);
          return { ok: true, status: 204, headers: { get: () => "" } };
        }
        requestStarted.resolve();
        calls.push(`${opts.method.toLowerCase()}:${opts.headers.Authorization}`);
        assert.ok(await getMeta("invite_accept_pending:peer"), "intent precedes consuming POST");
        if (readmissionResult) {
          if (opts.method === "POST") assert.equal(JSON.parse(opts.body).member_readmission, true);
          else {
            assert.ok(url.endsWith("/11111111-1111-4111-8111-111111111111/readmission"));
            assert.equal(opts.body, undefined, "read-only status never repeats consent");
          }
        }
        if (responseMode === "lost") throw Error("lost response after server commit");
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () =>
            responseMode === "hold"
              ? requestGate.promise
              : (readmissionResult ?? { vault_id: "vault", vault_name: "Shop", role: "viewer" }),
        };
      },
    },
  );
  Object.assign(
    memberRequests,
    compileUI("../vault-member-requests", {
      "./auth": auth,
      "./db-tx": dbTx,
      "./vault-api": api,
      "./tabs/errors": require("../tabs/errors"),
      "./people-connections": {
        peopleRequest: async (method: string, path: string, _body: any, before: any) => {
          await auth.applyForCurrentSession(before, async () => {});
          directCalls.push({ method, path, session: before });
          if (responseMode === "lost") throw new Error("offline before server decline");
          return method === "GET"
            ? {
                vault_name: "Private Shop",
                role: "viewer",
                inviter_name: "Owner",
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              }
            : undefined;
        },
      },
    }),
  );
  return {
    store,
    proof,
    backfill,
    api,
    readmission,
    returnResult: (pending: boolean) => {
      readmissionResult = {
        vault_id: "vault",
        vault_name: "Shop",
        role: "viewer",
        member_readmission: true,
        readmission_pending: pending,
        readmission_invite_id: "11111111-1111-4111-8111-111111111111",
        readmission_device_id: "peer-device",
        readmission_device_pubkey: peerKey,
        ...(!pending
          ? {
              readmission_member_event_id: "return-member",
              readmission_device_event_id: "return-device",
            }
          : {}),
      };
      return readmissionResult;
    },
    rotateKey: () => {
      currentPubkey = ownerKey;
    },
    get recoveryPublished() {
      return recoveryPublished;
    },
    skipReturnProjection: (skip: boolean) => {
      skipReturnProjection = skip;
    },
    getMeta,
    setMeta,
    calls,
    directCalls,
    session,
    SessionChangedError,
    append,
    omitMemberWitness: (omit = true) => {
      omitMemberWitness = omit;
    },
    seedPrematureDevice: async (acked = true) => {
      const response = witness();
      await append(
        {
          event_id: "premature-device",
          event_type: "vault_device_added",
          vault_id: "vault",
          target_id: "peer-device",
          device_id: "peer-device",
          actor_account_id: "peer",
          payload_schema: 1,
          payload: {
            account_id: "peer",
            device_id: "peer-device",
            device_pubkey: peerKey,
            witness: { ...response.device_witness, server_key_id: response.server_key_id },
          },
        },
        peerSeed,
        acked,
      );
    },
    witnessStatus: (status: number) => {
      nextWitnessStatus = status;
    },
    advance: () => {
      now += 61_000;
    },
    attempts: () => attempts,
    offline: () => {
      offline = true;
    },
    online: () => {
      offline = false;
    },
    refuse: () => {
      refuse = true;
    },
    ack: () => store.exec("UPDATE event_log SET server_acked_at=1"),
    noAnchor: () => store.exec("UPDATE vaults SET vault_trust_anchor_pubkey=NULL"),
    dropAppend: () => {
      dropNext = true;
    },
    holdWitness: () => {
      holdWitness = true;
    },
    releaseWitness: () => witnessGate.resolve(witness()),
    switchAccount: () => {
      account = "other";
      version++;
    },
    response: (mode: string) => {
      responseMode = mode;
    },
    waitForRequest: () => requestStarted.promise,
    expire: () => {
      assert.ok(timeoutCallback);
      timeoutCallback!();
    },
    releaseResponse: () =>
      requestGate.resolve({ vault_id: "vault", vault_name: "Shop", role: "viewer" }),
  };
}

async function main() {
  await readmissionCases();
  const localOrigin = "http://192.168.1.9:8080";
  const devEnv = {
    EXPO_PUBLIC_BACKEND_URL: localOrigin,
    EXPO_PUBLIC_DEV_WITNESS_ORIGIN: localOrigin,
    EXPO_PUBLIC_DEV_WITNESS_PUBKEY: serverKey,
    EXPO_PUBLIC_DEV_WITNESS_ROTATION_PUBKEY: peerKey,
  };
  const devWitness = compileUI(
    "../trust/dev-witness-key",
    {},
    {
      __DEV__: true,
      process: { env: devEnv },
    },
  );
  assert.deepEqual(devWitness.devWitnessPublicKeys(null), [serverKey, peerKey]);
  assert.deepEqual(devWitness.devWitnessPublicKeys(`${localOrigin}/v1`), [serverKey, peerKey]);
  for (const different of [
    "https://api.kaata.af",
    "http://192.168.1.9:8081",
    "http://192.168.1.9.evil.test:8080",
  ])
    assert.equal(devWitness.devWitnessPublicKeys(different), null);
  const releaseWitness = compileUI(
    "../trust/dev-witness-key",
    {},
    {
      __DEV__: false,
      process: { env: devEnv },
    },
  );
  assert.equal(releaseWitness.devWitnessPublicKeys(null), null);
  const unconfiguredWitness = compileUI(
    "../trust/dev-witness-key",
    {},
    {
      __DEV__: true,
      process: { env: { ...devEnv, EXPO_PUBLIC_DEV_WITNESS_PUBKEY: "bad-key" } },
    },
  );
  assert.equal(unconfiguredWitness.devWitnessPublicKeys(null), null);
  const reusedPhone = await fixture(devWitness);
  await reusedPhone.setMeta("mesh_server_pubkey_primary", ownerKey);
  assert.deepEqual(await reusedPhone.proof.loadPinnedWitnessPubkeysB64(), [serverKey, peerKey]);
  assert.equal(await reusedPhone.proof.persistPinnedServerPubkeys(serverKey, null), "no_change");
  assert.equal(await reusedPhone.getMeta("mesh_server_pubkey_primary"), ownerKey);
  await assert.rejects(
    reusedPhone.backfill.emitWitnessedSelfAdmission("vault"),
    reusedPhone.backfill.JoinProofPendingError,
  );
  reusedPhone.ack();
  await reusedPhone.backfill.emitWitnessedSelfAdmission("vault");
  assert.equal(
    reusedPhone.attempts(),
    1,
    "a reused phone verifies the same local test join without reissuing witnesses",
  );
  await reusedPhone.setMeta("backend_url_override", "https://api.kaata.af");
  assert.deepEqual(await reusedPhone.proof.loadPinnedWitnessPubkeysB64(), [ownerKey]);
  const healthy = await fixture();
  await assert.rejects(
    healthy.backfill.emitWitnessedSelfAdmission("vault"),
    healthy.backfill.JoinProofPendingError,
  );
  const folded = await healthy.proof.getLocalMembershipState("vault");
  assert.equal(folded.members.get("peer").role, "viewer");
  assert.equal(folded.devices.get(peerKey).account_id, "peer");
  assert.equal(
    folded.conflicts.length,
    0,
    "real signed append helpers produce valid witness chain",
  );
  healthy.ack();
  healthy.offline();
  await healthy.backfill.emitWitnessedSelfAdmission("vault");
  assert.equal(
    healthy.attempts(),
    1,
    "already-published proof completes offline without new witness",
  );

  const missingMember = await fixture();
  await missingMember.api.acceptVaultInvite("v_11111111-1111-4111-8111-111111111111");
  missingMember.omitMemberWitness();
  await missingMember.backfill.ensureChainBackfill("vault");
  assert.equal(await missingMember.getMeta("witness_emit_pending:vault"), "1");
  assert.equal(
    (missingMember.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n,
    1,
    "a successful HTTP response without membership authority cannot emit a device admission",
  );
  assert.equal(
    await missingMember.backfill.isSelfAdmissionPublished("vault", missingMember.session()),
    false,
  );
  missingMember.omitMemberWitness(false);
  missingMember.advance();
  await missingMember.backfill.ensureChainBackfill("vault");
  assert.equal(
    await missingMember.getMeta("witness_emit_pending:vault"),
    "1",
    "repair still waits for publication",
  );
  assert.equal(
    missingMember.calls.filter((call) => call.startsWith("post:")).length,
    1,
    "repair never consumes the accepted invitation again",
  );
  missingMember.ack();
  missingMember.advance();
  await missingMember.backfill.ensureChainBackfill("vault");
  assert.equal(await missingMember.getMeta("witness_emit_pending:vault"), "");
  assert.equal(
    await missingMember.backfill.isSelfAdmissionPublished("vault", missingMember.session()),
    true,
  );

  const stranded = await fixture();
  await stranded.seedPrematureDevice();
  const originalPremature = stranded.store
    .prepare("SELECT * FROM event_log WHERE event_id='premature-device'")
    .get();
  assert.equal(
    await stranded.backfill.isSelfAdmissionPublished("vault", stranded.session()),
    false,
    "a server-acked device event before membership is not a completed join",
  );
  await stranded.setMeta("witness_emit_pending:vault", "1");
  await stranded.backfill.ensureChainBackfill("vault");
  const repaired = await stranded.proof.getLocalMembershipState("vault");
  assert.equal(repaired.members.get("peer").role, "viewer");
  assert.equal(repaired.devices.get(peerKey).account_id, "peer");
  assert.deepEqual(
    stranded.store.prepare("SELECT * FROM event_log WHERE event_id='premature-device'").get(),
    originalPremature,
    "repair appends valid admissions without rewriting historical signed rows",
  );
  assert.equal(
    await stranded.backfill.isSelfAdmissionPublished("vault", stranded.session()),
    false,
  );
  stranded.ack();
  stranded.advance();
  await stranded.backfill.ensureChainBackfill("vault");
  assert.equal(await stranded.backfill.isSelfAdmissionPublished("vault", stranded.session()), true);
  assert.equal(await stranded.getMeta("witness_emit_pending:vault"), "");

  const paired = await fixture();
  await paired.append(
    {
      event_id: "qr-member",
      event_type: "vault_member_added",
      vault_id: "vault",
      target_id: "peer",
      device_id: "owner-device",
      actor_account_id: "owner",
      payload_schema: 1,
      payload: { account_id: "peer", role: "viewer" },
    },
    ownerSeed,
    true,
  );
  paired.omitMemberWitness();
  await assert.rejects(paired.backfill.emitWitnessedSelfAdmission("vault"), /server confirmation/);
  assert.equal(
    (await paired.proof.getLocalMembershipState("vault")).devices.get(peerKey).account_id,
    "peer",
    "an owner-approved QR member can bind its device without an invitation witness",
  );

  const namedInviter = await fixture();
  namedInviter.store
    .prepare("INSERT INTO vault_members_mirror VALUES('vault','owner','manager',1,NULL,NULL)")
    .run();
  await assert.rejects(
    namedInviter.backfill.emitWitnessedSelfAdmission("vault", { inviterName: "Manager" }),
    /server confirmation/,
  );
  assert.deepEqual(
    namedInviter.store
      .prepare("SELECT role,display_name FROM vault_members_mirror WHERE account_id='owner'")
      .get(),
    { role: "manager", display_name: "Manager" },
    "cosmetic inviter name preserves the known role",
  );
  const absentInviter = await fixture();
  await assert.rejects(
    absentInviter.backfill.emitWitnessedSelfAdmission("vault", { inviterName: "Inviter" }),
    /server confirmation/,
  );
  assert.equal(
    (absentInviter.store.prepare("SELECT COUNT(*) n FROM vault_members_mirror").get() as any).n,
    0,
    "an inviter name cannot manufacture an owner membership mirror",
  );

  const retry = await fixture();
  await retry.backfill.ensureChainBackfill("vault"); // startup before invite
  await retry.setMeta("witness_emit_pending:vault", "1");
  retry.offline();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(retry.attempts(), 1, "early one-shot pass must not consume later join retry");
  retry.online();
  retry.advance();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(
    await retry.getMeta("witness_emit_pending:vault"),
    "1",
    "local append is not published success",
  );
  retry.ack();
  retry.advance();
  await retry.backfill.ensureChainBackfill("vault");
  assert.equal(await retry.getMeta("witness_emit_pending:vault"), "");

  const missing = await fixture();
  missing.noAnchor();
  await assert.rejects(missing.backfill.emitWitnessedSelfAdmission("vault"), /owner proof/);
  assert.equal(
    (missing.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n,
    1,
    "no mirror-only fake admission",
  );
  const declined = await fixture();
  declined.dropAppend();
  await assert.rejects(declined.backfill.emitWitnessedSelfAdmission("vault"));
  const blocked = await fixture();
  blocked.refuse();
  await assert.rejects(
    blocked.backfill.emitWitnessedSelfAdmission("vault"),
    blocked.backfill.JoinAdmissionBlockedError,
  );
  blocked.advance();
  await assert.rejects(
    blocked.backfill.emitWitnessedSelfAdmission("vault"),
    blocked.backfill.JoinAdmissionBlockedError,
  );
  assert.equal(blocked.attempts(), 1, "removed permission does not hammer witness endpoint");
  const registration = await fixture();
  registration.witnessStatus(412);
  await assert.rejects(registration.backfill.emitWitnessedSelfAdmission("vault"));
  assert.equal(await registration.getMeta("reregister"), "1");
  registration.advance();
  await assert.rejects(
    registration.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  assert.ok(
    registration.calls.includes("register-key"),
    "failed first registration is repaired before requesting witness again",
  );
  const unpinned = await fixture();
  await unpinned.setMeta("mesh_server_pubkey_primary", "");
  await assert.rejects(
    unpinned.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  assert.deepEqual(
    unpinned.calls,
    ["pin-keys", "sweep-after-pin"],
    "failed initial check-in is repaired before verifying the join",
  );
  assert.equal(
    (await unpinned.proof.getLocalMembershipState("vault")).members.get("peer").role,
    "viewer",
  );
  const wrongPin = await fixture();
  await wrongPin.setMeta("mesh_server_pubkey_primary", ownerKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      wrongPin.backfill.emitWitnessedSelfAdmission("vault"),
      /does not match the trusted server key/,
    );
    wrongPin.advance();
  }
  assert.equal(
    (wrongPin.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n,
    1,
    "a mismatched witness key never queues another member or device event",
  );
  const rejected = await fixture();
  await assert.rejects(
    rejected.backfill.emitWitnessedSelfAdmission("vault"),
    /server confirmation/,
  );
  rejected.store.exec("UPDATE event_log SET rejected_at=1 WHERE actor_account_id='peer'");
  await assert.rejects(
    rejected.backfill.emitWitnessedSelfAdmission("vault"),
    rejected.backfill.JoinAdmissionBlockedError,
  );
  const oversized = await fixture();
  const clone = oversized.store.prepare(
    "INSERT INTO event_log SELECT ?,event_type,vault_id,target_id,relationship_id,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,actor_account_id,payload_json,payload_schema,event_sig_b64,signer_device_pubkey,author_seq,tombstone_reason,rejected_at,server_acked_at,applied_at,quarantine_reason FROM event_log WHERE event_id='genesis'",
  );
  for (let i = 0; i < 500; i++) clone.run(`extra-${i}`);
  await assert.rejects(
    oversized.backfill.emitWitnessedSelfAdmission("vault"),
    oversized.backfill.JoinAdmissionBlockedError,
  );
  assert.equal(oversized.attempts(), 0, "a truncated chain cannot authorize successful readiness");
  const synthetic = await fixture();
  await synthetic.append(
    {
      event_id: "synthetic",
      event_type: "vault_member_added",
      vault_id: "vault",
      target_id: "owner",
      device_id: "owner-device",
      actor_account_id: "owner",
      payload_schema: 1,
      payload: { account_id: "owner", role: "owner", backfill_synthetic: true },
    },
    ownerSeed,
    true,
  );
  assert.equal(
    (await synthetic.proof.loadLocalMembershipEvents("vault", 500, true)).length,
    1,
    "a local recovery suppression ack is not publication",
  );
  assert.equal(
    (await synthetic.proof.loadLocalMembershipEvents("vault")).length,
    2,
    "normal chain authority stays unchanged",
  );
  const changed = await fixture();
  changed.holdWitness();
  const old = changed.backfill.emitWitnessedSelfAdmission("vault");
  await settleUI();
  changed.switchAccount();
  changed.releaseWitness();
  await assert.rejects(old, changed.SessionChangedError);
  assert.equal((changed.store.prepare("SELECT COUNT(*) n FROM event_log").get() as any).n, 1);

  const lost = await fixture();
  lost.response("lost");
  await assert.rejects(lost.api.acceptVaultInvite("invite"), /lost response/);
  assert.ok(await lost.getMeta("invite_accept_pending:peer"));
  lost.response("ok");
  await lost.api.retryPendingVaultMaterialize();
  assert.equal(await lost.getMeta("witness_emit_pending:vault"), "1");
  assert.equal(await lost.getMeta("vault_materialize_pending"), "vault");
  const resumed = await lost.api.resumePendingVaultInvite("invite", lost.session());
  assert.equal(resumed.vault_id, "vault");
  assert.equal(
    lost.calls.filter((s) => s.startsWith("post")).length,
    2,
    "consumed-link remount uses receipt, not a third POST",
  );

  const late = await fixture();
  late.response("hold");
  const accept = late.api.acceptVaultInvite("invite");
  await settleUI();
  late.switchAccount();
  late.releaseResponse();
  await assert.rejects(accept, late.SessionChangedError);
  assert.equal(await late.getMeta("witness_emit_pending:vault"), null);
  const stalled = await fixture();
  stalled.response("hold");
  const request = stalled.api.acceptVaultInvite("invite");
  await stalled.waitForRequest();
  stalled.expire();
  await assert.rejects(request, /timed out/);
  assert.ok(
    await stalled.getMeta("invite_accept_pending:peer"),
    "body timeout retains replayable intent",
  );
  await screenCases();
  await targetedScreenCases();
  const direct = await fixture();
  const directId = "11111111-1111-4111-8111-111111111111";
  const directToken = `v_${directId}`;
  direct.store.prepare("INSERT INTO pending_invitations VALUES(?,NULL,NULL)").run(directToken);
  const preview = await direct.api.fetchInviteInfo(directToken, direct.session());
  assert.equal(preview.vault_name, "Private Shop");
  direct.response("lost");
  await assert.rejects(
    direct.api.declineVaultInviteLocally(directToken, direct.session()),
    /offline/,
  );
  assert.equal(
    (
      direct.store
        .prepare("SELECT declined_at FROM pending_invitations WHERE token=?")
        .get(directToken) as any
    ).declined_at,
    null,
    "failed server decline cannot hide the local invitation",
  );
  direct.response("ok");
  await direct.api.declineVaultInviteLocally(directToken, direct.session());
  assert.ok(
    (
      direct.store
        .prepare("SELECT declined_at FROM pending_invitations WHERE token=?")
        .get(directToken) as any
    ).declined_at,
  );
  assert.deepEqual(
    direct.directCalls.map(({ method, path }) => ({ method, path })),
    ["GET", "DELETE", "DELETE"].map((method) => ({
      method,
      path: `/v1/vaults/invites/requests/${directId}`,
    })),
  );
  assert.ok(direct.directCalls.every((call) => call.session.accountId === "peer"));
  assert.equal(
    direct.calls.length,
    0,
    "direct references never call a public bearer-token endpoint",
  );
  const staleSession = direct.session();
  direct.switchAccount();
  await assert.rejects(
    direct.api.fetchInviteInfo(directToken, staleSession),
    direct.SessionChangedError,
  );
  await assert.rejects(
    direct.api.declineVaultInviteLocally(directToken, staleSession),
    direct.SessionChangedError,
  );
  assert.equal(
    direct.directCalls.length,
    3,
    "stale sessions cannot dispatch direct invitation operations",
  );
  direct.store.close();
  console.log(
    "invite join: membership proof, journal, route reuse and account-targeted regression scenarios passed (real append/signatures/fold + SQLite journal + route reuse)",
  );
}

async function readmissionCases() {
  const token = "v_11111111-1111-4111-8111-111111111111";
  const returned = await fixture();
  const ownerEvent = async (id: string, type: string, payload: any, ack = true) =>
    returned.append(
      {
        event_id: id,
        event_type: type,
        vault_id: "vault",
        target_id: payload.device_id ?? payload.account_id,
        device_id: "owner-device",
        actor_account_id: "owner",
        payload_schema: 1,
        payload,
      },
      ownerSeed,
      ack,
    );
  await ownerEvent("old-member", "vault_member_added", { account_id: "peer", role: "editor" });
  await ownerEvent("old-device", "vault_device_added", {
    account_id: "peer",
    device_id: "peer-device",
    device_pubkey: peerKey,
  });
  await ownerEvent("old-second-device", "vault_device_added", {
    account_id: "peer",
    device_id: "second-device",
    device_pubkey: serverKey,
  });
  await ownerEvent("removal", "vault_member_removed", { account_id: "peer" });
  returned.store
    .prepare("INSERT INTO vault_members_mirror VALUES('vault','peer','editor',1,2,'Ahmad')")
    .run();
  returned.store.exec("UPDATE vaults SET archived_at=123");
  returned.returnResult(true);
  await returned.setMeta("witness_emit_pending:vault", "1");
  await returned.setMeta("vault_materialize_pending", "vault");
  await returned.api.acceptVaultInvite(token, returned.session(), "member_readmission");
  assert.equal(
    await returned.getMeta("witness_emit_pending:vault"),
    "",
    "waiting return cannot schedule witnessed resurrection",
  );
  assert.equal(
    await returned.getMeta("vault_materialize_pending"),
    "",
    "waiting return cannot materialize an ACL",
  );
  const journal = JSON.parse((await returned.getMeta("invite_accept_pending:peer"))!);
  assert.equal(journal[0].kind, "member_readmission");
  assert.deepEqual(journal[0].device, { id: "peer-device", pubkey: peerKey });
  await returned.api.retryPendingVaultMaterialize();
  assert.equal(
    returned.calls.filter((call) => call === "return-register-key").length,
    1,
    "polling never exhausts key registration budget",
  );
  assert.equal(
    returned.calls.filter((call) => call.startsWith("post:")).length,
    1,
    "polling never consumes invitation POST budget",
  );
  assert.equal(returned.calls.filter((call) => call.startsWith("get:")).length, 1);
  assert.equal(
    returned.calls.includes("return-metadata"),
    false,
    "scheduler leaves consent pending without any recovery",
  );
  assert.equal(
    (await returned.proof.getLocalMembershipState("vault")).members.get("peer").removed,
    true,
  );
  const completed = returned.returnResult(false);
  completed.role = "manager";
  delete completed.readmission_pending;
  const resumed = await returned.api.resumePendingVaultInvite(token, returned.session());
  assert.equal(
    resumed.role,
    "manager",
    "completed return allows a later legitimate promotion without changing the original low-role admission",
  );
  assert.equal(
    resumed.readmission_pending,
    false,
    "remount refreshes the durable request instead of returning stale pending result",
  );
  assert.equal(
    await returned.readmission.isMemberReadmissionPublished(completed, returned.session()),
    false,
    "completed HTTP alone grants no local access",
  );
  await ownerEvent("return-member", "vault_member_added", {
    account_id: "peer",
    role: "viewer",
    readmission_invite_id: token.slice(2),
  });
  assert.equal(
    await returned.readmission.isMemberReadmissionPublished(completed, returned.session()),
    false,
    "membership alone cannot revive the removed phone",
  );
  await ownerEvent(
    "return-device",
    "vault_device_added",
    {
      account_id: "peer",
      device_id: "peer-device",
      device_pubkey: peerKey,
      readmission_invite_id: token.slice(2),
    },
    false,
  );
  assert.equal(
    await returned.readmission.isMemberReadmissionPublished(completed, returned.session()),
    false,
    "unpublished pair cannot complete return",
  );
  returned.ack();
  await ownerEvent("later-promotion", "vault_member_role_changed", {
    account_id: "peer",
    role: "manager",
  });
  assert.equal(
    await returned.readmission.isMemberReadmissionPublished(completed, returned.session()),
    true,
  );
  assert.equal(
    (await returned.proof.getLocalMembershipState("vault")).devices.get(serverKey).removed,
    true,
    "other previously removed phones stay removed",
  );
  returned.skipReturnProjection(true);
  assert.equal(
    (await returned.readmission.recoverMemberReadmission(completed, returned.session())).ready,
    false,
    "verified fold cannot finish while projection remains deferred",
  );
  returned.skipReturnProjection(false);
  assert.deepEqual(
    await returned.readmission.recoverMemberReadmission(completed, returned.session()),
    { ready: true, archived: true },
    "existing local archive remains unchanged",
  );
  assert.ok(returned.recoveryPublished);
  await returned.api.retryPendingVaultMaterialize();
  assert.deepEqual(
    JSON.parse((await returned.getMeta("invite_accept_pending:peer"))!),
    [],
    "scheduler completes and clears exactly the finished request",
  );
  await ownerEvent("removed-again", "vault_member_removed", { account_id: "peer" });
  assert.equal(
    await returned.readmission.isMemberReadmissionPublished(completed, returned.session()),
    false,
    "later removal defeats old completed receipt",
  );
  returned.store.close();

  const interrupted = await fixture();
  interrupted.returnResult(true);
  interrupted.response("lost");
  await assert.rejects(
    interrupted.api.acceptVaultInvite(token, interrupted.session(), "member_readmission"),
    /lost response/,
  );
  const saved = JSON.parse((await interrupted.getMeta("invite_accept_pending:peer"))!);
  assert.equal(saved[0].result, null);
  assert.equal(saved[0].device.pubkey, peerKey, "lost consent reply retains exact device identity");
  interrupted.response("ok");
  await interrupted.api.retryPendingVaultMaterialize();
  assert.equal(
    interrupted.calls.filter((call) => call === "return-register-key").length,
    1,
    "lost-response replay reuses the already registered pinned key",
  );
  assert.equal(
    JSON.parse((await interrupted.getMeta("invite_accept_pending:peer"))!)[0].result
      .readmission_pending,
    true,
  );
  interrupted.rotateKey();
  const beforeRotation = interrupted.calls.length;
  await assert.rejects(
    interrupted.api.resumePendingVaultInvite(token, interrupted.session()),
    /another device key/,
  );
  assert.equal(
    interrupted.calls.length,
    beforeRotation,
    "key rotation cannot silently retarget saved consent",
  );
  interrupted.store.close();

  const lateConsent = await fixture();
  lateConsent.returnResult(true);
  lateConsent.response("hold");
  const pendingConsent = lateConsent.api.acceptVaultInvite(
    token,
    lateConsent.session(),
    "member_readmission",
  );
  await lateConsent.waitForRequest();
  lateConsent.switchAccount();
  lateConsent.releaseResponse();
  await assert.rejects(pendingConsent, lateConsent.SessionChangedError);
  assert.equal(
    await lateConsent.getMeta("invite_accept_pending:other"),
    null,
    "late return consent cannot enter a new account journal",
  );
  assert.equal(
    JSON.parse((await lateConsent.getMeta("invite_accept_pending:peer"))!)[0].result,
    null,
    "original uncertain consent stays recoverable",
  );
  lateConsent.store.close();
}

async function screenCases() {
  for (const mode of ["pending", "late-success", "late-error"]) {
    const hooks = uiHooks();
    let token = "A",
      published = false;
    const posts: string[] = [],
      toasts: string[] = [],
      navigations: string[] = [];
    const warnings: unknown[][] = [];
    class JoinProofPendingError extends Error {}
    const gate = deferred<any>();
    const router = { replace: (path: string) => navigations.push(path) };
    const toast = { push: (label: string) => toasts.push(label) };
    const session = { accountId: "peer", jwt: "jwt", bindingVersion: 0 };
    const result = (id: string) => ({ vault_id: id, vault_name: `Kaata ${id}`, role: "viewer" });
    let poll: (() => void) | undefined;
    const colors = new Proxy({}, { get: () => "black" });
    const screen = compileUI(
      "../../app/invite/[token]",
      {
        react: sessionReact(hooks),
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "expo-router": {
          useIsFocused: () => true,
          useRouter: () => router,
          useLocalSearchParams: () => ({ token }),
        },
        "react-native": {
          AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
          ActivityIndicator: "Spinner",
          Text: "Text",
          View: "View",
          StyleSheet: { create: (v: any) => v },
        },
        "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
        "../../components/Button": { Button: "Button" },
        "../../components/SettingsScreen": { ScreenHeader: "Header" },
        "../../components/Toast": { useToast: () => toast },
        "../../lib/auth": {
          getSessionJWT: async () => "jwt",
          captureCurrentSession: async () => session,
          applyForCurrentSession: async (_: any, work: any) => work(),
          SessionChangedError: class extends Error {},
        },
        "../../lib/checkin-trigger": { requestImmediateCheckIn: () => {} },
        "../../lib/colors": { colors },
        "../../lib/db-tx": {
          setActiveVaultId: async () => {},
          getSessionAccountIdSync: () => session.accountId,
          onAccountIdentityChanged: () => () => {},
        },
        "../../lib/db": {
          getLocalSelf: async () => ({ name: "Ahmad" }),
          setAppMeta: async () => {},
        },
        "../../lib/direction": { textDir: () => ({}), useIsRTL: () => false },
        "../../lib/fonts": { fonts: {} },
        "../../lib/i18n": { t: (key: string) => key },
        "../../lib/tokens": { gutter: 16, icon: { hero: 40 }, typography: {} },
        "../../lib/trust/backfill": {
          JoinAdmissionBlockedError: class extends Error {},
          JoinProofPendingError,
          isSelfAdmissionPublished: async () => published,
          witnessEmitPendingKey: (id: string) => id,
          emitWitnessedSelfAdmission: async () => {
            if (published) return;
            if (mode === "late-error") throw new Error("unexpected witness error");
            throw new JoinProofPendingError("still pending");
          },
        },
        "../../lib/recovery": {
          seedJoinedVaultMinimal: async () => {},
          recoverJoinedVault: async () => true,
        },
        "../../lib/tabs/sync": { syncAllTabs: async () => {} },
        "../../lib/vault-api": {
          ApiError: class extends Error {},
          retryPendingVaultMaterialize: async () => {},
          resumePendingVaultInvite: async () => null,
          lookupPendingInvite: async () => null,
          fetchInviteInfo: async (id: string) => ({
            vault_name: `Kaata ${id}`,
            role: "viewer",
            expires_at: Date.now() + 100000,
          }),
          acceptVaultInvite: async (id: string) => {
            posts.push(id);
            return id === "A" && mode !== "pending" ? gate.promise : result(id);
          },
          clearPendingVaultInvite: async () => {},
          clearVaultMaterializePending: async () => {},
        },
      },
      {
        console: { warn: (...args: unknown[]) => warnings.push(args) },
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: (fn: () => void) => {
          poll = fn;
          return 2;
        },
        clearInterval: () => {
          poll = undefined;
        },
      },
    ).default;
    const flush = async () => {
      for (let i = 0; i < 5; i++) {
        await settleUI();
        hooks.render(screen);
      }
    };
    hooks.render(screen);
    await flush();
    const press = () => {
      const button = nodes(hooks.tree).find(
        (n) => n.type === "Button" && n.props.label === "inviteAccept.confirm.accept",
      );
      assert.ok(button, `${mode}: expected confirmation for ${token}`);
      return button.props.onPress();
    };
    const a = press();
    if (mode === "pending") {
      await a;
      await flush();
    }
    token = "B";
    hooks.render(screen);
    await flush();
    if (mode === "late-success") gate.resolve(result("A"));
    if (mode === "late-error") gate.reject(Error("old A request failed"));
    await a;
    await flush();
    await press();
    await flush();
    assert.deepEqual(
      posts,
      ["A", "B"],
      `${mode}: a fresh link cannot reuse the old accepted result`,
    );
    assert.equal(toasts.length, 0, "unfinished proof never shows joined success");
    assert.ok(nodes(hooks.tree).some((n) => n.props.children === "inviteAccept.pending.title"));
    assert.equal(warnings.length, mode === "late-error" ? 1 : 0, "only unexpected failures warn");
    published = true;
    assert.ok(poll);
    poll();
    await flush();
    assert.equal(
      toasts.length,
      1,
      "local server acknowledgement completes without another network retry",
    );
    assert.deepEqual(navigations, ["/"]);
    hooks.unmount();
  }
}
function sessionReact(hooks: ReturnType<typeof uiHooks>) {
  return {
    ...hooks.react,
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      const [, update] = hooks.react.useState(getSnapshot);
      hooks.react.useEffect(() => subscribe(() => update(getSnapshot())), [subscribe, getSnapshot]);
      return getSnapshot();
    },
  };
}

async function targetedScreenFixture() {
  const hooks = uiHooks();
  const token = "v_11111111-1111-4111-8111-111111111111";
  let account: string | null = "A",
    bindingVersion = 0,
    localLookups = 0;
  let focused = true,
    foregroundListener: ((state: string) => void) | undefined;
  let returnResponse: any,
    returnReady = false,
    returnArchived = false,
    returnRecoveryCalls = 0;
  let returnTimer: (() => void) | undefined;
  const appState = {
    currentState: "active",
    addEventListener: (_: string, listener: (state: string) => void) => {
      foregroundListener = listener;
      return {
        remove: () => {
          foregroundListener = undefined;
        },
      };
    },
  };
  const listeners = new Set<() => void>();
  const previews: { session: any; reply: ReturnType<typeof deferred<any>> }[] = [];
  const posts: any[] = [],
    declines: any[] = [],
    seeds: string[] = [],
    navigations: string[] = [],
    toasts: string[] = [];
  const acceptReply = deferred<any>(),
    declineReply = deferred<void>();
  class SessionChangedError extends Error {}
  const session = () => ({
    accountId: account,
    jwt: account ? `jwt-${account}-${bindingVersion}` : null,
    bindingVersion,
  });
  const guard = async (before: any, work: any) => {
    if (before.accountId !== account || before.bindingVersion !== bindingVersion)
      throw new SessionChangedError();
    return work();
  };
  const router = { replace: (path: string) => navigations.push(path) };
  const toast = { push: (text: string) => toasts.push(text) };
  const screen = compileUI(
    "../../app/invite/[token]",
    {
      react: sessionReact(hooks),
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "expo-router": {
        useIsFocused: () => focused,
        useRouter: () => router,
        useLocalSearchParams: () => ({ token }),
      },
      "react-native": {
        AppState: appState,
        ActivityIndicator: "Spinner",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (v: any) => v },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../../components/Button": { Button: "Button" },
      "../../components/SettingsScreen": { ScreenHeader: "Header" },
      "../../components/Toast": { useToast: () => toast },
      "../../lib/auth": {
        captureCurrentSession: async () => session(),
        applyForCurrentSession: guard,
        applyForUnchangedLocalSession: guard,
        SessionChangedError,
      },
      "../../lib/db-tx": {
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        setActiveVaultId: async (id: string) => seeds.push(`switch:${id}`),
      },
      "../../lib/db": { getLocalSelf: async () => ({}), setAppMeta: async () => {} },
      "../../lib/checkin-trigger": { requestImmediateCheckIn: () => {} },
      "../../lib/colors": { colors: {} },
      "../../lib/direction": { textDir: () => ({}), useIsRTL: () => false },
      "../../lib/fonts": { fonts: {} },
      "../../lib/i18n": { t: (key: string, params?: any) => params?.name ?? key },
      "../../lib/tokens": { gutter: 16, icon: { hero: 40 }, typography: {} },
      "../../lib/trust/backfill": {
        JoinAdmissionBlockedError: class extends Error {},
        JoinProofPendingError: class extends Error {},
        isSelfAdmissionPublished: async () => false,
        witnessEmitPendingKey: (id: string) => id,
        emitWitnessedSelfAdmission: async () => {},
      },
      "../../lib/recovery": {
        seedJoinedVaultMinimal: async (id: string) => seeds.push(`${account}:${id}`),
        recoverJoinedVault: async () => true,
      },
      "../../lib/tabs/sync": { syncAllTabs: async () => {} },
      "../../lib/member-readmission-guest": {
        recoverMemberReadmission: async (_: any, before: any) => {
          await guard(before, async () => {});
          returnRecoveryCalls++;
          return { ready: returnReady, archived: returnArchived };
        },
      },
      "../../lib/vault-api": {
        ApiError: class extends Error {},
        retryPendingVaultMaterialize: async () => {},
        resumePendingVaultInvite: async () => null,
        lookupPendingInvite: async () => {
          localLookups++;
          return {
            vault_name: "Untrusted cached card",
            role: "owner",
            expires_at: Date.now() + 100000,
          };
        },
        fetchInviteInfo: async (value: string, before: any) => {
          assert.equal(value, token);
          assert.ok(before, "private preview receives its captured session");
          const reply = deferred<any>();
          previews.push({ session: before, reply });
          return reply.promise;
        },
        acceptVaultInvite: async (_: string, before: any, kind: any) => {
          posts.push({ ...before, kind });
          return returnResponse ?? acceptReply.promise;
        },
        declineVaultInviteLocally: async (value: string, before: any) => {
          assert.equal(value, token);
          declines.push(before);
          return declineReply.promise;
        },
        clearPendingVaultInvite: async () => {},
        clearVaultMaterializePending: async () => {},
      },
    },
    {
      setTimeout: (fn: () => void, delay: number) => {
        if (delay === 15000) returnTimer = fn;
        return 1;
      },
      clearTimeout: () => {
        returnTimer = undefined;
      },
      setInterval: () => 2,
      clearInterval: () => {},
    },
  ).default;
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      hooks.render(screen);
    }
  };
  const button = (label: string) =>
    nodes(hooks.tree).find((node) => node.type === "Button" && node.props.label === label);
  const switchAccount = (next: string | null, notify = true) => {
    account = next;
    bindingVersion++;
    if (notify) listeners.forEach((listener) => listener());
  };
  const preview = (name: string) => ({
    vault_name: name,
    role: "viewer",
    inviter_name: "Owner",
    inviter_email_redacted: null,
    expires_at: Date.now() + 100000,
  });
  hooks.render(screen);
  await flush();
  return {
    hooks,
    screen,
    flush,
    button,
    switchAccount,
    previews,
    preview,
    posts,
    declines,
    acceptReply,
    declineReply,
    seeds,
    navigations,
    toasts,
    localLookups: () => localLookups,
    returnResponse: (pending: boolean) => {
      returnResponse = {
        vault_id: "A-vault",
        vault_name: "A Kaata",
        role: "viewer",
        member_readmission: true,
        readmission_pending: pending,
      };
    },
    returnReady: (archived = false) => {
      returnReady = true;
      returnArchived = archived;
    },
    returnRecoveryCalls: () => returnRecoveryCalls,
    returnTimer: () => returnTimer,
    focus: (value: boolean) => {
      focused = value;
    },
    foreground: (value: boolean) => {
      appState.currentState = value ? "active" : "background";
      foregroundListener?.(appState.currentState);
    },
  };
}

async function targetedScreenCases() {
  const returning = await targetedScreenFixture();
  returning.previews[0].reply.resolve({
    ...returning.preview("A Kaata"),
    kind: "member_readmission",
  });
  await returning.flush();
  returning.returnResponse(true);
  const acceptReturn = returning.button("inviteAccept.readmission.accept")!.props.onPress;
  await Promise.all([acceptReturn(), acceptReturn()]);
  await returning.flush();
  assert.equal(returning.posts.length, 1);
  assert.equal(returning.posts[0].kind, "member_readmission");
  assert.deepEqual(returning.seeds, [], "pending return cannot seed or switch book");
  assert.equal(returning.returnRecoveryCalls(), 0);
  assert.equal(returning.toasts.length, 0);
  assert.ok(
    nodes(returning.hooks.tree).some(
      (node) => node.props.children === "inviteAccept.readmission.waitingTitle",
    ),
  );
  const oldTimer = returning.returnTimer();
  returning.foreground(false);
  oldTimer?.();
  await returning.flush();
  assert.equal(returning.posts.length, 1, "background timer cannot repeat consent");
  returning.foreground(true);
  await returning.flush();
  returning.previews
    .at(-1)!
    .reply.resolve({ ...returning.preview("A Kaata"), kind: "member_readmission" });
  await returning.flush();
  returning.returnResponse(false);
  await returning.button("inviteAccept.readmission.accept")!.props.onPress();
  await returning.flush();
  assert.deepEqual(
    returning.navigations,
    [],
    "completed response without verified proof still waits",
  );
  returning.returnReady(true);
  await returning.button("common.retry")!.props.onPress();
  await returning.flush();
  assert.deepEqual(
    returning.seeds,
    [],
    "a user-archived returned book is never selected or unarchived",
  );
  assert.deepEqual(returning.navigations, ["/"]);
  assert.equal(returning.toasts.length, 1);
  returning.hooks.unmount();

  const lateReturn = await targetedScreenFixture();
  lateReturn.previews[0].reply.resolve({
    ...lateReturn.preview("A Kaata"),
    kind: "member_readmission",
  });
  await lateReturn.flush();
  const lateAction = lateReturn.button("inviteAccept.readmission.accept")!.props.onPress();
  await settleUI();
  lateReturn.focus(false);
  await lateReturn.flush();
  lateReturn.acceptReply.resolve({
    member_readmission: true,
    readmission_pending: false,
    vault_id: "A-vault",
    vault_name: "A Kaata",
    role: "viewer",
  });
  await lateAction;
  assert.equal(
    lateReturn.returnRecoveryCalls(),
    0,
    "covered route cannot recover or navigate on a late consent reply",
  );
  assert.deepEqual(lateReturn.navigations, []);
  lateReturn.hooks.unmount();

  const late = await targetedScreenFixture();
  assert.equal(late.localLookups(), 0, "direct invitation cannot use an old share-link cache");
  late.switchAccount("B");
  await late.flush();
  late.previews[0].reply.resolve(late.preview("Private A Kaata"));
  await late.flush();
  assert.ok(!late.button("inviteAccept.confirm.accept"), "late A preview is not actionable for B");
  assert.ok(!nodes(late.hooks.tree).some((node) => node.props.children === "Private A Kaata"));
  late.previews[1].reply.resolve(null);
  await late.flush();
  assert.ok(!late.button("inviteAccept.confirm.accept"));
  late.hooks.unmount();

  const stale = await targetedScreenFixture();
  stale.previews[0].reply.resolve(stale.preview("A Kaata"));
  await stale.flush();
  const oldAccept = stale.button("inviteAccept.confirm.accept")!.props.onPress;
  const oldDecline = stale.button("inviteAccept.confirm.decline")!.props.onPress;
  // Dispatch a stale press before React has painted the account change.
  stale.switchAccount("B");
  await oldAccept();
  await oldDecline();
  assert.equal(stale.posts.length + stale.declines.length, 0);
  await stale.flush();
  assert.ok(!nodes(stale.hooks.tree).some((node) => node.props.children === "A Kaata"));
  stale.hooks.unmount();

  const batched = await targetedScreenFixture();
  batched.previews[0].reply.resolve(batched.preview("Old A Kaata"));
  await batched.flush();
  const old = batched.button("inviteAccept.confirm.accept")!.props.onPress;
  batched.switchAccount(null);
  batched.switchAccount("A");
  await old();
  await batched.flush();
  assert.equal(
    batched.posts.length,
    0,
    "A-to-signed-out-to-A invalidates the old session even in one frame",
  );
  assert.equal(batched.previews.length, 2);
  batched.hooks.unmount();

  const changedSession = await targetedScreenFixture();
  changedSession.previews[0].reply.resolve(changedSession.preview("A Kaata"));
  await changedSession.flush();
  changedSession.switchAccount("A", false);
  await changedSession.button("inviteAccept.confirm.accept")!.props.onPress();
  await changedSession.flush();
  assert.equal(
    changedSession.posts.length,
    0,
    "same account reauthentication cannot reuse an old preview session",
  );
  assert.equal(changedSession.previews.length, 2, "a new session must reauthorize the preview");
  changedSession.hooks.unmount();

  const accepting = await targetedScreenFixture();
  accepting.previews[0].reply.resolve(accepting.preview("A Kaata"));
  await accepting.flush();
  const action = accepting.button("inviteAccept.confirm.accept")!.props.onPress;
  const first = action();
  const second = action();
  await settleUI();
  assert.equal(accepting.posts.length, 1, "same-frame duplicate acceptance is blocked");
  accepting.switchAccount("B");
  await accepting.flush();
  accepting.acceptReply.resolve({ vault_id: "A-vault", vault_name: "A Kaata", role: "viewer" });
  await Promise.all([first, second]);
  await accepting.flush();
  assert.deepEqual(accepting.seeds, [], "late A acceptance cannot materialize into B");
  assert.deepEqual(accepting.navigations, []);
  assert.deepEqual(accepting.toasts, []);
  accepting.hooks.unmount();

  for (const failure of [false, true]) {
    const declining = await targetedScreenFixture();
    declining.previews[0].reply.resolve(declining.preview("A Kaata"));
    await declining.flush();
    const decline = declining.button("inviteAccept.confirm.decline")!.props.onPress;
    const first = decline(),
      duplicate = decline();
    await settleUI();
    assert.equal(declining.declines.length, 1);
    assert.equal(declining.declines[0].accountId, "A");
    assert.deepEqual(
      declining.navigations,
      [],
      "do not hide the invitation before server decline succeeds",
    );
    if (failure) declining.declineReply.reject(Error("offline"));
    else declining.declineReply.resolve();
    await Promise.all([first, duplicate]);
    await declining.flush();
    assert.deepEqual(declining.navigations, failure ? [] : ["/"]);
    assert.deepEqual(declining.toasts, failure ? ["inbox.failed"] : []);
    if (failure)
      assert.ok(declining.button("inviteAccept.confirm.decline"), "failed decline stays retryable");
    declining.hooks.unmount();
  }
  const leaving = await targetedScreenFixture();
  leaving.switchAccount(null);
  await leaving.flush();
  const signingIn = leaving.button("inviteAccept.signin.cta")!.props.onPress();
  leaving.hooks.unmount();
  await signingIn;
  leaving.previews[0].reply.resolve(leaving.preview("Old private card"));
  await settleUI();
  assert.deepEqual(leaving.navigations, [], "an unmounted sign-in action cannot navigate later");
  assert.equal(
    leaving.hooks.lateWrites,
    0,
    "an unmounted route never paints the old private preview",
  );
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
