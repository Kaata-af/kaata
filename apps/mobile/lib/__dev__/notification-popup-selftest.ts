// Real NotificationBell with controlled native measurement, motion, animation
// completion and portal/navigation timing. No server or notification is sent.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

function fixture() {
  const hooks = uiHooks();
  const motion = deferred<boolean>();
  const listeners = new Set<(value: boolean) => void>();
  const measures: ((...coords: number[]) => void)[] = [];
  const routes: any[] = [],
    opens: any[] = [],
    reads: any[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
  }
  const animations: {
    value: Value;
    opts: any;
    callback?: (result: { finished: boolean }) => void;
    stopped: boolean;
  }[] = [];
  const inbox = {
    page: { unread: 1, items: [], next_before: null },
    loading: false,
    failed: false,
    signedIn: true,
    reload: async () => {},
    read: async (id: any) => {
      reads.push(id);
    },
  };
  let dueCount = 0;
  const component = compileUI(
    "../../components/NotificationInbox",
    {
      "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      react: hooks.react,
      "react-native": {
        ActivityIndicator: "Spinner",
        Modal: "Modal",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (style: any) => style, absoluteFill: {} },
        useWindowDimensions: () => ({ height: 844 }),
        AccessibilityInfo: {
          isReduceMotionEnabled: () => motion.promise,
          addEventListener: (_: string, fn: (value: boolean) => void) => {
            listeners.add(fn);
            return { remove: () => listeners.delete(fn) };
          },
        },
        Animated: {
          Value,
          View: "AnimatedView",
          timing: (value: Value, opts: any) => {
            const item = { value, opts, stopped: false } as (typeof animations)[number];
            animations.push(item);
            return {
              start: (callback: any) => {
                item.callback = callback;
              },
              stop: () => {
                item.stopped = true;
                item.callback?.({ finished: false });
              },
            };
          },
        },
      },
      "expo-router": { router: { push: (route: any) => routes.push(route) } },
      "react-native-safe-area-context": {
        useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "../lib/colors": { colors: require("../colors").colors },
      "../lib/direction": { useIsRTL: () => false, rowDir: () => ({}), textDir: () => ({}) },
      "../lib/fonts": { fonts: {}, monoLineHeight: (_: number, line: number) => line },
      "../lib/format": { formatRelative: () => "now" },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/tokens": { TOUCH_MIN: 44, typography: {}, icon: { row: 22 }, radius: { lg: 16 } },
      "../lib/tabs/use-inbox": { useInbox: () => inbox },
      "../lib/tabs/open-notification": {
        openTabNotification: async (...args: any[]) => {
          opens.push(args);
        },
      },
      "../lib/use-customer-reminders": {
        useCustomerReminders: (_vault: any, _person: any, active = true) => {
          const due = active ? Array.from({ length: dueCount }, (_, id) => ({ id })) : [];
          return { due, rows: due };
        },
      },
      "./Toast": { useToast: () => ({ push() {} }) },
    },
    {
      setTimeout: (fn: () => void) => {
        timers.set(++nextTimer, fn);
        return nextTimer;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  function render() {
    hooks.render(() => component.NotificationBell());
    const anchor = nodes(hooks.tree).find((node) => node.props.collapsable === false)!;
    anchor.props.ref.current = {
      measureInWindow: (fn: (...coords: number[]) => void) => measures.push(fn),
    };
  }
  render();
  const find = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!;
  const label = (key: string) =>
    nodes(hooks.tree).find((node) => node.props.accessibilityLabel === key)!;
  // The label grows a due-reminders suffix when reminders are due.
  const bell = () =>
    nodes(hooks.tree).find(
      (node) =>
        typeof node.props.accessibilityLabel === "string" &&
        node.props.accessibilityLabel.startsWith("inbox.bell"),
    )!;
  return {
    hooks,
    motion,
    measures,
    routes,
    timers,
    animations,
    opens,
    reads,
    render,
    find,
    bell,
    due: (count: number, active = true) => {
      dueCount = count;
      return component.DueRemindersShortcut({ active, onPress: () => routes.push("/reminders") });
    },
    top: () =>
      flattenStyle(
        nodes(hooks.tree).find((node) => node.props.accessibilityViewIsModal)!.props.style,
      ).top,
    measure: (y = 100) => {
      measures.shift()!(0, y, 44, 44);
      render();
    },
    open: () => {
      bell().props.onPress();
      render();
    },
    close: () => {
      find("Modal").props.onRequestClose();
      render();
    },
    event: (value: boolean) => listeners.forEach((fn) => fn(value)),
    finish: (item = animations.at(-1)!, force = false) => {
      if (!item.stopped || force) {
        item.value.setValue(item.opts.toValue);
        item.callback?.({ finished: true });
      }
      render();
    },
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach((fn) => fn());
      render();
    },
    seeAll: () => {
      nodes(hooks.tree)
        .find(
          (node) =>
            node.type === "Pressable" &&
            nodes(node).some((child) => child.props.children === "inbox.seeAll"),
        )!
        .props.onPress();
      render();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

async function main() {
  const normal = fixture();
  normal.motion.resolve(false);
  await settleUI();
  normal.open();
  normal.measure(120);
  assert.equal(normal.top(), 170);
  assert.equal(normal.find("Modal").props.visible, true);
  normal.finish();
  normal.close();
  assert.equal(
    normal.top(),
    170,
    "closing keeps measured placement while native portal is visible",
  );
  assert.equal(normal.find("Modal").props.visible, true, "fade completes before portal dismisses");
  assert.equal(
    normal.find("AnimatedView").props.pointerEvents,
    "none",
    "closing controls cannot queue another action",
  );
  normal.finish();
  assert.equal(normal.find("Modal").props.visible, false);
  assert.equal(normal.top(), 170, "last native dismissal frame cannot jump to safe-area top");
  assert.equal(
    normal.animations.every((item) => item.opts.useNativeDriver),
    true,
  );

  // A stopped animation can still deliver its completion through the bridge.
  normal.open();
  normal.measure();
  normal.close();
  const oldClose = normal.animations.at(-1)!;
  normal.open();
  normal.measure(220);
  normal.finish(oldClose, true);
  assert.equal(
    normal.find("Modal").props.visible,
    true,
    "old close callback cannot dismiss a new opening",
  );
  assert.equal(normal.top(), 270);
  normal.close();
  normal.finish();

  // Out-of-order measurement, close-before-measure and unmount are common
  // during rapid taps/navigation. Only the current open request may paint.
  const pending = fixture();
  pending.open();
  const oldMeasure = pending.measures.shift()!;
  pending.open();
  pending.measure(210);
  oldMeasure(0, 10, 44, 44);
  pending.render();
  assert.equal(pending.top(), 260);
  pending.close();
  pending.open();
  const lateMeasure = pending.measures.shift()!;
  pending.close();
  lateMeasure(0, 300, 44, 44);
  pending.render();
  assert.equal(pending.find("Modal").props.visible, false);
  pending.open();
  const unmountedMeasure = pending.measures.shift()!;
  pending.hooks.unmount();
  unmountedMeasure(0, 300, 44, 44);
  pending.motion.resolve(false);
  await settleUI();
  assert.equal(pending.hooks.lateWrites, 0);
  assert.equal(pending.listenerCount, 0);

  const reduced = fixture();
  reduced.event(true);
  reduced.motion.resolve(false);
  await settleUI();
  reduced.open();
  reduced.measure();
  reduced.close();
  assert.equal(reduced.animations.length, 0, "new motion event wins over older bridge query");
  assert.equal(reduced.find("Modal").props.visible, false);
  assert.equal(reduced.top(), 150);
  reduced.event(false);
  reduced.open();
  reduced.measure();
  reduced.close();
  reduced.event(true);
  reduced.render();
  assert.equal(
    reduced.find("Modal").props.visible,
    false,
    "enabling reduced motion completes a running close immediately",
  );

  const nav = fixture();
  nav.motion.resolve(true);
  await settleUI();
  assert.equal(nav.due(0), null, "due shortcut stays quiet when there are no tasks");
  const dueShortcut = nav.due(2);
  assert.ok(dueShortcut && dueShortcut.props.accessibilityLabel === "reminders.dueShortcut");
  assert.equal(
    nav.due(2, false),
    null,
    "closing/hidden dropdown cannot retain a live private shortcut",
  );
  nav.open();
  nav.measure();
  nav.seeAll();
  nav.seeAll();
  assert.equal(nav.timers.size, 1, "double action queues one navigation");
  assert.deepEqual(nav.routes, []);
  nav.flushTimers();
  assert.deepEqual(nav.routes, ["/notifications"]);
  nav.open();
  nav.measure();
  nav.seeAll();
  nav.open();
  nav.measure();
  nav.flushTimers();
  assert.equal(nav.routes.length, 1, "reopening cancels pending navigation");
  nav.seeAll();
  nav.flushTimers();
  // Due reminders count on the bell (they used to be invisible until the
  // dropdown opened), and the dropdown's row takes the bell's count, so it no
  // longer pops in after opening or vanishes as the fade begins.
  nav.due(2);
  nav.render();
  const badge = nodes(nav.bell()).find(
    (node) => node.type === "Text" && node.props.allowFontScaling === false,
  )!;
  assert.equal(badge.props.children, 3, "1 unread notice + 2 due reminders on the badge");
  assert.ok(nav.bell().props.accessibilityLabel.includes("reminders.dueShortcut"));
  const rowCount = () =>
    nodes(nav.hooks.tree).find((node) => "dueReminders" in node.props)?.props.dueReminders;
  nav.open();
  nav.measure();
  assert.equal(rowCount(), 2, "the open dropdown shows the bell's due count");
  assert.equal(
    nodes(nav.hooks.tree).find((node) => "hasReminders" in node.props)?.props.hasReminders,
    true,
    "any reminder at all makes the row the way into the full list (audit #25)",
  );
  nav.close();
  assert.equal(rowCount(), 2, "the row keeps its count while the panel fades out");
  nav.seeAll();
  nav.hooks.unmount();
  assert.equal(nav.timers.size, 0, "unmount cancels pending navigation");
  assert.equal(nav.hooks.lateWrites, 0);
  normal.hooks.unmount();
  reduced.hooks.unmount();
  console.log(
    "PASS: notification dropdown keeps placement through dismissal; reduced motion, stale measurements/completions, rapid reopening, navigation and unmount guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
