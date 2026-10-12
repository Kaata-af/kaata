// Executes the actual sheet and scoped data hook. Native animation/timer frames
// are controlled so stopped callbacks can still be delivered adversarially.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { searchContacts } from "../search";
import {
  compareCustomerNames,
  DEFAULT_CUSTOMER_LIST,
  CUSTOMER_SORTS,
  selectedCustomerGroupIds,
  toggleCustomerGroupFilter,
} from "../customer-list";

export async function customerGroupUIChecks() {
  const hooks = uiHooks(),
    timers = new Map<number, () => void>(),
    frames = new Map<number, () => void>();
  let sequence = 0,
    managed = 0,
    dismissed = 0,
    reduceListener: (value: boolean) => void = () => {};
  const reduce = deferred<boolean>();
  const animations: { callback?: (event: { finished: boolean }) => void; stopped: boolean }[] = [];
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
    stopAnimation() {}
    // The backdrop's opacity follows the slide.
    interpolate(config: { inputRange: number[]; outputRange: number[] }) {
      return { interpolation: config, source: this };
    }
  }
  const animate = () => {
    const record = {
      stopped: false,
      callback: undefined as ((event: { finished: boolean }) => void) | undefined,
    };
    animations.push(record);
    return {
      start: (callback?: typeof record.callback) => {
        record.callback = callback;
      },
      stop: () => {
        record.stopped = true;
      },
    };
  };
  const props = {
    visible: true,
    preference: DEFAULT_CUSTOMER_LIST,
    groups: [{ id: "g", name: "Family", member_count: 1 }],
    contextKey: "a:v1",
    canManage: true,
    isRTL: false,
    onChange: () => {},
    onManage: () => managed++,
    onDismiss: () => {
      dismissed++;
      props.visible = false;
    },
  };
  const { CustomerListSheet } = compileUI(
    "../../components/CustomerListSheet.tsx",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@expo/vector-icons": { Ionicons: "Ionicons" },
      "react-native": {
        Animated: { Value, spring: animate, timing: animate, View: "AnimatedView" },
        Dimensions: { get: () => ({ height: 800 }) },
        AccessibilityInfo: {
          isReduceMotionEnabled: () => reduce.promise,
          addEventListener: (_name: string, fn: typeof reduceListener) => {
            reduceListener = fn;
            return { remove() {} };
          },
        },
        Modal: "Modal",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (s: any) => s, absoluteFill: {} },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../lib/colors": { colors: {} },
      "../lib/fonts": { fonts: {} },
      "../lib/direction": { rowDir: () => ({}), textDir: () => ({}) },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/customer-list": {
        CUSTOMER_SORTS,
        selectedCustomerGroupIds,
        toggleCustomerGroupFilter,
      },
      "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
      "../lib/tokens": { icon: { row: 22 }, radius: { sheet: 18, grabber: 2 } },
    },
    {
      requestAnimationFrame: (fn: () => void) => {
        const id = ++sequence;
        frames.set(id, fn);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      setTimeout: (fn: () => void) => {
        const id = ++sequence;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const render = () => hooks.render(() => CustomerListSheet(props));
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((fn) => fn());
  };
  const clickManage = () =>
    nodes(hooks.tree)
      .find((n) => n.props.accessibilityLabel === "groups.manage")!
      .props.onPress();
  render();
  flushFrames();
  const rowLabels = () =>
    nodes(hooks.tree)
      .map((n) => n.props.accessibilityLabel)
      .filter(Boolean);
  assert.ok(rowLabels().includes("groups.ungrouped"), "group rows show once a group exists");
  props.groups = [];
  render();
  assert.ok(
    !rowLabels().includes("groups.all") && !rowLabels().includes("groups.ungrouped"),
    "no All/Ungrouped filter rows before any group exists",
  );
  assert.ok(rowLabels().includes("groups.manage"), "managers can still create the first group");
  props.groups = [{ id: "g", name: "Family", member_count: 1 }];
  render();
  props.visible = false;
  render();
  const staleClose = animations.at(-1)!;
  props.visible = true;
  render();
  staleClose.callback?.({ finished: true });
  render();
  assert.ok(
    nodes(hooks.tree).some((n) => n.type === "Modal"),
    "stopped close callback cannot hide reopened sheet",
  );
  assert.ok(staleClose.stopped);
  flushFrames();
  clickManage();
  clickManage();
  assert.equal(dismissed, 1, "double tap coalesces");
  render();
  const callbacks = [...timers.values()];
  timers.clear();
  callbacks.forEach((fn) => fn());
  assert.equal(managed, 1, "manage opens only after sheet dismiss");
  props.visible = true;
  render();
  clickManage();
  render();
  props.contextKey = "b:v2";
  render();
  assert.equal(timers.size, 0, "context change cancels pending navigation");
  props.visible = true;
  render();
  clickManage();
  render();
  props.visible = true;
  render();
  assert.equal(timers.size, 0, "rapid reopen cancels deferred action");
  reduceListener(true);
  render();
  assert.equal(frames.size, 0, "reduced motion does not enqueue animation frame");
  props.visible = false;
  render();
  assert.equal(hooks.tree, null, "reduced-motion close is immediate");
  props.visible = true;
  render();
  clickManage();
  render();
  const delayed = [...timers.values()];
  hooks.unmount();
  reduce.resolve(false);
  await settleUI();
  delayed.forEach((fn) => fn());
  staleClose.callback?.({ finished: true });
  assert.equal(managed, 1);
  assert.equal(
    hooks.lateWrites,
    0,
    "late native/promise/timer callbacks do not write after unmount",
  );
  console.log(
    "PASS real sort/filter sheet rapid reopen, coalesced manage, scope/unmount guards and reduced motion",
  );

  const dataHooks = uiHooks();
  let vault = "v1",
    account = "a",
    pause: Promise<any> | null = null;
  const ledgerListeners = new Set<() => void>();
  const read = async (id: string) => {
    const captured = pause;
    return captured
      ? await captured
      : {
          groups: [{ id: id + "-group", name: id, member_count: 1 }],
          groupByPerson: { p: id + "-group" },
          groupsByPerson: { p: [id + "-group"] },
        };
  };
  const { useCustomerGroups } = compileUI("../use-customer-groups.ts", {
    react: dataHooks.react,
    "expo-router": { useFocusEffect: (fn: any) => dataHooks.react.useEffect(fn, [fn]) },
    "./db-tx": { getAccountIdSync: () => account },
    "./customer-groups": { readCustomerGroups: read },
    "./ledger-events": {
      useLedgerRefresh: (_vault: string | null, fn: () => void) =>
        dataHooks.react.useEffect(() => {
          ledgerListeners.add(fn);
          return () => {
            ledgerListeners.delete(fn);
          };
        }, [fn]),
    },
  });
  const dataRender = () => dataHooks.render(() => jsx("State", useCustomerGroups(vault)));
  dataRender();
  await settleUI();
  dataRender();
  assert.equal(dataHooks.tree.props.groups[0].id, "v1-group");
  const late = deferred<any>();
  pause = late.promise;
  for (const fn of [...ledgerListeners]) fn();
  account = "b";
  vault = "v2";
  pause = null;
  dataRender();
  assert.equal(
    dataHooks.tree.props.groups.length,
    0,
    "old group list is hidden on scope-change render",
  );
  await settleUI();
  dataRender();
  assert.equal(dataHooks.tree.props.groups[0].id, "v2-group");
  late.resolve({
    groups: [{ id: "stale", name: "stale", member_count: 1 }],
    groupByPerson: { p: "stale" },
    groupsByPerson: { p: ["stale"] },
  });
  await settleUI();
  dataRender();
  assert.equal(
    dataHooks.tree.props.groups[0].id,
    "v2-group",
    "late old account/kaata read rejected",
  );
  const lateUnmount = deferred<any>();
  pause = lateUnmount.promise;
  for (const fn of [...ledgerListeners]) fn();
  dataHooks.unmount();
  lateUnmount.resolve({ groups: [], groupByPerson: {}, groupsByPerson: {} });
  await settleUI();
  assert.equal(dataHooks.lateWrites, 0);
  assert.equal(ledgerListeners.size, 0);
  console.log(
    "PASS real group hook scope-bound reads, live ledger refresh, late results and unmount cleanup",
  );

  const personHooks = uiHooks();
  let currentAccount = "a",
    currentVault = "v",
    personId = "p",
    backCount = 0;
  let editable = true;
  let personState = {
    groups: [
      { id: "g", name: "Family", member_count: 1 },
      { id: "h", name: "Neighbors", member_count: 0 },
    ],
    groupByPerson: { p: "g", q: "h" },
    groupsByPerson: { p: ["g"], q: ["h"] },
    loaded: true,
    failed: false,
  };
  const written: string[][] = [];
  const pendingSave = deferred<void>();
  let failSave = false;
  let preventRemove = false;
  let preventCallback: ((options: { data: { action: unknown } }) => void) | null = null;
  const dispatched: unknown[] = [];
  const compilePersonGroup = (react: typeof personHooks.react) =>
    compileUI("../../app/person/[id]/group.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "expo-router": {
        useRouter: () => ({ back: () => backCount++, push() {} }),
        useNavigation: () => ({ dispatch: (action: unknown) => dispatched.push(action) }),
        useLocalSearchParams: () => ({ id: personId, vaultId: "v" }),
      },
      "expo-router/react-navigation": {
        usePreventRemove: (prevent: boolean, callback: typeof preventCallback) => {
          preventRemove = prevent;
          preventCallback = callback;
        },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (s: any) => s },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../../../components/SettingsScreen": { ScreenHeader: "Header" },
      "../../../lib/customer-groups": {
        assignCustomerGroups: async (_vault: string, _id: string, ids: string[]) => {
          written.push([...ids]);
          await pendingSave.promise;
          if (failSave) throw new Error("synthetic save failure");
        },
      },
      "../../../lib/db-tx": {
        getAccountIdSync: () => currentAccount,
        getActiveVaultIdSyncMaybe: () => currentVault,
      },
      "../../../lib/colors": { colors: {} },
      "../../../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../../../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../../../lib/fonts": { fonts: {} },
      "../../../lib/i18n": { t: (key: string) => key },
      "../../../lib/use-customer-groups": { useCustomerGroups: () => personState },
      "../../../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend: editable }),
      },
      "../../../lib/tokens": { icon: { row: 22 } },
    }).default;
  const PersonGroupScreen = compilePersonGroup(personHooks.react);
  let personRender = () => personHooks.render(() => PersonGroupScreen());
  // The harness ignores state after unmount, so every remount is a fresh one.
  const remountPersonGroup = () => {
    const hooks = uiHooks();
    const Screen = compilePersonGroup(hooks.react);
    personRender = () => hooks.render(() => Screen());
    personTree = () => hooks.tree;
    return hooks;
  };
  let personTree = () => personHooks.tree;
  const personRow = (label: string) =>
    nodes(personTree()).find((n) => n.props.accessibilityLabel === label)!;
  personRender();
  assert.equal(personRow("Family").props.accessibilityState.selected, true);
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(personRow("Family").props.accessibilityState.selected, true);
  assert.equal(personRow("Neighbors").props.accessibilityState.selected, true);
  assert.equal(written.length, 0, "multi-selection edits stay local until Done");
  personState = { ...personState, groupsByPerson: { p: [], q: ["h"] } };
  personRender();
  assert.equal(
    personRow("Family").props.accessibilityState.selected,
    true,
    "live refresh keeps explicit draft",
  );
  personId = "q";
  personRender();
  assert.equal(
    personRow("Family").props.accessibilityState.selected,
    false,
    "route change never carries another person's draft",
  );
  assert.equal(personRow("Neighbors").props.accessibilityState.selected, true);
  personRow("common.done").props.onPress();
  personRow("common.done").props.onPress();
  await settleUI();
  assert.deepEqual(written, [["h"]], "Done serializes one complete set");
  pendingSave.resolve();
  await settleUI();
  personRender();
  assert.equal(backCount, 1);
  editable = false;
  personRender();
  assert.equal(personRow("Neighbors").props.disabled, true, "viewer cannot change classification");
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "common.done"),
    false,
  );
  currentAccount = "b";
  currentVault = "other";
  editable = true;
  personRender();
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "common.done"),
    false,
    "scope change hides write action",
  );
  personHooks.unmount();

  // Leaving with unsaved checks saves them, whichever way the user leaves.
  currentAccount = "a";
  currentVault = "v";
  editable = true;
  personId = "p";
  personState = { ...personState, groupsByPerson: { p: ["g"], q: ["h"] } };
  let mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  assert.equal(preventRemove, false, "nothing unsaved: leaving is not intercepted");
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(preventRemove, true, "unsaved checks intercept leaving");
  const writesBeforeBack = written.length;
  preventCallback!({ data: { action: { type: "GO_BACK" } } });
  await settleUI();
  assert.deepEqual(written.slice(writesBeforeBack), [["g", "h"]], "Back saves the checked groups");
  assert.equal(dispatched.length, 1, "and then leaves");
  mounted.unmount();

  // A group removed before Done drops out of the draft instead of sticking.
  personState = {
    ...personState,
    groups: personState.groups.slice(),
    groupsByPerson: { p: ["g"], q: ["h"] },
  };
  mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(preventRemove, true);
  personState = {
    ...personState,
    groups: personState.groups.filter((group) => group.id !== "h"),
  };
  personRender();
  assert.equal(preventRemove, false, "a removed group leaves the draft");
  mounted.unmount();

  // A failed save is shown, and the next Back may discard instead of trapping.
  personState = {
    ...personState,
    groups: [
      { id: "g", name: "Family", member_count: 1 },
      { id: "h", name: "Neighbors", member_count: 0 },
    ],
  };
  failSave = true;
  mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  personRow("Neighbors").props.onPress();
  personRender();
  preventCallback!({ data: { action: { type: "GO_BACK" } } });
  await settleUI();
  personRender();
  assert.ok(
    nodes(personTree()).some((n) => n.props.children === "entry.saveFailed"),
    "the failed save is visible",
  );
  assert.equal(preventRemove, false, "after a failed save, Back can leave");
  failSave = false;
  mounted.unmount();

  // Manage groups: Android keyboard avoidance (CLAUDE.md) and ref focus, not
  // autoFocus under the closing BottomSheet modal.
  const manageSource = readFileSync(require.resolve("../../app/groups.tsx"), "utf8");
  assert.ok(
    /behavior="height"\s+enabled=\{Platform\.OS === "android"\}/.test(manageSource),
    "Manage groups lifts the name field and Save above Android's keyboard",
  );
  assert.ok(manageSource.includes("automaticallyAdjustKeyboardInsets"), "iOS keyboard insets");
  assert.ok(
    !/^\s*autoFocus(=|\s*$)/m.test(manageSource),
    "group name focuses by ref after the sheet closes",
  );

  // Group members: who is in a group, and many customers in or out at once.
  {
    const hooks = uiHooks();
    let canAmend = true;
    const assignments: [string, string[]][] = [];
    let membersPrevent = false;
    let membersCallback: ((options: { data: { action: unknown } }) => void) | null = null;
    const membersDispatched: unknown[] = [];
    let membersBack = 0;
    const roster = [
      { id: "p1", name: "Zarif", phone: null },
      { id: "p2", name: "Ahmad 10", phone: "+93700000002" },
      { id: "p3", name: "Ahmad 2", phone: null },
    ];
    const groupState = {
      groups: [
        { id: "g", name: "Family", member_count: 1 },
        { id: "h", name: "Shop", member_count: 1 },
      ],
      groupByPerson: { p1: "g", p2: "h", p3: null },
      groupsByPerson: { p1: ["g"], p2: ["h"], p3: [] as string[] },
      loaded: true,
      failed: false,
    };
    const { default: GroupMembers } = compileUI("../../app/group-members.tsx", {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        useRouter: () => ({ back: () => membersBack++, push() {} }),
        useNavigation: () => ({ dispatch: (action: unknown) => membersDispatched.push(action) }),
        useLocalSearchParams: () => ({ vaultId: "v", groupId: "g" }),
        useFocusEffect: (fn: () => void) => hooks.react.useEffect(fn, [fn]),
      },
      "expo-router/react-navigation": {
        usePreventRemove: (prevent: boolean, callback: typeof membersCallback) => {
          membersPrevent = prevent;
          membersCallback = callback;
        },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        KeyboardAvoidingView: "KAV",
        Platform: { OS: "android" },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../components/Button": { Button: "Button" },
      "../components/SettingsScreen": { ScreenHeader: "Header" },
      "../lib/colors": { colors: {} },
      "../lib/contacts-merge": {
        splitSearchQuery: (q: string) => ({ first: q.trim(), last: "", phoneDigits: "" }),
      },
      "../lib/customer-groups": {
        assignCustomerGroups: async (_vault: string, personId: string, ids: string[]) => {
          assignments.push([personId, [...ids].sort()]);
        },
      },
      "../lib/customer-list": { compareCustomerNames },
      "../lib/db": { listAllPeopleForSearch: async () => roster },
      "../lib/db-tx": { getAccountIdSync: () => "a", getActiveVaultIdSyncMaybe: () => "v" },
      "../lib/bidi": { ltrIsolate: (value: string) => value },
      "../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../lib/fonts": { fonts: {} },
      "../lib/i18n": { t: (key: string) => key, getLocale: () => "en" },
      "../lib/search": { searchContacts },
      "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8 } },
      "../lib/use-customer-groups": { useCustomerGroups: () => groupState },
      "../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend }),
      },
    });
    const renderMembers = () => hooks.render(() => GroupMembers());
    const listed = () =>
      nodes(hooks.tree)
        .filter((n) => n.type === "Pressable" && typeof n.props.accessibilityLabel === "string")
        .map((n) => n.props.accessibilityLabel);
    const memberRow = (name: string) =>
      nodes(hooks.tree).find((n) => n.type === "Pressable" && n.props.accessibilityLabel === name)!;
    renderMembers();
    await settleUI();
    renderMembers();
    assert.deepEqual(
      listed(),
      ["Zarif", "Ahmad 2", "Ahmad 10"],
      "members first, then everyone else in number-aware name order",
    );
    assert.equal(memberRow("Zarif").props.accessibilityState.checked, true);
    memberRow("Ahmad 2").props.onPress();
    memberRow("Ahmad 10").props.onPress();
    renderMembers();
    memberRow("Zarif").props.onPress();
    renderMembers();
    assert.deepEqual(listed(), ["Zarif", "Ahmad 2", "Ahmad 10"], "ticking never reorders rows");
    assert.equal(membersPrevent, true, "unsaved ticks intercept leaving");
    nodes(hooks.tree)
      .find((n) => n.type === "Button")!
      .props.onPress();
    await settleUI();
    assert.deepEqual(
      assignments.sort((a, b) => a[0].localeCompare(b[0])),
      [
        ["p1", []],
        ["p2", ["g", "h"]],
        ["p3", ["g"]],
      ],
      "Done writes each changed customer's complete set, keeping their other groups",
    );
    assert.equal(membersBack + membersDispatched.length, 1, "and leaves once");
    nodes(hooks.tree)
      .find((n) => n.type === "TextInput")!
      .props.onChangeText("Ahmad");
    renderMembers();
    assert.deepEqual(listed(), ["Ahmad 2", "Ahmad 10"], "search narrows the roster");
    hooks.unmount();

    const viewerHooks = uiHooks();
    canAmend = false;
    const { default: ViewerMembers } = compileUI("../../app/group-members.tsx", {
      react: viewerHooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        useRouter: () => ({ back() {}, push() {} }),
        useNavigation: () => ({ dispatch() {} }),
        useLocalSearchParams: () => ({ vaultId: "v", groupId: "g" }),
        useFocusEffect: (fn: () => void) => viewerHooks.react.useEffect(fn, [fn]),
      },
      "expo-router/react-navigation": { usePreventRemove() {} },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        KeyboardAvoidingView: "KAV",
        Platform: { OS: "ios" },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../components/Button": { Button: "Button" },
      "../components/SettingsScreen": { ScreenHeader: "Header" },
      "../lib/colors": { colors: {} },
      "../lib/contacts-merge": {
        splitSearchQuery: (q: string) => ({ first: q.trim(), last: "", phoneDigits: "" }),
      },
      "../lib/customer-groups": { assignCustomerGroups: async () => assert.fail("viewer write") },
      "../lib/customer-list": { compareCustomerNames },
      "../lib/db": { listAllPeopleForSearch: async () => roster },
      "../lib/db-tx": { getAccountIdSync: () => "a", getActiveVaultIdSyncMaybe: () => "v" },
      "../lib/bidi": { ltrIsolate: (value: string) => value },
      "../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../lib/fonts": { fonts: {} },
      "../lib/i18n": { t: (key: string) => key, getLocale: () => "en" },
      "../lib/search": { searchContacts },
      "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8 } },
      "../lib/use-customer-groups": { useCustomerGroups: () => groupState },
      "../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend }),
      },
    });
    viewerHooks.render(() => ViewerMembers());
    await settleUI();
    viewerHooks.render(() => ViewerMembers());
    const viewerRows = nodes(viewerHooks.tree).filter(
      (n) => n.type === "Pressable" && typeof n.props.accessibilityLabel === "string",
    );
    assert.deepEqual(
      viewerRows.map((n) => n.props.accessibilityLabel),
      ["Zarif"],
      "a viewer sees who is in the group",
    );
    assert.ok(
      viewerRows.every((n) => n.props.disabled),
      "and cannot change it",
    );
    assert.equal(
      nodes(viewerHooks.tree).some((n) => n.type === "Button"),
      false,
      "no Done for a viewer",
    );
    viewerHooks.unmount();
  }
  console.log(
    "PASS real customer group multi-selection, explicit Done, route refresh, viewer and scope guards",
  );
}
