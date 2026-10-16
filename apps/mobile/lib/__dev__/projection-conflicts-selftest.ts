// Real query hook + root listener against SQLite. Synthetic records only;
// deferred reads reproduce cold-launch and identity changes without native IO.
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileUI, deferred, settleUI, uiHooks } from "./ui-fixture";
import type { ProjectionConflictRow } from "../projection-conflicts";

function fixture(limit = 25) {
  const store = new Database(":memory:");
  store.exec(`
    CREATE TABLE projection_conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,
      vault_id TEXT,detail_json TEXT,created_at INTEGER,resolved_at INTEGER);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,event_type TEXT);
  `);
  const hooks = uiHooks();
  let vault = "a",
    account: string | null = "alice",
    appState = "active";
  const identityListeners = new Set<() => void>();
  const appListeners = new Set<(state: string) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0,
    reads = 0;
  let baselineGate: ReturnType<typeof deferred<void>> | null = null;
  let rowsGate: ReturnType<typeof deferred<void>> | null = null;
  let failCount = false;
  const notices: [string, string][] = [];
  const toast = { push: (message: string, tone: string) => notices.push([message, tone]) };
  const mod = compileUI(
    "../projection-conflicts",
    {
      react: hooks.react,
      "react-native": {
        AppState: {
          get currentState() {
            return appState;
          },
          addEventListener: (_: string, fn: (state: string) => void) => {
            appListeners.add(fn);
            return { remove: () => appListeners.delete(fn) };
          },
        },
      },
      "./db-tx": {
        getDb: async () => ({
          getFirstAsync: async (sql: string, ...args: unknown[]) => {
            reads++;
            if (sql.includes("COUNT(*)") && failCount) throw new Error("synthetic read failure");
            const row = store.prepare(sql).get(...args) ?? null;
            if (sql.includes("MAX(id)") && baselineGate) {
              const pending = baselineGate;
              baselineGate = null;
              await pending.promise;
            }
            return row;
          },
          getAllAsync: async (sql: string, ...args: unknown[]) => {
            reads++;
            const rows = store.prepare(sql).all(...args);
            if (rowsGate) {
              const pending = rowsGate;
              rowsGate = null;
              await pending.promise;
            }
            return rows;
          },
        }),
        getActiveVaultIdSyncMaybe: () => vault,
        getSessionAccountIdSync: () => account,
        onAccountIdentityChanged: (fn: () => void) => {
          identityListeners.add(fn);
          return () => identityListeners.delete(fn);
        },
      },
    },
    {
      setTimeout: (fn: () => void) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  let data: {
    rows: ProjectionConflictRow[];
    baselineId: number | null;
    scopeKey: string;
    refresh: () => Promise<void>;
  };
  const Listener = compileUI("../../components/ProjectionConflictsListener", {
    react: hooks.react,
    "./Toast": { useToast: () => toast },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/projection-conflicts": {
      useProjectionConflicts: () => (data = mod.useProjectionConflicts({ limit })),
    },
  }).ProjectionConflictsListener;
  const render = () =>
    hooks.render(() => {
      Listener();
      return { type: "Fixture", props: {} };
    });
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      render();
    }
  };
  const add = (
    options: {
      vault?: string;
      type?: string;
      kind?: string;
      legacy?: boolean;
      unknown?: boolean;
    } = {},
  ) => {
    const scope = options.vault ?? vault;
    const count = store.prepare("SELECT COUNT(*) AS n FROM projection_conflicts").get() as {
      n: number;
    };
    const event = `event-${count.n}`;
    if (!options.unknown)
      store
        .prepare("INSERT INTO event_log VALUES (?,?,?)")
        .run(event, scope, options.type ?? "entry_amended");
    const detail = {
      event_id: event,
      reason: "membership_unverified",
      ...(!options.legacy && options.type ? { event_type: options.type } : {}),
    };
    return Number(
      store
        .prepare(
          "INSERT INTO projection_conflicts(kind,vault_id,detail_json,created_at) VALUES(?,?,?,?)",
        )
        .run(options.kind ?? "event_rejected_by_server", scope, JSON.stringify(detail), Date.now())
        .lastInsertRowid,
    );
  };
  return {
    store,
    hooks,
    notices,
    render,
    flush,
    add,
    notify: () => mod.notifyProjectionConflictsChanged(),
    get data() {
      return data!;
    },
    get reads() {
      return reads;
    },
    delayBaseline: () => (baselineGate = deferred<void>()),
    delayRows: () => (rowsGate = deferred<void>()),
    failCount: (value: boolean) => {
      failCount = value;
    },
    switchVault: (value: string) => {
      vault = value;
    },
    switchAccount: (value: string | null) => {
      account = value;
      identityListeners.forEach((fn) => fn());
    },
    app: (value: string) => {
      appState = value;
      appListeners.forEach((fn) => fn(value));
    },
    poll: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
    },
    close: () => {
      hooks.unmount();
      assert.equal(appListeners.size, 0);
      assert.equal(identityListeners.size, 0);
      assert.equal(timers.size, 0);
      store.close();
    },
  };
}

