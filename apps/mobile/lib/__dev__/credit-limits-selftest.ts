// Actual policy/cache/intent/queue code, shipped migrations and in-memory SQLite.
// Native session/network edges are replaced; no phone or production data is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import Database from "better-sqlite3";
import {
  creditExceeded,
  KAATA_DEFAULT_CREDIT_ID,
  validCreditPolicy,
  type CreditPolicy,
} from "../credit-policy";
import { cacheCreditPolicies } from "../credit-policy-cache";
import { Mutex } from "../util/mutex";
import { toMinorUnits } from "../money";
import { signedEntryMinorSumSql } from "../money-sql";
import type { SQLiteTx } from "../db-tx";
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
INSERT INTO vaults VALUES('v1',NULL,NULL,NULL,'anchor'),('v2',NULL,NULL,NULL,'anchor');
INSERT INTO relationships VALUES('r1','v1','p1',1,NULL),('r2','v2','p2',1,NULL);
INSERT INTO users VALUES('self',1,'Owner');`);
const dbSource = readFileSync(require.resolve("../db"), "utf8");
for (const marker of [
  "customer_credit_limits",
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
  if (name === "./credit-policy") return policyModule;
  if (name === "./credit-policy-cache") return cacheModule;
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
  if (name === "./credit-policy-events")
    return {
      emitCreditPoliciesChanged: () => {
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
  if (name === "./direction") return require("../tabs/direction");
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
async function run() {
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
  release();
  await late;
  deferGET = null;
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
  release();
  await assert.rejects(switched, SessionChangedError);
  deferGET = null;
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
    { ...kaataDefault, restrict_editors: false },
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
void run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    fixture.close();
  });
