// Run with: npm run selftest:inbox-reads
// Pins lib/tabs/inbox-reads.ts — the offline "handled means read" queue —
// against a Map standing in for app_meta and a scripted markInboxRead. No
// database, no network, no React: the hook that consumes it is covered by
// inbox-selftest, the OS-tray dismissal by notifications-selftest.
import assert from "node:assert/strict";
import { TabApiError } from "../tabs/errors";

const saved = new Map<string, NodeJS.Module | undefined>();
function stub(name: string, exports: object) {
  const filename = require.resolve(name);
  saved.set(filename, require.cache[filename]);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: { __esModule: true, ...exports },
  } as NodeJS.Module;
}
const TAB = "00000000-0000-4000-8000-000000000001";
const TAB2 = "00000000-0000-4000-8000-000000000002";
const E1 = "00000000-0000-4000-8000-000000000011";
const E2 = "00000000-0000-4000-8000-000000000012";
const QUEUE = "inbox_read_queue";
const DAY = 24 * 3600_000;
const meta = new Map<string, string>();
const log: string[] = [];
const posted: any[] = [];
let account: string | null = "acct-a";
let metaBroken = false;
let inTransaction = false;
let post = async (_body: unknown): Promise<void> => {};
stub("../db", {
  getAppMeta: async (key: string) => {
    if (metaBroken) throw new Error("sqlite closed");
    return meta.get(key) ?? null;
  },
  setAppMeta: async (key: string, value: string) => {
    if (metaBroken) throw new Error("sqlite closed");
    log.push(inTransaction ? "queue-in-tx" : "queue");
    meta.set(key, value);
  },
});
stub("../db-tx", {
  getAccountIdSync: () => account,
  getDb: async () => ({ isInTransactionSync: () => inTransaction }),
});
stub("../tabs/api", {
  markInboxRead: (body: unknown) => {
    posted.push(body);
    return post(body);
  },
});
// The module warns (never throws) on every contained failure; keep the run
// readable and prove the containment by outcome instead.
console.warn = () => {};
const reads = require("../tabs/inbox-reads") as typeof import("../tabs/inbox-reads");
const {
  announceServerReads,
  coversWholeInbox,
  flushInboxReads,
  inboxItemMatches,
  markInboxHandled,
  markTabNoticesSeen,
  onInboxReadsApplied,
  pendingInboxReadSpecs,
  toReadBody,
} = reads;

type Row = { spec: any; account: string; at: number };
const queue = (): Row[] => JSON.parse(meta.get(QUEUE) ?? "[]");
const transport = () => new TabApiError(0, "network", "offline");
const offline = async () => {
  throw transport();
};
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}
function reset() {
  meta.clear();
  log.length = 0;
  posted.length = 0;
  account = "acct-a";
  metaBroken = false;
  inTransaction = false;
  post = async () => {};
}
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  reset();
  await fn();
  await settle();
  console.log(`PASS ${++passed}: ${name}`);
}

