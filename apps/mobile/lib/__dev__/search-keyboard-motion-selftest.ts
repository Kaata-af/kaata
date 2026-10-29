// Execute the real keyboard observer and animated style worklets. Native
// keyboard frame delivery and on-device rendering remain physical QA.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

type Event = { height: number; progress: number; duration: number };
type Handler = Record<"onStart" | "onMove" | "onInteractive" | "onEnd", (event: Event) => void>;
type Context = { current: unknown; Provider: { context: Context } };
type Metrics = { screenX: number; screenY: number; width: number; height: number };
type Measurement = (x: number, y: number, width: number, height: number) => void;

function fixture(
  platform: "ios" | "android",
  {
    avoidAndroidKeyboard = false,
    edgeToEdge = true,
    statusBarHeight = 0,
    initialKeyboard,
  }: {
    avoidAndroidKeyboard?: boolean;
    edgeToEdge?: boolean | "unknown" | "missing";
    statusBarHeight?: number;
    initialKeyboard?: Metrics;
  } = {},
) {
  const hooks = uiHooks();
  let active = true,
    focusStart: (() => void | (() => void)) | undefined,
    focusCleanup: (() => void) | undefined,
    metrics = initialKeyboard,
    layoutEvents = 0;
  const keyboardListeners = new Map<string, Set<(event: any) => void>>();
  const measurements: Measurement[] = [];
  const keyboardLayouts: { version: number; shown: boolean; overlap: number }[] = [];
  let receiptVersion = 0;
  let shown = false,
    renders = 0,
    registrations = 0,
    sharedValues = 0,
    childPresses = 0,
    reactUpdates = 0;
  let handler: Handler | null = null;
  const failAnimation = () =>
    assert.fail("native frame tracking must not start a guessed animation or timer");
  const module = compileUI(
    "../../components/SearchKeyboardMotion",
    {
      react: {
        ...hooks.react,
        useState: (initial: any) => {
          const [value, set] = hooks.react.useState(initial);
          return [
            value,
            (next: any) => {
              reactUpdates++;
              set(next);
            },
          ];
        },
        createContext: (value: unknown) => {
          const context = { current: value } as Context;
          context.Provider = { context };
          return context;
        },
        useContext: (context: Context) => context.current,
      },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        useFocusEffect: (fn: () => void | (() => void)) =>
          hooks.react.useEffect(() => {
            focusStart = fn;
            if (active) focusCleanup = fn() || undefined;
            return () => {
              focusCleanup?.();
              focusCleanup = undefined;
            };
          }, [fn]),
      },
      "react-native": {
        Platform: { OS: platform },
        StatusBar: { currentHeight: statusBarHeight },
        View: "View",
        StyleSheet: { flatten: flattenStyle },
        Keyboard: {
          metrics: () => metrics,
          addListener: (kind: string, callback: (event: any) => void) => {
            const listeners = keyboardListeners.get(kind) ?? new Set();
            keyboardListeners.set(kind, listeners);
            listeners.add(callback);
            return { remove: () => listeners.delete(callback) };
          },
        },
        TurboModuleRegistry: {
          get: (name: string) => {
            assert.equal(platform, "android");
            assert.equal(name, "DeviceInfo");
            return edgeToEdge === "missing"
              ? null
              : {
                  getConstants: () =>
                    edgeToEdge === "unknown" ? {} : { isEdgeToEdge: edgeToEdge },
                };
          },
        },
      },
      "react-native-keyboard-controller": {
        KeyboardProvider: "KeyboardProvider",
        useGenericKeyboardHandler: (next: Handler) => {
          handler = next;
          registrations++;
        },
      },
      "react-native-reanimated": {
        __esModule: true,
        default: { View: "AnimatedView" },
        useSharedValue: (initial: number) => {
          sharedValues++;
          return hooks.react.useRef({ value: initial }).current;
        },
        useAnimatedStyle: (read: () => unknown) => ({ read }),
        withTiming: failAnimation,
        withSpring: failAnimation,
        withDelay: failAnimation,
      },
    },
    { setTimeout: failAnimation, setInterval: failAnimation, requestAnimationFrame: failAnimation },
  );
  function expand(node: any): any {
    if (Array.isArray(node)) return node.map(expand);
    if (!node?.props) return node;
    if (node.type?.context) {
      const context = node.type.context as Context;
      const previous = context.current;
      context.current = node.props.value;
      const children = expand(node.props.children);
      context.current = previous;
      return jsx("MotionContext", { children });
    }
    if (typeof node.type === "function") return expand(node.type(node.props));
    if (node.type === "View" && node.props.testID === "frame" && node.props.ref) {
      node.props.ref.current = {
        measureInWindow: (callback: Measurement) => measurements.push(callback),
      };
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  const render = (nextShown = shown) => {
    shown = nextShown;
    renders++;
    const version = receiptVersion;
    return hooks.render(() =>
      expand(
        jsx(module.SearchKeyboardProvider, {
          children: [
            jsx(module.SearchKeyboardFrame, {
              testID: "frame",
              avoidAndroidKeyboard,
              style: { flex: 1, paddingBottom: 3 },
              onLayout: () => {
                layoutEvents++;
              },
              onKeyboardLayout: (shown: boolean, overlap: number) =>
                keyboardLayouts.push({ version, shown, overlap }),
              children: "Search results",
            }),
            jsx(module.SearchKeyboardFooter, {
              testID: "footer",
              closedPadding: 42,
              openPadding: 8,
              keyboardShown: shown,
              style: { paddingBottom: 99 },
              children: jsx("Pressable", { onPress: () => childPresses++ }),
            }),
          ],
        }),
      ),
    );
  };
  const resolveStyle = (style: any): any =>
    Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean).map(resolveStyle))
      : style?.read
        ? style.read()
        : flattenStyle(style);
  const find = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id)!;
  const padding = (id: string) => resolveStyle(find(id).props.style).paddingBottom as number;
  render();
  return {
    hooks,
    render,
    find,
    padding,
    layout: () =>
      find("frame").props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 824 } },
      }),
    show: (screenY: number, height = 824 - screenY) => {
      metrics = { screenX: 0, screenY, width: 390, height };
      keyboardListeners
        .get("keyboardDidShow")
        ?.forEach((callback) =>
          callback({ endCoordinates: metrics, duration: 0, easing: "keyboard" }),
        );
    },
    hide: () => {
      metrics = undefined;
      keyboardListeners.get("keyboardDidHide")?.forEach((callback) => callback({ duration: 0 }));
    },
    takeMeasurement: () => {
      const callback = measurements.shift();
      assert.ok(callback, "the real frame requests native window measurement");
      return (y: number, height: number) => callback(0, y, 390, height);
    },
    blur: () => {
      active = false;
      focusCleanup?.();
      focusCleanup = undefined;
    },
    refocus: () => {
      active = true;
      focusCleanup = focusStart?.() || undefined;
    },
    get pendingMeasurements() {
      return measurements.length;
    },
    get listenerCount() {
      return [...keyboardListeners.values()].reduce((sum, set) => sum + set.size, 0);
    },
    nativeListeners: (kind: string) => [...(keyboardListeners.get(kind) ?? [])],
    get layoutEvents() {
      return layoutEvents;
    },
    get handler() {
      assert.ok(handler);
      return handler;
    },
    get renders() {
      return renders;
    },
    get registrations() {
      return registrations;
    },
    get sharedValues() {
      return sharedValues;
    },
    get childPresses() {
      return childPresses;
    },
    get reactUpdates() {
      return reactUpdates;
    },
    keyboardLayouts,
    nextReceipt: () => {
      receiptVersion++;
    },
  };
}

