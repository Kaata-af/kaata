// Exercise decorative motion consumers against the system preference. No device,
// account, recovery operation, notification or financial record is accessed.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

class Value {
  writes: number[] = [];
  constructor(public value: number) {}
  setValue(value: number) {
    this.value = value;
    this.writes.push(value);
  }
  interpolate(options: any) {
    return { value: this, options };
  }
}
class Motion {
  started = false;
  stopped = false;
  callback?: (result: { finished: boolean }) => void;
  constructor(
    public kind: string,
    public value?: Value,
    public options?: any,
    public children: Motion[] = [],
  ) {}
  start(callback?: Motion["callback"]) {
    this.started = true;
    this.callback = callback;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.children.forEach((child) => child.stop());
    this.callback?.({ finished: false });
  }
  finish(force = false) {
    if (this.stopped && !force) return;
    this.children.forEach((child) => child.finish(force));
    if (this.value) this.value.setValue(this.options.toValue);
    this.callback?.({ finished: true });
  }
}
function nativeMotion() {
  const motions: Motion[] = [];
  const values: Value[] = [];
  const make = (kind: string, value?: Value, options?: any, children?: Motion[]) => {
    const item = new Motion(kind, value, options, children);
    motions.push(item);
    return item;
  };
  return {
    motions,
    values,
    Animated: {
      Value: class extends Value {
        constructor(value: number) {
          super(value);
          values.push(this);
        }
      },
      View: "AnimatedView",
      timing: (value: Value, options: any) => make("timing", value, options),
      spring: (value: Value, options: any) => make("spring", value, options),
      sequence: (children: Motion[]) => make("sequence", undefined, undefined, children),
      parallel: (children: Motion[]) => make("parallel", undefined, undefined, children),
      loop: (child: Motion) => make("loop", undefined, undefined, [child]),
    },
  };
}
const shared = {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "../lib/colors": { colors: {} },
  "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
  "../lib/direction": {
    useIsRTL: () => false,
    textDir: () => ({}),
    rowDir: () => ({}),
    trackingSafe: () => ({}),
  },
};

// Validation remains visible without a shake; changing the OS preference during
// a shake settles it without replaying the error when normal motion returns.
{
  const hooks = uiHooks(),
    native = nativeMotion();
  let reduced = true;
  const { FormField } = compileUI("../../components/FormField", {
    ...shared,
    react: { ...hooks.react, forwardRef: (fn: any) => fn },
    "react-native": {
      ...native,
      Animated: native.Animated,
      StyleSheet: { create: (v: any) => v },
      Text: "Text",
      TextInput: "Input",
      View: "View",
    },
    "./SheetBackdrop": { useSheetMotionPreference: () => reduced },
    "../lib/design-tokens": { SETTINGS_DISABLED_OPACITY: 0.5 },
  });
  let error: string | null = null;
  const render = () => hooks.render(() => FormField({ label: "Name", error }, null));
  render();
  error = "Required";
  render();
  assert.equal(native.motions.length, 0);
  assert.ok(
    nodes(hooks.tree).some(
      (n) => n.props.accessibilityLiveRegion === "polite" && n.props.children === "Required",
    ),
  );
  reduced = false;
  render();
  assert.equal(native.motions.length, 0, "Enabling motion does not shake an existing error");
  error = null;
  render();
  error = "Again";
  render();
  const shake = native.motions.at(-1)!;
  assert.equal(shake.kind, "sequence");
  reduced = true;
  render();
  assert.equal(shake.stopped, true);
  assert.equal(native.values[0].value, 0);
  const count = native.motions.length;
  reduced = false;
  render();
  assert.equal(native.motions.length, count);
  hooks.unmount();
}

// System Reduce Motion retains actual progress without repeating shimmer.
// Normal shimmer uses a native transform.
{
  const hooks = uiHooks(),
    native = nativeMotion();
  let reduced = true;
  const { RestoreProgress } = compileUI("../../components/RestoreProgress", {
    ...shared,
    react: hooks.react,
    "react-native": {
      Animated: native.Animated,
      Easing: { out: (v: any) => v, inOut: (v: any) => v, cubic: "cubic", ease: "ease" },
      StyleSheet: { create: (v: any) => v },
      Text: "Text",
      View: "View",
    },
    "./SheetBackdrop": { useSheetMotionPreference: () => reduced },
    "../lib/i18n": { t: (key: string) => key },
  });
  let fraction: number | undefined;
  const render = () =>
    hooks.render(() => RestoreProgress({ fraction, label: "Restoring", isRTL: true }));
  render();
  nodes(hooks.tree)
    .find((n) => n.props.onLayout)!
    .props.onLayout({ nativeEvent: { layout: { width: 200 } } });
  render();
  assert.equal(native.motions.length, 0);
  assert.equal(
    native.values[1].value,
    0.5,
    "An unknown progress stage retains a static centered segment",
  );
  fraction = 0.25;
  render();
  assert.equal(native.values[0].value, 0.25);
  assert.deepEqual(hooks.tree.props.accessibilityValue, { min: 0, max: 100, now: 25 });
  fraction = undefined;
  reduced = false;
  render();
  const loop = native.motions.at(-1)!;
  assert.equal(loop.kind, "loop");
  assert.equal(loop.children[0].options.useNativeDriver, true);
  reduced = true;
  render();
  assert.equal(loop.stopped, true);
  assert.equal(native.values[1].value, 0.5);
  hooks.unmount();
}

