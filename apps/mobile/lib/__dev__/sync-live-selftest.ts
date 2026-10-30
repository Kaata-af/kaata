// Real live channel and sync scheduler on a fake clock, socket, network and
// sync leg. Pins what keeps member sync fast on mobile data: a silently dead
// socket is redialed, every (re)connect catches up, a poke that lands during a
// running cycle queues one more, the network coming back syncs at once, and
// pull-to-refresh waits for a cycle that started after it asked.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as syncErrors from "../sync/errors";

// ---- fake clock -------------------------------------------------------------
let now = 1_000_000;
let nextTimer = 1;
type Timer = { at: number; fn: () => void; every?: number };
const timers = new Map<number, Timer>();
const realSetImmediate = setImmediate;
const g = globalThis as any;
g.__DEV__ = false;
g.setTimeout = (fn: () => void, ms = 0) => {
  const id = nextTimer++;
  timers.set(id, { at: now + Math.max(0, ms), fn });
  return id;
};
g.clearTimeout = (id: number) => void timers.delete(id);
g.setInterval = (fn: () => void, ms: number) => {
  const id = nextTimer++;
  timers.set(id, { at: now + ms, fn, every: ms });
  return id;
};
g.clearInterval = (id: number) => void timers.delete(id);
Date.now = () => now;

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((done) => realSetImmediate(done));
};
async function advance(ms: number): Promise<void> {
  const until = now + ms;
  for (;;) {
    await settle();
    let dueId = -1;
    let due: Timer | null = null;
    for (const [id, timer] of timers)
      if (timer.at <= until && (!due || timer.at < due.at)) {
        due = timer;
        dueId = id;
      }
    if (!due) break;
    now = due.at;
    if (due.every) due.at = now + due.every;
    else timers.delete(dueId);
    due.fn();
  }
  now = until;
  await settle();
}

