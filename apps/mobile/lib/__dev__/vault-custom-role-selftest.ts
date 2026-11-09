import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { compileUI } from "./ui-fixture";

async function main() {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE vault_members_mirror (vault_id TEXT, account_id TEXT, role TEXT, accepted_at INTEGER, revoked_at INTEGER);
      INSERT INTO vault_members_mirror VALUES ('shop', 'account-a', 'editor', 1, NULL)`);
    const db = {
      getFirstAsync: async (statement: string, ...args: string[]) =>
        sql.prepare(statement).get(...args),
    };
    const dbModule = {
      getDb: async () => db,
      getAppMetaInTx: async (_db: unknown, key: string) =>
        sql.prepare("SELECT value FROM app_meta WHERE key=?").get(key)?.value ?? null,
      setAppMetaInTx: async (_db: unknown, key: string, value: string) =>
        sql.prepare("INSERT OR REPLACE INTO app_meta VALUES (?, ?)").run(key, value),
    };
    const policy = compileUI("../vault-custom-role-policy", {
      "./db-tx": dbModule,
      "./vault-roles": require("../vault-roles"),
    });
    const restricted = {
      id: "limited-editor",
      name: "Cashier",
      base_role: "editor",
      permissions: ["entry.create"],
    };
    let account = "account-a";
    let invalidations = 0;
    let response: unknown = { roles: [], assignments: [], effective_role: restricted };
    let onFetch: (() => void) | undefined;
    const client = compileUI(
      "../vault-custom-roles",
      {
        "./db-tx": dbModule,
        "./vault-custom-role-policy": policy,
        "./util/mutex": require("../util/mutex"),
        "./api": { getBackendUrl: async () => "https://fixture.invalid" },
        "./auth": {
          captureCurrentSession: async () => ({ jwt: account, accountId: account }),
          applyForCurrentSession: async (session: { accountId: string }, work: () => unknown) => {
            if (session.accountId !== account) throw new Error("session_changed");
            return work();
          },
        },
        "./projection": { applyEventMutex: { runExclusive: (work: () => unknown) => work() } },
        "./use-vault-role": {
          invalidateVaultRoleCache: () => {
            invalidations++;
          },
        },
      },
      {
        fetch: async (_url: string, options: RequestInit) => {
          assert.deepEqual(options.headers, { Authorization: `Bearer ${account}` });
          onFetch?.();
          return { ok: true, status: 200, json: async () => response };
        },
        AbortController,
        setTimeout,
        clearTimeout,
      },
    );

    await client.readCustomRoles("shop");
    assert.equal(invalidations, 1);
    assert.equal(await policy.deniedCustomRoleForEvent(db, "shop", account, "entry_created"), null);
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", account, "entry_deleted"),
      "editor",
    );
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", account, "tally_note_added"),
      "editor",
    );
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", account, "vault_member_removed"),
      null,
    );
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "another-shop", account, "entry_deleted"),
      null,
    );
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", "account-b", "entry_deleted"),
      null,
    );

    // Invalid payloads and a response crossing an account change cannot clear
    // a known restriction. A verified owner promotion can supersede it locally.
    response = {
      roles: [],
      assignments: [],
      effective_role: { ...restricted, permissions: ["vault.members"] },
    };
    await assert.rejects(client.readCustomRoles("shop"), {
      reason: "invalid_custom_roles_response",
    });
    response = { roles: [], assignments: [], effective_role: null };
    onFetch = () => {
      account = "account-b";
    };
    await assert.rejects(client.readCustomRoles("shop"), /session_changed/);
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", "account-a", "entry_deleted"),
      "editor",
    );
    sql.exec("UPDATE vault_members_mirror SET role='owner'");
    assert.equal(
      await policy.deniedCustomRoleForEvent(db, "shop", "account-a", "entry_deleted"),
      null,
    );
    sql.exec("UPDATE vault_members_mirror SET role='editor'");
    account = "account-a";
    onFetch = undefined;
    await client.readCustomRoles("shop");
    assert.equal(invalidations, 2);
    assert.equal(await policy.deniedCustomRoleForEvent(db, "shop", account, "entry_deleted"), null);
    console.log(
      "PASS custom roles: cached enforcement, account and Kaata isolation, owner promotion and clearing an assignment",
    );
  } finally {
    sql.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
