// Real reconciliation SQL and control flow against synthetic in-memory SQLite.
// Never opens a phone database, a real network endpoint or a user backup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { buildLocalAccountId } from "../trust/account-id";
import { compileUI } from "./ui-fixture";
import { Mutex } from "../util/mutex";
import type { TabResponse, WireTab } from "../tabs/types";

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
stub("../auth", {
  getSessionJWT: async () => jwt,
  captureCurrentSession: async () => ({ jwt, accountId: "synthetic-account" }),
  applyForCurrentSession: async (_: unknown, work: () => Promise<unknown>) => work(),
  SessionChangedError: class extends Error {},
});
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

async function tabParticipationReconcileTests(): Promise<void> {
  const store = new Database(":memory:");
  try {
    const source = readFileSync(require.resolve("../db"), "utf8");
    for (const migration of ["028", "030", "031", "041"]) {
      const ddl = source.match(
        new RegExp(
          "async function runMigration" +
            migration +
            "[\\s\\S]*?db\\.execAsync\\(`([\\s\\S]*?)`\\)",
        ),
      )?.[1];
      assert.ok(ddl, `use shipped tab migration ${migration}`);
      store.exec(ddl);
    }
    const tx = {
      getFirstAsync: async (sql: string, ...args: unknown[]) =>
        store.prepare(sql).get(...args) ?? null,
      getAllAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).all(...args),
      runAsync: async (sql: string, ...args: unknown[]) => store.prepare(sql).run(...args),
      withTransactionAsync: async (work: () => Promise<void>) => {
        store.exec("BEGIN");
        try {
          await work();
          store.exec("COMMIT");
        } catch (error) {
          store.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const dbTx = {
      getDb: async () => tx,
      getAccountIdSync: () => "account",
      getActiveVaultIdSyncMaybe: () => "vault",
    };
    const tabsDb = compileUI("../tabs/db", {
      "../db-tx": dbTx,
      "../currency-scope": require("../currency-scope"),
      "../entry-date": require("../entry-date"),
      "../money": require("../money"),
      "./direction": require("../tabs/direction"),
      "./errors": require("../tabs/errors"),
      "./wire": require("../tabs/wire"),
      "./history": require("../tabs/history"),
      "./events": { emitTabApplied() {} },
      "../ledger-events": { emitLedgerApplied() {} },
      "../projection": { applyEventMutex: new Mutex() },
    }) as typeof import("../tabs/db");
    let wire: WireTab;
    let expectedFlag: number | null;
    const requested: Array<{ tabId: string; afterRev: number }> = [];
    const tabSync = compileUI("../tabs/sync", {
      "react-native": { AppState: { currentState: "active" } },
      "expo-network": { getNetworkStateAsync: async () => ({ isConnected: true }) },
      "../auth": {
        getSessionJWT: async () => "tab-session",
        captureCurrentSession: async () => ({ jwt: "tab-session" }),
        applyForCurrentSession: async (_: unknown, work: () => Promise<unknown>) => work(),
        SessionChangedError: class extends Error {},
      },
      "../db-tx": dbTx,
      "../ledger-events": { onLedgerApplied: () => () => {} },
      "./db": tabsDb,
      "./direction": require("../tabs/direction"),
      "./errors": require("../tabs/errors"),
      "./inbox-reads": { flushInboxReads: async () => {} },
      "./events": { onTabApplied: () => () => {} },
      "./api": {
        resolveTabAuth: async () => ({ jwt: "tab-session" }),
        fetchMine: async () => ({
          tabs: [{ tab: wire, role: "a", vault_id: "vault", relationship_id: "relationship" }],
        }),
        fetchTab: async (_: unknown, tabId: string, afterRev: number): Promise<TabResponse> => {
          requested.push({ tabId, afterRev });
          const before = await tabsDb.getTabLink(tabId);
          assert.equal(afterRev, wire.rev, "metadata discovery preserves the stored pull cursor");
          assert.equal(before?.rev, wire.rev);
          assert.equal(before?.last_synced_at, 400);
          assert.equal(before?.history_order, "3");
          assert.equal(
            before?.unjoined_invitation,
            expectedFlag,
            "/mine cannot apply participation metadata before the pull",
          );
          return { tab: wire, entries: [], full: true };
        },
      },
    }) as typeof import("../tabs/sync");
    for (const [id, rev, cached, remote] of [
      ["upgrade-empty", 0, null, true],
      ["peer-participated", 7, 1, false],
    ] as const) {
      store.exec("DELETE FROM tab_links");
      store
        .prepare(
          `INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,rev,closed_at,linked_at,last_synced_at,history_order,unjoined_invitation)
        VALUES(?,'vault','relationship','a','AFN',?,200,100,400,'3',?)`,
        )
        .run(id, rev, cached);
      expectedFlag = cached;
      wire = {
        id,
        you: "a",
        currency: "AFN",
        rev,
        created_at_ms: 100,
        closed_at_ms: 200,
        closed_by: "a",
        unjoined_invitation: remote,
        parties: {
          a: { label: "Owner", joined_at_ms: 100, bound: true, history_order: "3" },
          b: { label: "Peer", joined_at_ms: remote ? null : 150, bound: !remote },
        },
        balance: { a: "0", b: "0" },
        pending_for_you: 0,
      };
      const before = requested.length;
      await tabSync.reconcileTabsFromServer();
      assert.deepEqual(
        requested.slice(before),
        [{ tabId: id, afterRev: rev }],
        "participation metadata changes trigger one pull despite unchanged revision and history order",
      );
      const refreshed = await tabsDb.getTabLink(id);
      assert.equal(refreshed?.rev, rev);
      assert.equal(refreshed?.unjoined_invitation, remote ? 1 : 0);
      await tabSync.reconcileTabsFromServer();
      assert.equal(
        requested.length,
        before + 1,
        "acknowledged participation metadata does not cause repeated pulls",
      );
      if (!remote) {
        for (const staleFlag of [true, undefined]) {
          const current = (await tabsDb.getTabLink(id))!;
          await tabsDb.upsertTabFromWire(current, {
            tab: {
              ...wire,
              unjoined_invitation: staleFlag,
              parties: {
                ...wire.parties,
                b: { ...wire.parties.b, joined_at_ms: null, bound: false },
              },
            },
            entries: [],
            full: false,
          });
          assert.equal(
            (await tabsDb.getTabLink(id))?.unjoined_invitation,
            0,
            "late same-revision metadata cannot undo confirmed participation or restore private eligibility",
          );
          assert.equal((await tabsDb.getTabLink(id))?.rev, rev);
        }
      }
    }
    console.log(
      "PASS: closed tab discovery refreshes unknown zero-revision participation and same-revision peer activity without advancing the cursor before pull",
    );
  } finally {
    store.close();
  }
}

async function run(): Promise<void> {
  try {
    await tabParticipationReconcileTests();
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
