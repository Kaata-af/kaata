// Execute the real hook with controlled native animation replies. Actual finger
// tracking/responder transfer and native keyboard pixels still need phones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const hooks = uiHooks();
let reducedMotion = false,
  keyboardDismisses = 0,
  nativeReadRequests = 0;
const springs: { toValue: number; useNativeDriver: boolean; stopped: boolean }[] = [];
class Value {
  motion?: (typeof springs)[number];
  listeners = new Map<string, (state: { value: number }) => void>();
  listenerId = 0;
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
    this.listeners.forEach((listener) => listener({ value }));
  }
  stopAnimation(callback?: (value: number) => void) {
    if (this.motion) this.motion.stopped = true;
    // Match the phone failure: native getValue never calls its callback.
    if (callback) nativeReadRequests++;
  }
  addListener(listener: (state: { value: number }) => void) {
    const id = String(++this.listenerId);
    this.listeners.set(id, listener);
    return id;
  }
  removeListener(id: string) {
    this.listeners.delete(id);
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

assert.equal(
  drag.panHandlers.onStartShouldSetPanResponderCapture({}, state(1, 0)),
  false,
  "child Pressables keep first refusal of header taps",
);
assert.equal(drag.panHandlers.onStartShouldSetPanResponder({}, state(1, 0)), true);
drag.panHandlers.onPanResponderGrant({}, state(1, 0));
drag.panHandlers.onPanResponderMove({}, state(1, 3, 0, 40));
drag.panHandlers.onPanResponderRelease({}, state(1, 90, 0, 300));
assert.equal(offset.value, 0, "a plain header waits for vertical intent before following a finger");
assert.equal(dismissed, 0, "a horizontal header stroke cannot dismiss");
for (const gesture of [state(1, -30), state(1, 3), state(1, 10, 0, 30), state(1, 20, 0, 0, 2)])
  assert.equal(drag.panHandlers.onMoveShouldSetPanResponderCapture({}, gesture), false);
begin(2);
move(2, 30);
assert.equal(offset.value, 30, "the panel follows the handle's downward movement");
release(2, 30);
assert.equal(dismissed, 0, "a short drag does not dismiss");
assert.equal(springs.at(-1)?.toValue, 0);
assert.equal(springs.at(-1)?.useNativeDriver, true);

const releasedSpring = springs.at(-1)!;
reducedMotion = true;
drag = render();
assert.equal(releasedSpring.stopped, true, "Off stops a spring already running on native");
assert.equal(offset.value, 0);
reducedMotion = false;
drag = render();
begin(40);
move(40, 30);
reducedMotion = true;
drag = render();
assert.equal(offset.value, 30, "changing motion preserves a finger-controlled sheet drag");
release(40, 30);
assert.equal(offset.value, 0, "the released drag settles immediately in Off mode");
reducedMotion = false;
drag = render();
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
const oldSpringListener = [...offset.listeners.values()][0];
begin(10);
move(10, 8);
assert.equal(
  offset.value,
  24,
  "re-grabbing immediately continues from the observed spring position",
);
oldSpringListener({ value: 80 });
move(10, 9);
assert.equal(offset.value, 25, "a queued spring update cannot move an active finger stroke");
release(10, 8);
offset.setValue(80);
begin(16);
move(16, -60);
release(16, -60);
assert.equal(offset.value, 20, "a re-grab can pull an interrupted spring back toward open");
assert.equal(dismissed, 2, "close distance uses the final position, not the old starting offset");

reopen();
begin(11);
move(11, 80);
release(11, 80);
assert.equal(dismissed, 3, "a drag releases immediately even when native value reads never reply");

reopen();
begin(12);
move(12, 80);
const oldPresentationListener = [...offset.listeners.values()][0];
reopen();
drag.panHandlers.onPanResponderGrant({}, state(12, 0)); // delayed grant from the old presentation
move(12, 100);
release(12, 100);
begin(13);
move(13, 15);
oldPresentationListener({ value: 100 });
assert.equal(offset.value, 15, "old native listeners don't overwrite a reopened sheet's new drag");
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

// Panel gestures leave a scrolled list with its native responder. Once a
// stroke begins in that list, reaching its top must not turn it into a close.
let surfaceDismissed = 0;
props.onDismiss = () => surfaceDismissed++;
drag = render();
const scroll = (y: number) => drag.scrollProps.onScroll({ nativeEvent: { contentOffset: { y } } });
const touchSurface = (inScroll = true) => {
  assert.equal(
    drag.surfacePanHandlers.onStartShouldSetPanResponderCapture({}, state(20, 0)),
    false,
    "panel taps and row actions keep their responders",
  );
  if (inScroll) drag.scrollProps.onTouchStart();
};
const claimSurface = (dy = 10, dx = 0, touches = 1) =>
  drag.surfacePanHandlers.onMoveShouldSetPanResponderCapture({}, state(20, dy, 0, dx, touches));
const pullSurface = (dy = 75) => {
  assert.equal(claimSurface(), true);
  drag.surfacePanHandlers.onPanResponderGrant({}, state(20, 0));
  drag.surfacePanHandlers.onPanResponderMove({}, state(20, dy));
  assert.equal(offset.value, dy);
  drag.surfacePanHandlers.onPanResponderRelease({}, state(20, dy));
};
const nativeList = {};
drag.scrollProps.ref(nativeList);
assert.equal(drag.scrollProps.scrollEventThrottle, 16);
scroll(200);
touchSurface();
assert.equal(claimSurface(), false, "a downward swipe in a scrolled list stays a scroll");
scroll(0);
assert.equal(claimSurface(), false, "reaching the top mid-stroke cannot close the panel");
assert.equal(surfaceDismissed, 0);
assert.equal(offset.value, 0);
touchSurface();
for (const [dy, dx, touches] of [
  [-30, 0, 1],
  [3, 0, 1],
  [10, 30, 1],
  [20, 0, 2],
])
  assert.equal(claimSurface(dy, dx, touches), false);
pullSurface();
assert.equal(surfaceDismissed, 1, "a new pull from the top dismisses the panel");
drag.dismiss();
assert.equal(surfaceDismissed, 1, "surface/handle/Back dismissal still coalesces");

reopen();
scroll(200);
touchSurface(false);
pullSurface();
assert.equal(surfaceDismissed, 2, "the header/footer can pull even when the list is scrolled");

reopen();
touchSurface();
assert.equal(claimSurface(), false, "a rapid reopen preserves its existing list position");
drag.scrollProps.ref(null);
drag.scrollProps.ref({});
touchSurface();
scroll(-8);
assert.equal(claimSurface(), true, "a fresh list and iOS top overscroll allow dismissal");
drag.surfacePanHandlers.onPanResponderGrant({}, state(20, 0));
drag.surfacePanHandlers.onPanResponderMove({}, state(20, 25));
drag.surfacePanHandlers.onPanResponderRelease({}, state(20, 25));
assert.equal(surfaceDismissed, 2, "short panel pulls restore instead of dismissing");
assert.equal(offset.value, 0);

touchSurface();
scroll(20);
assert.equal(claimSurface(), false, "content that started scrolling retains its responder");
scroll(0);
touchSurface();
assert.equal(claimSurface(), true);
drag.surfacePanHandlers.onPanResponderGrant({}, state(20, 0));
drag.surfacePanHandlers.onPanResponderMove({}, state(20, 30));
drag.surfacePanHandlers.onPanResponderStart({}, state(20, 30, 0, 0, 2));
drag.surfacePanHandlers.onPanResponderRelease({}, state(20, 90));
assert.equal(surfaceDismissed, 2, "a second finger cancels a panel pull immediately");
assert.equal(offset.value, 0);

touchSurface(false);
drag.controlProps.onTouchStart();
drag.scrollProps.onTouchStart();
assert.equal(claimSurface(90), false, "a native clock wheel keeps its vertical gesture");
assert.equal(surfaceDismissed, 2);
assert.equal(offset.value, 0);

touchSurface();
reopen();
assert.equal(claimSurface(), false, "a stale touch cannot claim a reopened panel");

begin(15);
move(15, 100);
const unmountedListener = [...offset.listeners.values()][0];
hooks.unmount();
unmountedListener({ value: 80 });
release(15, 100);
drag.dismiss();
assert.equal(freshDismissed, 1, "unmounted sheets ignore every delayed gesture/reply");
assert.equal(hooks.lateWrites, 0);
assert.equal(offset.listeners.size, 0, "unmounted sheets remove their native value listener");
assert.equal(nativeReadRequests, 0, "gesture movement and release never wait for native getValue");

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

// Exercise the installed RN adapter too: the native responder names, separate
// state IDs and grant-time dy reset are absent from the callback-only fixture.
const interactionPath = join(
  dirname(require.resolve("react-native/package.json")),
  "Libraries/Interaction",
);
const interactionModules = new Map<string, any>();
function loadInteraction(name: string): any {
  if (interactionModules.has(name)) return interactionModules.get(name);
  const exports = {};
  const { code } = require("@babel/core").transformSync(
    readFileSync(join(interactionPath, `${name}.js`), "utf8"),
    {
      configFile: false,
      babelrc: false,
      plugins: [
        [require.resolve("flow-parser/babel-plugin"), { parseLangTypes: "flow" }],
        require.resolve("@babel/plugin-transform-flow-strip-types"),
        require.resolve("@babel/plugin-transform-modules-commonjs"),
      ],
    },
  );
  new Function("require", "exports", code)((dependency: string) => {
    assert.equal(dependency, "./TouchHistoryMath");
    return loadInteraction("TouchHistoryMath");
  }, exports);
  interactionModules.set(name, exports);
  return exports;
}
const nativePanResponder = loadInteraction("PanResponder").default;
for (const surface of ["handle", "header"] as const) {
  const nativeHooks = uiHooks();
  let nativeDismissed = 0;
  const real = compileUI("../use-sheet-drag", {
    react: nativeHooks.react,
    "../components/SheetBackdrop": { useSheetMotionPreference: () => false },
    "react-native": {
      PanResponder: nativePanResponder,
      Keyboard: { dismiss: () => {} },
      Animated: {
        Value,
        add: (left: Value, right: Value) => ({ left, right }),
        spring: () => ({ start: () => {} }),
      },
    },
  });
  const realDrag = nativeHooks.render(() => ({
    type: "Hook",
    props: real.useSheetDrag(true, new Value(0), () => nativeDismissed++),
  })).props;
  const handlers = realDrag.panHandlers;
  const responder =
    surface === "handle"
      ? handleModule.SheetHandle({ panHandlers: handlers, onDismiss: realDrag.dismiss }).props
      : handlers;
  let previousY = 0,
    previousX = 0;
  const event = (y: number, time: number, active = true, x = 0) => {
    const touch = {
      touchActive: active,
      startPageX: 0,
      startPageY: 0,
      startTimeStamp: 1,
      currentPageX: x,
      currentPageY: y,
      currentTimeStamp: time,
      previousPageX: previousX,
      previousPageY: previousY,
      previousTimeStamp: time - 16,
    };
    previousY = y;
    previousX = x;
    return {
      nativeEvent: { touches: active ? [touch] : [] },
      touchHistory: {
        touchBank: [touch],
        indexOfSingleActiveTouch: 0,
        numberActiveTouches: active ? 1 : 0,
        mostRecentTimeStamp: time,
      },
    };
  };
  if (surface === "header") {
    const touch = event(0, 1);
    assert.equal(responder.onStartShouldSetResponderCapture(touch), false);
    assert.equal(responder.onStartShouldSetResponder(touch), true);
    responder.onResponderGrant(touch);
    responder.onResponderMove(event(2, 17, true, 50));
    const end = event(2, 33, false, 50);
    responder.onResponderEnd(end);
    responder.onResponderRelease(end);
    assert.equal(
      realDrag.translateY.right.value,
      0,
      "a native horizontal title stroke stays still",
    );
    assert.equal(nativeDismissed, 0);
  }
  const start = event(0, 101);
  assert.equal(responder.onStartShouldSetResponderCapture(start), false);
  if (surface === "header") {
    assert.equal(responder.onStartShouldSetResponder(start), true);
    responder.onResponderGrant(start);
    responder.onResponderMove(event(10, 117));
  } else {
    const threshold = event(10, 117);
    assert.equal(responder.onMoveShouldSetResponderCapture(threshold), true);
    responder.onResponderGrant(threshold);
  }
  responder.onResponderMove(event(60, 133));
  assert.equal(
    realDrag.translateY.right.value,
    surface === "header" ? 60 : 50,
    `${surface}: native moves immediately after grant`,
  );
  responder.onResponderMove(event(90, 149));
  const end = event(90, 165, false);
  responder.onResponderEnd(end);
  responder.onResponderRelease(end);
  assert.equal(nativeDismissed, 1, `${surface}: native release closes without a value-read reply`);
  assert.equal(nativeReadRequests, 0);
  nativeHooks.unmount();
}
console.log(
  "PASS: sheet drag direction, cancellation, flicks, re-grabs, missing native replies, lifetimes, accessible handle and installed RN responder adapter",
);
