// Native adapters are synthetic. Tests the shipped notification orchestration,
// not FCM/APNs delivery or Swift execution; those need the two-phone test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { TabLink } from "../tabs/types";
import { defaultNotificationPolicy, type NotificationPolicy } from "../notification-policy";

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
let accountId = "account";
let bindingVersion = 1;
let authWait: (() => Promise<void>) | null = null;
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
let deliveryPolicy: NotificationPolicy = { ...defaultNotificationPolicy(), previews: "full" };
let preferenceVersion = 0;
let preferencesSupported = true;
let onTabPolicyRead: (() => Promise<void>) | null = null;
const preferenceListeners = new Set<() => void>();
let onEntryRead: (() => void) | null = null;
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
let locale = "en";
const localeListeners = new Set<() => void>();
const changeLocale = (value: string) => {
  locale = value;
  for (const listener of localeListeners) listener();
};
let registrationResult: () => Promise<{ enabled: boolean }> = async () => ({ enabled: true });
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
  getAccountIdSync: () => accountId,
  getSessionAccountIdSync: () => (signedIn ? accountId : null),
  getDb: async () => ({
    getFirstAsync: async (sql: string, ...args: unknown[]) => {
      const row = rows.get(String(args[0])) ?? currentEntry;
      if (sql.includes("SELECT * FROM tab_entries")) {
        const hook = onEntryRead;
        onEntryRead = null;
        hook?.();
      }
      return row;
    },
  }),
});
stub("../auth", {
  captureCurrentSession: async () => ({
    accountId,
    bindingVersion,
    jwt: signedIn ? "synthetic" : null,
  }),
  applyForCurrentSession: async (
    snapshot: { accountId: string; bindingVersion: number; jwt: string | null },
    run: () => Promise<unknown>,
  ) => {
    if (
      !signedIn ||
      !snapshot.jwt ||
      snapshot.accountId !== accountId ||
      snapshot.bindingVersion !== bindingVersion
    )
      throw new Error("session changed");
    return run();
  },
});
stub("../use-vault-role", { readVaultRole: async () => "editor", canPerformAction: () => true });
stub("../notification-preferences", {
  notificationPolicyForContact: async () => deliveryPolicy,
  notificationPolicyForTab: async () => {
    const work = onTabPolicyRead;
    onTabPolicyRead = null;
    if (work) await work();
    return deliveryPolicy;
  },
  notificationPreferencesRevision: () => preferenceVersion,
  notificationOwnerScope: () => (signedIn ? `account:${accountId}` : "local:install"),
  onNotificationPreferencesChanged: (listener: () => void) => {
    preferenceListeners.add(listener);
    return () => preferenceListeners.delete(listener);
  },
});
stub("../notification-capabilities", {
  notificationPreferencesSupported: async () => preferencesSupported,
});
stub("../i18n", {
  getLocale: () => locale,
  subscribeLocale: (fn: () => void) => {
    localeListeners.add(fn);
    return () => localeListeners.delete(fn);
  },
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
    const wait = authWait;
    authWait = null;
    if (wait) await wait();
    if (!signedIn || authFailure) throw new Error("no session or locked keychain");
    return { jwt: "synthetic" };
  },
  registerTabNotifications: async (_: unknown, id: string, options: unknown) => {
    registrations.push({ id, options });
    return registrationResult();
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
  deliveryPolicy = { ...defaultNotificationPolicy(), previews: "full" };
  preferencesSupported = true;
  onTabPolicyRead = null;
  locale = "en";
  registrationResult = async () => ({ enabled: true });
  meta.clear();
  calls.length = 0;
  asks = 0;
  registrations = [];
  scheduled = [];
  signedIn = true;
  accountId = "account";
  bindingVersion = 1;
  authWait = null;
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
  currentEntry = undefined;
  onEntryRead = null;
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
  for (const locale of ["en", "fa", "ps"]) {
    const category = categories.find((c) => c.id === `tab-review-${locale}`)!;
    assert.equal(category.actions.length, 2);
    for (const action of category.actions) {
      assert.equal(action.options.opensAppToForeground, false);
      assert.equal(action.options.isAuthenticationRequired, true);
    }
  }
  await test("language changes refresh the server immediately inside the hourly throttle", async () => {
    locale = "fa";
    granted = true;
    await notify.ensureTabNotificationPermission();
    assert.equal(registrations[0].options.locale, "fa");
    await notify.syncTabPushSubscriptions();
    assert.equal(registrations.length, 1, "unchanged account/language stays throttled");
    changeLocale("ps");
    await settled();
    assert.deepEqual(
      registrations.map((item) => item.options.locale),
      ["fa", "ps"],
    );
    assert.equal(asks, 0, "language changes do not reprompt when permission is granted");
  });
  await test("a language change during a request serializes the latest locale and ignores stale status", async () => {
    locale = "fa";
    granted = true;
    let finish!: (value: { enabled: boolean }) => void;
    registrationResult = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const first = notify.ensureTabNotificationPermission();
    await settled();
    assert.equal(registrations.length, 1);
    changeLocale("en");
    changeLocale("ps");
    await settled();
    assert.equal(registrations.length, 1, "newer requests wait for the old server response");
    registrationResult = async () => ({ enabled: true });
    finish({ enabled: false });
    await first;
    await settled();
    assert.deepEqual(
      registrations.map((item) => item.options.locale),
      ["fa", "ps"],
    );
    assert.equal(meta.get("tab_push_active"), "1");
    assert.equal(meta.get("tab_push_error"), "");
    await notify.syncTabPushSubscriptions();
    assert.equal(registrations.length, 2, "the latest successful registration owns the throttle");
  });
  await test("a failed old-language request cannot delay the latest-language registration", async () => {
    locale = "fa";
    granted = true;
    let fail!: (error: Error) => void;
    registrationResult = () =>
      new Promise((_, reject) => {
        fail = reject;
      });
    const first = notify.ensureTabNotificationPermission();
    await settled();
    changeLocale("ps");
    registrationResult = async () => ({ enabled: true });
    fail(new Error("synthetic old-language connection failure"));
    await first;
    await settled();
    assert.deepEqual(
      registrations.map((item) => item.options.locale),
      ["fa", "ps"],
    );
    assert.equal(meta.get("tab_push_error"), "");
  });
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
  await test("explicit old notification reviews still reach the server after either closure reason", async () => {
    for (const closed_reason of [null, "account_deleted"] as const) {
      links = [{ ...link, closed_at: 10, closed_reason }];
      for (const action of ["tab-accept", "tab-reject"]) {
        calls.length = 0;
        await task({ data: response(action) });
        assert.deepEqual(calls.slice(0, 3), ["queue", "dismiss", "sync"]);
      }
    }
    assert.equal(queued.has(`${ENTRY}:1:accept`), true);
    assert.equal(queued.has(`${ENTRY}:1:dispute`), true);
    assert.equal(scheduled.length, 0, "reviewing is separate from alert permission");
    authFailure = true;
    calls.length = 0;
    await task({ data: response("tab-accept") });
    assert.equal(calls.includes("queue"), false, "closure never bypasses current authentication");
    assert.equal(scheduled.length, 0, "a failed closed-tab action does not create a new alert");
  });
  await test("an old notification tap cannot queue or mark a review for a replacement account", async () => {
    links = [{ ...link, closed_at: 10 }];
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    authWait = async () => {
      start();
      await waiting;
    };
    const handling = task({ data: response("tab-accept") });
    await started;
    accountId = "replacement";
    bindingVersion++;
    release();
    await handling;
    await settled();
    assert.equal(queued.size, 0, "the replacement session cannot inherit the old tap");
    assert.deepEqual(inboxMarks, [], "nor can it mark the previous account's notice as handled");
    assert.equal(calls.includes("sync"), false);
    assert.equal(
      scheduled.length,
      0,
      "the closed relationship stays muted on a stale action failure",
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
      shown("closed-outcome", { tab_id: TAB2, entry_id: ENTRY2, rev: 2, kind: "entry_accepted" }),
      shown("closed-meta", { tab_id: TAB2, rev: 3, kind: "updated" }),
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
      ["reviewed", "closed", "closed-outcome", "closed-meta"],
      "closed relationships mute every alert; only stale review requests disappear on open ones",
    );
    dismissed.length = 0;
    presented = sweepable();
    rows.set(ENTRY2, { status: "pending", voided_by_entry_id: "void-row" });
    emitApplied({ tabId: TAB, relationshipId: "r", vaultId: "vault", origin: "pull", changes: [] });
    await settled();
    assert.deepEqual(
      dismissed,
      ["reviewed", "pending", "closed", "closed-outcome", "closed-meta"],
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
  await test("a local unlink immediately clears all tray alerts without erasing inbox history", async () => {
    links = [{ ...link, closed_at: 20 }];
    presented = [
      shown("created", { tab_id: TAB, entry_id: ENTRY, kind: "entry_created" }),
      shown("accepted", { tab_id: TAB, entry_id: ENTRY, kind: "entry_accepted" }),
      shown("rejected", { tab_id: TAB, entry_id: ENTRY2, kind: "entry_rejected" }),
      shown("metadata", { tab_id: TAB, kind: "updated" }),
      shown("reminder", { tab_id: TAB, kind: "customer_reminder" }),
      shown("other", { unrelated: true }),
    ];
    emitApplied({ tabId: TAB, origin: "local", changes: [] });
    await settled();
    assert.deepEqual(dismissed, ["created", "accepted", "rejected", "metadata"]);
    assert.deepEqual(
      inboxMarks,
      [],
      "muting presentation does not mark or delete durable inbox records",
    );
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
      // A customer reminder is an alarm the user set: it alerts even while
      // Kaata is open, where it used to be dropped without a sound or banner.
      state.currentState = "active";
      const reminder = response("default", {
        kind: "customer_reminder",
        owner_scope: `account:${accountId}`,
        reminder_id: "r1",
      }).notification;
      assert.deepEqual(await handler.handleNotification(reminder), {
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      });
    }
  });
  await test("late remote alerts for closed relationships stay silent on both platforms", async () => {
    state.currentState = "background";
    for (const os of ["android", "ios"]) {
      platform.OS = os;
      for (const closed_reason of [null, "account_deleted"] as const) {
        links = [{ ...link, closed_at: 30, closed_reason }];
        for (const kind of [
          "entry_created",
          "entry_accepted",
          "entry_rejected",
          "entry_voided",
          "updated",
        ]) {
          const result = await handler.handleNotification(
            response("default", { ...payload, kind }).notification,
          );
          assert.deepEqual(result, {
            shouldShowBanner: false,
            shouldShowList: false,
            shouldPlaySound: false,
            shouldSetBadge: false,
          });
        }
        assert.equal(
          (
            await handler.handleNotification(
              response("default", {
                tab_id: TAB,
                kind: "customer_reminder",
                owner_scope: `account:${accountId}`,
              }).notification,
            )
          ).shouldShowBanner,
          true,
          "the user's own reminder remains independent of shared alerts",
        );
      }
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
  await test("closed-period pulls update history without scheduling any fallback alerts", async () => {
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "pending",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      author_account_id: "peer",
    };
    for (const closed_reason of [null, "account_deleted"] as const) {
      links = [{ ...link, closed_at: 40, closed_reason }];
      emitApplied({
        tabId: TAB,
        origin: "pull",
        changes: ["entry_created", "entry_accepted", "entry_rejected", "entry_voided"].map(
          (kind) => ({
            entryId: ENTRY,
            rev: 1,
            kind,
          }),
        ),
      });
      await settled();
    }
    assert.equal(scheduled.length, 0);
    assert.deepEqual(inboxMarks, []);
  });
  await test("unlinking during an incoming fallback's entry read prevents the alert", async () => {
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "pending",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      author_account_id: "peer",
    };
    onEntryRead = () => {
      links = [{ ...link, closed_at: 50 }];
    };
    emitApplied({
      tabId: TAB,
      origin: "pull",
      changes: [{ entryId: ENTRY, rev: 1, kind: "entry_created" }],
    });
    await settled();
    assert.equal(onEntryRead, null, "the close raced the shipped fallback path");
    assert.equal(scheduled.length, 0);
  });
  await test("settings register full per-contact policy and unsupported servers lose old full-detail subscriptions", async () => {
    granted = true;
    deliveryPolicy = { ...deliveryPolicy, tallies: false, sound: false, previews: "private" };
    await notify.ensureTabNotificationPermission();
    assert.deepEqual(registrations.at(-1).options.preferences, deliveryPolicy);
    preferencesSupported = false;
    await notify.ensureTabNotificationPermission();
    assert.equal(registrations.at(-1).options.token, "");
    assert.equal(registrations.at(-1).options.preferences, undefined);
    assert.equal(meta.get("tab_push_error"), "settings_unsupported");
    assert.equal(meta.get("tab_push_active:" + TAB), "0");
  });
  await test("a policy read from an old preference generation cannot start an HTTP registration", async () => {
    granted = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTabPolicyRead = () => blocked;
    const old = notify.ensureTabNotificationPermission();
    await settled();
    assert.equal(onTabPolicyRead, null, "the old registration is waiting on its policy read");
    deliveryPolicy = { ...deliveryPolicy, previews: "private" };
    preferenceVersion++;
    const latest = notify.ensureTabNotificationPermission();
    release();
    await Promise.all([old, latest]);
    assert.equal(registrations.length, 1, "only the latest privacy snapshot reaches the server");
    assert.equal(registrations[0].options.preferences.previews, "private");
  });
  await test("master, categories, quiet hours, foreground and sound independently control OS presentation", async () => {
    state.currentState = "background";
    deliveryPolicy.enabled = false;
    assert.equal(
      (await handler.handleNotification(response("default").notification)).shouldShowBanner,
      false,
    );
    deliveryPolicy.enabled = true;
    for (const [key, kind] of [
      ["tallies", "entry_created"],
      ["reviews", "entry_accepted"],
      ["cancellations", "entry_voided"],
      ["connections", "joined"],
      ["reminders", "customer_reminder"],
    ] as const) {
      deliveryPolicy[key] = false;
      assert.equal(
        (
          await handler.handleNotification(
            response("default", { ...payload, kind, owner_scope: `account:${accountId}` })
              .notification,
          )
        ).shouldShowBanner,
        false,
      );
      deliveryPolicy[key] = true;
    }
    deliveryPolicy.sound = false;
    const silent = await handler.handleNotification(response("default").notification);
    assert.equal(silent.shouldShowBanner, true);
    assert.equal(silent.shouldPlaySound, false);
    state.currentState = "active";
    deliveryPolicy.foreground = true;
    assert.equal(
      (await handler.handleNotification(response("default").notification)).shouldShowBanner,
      true,
    );
    deliveryPolicy.time_zone = "UTC";
    const now = new Date(),
      minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    deliveryPolicy.quiet_hours = {
      enabled: true,
      start_minute: (minute + 1439) % 1440,
      end_minute: (minute + 1) % 1440,
      allow_reminders: true,
    };
    assert.equal(
      (await handler.handleNotification(response("default").notification)).shouldShowBanner,
      false,
    );
    const reminder = response("default", {
      kind: "customer_reminder",
      owner_scope: `account:${accountId}`,
    }).notification;
    assert.equal((await handler.handleNotification(reminder)).shouldShowBanner, true);
    deliveryPolicy.quiet_hours.allow_reminders = false;
    assert.equal((await handler.handleNotification(reminder)).shouldShowBanner, false);
  });
  await test("old-account reminders and signed-out shared alerts never show", async () => {
    state.currentState = "background";
    for (const owner_scope of [undefined, "account:previous"]) {
      assert.equal(
        (
          await handler.handleNotification(
            response("default", { kind: "customer_reminder", owner_scope }).notification,
          )
        ).shouldShowBanner,
        false,
      );
    }
    signedIn = false;
    assert.equal(
      (await handler.handleNotification(response("default").notification)).shouldShowBanner,
      false,
    );
  });
  for (const recordingMode of ["notify", "notify_one_way"] as const)
    await test(`${recordingMode} fallback alerts honor previews and never offer approval`, async () => {
      state.currentState = "background";
      links = [{ ...link, recording_mode: recordingMode }];
      currentEntry = {
        created_by: "a",
        status: "recorded",
        amount_minor: 12345,
        direction: "a_to_b",
        author_name: "Private Person",
        author_account_id: "peer",
      };
      for (const [previews, body] of [
        ["full", "tab.notify.detail.recorded"],
        ["name", "notificationSettings.alert.tally"],
        ["private", "notificationSettings.alert.private"],
      ] as const) {
        deliveryPolicy = { ...deliveryPolicy, previews, sound: false, vibration: false };
        emitApplied({
          tabId: TAB,
          origin: "pull",
          changes: [{ entryId: ENTRY, rev: 2, kind: "entry_created" }],
        });
        await settled();
        assert.equal(scheduled.at(-1).content.body, body);
        assert.equal(scheduled.at(-1).content.categoryIdentifier, undefined);
        assert.equal(scheduled.at(-1).content.sound, undefined);
        assert.equal(scheduled.at(-1).trigger.channelId, "tab-updates-s0-v0");
        assert.ok(!JSON.stringify(scheduled.at(-1).content.data).includes("Private Person"));
      }
      for (const action of ["tab-accept", "tab-reject"]) {
        await task({ data: response(action) });
        await responseListener(response(action));
      }
      await settled();
      assert.equal(
        queued.size,
        0,
        "stale notification buttons cannot review tallies without an approval requirement",
      );
      assert.deepEqual(inboxMarks, [], "ignoring an inapplicable action does not mark a review");
      assert.ok(!calls.includes("sync"));
    });
  await test("one-way, unknown and unresolved modes ignore pending-tally review buttons", async () => {
    state.currentState = "background";
    for (const mode of [
      { recording_mode: "notify_one_way" },
      { recording_mode: "future_unknown" },
      { recording_mode: "review", recording_mode_known: 0 },
    ]) {
      links = [{ ...link, ...mode } as TabLink];
      currentEntry = {
        created_by: "a",
        status: "pending",
        amount_minor: 12500,
        direction: "a_to_b",
        author_account_id: "peer",
      };
      emitApplied({
        tabId: TAB,
        origin: "pull",
        changes: [{ entryId: ENTRY, rev: 2, kind: "entry_created" }],
      });
      await settled();
      assert.equal(scheduled.at(-1).content.categoryIdentifier, undefined);
      for (const action of ["tab-accept", "tab-reject"]) {
        await task({ data: response(action) });
        await responseListener(response(action));
      }
      await settled();
      assert.equal(queued.size, 0, "notification metadata never grants review rights");
      assert.deepEqual(inboxMarks, []);
    }
  });
  await test("iOS discards stale native reviews for a read-only notification recipient", async () => {
    platform.OS = "ios";
    links = [{ ...link, recording_mode: "notify_one_way" }];
    nativePending = [
      { id: "old-accept", action: "tab-accept", data: payload },
      { id: "old-reject", action: "tab-reject", data: payload },
    ];
    await notify.ensureTabNotificationPermission();
    assert.equal(nativePending.length, 0, "inapplicable native handoffs are completed once");
    assert.equal(queued.size, 0);
    assert.deepEqual(inboxMarks, []);
    assert.ok(!calls.includes("sync"));
  });
  await test("account or privacy changes during an entry read suppress stale local alerts", async () => {
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "pending",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      author_account_id: "peer",
    };
    for (const race of ["privacy", "account"] as const) {
      onEntryRead = () => {
        if (race === "privacy") {
          deliveryPolicy = { ...deliveryPolicy, previews: "private" };
          preferenceVersion++;
        } else {
          accountId = "replacement";
          bindingVersion++;
        }
      };
      emitApplied({
        tabId: TAB,
        origin: "pull",
        changes: [{ entryId: ENTRY, rev: 2, kind: "entry_created" }],
      });
      await settled();
      assert.equal(
        scheduled.length,
        0,
        "stale sensitive content never reaches the native scheduler",
      );
    }
  });
  await test("peer cancellations follow cancellation preference without author self-alerts", async () => {
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "recorded",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      voided_by_entry_id: "void",
    };
    const event = {
      tabId: TAB,
      origin: "pull",
      changes: [{ entryId: ENTRY, rev: 2, kind: "entry_voided" }],
    };
    deliveryPolicy.cancellations = false;
    emitApplied(event);
    await settled();
    assert.equal(scheduled.length, 0);
    deliveryPolicy.cancellations = true;
    emitApplied(event);
    await settled();
    assert.equal(scheduled.length, 1);
    currentEntry.created_by = "b";
    emitApplied(event);
    await settled();
    assert.equal(scheduled.length, 1);
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