async function main() {
  await test("inboxItemMatches: all five specs, ids compared as BigInt", async () => {
    const item = { id: "12345678901234", tab_id: TAB, rev: 7, entry_id: E1 };
    assert.equal(inboxItemMatches(item, { id: "12345678901234" }), true);
    assert.equal(inboxItemMatches(item, { id: "12345678901235" }), false);
    assert.equal(
      inboxItemMatches(item, { id: "12345678901234", tab_id: TAB2, entry_id: E2 }),
      true,
      "an id wins over its hints",
    );
    assert.equal(inboxItemMatches(item, { through: "12345678901234" }), true);
    assert.equal(inboxItemMatches(item, { through: "12345678901299" }), true);
    assert.equal(inboxItemMatches(item, { through: "12345678901233" }), false);
    assert.equal(
      inboxItemMatches({ ...item, id: "9007199254740993" }, { through: "9007199254740992" }),
      false,
      "past 2^53 a Number comparison would say ≤; BigInt says no",
    );
    assert.equal(inboxItemMatches(item, { through: "abc" }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, entry_id: E1 }), true);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, entry_id: E2 }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB2, entry_id: E1 }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, rev: 7 }), true);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, rev: 8 }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB2, rev: 7 }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, through_rev: 7 }), true);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, through_rev: 99 }), true);
    assert.equal(inboxItemMatches(item, { tab_id: TAB, through_rev: 6 }), false);
    assert.equal(inboxItemMatches(item, { tab_id: TAB2, through_rev: 99 }), false);
    assert.equal(
      inboxItemMatches(item, { tab_id: TAB, entry_id: E1, rev: 8 }),
      false,
      "an exact rev beats the entry hint: the same tally at another rev is another notice",
    );
    assert.equal(inboxItemMatches(item, { tab_id: TAB, entry_id: E2, rev: 7 }), true);
    assert.equal(inboxItemMatches(item, {} as any), false, "no target never matches");
    assert.equal(
      coversWholeInbox({ latest_id: "12345678901234" }, { through: "12345678901234" }),
      true,
    );
    assert.equal(
      coversWholeInbox({ latest_id: "12345678901234" }, { through: "12345678901233" }),
      false,
    );
    assert.equal(coversWholeInbox({ latest_id: "5" }, { tab_id: TAB, through_rev: 99 }), false);
    assert.equal(coversWholeInbox({ latest_id: "5" }, { through: "x" }), false);
  });

  await test("toReadBody strips hints and keeps id > through > through_rev > rev > entry", async () => {
    assert.deepEqual(toReadBody({ id: "5", tab_id: TAB, rev: 2, entry_id: E1 }), { id: "5" });
    assert.deepEqual(toReadBody({ through: "5", tab_id: TAB }), { through: "5" });
    assert.deepEqual(toReadBody({ tab_id: TAB, through_rev: 3, rev: 1 }), {
      tab_id: TAB,
      through_rev: 3,
    });
    assert.deepEqual(
      toReadBody({ tab_id: TAB, entry_id: E1, rev: 4 }),
      { tab_id: TAB, rev: 4 },
      "a known rev is the exact notice; the entry form is unbounded in time",
    );
    assert.deepEqual(toReadBody({ tab_id: TAB, entry_id: E1 }), { tab_id: TAB, entry_id: E1 });
    assert.deepEqual(toReadBody({ tab_id: TAB, rev: 4 }), { tab_id: TAB, rev: 4 });
    assert.throws(() => toReadBody({} as any), TypeError);
  });

  await test("a mark announces, then queues {spec, account, at}, then posts the canonical body", async () => {
    const off = onInboxReadsApplied((specs, source) =>
      log.push("emit:" + source + ":" + JSON.stringify(specs)),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    post = async (body) => {
      log.push("post:" + JSON.stringify(body));
      await gate;
    };
    const before = Date.now();
    await markInboxHandled({ id: "12345678901234", tab_id: TAB, rev: 3 });
    await settle();
    assert.deepEqual(log, [
      `emit:handled:[{"id":"12345678901234","tab_id":"${TAB}","rev":3}]`,
      "queue",
      'post:{"id":"12345678901234"}',
    ]);
    const [row, ...rest] = queue();
    assert.equal(rest.length, 0);
    assert.deepEqual(row.spec, { id: "12345678901234", tab_id: TAB, rev: 3 });
    assert.equal(row.account, "acct-a");
    assert.ok(row.at >= before && row.at <= Date.now());
    release();
    await settle();
    assert.deepEqual(queue(), [], "sent entries leave the queue");
    off();
  });

  await test("signed out: announced, never queued, never sent", async () => {
    account = null;
    const seen: unknown[] = [];
    const off = onInboxReadsApplied((specs) => seen.push(...specs));
    await markInboxHandled({ tab_id: TAB, entry_id: E1 });
    await settle();
    assert.deepEqual(seen, [{ tab_id: TAB, entry_id: E1 }]);
    assert.equal(meta.has(QUEUE), false);
    assert.equal(posted.length, 0);
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 0 });
    off();
  });

  await test("dedupe by account + canonical body, 30-day drop, cap at the 200 newest", async () => {
    post = offline;
    await markInboxHandled({ tab_id: TAB, rev: 9 });
    await markInboxHandled({ tab_id: TAB, rev: 9, entry_id: E1 });
    await settle();
    assert.equal(queue().length, 1, "same canonical body {tab_id, rev}: one entry");
    assert.deepEqual(queue()[0].spec, { tab_id: TAB, rev: 9, entry_id: E1 }, "newest spec kept");
    const now = Date.now();
    meta.set(
      QUEUE,
      JSON.stringify([
        { spec: { tab_id: TAB, rev: 1 }, account: "acct-a", at: now - 31 * DAY },
        { spec: { tab_id: TAB, rev: 2 }, account: "acct-a", at: now - 29 * DAY },
        { garbage: true },
        { spec: {}, account: "acct-a", at: now },
      ]),
    );
    await markInboxHandled({ tab_id: TAB, rev: 3 });
    await settle();
    assert.deepEqual(
      queue().map((e) => e.spec),
      [
        { tab_id: TAB, rev: 2 },
        { tab_id: TAB, rev: 3 },
      ],
      "expired, malformed and target-less rows are dropped",
    );
    meta.set(
      QUEUE,
      JSON.stringify(
        Array.from({ length: 205 }, (_, i) => ({
          spec: { tab_id: TAB, rev: i + 1 },
          account: "acct-a",
          at: now - 205 + i,
        })),
      ),
    );
    await markInboxHandled({ tab_id: TAB, rev: 500 });
    await settle();
    const capped = queue();
    assert.equal(capped.length, 200);
    assert.equal(capped[0].spec.rev, 7, "the six oldest went first");
    assert.equal(capped.at(-1)!.spec.rev, 500);
  });

  await test("flush sends oldest first and empties the queue", async () => {
    post = offline;
    await markInboxHandled({ tab_id: TAB, rev: 1 });
    await markInboxHandled({ tab_id: TAB, rev: 2 });
    await markInboxHandled({ tab_id: TAB2, entry_id: E2 });
    await settle();
    assert.equal(queue().length, 3);
    assert.deepEqual(await pendingInboxReadSpecs("acct-a"), [
      { tab_id: TAB, rev: 1 },
      { tab_id: TAB, rev: 2 },
      { tab_id: TAB2, entry_id: E2 },
    ]);
    posted.length = 0;
    post = async () => {};
    assert.deepEqual(await flushInboxReads(), { sent: 3, remaining: 0 });
    assert.deepEqual(posted, [
      { tab_id: TAB, rev: 1 },
      { tab_id: TAB, rev: 2 },
      { tab_id: TAB2, entry_id: E2 },
    ]);
    assert.deepEqual(queue(), []);
    assert.deepEqual(await pendingInboxReadSpecs("acct-a"), []);
  });

  await test("a transport failure (or 401/408/429/5xx) keeps that entry and everything after it", async () => {
    post = offline;
    for (const rev of [1, 2, 3]) await markInboxHandled({ tab_id: TAB, rev });
    await settle();
    posted.length = 0;
    let n = 0;
    post = async () => {
      if (++n === 2) throw transport();
    };
    assert.deepEqual(await flushInboxReads(), { sent: 1, remaining: 2 });
    assert.deepEqual(
      queue().map((e) => e.spec.rev),
      [2, 3],
    );
    assert.deepEqual(
      posted.map((b) => b.rev),
      [1, 2],
      "stopped at the failure; rev 3 never tried ahead of it",
    );
    for (const status of [401, 408, 429, 500, 503]) {
      posted.length = 0;
      post = async () => {
        throw new TabApiError(status, "http_" + status, "later");
      };
      assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 2 }, String(status));
      assert.equal(posted.length, 1, `${status} stops after the first attempt`);
    }
    post = async () => {
      throw new TypeError("not even an api error");
    };
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 2 });
    assert.deepEqual(
      queue().map((e) => e.spec.rev),
      [2, 3],
    );
  });

  await test("a verdict (400 / 403 / 404) drops only that entry", async () => {
    post = offline;
    for (const rev of [1, 2, 3, 4]) await markInboxHandled({ tab_id: TAB, rev });
    await settle();
    posted.length = 0;
    const verdicts = new Map([
      [1, 400],
      [3, 404],
    ]);
    post = async (body: any) => {
      const status = verdicts.get(body.rev);
      if (status) throw new TabApiError(status, "bad", "no");
    };
    assert.deepEqual(await flushInboxReads(), { sent: 2, remaining: 0 });
    assert.deepEqual(
      posted.map((b) => b.rev),
      [1, 2, 3, 4],
    );
    assert.deepEqual(queue(), []);
    post = offline;
    await markInboxHandled({ tab_id: TAB, rev: 5 });
    await settle();
    post = async () => {
      throw new TabApiError(403, "forbidden", "not yours");
    };
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 0 });
    assert.deepEqual(queue(), []);
  });

  await test("accounts are isolated: another account's entries wait for it", async () => {
    post = offline;
    await markInboxHandled({ tab_id: TAB, rev: 1 });
    await markInboxHandled({ tab_id: TAB, rev: 2 });
    await settle();
    account = "acct-b";
    await markInboxHandled({ tab_id: TAB2, rev: 1 });
    await settle();
    assert.equal(queue().length, 3);
    assert.deepEqual(await pendingInboxReadSpecs("acct-b"), [{ tab_id: TAB2, rev: 1 }]);
    posted.length = 0;
    post = async () => {};
    assert.deepEqual(await flushInboxReads(), { sent: 1, remaining: 0 });
    assert.deepEqual(posted, [{ tab_id: TAB2, rev: 1 }]);
    assert.deepEqual(
      queue().map((e) => e.account),
      ["acct-a", "acct-a"],
    );
    account = null;
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 0 });
    assert.equal(queue().length, 2, "signed out sends nothing and drops nothing");
    account = "acct-a";
    assert.deepEqual(await flushInboxReads(), { sent: 2, remaining: 0 });
    assert.deepEqual(queue(), []);
  });

  await test("never two passes at once; a call during a pass gets one follow-up pass", async () => {
    post = offline;
    for (const rev of [1, 2, 3]) await markInboxHandled({ tab_id: TAB, rev });
    await settle();
    posted.length = 0;
    let inFlight = 0;
    let peak = 0;
    post = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise<void>((r) => setImmediate(r));
      inFlight--;
    };
    const [first, second, third] = await Promise.all([
      flushInboxReads(),
      flushInboxReads(),
      flushInboxReads(),
    ]);
    assert.deepEqual(first, { sent: 3, remaining: 0 });
    assert.deepEqual(second, { sent: 0, remaining: 0 }, "the follow-up pass found nothing left");
    assert.deepEqual(third, second, "…and was shared, not tripled");
    assert.equal(peak, 1);
    assert.equal(posted.length, 3, "nothing was replayed");
  });

  await test("a mark queued mid-pass is sent by the follow-up pass", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    post = offline;
    await markInboxHandled({ tab_id: TAB, rev: 1 });
    await settle();
    posted.length = 0;
    post = async (body: any) => {
      if (body.rev === 1) await gate;
    };
    const pass = flushInboxReads();
    await settle();
    await markInboxHandled({ tab_id: TAB, rev: 2 });
    release();
    await pass;
    await settle();
    assert.deepEqual(
      posted.map((b) => b.rev),
      [1, 2],
    );
    assert.deepEqual(queue(), []);
  });

  await test("never throws: broken app_meta, a throwing listener or sender, a target-less spec", async () => {
    metaBroken = true;
    const seen: unknown[] = [];
    const off = onInboxReadsApplied((specs) => {
      seen.push(...specs);
      throw new Error("listener bug");
    });
    await markInboxHandled({ tab_id: TAB, entry_id: E1 });
    assert.equal(seen.length, 1, "a throwing listener does not stop the mark");
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 0 });
    off();
    metaBroken = false;
    await markInboxHandled({} as any);
    await settle();
    assert.equal(meta.has(QUEUE), false, "a spec with no target is ignored");
    post = (() => {
      throw new Error("sync throw");
    }) as any;
    await markInboxHandled({ tab_id: TAB, rev: 1 });
    await settle();
    assert.equal(queue().length, 1, "kept for a later flush");
  });

  await test("markTabNoticesSeen marks through the rev only when focused, active and rev > 0", async () => {
    post = offline;
    const link = { tab_id: TAB, rev: 5 };
    assert.equal(markTabNoticesSeen(link, { focused: false, appState: "active" }), false);
    assert.equal(markTabNoticesSeen(link, { focused: true, appState: "background" }), false);
    assert.equal(markTabNoticesSeen(link, { focused: true, appState: "inactive" }), false);
    assert.equal(
      markTabNoticesSeen({ ...link, rev: 0 }, { focused: true, appState: "active" }),
      false,
    );
    await settle();
    assert.equal(meta.has(QUEUE), false, "a pull behind the lock screen marks nothing");
    assert.equal(markTabNoticesSeen(link, { focused: true, appState: "active" }), true);
    await settle();
    assert.deepEqual(
      queue().map((e) => e.spec),
      [{ tab_id: TAB, through_rev: 5 }],
    );
  });

  await test("a through_rev the server acknowledged is not re-sent, nor any rev under it; it is still announced", async () => {
    const seen: unknown[] = [];
    const off = onInboxReadsApplied((specs) => seen.push(...specs));
    await markInboxHandled({ tab_id: TAB, through_rev: 5 });
    await settle();
    assert.equal(posted.length, 1);
    for (const spec of [
      { tab_id: TAB, through_rev: 5 },
      { tab_id: TAB, through_rev: 4 },
      { tab_id: TAB, rev: 5, entry_id: E1 },
    ])
      await markInboxHandled(spec);
    await settle();
    assert.equal(
      posted.length,
      1,
      "nothing at or under an acknowledged through_rev goes out again",
    );
    assert.equal(seen.length, 4, "…but every one was announced (tray + page)");
    assert.equal(meta.has(QUEUE) ? queue().length : 0, 0);
    await markInboxHandled({ tab_id: TAB, through_rev: 6 });
    await markInboxHandled({ tab_id: TAB, entry_id: E1 });
    await markInboxHandled({ tab_id: TAB2, through_rev: 1 });
    await settle();
    assert.deepEqual(
      posted.slice(1),
      [
        { tab_id: TAB, through_rev: 6 },
        { tab_id: TAB, entry_id: E1 },
        { tab_id: TAB2, through_rev: 1 },
      ],
      "a higher rev, the unbounded entry form and another tab still go out",
    );
    account = "acct-b";
    await markInboxHandled({ tab_id: TAB, through_rev: 3 });
    await settle();
    assert.deepEqual(posted.at(-1), { tab_id: TAB, through_rev: 3 }, "per account");
    off();
  });

  await test("400 invalid_body for a tab-form body is version skew: kept and retried, never dropped", async () => {
    post = offline;
    // rev 50: above anything the previous case had the server acknowledge.
    await markInboxHandled({ tab_id: TAB, rev: 50 });
    await markInboxHandled({ id: "7" });
    await settle();
    posted.length = 0;
    post = async () => {
      throw new TabApiError(400, "invalid_body", "provide exactly one of: id, through");
    };
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 2 });
    assert.equal(posted.length, 1, "stops at the skewed entry; the order behind it holds");
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 2 }, "still there next pass");
    // The backend deploy lands: everything drains in order.
    post = async () => {};
    assert.deepEqual(await flushInboxReads(), { sent: 2, remaining: 0 });
    assert.deepEqual(posted.slice(2), [{ tab_id: TAB, rev: 50 }, { id: "7" }]);
    // The same 400 for an id/through body IS a verdict.
    post = offline;
    await markInboxHandled({ id: "8" });
    await settle();
    post = async () => {
      throw new TabApiError(400, "invalid_body", "no");
    };
    assert.deepEqual(await flushInboxReads(), { sent: 0, remaining: 0 });
  });

  await test("server reads are announced as exact (tab, rev) notices and never queued or sent", async () => {
    const seen: Array<[unknown, string]> = [];
    const off = onInboxReadsApplied((specs, source) => seen.push([specs, source]));
    announceServerReads([
      { tab_id: TAB, rev: 3, read: true },
      { tab_id: TAB, rev: 4, read: false },
      { tab_id: TAB2, rev: 0, read: true },
      { tab_id: TAB2, rev: 9, read: true },
    ]);
    announceServerReads([{ tab_id: TAB, rev: 1, read: false }]);
    await settle();
    assert.deepEqual(seen, [
      [
        [
          { tab_id: TAB, rev: 3 },
          { tab_id: TAB2, rev: 9 },
        ],
        "server",
      ],
    ]);
    assert.equal(meta.has(QUEUE), false);
    assert.equal(posted.length, 0);
    off();
  });

  await test("a pending read announced a moment ago is already visible to a reader in the same tick", async () => {
    post = offline;
    const seen: Promise<unknown[]>[] = [];
    // The hook's listener runs inside the announcement, before the append is
    // awaited; a read that started right then must still see the entry.
    const off = onInboxReadsApplied(() => seen.push(pendingInboxReadSpecs("acct-a")));
    await markInboxHandled({ tab_id: TAB, rev: 52 });
    assert.deepEqual(await seen[0], [{ tab_id: TAB, rev: 52 }]);
    off();
  });

  await test("the queue write waits for an open SQLite transaction to end", async () => {
    post = offline;
    inTransaction = true;
    setTimeout(() => {
      inTransaction = false;
    }, 60);
    await markInboxHandled({ tab_id: TAB, rev: 53 });
    await settle();
    assert.deepEqual(log, ["queue"], "written after the transaction closed, never inside it");
    assert.equal(queue().length, 1);
  });

  console.log(`\n${passed} inbox read-queue regressions passed.`);
}
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const [key, value] of saved) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
  });
