// Synthetic fixtures only: never opens a phone's database or the network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import type { SessionSnapshot } from "../auth";
import type { VaultListing } from "../vault-api";
import { runMembersScreenSelftest } from "./members-screen-selftest";

function compile<T>(source: string, mocks: Record<string, unknown> = {}): T {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", code)((name: string) => {
    assert.ok(name in mocks, `unexpected dependency ${name}`);
    return mocks[name];
  }, exports);
  return exports as T;
}

const fixture = new Database(":memory:");
fixture.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE vaults (id TEXT PRIMARY KEY);
  INSERT INTO vaults VALUES ('v'), ('other');
  CREATE TABLE vault_members_mirror (
    vault_id TEXT, account_id TEXT, role TEXT, display_name TEXT,
    accepted_at INTEGER, revoked_at INTEGER, PRIMARY KEY(vault_id, account_id)
  );
  INSERT INTO vault_members_mirror VALUES ('v', 'peer', 'viewer', 'Admission name', 1, NULL);
  INSERT INTO vault_members_mirror VALUES ('v', 'viewer-a', 'owner', 'A', 1, NULL);
  INSERT INTO vault_members_mirror VALUES ('v', 'viewer-b', 'editor', 'B', 1, NULL);
  INSERT INTO vault_members_mirror VALUES ('other', 'peer', 'viewer', 'Other vault name', 1, NULL);
  CREATE TABLE users (account_id TEXT, display_name TEXT);
