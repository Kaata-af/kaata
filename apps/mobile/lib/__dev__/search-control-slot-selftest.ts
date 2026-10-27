// Execute the real search-control slot with a controlled animation boundary.
// Native frame smoothness and TextInput focus still require phone/screen checks.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

type Props = {
  visible: boolean;
  width: number;
  height: number;
  collapse?: boolean;
  animate?: boolean;
  gap?: number;
  isRTL?: boolean;
  style?: unknown;
  children: unknown;
};

function fixture(initial: Partial<Props> = {}, initialReducedMotion = false) {
  const hooks = uiHooks();
  let reducedMotion = initialReducedMotion;
  const child = jsx("Control", { accessibilityLabel: "Clear search" });
  const renderedStyles: any[] = [];
  const slotJsx: typeof jsx = (type, props) => {
    if (type === "AnimatedView") renderedStyles.push(flattenStyle(props.style));
    return jsx(type, props);
  };
  let props: Props = { visible: false, width: 44, height: 44, children: child, ...initial };
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
    interpolate(options: { inputRange: number[]; outputRange: number[] }) {
      return {
        read: () => {
          const [from, to] = options.inputRange;
          const [start, end] = options.outputRange;
          return start + ((this.value - from) / (to - from)) * (end - start);
        },
      };
    }
  }
  const animations: {
    target: number;
    stopped: boolean;
    running: boolean;
    step: (fraction: number) => void;
    stop: () => void;
  }[] = [];
  const component = compileUI("../../components/SearchControlSlot", {
    react: hooks.react,
    "react/jsx-runtime": { jsx: slotJsx, jsxs: slotJsx },
    "./SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
    "react-native": {
      View: "View",
      Easing: { cubic: (value: number) => value ** 3, out: (fn: unknown) => fn },
      Animated: {
        Value,
        View: "AnimatedView",
        timing: (value: Value, options: { toValue: number }) => {
          const start = value.value;
          const animation = {
            target: options.toValue,
            stopped: false,
            running: false,
            step(fraction: number) {
              // A stopped native animation cannot deliver later frames.
              if (this.stopped || !this.running) return;
              value.setValue(start + (this.target - start) * fraction);
              if (fraction === 1) this.running = false;
            },
            stop() {
              this.stopped = true;
              this.running = false;
            },
          };
          animations.push(animation);
          return {
            start: () => (animation.running = true),
            stop: () => animation.stop(),
          };
        },
      },
    },
  });
  const render = (next: Partial<Props> = {}) => {
    props = { ...props, ...next };
    return hooks.render(() => component.SearchControlSlot(props));
  };
  const number = (value: any) =>
    typeof value === "number" ? value : value instanceof Value ? value.value : value.read();
  const style = () => flattenStyle(hooks.tree.props.style);
  render();
  return {
    hooks,
    child,
    render,
    style,
    animations,
    renderedStyles,
    number,
    opacity: () => number(style().opacity),
    setMotion: (value: boolean) => {
      reducedMotion = value;
      render();
    },
  };
}

function hidden(tree: ReturnType<typeof jsx>) {
  assert.equal(tree.props.pointerEvents, "none", "hidden controls cannot intercept taps");
  assert.equal(tree.props.accessibilityElementsHidden, true, "VoiceOver skips hidden controls");
  assert.equal(
    tree.props.importantForAccessibility,
    "no-hide-descendants",
    "TalkBack skips the entire hidden control subtree",
  );
  assert.equal(
    nodes(tree).some((node) => node.type === "Control"),
    false,
  );
}

