// Execute the real hook with controlled native animation replies. Actual finger
// tracking/responder transfer and native keyboard pixels still need phones.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const hooks = uiHooks();
let reducedMotion = false,
  deferStop = false,
  keyboardDismisses = 0;
const nativeReplies: (() => void)[] = [];
const springs: { toValue: number; useNativeDriver: boolean; stopped: boolean }[] = [];
class Value {
  motion?: (typeof springs)[number];
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
  }
  stopAnimation(callback?: (value: number) => void) {
    if (this.motion) this.motion.stopped = true;
    if (!callback) return;
    const stoppedAt = this.value;
    if (deferStop) nativeReplies.push(() => callback(stoppedAt));
    else callback(stoppedAt);
  }
}
const module = compileUI("../use-sheet-drag", {
  react: hooks.react,
  "../components/SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
  "react-native": {
    Keyboard: { dismiss: () => keyboardDismisses++ },
    PanResponder: { create: (callbacks: any) => ({ panHandlers: callbacks }) },
    Animated: {
      Value,
      add: (left: Value, right: Value) => ({ left, right }),
      spring: (value: Value, config: any) => ({
        start: () => {
          const motion = { ...config, stopped: false };
          springs.push(motion);
          value.motion = motion;
        },
      }),
    },
  },
});
let dismissed = 0,
  freshDismissed = 0;
const props = { visible: true, onDismiss: () => dismissed++ };
const entrance = new Value(0);
const render = () =>
  hooks.render(() => ({
    type: "Hook",
    props: module.useSheetDrag(props.visible, entrance, props.onDismiss),
  })).props;
let drag = render();
const offset = drag.translateY.right as Value;
assert.equal(drag.translateY.left, entrance, "drag composes with the existing modal animation");
// RN's PanResponder reuses its instance's stateID across strokes; asynchronous
// native replies must be guarded by stroke identity, not a changing test ID.
const state = (_id: number, dy: number, vy = 0, dx = 0, touches = 1) => ({
  stateID: 1,
  dy,
  vy,
  dx,
  numberActiveTouches: touches,
});
const begin = (id: number) => {
  assert.equal(drag.panHandlers.onMoveShouldSetPanResponderCapture({}, state(id, 10)), true);
  drag.panHandlers.onPanResponderGrant({}, state(id, 0));
};
const move = (id: number, dy: number, touches = 1) =>
  drag.panHandlers.onPanResponderMove({}, state(id, dy, 0, 0, touches));
const release = (id: number, dy: number, vy = 0) =>
  drag.panHandlers.onPanResponderRelease({}, state(id, dy, vy, 0, 0));
const reopen = () => {
  props.visible = false;
  drag = render();
  props.visible = true;
  drag = render();
  assert.equal(offset.value, 0, "reopened sheets reset the drag offset");
};
const flushNative = () => nativeReplies.splice(0).forEach((reply) => reply());

assert.equal(drag.panHandlers.onStartShouldSetPanResponder(), false, "taps remain Pressable taps");
for (const gesture of [state(1, -30), state(1, 3), state(1, 10, 0, 30), state(1, 20, 0, 0, 2)])
  assert.equal(drag.panHandlers.onMoveShouldSetPanResponderCapture({}, gesture), false);
begin(2);
move(2, 30);
assert.equal(offset.value, 30, "the panel follows the handle's downward movement");
release(2, 30);
assert.equal(dismissed, 0, "a short drag does not dismiss");
assert.equal(springs.at(-1)?.toValue, 0);
assert.equal(springs.at(-1)?.useNativeDriver, true);
offset.setValue(0);
begin(3);
move(3, 100);
drag.panHandlers.onPanResponderTerminate({}, state(3, 100));
release(3, 100);
assert.equal(dismissed, 0, "cancelled drags spring back even after a long pull");
offset.setValue(0);
begin(4);
move(4, -12);
assert.equal(offset.value, 0, "the handle cannot pull a sheet above its open position");
release(4, -12);
begin(5);
move(5, 90, 2);
release(5, 90);
assert.equal(dismissed, 0, "a second finger cancels the close gesture");
offset.setValue(0);
begin(6);
move(6, 12);
release(6, 12, 3);
assert.equal(dismissed, 0, "a tiny accidental flick doesn't close a sheet");
offset.setValue(0);
begin(7);
move(7, 24);
release(7, 24, 1);
assert.equal(dismissed, 1, "a deliberate downward flick closes");
assert.equal(
  offset.value,
  24,
  "closing keeps the finger's position for the existing exit animation",
);
drag.dismiss();
release(7, 90);
assert.equal(dismissed, 1, "gesture, handle and Back dismissals coalesce");
reopen();
begin(8);
move(8, 75);
release(8, 75);
assert.equal(dismissed, 2, "a slow long drag also closes");

