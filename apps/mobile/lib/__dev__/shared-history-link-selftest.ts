// Product flows use the shipped link/outbox code and synthetic SQLite/session
// boundaries. No app, live account, backend, or phone is opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import ts from "typescript";
import type { TabLink, WireTab } from "../tabs/types";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const VAULT = "vault",
  REL = "relationship",
  PERSON = "person";
let fixture: Database.Database;
let accountId = "account",
  jwt: string | null = "fixture-jwt",
  bindingVersion = 1;
let activeVault = VAULT;
let role = "editor";
let online = true;
let displayBalance = 12.34;
let confirmedSharedBalance = 0;
let roleWait: (() => Promise<void>) | null = null;
let syncWait: (() => Promise<void>) | null = null;
let syncStep: ((id: string) => Promise<void>) | null = null;
let discoveryWait: (() => Promise<void>) | null = null;
let afterCreatePerson: (() => Promise<void>) | null = null;
let requestWait: (() => Promise<void>) | null = null;
let joinError: Error | null = null;
const requests: Array<{ kind: string; body: any; accountId: string; auth: any }> = [];
const synced: string[] = [],
  archived: string[] = [];
const marked: unknown[] = [];
const source = readFileSync(require.resolve("../db"), "utf8");
function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(required, exports);
  return exports as T;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class SessionChangedError extends Error {}