const ios = fixture("ios");
const provider = nodes(ios.hooks.tree).find((node) => node.type === "KeyboardProvider")!;
assert.equal(
  provider.props.preload,
  false,
  "mounting the app must not preload or flash an input keyboard",
);
assert.equal(ios.registrations, 1);
assert.equal(ios.find("frame").type, "AnimatedView");
assert.equal(ios.find("footer").type, "AnimatedView");
const expectFrame = (height: number, footer: number) => {
  assert.equal(ios.padding("frame"), height);
  assert.ok(Math.abs(ios.padding("footer") - footer) < 1e-9);
};
expectFrame(0, 42);
ios.render(true);
expectFrame(0, 42); // Semantic focus/did-show cannot jump ahead of native motion.
const rendersBeforeMovement = ios.renders;
const native = (kind: keyof Handler, height: number, progress: number, duration = 250) =>
  ios.handler[kind]({ height, progress, duration });
native("onStart", 300, 1);
expectFrame(0, 42);
native("onMove", 75, 0.25);
expectFrame(75, 33.5);
native("onMove", 150, 0.5);
expectFrame(150, 25);
native("onEnd", 300, 1);
expectFrame(300, 8);
native("onStart", 0, 0);
expectFrame(300, 8); // Closing start also describes an endpoint, not a frame.
native("onInteractive", 180, 0.6);
expectFrame(180, 21.6);
native("onEnd", 300, 1);
expectFrame(300, 8); // A canceled interactive close restores the shown position.
native("onInteractive", 75, 0.25);
expectFrame(75, 33.5);
native("onEnd", 0, 0);
expectFrame(0, 42);
native("onStart", 200, 1, 0);
expectFrame(200, 8);
native("onMove", -20, 0.8);
expectFrame(0, 42);
native("onMove", 100, -1);
expectFrame(100, 42);
native("onInteractive", 100, 2);
expectFrame(100, 8);
native("onEnd", 0, 1, 0);
expectFrame(0, 42); // Hardware/no-IME events cannot remove closed safe-area padding.
assert.equal(
  ios.renders,
  rendersBeforeMovement,
  "native frames update shared styles without JS React rerenders",
);
assert.equal(ios.reactUpdates, 0, "per-frame handlers never schedule React state updates");
nodes(ios.find("footer"))
  .find((node) => node.type === "Pressable")!
  .props.onPress();