reopen();
begin(9);
move(9, 20);
release(9, 20);
offset.setValue(16); // native spring is partway home when the user grabs again
deferStop = true;
begin(10);
move(10, 8);
assert.equal(offset.value, 16, "buffer movement while reading the stopped native position");
flushNative();
assert.equal(offset.value, 24, "re-grabbing continues from the actual position without a jump");
release(10, 8);
offset.setValue(80);
begin(16);
move(16, -60);
flushNative();
release(16, -60);
assert.equal(offset.value, 20, "a re-grab can pull an interrupted spring back toward open");
assert.equal(dismissed, 2, "close distance uses the final position, not the old starting offset");
deferStop = false;

reopen();
deferStop = true;
begin(11);
move(11, 80);
release(11, 80);
assert.equal(dismissed, 2, "a release can wait for an asynchronous native stop reply");
flushNative();
assert.equal(dismissed, 3, "that release commits exactly once after its reply");
deferStop = false;

reopen();
deferStop = true;
begin(12);
move(12, 80);
reopen();
deferStop = false;
drag.panHandlers.onPanResponderGrant({}, state(12, 0)); // delayed grant from the old presentation
move(12, 100);
release(12, 100);
begin(13);
move(13, 15);
flushNative();
assert.equal(offset.value, 15, "old native replies don't overwrite a reopened sheet's new drag");
assert.equal(dismissed, 3, "old gesture callbacks cannot dismiss a reopened sheet");
props.onDismiss = () => freshDismissed++;
drag = render();
release(13, 75);
assert.equal(freshDismissed, 1, "a live gesture uses the current dismissal callback");
assert.equal(dismissed, 3);

reopen();
reducedMotion = true;
drag = render();
const springCount = springs.length;
begin(14);
move(14, 25);
release(14, 25);
assert.equal(offset.value, 0);
assert.equal(springs.length, springCount, "Reduce Motion returns immediately without a spring");
assert.ok(keyboardDismisses > 0, "dragging/tapping the handle dismisses a search keyboard");

deferStop = true;
begin(15);
move(15, 100);
hooks.unmount();
flushNative();
release(15, 100);
drag.dismiss();
assert.equal(freshDismissed, 1, "unmounted sheets ignore every delayed gesture/reply");
assert.equal(hooks.lateWrites, 0);

let handleDismissed = 0;
const handleModule = compileUI("../../components/SheetHandle", {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": { View: "View", Pressable: "Pressable", StyleSheet: { create: (s: any) => s } },
  "../lib/colors": { colors: {} },
  "../lib/i18n": { t: (key: string) => key },
  "../lib/tokens": { radius: { grabber: 2 }, TOUCH_MIN: 44 },
});
const handle = handleModule.SheetHandle({
  panHandlers: drag.panHandlers,
  onDismiss: () => handleDismissed++,
});
assert.equal(
  handle.props.onMoveShouldSetPanResponderCapture,
  drag.panHandlers.onMoveShouldSetPanResponderCapture,
);
const target = nodes(handle).find((node) => node.type === "Pressable")!;
assert.equal(flattenStyle(target.props.style).minHeight, 44);
assert.equal(target.props.accessibilityRole, "button");
assert.equal(target.props.accessibilityLabel, "common.close");
target.props.onPress();
assert.equal(handleDismissed, 1, "the handle also offers a tap/screen-reader close action");
console.log(
  "PASS: sheet drag direction, cancellation, flicks, rapid re-grabs, native replies, lifetimes and accessible handle",
);