function snapshot() {
  return { jwt, accountId, bindingVersion };
}
async function current<T>(
  expected: ReturnType<typeof snapshot>,
  run: () => Promise<T>,
): Promise<T> {
  if (
    !expected.jwt ||
    expected.jwt !== jwt ||
    expected.accountId !== accountId ||
    expected.bindingVersion !== bindingVersion
  )
    throw new SessionChangedError("session changed");
  return run();
}
const sqlite = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  withTransactionAsync: async (run: () => Promise<void>) => {
    fixture.exec("BEGIN");
    try {
      await run();
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
  },
};
const dbTx = {
  getDb: async () => sqlite,
  getAccountIdSync: () => accountId,
  getActiveVaultIdSyncMaybe: () => activeVault,
  setActiveVaultId: async (id: string) => {
    activeVault = id;
  },
};
const tabsDb = compile<typeof import("../tabs/db")>("../tabs/db", (name) => {
  if (name === "../db-tx") return dbTx;
  if (name === "../projection")
    return { applyEventMutex: { runExclusive: (run: () => unknown) => run() } };
  if (name === "../ledger-events") return { emitLedgerApplied() {} };
  if (name === "../money") return require("../money");
  if (name === "../entry-date") return require("../entry-date");
  if (name === "../currency-scope") return require("../currency-scope");
  if (name === "./events") return { emitTabApplied() {} };
  if (name.startsWith("./")) return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected tab-db dependency ${name}`);
});
const errors = require("../tabs/errors") as typeof import("../tabs/errors");
function wire(id = "invited", you: "a" | "b" = "b"): WireTab {
  return {
    id,
    you,
    currency: "AFN",
    rev: 10,
    created_at_ms: 1,
    closed_at_ms: null,
    closed_by: null,
    parties: {
      a: { label: "A", joined_at_ms: 1, bound: true, history_order: "3" },
      b: { label: "B", joined_at_ms: 1, bound: true, history_order: "3" },
    },
    balance: { a: "0", b: "0" },
    pending_for_you: 0,
  };
}
const flows = compile<typeof import("../tabs/link")>("../tabs/link", (name) => {
  if (name === "expo-crypto") return { randomUUID };
  if (name === "expo-network")
    return { getNetworkStateAsync: async () => ({ isConnected: online }) };
  if (name === "react-native") return { Linking: {} };
  if (name === "../auth")
    return {
      captureCurrentSession: async () => snapshot(),
      applyForCurrentSession: current,
      getSessionJWT: async () => jwt,
      updateAccountPhone: async () => {},
      SessionChangedError,
    };
  if (name === "../db-tx") return dbTx;
  if (name === "../use-vault-role")
    return {
      readVaultRole: async () => {
        const wait = roleWait;
        roleWait = null;
        if (wait) await wait();
        return role;
      },
    };
  if (name === "../credit-admission") return { hardLimitApplies: async () => false };
  if (name === "../entry-date") return require("../entry-date");
  if (name === "../currency-scope") return require("../currency-scope");
  if (name === "../money" || name === "../types" || name === "../vault-roles")
    return require("../" + name.slice(3));
  if (name === "../currency") return { applyVaultCurrency: async () => {} };
  if (name === "../db")
    return {
      getActiveRelationshipIdForPerson: async () => REL,
      getLocalSelf: async () => ({ phone: null }),
      getPerson: async () => ({
        id: PERSON,
        balance: displayBalance,
        tab_confirmed_balance: confirmedSharedBalance,
      }),
      bumpUsageCounter: async () => {},
      createPerson: async () => {
        fixture
          .prepare("INSERT INTO relationships VALUES('new-relationship', ?, 'new-person', NULL, 1)")
          .run(VAULT);
        if (afterCreatePerson) await afterCreatePerson();
        return { ok: true, id: "new-person" };
      },
      archivePerson: async (id: string) => {
        archived.push(id);
        fixture.prepare("UPDATE relationships SET archived_at=1 WHERE user_b_id=?").run(id);
      },
    };
  if (name === "../event-log") return { RoleGateRejectionError: class extends Error {} };
  if (name === "../vault-router") return { VaultHasOpenTabError: class extends Error {} };
  if (name === "../sync/push") return { pushEvents: async () => ({ pushed: 0, duplicates: 0 }) };
  if (name === "./db") return tabsDb;
  if (name === "./api")
    return {
      createTab: async (body: unknown, auth: unknown) => {
        requests.push({ kind: "create", body, accountId, auth });
        if (requestWait) await requestWait();
        return {
          tab: wire("created", "a"),
          entries: [],
          my_token: "my-token",
          invite_url: "https://example.test/t/invite",
        };
      },
      joinTab: async (auth: unknown, id: string, body: unknown) => {
        requests.push({ kind: "join", body, accountId, auth });
        if (requestWait) await requestWait();
        if (joinError) throw joinError;
        return { tab: wire(id), entries: [], full: true };
      },
    };
  if (name === "./sync")
    return {
      syncTab: async (id: string) => {
        synced.push(id);
        const wait = syncWait;
        syncWait = null;
        if (wait) await wait();
        if (syncStep) await syncStep(id);
        return { ok: online, error: online ? null : "offline" };
      },
      reconcileTabsFromServer: async () => {
        const wait = discoveryWait;
        discoveryWait = null;
        if (wait) await wait();
      },
      takeAppendOutcome: () => null,
    };
  if (name === "./inbox-reads")
    return {
      markInboxHandled: async (spec: unknown) => {
        marked.push(spec);
      },
    };
  if (name.startsWith("./")) return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected link dependency ${name}`);
});
function ddl(marker: string) {
  const statement = new RegExp("execAsync\\(`([^`]*" + marker + "[^`]*)`\\)").exec(source)?.[1];
  assert.ok(statement, `shipped schema ${marker}`);
  return statement;
}
function reset() {
  fixture?.close();
  fixture = new Database(":memory:");
  fixture.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,currency TEXT);
    CREATE TABLE relationships(id TEXT PRIMARY KEY,vault_id TEXT,user_b_id TEXT,archived_at INTEGER,created_at INTEGER);
    INSERT INTO vaults VALUES('${VAULT}','AFN');
    INSERT INTO relationships VALUES('${REL}','${VAULT}','${PERSON}',NULL,1);`);
  for (const marker of [
    "CREATE TABLE IF NOT EXISTS tab_links",
    "CREATE TABLE IF NOT EXISTS tab_failed_ops",
    "CREATE TABLE IF NOT EXISTS tab_settlements",
    "ALTER TABLE tab_entries ADD COLUMN author_account_id",
    "ALTER TABLE tab_entries ADD COLUMN author_member_role",
    "ALTER TABLE tab_links ADD COLUMN history_order",
  ])
    fixture.exec(ddl(marker));
  jwt = "fixture-jwt";
  accountId = "account";
  bindingVersion = 1;
  activeVault = VAULT;
  role = "editor";
  online = true;
  displayBalance = 12.34;
  confirmedSharedBalance = 0;
  roleWait = syncWait = discoveryWait = afterCreatePerson = requestWait = null;
  syncStep = null;
  joinError = null;
  requests.length = synced.length = archived.length = marked.length = 0;
}
async function seedLink(id = "prior", overrides: Partial<TabLink> = {}): Promise<TabLink> {
  const link: TabLink = {
    tab_id: id,
    vault_id: VAULT,
    relationship_id: REL,
    role: "a",
    currency: "AFN",
    party_token: null,
    my_label: "A",
    other_label: "B",
    other_joined_at: 1,
    history_order: "1",
    invite_url: null,
    rev: 5,
    closed_at: 100,
    linked_at: 1,
    last_synced_at: 1,
    last_error: null,
    ...overrides,
  };
  await tabsDb.upsertTabLink(link);
  return link;
}
function seedEntry(link: TabLink, id = "entry", by = "b", status = "pending") {
  fixture
    .prepare(
      `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status)
    VALUES (?,?,1,1,?,'a_to_b',1000,'entry',1,1,?)`,
    )
    .run(id, link.tab_id, by, status);
}
function count(table: string) {
  return (fixture.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
const newTarget = { vaultId: VAULT, newPerson: { firstName: "New", lastName: null, phone: null } };
let passed = 0,
  failed = 0;
async function test(name: string, run: () => Promise<void>) {
  reset();
  try {
    await run();
    console.log(`PASS ${++passed}: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`, error);
  }
}
async function main() {
  await test("closed pending entries permit one final authorized review/cancellation for either closure reason", async () => {
    for (const reason of [null, "account_deleted"] as const)
      for (const action of ["accept", "dispute", "void"] as const) {
        reset();
        const link = await seedLink("prior", { closed_reason: reason });
        seedEntry(link, "entry", action === "void" ? "a" : "b");
        if (action === "accept") await flows.acceptEntry(link, "entry");
        else if (action === "dispute") await flows.disputeEntry(link, "entry", " correction ");
        else await flows.voidEntry(link, "entry");
        const operations = await sqlite.getAllAsync("SELECT op FROM tab_outbox");
        assert.deepEqual(operations, [{ op: action }]);
        assert.equal((await tabsDb.getTabLink(link.tab_id))?.closed_at, 100);
        if (action !== "void")
          await assert.rejects(flows.acceptEntry(link, "entry"), errors.TabReviewFinalError);
      }
  });
  await test("closed entries retain role/session authorization and accepted entries cannot be cancelled", async () => {
    const link = await seedLink();
    seedEntry(link);
    for (role of ["viewer", "clerk"]) {
      await assert.rejects(flows.acceptEntry(link, "entry"), errors.TabPermissionError);
      await assert.rejects(flows.disputeEntry(link, "entry", ""), errors.TabPermissionError);
      await assert.rejects(flows.voidEntry(link, "entry"), errors.TabPermissionError);
    }
    role = "editor";
    jwt = null;
    await assert.rejects(flows.acceptEntry(link, "entry"));
    jwt = "fixture-jwt";
    fixture.prepare("UPDATE tab_entries SET created_by='a',status='accepted'").run();
    await assert.rejects(flows.voidEntry(link, "entry"), errors.TabReviewFinalError);
    assert.equal(count("tab_outbox"), 0);
  });
  await test("relink sends the freshly synchronized authoritative prior ID/revision", async () => {
    await seedLink("older", { history_order: "1", linked_at: 9999 });
    await seedLink("newer", { history_order: "2", linked_at: 1 });
    syncWait = async () => {
      fixture.prepare("UPDATE tab_links SET rev=19 WHERE tab_id='newer'").run();
      displayBalance = 45.67;
    };
    const result = await flows.linkContact(PERSON, { myLabel: " A " });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.expected_previous_tab_id, "newer");
    assert.equal(requests[0].body.expected_previous_rev, 19);
    assert.deepEqual(requests[0].body.expected_history_revisions, { older: 5, newer: 19 });
    assert.equal(requests[0].body.opening.amount, "45.67");
    assert.equal(
      requests[0].auth.jwt,
      "fixture-jwt",
      "create uses the initiating session explicitly",
    );
    assert.equal(result.link.history_order, "3");
    assert.equal((await tabsDb.getTabLink("older"))?.closed_at, 100);
  });
  await test("new sharing without history does not fabricate a prior receipt", async () => {
    displayBalance = 0;
    await flows.linkContact(PERSON, { myLabel: "A" });
    assert.equal(requests[0].body.opening, null);
    assert.equal(requests[0].body.expected_previous_tab_id, undefined);
    assert.equal(requests[0].body.expected_previous_rev, undefined);
  });
  await test("relink discovers a missing earlier period before copying its complete revision snapshot", async () => {
    await seedLink("newer", { history_order: "2" });
    discoveryWait = async () => {
      await seedLink("restored-older", { history_order: "1", rev: 8 });
    };
    await flows.linkContact(PERSON, { myLabel: "A" });
    assert.deepEqual(requests[0].body.expected_history_revisions, {
      newer: 5,
      "restored-older": 8,
    });
    assert.ok(
      synced.includes("restored-older"),
      "the discovered book is pulled before its balance is copied",
    );
  });
  await test("private offset cannot silently replace an earlier confirmed loan with no opening", async () => {
    await seedLink();
    confirmedSharedBalance = 300;
    displayBalance = 0;
    await assert.rejects(
      flows.linkContact(PERSON, { myLabel: "A" }),
      (err: unknown) =>
        err instanceof errors.TabApiError && err.code === "shared_history_opening_required",
    );
    assert.equal(requests.length, 0, "old confirmed debt needs an explicit reviewable opening");
    assert.equal((await tabsDb.getTabLink("prior"))?.closed_at, 100);
  });
  await test("pending, unsynced action and queued operations refuse relinking before a new request", async () => {
    for (const kind of ["pending", "local", "outbox"] as const) {
      reset();
      const link = await seedLink();
      seedEntry(link, "entry", "b", kind === "pending" ? "pending" : "accepted");
      if (kind === "local") fixture.prepare("UPDATE tab_entries SET local_action_pending=1").run();
      if (kind === "outbox")
        await tabsDb.enqueueTabOp({
          id: "waiting",
          tab_id: link.tab_id,
          op: "close",
          payload: "{}",
          created_at: 1,
          attempts: 0,
          next_at: 999999,
          last_error: null,
        });
      await assert.rejects(
        flows.linkContact(PERSON, { myLabel: "A" }),
        (error: any) => error.code === "shared_history_pending",
      );
      assert.equal(requests.length, 0);
    }
  });
  await test("unlink queues the server-verified invitation cleanup opt-in without local financial edits", async () => {
    const link = await seedLink("unused", {
      closed_at: null,
      other_joined_at: null,
      unjoined_invitation: 1,
    });
    seedEntry(link, "opening", "a");
    fixture.prepare("UPDATE tab_entries SET kind='opening' WHERE id='opening'").run();
    const before = fixture.prepare("SELECT * FROM tab_entries").all();
    await flows.unlinkContact(link);
    const operations = fixture.prepare("SELECT op,payload FROM tab_outbox").all() as Array<{
      op: string;
      payload: string;
    }>;
    assert.equal(operations.length, 1);
    assert.equal(operations[0].op, "close");
    assert.deepEqual(JSON.parse(operations[0].payload), { withdraw_unjoined_opening: true });
    assert.deepEqual(fixture.prepare("SELECT * FROM tab_entries").all(), before);
    assert.notEqual(
      (await tabsDb.getTabLink(link.tab_id))?.closed_at,
      null,
      "the queued close immediately stops new local sharing",
    );
  });
  await test("relink cleans a refreshed legacy untouched opening before collecting its new revision receipt", async () => {
    const link = await seedLink("unused", { other_joined_at: null, unjoined_invitation: null });
    seedEntry(link, "opening", "a");
    fixture.prepare("UPDATE tab_entries SET kind='opening' WHERE id='opening'").run();
    let cleanups = 0;
    syncStep = async (id) => {
      const queued = fixture
        .prepare("SELECT id,op,payload FROM tab_outbox WHERE tab_id=?")
        .all(id) as Array<{
        id: string;
        op: string;
        payload: string;
      }>;
      if (!queued.length) {
        fixture.prepare("UPDATE tab_links SET unjoined_invitation=1 WHERE tab_id=?").run(id);
        return;
      }
      assert.equal(requests.length, 0, "a new invitation must wait for opening withdrawal");
      assert.equal(queued.length, 1);
      assert.equal(queued[0].op, "close");
      assert.deepEqual(JSON.parse(queued[0].payload), { withdraw_unjoined_opening: true });
      cleanups++;
      // Model the committed server response; the product flow must use this
      // fresh revision, not its pre-cleanup snapshot.
      fixture
        .prepare("UPDATE tab_entries SET voided_by_entry_id='server-void',rev=6 WHERE id='opening'")
        .run();
      fixture.prepare("UPDATE tab_links SET rev=6 WHERE tab_id=?").run(id);
      fixture.prepare("DELETE FROM tab_outbox WHERE id=?").run(queued[0].id);
    };
    await flows.linkContact(PERSON, { myLabel: "A" });
    assert.equal(cleanups, 1);
    assert.deepEqual(synced, ["unused", "unused"]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.expected_previous_tab_id, "unused");
    assert.equal(requests[0].body.expected_previous_rev, 6);
    assert.deepEqual(requests[0].body.expected_history_revisions, { unused: 6 });
    assert.equal(requests[0].body.opening.amount, "12.34");
  });
  await test("real pending claims and false or unknown invitation metadata never trigger cleanup", async () => {
    for (const [kind, invitation] of [
      ["entry", 1],
      ["opening", 0],
      ["opening", null],
    ] as const) {
      reset();
      const link = await seedLink("prior", {
        other_joined_at: null,
        unjoined_invitation: invitation,
      });
      seedEntry(link, "pending", "a");
      fixture.prepare("UPDATE tab_entries SET kind=? WHERE id='pending'").run(kind);
      await assert.rejects(
        flows.linkContact(PERSON, { myLabel: "A" }),
        (error: unknown) =>
          error instanceof errors.TabApiError && error.code === "shared_history_pending",
      );
      assert.equal(requests.length, 0);
      assert.equal(
        count("tab_outbox"),
        0,
        "ordinary or unverified history cannot be auto-withdrawn",
      );
      assert.equal(
        (
          fixture
            .prepare("SELECT voided_by_entry_id FROM tab_entries WHERE id='pending'")
            .get() as { voided_by_entry_id: string | null }
        ).voided_by_entry_id,
        null,
      );
    }
  });
  await test("retiring the duplicate opening leaves genuine ordinary claims blocking relink", async () => {
    const link = await seedLink("unused", { other_joined_at: null, unjoined_invitation: 1 });
    seedEntry(link, "opening", "a");
    fixture.prepare("UPDATE tab_entries SET kind='opening',seq=2 WHERE id='opening'").run();
    seedEntry(link, "ordinary", "a");
    let cleanups = 0;
    syncStep = async (id) => {
      const operations = fixture
        .prepare("SELECT id FROM tab_outbox WHERE tab_id=?")
        .all(id) as Array<{ id: string }>;
      if (!operations.length) return;
      cleanups++;
      fixture
        .prepare("UPDATE tab_entries SET voided_by_entry_id='server-void',rev=6 WHERE id='opening'")
        .run();
      fixture.prepare("UPDATE tab_links SET rev=6 WHERE tab_id=?").run(id);
      fixture.prepare("DELETE FROM tab_outbox WHERE id=?").run(operations[0].id);
    };
    await assert.rejects(
      flows.linkContact(PERSON, { myLabel: "A" }),
      (error: unknown) =>
        error instanceof errors.TabApiError && error.code === "shared_history_pending",
    );
    assert.equal(cleanups, 1);
    assert.equal(requests.length, 0);
    assert.equal(count("tab_outbox"), 0);
    assert.deepEqual(
      fixture
        .prepare("SELECT status,voided_by_entry_id FROM tab_entries WHERE id='ordinary'")
        .get(),
      {
        status: "pending",
        voided_by_entry_id: null,
      },
    );
  });
  await test("fresh participation evidence prevents cleanup of a previously unused cached invitation", async () => {
    const link = await seedLink("unused", { other_joined_at: null, unjoined_invitation: 1 });
    seedEntry(link, "opening", "a");
    fixture.prepare("UPDATE tab_entries SET kind='opening' WHERE id='opening'").run();
    syncStep = async (id) => {
      fixture.prepare("UPDATE tab_links SET unjoined_invitation=0 WHERE tab_id=?").run(id);
    };
    await assert.rejects(
      flows.linkContact(PERSON, { myLabel: "A" }),
      (error: unknown) =>
        error instanceof errors.TabApiError && error.code === "shared_history_pending",
    );
    assert.equal(count("tab_outbox"), 0);
    assert.equal(requests.length, 0);
  });
  await test("session replacement during legacy invitation refresh cannot enqueue cleanup for the new account", async () => {
    const link = await seedLink("unused", { other_joined_at: null, unjoined_invitation: 1 });
    seedEntry(link, "opening", "a");
    fixture.prepare("UPDATE tab_entries SET kind='opening' WHERE id='opening'").run();
    syncWait = async () => {
      accountId = "replacement-account";
      jwt = "replacement-jwt";
      bindingVersion++;
    };
    await assert.rejects(flows.linkContact(PERSON, { myLabel: "A" }), SessionChangedError);
    assert.equal(requests.length, 0);
    assert.equal(
      count("tab_outbox"),
      0,
      "old-account cleanup must stay bound to the initiating session",
    );
  });
  await test("offline or unknown prior ordering fails closed instead of guessing a carry receipt", async () => {
    await seedLink();
    online = false;
    await assert.rejects(
      flows.linkContact(PERSON, { myLabel: "A" }),
      errors.TabAuthUnavailableError,
    );
    assert.equal(requests.length, 0);
    online = true;
    fixture.prepare("UPDATE tab_links SET history_order=NULL").run();
    await assert.rejects(flows.linkContact(PERSON, { myLabel: "A" }));
    assert.equal(requests.length, 0);
  });
  await test("a fresh invite can join closed finished history, but open contacts and closed invites are refused", async () => {
    await seedLink();
    await flows.joinTabAsContact("token", wire(), { vaultId: VAULT, personId: PERSON }, "B");
    assert.equal(requests[0].body.expected_previous_tab_id, "prior");
    assert.equal(requests[0].body.expected_previous_rev, 5);
    assert.deepEqual(requests[0].auth, {
      token: "token",
      jwt: "fixture-jwt",
      recordingMode: "review",
      requireRecordingSupport: true,
    });
    reset();
    await seedLink("open", { closed_at: null });
    await assert.rejects(
      flows.joinTabAsContact("token", wire(), { vaultId: VAULT, personId: PERSON }, "B"),
      errors.TabAlreadyLinkedError,
    );
    assert.equal(requests.length, 0);
    await assert.rejects(
      flows.joinTabAsContact("token", { ...wire(), closed_at_ms: 10 }, newTarget, "B"),
      errors.TabClosedError,
    );
    assert.equal(
      count("relationships"),
      1,
      "closed invitations cannot even create an unwanted contact",
    );
  });
  await test("unidentified restored modes block new local financial intent until refreshed", async () => {
    fixture.exec(
      "CREATE TABLE users(display_name TEXT,is_local_self INTEGER); INSERT INTO users VALUES('A',1)",
    );
    const link = await seedLink("unknown", { closed_at: null, recording_mode_known: 0 });
    const before = count("tab_entries");
    await assert.rejects(
      flows.addTabEntry(PERSON, "debt", 10, null),
      (error: any) => error.code === "notification_only_unsupported",
    );
    await assert.rejects(
      flows.unlinkContact(link),
      (error: any) => error.code === "notification_only_unsupported",
    );
    assert.equal(count("tab_entries"), before);
    assert.equal(
      count("tab_outbox"),
      0,
      "a failed refresh cannot optimistically change source money or close the account",
    );
    assert.equal((await tabsDb.getTabLink(link.tab_id))!.closed_at, null);
    syncStep = async () => {
      fixture.prepare("UPDATE tab_links SET recording_mode_known=1,recording_mode='review'").run();
    };
    await flows.addTabEntry(PERSON, "debt", 10, null);
    assert.equal(count("tab_outbox"), 1, "explicit metadata restores the existing review workflow");
    assert.equal(count("tab_entries"), before + 1);
  });
  await test("definite failed join rolls back its newly created contact; ambiguous timeouts preserve it", async () => {
    joinError = new errors.TabApiError(409, "same_account", "refused");
    await assert.rejects(
      flows.joinTabAsContact("token", wire(), newTarget, "B"),
      errors.TabSameAccountError,
    );
    assert.deepEqual(archived, ["new-person"]);
    reset();
    joinError = new errors.TabApiError(503, "unavailable", "uncertain");
    await assert.rejects(flows.joinTabAsContact("token", wire(), newTarget, "B"));
    assert.deepEqual(archived, [], "a possible server binding must remain recoverable");
    reset();
    joinError = new errors.TabApiError(
      503,
      "notification_only_unsupported",
      "feature preflight refused",
    );
    await assert.rejects(flows.joinTabAsContact("token", wire(), newTarget, "B"));
    assert.deepEqual(
      archived,
      ["new-person"],
      "known unsupported capability cannot have claimed the new contact",
    );
  });
  await test("a stale carried opening refuses Join and cleans only a newly created contact", async () => {
    const prior = await seedLink();
    seedEntry(prior, "saved-source", "a", "recorded");
    const saved = fixture.prepare("SELECT * FROM tab_entries").all();
    const metadata = fixture.prepare("SELECT * FROM tab_links").all();
    joinError = new errors.TabApiError(409, "opening_source_changed", "source changed");
    await assert.rejects(
      flows.joinTabAsContact("token", { ...wire(), recording_mode: "notify" }, newTarget, "B"),
      (error: any) => error.code === "opening_source_changed",
    );
    assert.equal(archived.length, 1, "a definite refusal cannot leave a phantom new contact");
    assert.deepEqual(fixture.prepare("SELECT * FROM tab_entries").all(), saved);
    assert.deepEqual(fixture.prepare("SELECT * FROM tab_links").all(), metadata);
    assert.equal(count("tab_outbox"), 0);
    reset();
    const existing = await seedLink();
    seedEntry(existing, "saved-source", "a", "recorded");
    const before = fixture.prepare("SELECT * FROM tab_entries").all();
    joinError = new errors.TabApiError(409, "opening_source_changed", "source changed");
    await assert.rejects(
      flows.joinTabAsContact(
        "token",
        { ...wire(), recording_mode: "notify" },
        { vaultId: VAULT, personId: PERSON },
        "B",
      ),
      (error: any) => error.code === "opening_source_changed",
    );
    assert.equal(archived.length, 0, "an existing contact is never rolled back");
    assert.deepEqual(fixture.prepare("SELECT * FROM tab_entries").all(), before);
    assert.equal(count("relationships"), 1);
  });
  await test("the shipped Join handler stops a stale invitation with sender recovery guidance", async () => {
    const screen = ts.createSourceFile(
      "join.tsx",
      readFileSync(require.resolve("../../app/t/[token]"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let handler: ts.FunctionDeclaration | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "runJoin") handler = node;
      ts.forEachChild(node, visit);
    };
    visit(screen);
    assert.ok(handler, "exercise the actual screen handler rather than a copied error map");
    const emitted = ts.transpileModule(handler.getText(screen), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const code of ["opening_source_changed", "network"]) {
      const state = { stage: "preview", error: "", retryable: true, pickError: "", pickerReads: 0 };
      const joiningRef = { current: false };
      const bindings = {
        ...errors,
        token: "token",
        tab: { ...wire(), recording_mode: "notify" },
        joiningRef,
        getLocalSelf: async () => ({ name: "Me" }),
        joinTabAsContact: async () => {
          throw new errors.TabApiError(code === "network" ? 0 : 409, code, code);
        },
        t: (key: string) => key,
        setPickError: (value: string) => {
          state.pickError = value;
        },
        setPhoneError: () => {},
        setStage: (value: string) => {
          state.stage = value;
        },
        setErrorMsg: (value: string) => {
          state.error = value;
        },
        setRetryable: (value: boolean) => {
          state.retryable = value;
        },
        setVaultId: () => {},
        setContactsAttempt: () => {},
        loadFacts: async () => {
          state.pickerReads++;
          return [];
        },
        console: { warn() {} },
      };
      const run = new Function(...Object.keys(bindings), emitted + "\nreturn runJoin;")(
        ...Object.values(bindings),
      );
      await run({ vaultId: VAULT, personId: PERSON }, "Sender");
      assert.equal(joiningRef.current, false);
      if (code === "opening_source_changed") {
        assert.equal(state.stage, "error");
        assert.equal(state.error, "tab.join.openingChanged");
        assert.equal(
          state.retryable,
          false,
          "the same stale invitation has no misleading Retry button",
        );
        assert.equal(
          state.pickerReads,
          0,
          "choosing another local contact cannot repair sender history",
        );
        assert.equal(state.pickError, null);
      } else {
        assert.equal(
          state.stage,
          "pick",
          "ordinary transport failures keep their existing retry flow",
        );
        assert.equal(state.pickError, "entry.saveFailed");
        assert.equal(state.pickerReads, 1);
      }
    }
  });
  await test("a preflight failure after local contact creation also cleans up before any join request", async () => {
    afterCreatePerson = async () => {
      const prior = await seedLink("concurrent-history", { relationship_id: "new-relationship" });
      seedEntry(prior);
    };
    await assert.rejects(flows.joinTabAsContact("token", wire(), newTarget, "B"));
    assert.equal(requests.length, 0);
    assert.deepEqual(archived, ["new-person"]);
  });
  await test("unknown ordering discovered after new-contact creation is a definite pre-request cleanup", async () => {
    afterCreatePerson = async () => {
      await seedLink("concurrent-history", {
        relationship_id: "new-relationship",
        history_order: null,
      });
    };
    await assert.rejects(flows.joinTabAsContact("token", wire(), newTarget, "B"));
    assert.equal(requests.length, 0);
    assert.deepEqual(
      archived,
      ["new-person"],
      "no server request can have claimed this new contact",
    );
  });
  await test("review tap cannot cross an account switch during asynchronous authorization", async () => {
    for (const action of ["accept", "dispute", "void"] as const) {
      reset();
      const link = await seedLink();
      seedEntry(link, "entry", action === "void" ? "a" : "b");
      const started = deferred(),
        release = deferred();
      roleWait = async () => {
        started.resolve();
        await release.promise;
      };
      const reviewing =
        action === "accept"
          ? flows.acceptEntry(link, "entry")
          : action === "dispute"
            ? flows.disputeEntry(link, "entry", "")
            : flows.voidEntry(link, "entry");
      await started.promise;
      accountId = "replacement";
      jwt = "replacement-jwt";
      bindingVersion++;
      release.resolve();
      await assert.rejects(reviewing, SessionChangedError);
      assert.equal(count("tab_outbox"), 0);
    }
  });
  await test("relink cannot cross an account switch while old history is syncing", async () => {
    await seedLink();
    const started = deferred(),
      release = deferred();
    syncWait = async () => {
      started.resolve();
      await release.promise;
    };
    const linking = flows.linkContact(PERSON, { myLabel: "A" });
    await started.promise;
    accountId = "replacement";
    jwt = "replacement-jwt";
    bindingVersion++;
    release.resolve();
    await assert.rejects(linking, SessionChangedError);
    assert.equal(requests.length, 0);
  });
  await test("late create/join acknowledgements cannot cache links into a replacement session", async () => {
    for (const action of ["create", "join"] as const) {
      reset();
      const started = deferred(),
        release = deferred();
      requestWait = async () => {
        started.resolve();
        await release.promise;
      };
      const work =
        action === "create"
          ? flows.linkContact(PERSON, { myLabel: "A" })
          : flows.joinTabAsContact("token", wire(), { vaultId: VAULT, personId: PERSON }, "B");
      await started.promise;
      accountId = "replacement";
      jwt = "replacement-jwt";
      bindingVersion++;
      release.resolve();
      await assert.rejects(work, SessionChangedError);
      assert.equal(count("tab_links"), 0);
    }
  });
  await test("switching kaatas while authorizing a closed review never queues an old-scope action", async () => {
    const link = await seedLink();
    seedEntry(link);
    const started = deferred(),
      release = deferred();
    roleWait = async () => {
      started.resolve();
      await release.promise;
    };
    const reviewing = flows.acceptEntry(link, "entry");
    await started.promise;
    activeVault = "another-vault";
    release.resolve();
    await assert.rejects(reviewing, errors.TabAuthUnavailableError);
    assert.equal(count("tab_outbox"), 0);
  });
  console.log(`\n${passed} shared-history link regressions passed; ${failed} failed.`);
  if (failed) process.exitCode = 1;
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fixture?.close());
