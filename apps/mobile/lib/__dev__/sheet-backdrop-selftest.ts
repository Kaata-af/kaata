// Native blur pixels still require phones. This executes the real provider,
// backdrop and animation hook across accessibility and interrupted lifetimes.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, uiHooks, settleUI } from "./ui-fixture";

async function main() {
  const hooks = uiHooks();
  let os = "android",
    sdk = 35;
  const motion = deferred<boolean>(),
    transparency = deferred<boolean>();
  const listeners = new Map<string, (value: boolean) => void>();
  let context: any;
  const module = compileUI("../../components/SheetBackdrop", {
    react: {
      ...hooks.react,
      createContext: (value: any) => (context = { value, Provider: "Provider" }),
      useContext: (ctx: any) => ctx.value,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "expo-blur": { BlurTargetView: "BlurTargetView", BlurView: "BlurView" },
    "react-native": {
      View: "View",
      Pressable: "Pressable",
      StyleSheet: { absoluteFill: { position: "absolute" } },
      Platform: {
        get OS() {
          return os;
        },
        get Version() {
          return sdk;
        },
      },
      AccessibilityInfo: {
        isReduceMotionEnabled: () => motion.promise,
        isReduceTransparencyEnabled: () => transparency.promise,
        addEventListener: (name: string, callback: (value: boolean) => void) => {
          listeners.set(name, callback);
          return { remove: () => listeners.delete(name) };
        },
      },
    },
    "../lib/blur": require("../blur"),
    "../lib/i18n": { t: (key: string) => key },
  });
  const provider = () => {
    const tree = hooks.render(() => module.SheetBlurProvider({ children: "app" }));
    context.value = tree.props.value;
    return tree;
  };
  let tree = provider();
  const target = nodes(tree).find((node) => node.type === "BlurTargetView")!;
  assert.equal(target.props.collapsable, false, "native target cannot be optimized away");
  target.props.ref.current = { nativeView: true };
  let dismisses = 0;
  const backdrop = () => module.SheetBackdrop({ onDismiss: () => dismisses++ });
  let overlay = backdrop();
  const blur = nodes(overlay).find((node) => node.type === "BlurView")!;
  assert.equal(blur.props.blurTarget, target.props.ref, "Android blurs the actual root target");
  assert.equal(blur.props.blurMethod, "dimezisBlurViewSdk31Plus");
  const dismiss = nodes(overlay).find((node) => node.type === "Pressable")!;
  dismiss.props.onPress();
  assert.equal(dismisses, 1);
  // Screen readers keep a way out of short menus (audit #28): the dismiss
  // target is a labelled button outside the hidden blur and tint.
  assert.equal(dismiss.props.accessibilityLabel, "common.close");
  assert.equal(dismiss.props.accessibilityRole, "button");
  assert.notEqual(overlay.props.accessibilityElementsHidden, true);
  const hidden = nodes(overlay).find((node) => node.props?.accessibilityElementsHidden)!;
  assert.ok(
    nodes(hidden).some((node) => node.type === "BlurView"),
    "the blur stays hidden",
  );
  assert.equal(
    nodes(hidden).some((node) => node.type === "Pressable"),
    false,
    "the dismiss button is not inside the hidden layer",
  );
  sdk = 30;
  assert.equal(
    nodes(backdrop()).some((node) => node.type === "BlurView"),
    false,
    "old Android has deliberate inexpensive fallback",
  );
  listeners.get("reduceMotionChanged")!(false);
  provider();
  motion.resolve(true);
  await settleUI();
  provider();
  assert.equal(
    module.useSheetMotionPreference(),
    false,
    "a late getter cannot overwrite a newer accessibility event",
  );
  listeners.get("reduceMotionChanged")!(true);
  provider();
  assert.equal(module.useSheetMotionPreference(), true);
  hooks.unmount();
  assert.equal(listeners.size, 0);

  // A fresh iOS provider subscribes to Reduce Transparency and removes blur.
  const iosHooks = uiHooks();
  const iosModule = compileUI("../../components/SheetBackdrop", {
    react: {
      ...iosHooks.react,
      createContext: (value: any) => (context = { value, Provider: "Provider" }),
      useContext: (ctx: any) => ctx.value,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-blur": { BlurTargetView: "BlurTargetView", BlurView: "BlurView" },
    "react-native": {
      View: "View",
      Pressable: "Pressable",
      StyleSheet: { absoluteFill: {} },
      Platform: { OS: "ios" },
      AccessibilityInfo: {
        isReduceMotionEnabled: async () => false,
        isReduceTransparencyEnabled: () => transparency.promise,
        addEventListener: (name: string, callback: (value: boolean) => void) => {
          listeners.set(name, callback);
          return { remove: () => listeners.delete(name) };
        },
      },
    },
    "../lib/blur": require("../blur"),
    "../lib/i18n": { t: (key: string) => key },
  });
  const iosProvider = () => {
    const tree = iosHooks.render(() => iosModule.SheetBlurProvider({ children: "app" }));
    context.value = tree.props.value;
  };
  iosProvider();
  assert.ok(
    nodes(iosModule.SheetBackdrop({ onDismiss() {} })).some((node) => node.type === "BlurView"),
  );
  transparency.resolve(true);
  await settleUI();
  iosProvider();
  assert.equal(
    nodes(iosModule.SheetBackdrop({ onDismiss() {} })).some((node) => node.type === "BlurView"),
    false,
  );
  listeners.get("reduceTransparencyChanged")!(false);
  iosProvider();
  assert.ok(
    nodes(iosModule.SheetBackdrop({ onDismiss() {} })).some((node) => node.type === "BlurView"),
  );
  iosHooks.unmount();
  assert.equal(listeners.size, 0);

  const animated = uiHooks();
  let visible = false,
    reduced = false,
    nextFrame = 0;
  const frames = new Map<number, () => void>();
  const animations: { stopped: boolean; callback?: (result: { finished: boolean }) => void }[] = [];
  class Value {
    constructor(public value: number) {}
    stopAnimation() {}
    setValue(value: number) {
      this.value = value;
    }
  }
  const animation = () => {
    const item = { stopped: false } as (typeof animations)[number];
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
  };
  const hook = compileUI(
    "../use-overlay-animation",
    {
      react: animated.react,
      "react-native": {
        Animated: { Value, timing: animation, spring: animation, parallel: animation },
      },
      "../components/SheetBackdrop": { useSheetMotionPreference: () => reduced },
    },
    {
      requestAnimationFrame: (callback: () => void) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
      cancelAnimationFrame: (frame: number) => frames.delete(frame),
    },
  );
  const render = () =>
    animated.render(() => ({ type: "Hook", props: hook.useOverlayAnimation(visible) })).props;
  assert.equal(render().rendered, false);
  visible = true;
  assert.equal(render().rendered, true);
  visible = false;
  render();
  assert.equal(frames.size, 0, "closing before entrance cancels its queued frame");
  const close = animations.at(-1)!;
  visible = true;
  render();
  close.callback?.({ finished: true });
  assert.equal(render().rendered, true, "a stale finished close cannot remove reopened sheet");
  reduced = true;
  const still = render();
  assert.equal(still.opacity.value, 1);
  assert.equal(still.position.value, 0);
  assert.equal(frames.size, 0);
  visible = false;
  assert.equal(render().rendered, false, "Reduce Motion dismisses immediately");
  reduced = false;
  visible = true;
  render();
  animated.unmount();
  assert.equal(frames.size, 0, "unmount cancels pending entrance");
  close.callback?.({ finished: true });
  assert.equal(animated.lateWrites, 0);
  console.log(
    "PASS: SDK57 native target, Android performance fallback, iOS Reduce Transparency, Reduce Motion, dismiss targets and canceled/reopened/unmounted overlay lifetimes",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
