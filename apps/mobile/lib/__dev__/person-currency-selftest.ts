// Real in-memory SQLite, Ed25519 signatures, role gate and projection only.
// No phone, network, production database, or native key storage is accessed.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import * as ed from "@noble/ed25519";
import type { LedgerEvent, VaultRole } from "../events";
import type { SQLiteTx } from "../db-tx";
import { compileUI, deferred } from "./ui-fixture";

function declaration(file: string, name: string) {
  const source = readFileSync(require.resolve(file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find(
    (node) =>
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name,
  );
  assert.ok(node, `actual ${name}`);
  return node.getText(ast);
}
function compile(source: string, required: (name: string) => any) {
  const result: any = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(required, result);
  return result;
}
function load(file: string, required: (name: string) => any) {
  return compile(readFileSync(require.resolve(file), "utf8"), required);
}

async function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,phone_e164 TEXT,display_name TEXT,is_local_self INTEGER,google_sub TEXT,account_id TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,field_hlcs TEXT);
    INSERT INTO users VALUES('self',NULL,'Owner',1,NULL,NULL,1,1,NULL,NULL),('person',NULL,'Customer',0,NULL,NULL,1,1,NULL,NULL);
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,is_default INTEGER,account_id TEXT,registered_with_server_at INTEGER,vault_epoch INTEGER,hlc_logical INTEGER,hlc_wall_ms INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_settings(vault_id TEXT,key TEXT,value TEXT,hlc_pms INTEGER,hlc_l INTEGER,hlc_did TEXT,updated_at INTEGER,PRIMARY KEY(vault_id,key));
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_a_id TEXT,user_b_id TEXT,context TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,field_hlcs TEXT,default_entry_currency TEXT,group_id TEXT,group_ids TEXT);
    CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn REAL,note TEXT,currency TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER,proposed_by_user_id TEXT,current_event_id TEXT,is_deleted INTEGER,is_settled INTEGER,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER,field_hlcs TEXT);
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,PRIMARY KEY(vault_id,account_id));
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,device_id TEXT,author_user_id_local_only TEXT NOT NULL,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,appended_at INTEGER,server_acked_at INTEGER,rejected_at INTEGER,origin TEXT,event_sig_b64 TEXT,signer_device_pubkey TEXT,ingested_at INTEGER,applied_at INTEGER,author_seq INTEGER,quarantine_reason TEXT,tombstone_reason TEXT);
    CREATE UNIQUE INDEX author_slot ON event_log(vault_id,device_id,author_seq);
    CREATE TABLE projection_conflicts(id INTEGER PRIMARY KEY,kind TEXT,vault_id TEXT,detail_json TEXT,created_at INTEGER);
    CREATE TABLE vault_device_registry(vault_id TEXT,device_pubkey TEXT,device_id TEXT,account_id TEXT,added_at_ms INTEGER,removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT);
    CREATE TABLE vault_credentials(vault_id TEXT,device_id TEXT,account_id TEXT,device_pubkey TEXT);
    CREATE TABLE revocation_list(vault_id TEXT,device_id TEXT,lifted_at INTEGER);`);
  let account: string | null = null;
  let active = "v1";
  let token: string | null = "token";
  let queryPause: ReturnType<typeof deferred<void>> | null = null;
  let queryEntered: (() => void) | null = null;
  let afterSigner: (() => void) | null = null;
  let signatures = 0;
  let failSignature: number | null = null;
  let notifications = 0;
  const tx = {
    execAsync: async (query: string) => sql.exec(query),
    getFirstAsync: async (query: string, ...args: unknown[]) => {
      if (queryPause && query.includes("user_b_id=?")) {
        queryEntered?.();
        await queryPause.promise;
      }
      return sql.prepare(query).get(...args) ?? null;
    },
    getAllAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).all(...args),
    runAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      assert.equal(sql.inTransaction, false, "atomic contact edit does not nest transactions");
      sql.exec("BEGIN");
      try {
        await work();
        sql.exec("COMMIT");
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as SQLiteTx;
  const dbTx = {
    getDb: async () => tx,
    getInstallIdSync: () => "device",
    getAccountIdSync: () => account,
    getActiveVaultIdSyncMaybe: () => active,
    getActiveVaultIdSync: () => active,
    getLocalSelfUserIdSync: () => "self",
    getAppMetaInTx: async (_: unknown, key: string) =>
      (sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as any)?.value ?? null,
    setAppMetaInTx: async (_: unknown, key: string, value: string) =>
      sql.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(key, value),
  };
  const auth = compile(
    `const {SecureStore,getAccountIdSync,setAccount,setJwt}=require('fixture-auth');
    let sessionBindingVersion=0;let sessionMutationTail=Promise.resolve();
    ${declaration("../auth", "mutateLocalSession")}
    const SESSION_CLAIMS=['account_id','install_id','provider','provider_sub','ep'];
    ${declaration("../auth", "decodeIdTokenClaims")}
    ${declaration("../auth", "sameSessionToken")}
    export ${declaration("../auth", "SessionChangedError")}
    export ${declaration("../auth", "captureCurrentSession")}
    export ${declaration("../auth", "applyForUnchangedLocalSession")}
    const SESSION_KEY='fixture';
    export function switchSession(next:string|null,jwt:string|null){return mutateLocalSession(async()=>{
      sessionBindingVersion++;setAccount(next);setJwt(jwt);
    });}`,
    () => ({
      SecureStore: { getItemAsync: async () => token },
      getAccountIdSync: () => account,
      setAccount: (value: string | null) => {
        account = value;
      },
      setJwt: (value: string | null) => {
        token = value;
      },
    }),
  );
  const crypto = { randomUUID, getRandomBytes: randomBytes };
  const signature = compileUI("../event-sig", {
    "expo-crypto": crypto,
    "@noble/ed25519": ed,
    "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  });
  const secret = new Uint8Array(32).fill(31);
  const pubkey = Buffer.from(ed.getPublicKey(secret)).toString("base64");
  const device = {
    DeviceKeyUnavailableError: class extends Error {},
    getDeviceSigner: async () => {
      assert.equal(sql.inTransaction, false);
      afterSigner?.();
      return {
        pubkey_b64: pubkey,
        sign: async (bytes: Uint8Array) => {
          if (++signatures === failSignature) throw Error("injected signing failure");
          return ed.sign(bytes, secret);
        },
      };
    },
    getDevicePubkey: () => pubkey,
    isOwnDevicePubkey: async (key: string) => key === pubkey,
  };
  const roleGate = load("../projection/role-gate", (name) => {
    if (name === "../db-tx") return dbTx;
    if (name === "../event-sig") return signature;
    if (name === "../mesh/device-key") return device;
    if (name === "../effective-account")
      return { resolveAccountIdCandidates: async (id: string) => [id] };
    if (name === "../trust/chain" || name === "../trust/crypto-runtime") return {};
    return require(name === "../hlc" ? "../hlc" : "../trust/ownership-transfer");
  });
  const roleNotifications = {
    invalidateVaultRoleCache: () => roleGate.invalidateRoleGateCache(),
    withDeferredVaultRoleNotifications: (work: () => Promise<unknown>) => work(),
  };
  const fieldHlc = compileUI("../projection/field-hlc", {
    "../db": { FIELD_HLC_INIT: { pms: -1, l: 0, did: "" } },
    "../hlc": require("../hlc"),
  });
  const persons = compileUI("../projection/persons", {
    "./field-hlc": fieldHlc,
    "./errors": require("../projection/errors"),
    "../currency-scope": require("../currency-scope"),
  });
  const members = compileUI("../projection/vault_members", {
    "../hlc": require("../hlc"),
    "../use-vault-role": roleNotifications,
  });
  const settings = compileUI("../projection/vault_settings", {
    "../hlc": require("../hlc"),
    "../currency-settings": require("../currency-settings"),
  });
  const projection = load("../projection", (name) => {
    if (name === "../db-tx") return dbTx;
    if (name === "../event-sig") return signature;
    if (name === "../mesh/device-key") return device;
    if (name === "./role-gate") return roleGate;
    if (name === "./persons") return persons;
    if (name === "./vault_members") return members;
    if (name === "./vault_settings") return settings;
    if (name === "../use-vault-role") return roleNotifications;
    if (name === "../projection-conflicts") return { notifyProjectionConflictsChanged() {} };
    if (name === "../credit-admission")
      return {
        captureCreditMutationBaseline: async () => {},
        requiresCreditAdmission: async () => false,
      };
    if (name === "./sweep") return { scheduleSweep() {} };
    if (name === "../ledger-events")
      return {
        emitLedgerApplied() {
          assert.equal(sql.inTransaction, false);
          notifications++;
        },
      };
    if (name.startsWith("./")) return {};
    return require(name);
  });
  const currency = compileUI("../currency", {
    "./db": {
      listLedgerCurrencies: async (vault: string) =>
        (
          sql.prepare("SELECT DISTINCT currency FROM entries WHERE vault_id=?").all(vault) as {
            currency: string;
          }[]
        ).map((row) => row.currency),
    },
    "./db-tx": dbTx,
    "./i18n": { getLocale: () => "en" },
    react: {},
    "./currency-scope": require("../currency-scope"),
    "./currency-settings": require("../currency-settings"),
    "./currency-catalog": require("../currency-catalog"),
  });
  const eventLog = compileUI("../event-log", {
    "expo-crypto": crypto,
    "./db-tx": dbTx,
    "./mesh/device-key": device,
    "./event-sig": signature,
    "./money": require("../money"),
    "./money-sql": require("../money-sql"),
    "./tabs/errors": require("../tabs/errors"),
    "./entry-date": require("../entry-date"),
    "./currency-scope": require("../currency-scope"),
    "./currency-settings": require("../currency-settings"),
    "./projection": projection,
    "./currency": currency,
  });
  const personCurrency = compileUI("../person-currency", {
    "./auth": auth,
    "./db-tx": dbTx,
    "./currency-scope": require("../currency-scope"),
    "./event-log": eventLog,
    "./projection": projection,
    "./currency": currency,
  }) as typeof import("../person-currency");
  const create = compileUI("../vault-initial-currencies", {
    "expo-crypto": crypto,
    "./db-tx": dbTx,
    "./currency-settings": require("../currency-settings"),
    "./currency-scope": require("../currency-scope"),
    "./projection": projection,
    "./trust/account-id": require("../trust/account-id"),
  });
  await create.createVaultWithCurrencies(
    {
      vaultId: "v1",
      currency: "AFN",
      enabledCurrencies: ["AFN", "USD", "EUR"],
      expectedSignerPubkey: pubkey,
    },
    async () => {
      sql
        .prepare(
          "INSERT INTO vaults(id,name,currency,legacy_currency,default_entry_currency,created_at,updated_at,vault_trust_anchor_pubkey) VALUES('v1','Book','AFN','AFN','AFN',1,1,?)",
        )
        .run(pubkey);
      sql.exec(
        "INSERT INTO relationships VALUES('r1','v1','self','person','peer',1,1,NULL,NULL,NULL,NULL,NULL)",
      );
    },
  );
  sql.exec(`INSERT INTO vaults(id,name,currency,legacy_currency,default_entry_currency,created_at,updated_at) VALUES('v2','Other','EUR','EUR','EUR',1,1);
    INSERT INTO relationships VALUES('r2','v2','self','person','peer',1,1,NULL,NULL,NULL,NULL,NULL);
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,updated_at,is_deleted,is_settled) VALUES('old-money','v1','r1','debt',12.34,'AFN',10,10,0,0);`);
  const rows = () => sql.prepare("SELECT * FROM event_log ORDER BY author_seq").all() as any[];
  const saved = () => sql.prepare("SELECT * FROM relationships WHERE id='r1'").get() as any;
  const wire = (row: any) =>
    ({
      event_id: row.event_id,
      event_type: row.event_type,
      vault_id: row.vault_id,
      target_id: row.target_id,
      relationship_id: row.relationship_id,
      hlc: { pms: row.hlc_physical_ms, l: row.hlc_logical, did: row.hlc_device_id },
      device_id: row.device_id,
      author_user_id_local_only: "",
      actor_account_id: row.actor_account_id,
      payload_schema: row.payload_schema,
      payload: JSON.parse(row.payload_json),
      appended_at: row.appended_at,
      server_acked_at: null,
      rejected_at: null,
      origin: "remote",
      event_sig_b64: row.event_sig_b64,
      signer_device_pubkey: row.signer_device_pubkey,
      author_seq: row.author_seq,
    }) as LedgerEvent;
  return {
    sql,
    tx,
    dbTx,
    projection,
    persons,
    personCurrency,
    eventLog,
    auth,
    currency,
    pubkey,
    rows,
    saved,
    wire,
    notifications: () => notifications,
    active: (value: string) => {
      active = value;
    },
    afterSigner: (value: (() => void) | null) => {
      afterSigner = value;
    },
    failSecondSignature: () => {
      failSignature = signatures + 2;
    },
    pauseRead: () => {
      queryPause = deferred<void>();
      const entered = deferred<void>();
      queryEntered = entered.resolve;
      return {
        entered: entered.promise,
        release: () => {
          queryPause!.resolve();
          queryPause = null;
          queryEntered = null;
        },
      };
    },
    seedRole: (role: VaultRole) => {
      active = "v2";
      account = "member";
      roleGate.invalidateRoleGateCache();
      sql.prepare("DELETE FROM event_log WHERE vault_id='v2'").run();
      sql.prepare("DELETE FROM vault_device_registry WHERE vault_id='v2'").run();
      sql
        .prepare(
          "INSERT INTO vault_device_registry(vault_id,device_pubkey,device_id,account_id,added_at_ms) VALUES('v2',?,'device','member',1)",
        )
        .run(pubkey);
      sql
        .prepare(
          "INSERT INTO event_log(event_id,event_type,vault_id,target_id,payload_json,hlc_physical_ms,hlc_logical,hlc_device_id,device_id,author_user_id_local_only,applied_at) VALUES(?,'vault_member_added','v2','member',?,1,0,'device','device','self',1)",
        )
        .run(randomUUID(), JSON.stringify({ account_id: "member", role }));
      sql
        .prepare(
          "INSERT OR REPLACE INTO vault_settings VALUES('v2','enabled_currencies','[\"EUR\",\"USD\"]',1,0,'device',1)",
        )
        .run();
    },
  };
}

async function main() {
  await migrationChecks();
  {
    const f = await fixture();
    assert.equal(await f.personCurrency.getPersonDefaultCurrency("v1", "person"), null);
    assert.equal(await f.personCurrency.getPersonEntryCurrency("v1", "person"), "AFN");
    const oldMoney = f.sql.prepare("SELECT * FROM entries").all();
    await f.personCurrency.changePersonDefaultCurrency("v1", "person", "USD");
    assert.equal(await f.personCurrency.getPersonEntryCurrency("v1", "person"), "USD");
    assert.equal(
      await f.personCurrency.getPersonEntryCurrency("v2", "person"),
      "EUR",
      "same contact in another book keeps its own default",
    );
    const preference = f.rows().at(-1)!;
    assert.equal(preference.event_type, "person_default_currency_set");
    assert.equal(preference.target_id, "r1");
    assert.equal(preference.relationship_id, "r1");
    assert.equal(await (f as any).personCurrency.getPersonDefaultCurrency("v1", "missing"), null);
    f.sql
      .prepare(
        "UPDATE vault_settings SET value='[\"AFN\",\"EUR\"]' WHERE vault_id='v1' AND key='enabled_currencies'",
      )
      .run();
    assert.equal(
      await f.personCurrency.getPersonDefaultCurrency("v1", "person"),
      "USD",
      "disabled override remains stored",
    );
    assert.equal(
      await f.personCurrency.getPersonEntryCurrency("v1", "person"),
      "AFN",
      "disabled override falls back for future tallies",
    );
    await f.eventLog.appendPersonEdit({
      userId: "person",
      relationshipId: "r1",
      vaultId: "v1",
      name: "Customer",
      defaultCurrency: "USD",
      expectedAccountId: null,
    });
    assert.equal(
      f.saved().default_entry_currency,
      "USD",
      "an unrelated edit may retain its dormant preference",
    );
    await assert.rejects(
      f.personCurrency.changePersonDefaultCurrency("v1", "person", "JPY"),
      /no longer enabled/,
    );
    f.sql
      .prepare(
        "UPDATE vault_settings SET value='[\"AFN\",\"USD\",\"EUR\"]' WHERE vault_id='v1' AND key='enabled_currencies'",
      )
      .run();
    assert.equal(await f.personCurrency.getPersonEntryCurrency("v1", "person"), "USD");
    await f.personCurrency.changePersonDefaultCurrency("v1", "person", null, {
      expectedDefaultCurrency: "USD",
    });
    const reset = f.rows().at(-1)!;
    assert.equal(f.saved().default_entry_currency, null);
    const resetHlc = JSON.parse(f.saved().field_hlcs).default_entry_currency;
    await f.persons.applyPersonDefaultCurrencySet(f.tx, f.wire(preference));
    assert.equal(
      f.saved().default_entry_currency,
      null,
      "older signed preference cannot undo newer reset",
    );
    assert.deepEqual(JSON.parse(f.saved().field_hlcs).default_entry_currency, resetHlc);
    assert.deepEqual(
      f.sql.prepare("SELECT * FROM entries").all(),
      oldMoney,
      "preferences never relabel or edit existing money",
    );
    const malformed = [
      {},
      { currency: undefined },
      { currency: "usd" },
      { currency: 42 },
      { currency: [] },
      { currency: "USD " },
    ];
    for (const payload of malformed)
      await assert.rejects(
        f.persons.applyPersonDefaultCurrencySet(f.tx, { ...f.wire(reset), payload } as any),
        /Invalid/,
      );
    await assert.rejects(
      f.persons.applyPersonDefaultCurrencySet(f.tx, { ...f.wire(reset), vault_id: "v2" } as any),
      /missing/,
    );
    await assert.rejects(
      f.persons.applyPersonDefaultCurrencySet(f.tx, {
        ...f.wire(reset),
        relationship_id: "r2",
      } as any),
      /own relationship/,
    );
    const forged = await f.projection.applyEvent(
      { ...f.wire(preference), event_id: randomUUID() },
      { origin: "remote" },
    );
    assert.equal(forged.applied, false);
    assert.equal(forged.role_gate.reason, "bad_signature");
    assert.equal(
      f.saved().default_entry_currency,
      null,
      "forged preference cannot bypass actual signature gate",
    );
    await snapshotChecks(f, preference, reset);
    f.sql.close();
    console.log(
      "PASS contact currency: per-book choice, enabled fallback, immutable money, strict payloads, signed null-reset LWW and snapshot recovery",
    );
  }
  for (const role of ["viewer", "clerk", "editor", "manager", "owner"] as const) {
    const f = await fixture();
    f.seedRole(role);
    const before = f.rows().length;
    if (role === "viewer" || role === "clerk") {
      await assert.rejects(
        f.personCurrency.changePersonDefaultCurrency("v2", "person", "USD"),
        f.eventLog.RoleGateRejectionError,
      );
      assert.equal(
        (
          f.sql
            .prepare("SELECT default_entry_currency FROM relationships WHERE id='r2'")
            .get() as any
        ).default_entry_currency,
        null,
      );
      assert.equal(f.rows().length, before, "role refusal rolls back the signed batch");
    } else await f.personCurrency.changePersonDefaultCurrency("v2", "person", "USD");
    f.sql.close();
  }
  console.log(
    "PASS contact currency: actual signed role gate denies viewer/clerk and permits editor/manager/owner",
  );
  for (const switchScope of ["vault", "account-aba", "cancel"] as const) {
    const f = await fixture();
    const paused = f.pauseRead();
    let current = true;
    const pending = f.personCurrency.changePersonDefaultCurrency("v1", "person", "USD", {
      shouldContinue: () => current,
    });
    await paused.entered;
    if (switchScope === "vault") f.active("v2");
    if (switchScope === "account-aba") {
      await f.auth.switchSession("other", "other-token");
      await f.auth.switchSession(null, "token");
    }
    if (switchScope === "cancel") current = false;
    const before = f.rows().length;
    paused.release();
    await assert.rejects(pending);
    assert.equal(f.rows().length, before);
    assert.equal(f.saved().default_entry_currency, null);
    f.sql.close();
  }
  {
    const f = await fixture();
    await f.personCurrency.changePersonDefaultCurrency("v1", "person", "USD");
    const before = f.rows().length;
    await assert.rejects(
      f.personCurrency.changePersonDefaultCurrency("v1", "person", "EUR", {
        expectedDefaultCurrency: null,
      }),
      /preference changed/,
    );
    assert.equal(f.rows().length, before);
    f.failSecondSignature();
    await assert.rejects(
      f.eventLog.appendPersonEdit({
        userId: "person",
        relationshipId: "r1",
        vaultId: "v1",
        name: "Renamed",
        defaultCurrency: "EUR",
        expectedAccountId: null,
      }),
      /signing failure/,
    );
    assert.equal(f.rows().length, before);
    assert.equal(f.saved().default_entry_currency, "USD");
    assert.equal(
      (f.sql.prepare("SELECT display_name FROM users WHERE id='person'").get() as any).display_name,
      "Customer",
    );
    f.sql.close();
  }
  {
    const f = await fixture();
    const before = f.rows().length;
    f.afterSigner(() => f.active("v2"));
    await assert.rejects(
      f.personCurrency.changePersonDefaultCurrency("v1", "person", "USD"),
      /context changed|scope/,
    );
    assert.equal(f.rows().length, before);
    assert.equal(f.saved().default_entry_currency, null);
    f.sql.close();
  }
  console.log(
    "PASS contact currency: account ABA, vault/cancel guards, stale preference rejection and atomic multi-field signing rollback",
  );
}

async function migrationChecks() {
  const sql = new Database(":memory:");
  sql.exec(`CREATE TABLE relationships(id TEXT PRIMARY KEY,field_hlcs TEXT);
    CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER);
    CREATE TABLE sync_state(vault_id TEXT PRIMARY KEY,last_pulled_server_seq INTEGER,last_push_at INTEGER);
    INSERT INTO sync_state VALUES('v1',77,99),('v2',88,100);
    CREATE TABLE event_log(event_type TEXT,applied_at INTEGER,quarantine_reason TEXT,rejected_at INTEGER,tombstone_reason TEXT);
    INSERT INTO event_log VALUES('person_default_currency_set',5,'unknown_event_type',NULL,NULL),('person_default_currency_set',6,'blocked',7,NULL),('person_default_currency_set',8,'bad',NULL,'bad_signature'),('entry_created',9,NULL,NULL,NULL);`);
  const tx = {
    execAsync: async (q: string) => sql.exec(q),
    runAsync: async (q: string, ...args: any[]) => sql.prepare(q).run(...args),
    getAllAsync: async (q: string) => sql.prepare(q).all(),
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
  const migrate = compile(
    `const MIGRATION_043='043_person_default_currency';${declaration("../db", "columnExists")};export ${declaration("../db", "runMigration043")}`,
    () => ({}),
  ).runMigration043;
  await migrate(tx);
  assert.ok(
    (sql.prepare("PRAGMA table_info(relationships)").all() as any[]).some(
      (row) => row.name === "default_entry_currency",
    ),
  );
  assert.deepEqual(sql.prepare("SELECT * FROM sync_state ORDER BY vault_id").all(), [
    { vault_id: "v1", last_pulled_server_seq: 0, last_push_at: 99 },
    { vault_id: "v2", last_pulled_server_seq: 0, last_push_at: 100 },
  ]);
  const rows = sql.prepare("SELECT * FROM event_log").all() as any[];
  assert.equal(rows[0].applied_at, null);
  assert.equal(rows[0].quarantine_reason, null);
  assert.equal(rows[1].rejected_at, 7);
  assert.equal(rows[1].applied_at, 6);
  assert.equal(rows[2].tombstone_reason, "bad_signature");
  assert.equal(rows[2].applied_at, 8);
  assert.equal(rows[3].applied_at, 9);
  assert.equal(
    (
      sql
        .prepare(
          "SELECT COUNT(*) AS n FROM schema_migrations WHERE name='043_person_default_currency'",
        )
        .get() as any
    ).n,
    1,
  );
  sql.close();
  console.log(
    "PASS migration043: all-book cursor recovery and unknown-event rearm preserve rejected/tombstoned history and push state",
  );
}

async function snapshotChecks(f: Awaited<ReturnType<typeof fixture>>, preference: any, reset: any) {
  const mapping = compileUI("../projection/ingest-row", {
    "../db-tx": f.dbTx,
    "../events": require("../events"),
    "../hlc": require("../hlc"),
    "./index": {},
  });
  const toWire = (row: any) => {
    const event = f.wire(row);
    return {
      ...event,
      account_id: event.actor_account_id,
      schema_version: event.payload_schema,
      server_seq: row.author_seq,
    };
  };
  const genesis = f
    .rows()
    .find((row) => row.event_type === "vault_member_added" && row.vault_id === "v1")!;
  const snapshotVault = f.sql.prepare("SELECT * FROM vaults WHERE id='v1'").get();
  const received: LedgerEvent[] = [];
  const pending = new Map<string, LedgerEvent>();
  let cursor = 0;
  const restore = compileUI("../restore", {
    "./credit-policy-cache": {},
    "./api": {},
    "./currency-sync": {},
    "./auth": {},
    "./db-tx": f.dbTx,
    "./hlc": require("../hlc"),
    "./projection/field-hlc": { serializeFieldHLCs: JSON.stringify },
    "./entry-date": require("../entry-date"),
    "./currency-metadata": require("../currency-metadata"),
    "./customer-group-restore": compileUI("../customer-group-restore", {
      "./projection/field-hlc": compileUI("../projection/field-hlc", {
        "../db": { FIELD_HLC_INIT: { pms: -1, l: 0, did: "" } },
        "../hlc": require("../hlc"),
      }),
      "./group-memberships": require("../group-memberships"),
    }),
    "./projection/ingest-row": {
      mapPulledWireToEvent: mapping.mapPulledWireToEvent,
      ingestPulledEvents: async (events: LedgerEvent[]) => {
        for (const event of events) {
          received.push(event);
          pending.set(event.event_id, event);
        }
        return events.length;
      },
    },
    "./projection/sweep": {
      sweepVaultNow: async () => {
        const ordered = [...pending.values()].sort((a, b) =>
          require("../hlc").compareHLC(a.hlc, b.hlc),
        );
        pending.clear();
        for (const event of ordered) {
          const result = await f.projection.applyEvent(event, { origin: "remote" });
          assert.ok(
            result.applied || result.reason === "duplicate",
            `original signed snapshot ${event.event_type} must pass replay: ${JSON.stringify(result)}`,
          );
        }
      },
    },
    "./sync/cursor": {
      setLastPulledServerSeq: async (_: string, value: number) => {
        cursor = value;
      },
    },
  });
  f.sql.exec(
    "DELETE FROM event_log;DELETE FROM vault_device_registry;DELETE FROM vault_members_mirror;DELETE FROM vault_settings;DELETE FROM app_meta WHERE key='hlc_last';UPDATE relationships SET default_entry_currency=NULL,field_hlcs=NULL",
  );
  const relationship = {
    id: "r1",
    vault_id: "v1",
    user_a_id: "self",
    user_b_id: "person",
    context: "peer",
    created_at: 1,
    updated_at: 1,
    archived_at: null,
  };
  await restore.restoreFromSnapshot(
    {
      vault_id: "v1",
      vault: snapshotVault,
      shop_profile: null,
      users: [],
      relationships: [relationship],
      entries: [],
      membership_events: [toWire(genesis)],
      person_currency_events: [toWire(preference), toWire(reset), toWire(genesis)],
      events: [toWire(reset)],
      snapshot_server_seq: 500,
      generated_at_ms: Date.now(),
      hlc_last: toWire(reset).hlc,
    },
    { localSelfId: "self", setActiveDefault: false },
  );
  assert.equal(cursor, 500);
  assert.equal(f.saved().default_entry_currency, null);
  const restoredHlc = JSON.parse(f.saved().field_hlcs).default_entry_currency;
  assert.deepEqual(restoredHlc, f.wire(reset).hlc);
  for (const original of [preference, reset]) {
    const restored = received.find((event) => event.event_id === original.event_id)!;
    const expected = f.wire(original);
    for (const key of [
      "event_sig_b64",
      "signer_device_pubkey",
      "author_seq",
      "actor_account_id",
      "device_id",
      "target_id",
      "relationship_id",
      "payload",
      "hlc",
    ] as const)
      assert.deepEqual(restored[key], expected[key], `snapshot preserves original signed ${key}`);
  }
  assert.ok(
    received
      .filter((e) => e.event_type === "person_default_currency_set")
      .every(
        (e) =>
          e.event_sig_b64 === preference.event_sig_b64 || e.event_sig_b64 === reset.event_sig_b64,
      ),
  );
  assert.equal(
    received.filter((e) => e.event_type === "vault_member_added").length,
    1,
    "unrelated event cannot enter through person-currency field",
  );
  assert.equal(
    f.rows().filter((e) => e.event_id === reset.event_id).length,
    1,
    "tail overlap is idempotent",
  );
  await f.persons.applyPersonDefaultCurrencySet(f.tx, f.wire(preference));
  assert.equal(f.saved().default_entry_currency, null, "restored signed reset blocks old choice");
  assert.deepEqual(JSON.parse(f.saved().field_hlcs).default_entry_currency, restoredHlc);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
