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
let onSweepRead: (() => Promise<void>) | null = null;
// tab_entries rows by id for the tray sweep; anything else answers currentEntry.
const rows = new Map<string, any>();
let responseListener: any;
let receivedListener: any;
let registeredTask = "";
const channels = new Map<string, Record<string, unknown>>();
let categories: Array<{ id: string; actions: any[] }> = [];
let registrations: any[] = [];
let accountRegistrations: any[] = [];
let tokenListener: ((token: { type: string; data: string }) => void) | undefined;
let tokenGate: Promise<{ data: string }> | null = null;
let onTokenRequest: ((options: any) => Promise<void>) | null = null;
const tokenOptions: any[] = [];
let unregisters = 0;
const identityListeners = new Set<() => void>();
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
const reviewScopes: string[] = [];
// The OS tray, and what left it; the read marks that reached the server stub.
let presented: any[] = [];
let trayGate: Promise<any[]> | null = null;
const dismissed: string[] = [];
const inboxMarks: unknown[] = [];
const cues: Array<{ key: string; sound: boolean; vibration: boolean }> = [];

stub("react-native", { AppState: state, Platform: platform });
stub("../foreground-notification-cue", {
  playForegroundNotificationCue: (
    { sound, vibration }: NotificationPolicy,
    current: () => boolean,
    key: string,
  ) => {
    if (current() && (sound || vibration)) cues.push({ key, sound, vibration });
  },
});
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
  onAccountIdentityChanged: (listener: () => void) => {
    identityListeners.add(listener);
    return () => identityListeners.delete(listener);
  },
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
      if (sql.includes("SELECT status, voided_by_entry_id FROM tab_entries")) {
        const hook = onSweepRead;
        onSweepRead = null;
        await hook?.();
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
  getTabLink: async (id: string, vaultId?: string) =>
    links.find((l) => l.tab_id === id && (!vaultId || l.vault_id === vaultId)) ?? null,
  listTabLinksForId: async (id: string) => links.filter((l) => l.tab_id === id),
  listTabLinks: async () => links,
  queueNotificationReview: async (link: TabLink, entry: string, rev: number, action: string) => {
    calls.push("queue");
    reviewScopes.push(`${link.vault_id}:${link.role}`);
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
stub("../account-notifications", {
  registerAccountNotifications: async (
    session: unknown,
    token: string,
    locale: string,
    preferences: unknown,
  ) => {
    accountRegistrations.push({ session, token, locale, preferences });
    return { enabled: !!token };
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
stub("../tabs/binding-access", { isTabVaultRevoked: async () => false });
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
  addPushTokenListener: (listener: (token: { type: string; data: string }) => void) => {
    tokenListener = listener;
    return { remove() {} };
  },
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async (id: string, options: Record<string, unknown>) => {
    channels.set(id, options);
  },
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
  getExpoPushTokenAsync: async (options: any) => {
    tokenOptions.push(options);
    await onTokenRequest?.(options);
    return tokenGate ? await tokenGate : { data: "synthetic-push-token" };
  },
  unregisterForNotificationsAsync: async () => {
    unregisters++;
  },
  dismissNotificationAsync: async (id: string) => {
    calls.push("dismiss");
    dismissed.push(id);
  },
  getPresentedNotificationsAsync: async () => (trayGate ? await trayGate : presented),
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
const { observeIncomingRequests } =
  require("../incoming-request-cue") as typeof import("../incoming-request-cue");
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
  accountRegistrations = [];
  tokenGate = null;
  onTokenRequest = null;
  tokenOptions.length = 0;
  unregisters = 0;
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
  reviewScopes.length = 0;
  nativePending = [];
  presented = [];
  trayGate = null;
  dismissed.length = 0;
  inboxMarks.length = 0;
  cues.length = 0;
  rows.clear();
  currentEntry = undefined;
  onEntryRead = null;
  onSweepRead = null;
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
  for (const sound of [0, 1]) {
    const disabled = channels.get(`tab-updates-s${sound}-v0`);
    const enabled = channels.get(`tab-updates-s${sound}-v1`);
    assert.ok(disabled);
    assert.equal(disabled.enableVibrate, false);
    assert.equal(Object.hasOwn(disabled, "vibrationPattern"), false);
    assert.equal(enabled?.enableVibrate, true);
    assert.deepEqual(enabled?.vibrationPattern, [0, 250, 250, 250]);
  }
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
    assert.ok(Number(meta.get(`tab_push_active:account:vault:${TAB}`)) > 0);
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
  await test("one party's push subscription cannot suppress the other party's fallback", async () => {
    const a = { ...link, role: "a", vault_id: "other-vault" } as TabLink;
    links = [a, link];
    registrationResult = async () => ({ enabled: registrations.length === 1 });
    await notify.ensureTabNotificationPermission();
    assert.ok(Number(meta.get(`tab_push_active:account:other-vault:${TAB}`)) > 0);
    assert.equal(meta.get(`tab_push_active:account:vault:${TAB}`), "0");
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "pending",
      amount_minor: 500,
      direction: "a_to_b",
      author_account_id: "peer",
    };
    emitApplied({
      tabId: TAB,
      vaultId: "vault",
      origin: "pull",
      changes: [{ entryId: ENTRY, rev: 2, kind: "entry_created" }],
    });
    await settled();
    assert.equal(
      scheduled.length,
      1,
      "B still gets its fallback when only A registered successfully",
    );
    currentEntry.created_by = "b";
    emitApplied({
      tabId: TAB,
      vaultId: "other-vault",
      origin: "pull",
      changes: [{ entryId: ENTRY2, rev: 3, kind: "entry_created" }],
    });
    await settled();
    assert.equal(scheduled.length, 1, "A relies on its own active push subscription");
    accountId = "replacement";
    emitApplied({
      tabId: TAB,
      vaultId: "other-vault",
      origin: "pull",
      changes: [{ entryId: ENTRY2, rev: 4, kind: "entry_created" }],
    });
    await settled();
    assert.equal(
      scheduled.length,
      2,
      "a replacement account does not inherit the prior account's registration",
    );
  });
  await test("discovering a second party binding refreshes push without waiting for the hourly timer", async () => {
    await notify.ensureTabNotificationPermission();
    assert.equal(registrations.length, 1);
    await notify.syncTabPushSubscriptions();
    assert.equal(registrations.length, 1, "unchanged bindings keep the network throttle");
    links = [...links, { ...link, vault_id: "recovered-vault", role: "a" }];
    await notify.syncTabPushSubscriptions();
    assert.equal(
      registrations.length,
      3,
      "the recovered perspective registers immediately in the same foreground session",
    );
    assert.ok(Number(meta.get(`tab_push_active:account:recovered-vault:${TAB}`)) > 0);
    await notify.syncTabPushSubscriptions();
    assert.equal(
      registrations.length,
      3,
      "the new successful signature becomes the throttle owner",
    );
  });
  await test("denial is remembered; settings revocation unregisters", async () => {
    grantOnRequest = false;
    await notify.ensureTabNotificationPermission();
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 1);
    assert.equal(registrations.at(-1).options.token, "");
    assert.equal(meta.get("tab_push_error"), "permission_denied");
  });
  await test("signed-out app never prompts; signed-in accounts register without shared tallies", async () => {
    signedIn = false;
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 0);
    assert.equal(registrations.length, 0);
    signedIn = true;
    links = [];
    accountRegistrations = [];
    await notify.ensureTabNotificationPermission();
    assert.equal(asks, 1);
    assert.equal(accountRegistrations.length, 1);
    assert.equal(accountRegistrations[0].token, "synthetic-push-token");
    assert.equal(registrations.length, 0);
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
  await test("a review notification selects its party when the account can see both Kaata sides", async () => {
    links = [{ ...link, role: "a", vault_id: "other-vault" }, link];
    await task({ data: response("tab-accept") });
    assert.deepEqual(
      reviewScopes,
      ["vault:b"],
      "the active/first binding cannot replace the push's recipient party",
    );
    await task({ data: response("tab-reject", { ...payload, entry_id: ENTRY2, role: "a" }) });
    assert.deepEqual(reviewScopes, ["vault:b", "other-vault:a"]);
  });
  await test("removal notices never dispatch the original tally review action", async () => {
    for (const kind of [
      "entry_removal_requested",
      "entry_removal_approved",
      "entry_removal_declined",
    ]) {
      for (const action of ["tab-accept", "tab-reject"])
        await task({ data: response(action, { ...payload, kind }) });
    }
    assert.equal(queued.size, 0);
    assert.equal(inboxMarks.length, 0);
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
      ["reviewed", "closed", "closed-meta"],
      "closed relationships mute stale requests but retain final outcome alerts",
    );
    dismissed.length = 0;
    presented = sweepable();
    rows.set(ENTRY2, { status: "pending", voided_by_entry_id: "void-row" });
    emitApplied({ tabId: TAB, relationshipId: "r", vaultId: "vault", origin: "pull", changes: [] });
    await settled();
    assert.deepEqual(
      dismissed,
      ["reviewed", "pending", "closed", "closed-meta"],
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
    assert.deepEqual(dismissed, ["created", "metadata"]);
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
  await test("foreground notices cue once through the app or the OS presentation path", async () => {
    for (const os of ["android", "ios"]) {
      platform.OS = os;
      state.currentState = "active";
      cues.length = 0;
      meta.delete("notification_delivered_v1:account");
      const result = await handler.handleNotification(response("default").notification);
      assert.deepEqual(result, {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
      assert.deepEqual(cues, [
        { key: `account:account:tab:${TAB}:${ENTRY}:1`, sound: true, vibration: true },
      ]);
      deliveryPolicy.foreground = true;
      assert.equal(
        (await handler.handleNotification(response("default", { ...payload, rev: 2 }).notification))
          .shouldPlaySound,
        true,
      );
      deliveryPolicy.foreground = false;
      const own = response("default", { ...payload, actor_account_id: "account" }).notification;
      assert.equal((await handler.handleNotification(own)).shouldShowBanner, false);
      state.currentState = "background";
      assert.equal(
        (await handler.handleNotification(response("default", { ...payload, rev: 3 }).notification))
          .shouldShowBanner,
        true,
      );
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
      assert.equal(cues.length, 1, "no additional app cue for system alerts or own notices");
    }
  });
  await test("closed relationships suppress new work but deliver terminal outcomes once", async () => {
    state.currentState = "background";
    links = [{ ...link, closed_at: 30 }];
    let rev = 10;
    for (const kind of [
      "entry_created",
      "entry_removal_requested",
      "updated",
      "settled",
      "unlinked",
      "entry_accepted",
      "entry_rejected",
      "entry_voided",
      "entry_removal_approved",
      "entry_removal_declined",
    ]) {
      const notification = response("default", { ...payload, kind, rev: ++rev }).notification;
      const shouldShow = !["entry_created", "entry_removal_requested", "updated"].includes(kind);
      assert.equal(
        (await handler.handleNotification(notification)).shouldShowBanner,
        shouldShow,
        kind,
      );
      assert.equal(
        (await handler.handleNotification(notification)).shouldShowBanner,
        false,
        `retry of ${kind}`,
      );
    }
  });
  await test("pull fallback cues in the foreground and skips own acknowledgements", async () => {
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
    assert.equal(cues[0]?.key, `account:account:tab:${TAB}:${ENTRY}:1`);
    currentEntry.created_by = "b";
    emitApplied(ev);
    await settled();
    assert.equal(cues.length, 1, "own side in foreground");
    state.currentState = "background";
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
  await test("foreground request polling cues for newly arrived requests only", async () => {
    const poll = (
      previous: ReturnType<typeof observeIncomingRequests>,
      rows: Array<{ id: string; created_at_ms: number }>,
    ) => observeIncomingRequests(previous, rows, "friend_request", () => true);
    const existing = { id: "existing", created_at_ms: 10 };
    const fresh = { id: "fresh", created_at_ms: 11 };
    let seen = poll(null, [existing]);
    await settled();
    assert.equal(cues.length, 0, "silent baseline");
    seen = poll(seen, [fresh, existing]);
    await settled();
    assert.equal(cues[0]?.key, "account:account:connection:friend_requested:fresh");
    seen = poll(seen, [existing, { id: "older", created_at_ms: 9 }]);
    await settled();
    assert.equal(cues.length, 1, "an older request can become visible after an action");
    deliveryPolicy.connections = false;
    seen = poll(seen, [{ id: "muted", created_at_ms: 12 }]);
    await settled();
    assert.equal(cues.length, 1);
    deliveryPolicy.connections = true;
    poll(seen, [{ id: "stale", created_at_ms: 13 }]);
    accountId = "other-account";
    await settled();
    assert.equal(cues.length, 1, "pending policy lookup cannot cue across an account switch");
  });
  await test("closed-period pulls retain final outcomes but suppress stale entry creation", async () => {
    state.currentState = "background";
    currentEntry = {
      created_by: "a",
      status: "accepted",
      amount_minor: 100,
      direction: "a_to_b",
      author_name: "Writer",
      author_account_id: "peer",
    };
    links = [{ ...link, closed_at: 40 }];
    emitApplied({
      tabId: TAB,
      origin: "pull",
      changes: ["entry_created", "entry_accepted", "entry_rejected", "entry_voided"].map(
        (kind, i) => ({ entryId: ENTRY, rev: i + 1, kind }),
      ),
    });
    await settled();
    assert.deepEqual(
      scheduled.map((item) => item.content.data.kind),
      ["entry_accepted", "entry_rejected", "entry_voided"],
    );
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
    assert.equal(meta.get(`tab_push_active:account:vault:${TAB}`), "0");
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
      ["cancellations", "entry_removal_requested"],
      ["cancellations", "entry_removal_approved"],
      ["cancellations", "entry_removal_declined"],
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
      (await handler.handleNotification(response("default", { ...payload, rev: 2 }).notification))
        .shouldShowBanner,
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
  await test("account connection pushes ring with no tabs and reject old-account delivery", async () => {
    links = [];
    const data = {
      target: "connection",
      kind: "friend_accepted",
      notification_id: "900",
      source_id: ENTRY,
      actor_account_id: "peer",
      recipient_account_id: accountId,
    };
    await handler.handleNotification(response("default", data).notification);
    await handler.handleNotification(response("default", data).notification);
    assert.equal(cues.length, 1, "provider retry cues only once");
    const before = cues.length;
    await handler.handleNotification(
      response("default", { ...data, notification_id: "901", recipient_account_id: "other" })
        .notification,
    );
    assert.equal(cues.length, before, "old account recipient is ignored");
    await handler.handleNotification(
      response("default", { ...data, notification_id: "902", recipient_account_id: undefined })
        .notification,
    );
    assert.equal(cues.length, before, "missing recipient is not trusted");
    state.currentState = "background";
    assert.equal(
      (
        await handler.handleNotification(
          response("default", { ...data, notification_id: "903" }).notification,
        )
      ).shouldShowBanner,
      true,
    );
  });
  await test("foreground inbox banners share push receipts and respect private previews", async () => {
    links = [];
    granted = true;
    deliveryPolicy.foreground = true;
    deliveryPolicy.previews = "private";
    const item = {
      id: "910",
      kind: "friend_accepted",
      actor_account_id: "peer",
      recipient_account_id: accountId,
      source_id: ENTRY,
      body: "Sensitive full detail",
      created_at_ms: Date.now(),
      read: false,
      tab_id: "",
      entry_id: "",
      role: "" as const,
      rev: 0,
    };
    assert.equal(
      await notify.presentForegroundInboxNotification(item, deliveryPolicy, () => true),
      true,
    );
    assert.equal(scheduled[0].content.body, "notificationSettings.alert.private");
    assert.equal(scheduled[0].content.data.target, "connection");
    const data = scheduled[0].content.data;
    assert.equal(
      (await handler.handleNotification(response("default", data).notification)).shouldShowBanner,
      true,
    );
    assert.equal(
      (await handler.handleNotification(response("default", data).notification)).shouldShowBanner,
      false,
    );
    assert.equal(cues.length, 0);
    const baseline = observeIncomingRequests(null, [], "friend_request", () => true);
    observeIncomingRequests(
      baseline,
      [{ id: ENTRY2, created_at_ms: Date.now() }],
      "friend_request",
      () => true,
    );
    await settled();
    assert.equal(cues.length, 0, "request cards leave enabled banners to the global observer");
  });
  await test("remote connection reads clear exact tray IDs and mark-all preserves newer notices", async () => {
    const data = {
      target: "connection",
      kind: "friend_requested",
      source_id: ENTRY,
      recipient_account_id: accountId,
    };
    presented = [
      shown("old", { ...data, notification_id: "920" }),
      shown("new", { ...data, notification_id: "921" }),
    ];
    inboxReads.announceServerReads([
      { id: "920", recipient_account_id: accountId, tab_id: "", rev: 0, read: true },
    ]);
    await settled();
    assert.deepEqual(dismissed, ["old"]);
    dismissed.length = 0;
    await inboxReads.markInboxHandled({ through: "920" });
    await settled();
    assert.deepEqual(dismissed, ["old"], "mark-all cursor never dismisses a later notification");
  });
  await test("late tray cleanup cannot clear a replacement account's notifications", async () => {
    let release!: (value: any[]) => void;
    trayGate = new Promise((resolve) => {
      release = resolve;
    });
    const marking = inboxReads.markInboxHandled({ through: "999" });
    await settled();
    accountId = "replacement";
    bindingVersion++;
    identityListeners.forEach((fn) => fn());
    await settled();
    accountId = "third";
    bindingVersion++;
    identityListeners.forEach((fn) => fn());
    await settled();
    release([
      shown("current", {
        target: "connection",
        kind: "friend_accepted",
        notification_id: "930",
        recipient_account_id: "third",
      }),
    ]);
    await marking;
    await settled();
    assert.deepEqual(dismissed, [], "A mark-all and B cleanup cannot dismiss C's valid notice");
  });
  await test("a shared-tray sweep cannot dismiss notices after its account changes during SQLite reads", async () => {
    presented = [shown("current-account-notice", { ...payload })];
    rows.set(ENTRY, { status: "accepted", voided_by_entry_id: null });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    onSweepRead = () => pending;
    emitApplied({ tabId: TAB, vaultId: "vault", origin: "pull", changes: [] });
    await settled();
    assert.equal(onSweepRead, null, "the shipped sweep reached its SQLite await");
    accountId = "replacement";
    bindingVersion++;
    identityListeners.forEach((fn) => fn());
    release();
    await settled();
    assert.deepEqual(
      dismissed,
      [],
      "previous account's cached verdict cannot clear the replacement account's tray",
    );
  });
  await test("SDK 58's initial native-token event does not cancel or recursively restart registration", async () => {
    links = [];
    granted = true;
    const nativeToken = { type: "android", data: "native-initial" };
    onTokenRequest = async (options) => {
      if (!options.devicePushToken) tokenListener?.(nativeToken);
    };
    await notify.ensureTabNotificationPermission();
    await settled();
    assert.equal(tokenOptions.length, 1, "native acquisition is not recursively repeated");
    assert.equal(
      accountRegistrations.length,
      1,
      "the initial native event does not invalidate its own registration",
    );
    assert.ok(Number(meta.get("account_push_active:account")) > 0);
    tokenListener?.(nativeToken);
    tokenListener?.({ ...nativeToken });
    await settled();
    assert.equal(tokenOptions.length, 1, "repeated identical token emissions are no-ops");
    assert.equal(accountRegistrations.length, 1);
  });
  await test("a genuine token rotation during exchange registers the latest token without losing the wakeup", async () => {
    links = [];
    granted = true;
    let release!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    onTokenRequest = async () => exchanging;
    const old = notify.ensureTabNotificationPermission();
    await settled();
    assert.equal(tokenOptions[0].devicePushToken.data, "native-initial");
    tokenListener?.({ type: "android", data: "native-rotated-during-exchange" });
    onTokenRequest = null;
    release();
    await old;
    await settled();
    assert.equal(tokenOptions.length, 2);
    assert.equal(tokenOptions[1].devicePushToken.data, "native-rotated-during-exchange");
    assert.equal(accountRegistrations.length, 1, "stale token exchange is never registered");
    assert.ok(Number(meta.get("account_push_active:account")) > 0);
  });
  await test("token changes re-register an account with no existing shared tallies", async () => {
    links = [];
    granted = true;
    await notify.ensureTabNotificationPermission();
    assert.equal(accountRegistrations.length, 1);
    tokenListener?.({ type: "android", data: "rotated-token" });
    await settled();
    assert.equal(accountRegistrations.length, 2);
  });
  await test("hung native token acquisition cannot trap logout or register a stale account", async () => {
    links = [];
    granted = true;
    let release!: (value: { data: string }) => void;
    tokenGate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = notify.ensureTabNotificationPermission();
    await settled();
    const began = Date.now();
    await notify.unregisterAccountNotificationPush({ accountId, bindingVersion, jwt: "synthetic" });
    assert.ok(
      Date.now() - began < 3500,
      "logout wait is bounded even when native token acquisition never resolves",
    );
    assert.equal(unregisters, 1, "native push token revoked on sign-out");
    assert.equal(accountRegistrations.at(-1).token, "");
    accountId = "replacement";
    bindingVersion++;
    tokenGate = null;
    identityListeners.forEach((fn) => fn());
    await settled();
    assert.equal(accountRegistrations.at(-1).session.accountId, "replacement");
    release({ data: "stale-token" });
    await pending;
    assert.equal(
      accountRegistrations.some((registration) => registration.token === "stale-token"),
      false,
    );
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
