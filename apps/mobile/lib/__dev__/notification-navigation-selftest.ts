import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { tallyScrollTarget } from "../tally-viewport";
import { settleUI } from "./ui-fixture";

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
    },
  },
  "./db": {
    getTabLink: async () =>
      cached ? { relationship_id: "relationship", vault_id: "correct-vault" } : null,
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
function notificationTapFixture(initial: any = null, listenerOnSubscribe: any = null) {
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
    openedCount = 0;
  const reminderCalls: any[] = [],
    tabCalls: any[] = [],
    legacyRoutes: any[] = [];
  const native = {
    DEFAULT_ACTION_IDENTIFIER: "default",
    addNotificationResponseReceivedListener(fn: any) {
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
      openCustomerReminder: async (...args: any[]) => reminderCalls.push(args),
    },
    "../lib/tabs/open-notification": {
      openTabNotification: async (...args: any[]) => tabCalls.push(args),
    },
  };
  const code = ts.transpileModule(
    `${globals}\n exports.mount = () => { ${effect.getText(source)} };`,
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const exported: any = {};
  new Function(
    "require",
    "exports",
    "useEffect",
    "appReady",
    "isRunningInExpoGo",
    "setLaunchNotificationOpened",
    "setLaunchNotificationsReady",
    "router",
    "__DEV__",
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
    true,
    () => false,
    () => {
      openedCount++;
    },
    () => {
      readyCount++;
    },
    { push: (route: any) => legacyRoutes.push(route) },
    false,
  );
  return {
    reminderCalls,
    tabCalls,
    legacyRoutes,
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
    mount: () => exported.mount(),
    unmount: () => cleanup?.(),
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
  assert.deepEqual(cold.reminderCalls, [
    [id, "account:a", JSON.stringify(["same-request", 1000]), "private-state-fingerprint"],
  ]);
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
    simultaneous.tabCalls,
    [[TAB, ENTRY, { rev: 4 }]],
    "tab routing and revision remain intact",
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
