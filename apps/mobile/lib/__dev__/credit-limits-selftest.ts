// Actual policy/cache/intent/queue code, shipped migrations and in-memory SQLite.
// Native session/network edges are replaced; no phone or production data is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import Database from "better-sqlite3";
import {
  creditExceeded,
  creditStatusForExposure,
  KAATA_DEFAULT_CREDIT_ID,
  validCreditPolicy,
  type CreditPolicy,
} from "../credit-policy";
import { cacheCreditPolicies } from "../credit-policy-cache";
import { cacheCreditAlerts } from "../credit-alert-cache";
import { Mutex } from "../util/mutex";
import { fromMinorUnits, toMinorUnits } from "../money";
import { signedEntryMinorSumSql } from "../money-sql";
import { effectiveEntryCurrencySql, isValidCurrencyCode } from "../currency-scope";
import type { SQLiteTx } from "../db-tx";
import { applyCurrencyMigration } from "./currency-fixture";
import type {
  EntryCreatedEvent,
  EntryAmendedEvent,
  EntryDeletedEvent,
  LedgerEvent,
  VaultRole,
} from "../events";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const fixture = new Database(":memory:");
fixture.pragma("foreign_keys = ON");
fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,account_id TEXT,archived_at INTEGER,registered_with_server_at INTEGER,vault_trust_anchor_pubkey TEXT);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),user_b_id TEXT,created_at INTEGER,archived_at INTEGER);
CREATE TABLE users(id TEXT PRIMARY KEY,is_local_self INTEGER,display_name TEXT);
CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn NUMERIC,note TEXT,created_at INTEGER,updated_at INTEGER,proposed_by_user_id TEXT,current_event_id TEXT,is_deleted INTEGER DEFAULT 0,is_settled INTEGER DEFAULT 0,accepted_at INTEGER,disputed_at INTEGER,disputed_reason TEXT,settled_at INTEGER,deleted_at INTEGER,field_hlcs TEXT);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,payload_json TEXT,applied_at INTEGER,quarantine_reason TEXT,server_acked_at INTEGER,rejected_at INTEGER,last_reject_reason TEXT,appended_at INTEGER,event_type TEXT,actor_account_id TEXT,target_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT,author_user_id_local_only TEXT,origin TEXT DEFAULT 'local');
CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,revoked_at INTEGER);
CREATE TABLE vault_device_registry(vault_id TEXT,account_id TEXT,device_id TEXT,device_pubkey TEXT,removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT);
CREATE TABLE vault_credentials(vault_id TEXT,account_id TEXT);
INSERT INTO vaults(id,account_id,archived_at,registered_with_server_at,vault_trust_anchor_pubkey) VALUES('v1',NULL,NULL,NULL,'anchor'),('v2',NULL,NULL,NULL,'anchor');
INSERT INTO relationships VALUES('r1','v1','p1',1,NULL),('r2','v2','p2',1,NULL);
INSERT INTO users VALUES('self',1,'Owner');`);
fixture.exec(
  "ALTER TABLE vaults ADD COLUMN currency TEXT DEFAULT 'AFN'; CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER); CREATE TABLE settlements(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,settled_at_ms INTEGER,created_at INTEGER);",
);
const dbSource = readFileSync(require.resolve("../db"), "utf8");
for (const marker of [
  "customer_credit_limits",
  "credit_alert_policies",
  "kaata_credit_defaults",
  "vault_member_credit_permissions",
  "credit_mutation_baselines",
  "tab_links",
  "tab_failed_ops",
]) {
  const ddl = new RegExp(
    "execAsync\\(`([^`]*CREATE TABLE IF NOT EXISTS " + marker + "[^`]*)`\\)",
  ).exec(dbSource)?.[1];
  assert.ok(ddl, `actual migration ${marker}`);
  fixture.exec(ddl);
}
const editorRestrictionDDL = /`(ALTER TABLE \$\{table\} ADD COLUMN restrict_editors[^`]*)`/.exec(
  dbSource,
)?.[1];
assert.ok(editorRestrictionDDL, "actual migration 040 editor restriction column");
for (const table of ["customer_credit_limits", "kaata_credit_defaults"])
  fixture.exec(editorRestrictionDDL.replace("${table}", table));
const pendingActionDDL = /ALTER TABLE tab_entries ADD COLUMN local_action_pending[^;]*;/.exec(
  dbSource,
)?.[0];
assert.ok(pendingActionDDL, "actual shared action-pending migration");
fixture.exec(pendingActionDDL);
const historyOrderDDL = /ALTER TABLE tab_links ADD COLUMN history_order TEXT;/.exec(dbSource)?.[0];
assert.ok(historyOrderDDL, "actual shared history order migration");
fixture.exec(historyOrderDDL);
const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (fn: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await fn();
      fixture.exec("COMMIT");
    } catch (e) {
      fixture.exec("ROLLBACK");
      throw e;
    }
  },
} as unknown as SQLiteTx;
let session = { jwt: null as string | null, accountId: null as string | null, bindingVersion: 0 };
let active = "v1",
  role: VaultRole = "owner",
  emits = 0,
  puts = 0;
const localOwner = "local:AAAAAAAAAAAAAAAA",
  localClerk = "local:BBBBBBBBBBBBBBBB";
let identities = [localOwner];
class SessionChangedError extends Error {}
const guard = async <T>(snapshot: typeof session, fn: () => Promise<T>) => {
  if (
    snapshot.jwt !== session.jwt ||
    snapshot.accountId !== session.accountId ||
    snapshot.bindingVersion !== session.bindingVersion
  )
    throw new SessionChangedError();
  return fn();
};
function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  const js = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)(required, exports);
  return exports as T;
}
// Reuse the shipped currency readers with the same SQLite fixture, without
// importing the native database initialization or React hooks into Node.
const dbAST = ts.createSourceFile("db.ts", dbSource, ts.ScriptTarget.Latest, true);
const ledgerCurrencyDeclaration = dbAST.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "listLedgerCurrencies",
);
assert.ok(ledgerCurrencyDeclaration, "actual ledger currency discovery");
const ledgerCurrencyReaders = {} as Pick<typeof import("../db"), "listLedgerCurrencies">;
new Function(
  "exports",
  "getDb",
  "effectiveEntryCurrencySql",
  "isValidCurrencyCode",
  ts.transpileModule("export " + ledgerCurrencyDeclaration.getText(dbAST), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)(ledgerCurrencyReaders, async () => db, effectiveEntryCurrencySql, isValidCurrencyCode);
const currencyReaders = compile<typeof import("../currency")>("../currency", (name) => {
  if (name === "./db") return ledgerCurrencyReaders;
  if (name === "./db-tx") return { getDb: async () => db };
  if (name === "./i18n") return { getLocale: () => "en" };
  if (name === "react") return {};
  if (name === "./currency-scope") return require("../currency-scope");
  if (name === "./currency-settings") return require("../currency-settings");
  if (name === "./currency-catalog") return require("../currency-catalog");
  throw Error(`unexpected currency reader import ${name}`);
});
const fieldHLCs = compile<typeof import("../projection/field-hlc")>(
  "../projection/field-hlc",
  (name) => {
    if (name === "../db") return { FIELD_HLC_INIT: { pms: 0, l: 0, did: "init" } };
    if (name === "../hlc") return require("../hlc");
    throw Error(`unexpected field HLC import ${name}`);
  },
);
const entryAppliers = compile<typeof import("../projection/entries")>(
  "../projection/entries",
  (name) => {
    if (name === "../entry-date") return require("../entry-date");
    if (name === "../currency-scope") return require("../currency-scope");
    if (name === "../hlc") return require("../hlc");
    if (name === "../money") return require("../money");
    if (name === "./field-hlc") return fieldHLCs;
    if (name === "./errors") return require("../projection/errors");
    throw Error(`unexpected entry applier import ${name}`);
  },
);
const {
  needsCreditAdmission,
  deferCreditAdmission,
  requiresCreditAdmission,
  revertRefusedClerkTally,
  hardLimitApplies,
  CreditMutationAdmissionError,
  captureCreditMutationBaseline,
} = compile<typeof import("../credit-admission")>("../credit-admission", (name) => {
  if (name === "./currency-scope") return require("../currency-scope");
  if (name === "./projection/entries") return entryAppliers;
  throw Error(`unexpected credit admission import ${name}`);
});
const policyModule = require("../credit-policy"),
  cacheModule = require("../credit-policy-cache");
const roleGate = compile<typeof import("../projection/role-gate")>(
  "../projection/role-gate",
  (name) => {
    if (name === "../db-tx") return { getAccountIdSync: () => session.accountId };
    if (name === "../effective-account")
      return { resolveAccountIdCandidates: async () => identities };
    if (name === "../event-sig") return { verifyEventSignature: () => ({ valid: true }) };
    if (name === "../hlc") return require("../hlc");
    if (name === "../trust/chain") return {};
    if (name === "../trust/ownership-transfer") return require("../trust/ownership-transfer");
    if (name === "../trust/crypto-runtime") return {};
    throw Error(`unexpected role-gate import ${name}`);
  },
);
const credit = compile<typeof import("../credit-limits")>("../credit-limits", (name) => {
  if (name === "./currency") return currencyReaders;
  if (name === "./db") return ledgerCurrencyReaders;
  if (name === "./currency-scope") return require("../currency-scope");
  if (name === "./currency-sync")
    return { ...require("../currency-sync"), ensureCurrencySyncSupported: async () => {} };
  if (name === "./credit-policy") return policyModule;
  if (name === "./credit-policy-cache") return cacheModule;
  if (name === "./credit-alert-cache") return require("../credit-alert-cache");
  if (name === "./credit-alert-policy") return require("../credit-alert-policy");
  if (name === "./db-tx") return { getDb: async () => db, getActiveVaultIdSyncMaybe: () => active };
  if (name === "./auth")
    return {
      captureCurrentSession: async () => ({ ...session }),
      applyForUnchangedLocalSession: guard,
      applyForCurrentSession: guard,
    };
  if (name === "./api") return { getBackendUrl: async () => "https://credit.fixture.invalid" };
  if (name === "./use-vault-role") return { readVaultRole: async () => role };
  if (name === "./effective-account") return { resolveAccountIdCandidates: async () => identities };
  if (name === "./money") return { toMinorUnits };
  if (name === "./money-sql") return { signedEntryMinorSumSql };
  if (name === "./entry-date") return require("../entry-date");
  if (name === "./tabs/history") return require("../tabs/history");
  if (name === "./credit-policy-events")
    return {
      emitCreditPoliciesChanged: () => {
        assert.equal(fixture.inTransaction, false, "policy notifications follow the commit");
        emits++;
      },
    };
  if (name === "./util/mutex") return { Mutex };
  if (name === "./sync/push")
    return {
      pushEvents: async () => {
        assert.equal(fixture.inTransaction, false);
      },
    };
  if (name === "./projection") return { applyEventMutex: new Mutex() };
  throw Error(`unexpected import ${name}`);
});
const tabs = compile<typeof import("../tabs/db")>("../tabs/db", (name) => {
  if (name === "../currency-scope") return require("../currency-scope");
  if (name === "../db-tx")
    return {
      getDb: async () => db,
      getActiveVaultIdSyncMaybe: () => active,
      getAccountIdSync: () => session.accountId,
    };
  if (name === "../projection") return { applyEventMutex: new Mutex() };
  if (name === "../ledger-events")
    return {
      emitLedgerApplied: () => {
        emits++;
      },
    };
  if (name === "./events") return { emitTabApplied: () => {} };
  if (name === "../money") return require("../money");
  if (name === "../entry-date") return require("../entry-date");
  if (name === "./direction") return require("../tabs/direction");
  if (name === "./history") return require("../tabs/history");
  if (name === "./recording-mode") return require("../tabs/recording-mode");
  if (name === "./errors") return require("../tabs/errors");
  if (name === "./wire") return require("../tabs/wire");
  throw Error(`unexpected tab import ${name}`);
});
const policy = (
  cap: number | null = 10000,
  mode: CreditPolicy["mode"] = "clerk_block",
  updated = 1,
): CreditPolicy => ({
  relationship_id: "r1",
  max_collect_minor: cap,
  max_pay_minor: 0,
  mode,
  updated_at_ms: updated,
});
const realFetch = globalThis.fetch;
let getReply: CreditPolicy[] = [];
let deferGET: Promise<void> | null = null;
globalThis.fetch = async (_url, init) => {
  assert.equal(fixture.inTransaction, false, "network never holds SQLite transaction");
  if (init?.method === "PUT") {
    puts++;
    const p = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ...p, updated_at_ms: Date.now() + puts }));
  }
  const response = getReply.slice();
  if (deferGET) await deferGET;
  return new Response(JSON.stringify(response));
};
const cached = () =>
  fixture.prepare("SELECT * FROM customer_credit_limits WHERE vault_id='v1'").get() as
    | (CreditPolicy & { sync_pending: number })
    | undefined;
