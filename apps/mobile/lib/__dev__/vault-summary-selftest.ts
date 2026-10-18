// Execute the real summary hooks with controlled SQLite, app state and timers.
// Native Modal animation remains covered by the sheet/device smoke checks.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, settleUI, uiHooks } from "./ui-fixture";

function fixture() {
  const hooks = uiHooks();
  const timers = new Map<number, { run: () => void; ms: number }>();
  const listeners = new Set<(state: string) => void>();
  let nextTimer = 0;
  let dbCalls = 0;
  const memberReads: string[] = [];
  const syncReads: string[] = [];
  let count = 3;
  let timestamp = Date.now();
  let membersReply = async () => ({ n: count });
  const db = {
    getFirstAsync: (_sql: string, vault: string) => {
      memberReads.push(vault);
      return membersReply();
    },
  };
  let dbReply = async () => db;
  const appState = {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const summary = compileUI(
    "../use-vault-summary",
    {
      react: hooks.react,
      "react-native": { AppState: appState },
      "./db-tx": {
        getDb: () => {
          dbCalls++;
          return dbReply();
        },
      },
      "./sync": {
        getSyncIndicator: async (vault: string) => {
          syncReads.push(vault);
          return { lastPullAt: new Date(timestamp - 100), lastPushAt: new Date(timestamp) };
        },
      },
      "./i18n": { t: (key: string) => key },
    },
    {
      setInterval: (run: () => void, ms: number) => {
        const id = ++nextTimer;
        timers.set(id, { run, ms });
        return id;
      },
      clearInterval: (id: number) => timers.delete(id),
    },
  );
  const props = { vault: "vault-a" as string | null, enabled: false };
  const render = () =>
    hooks.render(() => ({
      type: "Summary",
      props: {
        count: summary.useMembersCount(props.vault, props.enabled),
        synced: summary.useLastSyncedRelative(props.vault, props.enabled),
      },
    })).props;
  return {
    hooks,
    props,
    render,
    timers,
    listeners,
    memberReads,
    syncReads,
    get dbCalls() {
      return dbCalls;
    },
    setCount(next: number) {
      count = next;
    },
    setTimestamp(next: number) {
      timestamp = next;
    },
    holdDb() {
      const pending = deferred<typeof db>();
      dbReply = () => pending.promise;
      return () => {
        dbReply = async () => db;
        pending.resolve(db);
      };
    },
    holdMembers() {
      const pending = deferred<{ n: number }>();
      membersReply = () => pending.promise;
      return (n: number) => {
        membersReply = async () => ({ n: count });
        pending.resolve({ n });
      };
    },
    failMembers() {
      membersReply = async () => {
        throw new Error("Transient SQLite read failure");
      };
    },
    restoreMembers() {
      membersReply = async () => ({ n: count });
    },
    tick(ms: number) {
      for (const timer of [...timers.values()]) if (timer.ms === ms) timer.run();
    },
    changeState(state: string) {
      appState.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

async function main() {
  const f = fixture();
  assert.equal(f.render().count, 1);
  await settleUI();
  assert.equal(f.dbCalls, 0, "closed settings never open SQLite");
  assert.equal(f.syncReads.length, 0, "closed summaries never read sync state");
  assert.equal(f.timers.size, 0, "closed settings do not retain polling timers");
  assert.equal(f.listeners.size, 0, "closed settings do not retain app-state listeners");

  f.props.enabled = true;
  f.render();
  await settleUI();
  const first = f.render();
  assert.equal(first.count, 3, "opening starts a fresh membership read immediately");
  assert.equal(first.synced.label, "menu.sync.justNow");
  assert.deepEqual(f.memberReads, ["vault-a"]);
  assert.deepEqual(f.syncReads, ["vault-a"]);
  assert.deepEqual([...f.timers.values()].map((timer) => timer.ms).sort(), [15_000, 30_000]);
  f.render();
  assert.equal(f.dbCalls, 1, "ordinary renders do not restart polling");

  f.props.enabled = false;
  const closed = f.render();
  assert.equal(closed.count, first.count, "retain the displayed count during the exit animation");
  assert.deepEqual(closed.synced, first.synced, "retain the last-sync label during the exit");
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  f.tick(15_000);
  f.tick(30_000);
  await settleUI();
  assert.equal(f.dbCalls, 1, "closed timers perform no further reads");
  f.setCount(5);
  f.setTimestamp(Date.now() - 120_000);
  f.props.enabled = true;
  f.render();
  await settleUI();
  assert.equal(f.render().count, 5, "reopening does not wait for the old polling deadline");
  assert.equal(f.render().synced.label, "menu.sync.minAgo");

  const finishBackgroundRead = f.holdMembers();
  f.tick(15_000);
  await settleUI();
  const readsBeforeBackground = f.memberReads.length;
  f.tick(15_000);
  await settleUI();
  assert.equal(f.memberReads.length, readsBeforeBackground, "slow reads do not overlap");
  f.changeState("background");
  assert.equal(f.timers.size, 0, "backgrounding pauses both timers while the sheet is open");
  finishBackgroundRead(99);
  await settleUI();
  assert.equal(f.render().count, 5, "a pre-background reply cannot update the resumed sheet");
  f.setCount(7);
  f.changeState("active");
  await settleUI();
  assert.equal(f.render().count, 7, "foregrounding refreshes an open sheet immediately");
  const resumedCalls = f.dbCalls;
  f.changeState("active");
  assert.equal(f.dbCalls, resumedCalls, "duplicate active notifications do not restart reads");

  f.failMembers();
  f.tick(15_000);
  await settleUI();
  assert.equal(f.render().count, 7, "transient read errors retain the displayed value");
  f.restoreMembers();
  f.setCount(0);
  f.tick(15_000);
  await settleUI();
  assert.equal(f.render().count, 1, "the existing local-only single-member fallback is preserved");
  f.hooks.unmount();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);

  const race = fixture();
  const finishDbOpen = race.holdDb();
  race.props.enabled = true;
  race.render();
  race.props.enabled = false;
  race.render();
  finishDbOpen();
  await settleUI();
  assert.equal(race.memberReads.length, 0, "closing during DB open skips the subsequent SELECT");
  const finishOldVault = race.holdMembers();
  race.props.enabled = true;
  race.render();
  await settleUI();
  race.props.vault = "vault-b";
  race.restoreMembers();
  race.setCount(8);
  race.render();
  await settleUI();
  assert.equal(race.render().count, 8);
  finishOldVault(99);
  await settleUI();
  assert.equal(race.render().count, 8, "old vault replies never replace the current vault's count");
  const finishUnmounted = race.holdMembers();
  race.tick(15_000);
  await settleUI();
  race.hooks.unmount();
  finishUnmounted(99);
  await settleUI();
  assert.equal(race.hooks.lateWrites, 0, "unmounted hooks ignore in-flight results");
  assert.equal(race.timers.size, 0);
  assert.equal(race.listeners.size, 0);

  const idle = fixture();
  idle.changeState("background");
  idle.props.enabled = true;
  idle.render();
  await settleUI();
  assert.equal(idle.dbCalls, 0, "opening in the background waits for foreground");
  assert.equal(idle.timers.size, 0);
  idle.changeState("active");
  await settleUI();
  assert.equal(idle.render().count, 3);
  idle.props.vault = null;
  idle.render();
  assert.equal(idle.timers.size, 0, "missing vaults do not poll");
  assert.equal(idle.listeners.size, 0);
  idle.hooks.unmount();

  settingsVisibilityWiring();
  console.log(
    "PASS: closed/background summary reads, immediate reopen/resume, stale replies, cadence, failures and cleanup",
  );
}

function settingsVisibilityWiring() {
  const hooks = uiHooks();
  let rendered = false;
  const reads: unknown[][] = [];
  const sheet = compileUI("../../components/ProfileSettingsSheet", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "./SheetBackdrop": { SheetBackdrop: "Backdrop" },
    "./SheetHandle": { SheetHandle: "Handle" },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: () => ({ rendered, opacity: 1, position: 0 }),
    },
    "../lib/use-sheet-drag": { useSheetDrag: () => ({ translateY: 0, panHandlers: {} }) },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": { useRouter: () => ({}) },
    "react-native": {
      Animated: { View: "AnimatedView" },
      Dimensions: { get: () => ({ height: 800 }) },
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (styles: unknown) => styles },
    },
    "react-native-safe-area-context": { SafeAreaView: "Safe", useSafeAreaInsets: () => ({}) },
    "../lib/colors": { colors: {} },
    "../lib/db-tx": { getAccountIdSync: () => null },
    "../lib/design-tokens": {},
    "../lib/currency": { getCurrencySymbol: () => "" },
    "../lib/direction": { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) },
    "../lib/fonts": { fonts: {} },
    "../constants/env": { SOLO_STORE_MODE: true },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/use-vault-summary": {
      useMembersCount: (...args: unknown[]) => {
        reads.push(args);
        return 1;
      },
    },
    "./InitialAvatar": { InitialAvatar: "Avatar" },
    "./SettingsScreen": { NavRow: "NavRow", SectionGap: "Gap", SectionHeader: "Header" },
  });
  const props = { visible: false, activeVaultId: "vault-a", vaults: [], signedInUser: null };
  const render = () => hooks.render(() => sheet.ProfileSettingsSheet(props));
  assert.equal(render(), null);
  assert.deepEqual(reads.at(-1), ["vault-a", false]);
  props.visible = true;
  rendered = true;
  assert.equal(render().type, "Modal");
  assert.deepEqual(reads.at(-1), ["vault-a", true]);
  props.visible = false;
  assert.equal(
    render().type,
    "Modal",
    "closing keeps the existing Modal until its exit animation finishes",
  );
  assert.deepEqual(
    reads.at(-1),
    ["vault-a", false],
    "polling stops at dismiss, before the exit completes",
  );
  hooks.unmount();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
