// Executes the shipped sync loop against synthetic SQLite and HTTP boundaries.
// Never opens a phone, kaata.db, or a live account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import type {
  MineResponse,
  TabAppliedEvent,
  TabLink,
  TabOutboxRow,
  TabResponse,
} from "../tabs/types";
import { Mutex } from "../util/mutex";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const fixture = new Database(":memory:");
const dbSource = readFileSync(require.resolve("../db"), "utf8");
const ddl = dbSource.match(
  /async function runMigration028[\s\S]*?db\.execAsync\(`([\s\S]*?)`\)/,
)?.[1];
assert.ok(ddl, "use the shipped tab schema");
fixture.exec(ddl);
const failedDdl = dbSource.match(
  /async function runMigration029[\s\S]*?db\.execAsync\(`([\s\S]*?)`\)/,
)?.[1];
assert.ok(failedDdl, "use the shipped refused-operation schema");
fixture.exec(failedDdl);
for (const migration of ["030", "031", "041"]) {
  const extraDdl = dbSource.match(
    new RegExp(
      "async function runMigration" + migration + "[\\s\\S]*?db\\.execAsync\\(`([\\s\\S]*?)`\\)",
    ),
  )?.[1];
  assert.ok(extraDdl, `use shipped migration ${migration}`);
  fixture.exec(extraDdl);
}
const realNow = Date.now;
let now = 1_000_000;
Date.now = () => now;
let online = true;
let signedIn = true;
let pendingQueries = 0;
const pulls: string[] = [];
const reviews: string[] = [];
const apiCalls: string[] = [];
const cursors: number[] = [];
const remoteClosed = new Map<string, number | null>();
const remoteOrder = new Map<string, string | null | undefined>();
let mineTabs: MineResponse["tabs"] = [];
let useRealCache = false;
const applied: TabAppliedEvent[] = [];
const applyEventMutex = new Mutex();
let closeOutcome: "success" | "retry" | "refuse" = "success";