function load<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected dependency of ${path}: ${name}`);
    return mocks[name];
  }, exports);
  return exports as T;
}

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  timers.clear();
  await run();
  console.log(`PASS ${++passed}: ${name}`);
}

// ---- live channel -------------------------------------------------------------
const sockets: FakeSocket[] = [];
class FakeSocket {
  sent: string[] = [];
  closed = false;
  onopen: null | (() => void) = null;
  onmessage: null | ((event: { data: string }) => void) = null;
  onerror: null | (() => void) = null;
  onclose: null | (() => void) = null;
  constructor(readonly url: string) {
    sockets.push(this);
  }
  send(message: string) {
    this.sent.push(message);
  }
  close() {
    this.closed = true;
  }
}
g.WebSocket = FakeSocket;
const live = load<typeof import("../sync/live")>("../sync/live", {
  "../api": { getBackendUrl: async () => "https://api.test" },
});

// ---- scheduler ----------------------------------------------------------------
const net = { connected: true };
const netListeners = new Set<(state: { isConnected: boolean }) => void>();
let pulls = 0,
  sweeps = 0,
  tabSweeps = 0,
  pullFails = false;
let pullGate: Promise<void> | null = null;
let liveOpts: any = null;
const scheduler = load<typeof import("../sync/scheduler")>("../sync/scheduler", {
  "react-native": {
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  },
  "expo-network": {
    getNetworkStateAsync: async () => ({
      isConnected: net.connected,
      isInternetReachable: net.connected,
    }),
    addNetworkStateListener: (fn: (state: { isConnected: boolean }) => void) => {
      netListeners.add(fn);
      return { remove: () => netListeners.delete(fn) };
    },
  },
  "../auth": { getSessionJWT: async () => "jwt", clearLocalSession: async () => {} },
  "../db-tx": {
    getActiveVaultIdSyncMaybe: () => "vault",
    getDb: async () => ({ getAllAsync: async () => [] }),
  },
  "./errors": syncErrors,
  "./last-error": { clearLastSyncError: async () => {}, recordLastSyncError: async () => {} },
  "./live": {
    connectLiveChannel: (opts: unknown) => {
      liveOpts = opts;
      return { start() {}, stop() {} };
    },
  },
  "./pull": {
    pullEvents: async () => {
      pulls++;
      if (pullGate) await pullGate;
      if (pullFails) throw new syncErrors.SyncTransientError(0, null, "offline");
      return { pulled: 0 };
    },
  },
  "./push": { pushEvents: async () => ({ pushed: 0, rejected: 0, duplicates: 0 }) },
  "./reconcile": {
    ensureVaultRegistered: async () => {},
    fullBackupSweep: async () => {
      sweeps++;
    },
  },
  "../ledger-events": { onLedgerApplied: () => () => {} },
  "../tabs/sync": {
    requestTabSync() {},
    syncAllTabs: async () => {
      tabSweeps++;
    },
  },
  "../credit-limits": { refreshCreditPolicies: async () => {} },
  "../credit-alerts": { refreshCreditAlerts: async () => {} },
  "../member-credit-permissions": { refreshMemberCreditPermissions: async () => {} },
  "../replication": { checkConvergence: async () => {} },
  "../trust/backfill": { ensureChainBackfillAllVaults: async () => {} },
  "../vault-api": { retryPendingVaultMaterialize: async () => {} },
  "../self-phone-scrub": { ensureSelfPhoneContactsScrubbed: async () => {} },
  "../crash-report": { queueCrashReport() {} },
});
const setNetwork = (connected: boolean) => {
  net.connected = connected;
  for (const listener of [...netListeners]) listener({ isConnected: connected });
};

async function main() {
  await test("a silent socket is redialed and every connect reports itself", async () => {
    let opens = 0;
    const channel = live.connectLiveChannel({
      getJwt: async () => "jwt",
      onPoke() {},
      onOpen: () => opens++,
    });
    channel.start();
    await settle();
    assert.equal(sockets.length, 1);
    sockets[0].onopen!();
    assert.equal(opens, 1, "a connect reports itself so the scheduler can catch up");
    for (let i = 0; i < 4; i++) {
      await advance(30_000);
      sockets[0].onmessage!({ data: '{"t":"ping"}' });
    }
    assert.equal(sockets[0].closed, false, "a socket that hears pings stays up");
    assert.ok(sockets[0].sent.includes('{"t":"pong"}'));
    // Mobile NAT dropped the connection and no close ever reached the phone.
    await advance(80_000);
    assert.equal(sockets[0].closed, true, "a silent socket is torn down");
    await advance(2_000);
    assert.equal(sockets.length, 2, "and redialed");
    sockets[1].onopen!();
    assert.equal(opens, 2, "the reconnect triggers a catch-up");
    channel.stop();
    assert.equal(sockets[1].closed, true);
    await advance(300_000);
    assert.equal(sockets.length, 2, "a stopped channel never redials");
  });

  await test("the network coming back syncs at once instead of waiting out a backoff", async () => {
    pulls = 0;
    pullFails = true;
    const stop = scheduler.startSyncScheduler({ accountId: "account" });
    try {
      await advance(0);
      // Earn a long backoff while offline: 1, 2, 4, 8, 16 s...
      await advance(1_000 + 2_000 + 4_000 + 8_000 + 16_000);
      const offlinePulls = pulls;
      assert.ok(offlinePulls >= 5, `failing cycles kept retrying (${offlinePulls})`);
      pullFails = false;
      setNetwork(false);
      await advance(0);
      setNetwork(true);
      await advance(10);
      assert.equal(pulls, offlinePulls + 1, "the return of the network runs a cycle immediately");
    } finally {
      stop();
    }
  });

  await test("a poke during a running cycle queues exactly one more", async () => {
    pulls = 0;
    pullFails = false;
    const stop = scheduler.startSyncScheduler({ accountId: "account" });
    try {
      await advance(10);
      assert.equal(pulls, 1, "mount runs a cycle");
      let release!: () => void;
      pullGate = new Promise<void>((done) => (release = done));
      await advance(5_000);
      assert.equal(pulls, 2, "the interval cycle is in flight");
      liveOpts.onPoke("vault");
      liveOpts.onPoke("vault");
      await advance(400);
      assert.equal(pulls, 2, "nothing overlaps the running cycle");
      pullGate = null;
      release();
      await advance(10);
      assert.equal(pulls, 3, "the poke ran right after, not 5 s later");
      await advance(10);
      assert.equal(pulls, 3, "and only once");
    } finally {
      pullGate = null;
      stop();
    }
  });

  await test("a reconnect catches up on the kaata, other kaatas and shared accounts", async () => {
    pulls = 0;
    const stop = scheduler.startSyncScheduler({ accountId: "account" });
    try {
      await advance(10);
      const [p, s, t] = [pulls, sweeps, tabSweeps];
      liveOpts.onOpen();
      await advance(10);
      assert.equal(pulls, p + 1);
      assert.ok(sweeps > s, "the other kaatas are swept");
      assert.equal(tabSweeps, t + 1, "shared accounts are swept");
    } finally {
      stop();
    }
  });

  await test("pull-to-refresh waits for a cycle that started after it asked", async () => {
    pulls = 0;
    const stop = scheduler.startSyncScheduler({ accountId: "account" });
    try {
      await advance(10);
      let release!: () => void;
      pullGate = new Promise<void>((done) => (release = done));
      await advance(5_000);
      assert.equal(pulls, 2, "a cycle is running when the user pulls");
      let done = false;
      void scheduler.syncActiveVaultNow(30_000).then(() => (done = true));
      pullGate = null;
      release();
      await advance(1);
      assert.equal(pulls, 3, "a fresh cycle runs for the refresh");
      assert.equal(done, true, "and the refresh resolves when it finishes");
      let late = false;
      pullGate = new Promise<void>(() => {}); // never answers
      void scheduler.syncActiveVaultNow(8_000).then(() => (late = true));
      await advance(7_000);
      assert.equal(late, false);
      await advance(1_500);
      assert.equal(late, true, "a hung cycle releases the spinner at the bound");
    } finally {
      pullGate = null;
      stop();
    }
    let afterStop = false;
    await scheduler.syncActiveVaultNow(5).then(() => (afterStop = true));
    assert.equal(afterStop, true, "with no scheduler running it resolves at once");
  });

  console.log(`sync-live selftest: ${passed} cases passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