async function run() {
  for (let boot = 0; boot < 2; boot++) {
    const f = fixture(3);
    for (let i = 0; i < 30; i++)
      f.add({ legacy: true, type: i % 2 ? "vault_member_role_changed" : "person_renamed" });
    f.render();
    assert.equal(f.data.baselineId, null, "initial empty React render is not a loaded baseline");
    await f.flush();
    assert.equal(f.data.baselineId, 30);
    assert.equal(f.notices.length, 0, "a cold launch never replays old warnings");
    f.store.prepare("UPDATE projection_conflicts SET resolved_at=1 WHERE id>20").run();
    f.notify();
    await f.flush();
    assert.equal(
      f.notices.length,
      0,
      "older backlog outside the row limit remains old when revealed",
    );
    const internal = f.add({ legacy: true, type: "vault_member_role_changed" });
    f.notify();
    await f.flush();
    assert.equal(
      f.data.rows.find((row) => row.id === internal)?.detail.event_type,
      "vault_member_role_changed",
    );
    assert.equal(
      f.notices.length,
      0,
      "legacy server membership conflicts recover type from event_log",
    );
    f.add({ type: "person_renamed" });
    f.notify();
    await f.flush();
    assert.deepEqual(f.notices, [["projectionConflicts.toast.serverRejected", "error"]]);
    f.notify();
    await f.flush();
    assert.equal(f.notices.length, 1, "the same rejection is surfaced once");
    f.add({ unknown: true });
    f.notify();
    await f.flush();
    assert.equal(f.notices.length, 2, "a fresh unknown conflict is still actionable");
    f.add({ type: "entry_amended", kind: "event_rejected_by_local_role_gate" });
    f.notify();
    await f.flush();
    assert.equal(f.notices.at(-1)?.[0], "projectionConflicts.toast.roleGate");
    f.close();
  }
  console.log(
    "PASS conflicts: cold-launch backlog, row-limit boundary, legacy membership metadata and fresh user/unknown/local warnings",
  );

  const loading = fixture();
  loading.add({ type: "person_renamed" });
  const baseline = loading.delayBaseline();
  loading.render();
  await settleUI();
  const fresh = loading.add({ unknown: true });
  loading.notify();
  await settleUI();
  baseline.resolve();
  await loading.flush();
  assert.equal(loading.data.baselineId, 1);
  assert.ok(loading.data.rows.some((row) => row.id === fresh));
  assert.equal(
    loading.notices.length,
    1,
    "a fresh rejection during initial load is not swallowed by a second refresh",
  );
  loading.failCount(true);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await loading.data.refresh();
  } finally {
    console.warn = warn;
  }
  loading.failCount(false);
  loading.add({ unknown: true });
  await loading.data.refresh();
  await loading.flush();
  assert.equal(
    loading.notices.length,
    2,
    "a transient read failure does not reset an established boundary",
  );
  loading.close();
  console.log(
    "PASS conflicts: simultaneous initial notifications and retry preserve the first database boundary",
  );

  const scoped = fixture();
  scoped.add({ type: "person_renamed" });
  scoped.add({ vault: "b", type: "entry_amended" });
  const oldRows = scoped.delayRows();
  scoped.render();
  await settleUI();
  const oldRefresh = scoped.data.refresh;
  scoped.switchVault("b");
  scoped.notify();
  scoped.render();
  assert.equal(
    scoped.data.rows.length,
    0,
    "switching kaata hides the previous snapshot immediately",
  );
  await scoped.flush();
  oldRows.resolve();
  await scoped.flush();
  assert.ok(scoped.data.rows.every((row) => row.vault_id === "b"));
  assert.equal(scoped.notices.length, 0);
  const readsBeforeStaleRefresh = scoped.reads;
  await oldRefresh();
  assert.equal(
    scoped.reads,
    readsBeforeStaleRefresh,
    "a saved old-scope refresh cannot cancel a current request",
  );
  const accountRows = scoped.delayRows();
  const oldAccountRefresh = scoped.data.refresh();
  await settleUI();
  scoped.switchAccount("bob");
  scoped.switchAccount("alice");
  scoped.render();
  assert.equal(scoped.data.baselineId, null);
  await scoped.flush();
  accountRows.resolve();
  await oldAccountRefresh;
  await scoped.flush();
  assert.equal(
    scoped.notices.length,
    0,
    "A -> B -> A cannot publish an old in-flight account snapshot",
  );
  scoped.add({ unknown: true });
  scoped.app("background");
  scoped.notify();
  await scoped.flush();
  assert.equal(scoped.notices.length, 0);
  scoped.app("active");
  await scoped.flush();
  assert.equal(
    scoped.notices.length,
    1,
    "a genuine warning received while away is surfaced on resume",
  );
  scoped.switchVault("a");
  scoped.poll();
  await scoped.flush();
  assert.ok(
    scoped.data.rows.every((row) => row.vault_id === "a"),
    "polling discovers a kaata switch without a notification",
  );
  const unmountRows = scoped.delayRows();
  const unfinished = scoped.data.refresh();
  await settleUI();
  const stale = scoped.data.refresh;
  scoped.hooks.unmount();
  unmountRows.resolve();
  await unfinished;
  await stale();
  assert.equal(
    scoped.hooks.lateWrites,
    0,
    "unmounted reads and stale refresh callbacks do not update state",
  );
  scoped.store.close();
  console.log(
    "PASS conflicts: vault/account changes, stale requests, background resume, polling and unmount are isolated",
  );
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
