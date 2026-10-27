// Execute the real keyboard observer and animated style worklets. Native
// keyboard frame delivery and on-device rendering remain physical QA.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

type Event = { height: number; progress: number; duration: number };
type Handler = Record<"onStart" | "onMove" | "onInteractive" | "onEnd", (event: Event) => void>;
type Context = { current: unknown; Provider: { context: Context } };

function fixture(platform: "ios" | "android") {
  const hooks = uiHooks();
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
      "react-native": { Platform: { OS: platform }, View: "View" },
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
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
  }
  const render = (nextShown = shown) => {
    shown = nextShown;
    renders++;
    return hooks.render(() =>
      expand(
        jsx(module.SearchKeyboardProvider, {
          children: [
            jsx(module.SearchKeyboardFrame, {
              testID: "frame",
              style: { flex: 1, paddingBottom: 3 },
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
android.hooks.unmount();
console.log(
  "PASS search keyboard motion: exact native move/interactive/end frames, no start-endpoint jump, cancellation/clamps/instant/no-IME events, UI-only styles and unchanged Android layout",
);
