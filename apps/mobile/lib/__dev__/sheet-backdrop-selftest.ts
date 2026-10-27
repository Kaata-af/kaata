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
  const backdrop = (props: { blurTarget?: { current: any }; disabled?: boolean } = {}) =>
    module.SheetBackdrop({ onDismiss: () => dismisses++, ...props });
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
  assert.equal(dismiss.props.disabled, false, "existing sheet dismiss targets remain enabled");
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
  const localTarget: { current: any } = { current: { nativeView: "home body and footer" } };
  const localBackdrop = backdrop({ blurTarget: localTarget, disabled: true });
  const localBlur = nodes(localBackdrop).find((node) => node.type === "BlurView")!;
  assert.equal(
    localBlur.props.blurTarget,
    localTarget,
    "a local overlay blurs its supplied sibling",
  );
  assert.notEqual(
    localBlur.props.blurTarget,
    target.props.ref,
    "the ancestor is never substituted",
  );
  assert.equal(localBlur.props.intensity, blur.props.intensity);
  assert.equal(localBlur.props.tint, blur.props.tint);
  assert.equal(localBlur.props.blurMethod, blur.props.blurMethod);
  const blockedDismiss = nodes(localBackdrop).find((node) => node.type === "Pressable")!;
  assert.equal(blockedDismiss.props.disabled, true, "busy popovers disable their outside target");
  assert.deepEqual(blockedDismiss.props.accessibilityState, { disabled: true });
  assert.equal(blockedDismiss.props.accessibilityLabel, "common.close");
  localTarget.current = null;
  const waitingForTarget = backdrop({ blurTarget: localTarget });
  assert.equal(
    nodes(waitingForTarget).some((node) => node.type === "BlurView"),
    false,
    "an unmounted local Android target falls back to tint despite an available ancestor",
  );
  const fallbackDismiss = nodes(waitingForTarget).find((node) => node.type === "Pressable")!;
  assert.equal(fallbackDismiss.props.disabled, false);
  fallbackDismiss.props.onPress();
  assert.equal(dismisses, 2, "a target-not-ready fallback retains its accessible dismiss action");
  localTarget.current = { nativeView: "mounted local target" };
  assert.equal(
    nodes(backdrop({ blurTarget: localTarget })).find((node) => node.type === "BlurView")!.props
      .blurTarget,
    localTarget,
    "a later render can use the mounted local target without changing its ref identity",
  );
  assert.equal(
    nodes(backdrop()).find((node) => node.type === "BlurView")!.props.blurTarget,
    target.props.ref,
    "omitting the override keeps other sheets on the global target",
  );
  sdk = 30;
  assert.equal(
    nodes(backdrop()).some((node) => node.type === "BlurView"),
    false,
    "old Android has deliberate inexpensive fallback",
  );
  assert.equal(
    nodes(backdrop({ blurTarget: localTarget })).some((node) => node.type === "BlurView"),
    false,
    "a local target does not bypass the older Android performance fallback",
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
  assert.equal(
    nodes(iosModule.SheetBackdrop({ onDismiss() {}, blurTarget: localTarget })).find(
      (node) => node.type === "BlurView",
    )!.props.blurTarget,
    localTarget,
    "iOS receives the local override without changing its blur presentation",
  );
  transparency.resolve(true);
  await settleUI();
  iosProvider();
  assert.equal(
    nodes(iosModule.SheetBackdrop({ onDismiss() {} })).some((node) => node.type === "BlurView"),
    false,
  );
  assert.equal(
    nodes(iosModule.SheetBackdrop({ onDismiss() {}, blurTarget: localTarget })).some(
      (node) => node.type === "BlurView",
    ),
    false,
    "Reduce Transparency also suppresses a supplied local blur target",
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
    from = 600,
    scale = false,
    nextFrame = 0;
  const frames = new Map<number, () => void>();
  const animations: {
    kind: string;
    args: any[];
    started: boolean;
    stopped: boolean;
    callback?: (result: { finished: boolean }) => void;
  }[] = [];
  class Value {
    constructor(public value: number) {}
    stopAnimation() {}
    setValue(value: number) {
      this.value = value;
    }
  }
  const animation =
    (kind: string) =>
    (...args: any[]) => {
      const item = { kind, args, started: false, stopped: false } as (typeof animations)[number];
      animations.push(item);
      return {
        start: (callback: any) => {
          item.started = true;
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
        Animated: {
          Value,
          timing: animation("timing"),
          spring: animation("spring"),
          parallel: animation("parallel"),
        },
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
    animated.render(() => ({ type: "Hook", props: hook.useOverlayAnimation(visible, from, scale) }))
      .props;
  const runFrames = () => {
    for (const [id, work] of [...frames]) {
      frames.delete(id);
      work();
    }
  };
  assert.equal(render().rendered, false);
  assert.equal(animations.length, 0, "an initially closed overlay starts no exit animation");
  assert.equal(frames.size, 0, "an initially closed overlay schedules no entrance frame");
  from = 420;
  scale = true;
  let closed = render();
  assert.equal(closed.position.value, 420, "closed geometry changes update the hidden endpoint");
  assert.equal(closed.opacity.value, 0);
  reduced = true;
  render();
  reduced = false;
  render();
  assert.equal(animations.length, 0, "closed geometry and motion changes construct no animations");
  assert.equal(frames.size, 0);

  // A sheet that has actually opened still owns its exit until native completion.
  visible = true;
  assert.equal(render().rendered, true);
  assert.equal(frames.size, 1);
  runFrames();
  assert.equal(
    animations.at(-1)!.started,
    true,
    "a real entrance starts after its scheduled frame",
  );
  visible = false;
  assert.equal(
    render().rendered,
    true,
    "an animated exit keeps its sheet mounted until completion",
  );
  const completedClose = animations.at(-1)!;
  const closeTimings = animations.slice(-3, -1);
  assert.deepEqual(
    closeTimings.map((item) => item.kind),
    ["timing", "timing"],
  );
  assert.deepEqual(
    closeTimings.map((item) => item.args[1].duration),
    [140, 140],
    "scale overlays preserve their real exit duration",
  );
  assert.deepEqual(
    closeTimings.map((item) => item.args[1].toValue),
    [0, 420],
  );
  assert.ok(closeTimings.every((item) => item.args[1].useNativeDriver === true));
  completedClose.callback?.({ finished: true });
  assert.equal(render().rendered, false);
  const afterCompletedClose = animations.length;
  from = 510;
  scale = false;
  closed = render();
  assert.equal(closed.position.value, 510);
  reduced = true;
  render();
  reduced = false;
  render();
  assert.equal(
    animations.length,
    afterCompletedClose,
    "an already completed exit is not restarted by offscreen geometry or preferences",
  );

  // Even an entrance canceled before its first frame counts as presented.
  visible = true;
  assert.equal(render().rendered, true);
  visible = false;
  assert.equal(render().rendered, true);
  assert.equal(frames.size, 0, "closing before entrance cancels its queued frame");
  const close = animations.at(-1)!;
  assert.deepEqual(
    animations.slice(-3, -1).map((item) => item.args[1].duration),
    [160, 180],
    "ordinary sheets preserve both real exit durations",
  );
  visible = true;
  render();
  assert.equal(close.stopped, true, "reopening stops the prior native exit");
  close.callback?.({ finished: true });
  assert.equal(render().rendered, true, "a stale finished close cannot remove reopened sheet");
  reduced = true;
  const still = render();
  assert.equal(still.opacity.value, 1);
  assert.equal(still.position.value, 0);
  assert.equal(frames.size, 0);
  const beforeReducedClose = animations.length;
  visible = false;
  assert.equal(render().rendered, false, "Reduce Motion dismisses immediately");
  assert.equal(
    animations.length,
    beforeReducedClose,
    "Reduce Motion never constructs an exit animation",
  );
  reduced = false;
  render();
  assert.equal(
    animations.length,
    beforeReducedClose,
    "turning motion back on while closed does not animate",
  );
  visible = true;
  render();
  animated.unmount();
  assert.equal(frames.size, 0, "unmount cancels pending entrance");
  close.callback?.({ finished: true });
  assert.equal(animated.lateWrites, 0);
  console.log(
    "PASS: SDK58 global/local native targets, disabled dismiss, Android target-readiness/performance fallback, iOS Reduce Transparency, closed overlays schedule no animations, real exit completion, Reduce Motion, dismiss targets and canceled/reopened/unmounted overlay lifetimes",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
