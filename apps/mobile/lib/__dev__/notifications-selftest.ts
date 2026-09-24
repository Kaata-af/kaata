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
const link = { tab_id: TAB, role: "b", closed_at: null, vault_id: "vault" } as TabLink;
const state = { currentState: "active" };
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
let responseListener: any;
let receivedListener: any;
let registeredTask = "";
let categories: Array<{ id: string; actions: any[] }> = [];
let registrations: any[] = [];
let scheduled: any[] = [];
let nativePending: any[] = [];
let authFailure = false;
const queued = new Set<string>();

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
stub("../db-tx", { getInstallIdSync: () => "install", getAccountIdSync: () => "account" });
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
stub("../tabs/events", { onTabApplied: () => {} });
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
  setNotificationHandler: () => {},
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
  dismissNotificationAsync: async () => {
    calls.push("dismiss");
  },
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
const payload = { tab_id: TAB, entry_id: ENTRY, rev: 1, kind: "entry_created", role: "b" };
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
  await test("Android background accept queues before dismiss and sync", async () => {
    await task({ data: response("tab-accept") });
    assert.deepEqual(calls.slice(0, 3), ["queue", "dismiss", "sync"]);
    assert.equal(queued.has(`${ENTRY}:1:accept`), true);
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
  await test("Expo Go skips native registration", async () => {
    expoGo = true;
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
    assert.equal(registrations.length, 0);
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