function resetSession(jwt: string | null, accountId: string | null) {
  session = { jwt, accountId, bindingVersion: session.bindingVersion + 1 };
}
async function editorLimitsAndRecovery() {
  const staff = "editor-account";
  let version = 1000;
  const ownPolicy = (restrictEditors: boolean, mode: CreditPolicy["mode"] = "clerk_block") => ({
    ...policy(10000, mode, ++version),
    relationship_id: "r2",
    restrict_editors: restrictEditors,
  });
  const cacheOwn = async (restrictEditors: boolean, mode: CreditPolicy["mode"] = "clerk_block") => {
    await cacheCreditPolicies(db, "v2", [ownPolicy(restrictEditors, mode)], version + 1);
  };
  const setOverride = (value: "inherit" | "enforce" | "bypass") => {
    fixture
      .prepare(
        "INSERT INTO vault_member_credit_permissions VALUES('v2',?,?,?) ON CONFLICT(vault_id,account_id) DO UPDATE SET credit_limit_override=excluded.credit_limit_override,updated_at_ms=excluded.updated_at_ms",
      )
      .run(staff, value, ++version);
  };
  const create = (
    id: string,
    target: string,
    amount: number,
    at: number,
    type: "debt" | "payment" = "debt",
  ) =>
    ({
      event_id: id,
      event_type: "entry_created",
      vault_id: "v2",
      relationship_id: "r2",
      target_id: target,
      actor_account_id: staff,
      author_user_id_local_only: "self",
      origin: "local",
      appended_at: at,
      server_acked_at: null,
      rejected_at: null,
      hlc: { pms: at, l: 0, did: "editor-device" },
      device_id: "editor-device",
      payload_schema: 1,
      payload: {
        entry_id: target,
        relationship_id: "r2",
        type,
        amount_afn: amount,
        note: "Original note",
        occurred_at_ms: at,
      },
    }) as EntryCreatedEvent;
  const amend = (
    id: string,
    base: EntryCreatedEvent,
    changes: EntryAmendedEvent["payload"]["changes"],
    at: number,
  ) =>
    ({
      ...base,
      event_id: id,
      event_type: "entry_amended",
      appended_at: at,
      hlc: { ...base.hlc, pms: at },
      payload: { changes },
    }) as EntryAmendedEvent;
  const deletion = (id: string, base: EntryCreatedEvent, at: number) =>
    ({
      ...base,
      event_id: id,
      event_type: "entry_deleted",
      appended_at: at,
      hlc: { ...base.hlc, pms: at },
      payload: {},
    }) as EntryDeletedEvent;
  const store = async (event: LedgerEvent, apply = true) => {
    fixture
      .prepare(
        "INSERT INTO event_log(event_id,vault_id,relationship_id,event_type,target_id,payload_json,applied_at,appended_at,server_acked_at,actor_account_id,hlc_physical_ms,hlc_logical,hlc_device_id,author_user_id_local_only,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        event.event_id,
        event.vault_id,
        event.relationship_id,
        event.event_type,
        event.target_id,
        JSON.stringify(event.payload),
        apply ? event.hlc.pms : null,
        event.appended_at,
        event.server_acked_at,
        event.actor_account_id,
        event.hlc.pms,
        event.hlc.l,
        event.hlc.did,
        event.author_user_id_local_only,
        event.origin,
      );
    if (!apply) return;
    await captureCreditMutationBaseline(db, event);
    if (event.event_type === "entry_created") await entryAppliers.applyEntryCreated(db, event);
    else if (event.event_type === "entry_amended") await entryAppliers.applyEntryAmended(db, event);
    else if (event.event_type === "entry_deleted") await entryAppliers.applyEntryDeleted(db, event);
  };
  const proposed = create("editor-proposal", "editor-money", 25, 100);
  assert.equal(
    validCreditPolicy({ ...ownPolicy(true), restrict_editors: 1 as unknown as boolean }),
    false,
  );
  await cacheOwn(false);
  assert.equal(
    await requiresCreditAdmission(db, proposed, "editor"),
    false,
    "clerk-only hard limits leave ordinary editors exempt",
  );
  assert.equal(await requiresCreditAdmission(db, proposed, "clerk"), true);
  await cacheOwn(true);
  assert.equal(
    await requiresCreditAdmission(db, proposed, "editor"),
    true,
    "an own editor restriction requires admission",
  );
  const readOwn = await credit.readCreditPolicy("r2", "v2");
  assert.equal(readOwn?.restrict_editors, true, "SQLite policy reads normalize to a boolean");
  assert.equal(validCreditPolicy(readOwn!), true, "a read policy can be saved again");
  const defaults = { ...ownPolicy(true), relationship_id: KAATA_DEFAULT_CREDIT_ID };
  await cacheCreditPolicies(db, "v2", [defaults], version + 1);
  assert.equal(
    await hardLimitApplies(db, "v2", "r2", "editor", staff),
    true,
    "an editor restriction in the kaata default applies",
  );
  assert.equal((await credit.readCreditPoliciesForPeople("v2")).p2.restrict_editors, true);
  await cacheCreditPolicies(db, "v2", [defaults, ownPolicy(false)], version + 1);
  assert.equal(
    await hardLimitApplies(db, "v2", "r2", "editor", staff),
    false,
    "the customer's own policy overrides the default's role scope",
  );
  setOverride("enforce");
  assert.equal(
    await requiresCreditAdmission(db, proposed, "editor"),
    true,
    "an individual enforce exception includes an otherwise exempt editor",
  );
  for (const privileged of ["owner", "manager"] as const)
    assert.equal(
      await requiresCreditAdmission(db, proposed, privileged),
      false,
      `${privileged} authority is never reduced by an exception`,
    );
  await cacheOwn(false, "warn");
  assert.equal(
    await requiresCreditAdmission(db, proposed, "editor"),
    false,
    "enforce never converts a warning into a restriction",
  );
  assert.equal(await hardLimitApplies(db, "v2", "r2", "clerk", staff), false);
  await cacheOwn(true);
  setOverride("bypass");
  assert.equal(
    await requiresCreditAdmission(db, proposed, "editor"),
    false,
    "bypass exempts restricted editors",
  );
  assert.equal(
    await requiresCreditAdmission(db, proposed, "clerk"),
    false,
    "bypass exempts clerks too",
  );
  setOverride("inherit");
  assert.equal(await requiresCreditAdmission(db, proposed, "editor"), true);
  assert.equal(
    await requiresCreditAdmission(db, { ...proposed, server_acked_at: 1 }, "editor"),
    false,
  );
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES('signed-out-editor-admission','v2','vault_member_added',?,?,1,1,0,'editor-device')",
    )
    .run(staff, JSON.stringify({ account_id: staff, role: "editor" }));
  fixture.prepare("INSERT INTO vault_members_mirror VALUES('v2',?,'editor',NULL)").run(staff);
  fixture
    .prepare(
      "INSERT INTO vault_device_registry(vault_id,account_id,device_id,device_pubkey) VALUES('v2',?,'editor-device','editor-key')",
    )
    .run(staff);
  resetSession(null, null);
  identities = [staff];
  await cacheOwn(false);
  setOverride("enforce");
  for (const unsigned of [
    proposed,
    amend("signed-out-editor-edit", proposed, { amount_afn: 60 }, 110),
    deletion("signed-out-editor-delete", proposed, 120),
  ]) {
    const localUnsigned = { ...unsigned, actor_account_id: null };
    const gate = await roleGate.checkRoleForEvent(db, localUnsigned);
    assert.equal(gate.ok, true);
    assert.equal(gate.current_role, "editor");
    assert.equal(gate.current_account_id, staff, "persisted identity survives sign-out");
    assert.equal(
      await requiresCreditAdmission(
        db,
        localUnsigned,
        gate.current_role ?? undefined,
        gate.current_account_id,
      ),
      true,
      "signed-out editor exceptions apply to every financial mutation",
    );
  }
  fixture
    .prepare(
      "INSERT INTO vault_member_credit_permissions VALUES('v2','claimed-bypass','bypass',100)",
    )
    .run();
  const forged = {
    ...proposed,
    origin: "remote",
    actor_account_id: "claimed-bypass",
    event_sig_b64: "fixture",
    signer_device_pubkey: "editor-key",
  } as EntryCreatedEvent;
  const authenticated = await roleGate.checkRoleForEvent(db, forged);
  assert.equal(authenticated.ok, true, JSON.stringify(authenticated));
  assert.equal(
    authenticated.current_account_id,
    staff,
    "signature-bound identity wins over the claimed actor",
  );
  assert.equal(
    await requiresCreditAdmission(
      db,
      forged,
      authenticated.current_role ?? undefined,
      authenticated.current_account_id,
    ),
    true,
    "a claimed bypass cannot defeat the authenticated editor's enforce exception",
  );
  await cacheOwn(true);
  assert.equal(
    await requiresCreditAdmission(db, forged, "editor"),
    true,
    "remote admission never trusts a claimed wire bypass without authenticated identity",
  );
  setOverride("inherit");
  console.log(
    "PASS own/default editor restrictions, typed policy round trips, inherit/enforce/bypass, warn-only and owner/admin authority",
  );

  const base = create("editor-base", "editor-target", 40, 200);
  await store({ ...base, server_acked_at: 201 });
  const moneyEdit = amend("editor-pending-edit", base, { amount_afn: 90 }, 210);
  const noteEdit = amend("editor-note-only", base, { note: "Text only" }, 211);
  assert.equal(
    await requiresCreditAdmission(db, moneyEdit, "editor"),
    true,
    "money edits obey editor restrictions",
  );
  assert.equal(
    await requiresCreditAdmission(db, noteEdit, "editor"),
    false,
    "note-only edits stay offline",
  );
  assert.equal(
    await requiresCreditAdmission(
      db,
      amend("editor-date-only", base, { occurred_at_ms: 50 }, 212),
      "editor",
    ),
    false,
    "date-only edits stay offline because they do not move the recorded exposure boundary",
  );
  await store(moneyEdit, false);
  await deferCreditAdmission(db, moneyEdit);
  assert.equal(
    (fixture.prepare("SELECT amount_afn FROM entries WHERE id='editor-target'").get() as any)
      .amount_afn,
    40,
  );
  await cacheOwn(false, "warn");
  setOverride("bypass");
  assert.equal(
    await requiresCreditAdmission(db, moneyEdit, "manager"),
    true,
    "a pending edit survives a promotion, policy change and bypass until the server decides",
  );
  assert.equal(
    await requiresCreditAdmission(db, { ...moneyEdit, server_acked_at: 1 }, "manager"),
    false,
  );
  await assert.rejects(
    requiresCreditAdmission(db, noteEdit, "editor"),
    CreditMutationAdmissionError,
    "an outstanding money edit prevents editing the old recorded row again",
  );
  const pendingIntent = (await credit.listCreditIntents("p2", "v2")).find(
    (intent) => intent.id === moneyEdit.event_id,
  )!;
  assert.equal(pendingIntent.mutation, "edit");
  assert.equal(pendingIntent.amount_afn, 90);
  fixture
    .prepare("UPDATE credit_admission_intents SET status='refused' WHERE event_id=?")
    .run(moneyEdit.event_id);
  assert.equal(
    await requiresCreditAdmission(db, moneyEdit, "editor"),
    true,
    "a terminally refused attempt cannot apply after permissions change",
  );
  const pendingDelete = deletion("editor-pending-delete", base, 215);
  await cacheOwn(true);
  setOverride("inherit");
  assert.equal(
    await requiresCreditAdmission(db, pendingDelete, "editor"),
    true,
    "deletions also change financial exposure",
  );
  await store(pendingDelete, false);
  await deferCreditAdmission(db, pendingDelete);
  await cacheOwn(false, "warn");
  assert.equal(
    await requiresCreditAdmission(db, pendingDelete, "owner"),
    true,
    "a pending deletion remains deferred through a promotion",
  );
  assert.equal(
    (await credit.listCreditIntents("p2", "v2")).find(
      (intent) => intent.id === pendingDelete.event_id,
    )?.mutation,
    "delete",
  );
  console.log(
    "PASS editor money edits/deletes, offline note edits, unchanged recorded amounts and durable pending mutations through role/permission changes",
  );

  const original = create("rebuild-base", "rebuild-target", 40, 300);
  const refusedEdit = amend("rebuild-refused-edit", original, { amount_afn: 90 }, 310);
  const concurrentNote = amend(
    "rebuild-concurrent-note",
    original,
    { note: "A newer independent note" },
    320,
  );
  await store({ ...original, server_acked_at: 301 });
  await store(refusedEdit);
  await store(concurrentNote);
  fixture
    .prepare(
      "UPDATE entries SET accepted_at=302,is_settled=1,settled_at=303 WHERE id='rebuild-target'",
    )
    .run();
  await db.withTransactionAsync(async () => {
    assert.equal(
      await revertRefusedClerkTally(db, refusedEdit.event_id, "credit_limit_exceeded", 400),
      true,
    );
  });
  const restored = fixture.prepare("SELECT * FROM entries WHERE id='rebuild-target'").get() as any;
  assert.equal(restored.amount_afn, 40, "a refused edit restores the admitted amount");
  assert.equal(
    restored.note,
    "A newer independent note",
    "an independent concurrent note survives recovery",
  );
  assert.equal(restored.current_event_id, concurrentNote.event_id);
  assert.equal(restored.accepted_at, 302);
  assert.equal(restored.is_settled, 1);
  assert.equal(restored.settled_at, 303);
  assert.equal(JSON.parse(restored.field_hlcs).amount_afn.pms, 300);
  assert.equal(JSON.parse(restored.field_hlcs).note.pms, 320);
  const rejectedEdit = fixture
    .prepare("SELECT applied_at,rejected_at FROM event_log WHERE event_id=?")
    .get(refusedEdit.event_id) as any;
  assert.equal(rejectedEdit.applied_at, null);
  assert.equal(rejectedEdit.rejected_at, 400);
  assert.equal(
    await revertRefusedClerkTally(db, refusedEdit.event_id, "credit_limit_exceeded", 401),
    false,
  );

  const paid = create("delete-rebuild-base", "delete-rebuild-target", 20, 500, "payment");
  const refusedDelete = deletion("delete-rebuild-refused", paid, 510);
  const noteAfterDelete = amend(
    "delete-rebuild-note",
    paid,
    { note: "Concurrent note after rejected deletion" },
    520,
  );
  await store({ ...paid, server_acked_at: 501 });
  await store(refusedDelete);
  await store(noteAfterDelete);
  fixture
    .prepare(
      "UPDATE entries SET disputed_at=502,disputed_reason='review retained' WHERE id='delete-rebuild-target'",
    )
    .run();
  assert.equal(
    (
      fixture
        .prepare("SELECT is_deleted FROM entries WHERE id='delete-rebuild-target'")
        .get() as any
    ).is_deleted,
    1,
  );
  await db.withTransactionAsync(async () => {
    assert.equal(
      await revertRefusedClerkTally(db, refusedDelete.event_id, "credit_limit_exceeded", 600),
      true,
    );
  });
  const restoredDelete = fixture
    .prepare("SELECT * FROM entries WHERE id='delete-rebuild-target'")
    .get() as any;
  assert.equal(restoredDelete.is_deleted, 0);
  assert.equal(restoredDelete.deleted_at, null);
  assert.equal(restoredDelete.type, "payment");
  assert.equal(restoredDelete.amount_afn, 20);
  assert.equal(restoredDelete.note, "Concurrent note after rejected deletion");
  assert.equal(restoredDelete.disputed_at, 502);
  assert.equal(restoredDelete.disputed_reason, "review retained");
  const refusedIntents = await credit.listCreditIntents("p2", "v2");
  assert.equal(
    refusedIntents.find((intent) => intent.id === refusedDelete.event_id)?.admission_status,
    "refused",
  );
  assert.equal(
    refusedIntents.find((intent) => intent.id === refusedDelete.event_id)?.mutation,
    "delete",
  );
  console.log(
    "PASS terminal edit/delete recovery replays lawful money and concurrent notes, preserves review/settlement metadata and restores tombstones",
  );

  // Snapshot bootstrap installs lawful rows without their original create
  // events. A before-image must preserve that money through a stale-policy
  // refusal, including independent changes received while offline.
  const snapshot = create("snapshot-creation-absent", "snapshot-target", 65, 700);
  await entryAppliers.applyEntryCreated(db, snapshot);
  fixture.prepare("UPDATE entries SET accepted_at=701 WHERE id='snapshot-target'").run();
  const snapshotEdit = amend("snapshot-refused-edit", snapshot, { amount_afn: 95 }, 710);
  const snapshotNote = amend(
    "snapshot-independent-note",
    snapshot,
    { note: "Keep snapshot note" },
    720,
  );
  await store(snapshotEdit);
  await store(snapshotNote);
  await db.withTransactionAsync(async () => {
    assert.equal(
      await revertRefusedClerkTally(db, snapshotEdit.event_id, "credit_limit_exceeded", 730),
      true,
    );
  });
  const restoredSnapshot = fixture
    .prepare("SELECT * FROM entries WHERE id='snapshot-target'")
    .get() as any;
  assert.equal(restoredSnapshot.amount_afn, 65);
  assert.equal(restoredSnapshot.note, "Keep snapshot note");
  assert.equal(restoredSnapshot.accepted_at, 701);

  const snapshotPaid = create(
    "snapshot-payment-absent",
    "snapshot-paid-target",
    35,
    800,
    "payment",
  );
  await entryAppliers.applyEntryCreated(db, snapshotPaid);
  const snapshotDelete = deletion("snapshot-refused-delete", snapshotPaid, 810);
  const snapshotDeleteNote = amend(
    "snapshot-delete-note",
    snapshotPaid,
    { note: "Snapshot delete note" },
    820,
  );
  await store(snapshotDelete);
  await store(snapshotDeleteNote);
  await db.withTransactionAsync(async () => {
    assert.equal(
      await revertRefusedClerkTally(db, snapshotDelete.event_id, "credit_limit_exceeded", 830),
      true,
    );
  });
  const restoredSnapshotDelete = fixture
    .prepare("SELECT * FROM entries WHERE id='snapshot-paid-target'")
    .get() as any;
  assert.equal(restoredSnapshotDelete.is_deleted, 0);
  assert.equal(restoredSnapshotDelete.deleted_at, null);
  assert.equal(restoredSnapshotDelete.amount_afn, 35);
  assert.equal(restoredSnapshotDelete.note, "Snapshot delete note");

  const sequence = create("snapshot-sequence-absent", "snapshot-sequence-target", 40, 900);
  await entryAppliers.applyEntryCreated(db, sequence);
  const firstEdit = amend("snapshot-first-refused", sequence, { amount_afn: 90 }, 910);
  const secondEdit = amend("snapshot-second-refused", sequence, { amount_afn: 100 }, 920);
  await store(firstEdit);
  await store(secondEdit);
  await db.withTransactionAsync(async () => {
    assert.equal(
      await revertRefusedClerkTally(db, firstEdit.event_id, "credit_limit_exceeded", 930),
      true,
    );
    assert.equal(
      await revertRefusedClerkTally(db, secondEdit.event_id, "credit_limit_exceeded", 931),
      true,
    );
  });
  assert.equal(
    (
      fixture
        .prepare("SELECT amount_afn FROM entries WHERE id='snapshot-sequence-target'")
        .get() as any
    ).amount_afn,
    40,
    "a later refusal cannot resurrect an earlier refused snapshot edit",
  );
  console.log(
    "PASS snapshot-seeded edit/delete rollback uses captured baselines and retains lawful amount, independent notes and metadata across sequential refusals",
  );
}
async function ownerArchiveAuthority() {
  for (const memberRole of ["owner", "manager", "editor", "clerk", "viewer"] as const) {
    const member = `archive-${memberRole}`;
    fixture
      .prepare(
        "INSERT INTO event_log(event_id,vault_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES(?,'v2','vault_member_added',?,?,1,1,0,'archive-device')",
      )
      .run(
        `archive-admission-${memberRole}`,
        member,
        JSON.stringify({ account_id: member, role: memberRole }),
      );
    fixture
      .prepare("INSERT INTO vault_members_mirror VALUES('v2',?,?,NULL)")
      .run(member, memberRole);
    for (const signedOut of [false, true]) {
      resetSession(signedOut ? null : `jwt-${member}`, signedOut ? null : member);
      identities = [member];
      for (const [key, value] of [
        ["archived_at", "1700"],
        ["archived_at", ""],
        ["name", "A new Kaata name"],
        ["currency", "USD"],
      ]) {
        const isArchive = key === "archived_at";
        const allowed = memberRole === "owner" || (!isArchive && memberRole === "manager");
        const mutation = {
          event_id: `archive-check-${memberRole}-${signedOut}-${key}-${value}`,
          event_type: "vault_setting_set",
          vault_id: "v2",
          relationship_id: null,
          target_id: "v2",
          actor_account_id: signedOut ? null : member,
          author_user_id_local_only: "self",
          origin: "local",
          appended_at: 1800,
          server_acked_at: null,
          rejected_at: null,
          hlc: { pms: 1800, l: 0, did: "archive-device" },
          device_id: "archive-device",
          payload_schema: 1,
          payload: { key, value },
        } as LedgerEvent;
        const verdict = await roleGate.checkRoleForEvent(db, mutation);
        assert.equal(
          verdict.ok,
          allowed,
          `${memberRole} ${signedOut ? "signed out" : "signed in"} ${key}=${value}: ${JSON.stringify(verdict)}`,
        );
        assert.equal(
          verdict.current_role,
          memberRole,
          "configuration authority uses the persisted member role",
        );
        if (!verdict.ok) {
          assert.equal(verdict.reason, "insufficient_role");
          assert.equal(verdict.required_role, isArchive ? "owner" : "manager");
        } else {
          assert.equal(verdict.current_account_id, member);
        }
      }
    }
  }
  console.log(
    "PASS owner-only archive/unarchive gate, Admin name/currency authority, and signed-out editor/clerk/viewer configuration denial",
  );
}
async function unchangedPolicyRefreshes() {
  resetSession("jwt-noop", "noop-owner");
  const rowChanges = () =>
    (fixture.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  const refresh = async (rows: CreditPolicy[], expectedChanges: number) => {
    getReply = rows;
    const beforeEmits = emits;
    const beforeChanges = rowChanges();
    await credit.refreshCreditPolicies("v1");
    assert.equal(
      rowChanges() - beforeChanges,
      expectedChanges,
      "only changed cache rows are written",
    );
    assert.equal(
      emits - beforeEmits,
      expectedChanges > 0 ? 1 : 0,
      "one committed cache change notifies; unchanged responses do not",
    );
  };
  await refresh([], 0);
  await refresh([], 0);

  let rows = [
    policy(null, "warn", 10),
    { ...policy(null, "warn", 10), relationship_id: KAATA_DEFAULT_CREDIT_ID },
  ];
  await refresh(rows, 2);
  await refresh(rows, 0);
  await refresh(rows, 0);

  // Exercise real changes independently for both customer and kaata default.
  // Equal-version differences retain the cache's existing <= timestamp contract.
  for (const index of [0, 1]) {
    for (const patch of [
      { max_collect_minor: 0 },
      { max_pay_minor: null },
      { mode: "clerk_block" as const },
      { restrict_editors: true },
      { updated_at_ms: 11 },
      { restrict_editors: false },
    ]) {
      rows = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      await refresh(rows, 1);
      await refresh(rows, 0);
      const stored = await credit.readCreditPolicy(rows[index].relationship_id, "v1");
      assert.deepEqual(stored, {
        ...rows[index],
        currency: "AFN",
        restrict_editors: !!rows[index].restrict_editors,
      });
    }
  }
  // Omitted false and explicit false are the same persisted restriction.
  await refresh(
    rows.map(({ restrict_editors: _, ...row }) => row),
    0,
  );
  await refresh([rows[1]], 1);
  await refresh([rows[1]], 0);
  await refresh([], 1);
  await refresh([], 0);
  await refresh([{ ...policy(), relationship_id: "r2" }], 0);
  const wrongVaultRows = fixture
    .prepare("SELECT count(*) AS n FROM customer_credit_limits WHERE vault_id='v1'")
    .get() as { n: number };
  assert.equal(wrongVaultRows.n, 0, "a different vault's relationship is not cached");

  // Partial work rolls back before any notification if a response is invalid.
  getReply = [rows[1], policy(1.5)];
  const beforeInvalid = emits;
  await assert.rejects(credit.refreshCreditPolicies("v1"), /Invalid credit policy response/);
  assert.equal(emits, beforeInvalid);
  assert.equal(await credit.readCreditPolicy(KAATA_DEFAULT_CREDIT_ID, "v1"), null);
  assert.equal(await credit.readCreditPolicy("r1", "v1"), null);

  assert.equal(await cacheCreditPolicies(db, "v1", [policy(100, "warn", 20)], 21), true);
  await refresh([policy(1, "clerk_block", 10)], 0);
  assert.equal(cached()?.max_collect_minor, 100, "an older response cannot change the cache");
  fixture.prepare("UPDATE customer_credit_limits SET sync_pending=1 WHERE vault_id='v1'").run();
  assert.equal(await cacheCreditPolicies(db, "v1", [], 30), false);
  assert.equal(await cacheCreditPolicies(db, "v1", [policy(1, "clerk_block", 30)], 30), false);
  assert.equal(cached()?.max_collect_minor, 100, "pending local intent remains unchanged");
  assert.equal(cached()?.sync_pending, 1);

  fixture.exec("DELETE FROM customer_credit_limits; DELETE FROM kaata_credit_defaults");
  resetSession(null, null);
  getReply = [];
  puts = 0;
  emits = 0;
  console.log(
    "PASS unchanged policy GETs perform zero row changes and notifications; real/default changes, removals, rollback, scope and pending intent retain their contracts",
  );
}

async function run() {
  await applyCurrencyMigration(fixture);
  await preAlertSchemaWarningChecks();
  await unchangedPolicyRefreshes();
  assert.equal(creditExceeded(policy(), 0, 10000), false);
  assert.equal(creditExceeded(policy(), 10000, 10001), true);
  assert.equal(
    creditExceeded(policy(), 15000, 14999),
    false,
    "repayment allowed already above cap",
  );
  assert.equal(
    creditExceeded(policy(), 10, -1),
    true,
    "crossing zero creates forbidden opposite exposure",
  );
  assert.equal(creditExceeded(policy(null), 0, 100000), false);
  assert.equal(creditExceeded(policy(0), 0, 1), true, "zero is a real cap");
  assert.equal(validCreditPolicy(policy(1.5)), false);
  assert.throws(() => creditExceeded(policy(), Number.MAX_SAFE_INTEGER + 1, 0), RangeError);
  console.log("PASS directional exposure, zero/unlimited caps, repayment and exact integer limits");

  for (const [currency, collect, pay] of [
    ["USD", 10029, 25029],
    ["AFN", 20031, 50031],
  ] as const) {
    const p: CreditPolicy = {
      ...policy(),
      currency,
      max_collect_minor: collect,
      max_pay_minor: pay,
    };
    for (const [sign, cap] of [
      [1, collect],
      [-1, pay],
    ] as const) {
      const near = Math.ceil((cap * 4) / 5);
      for (const [exposure, status] of [
        [near - 1, "none"],
        [near, "near"],
        [cap - 1, "near"],
        [cap, "reached"],
        [cap + 1, "over"],
      ] as const) {
        assert.equal(
          credit.creditStatusForBalance(p, fromMinorUnits(sign * exposure)),
          status,
          `${currency} ${sign > 0 ? "collect" : "pay"} status respects the exact minor-unit boundary at ${exposure}`,
        );
      }
      assert.equal(creditExceeded(p, 0, sign * cap), false, "Reaching the cap remains allowed");
      assert.equal(
        creditExceeded(p, sign * cap, sign * (cap + 1)),
        true,
        "Only increasing beyond the cap exceeds it",
      );
    }
  }
  assert.equal(creditStatusForExposure(0, 0), "none", "No debt is not a reached zero cap");
  assert.equal(creditStatusForExposure(0, 1), "over", "A zero cap still forbids positive exposure");
  assert.equal(creditStatusForExposure(100, 0), "none");
  assert.equal(creditStatusForExposure(null, 100), "none");
  assert.equal(creditStatusForExposure(undefined, 100), "none");
  assert.equal(credit.creditStatusForBalance(policy(0), 0), "none");
  assert.equal(credit.creditStatusForBalance(null, 100), "none");
  console.log(
    "PASS exact near/reached/over status for both directions and currencies without changing admission boundaries",
  );

  fixture.prepare("INSERT INTO vault_members_mirror VALUES('v1',?,'owner',NULL)").run(localOwner);
  await assert.rejects(
    credit.saveCreditPolicy("v1", policy()),
    credit.CreditOnlineSaveRequiredError,
  );
  await credit.saveCreditPolicy("v1", policy(10000, "warn"));
  assert.equal(cached()?.sync_pending, 1, "actual local founder membership may configure warnings");
  await cacheCreditPolicies(db, "v1", [], Date.now() + 1000);
  assert.equal(
    cached()?.max_collect_minor,
    10000,
    "empty GET cannot erase unpublished local policy",
  );
  await cacheCreditPolicies(db, "v1", [policy(5, "warn", Date.now() + 2000)], Date.now() + 1000);
  assert.equal(cached()?.sync_pending, 1, "server cache cannot overwrite local intent");
  fixture.prepare("UPDATE vaults SET account_id='old-account' WHERE id='v1'").run();
  await assert.rejects(credit.saveCreditPolicy("v1", policy(5, "warn")), /require sign-in/);
  fixture.prepare("UPDATE vaults SET account_id=NULL WHERE id='v1'").run();
  fixture.prepare("INSERT INTO vault_members_mirror VALUES('v1','someone','clerk',NULL)").run();
  await assert.rejects(credit.saveCreditPolicy("v1", policy(5, "warn")), /require sign-in/);
  fixture.prepare("DELETE FROM vault_members_mirror").run();
  role = "clerk";
  await assert.rejects(credit.saveCreditPolicy("v1", policy(5, "warn")), /Manager required/);
  role = "owner";
  console.log(
    "PASS local policy survives cache replacement and shared/no-JWT or clerk config is refused",
  );

  resetSession("jwt-a", "a");
  getReply = [];
  await credit.refreshCreditPolicies("v1");
  assert.equal(puts, 1);
  assert.equal(cached()?.sync_pending, 0, "first sign-in publishes local policy before GET");
  assert.equal(
    cached()?.max_collect_minor,
    10000,
    "empty response begun before publication cannot erase newer save",
  );
  fixture.prepare("DELETE FROM customer_credit_limits").run();
  // Restore/cache accepts only known same-vault contacts and retains newer saves.
  await cacheCreditPolicies(db, "v1", [policy(100, "warn", 10)], 20);
  await cacheCreditPolicies(
    db,
    "v1",
    [policy(1, "clerk_block", 5), { ...policy(), relationship_id: "r2" }],
    20,
  );
  assert.equal(cached()?.max_collect_minor, 100);
  assert.equal(
    (
      fixture
        .prepare(
          "SELECT count(*) AS n FROM customer_credit_limits WHERE vault_id='v1' AND relationship_id='r2'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  console.log(
    "PASS first sign-in uploads local policies; restore/cache preserves scope and newer values",
  );

  let release!: () => void;
  deferGET = new Promise<void>((r) => {
    release = r;
  });
  getReply = [policy(1, "warn", Date.now() + 99999)];
  const late = credit.refreshCreditPolicies("v1");
  await new Promise((r) => setTimeout(r, 0));
  await credit.saveCreditPolicy("v1", policy(500));
  const beforeLateReply = emits;
  release();
  await late;
  deferGET = null;
  assert.equal(emits, beforeLateReply, "a version-superseded GET emits no false policy change");
  assert.equal(
    cached()?.max_collect_minor,
    500,
    "old GET cannot replace a save begun while it was outstanding",
  );
  deferGET = new Promise<void>((r) => {
    release = r;
  });
  getReply = [policy(2, "warn", Date.now() + 99999)];
  const switched = credit.refreshCreditPolicies("v1");
  await new Promise((r) => setTimeout(r, 0));
  resetSession("jwt-b", "b");
  const beforeSwitchedReply = emits;
  release();
  await assert.rejects(switched, SessionChangedError);
  deferGET = null;
  assert.equal(emits, beforeSwitchedReply, "another session's response cannot notify this session");
  assert.equal(cached()?.max_collect_minor, 500, "A reply cannot mutate B cache");
  console.log("PASS stale GET vs save and same-vault account-switch response guards");

  fixture
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run("legacy", "v1", "r1", "debt", 100, 100);
  assert.equal(
    await credit.creditBalanceInTx(db, "v1", "r1"),
    10000,
    "legacy major-unit amount remains100",
  );
  fixture
    .prepare(
      "INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,linked_at,currency)VALUES('t1','v1','r1','a',100,'AFN')",
    )
    .run();
  const tabEntry = fixture.prepare(
    "INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voided_by_entry_id)VALUES(?,'t1',1,1,'a','a_to_b',?,'entry',1,1,?,?)",
  );
  tabEntry.run("pending", 2000, "pending", null);
  tabEntry.run("rejected", 5000, "disputed", null);
  tabEntry.run("cancelled", 3000, "pending", "void");
  fixture
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,disputed_at) VALUES('cents','v1','r1','debt',0.01,101,NULL),('disputed','v1','r1','debt',99,101,1)",
    )
    .run();
  assert.equal(
    await credit.creditBalanceInTx(db, "v1", "r1"),
    2001,
    "pending counts; exact boundary, rejected/cancelled/disputed do not",
  );
  fixture.prepare("UPDATE tab_links SET closed_at=200,role='b' WHERE tab_id='t1'").run();
  assert.equal(
    await credit.creditBalanceInTx(db, "v1", "r1"),
    -1999,
    "closed linked period keeps opposite perspective and prelink exclusion",
  );
  console.log(
    "PASS local plus shared exposure, cents, both party perspectives and frozen link boundary",
  );

  // A rejected replacement opening cannot make earlier exposure disappear
  // from the real policy warning/admission input.
  fixture.exec(`INSERT INTO vaults(id,account_id,archived_at,registered_with_server_at,vault_trust_anchor_pubkey) VALUES('v-check',NULL,NULL,NULL,'anchor');
    INSERT INTO relationships VALUES('r-check','v-check','p-check',1,NULL);
    INSERT INTO users VALUES('p-check',0,'Checkpoint customer');
    INSERT INTO customer_credit_limits(vault_id,relationship_id,currency,max_collect_minor,max_pay_minor,mode,updated_at_ms)
      VALUES('v-check','r-check','AFN',35000,35000,'clerk_block',1);
    INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,linked_at,currency,closed_at,history_order)
      VALUES('credit-old','v-check','r-check','a',100,'AFN',200,'10'),
            ('credit-new','v-check','r-check','b',300,'AFN',NULL,'11');
    INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('credit-old-loan','credit-old',1,1,'a','a_to_b',30000,'opening',1,1,'accepted'),
            ('credit-new-opening','credit-new',1,1,'b','b_to_a',30000,'opening',2,2,'disputed');`);
  try {
    const before = await credit.creditBalanceInTx(db, "v-check", "r-check");
    assert.equal(before, 30000, "rejected opening preserves older accepted 300 exposure");
    assert.equal(await credit.creditWarning("p-check", "debt", 100, "v-check"), true);
    assert.equal(
      creditExceeded(
        { ...policy(350, "clerk_block", 1), max_collect_minor: 35000 },
        before,
        before + 10000,
      ),
      true,
      "the 350 cap refuses another100 against the real preserved300",
    );
    fixture.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('credit-new-gave','credit-new',2,2,'b','b_to_a',10000,'entry',3,3,'pending');`);
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      40000,
      "each period uses its own role; pending new100 counts once",
    );
    fixture.prepare("UPDATE tab_entries SET status='pending' WHERE id='credit-new-opening'").run();
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      40000,
      "a live pending opening absorbs prior300 without doublecounting",
    );
    fixture
      .prepare("UPDATE tab_entries SET amount_minor=10000 WHERE id='credit-new-opening'")
      .run();
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      20000,
      "pending-inclusive policy preserves the pending opening's recorded amount",
    );
    fixture
      .prepare(
        "UPDATE tab_entries SET voided_by_entry_id='withdrawal' WHERE id='credit-new-opening'",
      )
      .run();
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      40000,
      "withdrawing an opening restores the older recorded checkpoint",
    );
    fixture.exec(`INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at)
      VALUES('credit-before','v-check','r-check','debt',999,250),
            ('credit-after','v-check','r-check','debt',0.01,301);`);
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      40001,
      "post-latest private cents count once; earlier private history stays excluded",
    );
    fixture.exec(`INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('credit-new-repayment','credit-new',3,3,'b','a_to_b',40000,'entry',4,4,'pending');`);
    assert.equal(
      await credit.creditBalanceInTx(db, "v-check", "r-check"),
      1,
      "offsetting pending recorded flows reach zero without dropping privatecents",
    );
    const creditStarted = performance.now();
    for (let i = 0; i < 100; i++) await credit.creditBalanceInTx(db, "v-check", "r-check");
    console.log(
      `Cross-period recorded credit read: ${((performance.now() - creditStarted) / 100).toFixed(2)} ms/read on test host`,
    );
  } finally {
    fixture.prepare("DELETE FROM tab_links WHERE vault_id='v-check'").run();
    fixture.prepare("DELETE FROM entries WHERE vault_id='v-check'").run();
    fixture.prepare("DELETE FROM customer_credit_limits WHERE vault_id='v-check'").run();
    fixture.prepare("DELETE FROM relationships WHERE vault_id='v-check'").run();
    fixture.prepare("DELETE FROM users WHERE id='p-check'").run();
    fixture.prepare("DELETE FROM vaults WHERE id='v-check'").run();
  }
  console.log(
    "PASS recorded credit checkpoints preserve pending-inclusive caps across rejected/cancelled openings, party reversal, zero and private boundaries",
  );

  const event = {
    event_id: "attempt",
    event_type: "entry_created",
    vault_id: "v1",
    relationship_id: "r1",
    target_id: "money-id",
    server_acked_at: null,
    payload: {
      entry_id: "money-id",
      relationship_id: "r1",
      type: "debt",
      amount_afn: 25,
      note: "test",
      occurred_at_ms: 300,
    },
  } as EntryCreatedEvent;
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,payload_json,applied_at,appended_at,event_type) VALUES(?,?,?,123,300,'entry_created')",
    )
    .run(event.event_id, "v1", JSON.stringify(event.payload));
  assert.equal(needsCreditAdmission(event, "clerk"), true);
  assert.equal(
    needsCreditAdmission(event, "editor"),
    true,
    "editor money mutations are admission candidates",
  );
  await deferCreditAdmission(db, event);
  assert.equal(
    (
      fixture.prepare("SELECT applied_at FROM event_log WHERE event_id='attempt'").get() as {
        applied_at: number | null;
      }
    ).applied_at,
    null,
  );
  assert.equal(
    fixture.prepare("SELECT id FROM entries WHERE id='money-id'").get(),
    undefined,
    "pending intent is not recorded money",
  );
  assert.equal((await credit.listCreditIntents("p1", "v1"))[0].admission_status, "pending");
  fixture
    .prepare("UPDATE credit_admission_intents SET status='refused' WHERE event_id='attempt'")
    .run();
  assert.equal((await credit.listCreditIntents("p1", "v1"))[0].admission_status, "refused");
  assert.equal(
    needsCreditAdmission({ ...event, server_acked_at: 1 }, "clerk"),
    false,
    "only trusted HTTPS ack releases admission",
  );
  console.log("PASS durable pending/refused intent stays separate from financial records");

  const link = await db.getFirstAsync<any>("SELECT * FROM tab_links WHERE tab_id='t1'");
  await tabs.queueTabMutation(
    link,
    {
      id: "queued",
      tab_id: "t1",
      op: "append",
      payload: JSON.stringify({
        id: "queued",
        direction: "b_to_a",
        amount: "12.34",
        occurred_at_ms: 301,
      }),
      created_at: 301,
      attempts: 0,
      next_at: null,
      last_error: null,
    },
    { deferAppend: true },
  );
  assert.equal(fixture.prepare("SELECT id FROM tab_entries WHERE id='queued'").get(), undefined);
  assert.ok(fixture.prepare("SELECT id FROM tab_outbox WHERE id='queued'").get());
  assert.ok(
    (await credit.listCreditIntents("p1", "v1")).some(
      (r) => r.id === "queued" && r.admission_status === "pending",
    ),
  );
  await tabs.rejectTabOp(
    {
      id: "queued",
      tab_id: "t1",
      op: "append",
      payload: JSON.stringify({ direction: "b_to_a", amount: "12.34", occurred_at_ms: 301 }),
      created_at: 301,
      attempts: 0,
      next_at: null,
      last_error: null,
    },
    "credit_limit_exceeded",
  );
  assert.ok(
    (await credit.listCreditIntents("p1", "v1")).some(
      (r) => r.id === "queued" && r.admission_status === "refused",
    ),
  );
  assert.equal((await tabs.listFailedTabEntries("r1")).length, 1);
  assert.equal((await tabs.listFailedTabEntries("r1", { excludeCreditRefused: true })).length, 0);
  assert.equal(
    await credit.creditBalanceInTx(db, "v1", "r1"),
    -1999,
    "queued and refused attempts never change totals",
  );
  assert.ok(emits > 0, "policy/admission changes notify mounted consumers");
  console.log("PASS shared clerk queue/refusal is durable, absent from money, and shown only once");

  // The actual role gate resolves unsigned local appends using persisted identity,
  // while authenticated remote copies resolve the same signed device membership.
  resetSession(null, null);
  identities = [localClerk];
  fixture.exec(
    "DELETE FROM customer_credit_limits; DELETE FROM event_log; DELETE FROM vault_members_mirror; DELETE FROM vault_device_registry",
  );
  const addMember = fixture.prepare(
    "INSERT INTO event_log(event_id,vault_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES(?,'v1','vault_member_added',?,?,1,1,0,'d')",
  );
  addMember.run("founder", localOwner, JSON.stringify({ account_id: localOwner, role: "owner" }));
  addMember.run("clerk", localClerk, JSON.stringify({ account_id: localClerk, role: "clerk" }));
  fixture
    .prepare("INSERT INTO vault_members_mirror VALUES('v1',?,'owner',NULL),('v1',?,'clerk',NULL)")
    .run(localOwner, localClerk);
  fixture
    .prepare(
      "INSERT INTO vault_device_registry(vault_id,account_id,device_id,device_pubkey) VALUES('v1',?,'d','key')",
    )
    .run(localClerk);
  const localEvent = {
    ...event,
    event_id: "local-new",
    actor_account_id: null,
    origin: "local",
    hlc: { pms: 10, l: 0, did: "d" },
    device_id: "d",
    event_sig_b64: null,
  } as EntryCreatedEvent;
  const localGate = await roleGate.checkRoleForEvent(db, localEvent);
  assert.equal(localGate.ok, true);
  assert.equal(localGate.current_role, "clerk");
  assert.equal(
    await requiresCreditAdmission(db, localEvent, localGate.current_role ?? undefined),
    false,
    "never-cloud local paired origin remains offline",
  );
  const remoteEvent = {
    ...localEvent,
    origin: "remote",
    event_sig_b64: "fixture",
    signer_device_pubkey: "key",
  } as EntryCreatedEvent;
  const remoteGate = await roleGate.checkRoleForEvent(db, remoteEvent);
  assert.equal(remoteGate.ok, true, JSON.stringify(remoteGate));
  assert.equal(remoteGate.current_role, "clerk");
  assert.equal(
    await requiresCreditAdmission(db, remoteEvent, remoteGate.current_role ?? undefined),
    false,
    "mesh copy has same local admission decision",
  );
  // Clerks record offline unless the customer is under a hard ("restrict
  // clerks") limit (Matee, 2026-10-12). Codex's rule sent EVERY cloud clerk
  // tally through HTTPS admission, even with no limit, so clerks could not
  // work without internet.
  fixture.prepare("UPDATE vaults SET registered_with_server_at=0 WHERE id='v1'").run();
  fixture.prepare("UPDATE event_log SET server_acked_at=1 WHERE event_id='founder'").run();
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    false,
    "a cloud kaata without a hard limit records clerk tallies offline",
  );
  await cacheCreditPolicies(db, "v1", [policy(10000, "warn", 1)], 2);
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    false,
    "a warning limit never holds a clerk tally",
  );
  await cacheCreditPolicies(db, "v1", [policy(10000, "clerk_block", 3)], 4);
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "a hard limit on this customer needs the server's OK",
  );
  assert.equal(
    await requiresCreditAdmission(
      db,
      {
        ...localEvent,
        payload: { ...localEvent.payload, relationship_id: "r2" },
      } as EntryCreatedEvent,
      "clerk",
    ),
    false,
    "another customer without a limit is not held",
  );
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "owner"),
    false,
    "owners are never held",
  );
  fixture
    .prepare(
      "INSERT INTO credit_admission_intents(event_id,vault_id,relationship_id,status,reason) VALUES('local-new','v1','r1','pending',NULL)",
    )
    .run();
  await cacheCreditPolicies(db, "v1", [policy(10000, "warn", 5)], 6);
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "a deferred tally keeps waiting for the server's decision",
  );
  fixture.prepare("DELETE FROM credit_admission_intents WHERE event_id='local-new'").run();
  fixture.prepare("DELETE FROM customer_credit_limits").run();
  fixture.prepare("UPDATE vaults SET registered_with_server_at=NULL WHERE id='v1'").run();
  fixture.prepare("UPDATE event_log SET server_acked_at=NULL WHERE event_id='founder'").run();

  // A hard limit set on another phone that this clerk had not pulled: the
  // server refuses the offline tally on push. It leaves the balance for the
  // refused list instead of being retried forever.
  const offline = {
    entry_id: "offline-money",
    relationship_id: "r1",
    type: "debt",
    amount_afn: 40,
  };
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES('offline-evt','v1','entry_created','offline-money',?,9,9,0,'d')",
    )
    .run(JSON.stringify(offline));
  fixture
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,current_event_id) VALUES('offline-money','v1','r1','debt',40,9999999999999,'offline-evt')",
    )
    .run();
  const before = await credit.creditBalanceInTx(db, "v1", "r1");
  assert.equal(await revertRefusedClerkTally(db, "offline-evt", "credit_limit_exceeded", 99), true);
  assert.equal(
    await credit.creditBalanceInTx(db, "v1", "r1"),
    before - 4000,
    "the refused tally leaves the balance",
  );
  assert.ok(
    (await credit.listCreditIntents("p1", "v1")).some(
      (r) => r.id === "offline-evt" && r.admission_status === "refused",
    ),
    "and shows as not recorded",
  );
  assert.equal(
    await revertRefusedClerkTally(db, "offline-evt", "credit_limit_exceeded", 100),
    false,
    "a refused tally is not reverted twice",
  );
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES('built-on','v1','entry_created','amended-money',?,9,9,0,'d')",
    )
    .run(JSON.stringify({ ...offline, entry_id: "amended-money" }));
  fixture
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,current_event_id) VALUES('amended-money','v1','r1','debt',40,9,'later-amend')",
    )
    .run();
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,relationship_id,event_type,target_id,payload_json,applied_at,hlc_physical_ms,hlc_logical,hlc_device_id) VALUES('later-amend','v1','r1','entry_amended','amended-money',?,10,10,0,'d')",
    )
    .run(JSON.stringify({ changes: { amount_afn: 70 } }));
  assert.equal(
    await revertRefusedClerkTally(db, "built-on", "credit_limit_exceeded", 101),
    true,
    "a terminal refusal removes a tally even if a later local edit touched it",
  );
  assert.equal(fixture.prepare("SELECT id FROM entries WHERE id='amended-money'").get(), undefined);
  const refusedDescendant = fixture
    .prepare("SELECT applied_at,rejected_at FROM event_log WHERE event_id='later-amend'")
    .get() as any;
  assert.equal(
    refusedDescendant.applied_at,
    null,
    "unadmitted descendants of a refused creation cannot activate money later",
  );
  assert.equal(refusedDescendant.rejected_at, 101);
  identities = [localClerk, localOwner];
  const dual = await roleGate.checkRoleForEvent(db, { ...localEvent, event_id: "dual" });
  assert.equal(
    dual.current_role,
    "clerk",
    "persisted primary clerk beats stale founder alias after sign-out",
  );
  resetSession("jwt-owner", "owner");
  role = "owner";
  await assert.rejects(
    credit.saveCreditPolicy("v1", policy()),
    credit.ClerkCloudEnrollmentRequiredError,
  );
  fixture.prepare("DELETE FROM vault_members_mirror WHERE role='clerk'").run();
  fixture
    .prepare("INSERT INTO vault_members_mirror VALUES('v1','local:EDITOR0000000000','editor',NULL)")
    .run();
  await assert.rejects(
    credit.saveCreditPolicy("v1", { ...policy(), restrict_editors: true }),
    credit.ClerkCloudEnrollmentRequiredError,
    "enabling editor restrictions also requires local editors to enroll",
  );
  fixture.prepare("DELETE FROM vault_members_mirror WHERE role='editor'").run();

  // Kaata-wide default (Matee, 2026-10-12): it covers every customer without
  // their own limit, newly added ones included; a customer's own limit wins.
  fixture.prepare("INSERT INTO relationships VALUES('r3','v1','p3',1,NULL)").run();
  fixture.prepare("DELETE FROM customer_credit_limits").run();
  const kaataDefault = {
    ...policy(5000, "clerk_block", 20),
    relationship_id: KAATA_DEFAULT_CREDIT_ID,
  };
  await cacheCreditPolicies(
    db,
    "v1",
    [kaataDefault, { ...policy(9000, "warn", 20), relationship_id: "r3" }],
    21,
  );
  assert.deepEqual(
    await credit.readCreditPolicy(KAATA_DEFAULT_CREDIT_ID, "v1"),
    { ...kaataDefault, currency: "AFN", restrict_editors: false },
    "the default is cached in its own table",
  );
  assert.equal(
    (await credit.readEffectiveCreditPolicy("r1", "v1"))?.max_collect_minor,
    5000,
    "a customer without their own limit inherits the default",
  );
  assert.equal(
    (await credit.readEffectiveCreditPolicy("r3", "v1"))?.mode,
    "warn",
    "a customer's own limit wins over the default",
  );
  const people = await credit.readCreditPoliciesForPeople("v1");
  assert.equal(people.p1?.max_collect_minor, 5000, "home colours customers the default covers");
  assert.equal(people.p3?.max_collect_minor, 9000);
  assert.equal(await hardLimitApplies(db, "v1", "r1"), true, "a hard default holds clerk tallies");
  assert.equal(await hardLimitApplies(db, "v1", "r3"), false, "an own warn limit does not");
  await cacheCreditPolicies(db, "v1", [{ ...policy(9000, "warn", 20), relationship_id: "r3" }], 22);
  assert.equal(
    await credit.readCreditPolicy(KAATA_DEFAULT_CREDIT_ID, "v1"),
    null,
    "a server answer without the default removes it",
  );

  // Editing warns too (audit #24), counting only the change: r3 may owe 90.00
  // and already owes the 60.00 being edited.
  fixture
    .prepare(
      "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,created_at,disputed_at) VALUES('edit-me','v1','r3','debt',60,30,NULL),('rejected-row','v1','r3','debt',500,31,1)",
    )
    .run();
  assert.equal(await credit.creditWarningForEdit("edit-me", 90, "v1"), false, "up to the cap");
  assert.equal(
    await credit.creditWarning("p3", "debt", 90, "v1"),
    true,
    "a NEW 90.00 would pass it",
  );
  assert.equal(await credit.creditWarningForEdit("edit-me", 95, "v1"), true, "past the cap");
  assert.equal(
    await credit.creditWarningForEdit("edit-me", 50, "v1"),
    false,
    "lowering never warns",
  );
  assert.equal(
    await credit.creditWarningForEdit("rejected-row", 900, "v1"),
    false,
    "a rejected row is outside the balance",
  );
  assert.equal(await credit.creditWarningForEdit("missing", 900, "v1"), false);

  await currencyMoveWarningChecks();
  await directionalWarningChecks();
  await currencySettingsChecks();
  await combinedAlertWarningChecks();

  // Owners and managers hear what a limit stopped (audit #24); nobody else
  // asks, and an older server's 404 is an empty list.
  const policyFetch = globalThis.fetch;
  let refusalCalls = 0;
  let refusalStatus = 200;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("/v1/sync/credit-refusals?vault_id=v1"))
      return policyFetch(url, init);
    refusalCalls++;
    assert.equal(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
      `Bearer ${session.jwt}`,
    );
    if (refusalStatus !== 200) return new Response("{}", { status: refusalStatus });
    return new Response(
      JSON.stringify({
        refusals: [
          {
            relationship_id: "r1",
            type: "debt",
            amount_minor: 500,
            actor_account_id: "acct-clerk",
            actor_name: "Clerk",
            refused_at_ms: 7,
          },
          {
            relationship_id: "r1",
            type: "loan",
            amount_minor: 1,
            actor_name: "",
            refused_at_ms: 1,
          },
        ],
      }),
    );
  };
  resetSession("jwt-refusals", "acct-owner");
  role = "clerk";
  assert.deepEqual(await credit.fetchCreditRefusals("v1"), [], "a clerk never asks");
  assert.equal(refusalCalls, 0);
  role = "owner";
  const refused = await credit.fetchCreditRefusals("v1");
  assert.equal(refused.length, 1, "a malformed row is dropped");
  assert.equal(refused[0].amount_minor, 500);
  assert.equal(refused[0].actor_name, "Clerk");
  await credit.fetchCreditRefusals("v1");
  assert.equal(refusalCalls, 1, "one request a minute");
  resetSession("jwt-other", "acct-owner");
  refusalStatus = 404;
  assert.deepEqual(
    await credit.fetchCreditRefusals("v1"),
    [],
    "another session never reuses the cache",
  );
  assert.equal(refusalCalls, 2);
  globalThis.fetch = policyFetch;
  await editorLimitsAndRecovery();
  await ownerArchiveAuthority();
  console.log(
    "PASS actual signed-out/local paired role gate, mesh parity, offline clerk tallies unless a hard limit applies, stale-limit refusals leave the balance, clerk enrollment activation guard",
  );
}
async function currencySettingsChecks() {
  fixture.exec(`CREATE TABLE IF NOT EXISTS vault_settings(vault_id TEXT,key TEXT,value TEXT,PRIMARY KEY(vault_id,key));
    INSERT INTO vaults(id,currency,legacy_currency,default_entry_currency)
      VALUES('v-credit-currencies','AFN','AFN','USD'),('v-credit-other','KRW','KRW','KRW');
    INSERT INTO relationships(id,vault_id,user_b_id,created_at)
      VALUES('r-credit-currencies','v-credit-currencies','p-credit-currencies',1),
            ('r-credit-foreign','v-credit-currencies','p-credit-foreign',1),
            ('r-credit-other','v-credit-other','p-credit-other',1);
    INSERT INTO vault_settings VALUES('v-credit-currencies','default_entry_currency','"GBP"'),
      ('v-credit-currencies','enabled_currencies','["USD","EUR","GBP"]');
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at)
      VALUES('credit-history-afn','v-credit-currencies','r-credit-currencies','debt',1,'AFN',1),
            ('credit-history-aud','v-credit-currencies','r-credit-currencies','payment',1,'AUD',1),
            ('credit-history-other','v-credit-other','r-credit-other','debt',1,'ZAR',1);
    INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at)
      VALUES('credit-history-chf','v-credit-currencies','r-credit-currencies','a','CHF',1);`);
  const own: CreditPolicy = {
    relationship_id: "r-credit-currencies",
    currency: "USD",
    max_collect_minor: 12345,
    max_pay_minor: null,
    mode: "warn",
    restrict_editors: false,
    updated_at_ms: 1,
  };
  const defaultUSD: CreditPolicy = {
    ...own,
    relationship_id: KAATA_DEFAULT_CREDIT_ID,
    max_collect_minor: 1000,
    max_pay_minor: 2000,
    mode: "clerk_block",
    restrict_editors: true,
  };
  await cacheCreditPolicies(
    db,
    "v-credit-currencies",
    [
      own,
      { ...own, currency: "CAD", mode: "clerk_block", restrict_editors: true },
      { ...own, relationship_id: "r-credit-foreign", currency: "SEK" },
      defaultUSD,
      { ...defaultUSD, currency: "NZD" },
      { ...defaultUSD, currency: "AUD" },
    ],
    2,
  );
  await cacheCreditPolicies(db, "v-credit-other", [{ ...defaultUSD, currency: "KRW" }], 2);
  const selectedBefore = require("../currency-scope").getLedgerCurrencyCode();
  const settings = await credit.listCreditCurrencySettings(
    "r-credit-currencies",
    "v-credit-currencies",
  );
  assert.deepEqual(
    settings.map((row) => row.currency),
    ["GBP", "USD", "EUR", "AFN", "AUD", "CAD", "CHF", "NZD"],
    "preferred and enabled currencies precede stable history/configured currencies, including disabled rules",
  );
  const byCode = new Map(settings.map((row) => [row.currency, row]));
  assert.deepEqual(
    byCode.get("USD"),
    { currency: "USD", policy: own, defaultPolicy: defaultUSD },
    "an explicit unlimited opposite cap stays distinct from the stricter default",
  );
  assert.equal(
    byCode.get("CAD")?.policy?.restrict_editors,
    true,
    "SQLite editor restrictions normalize to boolean",
  );
  assert.equal(byCode.get("CAD")?.policy?.mode, "clerk_block");
  assert.equal(byCode.get("NZD")?.policy, null, "a default-only currency remains inherited");
  assert.equal(byCode.get("NZD")?.defaultPolicy?.restrict_editors, true);
  assert.deepEqual(byCode.get("GBP"), { currency: "GBP", policy: null, defaultPolicy: null });
  const defaults = await credit.listCreditCurrencySettings(
    KAATA_DEFAULT_CREDIT_ID,
    "v-credit-currencies",
  );
  assert.deepEqual(
    defaults.map((row) => row.currency),
    ["GBP", "USD", "EUR", "AFN", "AUD", "CHF", "NZD"],
    "the default route excludes customer-only configurations and other vaults",
  );
  assert.deepEqual(
    defaults.find((row) => row.currency === "USD"),
    {
      currency: "USD",
      policy: defaultUSD,
      defaultPolicy: null,
    },
  );
  assert.equal(
    require("../currency-scope").getLedgerCurrencyCode(),
    selectedBefore,
    "reading credit settings never changes the selected or write currency",
  );
  console.log(
    "PASS multi-currency credit settings discover enabled/history/disabled rules, retain own/default policies and role flags, and isolate customer/vault scope",
  );
}

async function directionalWarningChecks() {
  const caps = { max_collect_minor: 10000, max_pay_minor: 20000 };
  for (const scope of ["own", "inherited", "override", "currency"] as const) {
    const vault = `v-warning-${scope}`;
    const relationship = `r-warning-${scope}`;
    const person = `p-warning-${scope}`;
    const currency = scope === "currency" ? "USD" : "AFN";
    fixture.prepare("INSERT INTO vaults(id) VALUES(?)").run(vault);
    fixture
      .prepare("INSERT INTO relationships VALUES(?,?,?,1,NULL)")
      .run(relationship, vault, person);
    const own: CreditPolicy = {
      relationship_id: relationship,
      currency,
      ...caps,
      mode: "warn",
      updated_at_ms: 1,
    };
    const policies =
      scope === "inherited" ? [{ ...own, relationship_id: KAATA_DEFAULT_CREDIT_ID }] : [own];
    if (scope === "override" || scope === "currency")
      policies.push({
        ...own,
        relationship_id: KAATA_DEFAULT_CREDIT_ID,
        currency: "AFN",
        max_collect_minor: 0,
        max_pay_minor: 0,
      });
    await cacheCreditPolicies(db, vault, policies, 2);

    // Rebuild only this synthetic contact's rows; every assertion uses the
    // shipped balance reader and policy resolver, not just creditExceeded.
    const setBalance = (before: number, type: "debt" | "payment", original?: number) => {
      fixture.prepare("DELETE FROM entries WHERE vault_id=?").run(vault);
      const insert = fixture.prepare(
        "INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at) VALUES(?,?,?,?,?,?,1)",
      );
      const residual =
        before - (original === undefined ? 0 : (type === "debt" ? 1 : -1) * original);
      if (residual !== 0)
        insert.run(
          `${vault}-balance`,
          vault,
          relationship,
          residual > 0 ? "debt" : "payment",
          Math.abs(residual) / 100,
          currency,
        );
      if (original !== undefined)
        insert.run(`${vault}-edit`, vault, relationship, type, original / 100, currency);
    };
    for (const type of ["debt", "payment"] as const) {
      const sign = type === "debt" ? 1 : -1;
      const cap = type === "debt" ? caps.max_collect_minor : caps.max_pay_minor;
      const oppositeCap = type === "debt" ? caps.max_pay_minor : caps.max_collect_minor;
      const context = `${scope} ${currency} ${type}`;
      const creationCases = [
        { label: "at cap", before: 0, amount: cap, warning: false },
        { label: "over cap", before: 0, amount: cap + 1, warning: true },
        { label: "worsening", before: sign * (cap + 1), amount: 1, warning: true },
        { label: "repayment", before: -sign * (oppositeCap + 100), amount: 1, warning: false },
        { label: "cross zero to cap", before: -sign * 5000, amount: 5000 + cap, warning: false },
        { label: "cross zero over cap", before: -sign * 5000, amount: 5001 + cap, warning: true },
      ];
      for (const test of creationCases) {
        setBalance(test.before, type);
        assert.equal(
          await credit.creditWarning(person, type, test.amount / 100, vault, currency),
          test.warning,
          `${context} new ${test.label}`,
        );
      }
      const editCases = [
        {
          label: "at cap",
          before: sign * (cap - 1),
          original: cap / 2 - 1,
          amount: cap / 2,
          warning: false,
        },
        {
          label: "over cap",
          before: sign * cap,
          original: cap / 2,
          amount: cap / 2 + 1,
          warning: true,
        },
        {
          label: "unchanged over cap",
          before: sign * (cap + 1),
          original: cap + 1,
          amount: cap + 1,
          warning: false,
        },
        {
          label: "worsening",
          before: sign * (cap + 1),
          original: cap + 1,
          amount: cap + 2,
          warning: true,
        },
        {
          label: "reducing exposure",
          before: sign * (cap + 2),
          original: cap + 2,
          amount: cap + 1,
          warning: false,
        },
        {
          label: "repayment",
          before: -sign * (oppositeCap + 100),
          original: 100,
          amount: 101,
          warning: false,
        },
        {
          label: "cross zero to cap",
          before: -sign * 5000,
          original: 100,
          amount: 5100 + cap,
          warning: false,
        },
        {
          label: "cross zero over cap",
          before: -sign * 5000,
          original: 100,
          amount: 5101 + cap,
          warning: true,
        },
      ];
      for (const test of editCases) {
        setBalance(test.before, type, test.original);
        assert.equal(
          await credit.creditWarningForEdit(`${vault}-edit`, test.amount / 100, vault, currency),
          test.warning,
          `${context} edit ${test.label}`,
        );
      }
    }
    if (scope === "own") {
      for (const limitedType of ["debt", "payment"] as const) {
        await cacheCreditPolicies(
          db,
          vault,
          [
            {
              ...own,
              max_collect_minor: limitedType === "debt" ? 10000 : null,
              max_pay_minor: limitedType === "payment" ? 20000 : null,
              updated_at_ms: limitedType === "debt" ? 3 : 4,
            },
          ],
          5,
        );
        for (const type of ["debt", "payment"] as const) {
          setBalance(0, type);
          assert.equal(
            await credit.creditWarning(person, type, 201, vault, currency),
            type === limitedType,
            `${limitedType}-only cap: new ${type}`,
          );
          setBalance(type === "debt" ? 100 : -100, type, 100);
          assert.equal(
            await credit.creditWarningForEdit(`${vault}-edit`, 201, vault, currency),
            type === limitedType,
            `${limitedType}-only cap: edit ${type}`,
          );
        }
      }
    }
  }
  console.log(
    "PASS give/receive warning parity for new/edit caps, worsening, repayment, zero crossings, own/default/override policies and nondefault currency",
  );
}

async function currencyMoveWarningChecks() {
  fixture.exec(`INSERT INTO vaults(id) VALUES('v-warning');
    INSERT INTO relationships(id,vault_id,user_b_id,created_at) VALUES('r-warning','v-warning','p-warning',1);
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,is_deleted)
      VALUES('move-me','v-warning','r-warning','debt',12.34,'AFN',100,0);`);
  const destination = { ...policy(1000, "warn"), relationship_id: "r-warning", currency: "USD" };
  await cacheCreditPolicies(db, "v-warning", [destination], 2);
  assert.equal(
    await credit.creditWarningForEdit("move-me", 12.34, "v-warning", "USD"),
    true,
    "moving debt warns on the destination exposure even with an unchanged amount",
  );
  assert.equal(
    await credit.creditWarningForEdit("move-me", 10, "v-warning", "USD"),
    false,
    "moving debt up to the destination cap is allowed",
  );
  await cacheCreditPolicies(db, "v-warning", [{ ...destination, currency: "AFN" }], 3);
  fixture.exec(`UPDATE entries SET type='payment' WHERE id='move-me';
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at,is_deleted)
      VALUES('remaining-debt','v-warning','r-warning','debt',20,'AFN',101,0);`);
  assert.equal(
    await credit.creditWarningForEdit("move-me", 12.34, "v-warning", "USD"),
    true,
    "moving a payment warns when removing it exceeds the source cap",
  );
  fixture.exec(
    "DELETE FROM entries WHERE id='remaining-debt'; UPDATE entries SET type='debt',amount_afn=0.29 WHERE id='move-me'",
  );
  await cacheCreditPolicies(db, "v-warning", [{ ...destination, max_collect_minor: 29 }], 4);
  assert.equal(
    await credit.creditWarningForEdit("move-me", 0.29, "v-warning", "USD"),
    false,
    "currency-move warning uses exact minor units at the cap",
  );
  await cacheCreditPolicies(db, "v-warning", [{ ...destination, max_collect_minor: 28 }], 5);
  assert.equal(await credit.creditWarningForEdit("move-me", 0.29, "v-warning", "USD"), true);
  fixture
    .prepare(
      "INSERT INTO event_log(event_id,vault_id,relationship_id,target_id,payload_json,event_type,appended_at) VALUES('currency-intent','v-warning','r-warning','move-me',?,'entry_amended',200)",
    )
    .run(
      JSON.stringify({
        changes: { amount_afn: 0.29, currency: "USD", note: "pending correction" },
      }),
    );
  fixture.exec(
    "INSERT INTO credit_admission_intents(event_id,vault_id,relationship_id,status) VALUES('currency-intent','v-warning','r-warning','pending')",
  );
  assert.deepEqual(
    await credit.listCreditIntents("p-warning", "v-warning", "AFN"),
    [],
    "a correction intent is not labeled as its source unit",
  );
  const target = await credit.listCreditIntents("p-warning", "v-warning", "USD");
  assert.equal(target.length, 1);
  assert.equal(target[0].currency, "USD");
  assert.equal(target[0].amount_afn, 0.29);
  assert.equal(target[0].mutation, "edit");
  assert.equal(
    (await credit.listCreditIntents("p-warning", "v-warning", "AFN", { allCurrencies: true }))
      .length,
    1,
  );
  fixture.exec(
    "UPDATE credit_admission_intents SET status='refused' WHERE event_id='currency-intent'",
  );
  assert.equal(
    (await credit.listCreditIntents("p-warning", "v-warning", "USD"))[0].admission_status,
    "refused",
  );
  assert.equal(
    (fixture.prepare("SELECT currency FROM entries WHERE id='move-me'").get() as any).currency,
    "AFN",
    "pending/refused target currency does not relabel recorded money",
  );
  console.log(
    "PASS currency-move debt destination/payment source warnings, exact caps and target-labeled pending/refused intents",
  );
}

async function preAlertSchemaWarningChecks() {
  fixture.exec(`INSERT INTO vaults(id,currency,legacy_currency) VALUES('v-pre049','AFN','AFN');
    INSERT INTO relationships VALUES('r-pre049','v-pre049','p-pre049',1,NULL);
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at)
      VALUES('entry-pre049','v-pre049','r-pre049','debt',10,'AFN',20);
    ALTER TABLE credit_alert_policies RENAME TO credit_alert_policies_saved;`);
  try {
    const before = fixture.prepare("SELECT * FROM entries WHERE vault_id='v-pre049'").all();
    assert.equal(
      await credit.creditWarning("p-pre049", "debt", 100, "v-pre049", "AFN"),
      false,
      "a new tally's advisory check works on an already-open pre-049 database",
    );
    assert.equal(await credit.creditWarningForEdit("entry-pre049", 100, "v-pre049", "AFN"), false);
    await cacheCreditPolicies(
      db,
      "v-pre049",
      [
        {
          relationship_id: "r-pre049",
          currency: "AFN",
          max_collect_minor: 10000,
          max_pay_minor: 20000,
          mode: "clerk_block",
          updated_at_ms: 1,
        },
      ],
      2,
    );
    assert.equal(await credit.creditWarning("p-pre049", "debt", 90, "v-pre049", "AFN"), false);
    assert.equal(
      await credit.creditWarning("p-pre049", "debt", 91, "v-pre049", "AFN"),
      true,
      "the old collect cap still warns when the optional new cache is absent",
    );
    assert.equal(
      await credit.creditWarning("p-pre049", "payment", 211, "v-pre049", "AFN"),
      true,
      "the old pay cap still warns independently",
    );
    assert.equal(await credit.creditWarningForEdit("entry-pre049", 101, "v-pre049", "AFN"), true);
    const proposed = {
      event_id: "pre049-proposed",
      event_type: "entry_created",
      vault_id: "v-pre049",
      relationship_id: "r-pre049",
      target_id: "pre049-new",
      origin: "local",
      server_acked_at: null,
      payload: {
        entry_id: "pre049-new",
        relationship_id: "r-pre049",
        type: "debt",
        amount_afn: 91,
        currency: "AFN",
        note: null,
        occurred_at_ms: 30,
      },
    } as EntryCreatedEvent;
    assert.equal(
      await requiresCreditAdmission(db, proposed, "clerk"),
      true,
      "missing advisory cache never bypasses hard financial admission",
    );
    assert.equal(await requiresCreditAdmission(db, proposed, "owner"), false);
    assert.deepEqual(
      fixture.prepare("SELECT * FROM entries WHERE vault_id='v-pre049'").all(),
      before,
      "warning/admission reads do not modify any recorded balance",
    );

    // Execute the actual createEntryDetailed orchestration, including its
    // pre-save warning. Only the signed append boundary is substituted; it
    // dispatches the shipped entry projection into this isolated database.
    const createDeclaration = dbAST.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === "createEntryDetailed",
    );
    assert.ok(createDeclaration);
    const createAPI = {} as Pick<typeof import("../db"), "createEntryDetailed">;
    let appends = 0;
    let usage = 0;
    new Function(
      "require",
      "exports",
      "requireCurrencyCode",
      "getLedgerCurrencyCode",
      "getActiveVaultIdSync",
      "getTabLinkForPerson",
      "getTabGroupLinkForPerson",
      "getDb",
      "getAppMeta",
      "appendEntryCreated",
      "bumpUsageCounter",
      ts.transpileModule(createDeclaration.getText(dbAST), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    )(
      (name: string) => {
        if (name === "./auth")
          return {
            captureCurrentSession: async () => ({ ...session }),
            applyForUnchangedLocalSession: guard,
            SessionChangedError,
          };
        if (name === "./credit-limits") return credit;
        throw new Error(`Unexpected create dependency ${name}`);
      },
      createAPI,
      require("../currency-scope").requireCurrencyCode,
      () => "AFN",
      () => "v-pre049",
      async () => null,
      async () => null,
      async () => db,
      async () => null,
      async (input: {
        relationshipId: string;
        type: "debt" | "payment";
        amountAfn: number;
        note: string | null;
        currency: string;
      }) => {
        appends++;
        const event: EntryCreatedEvent = {
          ...proposed,
          event_id: "pre049-saved-event",
          target_id: "pre049-saved",
          device_id: "fixture",
          hlc: { pms: 40, l: 0, did: "fixture" },
          author_user_id_local_only: "self",
          payload_schema: 1,
          payload: {
            entry_id: "pre049-saved",
            relationship_id: input.relationshipId,
            type: input.type,
            amount_afn: input.amountAfn,
            note: input.note,
            occurred_at_ms: 40,
            currency: input.currency,
          },
        };
        await entryAppliers.applyEntryCreated(db, event);
        return { entry_id: event.target_id, event_id: event.event_id };
      },
      async () => {
        usage++;
      },
    );
    const saved = await createAPI.createEntryDetailed("p-pre049", "debt", 25, "pre-049 save", {
      session: { ...session },
      vaultId: "v-pre049",
      currency: "AFN",
    });
    assert.deepEqual(saved, {
      entry_id: "pre049-saved",
      duplicate_hint: null,
      admission_status: undefined,
      credit_warning: false,
    });
    assert.equal(appends, 1, "the pre-049 warning does not abort the actual create orchestration");
    assert.equal(usage, 1);
    assert.deepEqual(
      fixture.prepare("SELECT amount_afn,note,currency FROM entries WHERE id='pre049-saved'").get(),
      { amount_afn: 25, note: "pre-049 save", currency: "AFN" },
    );
  } finally {
    fixture.exec("ALTER TABLE credit_alert_policies_saved RENAME TO credit_alert_policies");
  }
  console.log(
    "PASS pre-049 live tally checks: new/edit warnings tolerate only the absent optional cache; collect/pay caps and clerk admission remain enforced",
  );
}

async function combinedAlertWarningChecks() {
  fixture.exec(`INSERT INTO vaults(id,currency,legacy_currency) VALUES('v-alert','AFN','AFN');
    INSERT INTO relationships VALUES('r-alert','v-alert','p-alert',1,NULL);
    INSERT INTO entries(id,vault_id,relationship_id,type,amount_afn,currency,created_at)
      VALUES('alert-usd','v-alert','r-alert','debt',4900,'USD',20),
            ('alert-afn','v-alert','r-alert','debt',99900,'AFN',20),
            ('alert-move','v-alert','r-alert','debt',100,'AFN',20);`);
  const combined: import("../credit-alert-policy").CreditAlertPolicy = {
    relationship_id: "r-alert",
    updated_at_ms: 1,
    groups: [
      {
        direction: "collect",
        conditions: [
          { currency: "USD", threshold_minor: 500000 },
          { currency: "AFN", threshold_minor: 10000000 },
        ],
      },
      {
        direction: "collect",
        conditions: [
          { currency: "USD", threshold_minor: 800000 },
          { currency: "AFN", threshold_minor: 8000000 },
        ],
      },
    ],
  };
  await cacheCreditAlerts(db, "v-alert", [combined], 2);
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 100, "v-alert", "USD"),
    true,
    "both conditions meet inclusively",
  );
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 1, "v-alert", "AFN"),
    false,
    "AFN alone cannot satisfy USD AND AFN",
  );
  assert.equal(await credit.creditWarningForEdit("alert-usd", 5000, "v-alert", "USD"), true);
  assert.equal(
    await credit.creditWarningForEdit("alert-usd", 4800, "v-alert", "USD"),
    false,
    "repayment never warns",
  );
  assert.equal(
    await credit.creditWarningForEdit("alert-move", 100, "v-alert", "USD"),
    false,
    "moving denominations subtracts source before checking entire vector",
  );
  await cacheCreditPolicies(
    db,
    "v-alert",
    [
      {
        relationship_id: "r-alert",
        currency: "USD",
        max_collect_minor: 100000,
        max_pay_minor: null,
        mode: "warn",
        updated_at_ms: 1,
      },
    ],
    2,
  );
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 1, "v-alert", "USD"),
    true,
    "independent caps remain an OR alternative",
  );
  await cacheCreditPolicies(db, "v-alert", [], 3);
  fixture.exec(
    "UPDATE entries SET amount_afn=7900 WHERE id='alert-usd'; UPDATE entries SET amount_afn=79900 WHERE id='alert-afn'",
  );
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 100, "v-alert", "USD"),
    true,
    "second AND group is an OR alternative",
  );
  fixture.exec(
    "UPDATE entries SET type='payment' WHERE vault_id='v-alert'; UPDATE entries SET amount_afn=4900 WHERE id='alert-usd'; UPDATE entries SET amount_afn=99900 WHERE id='alert-afn'",
  );
  await cacheCreditAlerts(
    db,
    "v-alert",
    [
      {
        ...combined,
        updated_at_ms: 3,
        groups: combined.groups.map((g) => ({ ...g, direction: "pay" })),
      },
    ],
    4,
  );
  assert.equal(
    await credit.creditWarning("p-alert", "payment", 100, "v-alert", "USD"),
    true,
    "pay group uses negative exposure for each denomination",
  );
  assert.equal(await credit.creditWarning("p-alert", "debt", 100, "v-alert", "USD"), false);
  assert.equal(
    await credit.creditWarningForEdit("alert-move", 100, "v-alert", "USD"),
    false,
    "pay currency move also reduces the source before AND evaluation",
  );
  fixture.exec(`UPDATE entries SET type='debt' WHERE vault_id='v-alert';
    DELETE FROM entries WHERE id='alert-usd';
    INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,linked_at,currency,history_order)
      VALUES('alert-tab','v-alert','r-alert','a',0,'USD','1');
    INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
      VALUES('alert-pending','alert-tab',1,1,'a','a_to_b',500000,'opening',1,1,'pending');`);
  await cacheCreditAlerts(db, "v-alert", [{ ...combined, updated_at_ms: 5 }], 6);
  const vector = await credit.creditAlertBalancesInTx(db, "v-alert", "r-alert", combined.groups);
  assert.deepEqual(
    vector,
    { USD: 500000, AFN: 10000000 },
    "pending shared exposure counts exactly once",
  );
  assert.equal(await credit.creditWarning("p-alert", "debt", 1, "v-alert", "AFN"), true);
  fixture.exec(`UPDATE tab_links SET closed_at=1 WHERE tab_id='alert-tab';
    INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,linked_at,currency)
    VALUES('alert-unknown','v-alert','r-alert','a',1,'USD');`);
  assert.equal(
    (await credit.creditAlertBalancesInTx(db, "v-alert", "r-alert", combined.groups)).USD,
    null,
    "unverified shared history remains unknown",
  );
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 1, "v-alert", "AFN"),
    false,
    "unknown USD cannot satisfy an AND group",
  );
  await cacheCreditPolicies(
    db,
    "v-alert",
    [
      {
        relationship_id: "r-alert",
        currency: "AFN",
        max_collect_minor: 9999999,
        max_pay_minor: null,
        mode: "warn",
        updated_at_ms: 5,
      },
    ],
    6,
  );
  assert.equal(
    await credit.creditWarning("p-alert", "debt", 1, "v-alert", "AFN"),
    true,
    "known independent warning still works beside unknown combined history",
  );
  console.log(
    "PASS combined inline warnings: inclusive alternatives, full-vector currency moves, repayments, collect/pay, pending shared exposure and unknown history",
  );
}

void run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    fixture.close();
  });
