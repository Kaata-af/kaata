// Execute the real cue against a shared motion policy and controlled time.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, uiHooks } from "./ui-fixture";

type Timer = { at: number; fn: () => void; cancelled: boolean };
function fixture(initialReduced = false) {
  const hooks = uiHooks();
  let reduced = initialReduced;
  let clock = 0,
    nextTimer = 0;
  let props = { requestKey: "first", tone: "neutral" };
  const timers = new Map<number, Timer>();
  const animations: { opts: any; stopped: boolean }[] = [];
  class Value {
    writes: number[] = [];
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
      this.writes.push(value);
    }
  }
  const { TallyHighlight } = compileUI(
    "../../components/TallyHighlight",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx },
      "./SheetBackdrop": { useSheetMotionPreference: () => reduced },
      "../lib/colors": {
        colors: { tallyHighlight: "gray", reviewAccepted: "green", reviewRejected: "red" },
      },
      "react-native": {
        Animated: {
          View: "AnimatedView",
          Value,
          timing: (_: Value, opts: any) => {
            const animation = { opts, stopped: false };
            animations.push(animation);
            return {
              start() {},
              stop() {
                animation.stopped = true;
              },
            };
          },
        },
        StyleSheet: { absoluteFill: { position: "absolute" } },
      },
    },
    {
      Date: { now: () => clock },
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++nextTimer;
        timers.set(id, { at: clock + ms, fn, cancelled: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const timer = timers.get(id);
        if (timer) timer.cancelled = true;
      },
    },
  );
  const render = (next = props) => {
    props = next;
    return hooks.render(() => TallyHighlight(props));
  };
  const value = () => flattenStyle(hooks.tree.props.style).opacity as Value;
  return {
    hooks,
    animations,
    timers,
    render,
    value,
    policy(next: boolean) {
      reduced = next;
      render();
    },
    advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        const timer = [...timers.values()]
          .filter((t) => !t.cancelled && t.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        timer.cancelled = true;
        clock = timer.at;
        timer.fn();
      }
      clock = end;
    },
  };
}

const normal = fixture();
const tree = normal.render();
assert.equal(tree.props.pointerEvents, "none");
assert.equal(tree.props.accessible, false);
assert.equal(flattenStyle(tree.props.style).backgroundColor, "gray");
assert.equal(normal.value().value, 0.4);
assert.deepEqual(normal.animations[0].opts, {
  toValue: 0,
  duration: 1200,
  delay: 300,
  useNativeDriver: true,
});
normal.render();
assert.equal(normal.animations.length, 1, "Unrelated renders do not replay notification cues");
normal.advance(1500);
assert.equal(normal.value().value, 0);
normal.policy(true);
normal.policy(false);
assert.equal(normal.value().value, 0, "Policy changes cannot replay expired cues");
assert.equal(normal.animations.length, 1);
normal.hooks.unmount();

const reduced = fixture(true);
reduced.render({ requestKey: "accepted", tone: "accepted" });
assert.equal(flattenStyle(reduced.hooks.tree.props.style).backgroundColor, "green");
assert.equal(reduced.value().value, 0.22, "Review decisions retain their static outcome cue");
assert.equal(reduced.animations.length, 0);
reduced.advance(1499);
assert.equal(reduced.value().value, 0.22);
reduced.advance(1);
assert.equal(reduced.value().value, 0);
reduced.hooks.unmount();

const toggled = fixture();
toggled.render();
toggled.advance(700);
toggled.policy(true);
assert.equal(toggled.animations[0].stopped, true, "Enabling reduced motion stops an active fade");
toggled.advance(300);
toggled.policy(false);
assert.equal(toggled.animations[1].opts.delay + toggled.animations[1].opts.duration, 500);
toggled.advance(500);
assert.equal(toggled.value().value, 0, "Policy changes preserve the first 1.5-second deadline");
toggled.hooks.unmount();

const replaced = fixture();
replaced.render();
const oldTimer = [...replaced.timers.values()][0];
replaced.advance(500);
replaced.render({ requestKey: "replacement", tone: "rejected" });
assert.equal(replaced.animations[0].stopped, true);
assert.equal(oldTimer.cancelled, true);
const writes = replaced.value().writes.length;
oldTimer.fn();
assert.equal(
  replaced.value().writes.length,
  writes,
  "Already queued old timers cannot erase a new cue",
);
assert.equal(flattenStyle(replaced.hooks.tree.props.style).backgroundColor, "red");
replaced.hooks.unmount();
const unmountedWrites = replaced.value().writes.length;
replaced.advance(2000);
assert.equal(replaced.value().writes.length, unmountedWrites);
assert.ok([...replaced.timers.values()].every((t) => t.cancelled));
assert.ok(replaced.animations.every((t) => t.stopped));
console.log(
  "PASS tally cues: shared motion policy, static review feedback, fixed lifetime, interrupted fades, replacement and unmount guards",
);
