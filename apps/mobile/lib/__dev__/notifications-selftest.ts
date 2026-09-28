// Native adapters are synthetic. Tests the shipped notification orchestration,
// not FCM/APNs delivery or Swift execution; those need the two-phone test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { TabLink } from "../tabs/types";

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
const ENTRY = "00000000-0000-4000-8000-000000000002";
const ENTRY2 = "00000000-0000-4000-8000-000000000003";
const TAB2 = "00000000-0000-4000-8000-000000000004";
const link = { tab_id: TAB, role: "b", closed_at: null, vault_id: "vault" } as TabLink;
const closedLink = { tab_id: TAB2, role: "b", closed_at: 1, vault_id: "vault" } as TabLink;
const appStateListeners: Array<(s: string) => void> = [];
const state = {
  currentState: "active",
  addEventListener: (_: string, fn: (s: string) => void) => {
    appStateListeners.push(fn);
    return { remove() {} };
  },
};
const emitAppState = (s: string) => {
  state.currentState = s;
  for (const fn of appStateListeners) fn(s);
};
const platform = { OS: "android" };
const meta = new Map<string, string>();
const calls: string[] = [];
let links = [link];
let signedIn = true;
let expoGo = false;
let granted = false;
let canAskAgain = true;
let grantOnRequest = true;
let asks = 0;
let task: any;
let handler: any;
const appliedListeners: any[] = [];
const emitApplied = (ev: unknown) => {
  for (const fn of appliedListeners) fn(ev);
};
let currentEntry: any;
// tab_entries rows by id for the tray sweep; anything else answers currentEntry.
const rows = new Map<string, any>();
let responseListener: any;
let receivedListener: any;
let registeredTask = "";
let categories: Array<{ id: string; actions: any[] }> = [];
let registrations: any[] = [];
let scheduled: any[] = [];
let nativePending: any[] = [];
let authFailure = false;
const queued = new Set<string>();
// The OS tray, and what left it; the read marks that reached the server stub.
let presented: any[] = [];
const dismissed: string[] = [];
const inboxMarks: unknown[] = [];

stub("react-native", { AppState: state, Platform: platform });
stub("expo", { isRunningInExpoGo: () => expoGo });
stub("expo-constants", { default: { easConfig: { projectId: "project" } } });
stub("expo-task-manager", {
  defineTask: (_: string, fn: any) => {
    task = fn;
  },
});
stub("../db", {
  getAppMeta: async (key: string) => meta.get(key) ?? null,
  setAppMeta: async (key: string, value: string) => {
    meta.set(key, value);
  },
});
stub("../db-tx", {
  getInstallIdSync: () => "install",
  getAccountIdSync: () => "account",
  getDb: async () => ({
    getFirstAsync: async (_sql: string, ...args: unknown[]) =>
      rows.get(String(args[0])) ?? currentEntry,
  }),
});
stub("../use-vault-role", { readVaultRole: async () => "editor", canPerformAction: () => true });
stub("../i18n", {
  getLocale: () => "en",
  t: (key: string) => key,
  tIn: (_: string, key: string) => key,
});
stub("../tabs/db", {
  getTabLink: async (id: string) => links.find((l) => l.tab_id === id) ?? null,
  listTabLinks: async () => links,
  queueNotificationReview: async (_: TabLink, entry: string, rev: number, action: string) => {
    calls.push("queue");
    queued.add(`${entry}:${rev}:${action}`);
  },
});
stub("../tabs/api", {
  resolveTabAuth: async () => {
    if (!signedIn || authFailure) throw new Error("no session or locked keychain");
    return { jwt: "synthetic" };
  },
  registerTabNotifications: async (_: unknown, id: string, options: unknown) => {
    registrations.push({ id, options });
    return { enabled: true };
  },
  markInboxRead: async (body: unknown) => {
    inboxMarks.push(body);
  },
});
stub("../tabs/sync", {
  setTabPushRefreshHook: () => {},
  syncTab: async () => {
    calls.push("sync");
  },
  requestTabSync: (id: string) => {
    calls.push(`poke:${id}`);
  },
});
stub("../tabs/events", {
  onTabApplied: (fn: any) => {
    appliedListeners.push(fn);
    return () => {};
  },
});
stub("../tabs/link", { setTabNotifyHook: () => {} });
stub("../../modules/kaata-notification-actions", {
  notificationActions: {
    pending: async () => nativePending,
    complete: async (id: string) => {
      calls.push(`complete:${id}`);
      nativePending = nativePending.filter((p) => p.id !== id);
    },
  },
});
stub("expo-notifications", {
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async () => {},
  setNotificationCategoryAsync: async (id: string, actions: any[]) => {
    categories.push({ id, actions });
  },
  setNotificationHandler: (value: any) => {
    handler = value;
  },
  addNotificationResponseReceivedListener: (fn: any) => {
    responseListener = fn;
  },
  addNotificationReceivedListener: (fn: any) => {
    receivedListener = fn;
  },
  registerTaskAsync: async (name: string) => {
    registeredTask = name;
  },
  getLastNotificationResponseAsync: async () => null,
  getPermissionsAsync: async () => ({ granted, canAskAgain }),
  requestPermissionsAsync: async () => {
    asks++;
    granted = grantOnRequest;
    return { granted, canAskAgain };
  },
  getExpoPushTokenAsync: async () => ({ data: "synthetic-push-token" }),
  dismissNotificationAsync: async (id: string) => {
    calls.push("dismiss");
    dismissed.push(id);
  },
  getPresentedNotificationsAsync: async () => presented,
  scheduleNotificationAsync: async (n: unknown) => {
    scheduled.push(n);
  },
});