function compile<T>(path: string, required: (name: string) => unknown): T {
  const exports = {};
  const output = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", output)(required, exports);
  return exports as T;
}
function getLink(id: string): TabLink | null {
  return (fixture.prepare("SELECT * FROM tab_links WHERE tab_id=?").get(id) as TabLink) ?? null;
}
const sqlite = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => {
    if (sql.includes("SELECT tl.tab_id FROM tab_links")) pendingQueries++;
    return fixture.prepare(sql).all(...args);
  },
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
const tabsDb = compile<typeof import("../tabs/db")>("../tabs/db", (name) => {
  if (name === "../db-tx")
    return {
      getDb: async () => sqlite,
      getAccountIdSync: () => "account",
      getActiveVaultIdSyncMaybe: () => "vault",
    };
  if (name === "../projection") return { applyEventMutex };
  if (name === "../ledger-events") return { emitLedgerApplied() {} };
  if (name === "../money") return require("../money");
  if (name === "./events")
    return { emitTabApplied: (event: TabAppliedEvent) => applied.push(event) };
  if (name.startsWith("./")) return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected outbox dependency ${name}`);
});
const { TabApiError } = require("../tabs/errors") as typeof import("../tabs/errors");
const queued = () =>
  fixture.prepare("SELECT * FROM tab_outbox ORDER BY rowid").all() as TabOutboxRow[];
const queue = (op: TabOutboxRow) => tabsDb.enqueueTabOp(op);
function response(id: string): TabResponse {
  const link = getLink(id)!;
  const closedAt = remoteClosed.has(id) ? remoteClosed.get(id)! : link.closed_at;
  return {
    tab: {
      id,
      currency: link.currency,
      rev: link.rev,
      created_at_ms: 1,
      closed_at_ms: closedAt,
      closed_by: closedAt != null ? "a" : null,
      you: link.role,
      parties: {
        a: { label: "A", joined_at_ms: 1, bound: true, history_order: remoteOrder.get(id) },
        b: { label: "B", joined_at_ms: 1, bound: true },
      },
      balance: { a: "0", b: "0" },
      pending_for_you: 0,
    },
    entries: [],
    full: false,
  };
}
const sync = compile<typeof import("../tabs/sync")>("../tabs/sync", (name) => {
  if (name === "react-native") return { AppState: { currentState: "active" } };
  if (name === "expo-network")
    return { getNetworkStateAsync: async () => ({ isConnected: online }) };
  if (name === "../auth")
    return {
      getSessionJWT: async () => (signedIn ? "fixture-jwt" : null),
      captureCurrentSession: async () => ({ jwt: signedIn ? "fixture-jwt" : null }),
      applyForCurrentSession: async (_: unknown, work: () => Promise<unknown>) => work(),
      SessionChangedError: class extends Error {},
    };
  if (name === "../db-tx") return { getDb: async () => sqlite };
  if (name === "../ledger-events") return { onLedgerApplied: () => () => {} };
  if (name === "./api")
    return {
      resolveTabAuth: async () => ({ jwt: "fixture-jwt" }),
      fetchMine: async () => ({ tabs: mineTabs }),
      fetchTab: async (_: unknown, id: string, afterRev: number) => {
        pulls.push(id);
        cursors.push(afterRev);
        return response(id);
      },
      acceptTabEntry: async (_: unknown, id: string, entry: string) => {
        apiCalls.push("accept");
        reviews.push(`${id}:${entry}`);
        return { ...response(id), entry: { id: entry } };
      },
      appendTabEntry: async (_: unknown, id: string, entry: { id: string }) => {
        apiCalls.push("append");
        if (remoteClosed.get(id) != null) throw new TabApiError(409, "tab_closed", "closed");
        return { ...response(id), entry, duplicate_hint: null };
      },
      closeTab: async (_: unknown, id: string) => {
        apiCalls.push("close");
        if (closeOutcome === "retry") throw new TabApiError(503, "unavailable", "retry later");
        if (closeOutcome === "refuse")
          throw new TabApiError(403, "role_insufficient", "permission changed");
        remoteClosed.set(id, now);
        return response(id);
      },
    };
  if (name === "./db")
    return {
      ...tabsDb,
      // The server/cache boundary below only applies metadata needed by this
      // scheduling fixture. Outbox order, retry and failed receipts are real.
      upsertTabFromWire: async (...args: Parameters<typeof tabsDb.upsertTabFromWire>) => {
        if (useRealCache) return tabsDb.upsertTabFromWire(...args);
        const result = args[1];
        fixture
          .prepare("UPDATE tab_links SET closed_at=? WHERE tab_id=?")
          .run(result.tab.closed_at_ms, result.tab.id);
        return { newFromThem: 0, statusChangedOnMine: 0 };
      },
    };
  if (name === "./inbox-reads") return { flushInboxReads: async () => {} };
  if (name === "./events") return { onTabApplied: () => () => {} };
  if (name === "./direction" || name === "./errors") return require("../tabs/" + name.slice(2));
  throw new Error(`Unexpected sync dependency ${name}`);
});

function seed(
  id: string,
  opts: { open?: boolean; rev?: number; status?: string; kind?: string; voided?: boolean } = {},
) {
  fixture
    .prepare(
      `INSERT INTO tab_links(tab_id,vault_id,relationship_id,role,currency,rev,closed_at,linked_at,last_synced_at)
     VALUES (?, 'vault', ?, 'a', 'AFN', ?, ?, 1, 1)`,
    )
    .run(id, `rel:${id}`, opts.rev ?? 5, opts.open ? null : 100);
  if (opts.status)
    fixture
      .prepare(
        `INSERT INTO tab_entries(id,tab_id,seq,rev,created_by,direction,amount_minor,kind,occurred_at,created_at,status,voided_by_entry_id)
       VALUES (?, ?, 1, 1, 'b', 'a_to_b', 100, ?, 1, 1, ?, ?)`,
      )
      .run(
        `entry:${id}`,
        id,
        opts.kind ?? "entry",
        opts.status,
        opts.voided ? "void-reference" : null,
      );
}
let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  fixture.exec(
    "DELETE FROM tab_failed_ops; DELETE FROM tab_outbox; DELETE FROM tab_entries; DELETE FROM tab_links",
  );
  pulls.length = 0;
  reviews.length = 0;
  apiCalls.length = 0;
  cursors.length = 0;
  remoteClosed.clear();
  remoteOrder.clear();
  mineTabs = [];
  useRealCache = false;
  applied.length = 0;
  closeOutcome = "success";
  pendingQueries = 0;
  now = 1_000_000;
  online = signedIn = true;
  sync._resetTabSyncPacingForTests();
  await run();
  console.log(`PASS ${++passed}: ${name}`);
}
async function main() {
  await test("upgrade discovery backfills completed closed history order without a financial revision bump", async () => {
    for (const [id, order] of [
      ["earlier", "71"],
      ["later", "72"],
    ]) {
      seed(id, { status: "accepted" });
      fixture
        .prepare(
          "UPDATE tab_links SET relationship_id='scope',my_label='A',other_label='B',other_joined_at=1 WHERE tab_id=?",
        )
        .run(id);
      remoteOrder.set(id, order);
      mineTabs.push({
        tab: response(id).tab,
        role: "a",
        vault_id: "vault",
        relationship_id: "scope",
      });
    }
    useRealCache = true;
    await sync.reconcileTabsFromServer();
    assert.deepEqual(
      pulls.sort(),
      ["earlier", "later"],
      "closed accepted periods are not left stranded by the normal skip",
    );
    assert.deepEqual(
      cursors,
      [5, 5],
      "backfill does not fabricate a financial revision or rewind the cursor",
    );
    assert.equal(getLink("earlier")?.history_order, "71");
    assert.equal(getLink("later")?.history_order, "72");
    assert.deepEqual(
      applied.map((event) => event.tabId).sort(),
      ["earlier", "later"],
      "the actual cache writer notifies the loading PersonDetail screen",
    );
    pulls.length = 0;
    applied.length = 0;
    await sync.reconcileTabsFromServer();
    assert.deepEqual(pulls, [], "the same backfill is not pulled repeatedly");
    assert.deepEqual(applied, []);
  });
  await test("older or malformed server order metadata never causes endless closed-history pulls", async () => {
    seed("closed", { status: "accepted" });
    fixture.prepare("UPDATE tab_links SET history_order='17'").run();
    for (const order of [undefined, null, "", "0", "01", "unknown"]) {
      remoteOrder.set("closed", order);
      mineTabs = [
        {
          tab: response("closed").tab,
          role: "a",
          vault_id: "vault",
          relationship_id: "rel:closed",
        },
      ];
      await sync.reconcileTabsFromServer();
      await sync.reconcileTabsFromServer();
    }
    assert.deepEqual(pulls, []);
    assert.equal(getLink("closed")?.history_order, "17");
  });
  await test("full sweep refreshes closed pending periods and restores, without polling finished history", async () => {
    seed("open", { open: true });
    seed("closed-pending", { status: "pending" });
    seed("deleted-account-period", { status: "pending" });
    seed("accepted", { status: "accepted" });
    seed("rejected", { status: "disputed" });
    seed("cancelled", { status: "pending", voided: true });
    seed("void-row", { status: "pending", kind: "void" });
    seed("restore", { rev: 0 });
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls.sort(), ["closed-pending", "deleted-account-period", "open", "restore"]);
    assert.equal(pendingQueries, 1);
  });
  await test("a screen watching closed history keeps its 5-second backstop until it leaves", async () => {
    seed("closed", { status: "accepted" });
    await sync.syncAllTabs({ discover: false });
    const stop = sync.watchTab("closed");
    now += 5_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, ["closed"]);
    assert.equal(pendingQueries, 1, "short ticks do not scan all historical pending rows");
    stop();
    pulls.length = 0;
    now += 5_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, []);
  });
  await test("a live poke keeps a closed period hot, then expires without endless historical polls", async () => {
    seed("closed", { status: "accepted" });
    await sync.syncAllTabs({ discover: false });
    sync.requestTabSync("closed");
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(pulls, ["closed"], "poke pulls immediately through the real debounce");
    pulls.length = 0;
    now += 5_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, ["closed"]);
    pulls.length = 0;
    now += 120_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, [], "completed closed periods go cold after the poke window");
  });
  await test("closed pending periods poll once per full sweep and stop when their last decision is final", async () => {
    seed("closed", { status: "pending" });
    await sync.syncAllTabs({ discover: false });
    pulls.length = 0;
    now += 5_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, [], "a hidden pending period does not consume the fast cadence");
    now += 55_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, ["closed"]);
    fixture.prepare("UPDATE tab_entries SET status='accepted' WHERE tab_id='closed'").run();
    pulls.length = 0;
    now += 60_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, []);
  });
  await test("an explicit queued review on closed history flushes on the next short tick", async () => {
    seed("closed", { status: "accepted" });
    await sync.syncAllTabs({ discover: false });
    await queue({
      id: "review",
      tab_id: "closed",
      op: "accept",
      payload: JSON.stringify({ entry_id: "entry:closed", expected_rev: 5 }),
      created_at: 1,
      attempts: 0,
      next_at: 0,
      last_error: null,
    });
    now += 5_000;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(reviews, ["closed:entry:closed"]);
    assert.deepEqual(pulls, ["closed"]);
    assert.equal(queued().length, 0);
  });
  await test("offline and signed-out sweeps do not touch pending-history reads", async () => {
    seed("closed", { status: "pending" });
    online = false;
    await sync.syncAllTabs({ discover: false });
    online = true;
    signedIn = false;
    await sync.syncAllTabs({ discover: false });
    assert.deepEqual(pulls, []);
    assert.equal(pendingQueries, 0);
  });
  const append = (nextAt = 0): TabOutboxRow => ({
    id: "append",
    tab_id: "closed",
    op: "append",
    payload: JSON.stringify({ id: "append", amount: "1", direction: "a_to_b", occurred_at_ms: 1 }),
    created_at: 1,
    attempts: 0,
    next_at: nextAt,
    last_error: null,
  });
  const close = (): TabOutboxRow => ({
    id: "close",
    tab_id: "closed",
    op: "close",
    payload: "{}",
    created_at: 2,
    attempts: 0,
    next_at: 0,
    last_error: null,
  });
  await test("unlink reaches the server before an older append's one-hour backoff", async () => {
    seed("closed", { status: "pending" });
    remoteClosed.set("closed", null);
    await queue(append(now + 3_600_000));
    await queue(close());
    assert.deepEqual(await tabsDb.listDueTabOps("closed"), [], "the normal FIFO really is blocked");
    const result = await sync.syncTab("closed");
    assert.equal(result.flushed, 1);
    assert.deepEqual(apiCalls, ["close"]);
    assert.equal(
      remoteClosed.get("closed"),
      now,
      "incoming activity is stopped now, not in an hour",
    );
    assert.deepEqual(
      queued().map((op) => op.id),
      ["append"],
      "the unsent tally is retained",
    );
    assert.equal(getLink("closed")?.closed_at, now, "the acknowledged close is cached");
  });
  await test("priority close preserves financial order and retains refused appends as Not sent", async () => {
    seed("closed", { status: "pending" });
    remoteClosed.set("closed", null);
    await queue(append());
    await queue({
      id: "review",
      tab_id: "closed",
      op: "accept",
      payload: JSON.stringify({ entry_id: "existing" }),
      created_at: 2,
      attempts: 0,
      next_at: 0,
      last_error: null,
    });
    await queue(close());
    const result = await sync.syncTab("closed");
    assert.deepEqual(apiCalls, ["close", "append", "accept"]);
    assert.equal(result.flushed, 2, "close and a finite existing review are acknowledged");
    assert.equal(result.failed, 1);
    assert.deepEqual(queued(), []);
    assert.deepEqual(
      fixture.prepare("SELECT id,op,reason FROM tab_failed_ops").all(),
      [{ id: "append", op: "append", reason: "tab_closed" }],
      "the server-refused new tally is preserved without counting as sent",
    );
    assert.deepEqual(sync.takeAppendOutcome("append"), { hint: null, rejected: "tab_closed" });
    assert.equal(cursors.at(-1), 0, "a refused optimistic tally forces a full truth pull");
  });
  await test("retrying unlink obeys its own backoff and sends no new append before success", async () => {
    seed("closed", { status: "pending" });
    remoteClosed.set("closed", null);
    await queue(append());
    await queue(close());
    closeOutcome = "retry";
    const failed = await sync.syncTab("closed");
    assert.deepEqual(apiCalls, ["close"]);
    assert.equal(failed.flushed, 0);
    assert.equal(failed.failed, 1);
    assert.match(failed.error ?? "", /close: 503/);
    assert.equal(
      getLink("closed")?.closed_at,
      null,
      "a failure does not pretend the server closed sharing",
    );
    assert.equal(queued().find((op) => op.id === "close")?.attempts, 1);
    assert.equal(queued().find((op) => op.id === "append")?.attempts, 0);
    apiCalls.length = 0;
    now += 5_000;
    await sync.syncTab("closed");
    assert.deepEqual(apiCalls, [], "neither close nor append ignores the close retry delay");
    assert.equal(queued().length, 2);
    closeOutcome = "success";
    now += 25_000;
    await sync.syncTab("closed");
    assert.deepEqual(
      apiCalls,
      ["close", "append"],
      "only the successful close unlocks the ordered drain",
    );
    assert.equal(queued().length, 0);
    const refused = fixture.prepare("SELECT reason FROM tab_failed_ops WHERE id='append'").get() as
      | { reason: string }
      | undefined;
    assert.equal(refused?.reason, "tab_closed");
  });
  await test("a permanently refused unlink keeps its receipt and other intents, then restores server truth", async () => {
    seed("closed", { status: "pending" });
    remoteClosed.set("closed", null);
    await queue(append());
    await queue(close());
    closeOutcome = "refuse";
    const result = await sync.syncTab("closed");
    assert.deepEqual(apiCalls, ["close"], "no new writes in the pass where unlink was refused");
    assert.equal(result.flushed, 0);
    assert.match(result.error ?? "", /close: 403 role_insufficient/);
    assert.deepEqual(
      queued().map((op) => op.id),
      ["append"],
    );
    assert.deepEqual(fixture.prepare("SELECT id,op,reason FROM tab_failed_ops").all(), [
      { id: "close", op: "close", reason: "role_insufficient" },
    ]);
    assert.equal(cursors.at(-1), 0);
    assert.equal(getLink("closed")?.closed_at, null);
  });
  console.log(`\n${passed} closed-period sync regressions passed.`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Date.now = realNow;
    fixture.close();
  });
