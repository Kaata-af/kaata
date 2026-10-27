// Real deletion/archive functions and append helpers against a synthetic store.
// Deferred database reads reproduce a kaata/account switch during an await.
// No user database, phone book, native module, or network is opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

type Scope = { vaultId: string; accountId: string | null };
let vaultId: string | null = "first-kaata";
let accountId: string | null = "first-account";
let dbReads = 0;
let queries: { sql: string; args: unknown[] }[] = [];
let events: any[] = [];
let archived = false;
let deleted = false;
let nextEvent = 0;
let archiveReads = 0;
let pause: { point: string; promise: Promise<void>; release: () => void; reached: boolean } | null =
  null;
const originalScope: Scope = { vaultId: "first-kaata", accountId: "first-account" };

async function checkpoint(point: string): Promise<void> {
  if (pause?.point !== point) return;
  pause.reached = true;
  await pause.promise;
}

const database = {
  getAllAsync: async (sql: string, ...args: unknown[]) => {
    queries.push({ sql, args });
    await checkpoint("relationships");
    return archived ? [] : [{ id: "first-relationship" }];
  },
  getFirstAsync: async (sql: string, ...args: unknown[]) => {
    queries.push({ sql, args });
    if (sql.includes("COUNT(*) AS n")) {
      await checkpoint("remaining-relationships");
      return { n: 0 };
    }
    if (sql.includes("SELECT phone_e164")) {
      await checkpoint("phone");
      return { phone_e164: null };
    }
    if (sql.includes("SELECT archived_at")) {
      await checkpoint(++archiveReads === 1 ? "archive-row" : "archive-preflight");
      return { archived_at: archived ? 10 : null };
    }
    if (sql.includes("FROM tab_entries")) {
      await checkpoint("tab-guard");
      return null;
    }
    if (sql.includes("INNER JOIN settlements")) {
      await checkpoint("chapter-guard");
      return null;
    }
    if (sql.includes("SELECT relationship_id, is_deleted")) {
      await checkpoint("delete-row");
      return { relationship_id: "first-relationship", is_deleted: deleted ? 1 : 0 };
    }
    if (sql.includes("SELECT is_deleted")) {
      await checkpoint("entry");
      return { is_deleted: deleted ? 1 : 0 };
    }
    throw new Error("unexpected synthetic query: " + sql);
  },
};
const tx = {
  getDb: async () => {
    const call = ++dbReads;
    await checkpoint("database-" + call);
    return database;
  },
  getActiveVaultIdSync: () => {
    if (!vaultId) throw new Error("no active kaata");
    return vaultId;
  },
  getActiveVaultIdSyncMaybe: () => vaultId,
  getAccountIdSync: () => accountId,
  getInstallIdSync: () => "synthetic-install",
  getLocalSelfUserIdSync: () => "self-" + accountId,
};
function compile(file: string, mocks: Record<string, any>): any {
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", "__DEV__", source)(
    (name: string) => {
      assert.ok(name in mocks, file + ": unexpected dependency " + name);
      return mocks[name];
    },
    exports,
    false,
  );
  return exports;
}
const append = compile("../event-log", {
  "expo-crypto": { randomUUID: () => "event-" + ++nextEvent },
  "./db-tx": tx,
  "./mesh/device-key": {},
  "./event-sig": {},
  "./money": {},
  "./money-sql": { signedEntryMinorSumSql: () => "0" },
  "./entry-date": require("../entry-date"),
  "./currency-scope": require("../currency-scope"),
  "./tabs/errors": { TabLinkedEntryError: class extends Error {} },
  "./projection": {
    applyEvent: async (event: any, options: any) => {
      await checkpoint(
        event.event_type === "person_phone_changed" ? "before-phone-preflight" : "before-preflight",
      );
      if (await options.preflightAbort?.(database)) return { applied: false, reason: "noop" };
      events.push(event);
      if (event.event_type === "person_archived") archived = true;
      if (event.event_type === "entry_deleted") deleted = true;
      return { applied: true };
    },
  },
});
const db = compile("../db", {
  "expo-crypto": {},
  "expo-sqlite": {},
  "./db-tx": tx,
  "./event-log": append,
  "./checkin-trigger": {},
  "./db-health": {},
  "./db-backup": {},
  "./trust/account-id": {},
  "./effective-account": {},
  "./phone": {},
  "./contacts-sync": {},
  "./uuid-v5": {},
  "./hlc": {},
  "./group-memberships": {},
  "./money-sql": { signedEntryMinorSumSql: () => "0" },
  "./entry-date": require("../entry-date"),
  "./currency-scope": require("../currency-scope"),
  "./vault-initial-currencies": {},
  "./tabs/history": require("../tabs/history"),
  "./tabs/db": {},
  "./tabs/direction": { tabBalanceSql: () => "0" },
  "./tabs/errors": { TabLinkedEntryError: class extends Error {} },
});

