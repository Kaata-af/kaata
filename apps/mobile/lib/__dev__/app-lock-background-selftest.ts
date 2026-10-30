// Exercise native animation boundaries without timers, devices or ledger data.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { colors } from "../colors";

type Animation = {
  kind: string;
  options?: Record<string, any>;
  children?: Animation[];
  started: number;
  stopped: number;
  start: (...args: any[]) => void;
  stop: () => void;
};

function fixture(os: "ios" | "android", version: number | string = os === "ios" ? 17 : 31) {
  const hooks = uiHooks();
  const platform = { OS: os, Version: version };
  let reducedMotion = false;
  let reducedTransparency = false;
  let transparencyReads = 0;
  const animations: Animation[] = [];
  const values: FakeValue[] = [];
  let renderCount = 0;
  class FakeValue {
    value: number;
    sets: number[] = [];
    stops = 0;
    interpolations: Record<string, any>[] = [];
    constructor(value: number) {
      this.value = value;
      values.push(this);
    }
    setValue(value: number) {
      this.value = value;
      this.sets.push(value);
    }
    stopAnimation(callback?: (value: number) => void) {
      this.stops++;
      callback?.(this.value);
    }
    interpolate(config: Record<string, any>) {
      this.interpolations.push(config);
      return { owner: this, ...config };
    }
    addListener() {
      assert.fail("Decorative motion must not stream native frames to JavaScript");
    }
    removeAllListeners() {}
  }
  const makeAnimation = (kind: string, options?: Record<string, any>, children?: Animation[]) => {
    const animation: Animation = {
      kind,
      options,
      children,
      started: 0,
      stopped: 0,
      start: () => {
        animation.started++;
      },
      stop: () => {
        animation.stopped++;
      },
    };
    animations.push(animation);
    return animation;
  };
  const accessibilityListeners = new Map<string, (value: boolean) => void>();
  const native = {
    Platform: platform,
    View: "View",
    Animated: {
      View: "AnimatedView",
      Value: FakeValue,
      timing: (_value: FakeValue, options: Record<string, any>) => makeAnimation("timing", options),
      sequence: (children: Animation[]) => makeAnimation("sequence", undefined, children),
      parallel: (children: Animation[]) => makeAnimation("parallel", undefined, children),
      loop: (child: Animation, options?: Record<string, any>) =>
        makeAnimation("loop", options, [child]),
    },
    Easing: {
      inOut: (value: unknown) => value,
      ease: "ease",
      sin: "sin",
      quad: "quad",
      linear: "linear",
    },
    AccessibilityInfo: {
      isReduceTransparencyEnabled: async () => {
        transparencyReads++;
        return reducedTransparency;
      },
      addEventListener: (event: string, callback: (value: boolean) => void) => {
        accessibilityListeners.set(event, callback);
        return { remove: () => accessibilityListeners.delete(event) };
      },
    },
    StyleSheet: {
      create: (value: any) => value,
      flatten: flattenStyle,
      absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
      absoluteFillObject: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
  const Component = compileUI("../../components/AppLockBackground", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": native,
    "react-native-svg": {
      __esModule: true,
      default: "Svg",
      Defs: "Defs",
      RadialGradient: "RadialGradient",
      Rect: "Rect",
      Stop: "Stop",
    },
    "../lib/reduced-motion": { useReducedMotion: () => reducedMotion },
    "./SheetBackdrop": {
      useSheetMotionPreference: () => false,
      useSheetTransparencyPreference: () => false,
    },
    "../lib/colors": { colors },
  }).AppLockBackground;
  let props: any = { active: true };
  const render = (patch: Record<string, any> = {}) => {
    props = { ...props, ...patch };
    return hooks.render(() => {
      renderCount++;
      return Component(props);
    });
  };
  return {
    hooks,
    render,
    animations,
    values,
    native,
    get renderCount() {
      return renderCount;
    },
    get transparencyReads() {
      return transparencyReads;
    },
    get transparencyListenerCount() {
      return accessibilityListeners.size;
    },
    setReducedMotion(value: boolean) {
      reducedMotion = value;
      render();
    },
    setReducedTransparency(value: boolean) {
      reducedTransparency = value;
      accessibilityListeners.get("reduceTransparencyChanged")?.(value);
      render();
    },
  };
}

const loops = (f: ReturnType<typeof fixture>) =>
  f.animations.filter((animation) => animation.kind === "loop");
const startedLoops = (f: ReturnType<typeof fixture>) =>
  loops(f).filter((animation) => animation.started > 0);
const glowLayers = (tree: any) =>
  nodes(tree).filter((node) => node.props.testID?.startsWith("app-lock-glow-"));
const colorChroma = (hex: string) => {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return Math.max(...channels) - Math.min(...channels);
};

async function main() {
  for (const os of ["ios", "android"] as const) {
    const f = fixture(os);
    f.render();
    const background = nodes(f.hooks.tree).find(
      (node) => node.props.testID === "app-lock-background",
    )!;
    assert.ok(background);
    assert.equal(background.props.pointerEvents, "none");
    assert.equal(background.props.accessibilityElementsHidden, true);
    assert.equal(background.props.importantForAccessibility, "no-hide-descendants");
    assert.ok(
      !nodes(background).some((node) =>
        [
          "Text",
          "Pressable",
          "TextInput",
          "BlurView",
          "BlurTargetView",
          "BalanceCardGlass",
        ].includes(node.type),
      ),
      "The private decoration contains no content, controls or live blur capture",
    );
    const glows = glowLayers(background);
    assert.equal(glows.length, 3, "Distinct color blooms keep the lock material visible");
    assert.deepEqual(glows.map((node) => node.props.testID).sort(), [
      "app-lock-glow-blue",
      "app-lock-glow-mint",
      "app-lock-glow-warm",
    ]);
    const oldMaterialChroma = Math.max(
      colorChroma(colors.entryActionReceived),
      colorChroma(colors.entryActionGave),
    );
    for (const glow of glows) {
      assert.equal(glow.type, "AnimatedView");
      assert.ok(nodes(glow).some((node) => node.type === "Svg"));
      const gradient = nodes(glow).find((node) => node.type === "RadialGradient")!;
      assert.ok(gradient, "Soft radial edges are static vector paint");
      const stops = nodes(gradient).filter((node) => node.type === "Stop");
      assert.ok(stops.length >= 2);
      assert.ok(
        colorChroma(stops[0].props.stopColor) > oldMaterialChroma,
        "Lock colors are richer than the muted shared card palette",
      );
      assert.ok(Number(stops[0].props.stopOpacity) >= 0.4, "The bloom remains visibly colored");
      assert.equal(
        Number(stops.at(-1)!.props.stopOpacity),
        0,
        "Bloom edges dissolve without a seam",
      );
    }
    const pearl = nodes(background).find(
      (node) => node.type === "RadialGradient" && node.props.id === "lock-pearl",
    )!;
    assert.ok(pearl, "A stationary bright center protects text readability");
    assert.equal(startedLoops(f).length, 1, "An active lock screen owns one native loop");
    const timing = f.animations.filter((animation) => animation.kind === "timing");
    assert.equal(
      timing.length,
      2,
      "The decoration drifts out and back rather than adding per-frame work",
    );
    for (const animation of timing) {
      assert.equal(animation.options?.useNativeDriver, true);
      assert.equal(
        animation.options?.isInteraction,
        false,
        "Decorative motion must not block interaction work",
      );
      assert.ok(
        animation.options?.duration >= 8000,
        "The ambient cycle is slow, not a distracting pulse",
      );
    }
    assert.equal(
      loops(f)[0].options?.resetBeforeIteration,
      false,
      "Pause/resume must not snap to the initial frame",
    );
    const style = flattenStyle(background.props.style);
    assert.equal(style.position, "absolute");
    assert.equal(
      style.backgroundColor,
      colors.bgBalanceGlass,
      "The decoration never reveals underlying private content",
    );
    assert.ok(style.top < 0 && style.bottom < 0 && style.left < 0 && style.right < 0);
    assert.equal(style.transform, undefined, "The opaque backing and pearl center stay still");
    const paths = new Set<string>();
    for (const glow of glows) {
      const transforms = flattenStyle(glow.props.style).transform as Record<string, any>[];
      const range = (kind: string): number[] => {
        const interpolation = transforms.find((transform) => kind in transform)![kind];
        assert.equal(interpolation.owner, f.values[0], "Every layer shares one native clock");
        return interpolation.outputRange;
      };
      const x = range("translateX"),
        y = range("translateY"),
        scale = range("scale");
      assert.ok(Math.max(...x.map(Math.abs)) <= Math.min(-style.left, -style.right));
      assert.ok(Math.max(...y.map(Math.abs)) <= Math.min(-style.top, -style.bottom));
      assert.ok(Math.min(...scale) >= 1, "Movement must never shrink below edge-covering size");
      assert.ok(Math.max(...scale) <= 1.08, "Ambient scaling stays subtle");
      paths.add(JSON.stringify([x, y, scale]));
    }
    assert.equal(paths.size, 3, "The colors drift differently rather than moving as one flat wash");
    assert.equal(f.renderCount, 1, "Starting native motion does not schedule a React frame loop");

    f.values[0].value = 0.63;
    f.render({ active: false });
    assert.equal(loops(f)[0].stopped, 1, "Inactive/background lock screens release their loop");
    assert.equal(f.values[0].value, 0.63, "Pausing does not jump the decoration back to its start");
    f.render({ active: true });
    assert.equal(startedLoops(f).length, 2);
    assert.equal(f.values[0].value, 0.63);
    f.setReducedMotion(true);
    assert.equal(loops(f)[1].stopped, 1);
    assert.equal(f.values[0].value, 0.5);
    assert.equal(glowLayers(f.hooks.tree).length, 3, "Reduce Motion preserves the static color");
    const startedBeforeReduced = startedLoops(f).length;
    f.render({ active: false });
    f.render({ active: true });
    assert.equal(
      startedLoops(f).length,
      startedBeforeReduced,
      "OS Reduce Motion is honored outside the sheet provider",
    );
    f.setReducedMotion(false);
    assert.equal(startedLoops(f).length, startedBeforeReduced + 1);
    const last = loops(f).at(-1)!;
    f.hooks.unmount();
    assert.equal(last.stopped, 1);
    await settleUI();
    assert.equal(f.hooks.lateWrites, 0);
    assert.equal(f.transparencyListenerCount, 0);
  }

  for (const version of [24, 29, 30, "unknown"]) {
    const f = fixture("android", version);
    f.render();
    assert.equal(
      startedLoops(f).length,
      0,
      "The legacy opaque Android fallback has no pointless animation",
    );
    assert.equal(f.transparencyReads, 0, "Android does not call iOS-only transparency APIs");
    f.hooks.unmount();
  }

  const transparency = fixture("ios");
  transparency.render();
  // Start the initial query while false, then let a newer native event own
  // the preference before that promise can apply its stale initial answer.
  await Promise.resolve();
  transparency.setReducedTransparency(true);
  await settleUI();
  transparency.render();
  assert.equal(startedLoops(transparency).length, 1);
  assert.equal(loops(transparency)[0].stopped, 1);
  assert.equal(transparency.values[0].value, 0.5);
  assert.equal(glowLayers(transparency.hooks.tree).length, 0);
  assert.equal(
    nodes(transparency.hooks.tree).filter((node) => node.type === "RadialGradient").length,
    1,
    "Reduce Transparency keeps opaque material and its quiet pearl center",
  );
  assert.equal(transparency.transparencyListenerCount, 1);
  transparency.setReducedTransparency(false);
  assert.equal(startedLoops(transparency).length, 2);
  assert.equal(glowLayers(transparency.hooks.tree).length, 3);
  transparency.hooks.unmount();
  assert.equal(transparency.transparencyListenerCount, 0);

  const inactive = fixture("ios");
  inactive.render({ active: false });
  assert.equal(startedLoops(inactive).length, 0);
  inactive.hooks.unmount();
  await settleUI();
  assert.equal(inactive.hooks.lateWrites, 0);
  const initiallyReduced = fixture("ios");
  initiallyReduced.setReducedMotion(true);
  assert.equal(
    startedLoops(initiallyReduced).length,
    0,
    "Known OS Reduce Motion prevents the first native loop",
  );
  initiallyReduced.hooks.unmount();
  await settleUI();
  assert.equal(initiallyReduced.hooks.lateWrites, 0);

  // Existing Home/customer card material has no animation API; lock-only
  // motion must not make every balance card own an infinite native loop.
  for (const os of ["ios", "android"] as const) {
    const hooks = uiHooks();
    let contextReducedTransparency = false;
    const material = compileUI("../../components/BalanceCardGlass", {
      react: { ...hooks.react, memo: (component: any) => component },
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "react-native": {
        Platform: { OS: os, Version: 31 },
        View: "View",
        StyleSheet: { create: (value: any) => value, absoluteFill: { position: "absolute" } },
        Animated: {
          loop: () => assert.fail("Ordinary balance cards remain static"),
          timing: () => assert.fail("Ordinary balance cards remain static"),
        },
      },
      "expo-blur": { BlurTargetView: "BlurTargetView", BlurView: "BlurView" },
      "../lib/colors": { colors },
      "./SheetBackdrop": { useSheetTransparencyPreference: () => contextReducedTransparency },
    }).BalanceCardGlass;
    const tree = hooks.render(() => material({}));
    assert.ok(nodes(tree).some((node) => node.type === "BlurView"));
    assert.ok(!nodes(tree).some((node) => node.type === "AnimatedView"));
    const explicitOpaque = hooks.render(() => material({ reducedTransparency: true }));
    assert.ok(!nodes(explicitOpaque).some((node) => node.type === "BlurView"));
    contextReducedTransparency = true;
    const contextualOpaque = hooks.render(() => material({}));
    assert.ok(
      !nodes(contextualOpaque).some((node) => node.type === "BlurView"),
      "Ordinary cards still honor their provider preference by default",
    );
    hooks.unmount();
  }
  console.log(
    "PASS lock background: richer static radial color, independent native-only gentle drift, quiet readable center, overscan, inactive/accessibility/legacy Android stops, no live blur or frame callbacks, cleanup/privacy and unchanged balance cards",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
