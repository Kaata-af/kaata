import assert from "node:assert/strict";
import type { CustomerBalanceFilter } from "../customer-list";
import { compileUI, flattenStyle, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";

type Swipe = {
  translationX: number;
  translationY: number;
  velocityX: number;
};
type Pan = {
  config: Record<string, unknown>;
  begin: () => void;
  end: (event: Swipe, success?: boolean) => void;
  finalize: () => void;
};
function fixture() {
  const hooks = uiHooks();
  let width = 390;
  const changes: CustomerBalanceFilter[] = [];
  const child = jsx("CustomerContent", { children: "list or empty state" });
  let props = {
    enabled: true,
    contextKey: "account:kaata:request-1",
    direction: "all" as CustomerBalanceFilter,
    onDirectionChange: (direction: CustomerBalanceFilter) => changes.push(direction),
    style: undefined as Record<string, unknown> | undefined,
    testID: undefined as string | undefined,
    children: child,
  };
  const { HomeBalanceFilterSwipe } = compileUI("../../components/HomeBalanceFilterSwipe", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View",
      StyleSheet: { create: (value: unknown) => value },
      useWindowDimensions: () => ({ width }),
    },
    "react-native-gesture-handler": {
      GestureDetector: "GestureDetector",
      Gesture: {
        Pan: () => {
          const pan: any = { config: {} };
          for (const key of ["enabled", "activeOffsetX", "failOffsetY", "runOnJS"])
            pan[key] = (value: unknown) => {
              pan.config[key] = value;
              return pan;
            };
          for (const [method, handler] of [
            ["onBegin", "begin"],
            ["onEnd", "end"],
            ["onFinalize", "finalize"],
          ])
            pan[method] = (callback: unknown) => {
              pan[handler] = callback;
              return pan;
            };
          return pan;
        },
      },
    },
  });
  const render = () => hooks.render(() => HomeBalanceFilterSwipe(props));
  const gesture = (): Pan => hooks.tree.props.gesture;
  const swipe = (x: number, velocity = 0, y = 0, success = true) => {
    const pan = gesture();
    pan.begin();
    pan.end({ translationX: x, translationY: y, velocityX: velocity }, success);
    pan.finalize();
  };
  render();
  return {
    hooks,
    changes,
    child,
    gesture,
    swipe,
    update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      render();
    },
    resize(value: number) {
      width = value;
      render();
    },
  };
}

for (const direction of ["all", "collect", "pay"] as const) {
  const f = fixture();
  f.update({ direction });
  f.swipe(-117);
  f.swipe(117);
  assert.deepEqual(f.changes, [
    direction === "pay" ? "all" : "pay",
    direction === "collect" ? "all" : "collect",
  ]);
  assert.deepEqual(f.gesture().config, {
    enabled: true,
    activeOffsetX: [-24, 24],
    failOffsetY: [-16, 16],
    runOnJS: true,
  });
  const wrapper = nodes(f.hooks.tree).find((node) => node.type === "View")!;
  assert.equal(wrapper.props.collapsable, false, "Gesture host remains a real native view");
  assert.equal(wrapper.props.children, f.child, "The same customer content stays mounted");
  assert.deepEqual(flattenStyle(wrapper.props.style), { flexGrow: 1, minHeight: 0 });
  assert.ok(!nodes(f.hooks.tree).some((node: UINode) => /ScrollView|Animated/.test(node.type)));
  f.update({ testID: "home-customer-content", style: { paddingTop: 12 } });
  const styledWrapper = nodes(f.hooks.tree).find((node) => node.type === "View")!;
  assert.equal(styledWrapper.props.testID, "home-customer-content");
  assert.equal(flattenStyle(styledWrapper.props.style).paddingTop, 12);
}

{
  const f = fixture();
  f.swipe(-116);
  f.swipe(116);
  f.swipe(-23, -1000);
  f.swipe(23, 1000);
  f.swipe(24, 499);
  f.swipe(24, -1000);
  f.swipe(130, 0, 131);
  f.swipe(130, 0, 130);
  f.swipe(130, 0, 0, false);
  f.swipe(Number.NaN);
  f.swipe(130, Number.POSITIVE_INFINITY);
  f.swipe(130, 0, Number.NaN);
  assert.deepEqual(
    f.changes,
    [],
    "Short, vertical, reversed flicks, failed and invalid events do nothing",
  );
  f.swipe(-24, -500);
  f.swipe(24, 500);
  f.swipe(117, -1000);
  assert.deepEqual(
    f.changes,
    ["pay", "collect", "collect"],
    "Qualified flicks and distance use physical direction",
  );
}

// Captured native callbacks must not change a different scope or a newer choice,
// including an ABA change that returns to the original props before release.
for (const change of [
  { enabled: false },
  { contextKey: "another-account:kaata:request-2" },
  { direction: "pay" as const },
]) {
  const f = fixture();
  const old = f.gesture();
  old.begin();
  f.update(change);
  old.end({ translationX: -150, translationY: 0, velocityX: -600 });
  f.update({ enabled: true, contextKey: "account:kaata:request-1", direction: "all" });
  old.end({ translationX: -150, translationY: 0, velocityX: -600 });
  old.begin();
  old.end({ translationX: -150, translationY: 0, velocityX: -600 });
  assert.deepEqual(
    f.changes,
    [],
    "Old begin/end callbacks cannot outlive their enabled, scope or direction epoch",
  );
  f.swipe(-150);
  assert.deepEqual(f.changes, ["pay"]);
}

{
  const f = fixture();
  f.update({ enabled: false });
  assert.equal(f.gesture().config.enabled, false, "Disabled native gesture does not claim touches");
  f.swipe(-150, -1000);
  assert.deepEqual(f.changes, []);
  f.update({ enabled: true });
  const old = f.gesture();
  old.begin();
  f.resize(844);
  old.end({ translationX: -150, translationY: 0, velocityX: -600 });
  f.swipe(-150);
  assert.deepEqual(f.changes, [], "Rotation invalidates old events and uses the current width");
  f.swipe(-254);
  assert.deepEqual(f.changes, ["pay"]);
  f.resize(0);
  f.swipe(-150, -1000);
  f.resize(Number.NaN);
  f.swipe(-150, -1000);
  assert.deepEqual(f.changes, ["pay"], "Unknown viewport widths do not commit");
}

{
  const f = fixture();
  const pan = f.gesture();
  const event = { translationX: 150, translationY: 0, velocityX: 600 };
  pan.end(event);
  assert.deepEqual(f.changes, [], "An end callback without begin is ignored");
  pan.begin();
  pan.finalize();
  pan.end(event);
  assert.deepEqual(f.changes, [], "Cancelled gestures cannot commit later");
  pan.begin();
  pan.end(event);
  pan.end(event);
  assert.deepEqual(f.changes, ["collect"], "Duplicate completion commits only once");
  pan.begin();
  f.hooks.unmount();
  pan.end(event);
  pan.begin();
  pan.end(event);
  assert.deepEqual(f.changes, ["collect"], "Unmounted gestures cannot change the list");
  assert.equal(f.hooks.lateWrites, 0);
}

console.log(
  "PASS list-only balance-filter swipes, direction toggling, drag/flick thresholds, vertical scroll coexistence and stale native callback guards",
);