function reset() {
  vaultId = originalScope.vaultId;
  accountId = originalScope.accountId;
  dbReads = 0;
  queries = [];
  events = [];
  archived = false;
  deleted = false;
  archiveReads = 0;
  pause = null;
}
function deferAt(point: string) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  pause = { point, promise, release, reached: false };
  return pause;
}
async function untilPaused() {
  for (let turn = 0; turn < 50 && !pause?.reached; turn++) await Promise.resolve();
  assert.equal(pause?.reached, true, "the requested database suspension was reached");
}
async function rejectsScopeChange(
  mutation: (scope?: Scope) => Promise<void>,
  point: string,
  switchAccount: boolean,
  completedEvents = 0,
) {
  reset();
  const suspended = deferAt(point);
  const mutationResult = mutation(originalScope);
  const rejection = assert.rejects(mutationResult, /context changed/);
  await untilPaused();
  if (switchAccount) accountId = "next-account";
  else vaultId = "next-kaata";
  suspended.release();
  await rejection;
  assert.equal(
    events.length,
    completedEvents,
    point + ": no further event crosses the scope change",
  );
  assert.ok(
    events.every(
      (event) =>
        event.vault_id === originalScope.vaultId &&
        event.actor_account_id === originalScope.accountId,
    ),
    "an in-flight event never acquires the next vault/account",
  );
}

async function main() {
  const archive = (scope?: Scope) => db.archivePerson("shared-contact", scope);
  const remove = (scope?: Scope) => db.softDeleteEntry("entry", scope);
  for (const mutation of [archive, remove]) {
    reset();
    vaultId = "next-kaata";
    await assert.rejects(mutation(originalScope), /context changed/);
    assert.equal(
      dbReads,
      0,
      "an already-stale expected kaata is rejected before opening the database",
    );
    reset();
    accountId = null;
    await assert.rejects(mutation(originalScope), /context changed/);
    assert.equal(
      dbReads,
      0,
      "an already-stale expected account is rejected before opening the database",
    );
    for (const switchAccount of [false, true])
      await rejectsScopeChange(mutation, "database-1", switchAccount);
    // Existing one-argument callers receive the same synchronous scope capture.
    await rejectsScopeChange(() => mutation(), "database-1", false);
  }

  for (const point of [
    "relationships",
    "database-2",
    "archive-row",
    "before-preflight",
    "archive-preflight",
  ])
    for (const switchAccount of [false, true])
      await rejectsScopeChange(archive, point, switchAccount);
  for (const point of ["remaining-relationships", "database-3", "phone", "before-phone-preflight"])
    for (const switchAccount of [false, true])
      await rejectsScopeChange(archive, point, switchAccount, 1);
  for (const point of ["tab-guard", "chapter-guard", "entry"])
    for (const switchAccount of [false, true])
      await rejectsScopeChange(remove, point, switchAccount);

  reset();
  await archive(originalScope);
  assert.deepEqual(
    events.map((event) => event.event_type),
    ["person_archived", "person_phone_changed"],
  );
  assert.ok(events.every((event) => event.actor_account_id === originalScope.accountId));
  assert.equal(
    queries[0].args[1],
    originalScope.vaultId,
    "relationship lookup stays in the captured vault",
  );

  reset();
  await remove(originalScope);
  assert.deepEqual(
    events.map((event) => event.event_type),
    ["entry_deleted"],
  );
  assert.equal(events[0].vault_id, originalScope.vaultId);
  assert.equal(events[0].actor_account_id, originalScope.accountId);
  await remove(originalScope);
  assert.equal(events.length, 1, "repeated deletion remains an idempotent no-op");

  for (const switchAccount of [false, true]) {
    reset();
    const suspended = deferAt("database-2");
    const alreadyAppending = remove(originalScope);
    await untilPaused();
    if (switchAccount) accountId = "next-account";
    else vaultId = "next-kaata";
    suspended.release();
    await alreadyAppending;
    assert.equal(events.length, 1, "an already-started delete completes in its original scope");
    assert.equal(events[0].vault_id, originalScope.vaultId);
    assert.equal(events[0].actor_account_id, originalScope.accountId);
  }

  reset();
  accountId = null;
  await archive({ vaultId: originalScope.vaultId, accountId: null });
  assert.ok(
    events.every((event) => event.actor_account_id === null),
    "signed-out local use remains supported",
  );
  console.log(
    "PASS: archive/delete capture scope before await, reject stale vault/account at database boundaries, preserve append identity and local/idempotent behavior",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
