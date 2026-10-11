// Executes the actual sheet and scoped data hook. Native animation/timer frames
// are controlled so stopped callbacks can still be delivered adversarially.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { DEFAULT_CUSTOMER_LIST, CUSTOMER_SORTS } from "../customer-list";

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
      "../lib/customer-list": { CUSTOMER_SORTS },
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
  lateUnmount.resolve({ groups: [], groupByPerson: {} });
  await settleUI();
  assert.equal(dataHooks.lateWrites, 0);
  assert.equal(ledgerListeners.size, 0);
  console.log(
    "PASS real group hook scope-bound reads, live ledger refresh, late results and unmount cleanup",
  );
}
