// Real reconciliation SQL and control flow against synthetic in-memory SQLite.
// Never opens a phone database, a real network endpoint or a user backup.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildLocalAccountId } from "../trust/account-id";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const fixture = new Database(":memory:");
fixture.exec(`
  CREATE TABLE vaults (id TEXT PRIMARY KEY, name TEXT, currency TEXT, created_at INTEGER,
    updated_at INTEGER, registered_with_server_at INTEGER, account_id TEXT,
    vault_trust_anchor_pubkey TEXT, archived_at INTEGER);
  CREATE TABLE vault_members_mirror (vault_id TEXT, account_id TEXT, role TEXT,
    accepted_at INTEGER, revoked_at INTEGER);
  CREATE TABLE event_log (vault_id TEXT, server_acked_at INTEGER, rejected_at INTEGER,
    tombstone_reason TEXT);
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
`);
const sqlite = {
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
};
function stub(name: string, exports: object): void {
  const filename = require.resolve(name);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...exports },
  } as NodeJS.Module;
}
let jwt: string | null = "synthetic-session";
let online = true;
const pulls: string[] = [];
const pushes: string[] = [];
const registrations: string[] = [];
const currentPubkey = Buffer.alloc(32, 1).toString("base64");
const retiredPubkey = Buffer.alloc(32, 2).toString("base64");
const foreignPubkey = Buffer.alloc(32, 3).toString("base64");
stub("expo-network", { getNetworkStateAsync: async () => ({ isConnected: online }) });
stub("../auth", { getSessionJWT: async () => jwt });
stub("../db-tx", {
  getDb: async () => sqlite,
  getAccountIdSync: () => "synthetic-account",
  refreshAccountIdCache: async () => "synthetic-account",
  getActiveVaultIdSyncMaybe: () => "active",
});
stub("../mesh/device-key", {
  ensureDeviceKey: async () => ({}),
  getDevicePubkey: () => "own-anchor",
  getRetiredDevicePubkeysSync: () => [],
  readOwnDevicePubkeys: async () => ({ current: currentPubkey, retired: [retiredPubkey] }),
});
stub("../vault-api", {
  createVaultOnServer: async (request: { vault_id: string }) =>
    registrations.push(request.vault_id),
  listVaults: async () => [],
});
stub("../sync/pull", {
  pullEvents: async (id: string) => {
    pulls.push(id);
    if (id === "member-slow") throw new Error("synthetic radio failure");
  },
});
stub("../sync/push", { pushEvents: async (id: string) => pushes.push(id) });
const { fullBackupSweep } = require("../sync/reconcile") as typeof import("../sync/reconcile");

const vault = fixture.prepare(
  "INSERT INTO vaults VALUES (?, ?, 'AFN', 1, 1, ?, 'synthetic-account', ?, ?)",
);
const member = fixture.prepare("INSERT INTO vault_members_mirror VALUES (?, ?, 'editor', ?, ?)");
for (const id of ["active", "owned-inactive"]) vault.run(id, id, 1, "own-anchor", null);
vault.run("owned-needs-registration", "Own", null, "own-anchor", null);
for (const id of [
  "member-inactive",
  "member-slow",
  "revoked",
  "other-account",
  "not-accepted",
  "archived-member",
  "archived-member-outbox",
  "archived-probe",
]) {
  vault.run(id, id, null, "foreign-anchor", id.startsWith("archived") ? 2 : null);
  member.run(
    id,
    id === "other-account" ? "another-account" : "synthetic-account",
    id === "not-accepted" ? null : 1,
    id === "revoked" ? 2 : null,
  );
}
fixture.prepare("INSERT INTO event_log VALUES ('archived-member-outbox', NULL, NULL, NULL)").run();
fixture.prepare("INSERT INTO app_meta VALUES ('server_archived_probe:archived-probe', '1')").run();
for (const [id, pubkey, revokedAt] of [
  ["member-local-key", currentPubkey, null],
  ["member-retired-key", retiredPubkey, null],
  ["revoked-local-key", currentPubkey, 2],
  ["foreign-local-key", foreignPubkey, null],
] as const) {
  vault.run(id, id, null, "foreign-anchor", null);
  member.run(id, buildLocalAccountId(pubkey), 1, revokedAt);
}

async function run(): Promise<void> {
  try {
    await fullBackupSweep();
    assert.deepEqual(
      registrations,
      ["owned-needs-registration"],
      "joined vaults never register as owned",
    );
    assert.deepEqual(
      pulls.sort(),
      [
        "archived-member-outbox",
        "archived-probe",
        "member-inactive",
        "member-local-key",
        "member-retired-key",
        "member-slow",
        "owned-inactive",
        "owned-needs-registration",
      ].sort(),
      "active memberships join the fallback sweep even without a registration stamp",
    );
    assert.ok(pushes.includes("member-inactive"));
    assert.ok(pushes.includes("member-local-key"));
    assert.ok(pushes.includes("member-retired-key"));
    assert.ok(
      !pushes.includes("member-slow"),
      "one failed member vault does not stop other vaults",
    );
    assert.equal(
      (
        fixture
          .prepare("SELECT registered_with_server_at FROM vaults WHERE id='member-inactive'")
          .get() as { registered_with_server_at: number | null }
      ).registered_with_server_at,
      null,
      "membership reads do not turn a joined vault into an owned registration",
    );
    const before = [pulls.length, pushes.length, registrations.length];
    online = false;
    await fullBackupSweep();
    online = true;
    jwt = null;
    await fullBackupSweep();
    assert.deepEqual(
      [pulls.length, pushes.length, registrations.length],
      before,
      "offline and signed-out sweeps make no requests",
    );
    console.log(
      "PASS: owned and joined non-active vault fallback, accepted/current-account/revoked/archive gates, registration ownership, per-vault failure, offline and sign-out",
    );
  } finally {
    fixture.close();
  }
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
