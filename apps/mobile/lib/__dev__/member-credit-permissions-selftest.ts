import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import { Mutex } from "../util/mutex";

const fixture = new Database(":memory:");
fixture.exec(`CREATE TABLE vault_member_credit_permissions(
  vault_id TEXT NOT NULL, account_id TEXT NOT NULL,
  credit_limit_override TEXT NOT NULL CHECK(credit_limit_override IN ('inherit','enforce','bypass')),
  updated_at_ms INTEGER NOT NULL, PRIMARY KEY(vault_id,account_id));`);
const db = {
  getFirstAsync: async (sql: string, ...args: any[]) => fixture.prepare(sql).get(...args) ?? null,
  runAsync: async (sql: string, ...args: any[]) => fixture.prepare(sql).run(...args),
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
};
let session = { jwt: "token", accountId: "owner", bindingVersion: 1 };
let emits = 0;
const guard = async (expected: typeof session, work: () => Promise<void>) => {
  if (
    expected.jwt !== session.jwt ||
    expected.accountId !== session.accountId ||
    expected.bindingVersion !== session.bindingVersion
  )
    throw new Error("session changed");
  await work();
};
const mocks: Record<string, unknown> = {
  "./api": { getBackendUrl: async () => "https://permissions.fixture.invalid" },
  "./auth": { captureCurrentSession: async () => ({ ...session }), applyForCurrentSession: guard },
  "./credit-policy-events": { emitCreditPoliciesChanged: () => emits++ },
  "./db-tx": { getDb: async () => db },
  "./util/mutex": { Mutex },
  "./projection": { applyEventMutex: new Mutex() },
};
const moduleExports: any = {};
const source = ts.transpileModule(
  readFileSync(require.resolve("../member-credit-permissions"), "utf8"),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
new Function("require", "exports", source)((name: string) => {
  assert.ok(name in mocks, `unexpected dependency ${name}`);
  return mocks[name];
}, moduleExports);
const client = moduleExports as typeof import("../member-credit-permissions");
const realFetch = globalThis.fetch;
let reply: unknown = [];
let status = 200;
let gate: Promise<void> | null = null;
let requests = 0;
globalThis.fetch = async (_url, init) => {
  assert.equal(fixture.inTransaction, false, "network stays outside SQLite transactions");
  assert.equal(
    init?.headers && (init.headers as Record<string, string>).Authorization,
    `Bearer ${session.jwt}`,
  );
  requests++;
  const response = reply;
  const responseStatus = status;
  if (gate) await gate;
  return new Response(JSON.stringify(response), { status: responseStatus });
};
const row = (value: "inherit" | "enforce" | "bypass", updated = 1) => ({
  account_id: "staff",
  credit_limit_override: value,
  updated_at_ms: updated,
});

async function run() {
  assert.equal(await client.readMemberCreditPermission("v", "staff"), "inherit");
  reply = [row("enforce")];
  await client.refreshMemberCreditPermissions("v");
  assert.equal(await client.readMemberCreditPermission("v", "staff"), "enforce");
  status = 404;
  await assert.rejects(client.refreshMemberCreditPermissions("v"), /404/);
  assert.equal(
    await client.readMemberCreditPermission("v", "staff"),
    "enforce",
    "older servers cannot erase a restriction",
  );
  status = 200;
  reply = [{ ...row("bypass"), updated_at_ms: "invalid" }];
  await assert.rejects(client.refreshMemberCreditPermissions("v"), /Invalid/);
  assert.equal(await client.readMemberCreditPermission("v", "staff"), "enforce");

  let release!: () => void;
  gate = new Promise<void>((done) => {
    release = done;
  });
  reply = [row("bypass", 2)];
  const priorRequests = requests;
  const stale = client.refreshMemberCreditPermissions("v");
  while (requests === priorRequests) await Promise.resolve();
  session = { ...session, bindingVersion: session.bindingVersion + 1 };
  release();
  await assert.rejects(stale, /session changed/);
  gate = null;
  assert.equal(
    await client.readMemberCreditPermission("v", "staff"),
    "enforce",
    "previous session's response cannot update cache",
  );

  reply = row("bypass", 3);
  await client.saveMemberCreditPermission("v", "staff", "bypass");
  assert.equal(await client.readMemberCreditPermission("v", "staff"), "bypass");
  status = 409;
  reply = { error_code: "member_cloud_enrollment_required", error: "member must enroll first" };
  await assert.rejects(
    client.saveMemberCreditPermission("v", "local:staff", "enforce"),
    (error: unknown) =>
      error instanceof client.MemberCreditPermissionError &&
      error.reason === "member_cloud_enrollment_required",
  );
  status = 200;
  assert.equal(emits, 2, "only committed permission changes notify consumers");
  reply = { ...row("enforce", 4), account_id: "other-staff" };
  await assert.rejects(client.saveMemberCreditPermission("v", "staff", "enforce"), /Invalid saved/);
  assert.equal(await client.readMemberCreditPermission("v", "staff"), "bypass");

  gate = new Promise<void>((done) => {
    release = done;
  });
  reply = [row("enforce", 5)];
  const beforeRefresh = requests;
  const refresh = client.refreshMemberCreditPermissions("v");
  while (requests === beforeRefresh) await Promise.resolve();
  const save = client.saveMemberCreditPermission("v", "staff", "bypass");
  await Promise.resolve();
  assert.equal(requests, beforeRefresh + 1, "save waits for the older refresh");
  reply = row("bypass", 6);
  release();
  gate = null;
  await Promise.all([refresh, save]);
  assert.equal(
    await client.readMemberCreditPermission("v", "staff"),
    "bypass",
    "older refresh cannot overwrite the new save",
  );

  reply = [];
  await client.refreshMemberCreditPermissions("v");
  assert.equal(
    await client.readMemberCreditPermission("v", "staff"),
    "inherit",
    "successful empty listing clears old exceptions",
  );
  console.log(
    "PASS member credit permission API/cache: absent endpoint, malformed responses, session changes, saved identity, refresh/save ordering and authoritative empty listing",
  );
}
run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = realFetch;
    fixture.close();
  });