assert.equal(ios.childPresses, 1, "the motion footer retains its child's controls");
ios.hooks.unmount();

const android = fixture("android");
assert.equal(
  nodes(android.hooks.tree).some((node) => node.type === "KeyboardProvider"),
  false,
);
assert.equal(android.registrations, 0, "Android never installs the native keyboard observer");
assert.equal(android.sharedValues, 0);
assert.equal(android.find("frame").type, "View");
assert.equal(android.find("footer").type, "View");
assert.equal(
  android.padding("frame"),
  3,
  "Android keeps the caller's layout rather than adding IME height",
);
assert.equal(android.padding("footer"), 42);
android.render(true);
assert.equal(
  android.padding("footer"),
  8,
  "Android retains its existing semantic keyboard padding",
);
android.render(false);
assert.equal(android.padding("footer"), 42);
assert.equal(android.registrations, 0);
assert.equal(
  android.listenerCount,
  0,
  "unrequested Android consumers do not observe or alter IME layout",
);
android.hooks.unmount();

const resized = fixture("android", {
  avoidAndroidKeyboard: true,
  edgeToEdge: false,
  statusBarHeight: 24,
});
assert.equal(
  resized.listenerCount,
  2,
  "a non-edge flag cannot prove whether Samsung resized the current window",
);
assert.equal(resized.find("frame").props.collapsable, false);
resized.show(492);
resized.takeMeasurement()(0, 468);
resized.render();
assert.equal(
  resized.padding("frame"),
  3,
  "a genuinely resized non-edge window needs no extra lift",
);
resized.layout();
resized.takeMeasurement()(60, 408);
resized.render();
assert.equal(
  resized.padding("frame"),
  3,
  "modal/header origins plus the status bar still produce zero when already resized",
);
assert.equal(resized.layoutEvents, 1, "measured frames preserve the caller's layout handler");
assert.deepEqual(resized.keyboardLayouts.at(-1), { version: 0, shown: true, overlap: 0 });
resized.layout();
resized.takeMeasurement()(0, 800);
resized.render();
assert.equal(
  resized.padding("frame"),
  335,
  "the same non-edge host avoids an unresized keyboard-covered window",
);
resized.layout();
resized.takeMeasurement()(60, 740);
resized.render();
assert.equal(
  resized.padding("frame"),
  335,
  "a stacked modal/header origin keeps the same screen overlap",
);
resized.layout();
resized.takeMeasurement()(-272, 740);
resized.render();
assert.equal(
  resized.padding("frame"),
  3,
  "native panning already above the keyboard adds no second lift",
);
resized.hooks.unmount();

