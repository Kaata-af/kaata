// Real SQLite, signing, role gate and projection. Only native key storage,
// notification edges and the unrelated post-commit profile event are replaced.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import * as ed from "@noble/ed25519";
import type { SQLiteTx } from "../db-tx";
import type { LedgerEvent } from "../events";
import { buildLocalAccountId } from "../trust/account-id";
import { compileUI } from "./ui-fixture";

function fixture() {
  const sql = new Database(":memory:");
  sql.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,phone_e164 TEXT,display_name TEXT,is_local_self INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE UNIQUE INDEX one_self ON users(is_local_self) WHERE is_local_self=1;
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,is_default INTEGER,account_id TEXT,registered_with_server_at INTEGER,vault_epoch INTEGER,hlc_logical INTEGER,hlc_wall_ms INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TRIGGER initial_currency AFTER INSERT ON vaults BEGIN UPDATE vaults SET legacy_currency=NEW.currency,default_entry_currency=NEW.currency WHERE id=NEW.id; END;
    CREATE TABLE shop_profile(vault_id TEXT PRIMARY KEY,owner_name TEXT,shop_name TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE vault_settings(vault_id TEXT REFERENCES vaults(id),key TEXT,value TEXT,hlc_pms INTEGER,hlc_l INTEGER,hlc_did TEXT,updated_at INTEGER,PRIMARY KEY(vault_id,key));
    CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,PRIMARY KEY(vault_id,account_id));
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,event_type TEXT,vault_id TEXT,target_id TEXT,relationship_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,device_id TEXT,author_user_id_local_only TEXT NOT NULL,actor_account_id TEXT,payload_json TEXT,payload_schema INTEGER,appended_at INTEGER,server_acked_at INTEGER,rejected_at INTEGER,origin TEXT,event_sig_b64 TEXT,signer_device_pubkey TEXT,ingested_at INTEGER,applied_at INTEGER,author_seq INTEGER,quarantine_reason TEXT);
    CREATE UNIQUE INDEX author_slot ON event_log(vault_id,device_id,author_seq);
    CREATE TABLE projection_conflicts(id INTEGER PRIMARY KEY,kind TEXT,vault_id TEXT,detail_json TEXT,created_at INTEGER);
    CREATE TABLE vault_device_registry(vault_id TEXT,device_pubkey TEXT,device_id TEXT,account_id TEXT,added_at_ms INTEGER,removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT);
    CREATE TABLE vault_credentials(vault_id TEXT,device_id TEXT,account_id TEXT,device_pubkey TEXT);
    CREATE TABLE revocation_list(vault_id TEXT,device_id TEXT,lifted_at INTEGER);`);
  let account: string | null = null;
  let cachedSelf: string | null = null;
  let cachedVault: string | null = null;
  let signerReads = 0;
  let signerFailure = false;
  let afterSignerRead: (() => void) | null = null;
  let notifications = 0;
  let transactions = 0;
  const tx = {
    getFirstAsync: async (query: string, ...args: unknown[]) =>
      sql.prepare(query).get(...args) ?? null,
    getAllAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).all(...args),
    runAsync: async (query: string, ...args: unknown[]) => sql.prepare(query).run(...args),
    withTransactionAsync: async (work: () => Promise<void>) => {
      assert.equal(sql.inTransaction, false, "creation never nests SQLite transactions");
      transactions++;
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
  const meta = async (_: unknown, key: string) =>
    (
      sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as
        | { value: string }
        | undefined
    )?.value ?? null;
  const setMeta = async (_: unknown, key: string, value: string) => {
    sql.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(key, value);
  };
  const dbTx = {
    getDb: async () => tx,
    getInstallIdSync: () => "device",
    getAccountIdSync: () => account,
    getLocalSelfUserIdSync: () => cachedSelf,
    getAppMetaInTx: meta,
    setAppMetaInTx: setMeta,
  };
  const crypto = { randomUUID, getRandomBytes: randomBytes };
  const signature = compileUI("../event-sig", {
    "expo-crypto": crypto,
    "@noble/ed25519": ed,
    "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  }) as typeof import("../event-sig");
  const secret = new Uint8Array(32).fill(11);
  const pubkey = Buffer.from(ed.getPublicKey(secret)).toString("base64");
  class DeviceKeyUnavailableError extends Error {
    reason = "test";
  }
  const device = {
    DeviceKeyUnavailableError,
    ensureDeviceKey: async () => {},
    getDevicePubkey: () => pubkey,
    getDeviceSigner: async () => {
      assert.equal(sql.inTransaction, false, "key access precedes mint transaction");
      signerReads++;
      if (signerFailure) throw new DeviceKeyUnavailableError("key unavailable");
      afterSignerRead?.();
      return { pubkey_b64: pubkey, sign: async (bytes: Uint8Array) => ed.sign(bytes, secret) };
    },
    isOwnDevicePubkey: async (key: string) => key === pubkey,
  };
  const required = (name: string) => require(name);
  const gate = compileModule("../projection/role-gate", (name) => {
    if (name === "../db-tx") return dbTx;
    if (name === "../event-sig") return signature;
    if (name === "../mesh/device-key") return device;
    if (name === "../effective-account")
      return { resolveAccountIdCandidates: async (id: string) => [id] };
    if (name === "../hlc") return require("../hlc");
    if (name === "../trust/ownership-transfer") return require("../trust/ownership-transfer");
    if (name === "../trust/chain" || name === "../trust/crypto-runtime") return {};
    throw Error(`Unexpected role import ${name}`);
  });
  const roleNotifications = {
    invalidateVaultRoleCache: () => {},
    withDeferredVaultRoleNotifications: (work: () => Promise<unknown>) => work(),
  };
  const members = compileUI("../projection/vault_members", {
    "../hlc": require("../hlc"),
    "../use-vault-role": roleNotifications,
  });
  const settings = compileUI("../projection/vault_settings", {
    "../hlc": require("../hlc"),
    "../currency-settings": require("../currency-settings"),
  });
  const projection = compileModule("../projection", (name) => {
    if (name === "../db-tx") return dbTx;
    if (name === "../events") return require("../events");
    if (name === "../event-sig") return signature;
    if (name === "../mesh/device-key") return device;
    if (name === "../hlc") return require("../hlc");
    if (name === "./role-gate") return gate;
    if (name === "./vault_members") return members;
    if (name === "./vault_settings") return settings;
    if (name === "../use-vault-role") return roleNotifications;
    if (name === "../util/mutex") return require("../util/mutex");
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
          assert.equal(count("vault_settings"), 2, "observers only see both committed settings");
          notifications++;
        },
      };
    if (name.startsWith("./")) return {};
    return required(name);
  }) as typeof import("../projection");
  const helper = compileUI("../vault-initial-currencies", {
    "expo-crypto": crypto,
    "./db-tx": dbTx,
    "./currency-settings": require("../currency-settings"),
    "./currency-scope": require("../currency-scope"),
    "./projection": projection,
    "./trust/account-id": { buildLocalAccountId },
  }) as typeof import("../vault-initial-currencies");
  const source = readFileSync(require.resolve("../db"), "utf8");
  const ast = ts.createSourceFile("db.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "createSelfProfile",
  )!;
  const profile: any = {};
  const bindings = {
    ...helper,
    Crypto: crypto,
    getDb: async () => tx,
    getAccountIdSync: dbTx.getAccountIdSync,
    getActiveVaultId: async () => meta(tx, "active_vault_id"),
    getAppMetaInTx: meta,
    setAppMetaInTx: setMeta,
    setActiveVaultIdCache: (id: string) => {
      cachedVault = id;
    },
    refreshLocalSelfUserIdCache: async () => {
      cachedSelf =
        (
          sql.prepare("SELECT id FROM users WHERE is_local_self=1").get() as
            | { id: string }
            | undefined
        )?.id ?? null;
    },
    normalizePhone: (value: string) => value,
    appendShopProfileUpdated: async () => {},
    requestImmediateCheckIn: () => {},
    require: (name: string) => {
      assert.equal(name, "./mesh/device-key");
      return device;
    },
  };
  const js = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", ...Object.keys(bindings), js)(profile, ...Object.values(bindings));
  const count = (table: string) =>
    (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const values = () =>
    Object.fromEntries(
      (
        sql.prepare("SELECT key,value FROM vault_settings ORDER BY key").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value]),
    );
  return {
    sql,
    tx,
    pubkey,
    signature,
    projection,
    helper,
    create: profile.createSelfProfile as typeof import("../db").createSelfProfile,
    count,
    values,
    counts: () => ({ signerReads, transactions, notifications, cachedSelf, cachedVault }),
    account: (id: string | null) => {
      account = id;
    },
    failSigner: () => {
      signerFailure = true;
    },
    afterSigner: (work: () => void) => {
      afterSignerRead = work;
    },
  };
}

function compileModule(path: string, required: (name: string) => unknown): any {
  const exports = {};
  const js = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(required, exports);
  return exports;
}

async function main() {
  {
    const f = fixture();
    for (const currencies of [[], ["USD"], ["AFN", "AFN"], ["AFN", "usd"]]) {
      await assert.rejects(f.create("Owner", "Shop", null, "AFN", currencies));
      assert.equal(f.count("users"), 0);
      assert.equal(f.count("vaults"), 0);
    }
    assert.equal(f.counts().signerReads, 0, "invalid draft fails before key preparation");
    assert.equal(f.counts().transactions, 0);
    await f.create("Owner", "Shop", null, "AFN", ["USD", "AFN", "AUD"]);
    assert.equal(f.counts().transactions, 1);
    assert.equal(f.counts().notifications, 1);
    assert.equal(f.count("vaults"), 1);
    assert.equal(f.count("users"), 1);
    assert.deepEqual(f.values(), {
      default_entry_currency: "AFN",
      enabled_currencies: '["USD","AFN","AUD"]',
    });
    const saved = f.sql.prepare("SELECT * FROM event_log ORDER BY author_seq").all() as any[];
    assert.deepEqual(
      saved.map((row) => row.event_type),
      ["vault_member_added", "vault_setting_set", "vault_setting_set"],
    );
    assert.equal(JSON.parse(saved[0].payload_json).account_id, buildLocalAccountId(f.pubkey));
    assert.ok(
      saved.every(
        (row) =>
          row.event_sig_b64 &&
          row.signer_device_pubkey === f.pubkey &&
          row.applied_at &&
          row.server_acked_at == null,
      ),
    );
    assert.ok(saved.every((row) => row.author_user_id_local_only === f.counts().cachedSelf));
    const events = saved.map(
      (row): LedgerEvent => ({
        event_id: row.event_id,
        event_type: row.event_type,
        vault_id: row.vault_id,
        target_id: row.target_id,
        relationship_id: null,
        hlc: { pms: row.hlc_physical_ms, l: row.hlc_logical, did: row.hlc_device_id },
        device_id: row.device_id,
        author_user_id_local_only: "", // Device-local author IDs never cross the wire.
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
      }),
    );
    f.sql.exec(
      "DELETE FROM event_log; DELETE FROM vault_settings; DELETE FROM vault_device_registry; DELETE FROM vault_members_mirror; DELETE FROM app_meta WHERE key='hlc_last'; UPDATE vaults SET default_entry_currency='USD';",
    );
    for (const event of events)
      assert.equal(
        (await f.projection.applyEvent(event, { origin: "remote" })).applied,
        true,
        "signed genesis-first history replays through actual peer role gate",
      );
    assert.deepEqual(f.values(), {
      default_entry_currency: "AFN",
      enabled_currencies: '["USD","AFN","AUD"]',
    });
    assert.equal(
      (f.sql.prepare("SELECT default_entry_currency FROM vaults").get() as any)
        .default_entry_currency,
      "AFN",
    );
    const before = f.values();
    await f.create("Renamed Owner", "Ignored Shop", null, "USD", ["USD"]);
    assert.equal(f.count("vaults"), 1);
    assert.deepEqual(
      f.values(),
      before,
      "existing book settings are never overwritten by onboarding rerun",
    );
    f.sql.close();
  }
  {
    const f = fixture();
    f.account("account-owner");
    await f.create("Owner", "New", null, "USD");
    assert.equal(
      f.values().enabled_currencies,
      '["USD"]',
      "old four-argument callers keep a single default",
    );
    const genesis = JSON.parse(
      (
        f.sql
          .prepare("SELECT payload_json FROM event_log WHERE event_type='vault_member_added'")
          .get() as any
      ).payload_json,
    );
    assert.equal(genesis.account_id, "account-owner");
    f.sql.close();
  }
  for (const failure of ["setting", "signer", "account"] as const) {
    const f = fixture();
    if (failure === "setting")
      f.sql.exec(
        "CREATE TRIGGER deny_enabled BEFORE INSERT ON vault_settings WHEN NEW.key='enabled_currencies' BEGIN SELECT RAISE(ABORT,'injected setting failure'); END;",
      );
    if (failure === "signer") f.failSigner();
    if (failure === "account") f.afterSigner(() => f.account("different-account"));
    await assert.rejects(f.create("Owner", "Failing Shop", null, "AFN", ["AFN", "USD"]));
    for (const table of [
      "users",
      "vaults",
      "shop_profile",
      "vault_settings",
      "event_log",
      "vault_members_mirror",
      "vault_device_registry",
      "app_meta",
    ])
      assert.equal(f.count(table), 0, `${failure} failure rolls back ${table}`);
    assert.equal(f.counts().cachedVault, null);
    assert.equal(f.counts().cachedSelf, null);
    assert.equal(f.counts().notifications, 0);
    f.sql.close();
  }
  {
    const f = fixture();
    await f.create("Self Only", "");
    assert.equal(f.count("users"), 1);
    assert.equal(f.count("vaults"), 0, "identity-only creation still mints no book/settings");
    assert.equal(f.count("event_log"), 0);
    const choices = ["AUD", "USD"];
    f.afterSigner(() => choices.push("EUR"));
    await f.helper.createVaultWithCurrencies(
      {
        vaultId: "later-book",
        currency: "AUD",
        enabledCurrencies: choices,
        expectedSignerPubkey: f.pubkey,
        accountId: null,
      },
      async (tx) => {
        await tx.runAsync(
          `INSERT INTO vaults(id,name,currency,created_at,updated_at,vault_epoch,hlc_logical,hlc_wall_ms,vault_trust_anchor_pubkey)
           VALUES('later-book','Later book','AUD',1,1,0,0,0,?)`,
          f.pubkey,
        );
        await tx.runAsync("INSERT INTO app_meta VALUES('active_vault_id','later-book')");
      },
    );
    assert.equal(
      f.values().enabled_currencies,
      '["AUD","USD"]',
      "the committed draft is copied before asynchronous key access",
    );
    assert.equal(f.values().default_entry_currency, "AUD");
    const before = f.values();
    let initializedAgain = false;
    await assert.rejects(
      f.helper.createVaultWithCurrencies(
        { vaultId: "later-book", currency: "USD", expectedSignerPubkey: f.pubkey },
        async () => {
          initializedAgain = true;
        },
      ),
      /already exists/,
    );
    assert.equal(initializedAgain, false);
    assert.deepEqual(f.values(), before, "a duplicate mint cannot overwrite an existing book");
    assert.equal(f.count("event_log"), 3);
    f.sql.close();
  }
  console.log(
    "initial-currencies: atomic mint, signed genesis-first replay, local/signed-in defaults, validation, rollback and existing-book preservation passed",
  );
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
