import assert from "node:assert/strict";
import type { CustomerBalanceFilter } from "../customer-list";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

type Swipe = {
  absoluteX: number;
  absoluteY: number;
  translationX: number;
  translationY: number;
  velocityX: number;
  numberOfPointers: number;
};
type Pan = {
  config: Record<string, unknown>;
  begin: (event: Swipe) => void;
  start: (event: Swipe) => void;
  move: (event: any, manager: { fail: () => void }) => void;
  update: (event: Swipe) => void;
  end: (event: Swipe, success?: boolean) => void;
  finalize: () => void;
};
type Animation = {
  from: number;
  target: number;
  config: any;
  callback?: (finished: boolean) => void;
  cancelled: boolean;
  finished: boolean;
  owner?: any;
};
function fixture() {
  const hooks = uiHooks();
  const effects: {
    kind: "layout" | "passive";
    setup: () => void | (() => void);
    cleanup?: void | (() => void);
  }[] = [];
  const trackedEffect = (
    kind: "layout" | "passive",
    setup: () => void | (() => void),
    deps?: unknown[],
  ) => {
    const record = hooks.react.useRef({ kind, setup, cleanup: undefined }).current;
    record.setup = setup;
    if (!effects.includes(record)) effects.push(record);
    hooks.react.useEffect(() => {
      record.cleanup = record.setup();
      return () => record.cleanup?.();
    }, deps);
  };
  let width = 390,
    reducedMotion = false,
    now = 0,
    frameID = 0;
  const frames = new Map<number, () => void>();
  const animations: Animation[] = [];
  const handoffs: (() => void)[] = [];
  let handoffCount = 0;
  const changes: CustomerBalanceFilter[] = [];
  const child = jsx("CustomerContent", { children: "one list or empty state" });
  const nativeGesture = { native: "vertical-scroll" };
  let props = {
    enabled: true,
    contextKey: "account:kaata:request-1",
    currencyKey: "[]",
    direction: "all" as CustomerBalanceFilter,
    nativeGesture: nativeGesture as any,
    onDirectionChange: (direction: CustomerBalanceFilter) => {
      changes.push(direction);
    },
    style: undefined as Record<string, unknown> | undefined,
    testID: undefined as string | undefined,
    children: child,
  };
  const cancel = (shared: any) => {
    const running: Animation | undefined = shared.running;
    if (running && !running.finished && !running.cancelled) {
      running.cancelled = true;
      shared.running = undefined;
      running.callback?.(false);
    }
  };
  const shared = (initial: any) => {
    let value = initial;
    const result: any = { running: undefined };
    Object.defineProperty(result, "value", {
      get: () => value,
      set(next) {
        cancel(result);
        if (next?.animation) {
          // Reanimated completes an animation to its current value immediately.
          if (next.target === value) {
            next.callback?.(true);
            return;
          }
          const animation: Animation = {
            ...next,
            from: value,
            owner: result,
            cancelled: false,
            finished: false,
          };
          animations.push(animation);
          result.running = animation;
          value = next.target;
        } else value = next;
      },
    });
    return result;
  };
  const { HomeBalanceFilterSwipe } = compileUI(
    "../../components/HomeBalanceFilterSwipe",
    {
      react: {
        ...hooks.react,
        useLayoutEffect: (setup: () => void | (() => void), deps?: unknown[]) =>
          trackedEffect("layout", setup, deps),
        useEffect: (setup: () => void | (() => void), deps?: unknown[]) =>
          trackedEffect("passive", setup, deps),
      },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        StyleSheet: { create: (value: unknown) => value },
        useWindowDimensions: () => ({ width }),
      },
      "./SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
      "react-native-reanimated": {
        __esModule: true,
        default: { View: "Animated.View" },
        ReduceMotion: { System: "system" },
        cancelAnimation: cancel,
        useSharedValue: (initial: any) => hooks.react.useRef(shared(initial)).current,
        useAnimatedStyle: (fn: () => any) => ({
          get transform() {
            return fn().transform;
          },
        }),
        withTiming: (target: number, config: any, callback?: Animation["callback"]) => ({
          animation: true,
          target,
          config,
          callback,
        }),
      },
      "react-native-worklets": {
        scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => {
          handoffCount++;
          handoffs.push(() => fn(...args));
        },
      },
      "react-native-gesture-handler": {
        GestureDetector: "GestureDetector",
        Gesture: {
          Pan: () => {
            const pan: any = { config: {} };
            for (const key of [
              "enabled",
              "maxPointers",
              "activeOffsetX",
              "failOffsetY",
              "simultaneousWithExternalGesture",
            ])
              pan[key] = (value: unknown) => {
                pan.config[key] = value;
                return pan;
              };
            for (const [method, handler] of [
              ["onBegin", "begin"],
              ["onStart", "start"],
              ["onTouchesMove", "move"],
              ["onUpdate", "update"],
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
    },
    {
      performance: { now: () => now },
      requestAnimationFrame: (callback: () => void) => {
        frames.set(++frameID, callback);
        return frameID;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    },
  );
  const render = () => hooks.render(() => HomeBalanceFilterSwipe(props));
  const gesture = (): Pan => hooks.tree.props.gesture;
  const event = (x = 0, velocity = 0, y = 0, pointers = 1): Swipe => ({
    absoluteX: 200 + x,
    absoluteY: 300 + y,
    translationX: 0,
    translationY: 0,
    velocityX: velocity,
    numberOfPointers: pointers,
  });
  const begin = (pan = gesture()) => {
    pan.begin(event());
    pan.start(event(25));
    return pan;
  };
  const finishAnimations = () => {
    for (const animation of [...animations]) {
      if (!animation.cancelled && !animation.finished) {
        animation.finished = true;
        animation.owner.running = undefined;
        animation.callback?.(true);
      }
    }
  };
  const flushRN = () => {
    for (const callback of handoffs.splice(0)) callback();
  };
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((fn) => fn());
  };
  const settle = () => {
    finishAnimations();
    flushRN();
    flushFrames();
    finishAnimations();
  };
  const swipe = (x: number, velocity = 0, y = 0, success = true) => {
    const pan = begin();
    pan.update(event(x, velocity, y));
    pan.end(event(x, velocity, y), success);
    pan.finalize();
    settle();
  };
  render();
  return {
    hooks,
    changes,
    child,
    nativeGesture,
    animations,
    handoffs,
    frames,
    gesture,
    begin,
    event,
    swipe,
    settle,
    finishAnimations,
    flushRN,
    flushFrames,
    get offset() {
      return flattenStyle(
        nodes(hooks.tree).find((node) => node.type === "Animated.View")!.props.style,
      ).transform[0].translateX;
    },
    get handoffCount() {
      return handoffCount;
    },
    update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      render();
    },
    resize(value: number) {
      width = value;
      render();
    },
    motion(value: boolean) {
      reducedMotion = value;
      render();
    },
    time(value: number) {
      now = value;
    },
    replayMountEffects() {
      // React's development replay keeps the same mounted hook/gesture instance
      // and render snapshot, but cleans up and sets up layout then passive work.
      for (const record of effects) record.cleanup?.();
      for (const kind of ["layout", "passive"] as const)
        for (const record of effects.filter((item) => item.kind === kind))
          record.cleanup = record.setup();
    },
  };
}

for (const direction of ["all", "collect", "pay"] as const) {
  const f = fixture();
  f.update({ direction });
  f.swipe(-80);
  f.swipe(80);
  assert.deepEqual(
    f.changes,
    ["pay", "collect"],
    "Physical swipes choose the same side in all languages, including repeated side",
  );
  assert.deepEqual(f.gesture().config, {
    enabled: true,
    maxPointers: 1,
    activeOffsetX: [-24, 24],
    failOffsetY: [-16, 16],
    simultaneousWithExternalGesture: f.nativeGesture,
  });
  const wrapper = nodes(f.hooks.tree).find((node) => node.type === "Animated.View")!;
  assert.equal(wrapper.props.collapsable, false);
  assert.equal(wrapper.props.children, f.child, "The same customer content remains mounted");
  assert.ok(
    !nodes(f.hooks.tree).some((node) => /ScrollView/.test(node.type)),
    "Adds no scroll host or second list",
  );
  f.update({ testID: "home-customer-content", style: { paddingTop: 12 } });
  const styled = nodes(f.hooks.tree).find((node) => node.type === "Animated.View")!;
  assert.equal(styled.props.testID, "home-customer-content");
  assert.equal(flattenStyle(styled.props.style).paddingTop, 12);
}

{
  const f = fixture();
  const pan = f.begin();
  for (const x of [-20, -40, -100, -200]) pan.update(f.event(x));
  assert.equal(f.offset, -96, "Finger feedback is bounded instead of exposing empty page widths");
  assert.equal(f.handoffCount, 0, "Repeated finger updates remain on UI without RN state traffic");
  pan.update(f.event(-50));
  assert.equal(f.offset, -32.5);
  pan.end(f.event(-50), true);
  pan.finalize();
  assert.deepEqual(f.changes, [], "Commit waits for the short outgoing motion");
  assert.equal(f.animations.at(-1)!.config.duration, 80);
  f.finishAnimations();
  assert.equal(f.handoffCount, 1);
  assert.deepEqual(f.changes, [], "Only the scheduled RN callback changes the filter");
  f.flushRN();
  assert.deepEqual(f.changes, ["pay"]);
  f.update({ direction: "pay" });
  assert.equal(f.animations.at(-1)!.from, 24);
  assert.equal(f.animations.at(-1)!.target, 0);
  assert.equal(f.animations.at(-1)!.config.duration, 160);
  assert.equal(f.frames.size, 0, "Committed incoming render cancels the no-render fallback");
  f.settle();
  assert.equal(f.offset, 0);
}

{
  const f = fixture();
  const pan = f.begin();
  pan.update(f.event(60));
  pan.finalize();
  assert.equal(f.animations.at(-1)!.from, 39);
  assert.equal(f.animations.at(-1)!.config.duration, 120);
  f.settle();
  pan.end(f.event(100, 900), true);
  f.settle();
  assert.deepEqual(f.changes, [], "Cancelled gesture cannot be completed later");
  assert.equal(f.offset, 0);
  f.swipe(31);
  f.swipe(-23, -900);
  f.swipe(24, 449);
  f.swipe(24, -900);
  f.swipe(90, 0, 0, false);
  f.swipe(Number.NaN);
  f.swipe(24, Number.POSITIVE_INFINITY);
  f.swipe(24, Number.NaN);
  f.swipe(90, 0, Number.NaN);
  assert.deepEqual(f.changes, [], "Short, reversed, failed and invalid gestures do not commit");
  f.swipe(-24, -450);
  f.swipe(24, 450);
  f.swipe(32, -900);
  assert.deepEqual(
    f.changes,
    ["pay", "collect", "collect"],
    "Distance or agreeing flick accepts full absolute movement even with zero native translation",
  );
}

{
  const f = fixture();
  const pan = f.begin();
  pan.update(f.event(-60));
  assert.equal(f.offset, -39);
  f.time(1200);
  let failures = 0;
  pan.move({ numberOfTouches: 1, allTouches: [f.event(-60, 0, 25)] }, { fail: () => failures++ });
  pan.update(f.event(-60, 0, 25));
  assert.equal(f.offset, -39, "Holding with vertical drift keeps the active horizontal offset");
  pan.update(f.event(-20, 0, 21));
  assert.equal(f.offset, -13, "Vertical drift cannot snap a held drag to zero");
  pan.update(f.event(Number.NaN));
  assert.equal(f.offset, -13, "An invalid movement sample preserves the last valid offset");
  f.update({ onDirectionChange: (side) => f.changes.push(side) });
  assert.equal(f.offset, -13, "An ordinary rerender does not move a held finger");
  assert.equal(f.animations.length, 0, "No return animation runs before release");
  assert.equal(failures, 0);
  assert.deepEqual(f.changes, []);
  pan.end(f.event(-20, 0, 21), true);
  pan.finalize();
  assert.equal(f.animations.length, 1, "Finalizing a rejected release does not restart its return");
  assert.equal(f.animations.at(-1)!.from, -13);
  assert.equal(f.animations.at(-1)!.target, 0);
  assert.equal(f.animations.at(-1)!.config.duration, 120);
  f.settle();
  assert.deepEqual(f.changes, [], "Pulling back below the distance threshold cancels on release");
  f.swipe(-60);
  assert.deepEqual(f.changes, ["pay"], "A fresh horizontal swipe still filters normally");
}

for (const sign of [-1, 1]) {
  const f = fixture();
  const pan = f.gesture();
  pan.begin(f.event());
  f.time(200);
  pan.move({ numberOfTouches: 1, allTouches: [f.event(sign * 8)] }, { fail: () => assert.fail() });
  f.time(700);
  pan.start(f.event(sign * 25));
  for (const [time, x, y] of [
    [1000, 60, 12],
    [2000, 140, 30],
    [4000, 220, 55],
  ]) {
    f.time(time);
    pan.update(f.event(sign * x, 0, y));
  }
  assert.equal(f.offset, sign * 96);
  assert.equal(f.animations.length, 0, "Slow movement stays under the finger until release");
  assert.deepEqual(f.changes, []);
  pan.end(f.event(sign * 220, 0, 55), true);
  pan.finalize();
  assert.equal(f.handoffCount, 1, "Releasing at the visual cap completes without another frame");
  f.settle();
  assert.deepEqual(
    f.changes,
    [sign < 0 ? "pay" : "collect"],
    "A slow full swipe uses distance, not speed or later vertical drift",
  );
  assert.equal(f.offset, 0);
}

for (const [x, y] of [
  [25, 15],
  [25, 20],
  [0, 30],
]) {
  const f = fixture();
  const pan = f.gesture();
  pan.begin(f.event());
  pan.start(f.event(x, 0, y));
  pan.update(f.event(200));
  pan.end(f.event(200), true);
  pan.finalize();
  f.settle();
  assert.deepEqual(
    f.changes,
    [],
    "Initial diagonal or vertical intent cannot become a filter swipe",
  );
}

{
  const f = fixture();
  f.swipe(90, Number.NaN, 40);
  assert.deepEqual(f.changes, ["collect"], "A full-distance swipe does not need a velocity sample");
}

// Every native closure and queued RN callback must expire across scope ABA,
// search/modal blocking, direction, currency selection, rotation or relation changes.
for (const change of [
  { enabled: false },
  { contextKey: "another-account:kaata:request-2" },
  { direction: "pay" as const },
  { currencyKey: '["USD"]' },
  { nativeGesture: { native: "replacement" } },
]) {
  const f = fixture();
  const old = f.begin();
  old.update(f.event(-60));
  old.end(f.event(-60, -600), true);
  old.finalize();
  f.finishAnimations();
  assert.equal(f.handoffs.length, 1);
  f.update(change);
  assert.equal(f.offset, 0, "Ownership change immediately clears visual displacement");
  f.update({
    enabled: true,
    contextKey: "account:kaata:request-1",
    direction: "all",
    currencyKey: "[]",
    nativeGesture: f.nativeGesture,
  });
  f.flushRN();
  old.begin(f.event());
  old.start(f.event(25));
  old.end(f.event(-100, -600), true);
  f.settle();
  assert.deepEqual(f.changes, [], "Old closures and queued completions cannot revive after ABA");
  f.swipe(-60);
  assert.deepEqual(f.changes, ["pay"]);
}

{
  const f = fixture();
  const old = f.begin();
  old.end(f.event(-60), true);
  f.resize(844);
  f.settle();
  assert.deepEqual(f.changes, [], "Width changes cancel the pending release animation");
  f.resize(0);
  f.swipe(-60, -900);
  f.resize(Number.NaN);
  f.swipe(-60, -900);
  assert.deepEqual(f.changes, [], "Unknown viewport widths never commit");
  f.resize(390);
  const pan = f.begin();
  pan.end(f.event(60), true);
  pan.end(f.event(60), true);
  pan.finalize();
  f.finishAnimations();
  f.update({ onDirectionChange: (side) => f.changes.push(side) });
  f.flushRN();
  f.flushFrames();
  f.finishAnimations();
  assert.deepEqual(
    f.changes,
    ["collect"],
    "Duplicate ends dispatch only once and use the latest callback",
  );
  assert.equal(f.offset, 0, "No parent render still settles through one bounded frame");
  assert.equal(f.frames.size, 0);
}

{
  const f = fixture();
  f.update({ direction: "collect", currencyKey: '["USD"]' });
  f.update({
    onDirectionChange: (direction) => {
      f.changes.push(direction);
      f.update({ direction, currencyKey: "[]" });
    },
  });
  f.swipe(60);
  assert.deepEqual(
    f.changes,
    ["collect"],
    "Same side still dispatches so the root can clear currency filtering",
  );
  assert.equal(
    f.animations.at(-1)!.from,
    -24,
    "Own currency-clear render receives the incoming motion",
  );
  assert.equal(f.offset, 0);
}

{
  const f = fixture();
  const first = f.begin();
  first.end(f.event(-60), true);
  first.finalize();
  f.finishAnimations();
  assert.equal(f.handoffs.length, 1);
  const next = f.begin();
  next.update(f.event(50));
  f.flushRN();
  assert.deepEqual(
    f.changes,
    [],
    "A new stroke invalidates a queued RN commit within the same epoch",
  );
  assert.equal(f.offset, 32.5, "Rejected old completion cannot disturb the new finger feedback");
  next.end(f.event(50), true);
  next.finalize();
  f.settle();
  assert.deepEqual(f.changes, ["collect"]);
}

{
  const f = fixture();
  const first = f.begin();
  first.end(f.event(-60), true);
  first.finalize();
  f.finishAnimations();
  f.flushRN();
  assert.equal(f.frames.size, 1);
  const next = f.begin();
  next.update(f.event(50));
  f.flushFrames();
  assert.equal(f.offset, 32.5, "An old fallback cannot settle a newer stroke in the same epoch");
  next.finalize();
  f.settle();
  assert.deepEqual(f.changes, ["pay"]);
}

{
  const f = fixture();
  f.motion(true);
  const pan = f.begin();
  pan.update(f.event(-60));
  assert.equal(f.offset, 0);
  pan.end(f.event(-60), true);
  pan.finalize();
  assert.equal(f.animations.length, 0, "Reduced motion suppresses drag and transition animations");
  f.flushRN();
  f.flushFrames();
  assert.deepEqual(f.changes, ["pay"], "Reduced motion preserves filtering");
  const old = f.begin();
  old.update(f.event(60));
  f.motion(false);
  old.end(f.event(60), true);
  f.settle();
  assert.deepEqual(f.changes, ["pay"], "Changing motion preference expires an in-progress stroke");
}

{
  const f = fixture();
  let failures = 0;
  const held = f.gesture();
  held.begin(f.event());
  f.time(400);
  held.move({ numberOfTouches: 1, allTouches: [f.event(60)] }, { fail: () => failures++ });
  held.start(f.event(60));
  held.end(f.event(60), true);
  held.finalize();
  f.settle();
  assert.equal(failures, 1);
  assert.deepEqual(f.changes, [], "A stationary row hold does not become a filter swipe");
  const slow = f.gesture();
  slow.begin(f.event());
  f.time(500);
  slow.move({ numberOfTouches: 1, allTouches: [f.event(7)] }, { fail: () => failures++ });
  f.time(1100);
  slow.start(f.event(25));
  slow.update(f.event(-60));
  slow.end(f.event(-60), true);
  slow.finalize();
  f.settle();
  assert.deepEqual(
    f.changes,
    ["pay"],
    "Continuous slow horizontal movement survives the hold guard",
  );
}

{
  const f = fixture();
  const pan = f.begin();
  pan.update(f.event(-60));
  pan.end(f.event(-60), true);
  pan.finalize();
  f.finishAnimations();
  const gestureBeforeReplay = f.gesture();
  f.replayMountEffects();
  assert.equal(
    f.gesture(),
    gestureBeforeReplay,
    "Mount replay does not require a rerender or new gesture",
  );
  f.flushRN();
  f.flushFrames();
  assert.deepEqual(f.changes, [], "Mount replay invalidates a queued stroke completion");
  f.swipe(60);
  assert.deepEqual(
    f.changes,
    ["collect"],
    "Fresh swipes work immediately after StrictMode effect replay",
  );
  assert.equal(f.offset, 0);
}

{
  const f = fixture();
  const pan = f.begin();
  pan.update(f.event(-60));
  pan.end(f.event(-60), true);
  pan.finalize();
  f.finishAnimations();
  f.hooks.unmount();
  f.flushRN();
  f.flushFrames();
  pan.begin(f.event());
  pan.start(f.event(25));
  pan.end(f.event(60), true);
  f.settle();
  assert.deepEqual(f.changes, [], "Unmount rejects pending native/RN/animation completions");
  assert.equal(f.offset, 0);
  assert.equal(f.hooks.lateWrites, 0);
}

console.log(
  "PASS animated list-only balance swipes: UI finger feedback, deferred single commit, native scroll relation, motion reduction, cancellation and scoped ABA guards",
);