function toastFixture(initialReduced: boolean) {
  const provider = uiHooks(),
    item = uiHooks(),
    native = nativeMotion();
  let active = provider;
  let reduced = initialReduced;
  const contexts = new Map<object, any>();
  let pan: any;
  const hook =
    (name: keyof typeof provider.react) =>
    (...args: any[]) =>
      (active.react[name] as any)(...args);
  const module = compileUI(
    "../../components/Toast",
    {
      ...shared,
      react: {
        ...Object.fromEntries(Object.keys(provider.react).map((name) => [name, hook(name as any)])),
        useLayoutEffect: hook("useEffect"),
        createContext: (value: any) => {
          const context = { Provider: {} };
          contexts.set(context.Provider, value);
          return context;
        },
        useContext: (context: any) => contexts.get(context.Provider),
      },
      "react-native": {
        Animated: native.Animated,
        AccessibilityInfo: { announceForAccessibility() {} },
        Platform: { OS: "android", select: (value: any) => value.android },
        StyleSheet: { create: (v: any) => v },
        Text: "Text",
        View: "View",
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
      "./SheetBackdrop": { useSheetMotionPreference: () => reduced },
      "react-native-gesture-handler": {
        GestureDetector: "GestureDetector",
        Gesture: {
          Pan: () => {
            const value: any = {};
            for (const name of ["activeOffsetX", "runOnJS", "onUpdate", "onEnd"])
              value[name] = (arg: any) => {
                if (name.startsWith("on")) value[name + "Handler"] = arg;
                return value;
              };
            pan = value;
            return value;
          },
        },
      },
    },
    { setTimeout: () => 1 },
  );
  function renderProvider() {
    active = provider;
    const tree = provider.render(() => module.ToastProvider({ children: jsx("App", {}) }));
    contexts.set(tree.type, tree.props.value);
    contexts.set(tree.props.children.type, tree.props.children.props.value);
    return tree.props.children.props.children[1];
  }
  renderProvider();
  module.useToast().push("Saved");
  const viewport = renderProvider();
  const child = nodes(viewport.type(viewport.props)).find((n) => n.props.toast)!;
  const dismissals: string[] = [];
  const render = () => {
    active = item;
    return item.render(() =>
      child.type({ ...child.props, onDismiss: (id: string) => dismissals.push(id) }),
    );
  };
  render();
  return {
    native,
    item,
    render,
    dismissals,
    get pan() {
      return pan;
    },
    systemPreference(value: boolean) {
      reduced = value;
      render();
    },
  };
}

const staticToast = toastFixture(true);
assert.equal(staticToast.native.motions.length, 0);
assert.equal(staticToast.native.values[0].value, 0);
assert.equal(staticToast.native.values[2].value, 1);
staticToast.pan.onUpdateHandler({ translationX: 25 });
assert.equal(staticToast.native.values[1].value, 25, "Direct touch feedback remains usable");
staticToast.pan.onEndHandler({ translationX: 25, velocityX: 0 });
assert.equal(staticToast.native.values[1].value, 0);
staticToast.pan.onEndHandler({ translationX: 100, velocityX: 0 });
assert.equal(staticToast.dismissals.length, 1);
assert.equal(staticToast.native.motions.length, 0, "Reduced toast dismissal is immediate");
staticToast.item.unmount();

const changedToast = toastFixture(false);
changedToast.native.motions.at(-1)!.finish();
changedToast.pan.onEndHandler({ translationX: 100, velocityX: 0 });
const leaving = changedToast.native.motions.at(-1)!;
changedToast.systemPreference(true);
assert.equal(leaving.stopped, true);
assert.equal(
  changedToast.dismissals.length,
  1,
  "An OS preference change completes pending dismissal",
);
leaving.finish(true);
assert.equal(changedToast.dismissals.length, 1, "A stale completion cannot dismiss twice");
changedToast.item.unmount();

const unmountedToast = toastFixture(false);
unmountedToast.pan.onEndHandler({ translationX: 100, velocityX: 0 });
const pending = unmountedToast.native.motions.at(-1)!;
unmountedToast.item.unmount();
pending.finish(true);
assert.equal(unmountedToast.dismissals.length, 0, "An unmounted toast ignores queued completions");
console.log(
  "PASS system motion consumers: static validation/progress/toasts, native shimmer, live OS preference changes, direct gestures and stale/unmount cleanup",
);