`);
const db = {
  execAsync: async (sql: string) => fixture.exec(sql),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (work: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await work();
      fixture.exec("COMMIT");
    } catch (err) {
      fixture.exec("ROLLBACK");
      throw err;
    }
  },
};

// Execute the actual appended migration, without importing db.ts's native IO.
const dbSource = readFileSync(require.resolve("../db"), "utf8");
const ast = ts.createSourceFile("db.ts", dbSource, ts.ScriptTarget.ES2022, true);
const migration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "runMigration033",
);
assert.ok(migration, "migration033 exists");
const migrations = compile<{ run: (connection: typeof db) => Promise<void> }>(
  'const MIGRATION_033 = "033_vault_member_profiles";\n' +
    migration.getText(ast) +
    "\nexports.run = runMigration033;",
);

let session: SessionSnapshot = { bindingVersion: 1, jwt: "token-a", accountId: "viewer-a" };
let calls = 0;
let response = async (): Promise<VaultListing[]> => [];
let dbGate: Promise<void> | null = null;
class ApiError extends Error {
  constructor(readonly status: number) {
    super("refused");
  }
}
const profiles = compile<typeof import("../member-profiles")>(
  readFileSync(require.resolve("../member-profiles"), "utf8"),
  {
    "./auth": {
      captureCurrentSession: async () => ({ ...session }),
      applyForCurrentSession: async (before: SessionSnapshot, work: () => Promise<unknown>) => {
        assert.deepEqual(before, session, "a changed session refuses old profile writes");
        return work();
      },
    },
    "./db-tx": {
      getDb: async () => {
        if (dbGate) await dbGate;
        return db;
      },
    },
    "./i18n": {
      isPlaceholderSelfName: (name: string) => name === "You" || name === "شما",
      t: (key: string) =>
        ({
          "members.youSuffix": " (You)",
          "recovery.selfPlaceholderName": "You",
          "members.nameUnavailable": "Name unavailable",
        })[key] ?? key,
    },
    "./vault-api": {
      ApiError,
      listVaults: async () => {
        calls++;
        return response();
      },
    },
  },
);
const listing = (name: string, email = "peer@example.test"): VaultListing[] => [
  {
    vault_id: "v",
    name: "House",
    role: "owner",
    members_count: 1,
    created_at_ms: 1,
    vault_epoch: 0,
    members: [{ account_id: "peer", role: "viewer", name, email }],
  },
];
const cached = (viewer = "viewer-a") =>
  fixture
    .prepare(
      "SELECT display_name, email FROM vault_member_profiles WHERE viewer_account_id = ? AND vault_id = 'v'",
    )
    .all(viewer);
const memberScreen = readFileSync(require.resolve("../../app/vault/members"), "utf8");
const memberSQL = memberScreen.match(/`(SELECT vmm\.account_id[\s\S]+?)`/)?.[1];
assert.ok(memberSQL, "the screen's actual member query exists");
const visiblePeer = (viewer: string, vault = "v") =>
  fixture
    .prepare(memberSQL)
    .all(viewer, viewer, vault)
    .find((row) => (row as { account_id: string }).account_id === "peer") as {
    display_name: string | null;
    profile_name: string | null;
    email: string | null;
    has_profile: number;
  };
const deferred = () => {
  let resolve!: (value: VaultListing[]) => void;
  const promise = new Promise<VaultListing[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function main() {
  await migrations.run(db);
  assert.equal(
    (fixture.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number })
      .count,
    1,
  );
  response = async () => listing("Ahmad");
  await profiles.refreshMemberProfiles("v");
  assert.deepEqual(cached(), [{ display_name: "Ahmad", email: "peer@example.test" }]);
  response = async () => listing("احمد‌ ولی", "new@example.test");
  await profiles.refreshMemberProfiles("v");
  assert.deepEqual(cached(), [{ display_name: "احمد‌ ولی", email: "new@example.test" }]);
  assert.deepEqual(
    fixture
      .prepare(
        "SELECT role, display_name FROM vault_members_mirror WHERE account_id = 'peer' AND vault_id = 'v'",
      )
      .get(),
    {
      role: "viewer",
      display_name: "Admission name",
    },
    "a rename never changes signed admission names or roles",
  );
  console.log(
    "PASS migration033, current names/emails replace cache, ZWNJ and admission history preserved",
  );

  const old = deferred();
  response = () => old.promise;
  const late = profiles.refreshMemberProfiles("v");
  await Promise.resolve();
  response = async () => listing("Newest");
  await profiles.refreshMemberProfiles("v");
  old.resolve(listing("Old response"));
  await late;
  assert.equal((cached()[0] as { display_name: string }).display_name, "Newest");
  console.log("PASS a late response cannot overwrite a newer refresh");

  let openDb!: () => void;
  dbGate = new Promise<void>((resolve) => {
    openDb = resolve;
  });
  response = async () => listing("Waiting for DB");
  const waiting = profiles.refreshMemberProfiles("v");
  await new Promise<void>((done) => setImmediate(done));
  dbGate = null;
  response = async () => listing("Won while DB was busy");
  await profiles.refreshMemberProfiles("v");
  openDb();
  await waiting;
  assert.equal((cached()[0] as { display_name: string }).display_name, "Won while DB was busy");
  console.log("PASS stale refresh is rechecked after DB acquisition");

  const oldSession = deferred();
  response = () => oldSession.promise;
  const stale = profiles.refreshMemberProfiles("v");
  await Promise.resolve();
  session = { bindingVersion: 2, jwt: "token-b", accountId: "viewer-b" };
  oldSession.resolve(listing("Wrong account"));
  await assert.rejects(stale);
  assert.deepEqual(cached("viewer-b"), []);
  response = async () => listing("For B");
  await profiles.refreshMemberProfiles("v");
  assert.equal((cached()[0] as { display_name: string }).display_name, "Won while DB was busy");
  assert.equal((cached("viewer-b")[0] as { display_name: string }).display_name, "For B");
  assert.equal(visiblePeer("viewer-a").display_name, "Won while DB was busy");
  assert.equal(visiblePeer("viewer-b").display_name, "For B");
  assert.equal(
    visiblePeer("viewer-b", "other").email,
    null,
    "another vault never reads this cache",
  );
  console.log(
    "PASS session changes refuse old writes; cached email is scoped to the authorized viewer",
  );

  fixture
    .prepare("UPDATE vault_members_mirror SET revoked_at = 2 WHERE account_id = 'viewer-b'")
    .run();
  assert.equal(
    visiblePeer("viewer-b").email,
    null,
    "a local revocation hides cached co-member email immediately",
  );
  fixture
    .prepare(
      "UPDATE vault_members_mirror SET revoked_at = NULL, accepted_at = NULL WHERE account_id = 'viewer-b'",
    )
    .run();
  assert.equal(
    visiblePeer("viewer-b").email,
    null,
    "a pending membership is not profile authority",
  );
  fixture
    .prepare("UPDATE vault_members_mirror SET accepted_at = 1 WHERE account_id = 'viewer-b'")
    .run();
  assert.equal(visiblePeer("viewer-b").email, "peer@example.test");
  fixture
    .prepare(
      "UPDATE vault_members_mirror SET accepted_at = NULL WHERE account_id = 'peer' AND vault_id = 'v'",
    )
    .run();
  assert.equal(
    visiblePeer("viewer-b").email,
    null,
    "a re-invited pending peer cannot expose an old cached email",
  );
  fixture
    .prepare(
      "UPDATE vault_members_mirror SET accepted_at = 1 WHERE account_id = 'peer' AND vault_id = 'v'",
    )
    .run();
  console.log(
    "PASS screen query rechecks accepted/unrevoked caller and peer membership without changing roles",
  );

  response = async () => {
    throw new Error("offline");
  };
  await assert.rejects(profiles.refreshMemberProfiles("v"));
  assert.equal(cached("viewer-b").length, 1, "offline keeps the authorized cache");
  response = async () => {
    throw new ApiError(403);
  };
  await assert.rejects(profiles.refreshMemberProfiles("v"));
  assert.deepEqual(cached("viewer-b"), [], "refused access clears cached email");
  response = async () => listing("For B");
  await profiles.refreshMemberProfiles("v");
  response = async () => [];
  await profiles.refreshMemberProfiles("v");
  assert.deepEqual(cached("viewer-b"), [], "no longer listed clears profiles");
  console.log("PASS offline cache, refusal and membership loss handled differently");

  response = async () => listing("You", "");
  await profiles.refreshMemberProfiles("v");
  assert.deepEqual(cached("viewer-b"), [{ display_name: null, email: null }]);
  assert.equal(
    visiblePeer("viewer-b").display_name,
    null,
    "a fresh name clear cannot revive an admission name",
  );
  assert.equal(
    profiles.memberIdentityName(
      { has_profile: 1, profile_name: "New", display_name: "Old" },
      false,
      null,
    ),
    "New",
  );
  assert.equal(
    profiles.memberIdentityName(
      { has_profile: 1, profile_name: null, display_name: "Old" },
      false,
      null,
    ),
    "Name unavailable",
  );
  assert.equal(
    profiles.memberIdentityName(
      { has_profile: 1, profile_name: null, display_name: "Old" },
      true,
      "Local old",
    ),
    "You",
  );
  assert.equal(
    profiles.memberIdentityName({ display_name: "Old" }, true, "Local new"),
    "Local new (You)",
  );
  assert.equal(
    profiles.memberIdentityName({ display_name: "You" }, false, null),
    "Name unavailable",
  );
  assert.equal(profiles.memberIdentityName({}, true, "You"), "You");
  session = { bindingVersion: 3, jwt: null, accountId: null };
  const before = calls;
  assert.equal(await profiles.refreshMemberProfiles("v"), false);
  assert.equal(calls, before, "offline local-CA has no profile lookup");
  fixture.prepare("DELETE FROM vaults WHERE id = 'v'").run();
  assert.equal(
    (
      fixture.prepare("SELECT COUNT(*) AS count FROM vault_member_profiles").get() as {
        count: number;
      }
    ).count,
    0,
  );
  console.log(
    "PASS nameless peers never become role labels; self fallback, local-only mode and vault cleanup",
  );
  fixture.close();
  await runMembersScreenSelftest();
}
void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
