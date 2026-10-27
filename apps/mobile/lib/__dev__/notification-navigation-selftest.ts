import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { tallyScrollTarget } from "../tally-viewport";
import { deferred, settleUI } from "./ui-fixture";

const viewport = { offset: 100, viewport: 700, bottomInset: 100, height: 80 };
assert.equal(tallyScrollTarget({ ...viewport, top: 250 }), null, "upper-middle tally stays put");
assert.equal(tallyScrollTarget({ ...viewport, top: 420 }), null, "middle tally stays put");
assert.equal(
  tallyScrollTarget({ ...viewport, top: 550 }),
  null,
  "fully visible lower tally stays put",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900 }),
  640,
  "offscreen tally centered, not pinned to top",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 40 }),
  0,
  "above viewport: clamp to content start",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 660 }),
  400,
  "reveal tally covered by floating actions",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 550, bottomInset: 250 }),
  365,
  "account for toast-raised footer",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 250, height: 800 }),
  null,
  "visible long note does not jump",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900, height: 800 }),
  884,
  "offscreen long note reveals its beginning",
);
assert.equal(
  tallyScrollTarget({ ...viewport, top: 900, viewport: 0 }),
  null,
  "wait for measured viewport",
);

const TAB = "00000000-0000-4000-8000-000000000001";
const ENTRY = "00000000-0000-4000-8000-000000000002";
let account: string | null = "account",
  accessible = true,
  cached = true,
  switchAccount = false;
