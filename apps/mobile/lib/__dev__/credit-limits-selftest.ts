// Actual policy/cache/intent/queue code, shipped migrations and in-memory SQLite.
// Native session/network edges are replaced; no phone or production data is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import Database from "better-sqlite3";
import { creditExceeded, validCreditPolicy, type CreditPolicy } from "../credit-policy";
import { cacheCreditPolicies } from "../credit-policy-cache";
import {
  needsCreditAdmission,
  deferCreditAdmission,
  requiresCreditAdmission,
} from "../credit-admission";
import { Mutex } from "../util/mutex";
import { toMinorUnits } from "../money";
import { signedEntryMinorSumSql } from "../money-sql";
import type { SQLiteTx } from "../db-tx";
import type { EntryCreatedEvent, VaultRole } from "../events";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const fixture = new Database(":memory:");
fixture.pragma("foreign_keys = ON");
fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,account_id TEXT,archived_at INTEGER,registered_with_server_at INTEGER,vault_trust_anchor_pubkey TEXT);
CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT REFERENCES vaults(id),user_b_id TEXT,created_at INTEGER,archived_at INTEGER);
CREATE TABLE users(id TEXT PRIMARY KEY,is_local_self INTEGER,display_name TEXT);
CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,relationship_id TEXT,type TEXT,amount_afn NUMERIC,created_at INTEGER,deleted_at INTEGER,disputed_at INTEGER);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,payload_json TEXT,applied_at INTEGER,quarantine_reason TEXT,server_acked_at INTEGER,rejected_at INTEGER,appended_at INTEGER,event_type TEXT,actor_account_id TEXT,target_id TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT);
CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,revoked_at INTEGER);
CREATE TABLE vault_device_registry(vault_id TEXT,account_id TEXT,device_id TEXT,device_pubkey TEXT,removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT);
CREATE TABLE vault_credentials(vault_id TEXT,account_id TEXT);
INSERT INTO vaults VALUES('v1',NULL,NULL,NULL,'anchor'),('v2',NULL,NULL,NULL,'anchor');
INSERT INTO relationships VALUES('r1','v1','p1',1,NULL),('r2','v2','p2',1,NULL);
INSERT INTO users VALUES('self',1,'Owner');`);
const dbSource = readFileSync(require.resolve("../db"), "utf8");
for (const marker of ["customer_credit_limits", "tab_links", "tab_failed_ops"]) {
  const ddl = new RegExp(
    "execAsync\\(`([^`]*CREATE TABLE IF NOT EXISTS " + marker + "[^`]*)`\\)",
  ).exec(dbSource)?.[1];
  assert.ok(ddl, `actual migration ${marker}`);
  fixture.exec(ddl);
}
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
    .prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,NULL,NULL)")
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
      "INSERT INTO entries VALUES('cents','v1','r1','debt',0.01,101,NULL,NULL),('disputed','v1','r1','debt',99,101,NULL,1)",
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
  assert.equal(needsCreditAdmission(event, "editor"), false);
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
  fixture.prepare("UPDATE vaults SET registered_with_server_at=0 WHERE id='v1'").run();
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "zero registration marker is unknown/cloud",
  );
  fixture.prepare("UPDATE vaults SET registered_with_server_at=NULL WHERE id='v1'").run();
  fixture.prepare("UPDATE vault_device_registry SET account_id='cloud-account'").run();
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "pair scan NULL registration cannot hide cloud peer identity",
  );
  fixture.prepare("UPDATE vault_device_registry SET account_id=?").run(localClerk);
  fixture.prepare("UPDATE vaults SET account_id='' WHERE id='v1'").run();
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "malformed empty binding fails closed",
  );
  fixture.prepare("UPDATE vaults SET account_id=NULL WHERE id='v1'").run();
  fixture.prepare("UPDATE event_log SET server_acked_at=1 WHERE event_id='founder'").run();
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "observed HTTPS history requires admission even without limits",
  );
  await cacheCreditPolicies(db, "v1", [policy(10000, "warn", 1)], 2);
  assert.equal(
    await requiresCreditAdmission(db, localEvent, "clerk"),
    true,
    "warning policies do not bypass cloud clerk admission",
  );
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
  console.log(
    "PASS actual signed-out/local paired role gate, mesh parity, conservative cloud markers and clerk enrollment activation guard",
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
