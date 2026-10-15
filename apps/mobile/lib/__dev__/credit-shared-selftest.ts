// Real shared-account queue and product flows against SQLite. Network/session
// boundaries are replaced; this never opens an app or a real account.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import type { SQLiteTx } from "../db-tx";
import type { VaultRole } from "../events";
import type { TabLink, TabOutboxRow } from "../tabs/types";
import { Mutex } from "../util/mutex";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const VAULT = "credit-test-vault",
  REL = "credit-test-rel",
  PERSON = "credit-test-person";
const ACCOUNT = "credit-test-account",
  TAB = "credit-test-tab";
let fixture: Database.Database;
let role: VaultRole = "editor";
let online = false;
let verdict: "offline" | "accept" | "refuse" = "offline";
let synced = 0;
const session = { jwt: "fixture-jwt", accountId: ACCOUNT };
const applyEventMutex = new Mutex();
const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (work: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await work();
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
  },
} as unknown as SQLiteTx;
const dbTx = {
  getDb: async () => db,
  getAccountIdSync: () => ACCOUNT,
  getActiveVaultIdSyncMaybe: () => VAULT,
};

function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  const source = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", source)(required, exports);
  return exports as T;
}

const tabsDb = compile<typeof import("../tabs/db")>("../tabs/db", (name) => {
  if (name === "../db-tx") return dbTx;
  if (name === "../projection") return { applyEventMutex };
  if (name === "../ledger-events") return { emitLedgerApplied: () => {} };
  if (name === "../money") return require("../money");
  if (name.startsWith("./")) return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected shared-db dependency ${name}`);
});

async function flush(): Promise<void> {
  synced++;
  if (verdict === "offline") return;
  for (const op of await tabsDb.listDueTabOps(TAB)) {
    if (verdict === "refuse") {
      await tabsDb.rejectTabOp(op, "credit_limit_exceeded");
      continue;
    }
    const payload = JSON.parse(op.payload);
    // The server result is authoritative. This boundary stands in for the
    // actual HTTP acknowledgment; all queue/optimism code above it is real.
    if (op.op === "accept" || op.op === "dispute") {
      fixture
        .prepare("UPDATE tab_entries SET status=?,local_action_pending=0 WHERE id=?")
        .run(op.op === "accept" ? "accepted" : "disputed", payload.entry_id);
    } else if (op.op === "void") {
      fixture
        .prepare("UPDATE tab_entries SET voided_by_entry_id=?,local_action_pending=0 WHERE id=?")
        .run("server-void", payload.entry_id);
    }
    await tabsDb.completeTabOp(op.id);
  }
}

const flows = compile<typeof import("../tabs/link")>("../tabs/link", (name) => {
  if (name === "expo-crypto") return { randomUUID };
  if (name === "expo-network")
    return { getNetworkStateAsync: async () => ({ isConnected: online }) };
  if (name === "react-native") return { Linking: {} };
  if (name === "../auth")
    return {
      captureCurrentSession: async () => session,
      getSessionJWT: async () => session.jwt,
      applyForCurrentSession: async (_: unknown, work: () => Promise<unknown>) => work(),
    };
  if (name === "../db-tx") return dbTx;
  if (name === "../use-vault-role") return { readVaultRole: async () => role };
  if (name === "../credit-admission") return require("../credit-admission");
  if (name === "../money") return require("../money");
  if (name === "../types") return require("../types");
  if (name === "../vault-roles") return require("../vault-roles");
  if (
    name === "../currency" ||
    name === "../db" ||
    name === "../event-log" ||
    name === "../vault-router" ||
    name === "./api"
  )
    return {};
  if (name === "../sync/push") return { pushEvents: async () => ({ pushed: 0, duplicates: 0 }) };
  if (name === "./db") return tabsDb;
  if (name === "./inbox-reads") return { markInboxHandled: async () => {} };
  if (name === "./sync") return { syncTab: flush, takeAppendOutcome: () => null };
  if (name.startsWith("./")) return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected shared-flow dependency ${name}`);
});

const dbSource = readFileSync(require.resolve("../db"), "utf8");
const creditLists = compile<typeof import("../credit-limits")>("../credit-limits", (name) => {
  if (name === "./db-tx") return dbTx;
  if (name === "./auth" || name === "./api") return {};
  if (name === "./use-vault-role") return { readVaultRole: async () => role };
  if (name === "./effective-account") return { resolveAccountIdCandidates: async () => [ACCOUNT] };
  if (name.startsWith("./")) return require("../" + name.slice(2));
  throw new Error(`Unexpected credit-list dependency ${name}`);
});
function ddl(marker: string): string {
  const block = new RegExp("execAsync\\(`([^`]*" + marker + "[^`]*)`\\)").exec(dbSource)?.[1];
  assert.ok(block, `shipped migration ${marker}`);
  return block;
}