for (const [edgeToEdge, statusBarHeight, y, height] of [
  [false, 48, 60, 716], // A taller Samsung status bar/display cutout.
  [false, 0, 60, 764], // Fullscreen/non-edge window with no top inset.
  [true, 48, 60, 764], // Edge measurements already include the top inset.
  ["unknown", 48, 60, 764],
] as const) {
  const offset = fixture("android", { avoidAndroidKeyboard: true, edgeToEdge, statusBarHeight });
  offset.show(492);
  offset.takeMeasurement()(y, height);
  offset.render();
  assert.equal(
    offset.padding("frame"),
    335,
    "coordinate normalization uses only the inset RN removed",
  );
  assert.deepEqual(offset.keyboardLayouts.at(-1), { version: 0, shown: true, overlap: 332 });
  offset.hide();
  offset.render();
  assert.deepEqual(offset.keyboardLayouts.at(-1), { version: 0, shown: false, overlap: 0 });
  offset.hooks.unmount();
}

for (const edgeToEdge of [true, "unknown", "missing"] as const) {
  const measured = fixture("android", { avoidAndroidKeyboard: true, edgeToEdge });
  assert.equal(
    measured.registrations,
    0,
    "Android avoidance installs no iOS provider/worklet clock",
  );
  assert.equal(measured.sharedValues, 0);
  assert.equal(measured.listenerCount, 2);
  assert.equal(
    measured.find("frame").props.collapsable,
    false,
    "the measured frame remains a real native host",
  );
  assert.equal(measured.padding("frame"), 3);
  measured.render(true);
  assert.equal(
    measured.padding("frame"),
    3,
    "focus semantics alone cannot invent keyboard overlap",
  );
  measured.show(492);
  assert.equal(measured.padding("frame"), 3, "avoidance waits for actual window geometry");
  measured.takeMeasurement()(0, 824);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    335,
    "an unresized 824px frame avoids the 332px covered by the IME plus caller padding",
  );
  assert.equal(
    824 - (measured.padding("frame") - 3),
    492,
    "the content boundary clears the reported keyboard top",
  );
  assert.equal(measured.padding("footer"), 8);
  measured.layout();
  measured.takeMeasurement()(60, 764);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    335,
    "a nonzero header/status-bar origin uses the same physical overlap",
  );
  measured.layout();
  measured.takeMeasurement()(60, 432);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    3,
    "if the native window already resized, measured avoidance adds nothing",
  );
  measured.layout();
  measured.takeMeasurement()(-272, 764);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    3,
    "supplied already-panned native bounds add no second lift",
  );
  measured.show(450, 374);
  measured.takeMeasurement()(60, 764);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    377,
    "a changing keyboard height remeasures current frame intersection",
  );
  measured.show(260, 100);
  measured.takeMeasurement()(24, 336);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    103,
    "short landscape geometry uses measured height, not a cached portrait frame",
  );
  measured.hide();
  measured.render();
  assert.equal(measured.padding("frame"), 3, "hide restores the caller's original padding exactly");
  measured.show(492);
  measured.takeMeasurement()(0, 824);
  measured.render();
  assert.equal(
    measured.padding("frame"),
    335,
    "a second keyboard cycle still avoids the full overlap",
  );
  measured.hide();
  measured.render();
  assert.equal(measured.padding("frame"), 3);
  assert.equal(measured.layoutEvents, 3);
  measured.hooks.unmount();
  assert.equal(measured.listenerCount, 0);
}

