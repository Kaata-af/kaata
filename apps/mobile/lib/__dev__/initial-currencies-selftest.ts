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
  let bindingVersion = 0;
  let cachedSelf: string | null = null;
  let cachedVault: string | null = null;
  let signerReads = 0;
  let signerFailure = false;
  let signatureCalls = 0;
  let failedSignatureCall: number | null = null;
  let refuseEnabledRole = false;
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
  let currentSecret = secret;
  const currentPubkey = () => Buffer.from(ed.getPublicKey(currentSecret)).toString("base64");
  class DeviceKeyUnavailableError extends Error {
    reason = "test";
  }
  const device = {
    DeviceKeyUnavailableError,
    ensureDeviceKey: async () => {},
    getDevicePubkey: currentPubkey,
    getDeviceSigner: async () => {
      assert.equal(sql.inTransaction, false, "key access precedes mint transaction");
      signerReads++;
      if (signerFailure) throw new DeviceKeyUnavailableError("key unavailable");
      afterSignerRead?.();
      return {
        pubkey_b64: currentPubkey(),
        sign: async (bytes: Uint8Array) => {
          signatureCalls++;
          if (signatureCalls === failedSignatureCall)
            throw new Error("injected second signature failure");
          return ed.sign(bytes, currentSecret);
        },
      };
    },
    isOwnDevicePubkey: async (key: string) => key === currentPubkey(),
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
  const realRoleGate = gate.checkRoleForEvent;
  gate.checkRoleForEvent = (tx: SQLiteTx, event: LedgerEvent) =>
    refuseEnabledRole &&
    event.event_type === "vault_setting_set" &&
    event.payload.key === "enabled_currencies"
      ? Promise.resolve({
          ok: false,
          reason: "insufficient_role",
          current_role: "viewer",
          required_role: "manager",
        })
      : realRoleGate(tx, event);
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
  }) as typeof import("../event-log");
  const session = () => ({ accountId: account, jwt: null, bindingVersion });
  const router = compileUI("../vault-router", {
    "./auth": {
      captureCurrentSession: async () => session(),
      applyForUnchangedLocalSession: async (
        expected: ReturnType<typeof session>,
        work: () => Promise<unknown>,
      ) => {
        if (expected.accountId !== account || expected.bindingVersion !== bindingVersion)
          throw new Error("stale local session");
        return work();
      },
    },
    "./db-tx": dbTx,
    "./effective-account": {},
    "./event-log": eventLog,
    "./vault-api": {},
    "./ownership-transfer-readiness": {},
    "./currency-settings": require("../currency-settings"),
    "./currency-scope": require("../currency-scope"),
  }) as typeof import("../vault-router");
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
    eventLog,
    router,
    session,
    create: profile.createSelfProfile as typeof import("../db").createSelfProfile,
    count,
    values,
    counts: () => ({ signerReads, transactions, notifications, cachedSelf, cachedVault }),
    account: (id: string | null) => {
      account = id;
      bindingVersion++;
    },
    failSigner: () => {
      signerFailure = true;
    },
    refuseEnabledRole: (value: boolean) => {
      refuseEnabledRole = value;
    },
    failSecondSignature: (value: boolean) => {
      failedSignatureCall = value ? signatureCalls + 2 : null;
    },
    usePairedSigner: () => {
      currentSecret = new Uint8Array(32).fill(22);
    },
    afterSigner: (work: (() => void) | null) => {
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
  await atomicCurrencySettings();
  await snapshotCurrencyRecovery();
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

async function atomicCurrencySettings() {
  const f = fixture();
  try {
    await f.create("Owner", "Atomic settings", null, "AFN", ["AFN", "USD"]);
    const vaultId = (f.sql.prepare("SELECT id FROM vaults").get() as { id: string }).id;
    f.sql.exec(
      "CREATE TABLE entries(id TEXT PRIMARY KEY,currency TEXT,amount_afn REAL,created_at INTEGER); INSERT INTO entries VALUES('historical','AFN',123.45,1000);",
    );
    const state = () => ({
      vault: f.sql
        .prepare("SELECT currency,legacy_currency,default_entry_currency FROM vaults")
        .get(),
      settings: f.values(),
      events: f.sql.prepare("SELECT * FROM event_log ORDER BY author_seq").all(),
      meta: f.sql.prepare("SELECT * FROM app_meta ORDER BY key").all(),
      entries: f.sql.prepare("SELECT * FROM entries").all(),
    });
    const previous = () => ({
      enabledValue: f.values().enabled_currencies,
      defaultCurrency: f.values().default_entry_currency,
    });
    const counts = f.counts();
    const before = state();
    const result = await f.router.changeVaultCurrencySettings(
      vaultId,
      { defaultCurrency: "EUR", enabledCurrencies: ["EUR", "USD"] },
      { session: f.session(), previous: previous() },
    );
    assert.equal(result.kind, "local");
    assert.deepEqual(f.values(), {
      default_entry_currency: "EUR",
      enabled_currencies: '["EUR","USD"]',
    });
    assert.deepEqual(
      f.sql.prepare("SELECT currency,legacy_currency,default_entry_currency FROM vaults").get(),
      { currency: "AFN", legacy_currency: "AFN", default_entry_currency: "EUR" },
    );
    assert.deepEqual(
      state().entries,
      before.entries,
      "default changes never relabel historical money or dates",
    );
    assert.equal(
      f.counts().transactions,
      counts.transactions + 1,
      "both settings use exactly one transaction",
    );
    assert.equal(
      f.counts().notifications,
      counts.notifications + 1,
      "observers see one complete committed pair",
    );
    const writes = state().events.slice(-2) as any[];
    assert.deepEqual(
      writes.map((row) => JSON.parse(row.payload_json).key),
      ["default_entry_currency", "enabled_currencies"],
    );
    for (const row of writes) {
      const event = {
        event_id: row.event_id,
        event_type: row.event_type,
        vault_id: row.vault_id,
        target_id: row.target_id,
        relationship_id: row.relationship_id,
        hlc: { pms: row.hlc_physical_ms, l: row.hlc_logical, did: row.hlc_device_id },
        device_id: row.device_id,
        actor_account_id: row.actor_account_id,
        payload_schema: row.payload_schema,
        payload: JSON.parse(row.payload_json),
        author_seq: row.author_seq,
      } as LedgerEvent;
      assert.deepEqual(
        f.signature.verifyEventSignature(event, row.event_sig_b64, row.signer_device_pubkey),
        { valid: true },
        "both saved settings retain authentic signatures",
      );
    }
    if (result.kind === "local") assert.equal(result.eventId, writes[1].event_id);

    const stable = state();
    const signerReads = f.counts().signerReads;
    for (const changes of [
      { defaultCurrency: "eur", enabledCurrencies: ["EUR"] },
      { defaultCurrency: "EUR", enabledCurrencies: [] },
      { defaultCurrency: "EUR", enabledCurrencies: ["USD"] },
      { defaultCurrency: "EUR", enabledCurrencies: ["EUR", "EUR"] },
      {
        defaultCurrency: "AFN",
        enabledCurrencies: require("../currency-catalog")
          .CURRENCIES.slice(0, 65)
          .map((row: any) => row.code),
      },
    ])
      await assert.rejects(f.router.changeVaultCurrencySettings(vaultId, changes));
    assert.equal(
      f.counts().signerReads,
      signerReads,
      "invalid complete drafts fail before signing",
    );
    assert.deepEqual(state(), stable);

    f.sql.exec(
      "CREATE TRIGGER reject_second_setting BEFORE INSERT ON vault_settings WHEN NEW.key='enabled_currencies' BEGIN SELECT RAISE(ABORT,'second setting failed'); END;",
    );
    const beforeRollback = state(),
      notices = f.counts().notifications;
    await assert.rejects(
      f.router.changeVaultCurrencySettings(vaultId, {
        defaultCurrency: "GBP",
        enabledCurrencies: ["GBP"],
      }),
      /second setting failed/,
    );
    assert.deepEqual(
      state(),
      beforeRollback,
      "second-setting failure rolls back default, signatures, clock, sequence and money",
    );
    assert.equal(f.counts().notifications, notices);
    f.sql.exec("DROP TRIGGER reject_second_setting");

    const enabledBaseline = previous();
    f.afterSigner(() =>
      f.sql
        .prepare(
          "UPDATE vault_settings SET value='[\"EUR\",\"GBP\"]' WHERE key='enabled_currencies'",
        )
        .run(),
    );
    await assert.rejects(
      f.router.changeVaultCurrencySettings(
        vaultId,
        { defaultCurrency: "USD", enabledCurrencies: ["USD"] },
        { previous: enabledBaseline },
      ),
      f.router.CurrencySettingsChangedError,
    );
    f.afterSigner(null);
    assert.equal(
      f.values().enabled_currencies,
      '["EUR","GBP"]',
      "a remote enabled-list edit wins over the stale draft",
    );
    assert.equal(f.count("event_log"), stable.events.length);
    const defaultBaseline = previous();
    f.afterSigner(() =>
      f.sql.exec(
        "UPDATE vault_settings SET value='GBP' WHERE key='default_entry_currency'; UPDATE vaults SET default_entry_currency='GBP';",
      ),
    );
    await assert.rejects(
      f.router.changeVaultCurrencySettings(
        vaultId,
        { defaultCurrency: "USD", enabledCurrencies: ["USD"] },
        { previous: defaultBaseline },
      ),
      f.router.CurrencySettingsChangedError,
    );
    f.afterSigner(null);
    assert.equal(f.values().default_entry_currency, "GBP", "a remote default edit also conflicts");

    const scopeState = state();
    let current = true;
    f.afterSigner(() => {
      current = false;
    });
    await assert.rejects(
      f.router.changeVaultCurrencySettings(
        vaultId,
        { defaultCurrency: "USD", enabledCurrencies: ["USD"] },
        { shouldContinue: () => current },
      ),
      /scope/,
    );
    f.afterSigner(null);
    assert.deepEqual(
      state(),
      scopeState,
      "losing focus/scope during key preparation writes neither setting",
    );
    const stale = f.session();
    f.account("other");
    f.account(null);
    await assert.rejects(
      f.router.changeVaultCurrencySettings(
        vaultId,
        { defaultCurrency: "USD", enabledCurrencies: ["USD"] },
        { session: stale },
      ),
      /stale local session/,
    );
    assert.deepEqual(state(), scopeState, "account ABA rejects retained Save consent");
    f.refuseEnabledRole(true);
    await assert.rejects(
      f.router.changeVaultCurrencySettings(vaultId, {
        defaultCurrency: "USD",
        enabledCurrencies: ["USD"],
      }),
      f.eventLog.RoleGateRejectionError,
    );
    f.refuseEnabledRole(false);
    assert.deepEqual(
      state(),
      scopeState,
      "a role refusal on the second event rolls back the first setting and both event rows",
    );
    f.failSecondSignature(true);
    await assert.rejects(
      f.router.changeVaultCurrencySettings(vaultId, {
        defaultCurrency: "USD",
        enabledCurrencies: ["USD"],
      }),
    );
    f.failSecondSignature(false);
    assert.deepEqual(
      state(),
      scopeState,
      "second-event signing failure rolls back the whole draft",
    );
    await f.eventLog.appendVaultMemberAdded({
      targetVaultId: vaultId,
      accountId: "viewer-account",
      role: "viewer",
    });
    const restrictedState = state();
    f.usePairedSigner();
    f.account("viewer-account");
    await assert.rejects(
      f.router.changeVaultCurrencySettings(vaultId, {
        defaultCurrency: "USD",
        enabledCurrencies: ["USD"],
      }),
      f.eventLog.RoleGateRejectionError,
    );
    f.account(null);
    assert.deepEqual(
      state(),
      restrictedState,
      "the actual role gate refuses a paired viewer's complete draft",
    );
    f.failSigner();
    await assert.rejects(
      f.router.changeVaultCurrencySettings(vaultId, {
        defaultCurrency: "USD",
        enabledCurrencies: ["USD"],
      }),
    );
    assert.deepEqual(
      state(),
      restrictedState,
      "unavailable signing keys never leave a partial choice",
    );
  } finally {
    f.sql.close();
  }
}

async function snapshotCurrencyRecovery() {
  const f = fixture();
  try {
    await f.create("Owner", "Shop", null, "AFN", ["AFN", "EUR"]);
    const saved = f.sql.prepare("SELECT * FROM event_log ORDER BY author_seq").all() as any[];
    const wire = saved.map((row) => ({
      event_id: row.event_id,
      event_type: row.event_type,
      hlc: { pms: row.hlc_physical_ms, l: row.hlc_logical, did: row.hlc_device_id },
      device_id: row.device_id,
      account_id: row.actor_account_id,
      target_id: row.target_id,
      relationship_id: row.relationship_id,
      schema_version: row.payload_schema,
      payload: JSON.parse(row.payload_json),
      author_seq: row.author_seq,
      event_sig_b64: row.event_sig_b64,
      signer_device_pubkey: row.signer_device_pubkey,
      server_seq: row.author_seq,
    }));
    const vault = f.sql.prepare("SELECT * FROM vaults").get() as any;
    const self = f.sql.prepare("SELECT id FROM users WHERE is_local_self=1").get() as {
      id: string;
    };
    f.sql
      .exec(`DELETE FROM event_log; DELETE FROM vault_settings; DELETE FROM vault_device_registry; DELETE FROM vault_members_mirror;
      CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn REAL,note TEXT,currency TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER,proposed_by_user_id TEXT,current_event_id TEXT,is_deleted INTEGER,is_settled INTEGER,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER,field_hlcs TEXT);`);
    const dbTx = {
      getDb: async () => f.tx,
      getAppMetaInTx: async (_: unknown, key: string) =>
        (f.sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key) as any)?.value ?? null,
      setAppMetaInTx: async (_: unknown, key: string, value: string) =>
        f.sql.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(key, value),
    };
    const mapping = compileUI("../projection/ingest-row", {
      "../db-tx": dbTx,
      "../events": require("../events"),
      "../hlc": require("../hlc"),
      "./index": {},
    });
    const pending = new Map<string, LedgerEvent>();
    const received: LedgerEvent[] = [];
    let cursor = 0;
    const restore = compileUI("../restore", {
      "./credit-policy-cache": {},
      "./api": {},
      "./currency-sync": {},
      "./auth": {},
      "./db-tx": dbTx,
      "./hlc": require("../hlc"),
      "./projection/field-hlc": { serializeFieldHLCs: JSON.stringify },
      "./entry-date": require("../entry-date"),
      "./currency-metadata": require("../currency-metadata"),
      "./customer-group-restore": { seedSnapshotCustomerGroups: async () => {} },
      // Keep the production wire mapper and real signed projection/role gate.
      // Only durable queue scheduling is controlled at this restore boundary.
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
          for (const event of ordered) await f.projection.applyEvent(event, { origin: "remote" });
        },
      },
      "./sync/cursor": {
        setLastPulledServerSeq: async (_: string, value: number) => {
          cursor = value;
        },
      },
    });
    const snapshot = {
      vault,
      vault_id: vault.id,
      shop_profile: null,
      users: [],
      relationships: [],
      entries: [
        {
          id: "historical-usd",
          vault_id: vault.id,
          relationship_id: "person",
          type: "debt",
          amount_afn: 12.5,
          note: null,
          currency: "USD",
          created_at: 1000,
          recorded_at_ms: 2000,
          occurred_at_hlc: wire[2].hlc,
          updated_at: wire[2].hlc.pms,
          deleted_at: null,
          proposed_by_user_id: null,
          current_event_id: null,
          is_deleted: 0,
          is_settled: 0,
          accepted_at: null,
          disputed_at: null,
          disputed_reason: null,
          settled_at: null,
        },
      ],
      membership_events: [wire[0]],
      // An unrelated setting cannot use this narrowly scoped field, even if
      // it was correctly signed. The tail overlap is normal and idempotent.
      enabled_currency_events: [wire[2], wire[1]],
      events: [wire[2]],
      snapshot_server_seq: 500,
      generated_at_ms: Date.now(),
      hlc_last: wire[2].hlc,
    };
    await restore.restoreFromSnapshot(snapshot, { localSelfId: self.id, setActiveDefault: false });
    assert.deepEqual(
      f.values(),
      { enabled_currencies: '["AFN","EUR"]' },
      "pre-cursor explicit choices survive without republishing other settings",
    );
    assert.equal(cursor, 500, "the normal snapshot cursor still skips old history");
    assert.ok(
      received.every(
        (event) =>
          event.event_type !== "vault_setting_set" || event.payload.key === "enabled_currencies",
      ),
    );
    const enabled = received.find((event) => event.event_id === wire[2].event_id)!;
    assert.equal(
      enabled.event_sig_b64,
      wire[2].event_sig_b64,
      "restore forwards the original signature unchanged",
    );
    assert.equal(f.count("event_log"), 2, "tail overlap does not duplicate signed settings");
    const historical = f.sql
      .prepare("SELECT * FROM entries WHERE id='historical-usd'")
      .get() as any;
    assert.equal(historical.currency, "USD");
    assert.equal(historical.created_at, 1000);
    assert.equal(JSON.parse(historical.field_hlcs).recorded_at_ms.pms, 2000);
    const currency = compileUI("../currency", {
      "./db": {
        getAppMeta: async () => null,
        setAppMeta: async () => {},
        listLedgerCurrencies: async () => ["AFN", "EUR", "USD"],
      },
      "./db-tx": dbTx,
      "./i18n": { getLocale: () => "en" },
      react: {},
      "./currency-scope": require("../currency-scope"),
      "./currency-settings": require("../currency-settings"),
      "./currency-catalog": require("../currency-catalog"),
    });
    assert.deepEqual(
      await currency.getEnabledCurrencies(vault.id),
      ["AFN", "EUR"],
      "disabled historical USD is not silently selectable after reinstall",
    );
    const newer = {
      ...enabled,
      event_id: randomUUID(),
      author_seq: (enabled.author_seq ?? 0) + 1,
      hlc: { ...enabled.hlc, pms: enabled.hlc.pms + 10 },
      payload: { key: "enabled_currencies", value: '["AFN"]' },
    } as LedgerEvent;
    newer.event_sig_b64 = await f.signature.signEvent(newer, async (bytes) =>
      ed.sign(bytes, new Uint8Array(32).fill(11)),
    );
    assert.equal((await f.projection.applyEvent(newer, { origin: "remote" })).applied, true);
    await restore.restoreFromSnapshot(snapshot, { localSelfId: self.id, setActiveDefault: false });
    assert.deepEqual(
      await currency.getEnabledCurrencies(vault.id),
      ["AFN"],
      "an existing newer choice is not regressed by old snapshot history",
    );
  } finally {
    f.sql.close();
  }
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
