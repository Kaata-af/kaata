import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import type { LedgerEvent } from "../events";
import { memberWitnessTuple } from "../trust/chain";
import { compileUI } from "./ui-fixture";

const OWNER = "owner";
const VAULT = "vault";
const DEVICE = "owner-device";
const GENESIS_MS = 1000;
const DEV_ORIGIN = "http://192.168.1.40:8080";
const noop = async () => {};
const signature = compileUI("../event-sig", {
  "expo-crypto": { getRandomBytes: randomBytes },
  "@noble/ed25519": ed,
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
}) as typeof import("../event-sig");
const seed = new Uint8Array(32).fill(18);
const anchor = Buffer.from(ed.getPublicKey(seed)).toString("base64");

function signed(event: LedgerEvent, signer = seed): LedgerEvent {
  return {
    ...event,
    signer_device_pubkey: Buffer.from(ed.getPublicKey(signer)).toString("base64"),
    event_sig_b64: Buffer.from(ed.sign(signature.canonicalizeEvent(event), signer)).toString(
      "base64",
    ),
  };
}

function fixture(interrupted = true, account = OWNER, devWitnessKey?: string) {
  const sql = new Database(":memory:");
  sql.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,PRIMARY KEY(vault_id,account_id));
    CREATE TABLE vault_device_registry(vault_id TEXT,device_pubkey TEXT,device_id TEXT,account_id TEXT,added_at_ms INTEGER,removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT,PRIMARY KEY(vault_id,device_pubkey));
    CREATE TABLE vault_credentials(vault_id TEXT,device_id TEXT,account_id TEXT,device_pubkey TEXT);
    CREATE TABLE revocation_list(vault_id TEXT,device_id TEXT,lifted_at INTEGER);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,device_id TEXT,author_user_id_local_only TEXT,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,appended_at INTEGER,server_acked_at INTEGER,rejected_at INTEGER,origin TEXT,event_sig_b64 TEXT,signer_device_pubkey TEXT,ingested_at INTEGER,applied_at INTEGER,quarantine_reason TEXT,tombstone_reason TEXT);
    CREATE TABLE applied_contacts(id TEXT PRIMARY KEY);
  `);
  sql.prepare("INSERT INTO vaults VALUES(?,?)").run(VAULT, anchor);
  if (interrupted) {
    sql
      .prepare("INSERT INTO vault_members_mirror VALUES(?,?,'owner',?,NULL,NULL)")
      .run(VAULT, account, GENESIS_MS);
    sql
      .prepare("INSERT INTO vault_device_registry VALUES(?,?,?,?,?,NULL,NULL,NULL)")
      .run(VAULT, anchor, DEVICE, account, GENESIS_MS);
  }
  const db = {
    getFirstAsync: async (query: string, ...args: unknown[]) =>
      sql.prepare(query).get(...args) ?? null,
    getAllAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).all(...args),
    runAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      sql.exec("BEGIN");
      try {
        await work();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const base = {
    event_id: "owner-genesis",
    vault_id: VAULT,
    target_id: account,
    relationship_id: null,
    device_id: DEVICE,
    author_user_id_local_only: "",
    actor_account_id: account.startsWith("local:") ? null : account,
    hlc: { pms: GENESIS_MS, l: 0, did: DEVICE },
    payload_schema: 1,
    appended_at: GENESIS_MS,
    server_acked_at: GENESIS_MS,
    rejected_at: null,
    origin: "remote" as const,
  };
  const genesis = signed({
    ...base,
    event_type: "vault_member_added",
    payload: { account_id: account, role: "owner" },
  });
  const insert = (event: LedgerEvent) => {
    sql
      .prepare(
        `INSERT INTO event_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'unknown_actor',NULL)`,
      )
      .run(
        event.event_id,
        event.event_type,
        event.vault_id,
        event.target_id,
        event.relationship_id,
        event.hlc.pms,
        event.hlc.l,
        event.hlc.did,
        event.device_id,
        event.author_user_id_local_only,
        event.actor_account_id,
        JSON.stringify(event.payload),
        event.payload_schema,
        event.appended_at,
        event.server_acked_at,
        event.rejected_at,
        event.origin,
        event.event_sig_b64,
        event.signer_device_pubkey,
        event.appended_at,
      );
  };
  insert(genesis);
  const hlc = require("../hlc");
  const events = require("../events");
  const mutex = require("../util/mutex");
  const dbModule = {
    getDb: async () => db,
    getAccountIdSync: () => "viewer",
    getAppMetaInTx: async (_tx: unknown, key: string) =>
      (
        sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as
          | { value: string }
          | undefined
      )?.value ?? null,
  };
  const devWitness = compileUI(
    "../trust/dev-witness-key",
    {},
    {
      __DEV__: !!devWitnessKey,
      process: {
        env: {
          EXPO_PUBLIC_DEV_WITNESS_ORIGIN: DEV_ORIGIN,
          EXPO_PUBLIC_DEV_WITNESS_PUBKEY: devWitnessKey,
          EXPO_PUBLIC_BACKEND_URL: DEV_ORIGIN,
        },
      },
    },
  );
  const gate = compileUI("../projection/role-gate", {
    "../db-tx": dbModule,
    "../effective-account": {},
    "../event-sig": signature,
    "../events": events,
    "../hlc": hlc,
    "../tally-note-policy": {},
    "../trust/chain": require("../trust/chain"),
    "../trust/crypto-runtime": {
      runtimeChainCrypto: {
        verifyRaw: signature.verifyRawSignature,
        canonicalize: signature.canonicalize,
      },
    },
    "../trust/dev-witness-key": devWitness,
    "../trust/ownership-transfer": require("../trust/ownership-transfer"),
  });
  const members = compileUI("../projection/vault_members", {
    "../hlc": hlc,
    "../use-vault-role": { invalidateVaultRoleCache: () => {} },
  });
  const replay = compileUI("../projection/replay", {
    "../db": dbModule,
    "../events": events,
    "./role-gate": gate,
    "./errors": require("../projection/errors"),
    "../credit-admission": {
      captureCreditMutationBaseline: noop,
      requiresCreditAdmission: async () => false,
    },
    "./index": {
      applyEventMutex: new mutex.Mutex(),
      APPLIERS: {
        vault_member_added: members.applyVaultMemberAdded,
        person_added: (database: typeof db, event: LedgerEvent) =>
          database.runAsync("INSERT INTO applied_contacts VALUES(?)", event.target_id),
      },
    },
  });
  const sweep = compileUI("../projection/sweep", {
    "../util/mutex": mutex,
    "../db": dbModule,
    "./replay": replay,
    "../ledger-events": { emitLedgerApplied: () => {} },
  });
  const applied = () =>
    sql.prepare("SELECT COUNT(*) n FROM event_log WHERE applied_at IS NOT NULL").get();
  return { sql, db, gate, genesis, insert, applied, replay, sweep };
}

async function main() {
  for (const account of [OWNER, "local:pre-signin"]) {
    const f = fixture(true, account);
    const person = signed({
      ...f.genesis,
      event_type: "person_added",
      event_id: "owner-contact",
      target_id: "person",
      relationship_id: "relationship",
      hlc: { pms: GENESIS_MS + 1, l: 0, did: DEVICE },
      payload: {
        user_id: "person",
        name: "Contact",
        phone_e164: null,
        relationship_context: "peer",
      },
    });
    f.insert(person);
    await f.sweep.sweepVaultNow(VAULT);
    assert.deepEqual(f.applied(), { n: 2 }, "interrupted genesis unblocks owner ledger events");
    assert.deepEqual(f.sql.prepare("SELECT id FROM applied_contacts").all(), [{ id: "person" }]);
    f.sql.close();
  }

  {
    const f = fixture();
    const later = signed({
      ...f.genesis,
      event_id: "later-owner-add",
      hlc: { ...f.genesis.hlc, l: 1 },
    });
    f.insert(later);
    assert.equal(
      (await f.gate.checkRoleForEvent(f.db, later)).ok,
      false,
      "a later admission cannot bootstrap",
    );
    assert.equal(
      (
        await f.gate.checkRoleForEvent(f.db, {
          ...f.genesis,
          event_sig_b64: Buffer.alloc(64).toString("base64"),
        })
      ).reason,
      "bad_signature",
    );
    f.sql.exec("UPDATE vault_device_registry SET device_id='different-device'");
    assert.equal(
      (await f.gate.checkRoleForEvent(f.db, f.genesis)).ok,
      false,
      "the existing device must match",
    );
    f.sql.exec("UPDATE vault_device_registry SET device_id='owner-device', removed_at_ms=1100");
    assert.equal(
      (await f.gate.checkRoleForEvent(f.db, f.genesis)).ok,
      false,
      "a removed anchor cannot bootstrap",
    );
    f.sql.exec(
      "UPDATE vault_device_registry SET removed_at_ms=NULL; UPDATE vault_members_mirror SET role='editor'",
    );
    assert.equal(
      (await f.gate.checkRoleForEvent(f.db, f.genesis)).ok,
      false,
      "a demoted member cannot bootstrap",
    );
    f.sql.exec("UPDATE vault_members_mirror SET role='owner'");
    f.sql
      .prepare(
        `UPDATE event_log SET event_type='vault_member_role_changed', applied_at=1100,
      quarantine_reason=NULL, payload_json=? WHERE event_id=?`,
      )
      .run(JSON.stringify({ account_id: OWNER, role: "editor" }), later.event_id);
    assert.equal(
      (await f.gate.checkRoleForEvent(f.db, f.genesis)).ok,
      false,
      "an already-applied role change wins even if the mirror is stale",
    );
    f.sql.close();
  }

  {
    const f = fixture(false);
    f.sql.exec(`CREATE TRIGGER fail_marker BEFORE UPDATE OF applied_at ON event_log
      WHEN NEW.applied_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture apply marker failure'); END;`);
    assert.deepEqual(await f.replay.applyAlreadyIngestedEvent(f.genesis), {
      kind: "quarantined",
      reason: "applier_throw",
    });
    assert.deepEqual(f.sql.prepare("SELECT COUNT(*) n FROM vault_device_registry").get(), { n: 0 });
    assert.deepEqual(f.sql.prepare("SELECT COUNT(*) n FROM vault_members_mirror").get(), { n: 0 });
    assert.deepEqual(f.applied(), { n: 0 }, "a failed marker rolls back the projection");
    f.sql.exec("DROP TRIGGER fail_marker");
    await f.sweep.sweepVaultNow(VAULT);
    assert.deepEqual(f.applied(), { n: 1 });
    f.sql.close();
  }

  {
    const serverSeed = new Uint8Array(32).fill(27);
    const serverKey = Buffer.from(ed.getPublicKey(serverSeed)).toString("base64");
    const f = fixture(false, OWNER, serverKey);
    const guest = "guest";
    const guestDevice = "guest-device";
    const issuedAt = GENESIS_MS + 10;
    const tuple = memberWitnessTuple({
      vault_id: VAULT,
      account_id: guest,
      inviter_account_id: OWNER,
      role: "viewer",
      issued_at_ms: issuedAt,
    });
    const witnessed = signed(
      {
        ...f.genesis,
        event_type: "vault_member_added",
        event_id: "guest-admission",
        target_id: guest,
        actor_account_id: guest,
        device_id: guestDevice,
        hlc: { pms: issuedAt + 1, l: 0, did: guestDevice },
        payload: {
          account_id: guest,
          role: "viewer",
          witness: {
            inviter_account_id: OWNER,
            issued_at_ms: issuedAt,
            server_key_id: "dev-key",
            sig_b64: Buffer.from(
              ed.sign(new TextEncoder().encode(signature.canonicalize(tuple)), serverSeed),
            ).toString("base64"),
          },
        },
      },
      new Uint8Array(32).fill(26),
    );
    const meta = f.sql.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)");
    meta.run("mesh_server_pubkey_primary", anchor);
    meta.run("backend_url_override", "https://api.kaata.af");
    f.insert(witnessed);
    await f.sweep.sweepVaultNow(VAULT);
    assert.deepEqual(f.applied(), { n: 1 }, "a different origin cannot trust the dev witness");
    assert.equal(
      f.sql.prepare("SELECT 1 FROM vault_members_mirror WHERE account_id=?").get(guest),
      undefined,
    );

    meta.run("backend_url_override", DEV_ORIGIN);
    await f.sweep.sweepVaultNow(VAULT);
    assert.deepEqual(f.applied(), { n: 2 }, "the correct origin replays the accepted guest proof");
    assert.deepEqual(
      f.sql.prepare("SELECT role FROM vault_members_mirror WHERE account_id=?").get(guest),
      { role: "viewer" },
    );
    assert.deepEqual(
      f.sql.prepare("SELECT value FROM app_meta WHERE key='mesh_server_pubkey_primary'").get(),
      { value: anchor },
    );
    f.sql.close();
  }
  console.log(
    "PASS invite projection: interrupted genesis, atomic replay, and exact-origin dev witness",
  );
}

void main();