// CommonJS-transform the real file so lazy native imports also cross the
// stubbed require boundary (Node ESM otherwise bypasses require.cache).
const Module = require("node:module");
const filename = require.resolve("../tabs/notify");
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = module.paths;
compiled._compile(
  ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText,
  filename,
);
const notify = compiled.exports as typeof import("../tabs/notify");
// The real read queue (its db / api boundaries are the stubs above), the
// same module instance notify.ts subscribed to at load.
const inboxReads = require("../tabs/inbox-reads") as typeof import("../tabs/inbox-reads");
const payload = { tab_id: TAB, entry_id: ENTRY, rev: 1, kind: "entry_created", role: "b" };
const shown = (id: string, data: unknown) => ({ request: { identifier: id, content: { data } } });
const response = (action: string, data: unknown = payload) => ({
  actionIdentifier: action,
  notification: { request: { identifier: "notice", content: { data } } },
});
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
function reset() {
  meta.clear();
  calls.length = 0;
  asks = 0;
  registrations = [];
  scheduled = [];
  signedIn = true;
  authFailure = false;
  granted = false;
  canAskAgain = true;
  grantOnRequest = true;
  state.currentState = "active";
  platform.OS = "android";
  links = [link];
  queued.clear();
  nativePending = [];
  presented = [];
  dismissed.length = 0;
  inboxMarks.length = 0;
  rows.clear();
}
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  reset();
  await fn();
  console.log(`PASS ${++passed}: ${name}`);
}
async function main() {
  await settled();
  assert.equal(typeof responseListener, "function");
  assert.equal(registeredTask, "kaata-tab-notification-actions");
  for (const locale of ["en", "fa"]) {
    const category = categories.find((c) => c.id === `tab-review-${locale}`)!;
    assert.equal(category.actions.length, 2);
    for (const action of category.actions) {
      assert.equal(action.options.opensAppToForeground, false);
      assert.equal(action.options.isAuthenticationRequired, true);
    }
  }
  await test("existing linked-contact upgrade asks once and registers push", async () => {
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 1);
    assert.equal(registrations[0].options.token, "synthetic-push-token");
    assert.equal(meta.get(`tab_push_active:${TAB}`) !== "0", true);
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 1);
  });
  await test("background sweep never presents a permission prompt", async () => {
    state.currentState = "background";
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
    assert.equal(registrations[0].options.token, "");
    assert.equal(meta.has("tab_notify_asked"), false);
  });
  await test("denial is remembered; settings revocation unregisters", async () => {
    grantOnRequest = false;
    await notify.ensureTabNotificationPermission();
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 1);
    assert.equal(registrations.at(-1).options.token, "");
    assert.equal(meta.get("tab_push_error"), "permission_denied");
  });
  await test("signed-out or unlinked app never prompts", async () => {
    signedIn = false;
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
    assert.equal(registrations.length, 0);
    signedIn = true;
    links = [];
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
  });
  await test("Android background accept queues before dismiss and sync, and marks handled", async () => {
    await task({ data: response("tab-accept") });
    assert.deepEqual(calls.slice(0, 3), ["queue", "dismiss", "sync"]);
    assert.equal(queued.has(`${ENTRY}:1:accept`), true);
    await settled();
    assert.deepEqual(
      inboxMarks,
      [{ tab_id: TAB, rev: 1 }],
      "review must read exactly the notice the push announced",
    );
  });
  await test("reject and foreground listener use the same non-navigation path", async () => {
    responseListener(response("tab-reject"));
    await settled();
    assert.equal(queued.has(`${ENTRY}:1:dispute`), true);
    receivedListener(response("default").notification);
    assert.equal(calls.includes(`poke:${TAB}`), true);
  });
  await test("body taps, invalid payloads and wrong party never review", async () => {
    for (const r of [
      response("default"),
      response("tab-accept", {}),
      response("tab-accept", { ...payload, role: "a" }),
    ]) {
      await task({ data: r });
    }
    assert.equal(queued.size, 0);
    await settled();
    assert.equal(inboxMarks.length, 0, "nothing reviewed, nothing read");
  });
  await test("a handled notice leaves the tray: by entry, by rev, through a rev, mark-all", async () => {
    presented = [
      shown("n1", { tab_id: TAB, entry_id: ENTRY, rev: 1 }),
      shown("n2", { tab_id: TAB, entry_id: ENTRY2, rev: 2 }),
      shown("n3", { tab_id: TAB, rev: 3 }),
      shown("n4", { tab_id: TAB2, entry_id: ENTRY, rev: 1 }),
      shown("n5", { unrelated: true }),
    ];
    const handled = async (spec: any) => {
      dismissed.length = 0;
      await inboxReads.markInboxHandled(spec);
      await settled();
      return [...dismissed];
    };
    assert.deepEqual(await handled({ tab_id: TAB, entry_id: ENTRY }), ["n1"]);
    assert.deepEqual(await handled({ tab_id: TAB, rev: 2 }), ["n2"]);
    assert.deepEqual(await handled({ tab_id: TAB, through_rev: 2 }), ["n1", "n2"]);
    assert.deepEqual(await handled({ id: "9", tab_id: TAB, entry_id: ENTRY2 }), ["n2"], "hints");
    assert.deepEqual(
      await handled({ tab_id: TAB, entry_id: ENTRY, rev: 2 }),
      ["n2"],
      "a known rev names the notice; the entry is only a hint",
    );
    assert.deepEqual(await handled({ id: "9" }), [], "an id alone names nothing in the tray");
    assert.deepEqual(await handled({ id: "9", tab_id: TAB }), [], "nor a tab without a rev/entry");
    assert.deepEqual(
      await handled({ through: "9" }),
      ["n1", "n2", "n3", "n4"],
      "mark-all clears every tab notification and nothing else",
    );
  });
  await test("a read the server reports (the other phone) clears the tray by rev, without a mark", async () => {
    presented = [
      shown("n1", { tab_id: TAB, entry_id: ENTRY, rev: 1, kind: "entry_created" }),
      shown("n2", { tab_id: TAB, entry_id: ENTRY2, rev: "2", kind: "entry_created" }),
      shown("n3", { tab_id: TAB, rev: 3, kind: "entry_accepted" }),
    ];
    inboxReads.announceServerReads([
      { tab_id: TAB, rev: 2, read: true },
      { tab_id: TAB, rev: 1, read: false },
      { tab_id: TAB, rev: 3, read: true },
    ]);
    await settled();
    assert.deepEqual(dismissed, ["n2", "n3"], "FCM's stringified rev matches too");
    assert.equal(inboxMarks.length, 0, "nothing is sent back for a read learned from the server");
  });
  await test("the tray is swept against the truth on resume and after a pull", async () => {
    links = [link, closedLink];
    rows.set(ENTRY, { status: "accepted", voided_by_entry_id: null });
    rows.set(ENTRY2, { status: "pending", voided_by_entry_id: null });
    const sweepable = () => [
      shown("reviewed", { tab_id: TAB, entry_id: ENTRY, rev: 1, kind: "entry_created" }),
      shown("pending", { tab_id: TAB, entry_id: ENTRY2, rev: 2, kind: "entry_created" }),
      shown("outcome", { tab_id: TAB, entry_id: ENTRY, rev: 3, kind: "entry_accepted" }),
      shown("closed", { tab_id: TAB2, entry_id: ENTRY2, rev: 1, kind: "entry_created" }),
      shown("unknown", {
        tab_id: TAB,
        entry_id: ENTRY2.replace("3", "9"),
        rev: 4,
        kind: "entry_created",
      }),
    ];
    presented = sweepable();
    emitAppState("background");
    await settled();
    assert.deepEqual(dismissed, [], "backgrounding sweeps nothing");
    emitAppState("active");
    await settled();
    assert.deepEqual(
      dismissed,
      ["reviewed", "closed"],
      "a request to review a tally that is no longer pending, or on a closed tab, is moot; a pending one, an outcome and an unknown row stay",
    );
    dismissed.length = 0;
    presented = sweepable();
    rows.set(ENTRY2, { status: "pending", voided_by_entry_id: "void-row" });
    emitApplied({ tabId: TAB, relationshipId: "r", vaultId: "vault", origin: "pull", changes: [] });
    await settled();
    assert.deepEqual(
      dismissed,
      ["reviewed", "pending", "closed"],
      "a pull sweeps; a voided tally is moot too",
    );
    dismissed.length = 0;
    presented = sweepable();
    emitApplied({
      tabId: TAB,
      relationshipId: "r",
      vaultId: "vault",
      origin: "local",
      changes: [],
    });
    await settled();
    assert.deepEqual(dismissed, [], "a local write is not new truth");
  });
  await test("iOS cold-start handoff survives keychain failure, then drains", async () => {
    platform.OS = "ios";
    state.currentState = "background";
    nativePending = [{ id: "cold", action: "tab-accept", data: payload }];
    authFailure = true;
    await notify.ensureTabNotificationPermission();
    assert.equal(nativePending.length, 1);
    assert.equal(queued.size, 0);
    authFailure = false;
    await notify.ensureTabNotificationPermission();
    assert.equal(nativePending.length, 0);
    assert.equal(queued.size, 1);
    assert.equal(asks, 0);
  });
  await test("failed Android action reports failure without false success", async () => {
    signedIn = false;
    await task({ data: response("tab-accept") });
    assert.equal(queued.size, 0);
    assert.equal(scheduled[0].content.body, "tab.notify.actionFailed");
  });
  await test("OS presentation stays silent in foreground on both platforms", async () => {
    for (const os of ["android", "ios"]) {
      platform.OS = os;
      state.currentState = "active";
      const result = await handler.handleNotification(response("default").notification);
      assert.deepEqual(result, {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
      state.currentState = "background";
      assert.equal(
        (await handler.handleNotification(response("default").notification)).shouldShowBanner,
        true,
      );
      const own = response("default", { ...payload, actor_account_id: "account" }).notification;
      assert.equal((await handler.handleNotification(own)).shouldShowBanner, false);
    }
  });
  await test("pull fallback ignores foreground and own acknowledgements", async () => {
    const ev = {
      tabId: TAB,
      origin: "pull",
      changes: [{ entryId: ENTRY, rev: 1, kind: "entry_created" }],
    };
    currentEntry = {
      created_by: "a",
      status: "pending",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      author_account_id: "peer",
    };
    emitApplied(ev);
    await settled();
    assert.equal(scheduled.length, 0);
    state.currentState = "background";
    currentEntry.created_by = "b";
    emitApplied(ev);
    await settled();
    assert.equal(scheduled.length, 0, "own side");
    currentEntry.created_by = "a";
    currentEntry.author_account_id = "account";
    emitApplied(ev);
    await settled();
    assert.equal(scheduled.length, 0, "same account on opposite side");
    currentEntry.author_account_id = "peer";
    emitApplied(ev);
    await settled();
    assert.equal(scheduled.length, 1, "real incoming fallback");
  });
  await test("Expo Go skips native registration and tray dismissal", async () => {
    expoGo = true;
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
    assert.equal(registrations.length, 0);
    presented = [shown("n1", { tab_id: TAB, entry_id: ENTRY, rev: 1 })];
    await inboxReads.markInboxHandled({ tab_id: TAB, entry_id: ENTRY });
    await settled();
    assert.deepEqual(dismissed, []);
  });
  console.log(`\n${passed} notification orchestration regressions passed.`);
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