{
  const preopened = fixture("android", {
    avoidAndroidKeyboard: true,
    initialKeyboard: { screenX: 0, screenY: 492, width: 390, height: 332 },
  });
  preopened.takeMeasurement()(0, 824);
  preopened.render();
  assert.equal(
    preopened.padding("frame"),
    335,
    "opening a focused route while IME is already visible uses Keyboard.metrics",
  );
  preopened.show(450);
  const oldShow = preopened.takeMeasurement();
  preopened.nextReceipt();
  preopened.render();
  preopened.show(400);
  const newShow = preopened.takeMeasurement();
  newShow(0, 824);
  preopened.render();
  assert.equal(preopened.padding("frame"), 427);
  assert.deepEqual(
    preopened.keyboardLayouts.at(-1),
    { version: 1, shown: true, overlap: 424 },
    "a callback change uses the current receipt without reinstalling focus listeners",
  );
  assert.equal(preopened.listenerCount, 2);
  const receiptsAfterLatestShow = preopened.keyboardLayouts.length;
  oldShow(0, 824);
  preopened.render();
  assert.equal(
    preopened.padding("frame"),
    427,
    "a delayed earlier measurement cannot restore obsolete keyboard geometry",
  );
  assert.equal(
    preopened.keyboardLayouts.length,
    receiptsAfterLatestShow,
    "an obsolete measurement cannot release a parent waiting for its own keyboard layout",
  );
  preopened.show(450);
  const afterHide = preopened.takeMeasurement();
  preopened.hide();
  preopened.render();
  assert.deepEqual(preopened.keyboardLayouts.at(-1), { version: 1, shown: false, overlap: 0 });
  const receiptsAfterHide = preopened.keyboardLayouts.length;
  afterHide(0, 824);
  preopened.render();
  assert.equal(
    preopened.padding("frame"),
    3,
    "a queued show measurement cannot lift the dock after hide",
  );
  assert.equal(preopened.keyboardLayouts.length, receiptsAfterHide);
  preopened.show(492);
  const afterBlur = preopened.takeMeasurement();
  const oldFocusShow = preopened.nativeListeners("keyboardDidShow")[0];
  const oldFocusHide = preopened.nativeListeners("keyboardDidHide")[0];
  preopened.blur();
  assert.equal(preopened.listenerCount, 0);
  const updatesAtBlur = preopened.reactUpdates;
  const receiptsAtBlur = preopened.keyboardLayouts.length;
  afterBlur(0, 824);
  preopened.render();
  assert.equal(
    preopened.reactUpdates,
    updatesAtBlur,
    "late native measurement after route blur cannot mutate state",
  );
  assert.equal(
    preopened.keyboardLayouts.length,
    receiptsAtBlur,
    "a blurred frame cannot issue a ready receipt to its parent",
  );
  assert.equal(preopened.padding("frame"), 3);
  preopened.refocus();
  const currentFocus = preopened.takeMeasurement();
  currentFocus(0, 824);
  preopened.render();
  assert.equal(preopened.padding("frame"), 335, "refocus samples the actual still-shown IME");
  const updatesAtRefocus = preopened.reactUpdates;
  const receiptsAtRefocus = preopened.keyboardLayouts.length;
  oldFocusHide({});
  oldFocusShow({ endCoordinates: { screenX: 0, screenY: 0, width: 390, height: 824 } });
  preopened.render();
  assert.equal(
    preopened.pendingMeasurements,
    0,
    "retained native listeners from an old focus cannot request layout work",
  );
  assert.equal(preopened.reactUpdates, updatesAtRefocus);
  assert.equal(preopened.keyboardLayouts.length, receiptsAtRefocus);
  assert.equal(
    preopened.padding("frame"),
    335,
    "old show/hide events cannot alter a newly focused search dock",
  );
  afterBlur(0, 824);
  preopened.render();
  assert.equal(
    preopened.padding("frame"),
    335,
    "old-focus callbacks stay obsolete even after refocus",
  );
  preopened.show(450);
  const afterUnmount = preopened.takeMeasurement();
  preopened.hooks.unmount();
  const receiptsAtUnmount = preopened.keyboardLayouts.length;
  afterUnmount(0, 824);
  assert.equal(preopened.keyboardLayouts.length, receiptsAtUnmount);
  assert.equal(preopened.hooks.lateWrites, 0);
  assert.equal(preopened.listenerCount, 0);
}

{
  const bounded = fixture("android", { avoidAndroidKeyboard: true });
  bounded.show(-100, 924);
  bounded.takeMeasurement()(0, 200);
  bounded.render();
  assert.equal(bounded.padding("frame"), 203, "avoidance is bounded by the measured frame height");
  bounded.show(492, 0);
  bounded.render();
  assert.equal(bounded.pendingMeasurements, 0);
  assert.equal(bounded.padding("frame"), 3, "hardware/no-IME input never reserves keyboard height");
  bounded.show(492);
  bounded.takeMeasurement()(NaN, 824);
  bounded.render();
  assert.equal(bounded.padding("frame"), 3, "invalid native coordinates do not poison layout");
  bounded.layout();
  bounded.takeMeasurement()(0, 0);
  bounded.render();
  assert.equal(bounded.padding("frame"), 3);
  bounded.show(Number.NaN, 100);
  bounded.render();
  assert.equal(bounded.pendingMeasurements, 0);
  assert.equal(bounded.padding("frame"), 3);
  bounded.hooks.unmount();
}
console.log(
  "PASS search keyboard motion: unchanged iOS native move/interactive/end worklets; opt-in Android actual-overlap avoidance, supplied resize/pan bounds without double lift, edge/unknown capabilities, already-open/height/rotation/repeated cycles, original padding and stale-focus/event/measurement/unmount guards",
);
