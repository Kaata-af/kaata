// Exercise the actual self-profile function against SQLite, with only native
// IO and the ledger append boundary replaced. No device/network data is read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import { canPerformAction, type VaultRole } from "../vault-roles";

function compile<T>(source: string, bindings: Record<string, unknown>): T {
  const exported: Record<string, unknown> = {};
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", ...Object.keys(bindings), output)(exported, ...Object.values(bindings));
  return exported as T;
}
function declaration(path: string, name: string): string {
  const source = readFileSync(require.resolve(path), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
  const node = ast.statements.find(
    (statement) =>
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === name,
  );
  assert.ok(node, `real declaration ${name}`);
  return node.getText(ast);
}
const { RoleGateRejectionError } = compile<typeof import("../event-log")>(
  declaration("../event-log", "RoleGateRejectionError"),
  {},
);
const fixture = new Database(":memory:");
fixture.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, is_local_self INTEGER,
  phone_e164 TEXT, updated_at INTEGER);
  INSERT INTO users VALUES ('self','Original Name',1,NULL,1),('peer','Peer Name',0,NULL,1);`);
let role: VaultRole = "viewer";
let vault: string | null = "read-only-vault";
let appendFailure: Error | null = null;
let appends = 0;
const db = {
  getFirstAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).get(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
};
const { updateSelfProfile } = compile<Pick<typeof import("../db"), "updateSelfProfile">>(
  declaration("../db", "updateSelfProfile"),
  {
    getDb: async () => db,
    getLocalSelfUserId: async () => "self",
    getActiveVaultIdSyncMaybe: () => vault,
    getAccountIdSync: () => "account-a",
    normalizePhone: (value: string) => value,
    RoleGateRejectionError,
    require: (path: string) => {
      assert.equal(path, "./use-vault-role");
      return { readVaultRole: async () => role, canPerformAction };
    },
    appendPersonRenamed: async ({ userId, name }: { userId: string; name: string }) => {
      appends++;
      if (appendFailure) throw appendFailure;
      fixture.prepare("UPDATE users SET display_name=? WHERE id=?").run(name, userId);
    },
    appendShopProfileUpdated: async () => {
      throw new Error("unexpected shop mutation");
    },
  },
);
const self = () =>
  fixture.prepare("SELECT display_name,phone_e164 FROM users WHERE id='self'").get();
async function main() {
  for (const restricted of ["viewer", "clerk"] as const) {
    role = restricted;
    await updateSelfProfile(`${restricted} Personal Name`, null, "+93700000001");
    assert.deepEqual(self(), {
      display_name: `${restricted} Personal Name`,
      phone_e164: "+93700000001",
    });
    assert.equal(appends, 0, `${restricted} profile edit does not attempt a ledger rename`);
    assert.equal(
      canPerformAction(restricted, "person.rename"),
      false,
      "ledger permission stays denied",
    );
  }
  console.log("PASS viewer/clerk can save personal name/phone without ledger rename authority");
  await updateSelfProfile("clerk Personal Name", null, "+93700000002");
  assert.equal(appends, 0, "an unchanged-name phone save never appends a rename");
  assert.equal((self() as { phone_e164: string }).phone_e164, "+93700000002");
  role = "editor";
  await updateSelfProfile("Editor Name", null);
  assert.equal(appends, 1, "authorized self rename retains the event-sourced path");
  assert.equal((self() as { display_name: string }).display_name, "Editor Name");
  console.log("PASS unchanged phone-only saves and authorized ledger rename remain distinct");
  appendFailure = new RoleGateRejectionError({
    reason: "insufficient_role",
    current_role: "viewer",
    required_role: "editor",
  });
  await updateSelfProfile("Demoted Personal Name", null);
  assert.equal((self() as { display_name: string }).display_name, "Demoted Personal Name");
  const peer = fixture.prepare("SELECT display_name FROM users WHERE id='peer'").get();
  assert.deepEqual(peer, { display_name: "Peer Name" }, "fallback is restricted to local self");
  appendFailure = new RoleGateRejectionError({
    reason: "bad_signature",
    current_role: "editor",
    required_role: "editor",
  });
  await assert.rejects(updateSelfProfile("Must Fail", null), RoleGateRejectionError);
  assert.equal((self() as { display_name: string }).display_name, "Demoted Personal Name");
  console.log(
    "PASS demotion refusal permits device identity only; signature/other gate failures stay failures",
  );
  appendFailure = null;
  vault = null;
  await updateSelfProfile("No Kaata Name", null);
  assert.equal((self() as { display_name: string }).display_name, "No Kaata Name");
  console.log("PASS personal identity saves without an active kaata");
  fixture.close();
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