// Fixed slots reserve Clear's space: a query appearing/clearing cannot make
// the input change its width. Collapsed action slots consume no orphan gap.
for (const isRTL of [false, true]) {
  const reserved = fixture({ isRTL }, true);
  hidden(reserved.hooks.tree);
  assert.equal(reserved.number(reserved.style().width), 44);
  assert.equal(reserved.style().height, 44);
  const tree = reserved.render({ visible: true });
  assert.equal(tree.props.pointerEvents, "auto");
  assert.equal(tree.props.accessibilityElementsHidden, false);
  assert.notEqual(tree.props.importantForAccessibility, "no-hide-descendants");
  assert.equal(reserved.number(reserved.style().width), 44);
  assert.equal(
    nodes(tree).find((node) => node.type === "Control"),
    reserved.child,
  );
  reserved.render({ visible: false });
  hidden(reserved.hooks.tree);
  assert.equal(reserved.number(reserved.style().width), 44);
  reserved.hooks.unmount();

  const collapsed = fixture({ collapse: true, gap: 8, isRTL }, true);
  const contribution = () => {
    const style = collapsed.style();
    return collapsed.number(style.width) + (style.marginLeft ?? 0) + (style.marginRight ?? 0) + 8;
  };
  assert.equal(contribution(), 0, "an empty slot and its parent gap occupy no space");
  collapsed.render({ visible: true });
  assert.equal(contribution(), 52, "the shown control gains its width and exactly one gap");
  assert.equal(collapsed.style().height, 44, "search controls never change the row's height");
  const inner = nodes(collapsed.hooks.tree).find((node) => node.type === "View")!;
  assert.equal(flattenStyle(inner.props.style).width, 44, "child control keeps its touch width");
  collapsed.render({ width: 48 });
  assert.equal(contribution(), 56, "layout width changes do not require remounting the slot");
  collapsed.render({ visible: false });
  assert.equal(contribution(), 0);
  collapsed.hooks.unmount();
}

// A keyboard-owned transition can opt out of local timing. The committed
// render already has the final size/opacity, before effects sync its progress.
for (const isRTL of [false, true]) {
  const immediate = fixture({ collapse: true, gap: 8, isRTL, animate: false });
  const assertImmediate = (visible: boolean, width = 44) => {
    const style = immediate.renderedStyles.at(-1)!;
    assert.equal(typeof style.width, "number", "immediate width is resolved during render");
    assert.equal(typeof style.opacity, "number", "immediate opacity is resolved during render");
    assert.equal(style.width, visible ? width + 8 : 0);
    assert.equal(style.opacity, visible ? 1 : 0);
    assert.equal(style.height, 44);
    assert.equal(style.alignItems, isRTL ? "flex-start" : "flex-end");
    assert.equal(style[isRTL ? "marginRight" : "marginLeft"], -8);
    assert.equal(style[isRTL ? "marginLeft" : "marginRight"], undefined);
    assert.equal(immediate.animations.length, 0, "opting out creates no timed frames");
  };
  hidden(immediate.hooks.tree);
  assertImmediate(false);
  const shown = immediate.render({ visible: true });
  assertImmediate(true);
  assert.equal(shown.props.pointerEvents, "auto");
  assert.equal(shown.props.accessibilityElementsHidden, false);
  assert.equal(
    nodes(shown).find((node) => node.type === "Control"),
    immediate.child,
  );
  immediate.render({ width: 48 });
  assertImmediate(true, 48);
  immediate.render({ visible: false });
  hidden(immediate.hooks.tree);
  assertImmediate(false, 48);
  immediate.hooks.unmount();

  const reserved = fixture({ isRTL, animate: false });
  assert.equal(reserved.style().width, 44);
  reserved.render({ visible: true });
  assert.equal(reserved.style().width, 44);
  assert.equal(reserved.style().opacity, 1);
  reserved.render({ visible: false });
  hidden(reserved.hooks.tree);
  assert.equal(reserved.style().width, 44, "fixed slots keep their reserved width without timing");
  assert.equal(reserved.style().opacity, 0);
  assert.equal(reserved.animations.length, 0);
  reserved.hooks.unmount();
}

// Switching off timing stops a partly completed animation, settles either
// requested state immediately, and seeds later default animation from there.
for (const isRTL of [false, true]) {
  for (const visible of [false, true]) {
    const switched = fixture({ collapse: true, gap: 8, isRTL });
    switched.animations.at(-1)!.step(1);
    switched.render({ visible: true });
    const moving = switched.animations.at(-1)!;
    moving.step(0.4);
    assert.ok(switched.opacity() > 0 && switched.opacity() < 1);
    const beforeSwitch = switched.animations.length;
    switched.render({ visible, animate: false });
    assert.equal(moving.stopped, true, "disabling timing cancels the active animation");
    assert.equal(switched.animations.length, beforeSwitch);
    assert.equal(switched.style().opacity, visible ? 1 : 0);
    assert.equal(switched.style().width, visible ? 52 : 0);
    if (!visible) hidden(switched.hooks.tree);
    moving.step(1);
    assert.equal(switched.style().opacity, visible ? 1 : 0);
    assert.equal(switched.style().width, visible ? 52 : 0, "stale frames cannot resize the slot");

    switched.render({ visible: !visible, animate: undefined });
    const resumed = switched.animations.at(-1)!;
    assert.equal(
      switched.animations.length,
      beforeSwitch + 1,
      "omitting animate restores its default timing",
    );
    assert.equal(resumed.running, true);
    assert.equal(resumed.target, visible ? 0 : 1);
    assert.equal(
      switched.opacity(),
      visible ? 1 : 0,
      "resumed motion starts at the synced immediate state",
    );
    resumed.step(0.5);
    assert.equal(switched.opacity(), 0.5);
    assert.equal(switched.number(switched.style().width), 26);
    moving.step(1);
    assert.equal(switched.opacity(), 0.5, "old frames cannot affect resumed motion");
    resumed.step(1);
    assert.equal(switched.opacity(), visible ? 0 : 1);
    assert.equal(switched.number(switched.style().width), visible ? 0 : 52);
    switched.hooks.unmount();
  }
}