const calls: string[] = [];
const routes: any[] = [];
const handled: unknown[] = [];
let markThrows = false;
let tabReads = 0;
let syncGate: Promise<void> | null = null;
let duringCurrency: (() => void) | null = null;
const mocks: Record<string, any> = {
  "./inbox-reads": {
    markInboxHandled: (spec: unknown) => {
      handled.push(spec);
      if (markThrows) throw new Error("queue unavailable");
      return Promise.resolve();
    },
  },
  "expo-router": {
    router: {
      push: (r: any) => {
        calls.push("route");
        routes.push(r);
      },
    },
  },
  "../db-tx": {
    getAccountIdSync: () => account,
    setActiveVaultId: async (id: string) => {
      calls.push(id);
    },
  },
  "../currency": {
    applyVaultCurrency: async () => {
      calls.push("currency");
      duringCurrency?.();
    },
  },
  "./db": {
    getTabLink: async () => {
      tabReads++;
      return cached ? { relationship_id: "relationship", vault_id: "correct-vault" } : null;
    },
    getPersonIdForRelationship: async () => {
      if (switchAccount) account = "another-account";
      return "person";
    },
  },
  "./sync": {
    reconcileTabsFromServer: async () => {
      cached = true;
      calls.push("recover");
    },
    syncTab: async () => {
      calls.push("sync");
      if (syncGate) await syncGate;
      return { ok: accessible };
    },
  },
};
const out: any = {};
new Function(
  "require",
  "exports",
  ts.transpileModule(readFileSync(require.resolve("../tabs/open-notification"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
)((key: string) => {
  assert.ok(key in mocks, key);
  return mocks[key];
}, out);

// Execute the real root-layout notification effect without booting React
// Native/database/fonts. Its native API and route adapters are the boundary.
function notificationTapFixture(
  initial: any = null,
  listenerOnSubscribe: any = null,
  options: {
    appReady?: boolean;
    fontsReady?: boolean;
    dbReady?: boolean | null;
    navigationReady?: boolean;
    appState?: string;
    expoGo?: boolean;
    platform?: "ios" | "android";
  } = {},
) {
  const text = readFileSync(require.resolve("../../app/_layout"), "utf8");
  const source = ts.createSourceFile(
    "_layout.tsx",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const globals = source.statements
    .filter((node) => {
      if (ts.isFunctionDeclaration(node))
        return ["notificationResponseKey", "routeFromNotificationData"].includes(
          node.name?.text ?? "",
        );
      if (ts.isVariableStatement(node))
        return node.declarationList.declarations.some((declaration) =>
          ["NOTIFICATION_PERSON_PREFIX", "handledNotificationResponses"].includes(
            declaration.name.getText(source),
          ),
        );
      return false;
    })
    .map((node) => node.getText(source))
    .join("\n");
  const root = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "RootLayout",
  ) as ts.FunctionDeclaration;
  const effect = root.body!.statements.find(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "useEffect" &&
      node.getText(source).includes("addNotificationResponseReceivedListener"),
  );
  assert.ok(effect, "actual tap-routing effect exists");
  let retained = initial,
    listener: ((response: any) => void) | null = null,
    cleanup: (() => void) | undefined,
    clearCount = 0,
    readyCount = 0,
    openedCount = 0,
    listenerRegistrations = 0;
  let adapterFailures = 0;
  let adapterGate: Promise<void> | null = null;
  let gates = {
    appReady: true,
    fontsReady: true,
    dbReady: true as boolean | null,
    navigationReady: true,
    ...options,
  };
  const appListeners = new Set<(state: string) => void>();
  const appState = {
    currentState: options.appState ?? "active",
    addEventListener: (_event: string, callback: (state: string) => void) => {
      appListeners.add(callback);
      return { remove: () => appListeners.delete(callback) };
    },
  };
  let timerId = 0;
  const timers = new Map<number, { run: () => void; delay: number }>();
  const timerHistory: { run: () => void; delay: number }[] = [];
  const frames = new Map<number, () => void>();
  const successfulReminders: any[] = [];
  const reminderCalls: any[] = [],
    tabCalls: any[] = [],
    legacyRoutes: any[] = [];
  const native = {
    DEFAULT_ACTION_IDENTIFIER: "default",
    addNotificationResponseReceivedListener(fn: any) {
      listenerRegistrations++;
      listener = fn;
      if (listenerOnSubscribe) {
        const value = listenerOnSubscribe;
        listenerOnSubscribe = null;
        fn(value);
      }
      return {
        remove: () => {
          listener = null;
        },
      };
    },
    getLastNotificationResponse: () => retained,
    clearLastNotificationResponse() {
      retained = null;
      clearCount++;
    },
  };
  const dependencies: Record<string, any> = {
    "expo-notifications": native,
    "../lib/open-customer-reminder": {
      openCustomerReminder: async (...args: any[]) => {
        reminderCalls.push(args);
        if (adapterGate) await adapterGate;
        if (adapterFailures > 0) {
          adapterFailures--;
          throw new Error("Synthetic reminder route not ready");
        }
        if (args[4] && !args[4]()) return;
        successfulReminders.push(args);
      },
    },
    "../lib/tabs/open-notification": {
      openTabNotification: async (...args: any[]) => tabCalls.push(args),
    },
  };
  const code = ts.transpileModule(
    `${globals}\n exports.mount = (gates) => { const { appReady, fontsReady, dbReady, navigationReady } = gates; ${effect.getText(source)} };`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const exported: any = {};
  new Function(
    "require",
    "exports",
    "useEffect",
    "AppState",
    "isRunningInExpoGo",
    "Platform",
    "setLaunchNotificationOpened",
    "setLaunchNotificationsReady",
    "router",
    "__DEV__",
    "setTimeout",
    "clearTimeout",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    code,
  )(
    (name: string) => {
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
    exported,
    (run: () => () => void) => {
      cleanup = run();
    },
    appState,
    () => options.expoGo ?? false,
    { OS: options.platform ?? "android" },
    () => {
      openedCount++;
    },
    () => {
      readyCount++;
    },
    { push: (route: any) => legacyRoutes.push(route) },
    false,
    (run: () => void, delay: number) => {
      const record = { run, delay };
      const id = ++timerId;
      timers.set(id, record);
      timerHistory.push(record);
      return id;
    },
    (id: number) => timers.delete(id),
    (run: () => void) => {
      const id = ++timerId;
      frames.set(id, run);
      return id;
    },
    (id: number) => frames.delete(id),
  );
  return {
    reminderCalls,
    tabCalls,
    legacyRoutes,
    successfulReminders,
    timers,
    timerHistory,
    frames,
    appListeners,
    get listenerRegistrations() {
      return listenerRegistrations;
    },
    get retained() {
      return retained;
    },
    get clearCount() {
      return clearCount;
    },
    get readyCount() {
      return readyCount;
    },
    get openedCount() {
      return openedCount;
    },
    mount: (next: Partial<typeof gates> = {}) => {
      cleanup?.();
      cleanup = undefined;
      gates = { ...gates, ...next };
      exported.mount(gates);
    },
    unmount: () => {
      cleanup?.();
      cleanup = undefined;
    },
    setState: (state: string) => {
      appState.currentState = state;
      for (const callback of [...appListeners]) callback(state);
    },
    failAttempts: (count: number) => {
      adapterFailures = count;
    },
    gateAdapter: (gate: Promise<void> | null) => {
      adapterGate = gate;
    },
    flushFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((run) => run());
    },
    runTimer: () => {
      assert.ok(timers.size > 0, "a bounded retry is scheduled");
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.run();
      return timer.delay;
    },
    tap: (response: any) => {
      retained = response;
      listener?.(response);
    },
    duplicate: (response: any) => listener?.(response),
  };
}

async function notificationTapTests() {
  const id = "12345678-1234-1234-1234-123456789abc";
  const reminderData = {
    kind: "customer_reminder",
    reminder_id: id,
    owner_scope: "account:a",
    reminder_fingerprint: "private-state-fingerprint",
  };
  const notice = (
    data: any,
    date = 1000,
    actionIdentifier = "default",
    identifier = "same-request",
  ) => ({
    actionIdentifier,
    notification: { date, request: { identifier, content: { data } } },
  });
  const launch = notice(reminderData);
  const cold = notificationTapFixture(launch);
  cold.mount();
  await settleUI();
  assert.deepEqual(
    cold.reminderCalls.map((args) => args.slice(0, 4)),
    [[id, "account:a", JSON.stringify(["same-request", 1000]), "private-state-fingerprint"]],
  );
  assert.equal(
    typeof cold.reminderCalls[0][4],
    "function",
    "the reminder adapter receives a live routing guard",
  );
  assert.equal(cold.clearCount, 1, "cold launch consumes native retained tap");
  assert.equal(cold.retained, null);
  cold.duplicate(launch);
  await settleUI();
  assert.equal(cold.reminderCalls.length, 1, "launch and listener copies route once");
  cold.unmount();
  cold.mount();
  await settleUI();
  assert.equal(cold.reminderCalls.length, 1, "layout remount cannot replay a launch draft");
  const nextOccurrence = notice(reminderData, 2000);
  cold.tap(nextOccurrence);
  await settleUI();
  assert.equal(
    cold.reminderCalls.length,
    2,
    "later recurrence of the same request gets a fresh intent",
  );
  assert.notEqual(cold.reminderCalls[1][2], cold.reminderCalls[0][2]);
  assert.equal(cold.clearCount, 2);
  cold.unmount();
  const ordinaryRestart = notificationTapFixture(cold.retained);
  ordinaryRestart.mount();
  await settleUI();
  assert.equal(
    ordinaryRestart.reminderCalls.length,
    0,
    "a new process on ordinary launch has no retained draft",
  );
  ordinaryRestart.unmount();

  // A native listener delivery that arrives while the cold lookup is being
  // installed uses exactly the same claim/clear path.
  const simultaneous = notificationTapFixture(launch, launch);
  simultaneous.mount();
  await settleUI();
  assert.equal(simultaneous.reminderCalls.length, 1);
  assert.equal(simultaneous.openedCount, 1);
  assert.equal(simultaneous.readyCount, 1);
  simultaneous.tap(notice(reminderData, 3000, "tab-accept"));
  await settleUI();
  assert.equal(
    simultaneous.reminderCalls.length,
    1,
    "custom tab actions remain with their own handler",
  );
  const tab = notice({ tab_id: TAB, entry_id: ENTRY, rev: "4" }, 4000, "default", "tab-notice");
  simultaneous.tap(tab);
  await settleUI();
  assert.deepEqual(
    simultaneous.tabCalls.map((args) => args.slice(0, 3)),
    [[TAB, ENTRY, { rev: 4 }]],
    "tab routing and revision remain intact",
  );
  assert.equal(
    typeof simultaneous.tabCalls[0][3],
    "function",
    "shared-tab opens receive the same live routing guard",
  );
  simultaneous.tap(notice({ url: "kaata://person/customer" }, 5000, "default", "legacy-notice"));
  await settleUI();
  assert.deepEqual(simultaneous.legacyRoutes, [
    { pathname: "/person/[id]", params: { id: "customer" } },
  ]);
  simultaneous.tap(notice({ ...reminderData, reminder_id: 5 }, 6000));
  simultaneous.tap(notice(reminderData, Number.NaN));
  simultaneous.tap(notice(reminderData, 7000, "default", ""));
  await settleUI();
  assert.equal(
    simultaneous.reminderCalls.length,
    1,
    "malformed native/payload identifiers never authorize a draft",
  );
  const { reminder_fingerprint, ...legacyReminderData } = reminderData;
  simultaneous.tap(notice(legacyReminderData, 7500));
  await settleUI();
  assert.equal(
    simultaneous.reminderCalls.at(-1)[3],
    undefined,
    "older alerts keep compatibility without a fingerprint",
  );
  simultaneous.tap(notice({ ...reminderData, reminder_fingerprint: 7 }, 7600));
  await settleUI();
  assert.equal(
    simultaneous.reminderCalls.at(-1)[3],
    "",
    "malformed fingerprints cannot masquerade as absent legacy metadata",
  );
  const beforeUnmount = simultaneous.reminderCalls.length;
  const lateListener = notice(reminderData, 8000);
  simultaneous.unmount();
  simultaneous.tap(lateListener);
  await settleUI();
  assert.equal(simultaneous.reminderCalls.length, beforeUnmount, "removed listener cannot route");

  for (const guard of ["appReady", "fontsReady", "dbReady", "navigationReady"] as const) {
    const waiting = notificationTapFixture(launch, null, { [guard]: false });
    waiting.mount();
    await settleUI();
    waiting.flushFrames();
    await settleUI();
    assert.equal(
      waiting.reminderCalls.length,
      0,
      `${guard} blocks launch routing before the navigator can handle it`,
    );
    assert.equal(waiting.clearCount, 0);
    assert.equal(waiting.retained, launch);
    assert.equal(
      waiting.readyCount,
      0,
      "startup intent arbitration also waits for real routing readiness",
    );
    waiting.mount({ [guard]: true });
    await settleUI();
    waiting.flushFrames();
    await settleUI();
    assert.equal(waiting.successfulReminders.length, 1);
    assert.equal(
      waiting.clearCount,
      1,
      "the original retained tap drains after readiness without redelivery",
    );
    waiting.unmount();
  }
  const incompleteDb = notificationTapFixture(launch, null, { dbReady: null });
  incompleteDb.mount();
  await settleUI();
  assert.equal(incompleteDb.clearCount, 0, "unknown database readiness cannot consume a tap");
  incompleteDb.unmount();

  const iosGo = notificationTapFixture(launch, null, { expoGo: true, platform: "ios" });
  iosGo.mount();
  await settleUI();
  assert.equal(
    iosGo.listenerRegistrations,
    1,
    "iPhone Expo Go installs local notification response routing",
  );
  assert.equal(iosGo.successfulReminders.length, 1);
  assert.equal(
    iosGo.clearCount,
    1,
    "iPhone Expo Go consumes its retained local reminder after routing",
  );
  assert.equal(iosGo.retained, null);
  iosGo.duplicate(launch);
  await settleUI();
  assert.equal(iosGo.reminderCalls.length, 1, "iPhone Expo Go shares native-tap deduplication");
  iosGo.unmount();

  for (const guard of ["appReady", "fontsReady", "dbReady", "navigationReady"] as const) {
    const waitingGo = notificationTapFixture(launch, null, {
      expoGo: true,
      platform: "ios",
      appState: "inactive",
      [guard]: false,
    });
    waitingGo.mount();
    await settleUI();
    assert.equal(waitingGo.listenerRegistrations, 0, `iPhone Expo Go waits for ${guard}`);
    assert.equal(waitingGo.clearCount, 0);
    assert.equal(waitingGo.retained, launch);
    waitingGo.mount({ [guard]: true });
    await settleUI();
    assert.equal(waitingGo.listenerRegistrations, 1);
    assert.equal(
      waitingGo.reminderCalls.length,
      0,
      "iPhone Expo Go retains lock-screen taps until active",
    );
    assert.equal(waitingGo.clearCount, 0);
    assert.equal(waitingGo.retained, launch);
    waitingGo.setState("active");
    await settleUI();
    assert.equal(waitingGo.successfulReminders.length, 1);
    assert.equal(
      waitingGo.clearCount,
      1,
      "ready and unlocked iPhone Expo Go drains the original tap",
    );
    waitingGo.unmount();
    assert.equal(waitingGo.appListeners.size, 0);
  }

  const androidGo = notificationTapFixture(launch, null, { expoGo: true, platform: "android" });
  androidGo.mount();
  await settleUI();
  assert.equal(
    androidGo.listenerRegistrations,
    0,
    "Android Expo Go keeps its native response-listener skip",
  );
  assert.equal(androidGo.appListeners.size, 0);
  assert.equal(androidGo.reminderCalls.length, 0);
  assert.equal(androidGo.clearCount, 0);
  assert.equal(
    androidGo.retained,
    launch,
    "unsupported Android Expo Go leaves native retained state untouched",
  );
  androidGo.setState("background");
  androidGo.setState("active");
  androidGo.duplicate(launch);
  await settleUI();
  assert.equal(androidGo.reminderCalls.length, 0);
  assert.equal(androidGo.clearCount, 0);
  androidGo.unmount();

  const inactive = notificationTapFixture(launch, null, { appState: "background" });
  inactive.mount();
  await settleUI();
  assert.equal(
    inactive.reminderCalls.length,
    0,
    "a locked/background process defers its launch tap",
  );
  assert.equal(inactive.clearCount, 0);
  assert.equal(inactive.retained, launch);
  assert.ok(
    inactive.openedCount > 0,
    "notification intent takes priority over email resume while waiting for active",
  );
  inactive.setState("active");
  await settleUI();
  assert.equal(inactive.successfulReminders.length, 1);
  assert.equal(inactive.clearCount, 1);
  inactive.setState("active");
  inactive.duplicate(launch);
  await settleUI();
  assert.equal(
    inactive.reminderCalls.length,
    1,
    "foreground events and duplicate delivery do not replay an opened tap",
  );
  inactive.unmount();

  const slowRoute = deferred<void>();
  const deferredRoute = notificationTapFixture(launch);
  deferredRoute.gateAdapter(slowRoute.promise);
  deferredRoute.mount();
  await settleUI();
  assert.equal(deferredRoute.reminderCalls.length, 1);
  assert.equal(deferredRoute.successfulReminders.length, 0);
  assert.equal(
    deferredRoute.clearCount,
    0,
    "native response remains available until async routing succeeds",
  );
  deferredRoute.duplicate(launch);
  await settleUI();
  assert.equal(
    deferredRoute.reminderCalls.length,
    1,
    "in-flight listener/launch duplicates coalesce",
  );
  slowRoute.resolve();
  await settleUI();
  assert.equal(deferredRoute.successfulReminders.length, 1);
  assert.equal(deferredRoute.clearCount, 1);
  deferredRoute.unmount();

  const retry = notificationTapFixture(launch);
  retry.failAttempts(1);
  retry.mount();
  await settleUI();
  assert.equal(retry.reminderCalls.length, 1);
  assert.equal(retry.successfulReminders.length, 0);
  assert.equal(retry.clearCount, 0, "a failed route does not consume its native response");
  assert.equal(retry.retained, launch);
  assert.equal(retry.runTimer(), 250);
  await settleUI();
  assert.equal(
    retry.reminderCalls.length,
    2,
    "a failed occurrence is not prematurely marked handled",
  );
  assert.equal(retry.successfulReminders.length, 1);
  assert.equal(retry.clearCount, 1);
  assert.equal(retry.timers.size, 0);
  retry.duplicate(launch);
  await settleUI();
  assert.equal(retry.reminderCalls.length, 2);
  retry.unmount();

  const bounded = notificationTapFixture(launch);
  bounded.failAttempts(99);
  bounded.mount();
  await settleUI();
  assert.equal(bounded.runTimer(), 250);
  await settleUI();
  assert.equal(bounded.runTimer(), 750);
  await settleUI();
  assert.equal(bounded.reminderCalls.length, 3);
  assert.equal(bounded.timers.size, 0, "automatic retries are bounded rather than looping");
  assert.equal(bounded.clearCount, 0);
  assert.equal(bounded.retained, launch);
  bounded.failAttempts(0);
  bounded.setState("background");
  bounded.setState("active");
  await settleUI();
  assert.equal(
    bounded.successfulReminders.length,
    1,
    "a later foreground can recover an unconsumed tap",
  );
  bounded.unmount();

  const cancelledRoute = deferred<void>();
  const departed = notificationTapFixture(launch);
  departed.gateAdapter(cancelledRoute.promise);
  departed.mount();
  await settleUI();
  const canOpen = departed.reminderCalls[0][4];
  assert.equal(canOpen(), true);
  departed.unmount();
  assert.equal(canOpen(), false, "a departed routing effect revokes its adapter guard");
  cancelledRoute.resolve();
  await settleUI();
  assert.equal(departed.successfulReminders.length, 0);
  assert.equal(departed.clearCount, 0);
  assert.equal(departed.retained, launch);
  assert.equal(departed.appListeners.size, 0);
  assert.equal(departed.timers.size, 0);
  assert.equal(departed.frames.size, 0);
  departed.gateAdapter(null);
  departed.mount();
  await settleUI();
  assert.equal(
    departed.successfulReminders.length,
    1,
    "an aborted effect does not poison retry after remount",
  );
  departed.unmount();

  const previousTap = deferred<void>();
  const superseded = notificationTapFixture(launch);
  superseded.gateAdapter(previousTap.promise);
  superseded.mount();
  await settleUI();
  const previousCanOpen = superseded.reminderCalls[0][4];
  superseded.gateAdapter(null);
  const newerTap = notice(reminderData, 9000, "default", "newer-request");
  superseded.tap(newerTap);
  await settleUI();
  assert.equal(previousCanOpen(), false, "a newer tap revokes an older in-flight open");
  assert.equal(superseded.successfulReminders.length, 1);
  assert.equal(superseded.successfulReminders[0][2], JSON.stringify(["newer-request", 9000]));
  previousTap.resolve();
  await settleUI();
  assert.equal(
    superseded.successfulReminders.length,
    1,
    "an older deferred customer cannot replace the newer destination",
  );
  assert.equal(superseded.clearCount, 1);
  superseded.unmount();

  const stoppedRetry = notificationTapFixture(launch);
  stoppedRetry.failAttempts(1);
  stoppedRetry.mount();
  await settleUI();
  const retainedTimer = stoppedRetry.timerHistory[0];
  const attemptsBeforeCleanup = stoppedRetry.reminderCalls.length;
  stoppedRetry.unmount();
  assert.equal(stoppedRetry.timers.size, 0);
  retainedTimer.run();
  await settleUI();
  assert.equal(
    stoppedRetry.reminderCalls.length,
    attemptsBeforeCleanup,
    "a stale retry timer cannot navigate after cleanup",
  );

  const hiddenRoute = deferred<void>();
  const backgrounded = notificationTapFixture(launch);
  backgrounded.gateAdapter(hiddenRoute.promise);
  backgrounded.mount();
  await settleUI();
  backgrounded.setState("background");
  assert.equal(backgrounded.reminderCalls[0][4](), false);
  hiddenRoute.resolve();
  await settleUI();
  assert.equal(backgrounded.successfulReminders.length, 0);
  assert.equal(backgrounded.clearCount, 0, "losing foreground before completion retains the tap");
  backgrounded.gateAdapter(null);
  backgrounded.setState("active");
  await settleUI();
  assert.equal(backgrounded.successfulReminders.length, 1);
  backgrounded.unmount();
}
async function main() {
  await notificationTapTests();
  await out.openTabNotification(TAB, ENTRY);
  assert.deepEqual(calls, ["sync", "correct-vault", "currency", "route"]);
  assert.equal(routes[0].params.entryId, ENTRY);
  const key = routes[0].params.notificationKey;
  await out.openTabNotification(TAB, ENTRY);
  assert.notEqual(routes[1].params.notificationKey, key, "repeat tap must replay the highlight");
  calls.length = 0;
  cached = false;
  await out.openTabNotification(TAB, ENTRY);
  assert.equal(calls[0], "recover");
  await out.openTabNotification(TAB, "../../untrusted");
  assert.equal(routes.at(-1).params.entryId, undefined);
  // Landing on the tally reads its notice — by inbox id (with tray hints)
  // from the bell, by the exact rev an OS payload announced (the entry as a
  // tray hint), by entry only when no rev is known, never with an entry id
  // that failed validation, and never at all when the tap named nothing. A
  // failing mark cannot undo the navigation.
  assert.deepEqual(handled, [
    { tab_id: TAB, entry_id: ENTRY },
    { tab_id: TAB, entry_id: ENTRY },
    { tab_id: TAB, entry_id: ENTRY },
  ]);
  handled.length = 0;
  await out.openTabNotification(TAB, ENTRY, { notificationId: "77", rev: 3 });
  await out.openTabNotification(TAB, ENTRY, { rev: 4 });
  await out.openTabNotification(TAB, null, { rev: 3 });
  await out.openTabNotification(TAB, "../../untrusted", { notificationId: "78" });
  await out.openTabNotification(TAB, "../../untrusted", { rev: 0 });
  await out.openTabNotification(TAB);
  assert.deepEqual(handled, [
    { id: "77", tab_id: TAB, entry_id: ENTRY, rev: 3 },
    { tab_id: TAB, rev: 4, entry_id: ENTRY },
    { tab_id: TAB, rev: 3 },
    { id: "78", tab_id: TAB },
  ]);
  markThrows = true;
  const routed = routes.length;
  await out.openTabNotification(TAB, ENTRY);
  assert.equal(routes.length, routed + 1, "a failing read mark must not fail the navigation");
  markThrows = false;
  handled.length = 0;
  calls.length = 0;
  const beforeCancellation = routes.length;
  const readsBeforeCancellation = tabReads;
  await out.openTabNotification(TAB, ENTRY, undefined, () => false);
  assert.deepEqual(calls, [], "an initially canceled tab open performs no sync or vault work");
  assert.equal(tabReads, readsBeforeCancellation);
  assert.equal(routes.length, beforeCancellation);
  assert.equal(handled.length, 0);

  const delayedSync = deferred<void>();
  syncGate = delayedSync.promise;
  let canOpenTab = true;
  const syncing = out.openTabNotification(TAB, ENTRY, undefined, () => canOpenTab);
  await settleUI();
  assert.deepEqual(calls, ["sync"]);
  canOpenTab = false;
  delayedSync.resolve();
  await syncing;
  syncGate = null;
  assert.deepEqual(calls, ["sync"], "a superseded sync cannot switch vaults or route");
  assert.equal(routes.length, beforeCancellation);
  assert.equal(handled.length, 0);

  calls.length = 0;
  canOpenTab = true;
  duringCurrency = () => {
    canOpenTab = false;
  };
  await out.openTabNotification(TAB, ENTRY, undefined, () => canOpenTab);
  duringCurrency = null;
  assert.deepEqual(calls, ["sync", "correct-vault", "currency"]);
  assert.equal(
    routes.length,
    beforeCancellation,
    "cleanup during currency selection prevents the final tab push",
  );
  assert.equal(handled.length, 0, "canceled tab navigation never marks a notice read");
  const before = routes.length;
  accessible = false;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  accessible = true;
  switchAccount = true;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  account = null;
  await assert.rejects(out.openTabNotification(TAB, ENTRY));
  assert.equal(routes.length, before, "revoked/signed-out/switched users never navigate");
  assert.equal(handled.length, 0, "a refused open must not read the notice either");
  console.log(
    "PASS: notification entry target, repeated taps, cold recovery, vault-before-route ordering, invalid payload, access checks and handled-means-read marks",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