const link: TabLink = {
  tab_id: TAB,
  vault_id: VAULT,
  relationship_id: REL,
  role: "a",
  currency: "AFN",
  party_token: null,
  my_label: "Shop",
  other_label: "Customer",
  other_joined_at: 1,
  invite_url: null,
  rev: 1,
  closed_at: null,
  linked_at: 1,
  last_synced_at: 1,
  last_error: null,
};

function reset(): void {
  fixture?.close();
  fixture = new Database(":memory:");
  fixture.pragma("foreign_keys = ON");
  fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER,created_at INTEGER);
    CREATE TABLE users(id TEXT PRIMARY KEY,is_local_self INTEGER,display_name TEXT);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,payload_json TEXT,event_type TEXT,appended_at INTEGER,vault_id TEXT,target_id TEXT,server_acked_at INTEGER);
    CREATE TABLE entries(id TEXT PRIMARY KEY,vault_id TEXT,type TEXT,amount_afn NUMERIC,note TEXT);
    INSERT INTO vaults VALUES('${VAULT}');
    INSERT INTO relationships VALUES('${REL}','${VAULT}','${PERSON}',NULL,1);
    INSERT INTO users VALUES('self',1,'Editor');`);
  for (const marker of [
    "CREATE TABLE IF NOT EXISTS tab_links",
    "CREATE TABLE IF NOT EXISTS tab_failed_ops",
    "ALTER TABLE tab_entries ADD COLUMN author_account_id",
    "ALTER TABLE tab_entries ADD COLUMN author_member_role",
    "CREATE TABLE IF NOT EXISTS customer_credit_limits",
    "CREATE TABLE IF NOT EXISTS kaata_credit_defaults",
    "CREATE TABLE IF NOT EXISTS vault_member_credit_permissions",
  ])
    fixture.exec(ddl(marker));
  fixture.exec(
    "ALTER TABLE customer_credit_limits ADD COLUMN restrict_editors INTEGER NOT NULL DEFAULT 0; ALTER TABLE kaata_credit_defaults ADD COLUMN restrict_editors INTEGER NOT NULL DEFAULT 0;",
  );
  fixture
    .prepare(
      "INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,linked_at,rev) VALUES(?,?,?,?,?,?,?)",
    )
    .run(TAB, VAULT, REL, "a", "AFN", 1, 1);
  role = "editor";
  online = false;
  verdict = "offline";
  synced = 0;
}

function policy(mode: "warn" | "clerk_block", restrictEditors: boolean): void {
  fixture
    .prepare(
      "INSERT INTO customer_credit_limits(vault_id,relationship_id,max_collect_minor,max_pay_minor,mode,updated_at_ms,restrict_editors) VALUES(?,?,0,0,?,1,?)",
    )
    .run(VAULT, REL, mode, Number(restrictEditors));
}
function override(value: "enforce" | "bypass"): void {
  fixture
    .prepare("INSERT INTO vault_member_credit_permissions VALUES(?,?,?,1)")
    .run(VAULT, ACCOUNT, value);
}
function count(table: string): number {
  return (fixture.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function entry(id: string): { status: string; voided_by_entry_id: string | null } {
  return fixture
    .prepare("SELECT status,voided_by_entry_id FROM tab_entries WHERE id=?")
    .get(id) as ReturnType<typeof entry>;
}
function balance(): number {
  return (
    fixture
      .prepare(
        "SELECT COALESCE(SUM(CASE WHEN direction='a_to_b' THEN amount_minor ELSE -amount_minor END),0) AS n FROM tab_entries WHERE kind<>'void' AND voided_by_entry_id IS NULL AND status<>'disputed'",
      )
      .get() as { n: number }
  ).n;
}
async function seed(id: string, by: "a" | "b"): Promise<void> {
  await tabsDb.insertOptimisticEntry(
    link,
    { id, type: "payment", amount: 10, note: null, occurred_at: 10 },
    false,
  );
  fixture
    .prepare("UPDATE tab_entries SET created_by=?,local_pending=0,seq=1,rev=1 WHERE id=?")
    .run(by, id);
}
function pending(error: unknown): boolean {
  return (error as { code?: string })?.code === "credit_confirmation_pending";
}

async function main(): Promise<void> {
  for (const scenario of [
    { label: "unlimited clerk", role: "clerk", defer: false },
    { label: "unlimited editor", role: "editor", defer: false },
    { label: "hard clerk", role: "clerk", mode: "clerk_block", editors: false, defer: true },
    { label: "hard editor", role: "editor", mode: "clerk_block", editors: true, defer: true },
    {
      label: "clerk-only policy editor",
      role: "editor",
      mode: "clerk_block",
      editors: false,
      defer: false,
    },
    { label: "warn editor", role: "editor", mode: "warn", editors: true, defer: false },
    {
      label: "owner",
      role: "owner",
      mode: "clerk_block",
      editors: true,
      override: "enforce",
      defer: false,
    },
    {
      label: "admin",
      role: "manager",
      mode: "clerk_block",
      editors: true,
      override: "enforce",
      defer: false,
    },
    {
      label: "bypass editor",
      role: "editor",
      mode: "clerk_block",
      editors: true,
      override: "bypass",
      defer: false,
    },
    {
      label: "enforced editor",
      role: "editor",
      mode: "clerk_block",
      editors: false,
      override: "enforce",
      defer: true,
    },
    {
      label: "bypass clerk",
      role: "clerk",
      mode: "clerk_block",
      editors: false,
      override: "bypass",
      defer: false,
    },
  ] as const) {
    reset();
    role = scenario.role;
    if ("mode" in scenario && scenario.mode) policy(scenario.mode, scenario.editors ?? false);
    if ("override" in scenario && scenario.override) override(scenario.override);
    const result = await flows.addTabEntry(PERSON, "debt", 12.34, null);
    assert.equal(!!result.pendingAdmission, scenario.defer, scenario.label);
    assert.equal(count("tab_outbox"), 1, `${scenario.label}: durable queue`);
    assert.equal(
      count("tab_entries"),
      scenario.defer ? 0 : 1,
      `${scenario.label}: visibility before acknowledgment`,
    );
    assert.equal(balance(), scenario.defer ? 0 : 1234, `${scenario.label}: exact recorded money`);
  }

  // Rejections and cancellations that could increase exposure remain intent
  // only. Concurrent/repeated gestures cannot build contradictory operations.
  for (const operation of ["dispute", "void", "accept"] as const) {
    reset();
    policy("clerk_block", true);
    await seed("target", operation === "void" ? "a" : "b");
    const act = () =>
      operation === "dispute"
        ? flows.disputeEntry(link, "target", "No")
        : operation === "void"
          ? flows.voidEntry(link, "target")
          : flows.acceptEntry(link, "target");
    const before = balance();
    await assert.rejects(act, pending, `${operation}: waiting result`);
    assert.equal(entry("target").status, "pending", `${operation}: original status retained`);
    assert.equal(entry("target").voided_by_entry_id, null, `${operation}: original not cancelled`);
    assert.equal(balance(), before, `${operation}: money unchanged before ack`);
    assert.equal(count("tab_outbox"), 1, `${operation}: durable pending op`);
    const waiting = await creditLists.listCreditIntents(PERSON, VAULT);
    assert.equal(waiting.length, 1, `${operation}: pending intent stays visible`);
    assert.equal(waiting[0].mutation, operation, `${operation}: visible operation label`);
    assert.equal(waiting[0].amount_afn, 10, `${operation}: visible exact amount`);
    assert.equal(waiting[0].admission_status, "pending", `${operation}: visible waiting status`);
    const persisted = fixture.prepare("SELECT * FROM tab_outbox").get() as TabOutboxRow;
    await assert.rejects(act, pending, `${operation}: duplicate prevented`);
    assert.equal(count("tab_outbox"), 1, `${operation}: no duplicate queue`);
    verdict = "refuse";
    await flush();
    assert.equal(count("tab_outbox"), 0, `${operation}: refused op no longer retries`);
    assert.equal(count("tab_failed_ops"), 1, `${operation}: terminal refusal durable`);
    assert.equal(balance(), before, `${operation}: refusal never records money`);
    assert.equal(entry("target").status, "pending", `${operation}: refusal preserves truth`);
    const refused = await creditLists.listCreditIntents(PERSON, VAULT);
    assert.equal(refused.length, 1, `${operation}: terminal result stays visible`);
    assert.equal(refused[0].admission_status, "refused", `${operation}: visible refusal status`);
    await tabsDb.rejectTabOp(persisted, "credit_limit_exceeded");
    assert.equal(count("tab_failed_ops"), 1, `${operation}: refusal result idempotent`);
  }

  reset();
  policy("clerk_block", true);
  await seed("accepted-after-ack", "b");
  verdict = "accept";
  await flows.acceptEntry(link, "accepted-after-ack");
  assert.equal(entry("accepted-after-ack").status, "accepted", "authoritative ack applies review");
  assert.equal(count("tab_outbox"), 0, "ack clears durable op");

  reset();
  policy("warn", true);
  await seed("warning-only-review", "b");
  await flows.disputeEntry(link, "warning-only-review", "");
  assert.equal(
    entry("warning-only-review").status,
    "disputed",
    "warning-only review works offline",
  );
  assert.equal(balance(), 0, "warning-only mode retains existing authority");
  fixture.close();
  console.log(
    "credit shared selftest: offline compatibility, editor/admin/override admission, deferred review/cancel, duplicate prevention and terminal refusals passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