// A hide cancels an in-flight entrance; reopening cancels the exit. Old
// animation completions cannot shrink a reopened control or erase its opacity.
const interrupted = fixture({ collapse: true, gap: 8 });
interrupted.animations.at(-1)!.step(1);
interrupted.render({ visible: true });
const enter = interrupted.animations.at(-1)!;
enter.step(0.4);
assert.ok(interrupted.opacity() > 0 && interrupted.opacity() < 1);
const progress = interrupted.style().opacity;
interrupted.render({ visible: false });
const exit = interrupted.animations.at(-1)!;
assert.equal(enter.stopped, true, "hiding stops the old entrance");
hidden(interrupted.hooks.tree);
exit.step(0.5);
const beforeReopen = interrupted.opacity();
interrupted.render({ visible: true });
const reopen = interrupted.animations.at(-1)!;
assert.equal(exit.stopped, true, "reopening stops the old exit");
assert.equal(interrupted.opacity(), beforeReopen, "reopen continues from the displayed position");
assert.equal(interrupted.style().opacity, progress, "the slot keeps its animation identity");
enter.step(1);
exit.step(1);
assert.equal(
  interrupted.opacity(),
  beforeReopen,
  "canceled frames cannot override the new entrance",
);
reopen.step(1);
assert.equal(interrupted.opacity(), 1);
assert.equal(interrupted.number(interrupted.style().width), 52);
interrupted.render({ visible: true, children: interrupted.child });
assert.equal(
  nodes(interrupted.hooks.tree).find((node) => node.type === "Control"),
  interrupted.child,
);
assert.equal(interrupted.animations.at(-1), reopen, "unrelated rerenders do not restart motion");

// Toggling Reduce Motion during an animation cancels it and reaches the
// requested state synchronously, including future show/hide transitions.
interrupted.render({ visible: false });
const moving = interrupted.animations.at(-1)!;
moving.step(0.3);
const animationCount = interrupted.animations.length;
interrupted.setMotion(true);
assert.equal(moving.stopped, true);
assert.equal(interrupted.opacity(), 0);
assert.equal(interrupted.number(interrupted.style().width), 0);
assert.equal(
  interrupted.animations.length,
  animationCount,
  "Reduce Motion creates no timed animation",
);
interrupted.render({ visible: true });
assert.equal(interrupted.opacity(), 1);
assert.equal(interrupted.number(interrupted.style().width), 52);
assert.equal(interrupted.animations.length, animationCount);
moving.step(1);
assert.equal(interrupted.opacity(), 1, "old motion cannot undo the accessibility choice");
interrupted.render({ visible: false });
hidden(interrupted.hooks.tree);
assert.equal(interrupted.opacity(), 0);
assert.equal(interrupted.animations.length, animationCount);

// Leaving the screen while it is revealing the controls stops all owned
// work, including a possible last native frame after unmount.
interrupted.setMotion(false);
interrupted.render({ visible: true });
const unmounting = interrupted.animations.at(-1)!;
unmounting.step(0.25);
const finalProgress = interrupted.opacity();
interrupted.hooks.unmount();
assert.equal(unmounting.stopped, true);
assert.equal(
  interrupted.animations.some((animation) => animation.running),
  false,
);
unmounting.step(1);
assert.equal(interrupted.opacity(), finalProgress);
assert.equal(interrupted.hooks.lateWrites, 0);

console.log(
  "PASS: search control slots reserve/collapse gaps in LTR/RTL, hide touch/accessibility, keep control identity, cancel interrupted/unmounted motion, render immediate animate=false states, resume default timing and honor Reduce Motion instantly",
);
