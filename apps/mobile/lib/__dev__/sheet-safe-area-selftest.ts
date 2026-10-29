import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { compileUI, flattenStyle, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";

// Execute the real shared surface and real sheet callers. Only platform hooks,
// native views and the independently tested animation/gesture boundaries are fake.
// In particular, no native onShow/layout/safe-area callback runs before assertions.
let insets = { top: 59, bottom: 34, left: 0, right: 0 };
let window = { width: 390, height: 844, scale: 3, fontScale: 1 };
let translation = 600;
const pan = () => true;
const platform = { OS: "ios" };
const native = {
  Platform: platform,
  Animated: { View: "AnimatedView" },
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: {
    create: (styles: unknown) => styles,
    flatten: flattenStyle,
    absoluteFill: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
    hairlineWidth: 1 / 3,
  },
  useWindowDimensions: () => window,
};
const safeArea = {
  useSafeAreaInsets: () => insets,
  SafeAreaView: "NativeSafeAreaView",
  // A new provider/window-metric cache would make a passing first-open result
  // depend on remount timing and stop legitimate inset decreases from applying.
  SafeAreaProvider: () => {
    throw new Error("Sheet surfaces consume the existing live root provider");
  },
  initialWindowMetrics: null,
};
const surface = compileUI("../../components/SheetSurface", {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": native,
  "react-native-safe-area-context": safeArea,
}) as typeof import("../../components/SheetSurface");
const fonts = {
  fonts: { sansSemi: "sans", sansMedium: "sans", monoSemi: "mono" },
  monoLineHeight: (_size: number, line: number) => line,
  sansLineHeight: (_size: number, line: number) => line,
};
const tokens = compileUI("../tokens", { "./fonts": fonts });
const style = (node: UINode) => flattenStyle(node.props.style) ?? {};
const renderSurface = (props: Parameters<typeof surface.SheetSurface>[0] = {}) =>
  surface.SheetSurface(props) as UINode;

{
  const onLayout = () => {};
  const ref = { current: null };
  const first = renderSurface({ ref, onLayout, children: "Save" });
  assert.equal(first.type, "View", "first visible render is an ordinary native View");
  assert.equal(style(first).paddingBottom, 34, "home-indicator space exists before native mount");
  assert.equal(first.props.onLayout, onLayout, "view callbacks stay intact");
  assert.equal(first.props.ref, ref, "the native view ref stays intact");
  assert.equal(first.props.children, "Save");
  assert.equal(style(first).minHeight, 0);
  assert.equal(style(first).flexShrink, 1);
}

{
  const padded = renderSurface({
    style: [
      { padding: 7 },
      { paddingHorizontal: 12, paddingVertical: 9 },
      { paddingBottom: 4, paddingLeft: 3, paddingRight: 0 },
    ],
  });
  assert.equal(style(padded).paddingBottom, 38, "explicit bottom padding adds to the inset");
  assert.equal(style(padded).paddingLeft, 3);
  assert.equal(style(padded).paddingRight, 0, "an explicit zero overrides horizontal padding");
  const vertical = renderSurface({ style: { paddingVertical: 11, paddingHorizontal: 5 } });
  assert.equal(style(vertical).paddingBottom, 45);
  assert.equal(style(vertical).paddingLeft, 5);
  const uniform = renderSurface({ style: { padding: 8 } });
  assert.equal(style(uniform).paddingBottom, 42);
  assert.equal(style(uniform).paddingRight, 8);
}

{
  const child = jsx("ScrollView", { children: Array.from({ length: 300 }, (_, i) => String(i)) });
  // The native-boundary fixture represents JSX as UINode, while production
  // correctly requires ReactNode. Keep that adaptation inside this test.
  const props = { maxHeightRatio: 0.75, children: child as unknown as ReactNode };
  const tall = renderSurface(props);
  assert.equal(style(tall).maxHeight, 633);
  assert.equal(tall.props.children, child, "long content remains inside the capped padded surface");
  assert.equal(style(tall).height, undefined, "the cap does not force short sheets to fill it");
  insets = { top: 59, bottom: 34, left: 0, right: 0 };
  window = { ...window, height: 100 };
  const short = renderSurface({ ...props, maxHeightRatio: 0.95 });
  assert.equal(style(short).maxHeight, 29, "the top safe-area allowance wins over the ratio");
  assert.equal(style(short).paddingBottom, 34, "safe padding is part of the outer capped View");
  assert.equal(style(short).minHeight, 0);
  assert.equal(style(short).flexShrink, 1);
  window = { ...window, height: 60 };
  assert.equal(
    style(renderSurface(props)).maxHeight,
    0,
    "an exhausted viewport never yields a negative cap",
  );
}

{
  // Reuse the same module and props: no remount may be needed to rotate, resize,
  // remove a home indicator, or move the notch to either side.
  const props = { maxHeightRatio: 0.75, style: { padding: 2 } };
  window = { ...window, width: 844, height: 390 };
  insets = { top: 0, bottom: 21, left: 59, right: 0 };
  const landscape = renderSurface(props);
  assert.equal(style(landscape).paddingBottom, 23);
  assert.equal(style(landscape).paddingLeft, 61);
  assert.equal(style(landscape).paddingRight, 2);
  assert.equal(style(landscape).maxHeight, 292.5, "height uses the current orientation");
  insets = { top: 0, bottom: 0, left: 0, right: 59 };
  const opposite = renderSurface(props);
  assert.equal(style(opposite).paddingBottom, 2, "valid zero must replace a previous inset");
  assert.equal(style(opposite).paddingLeft, 2);
  assert.equal(style(opposite).paddingRight, 61);
  window = { ...window, height: 280 };
  assert.equal(style(renderSurface(props)).maxHeight, 210, "live window shrink also changes cap");
}

function sheetFixture(name: "BottomSheet" | "OptionSheet") {
  const hooks = uiHooks();
  let dismissed = 0;
  const options = Array.from({ length: 200 }, (_, i) => ({ key: String(i), label: `Choice ${i}` }));
  const module = compileUI(`../../components/${name}`, {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "react-native-safe-area-context": safeArea,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "./SheetSurface": surface,
    "./ProtectedModal": { ProtectedModal: "Modal" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./SheetHandle": { SheetHandle: "SheetHandle" },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: (visible: boolean) => ({
        rendered: visible,
        opacity: 1,
        position: translation,
      }),
    },
    "../lib/use-sheet-drag": {
      useSheetDrag: (_visible: boolean, _position: number, dismiss: () => void) => ({
        dismiss,
        translateY: translation,
        surfacePanHandlers: { onMoveShouldSetResponder: pan },
        panHandlers: {},
        scrollProps: {},
      }),
    },
    "../lib/colors": { colors: require("../colors").colors },
    "../lib/design-tokens": require("../design-tokens"),
    "../lib/direction": {
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
      useIsRTL: () => false,
    },
    "../lib/fonts": fonts,
    "../lib/tokens": tokens,
  });
  const component = module[name];
  const props =
    name === "BottomSheet"
      ? { visible: true, title: "Actions", actions: [{ label: "Save", onPress() {} }] }
      : { visible: true, title: "Choices", options, selected: "0", onSelect() {}, isRTL: false };
  const render = (visible = true) =>
    hooks.render(() => component({ ...props, visible, onDismiss: () => dismissed++ }));
  function inspect(tree: UINode) {
    assert.equal(tree.type, "Modal");
    assert.equal(tree.props.statusBarTranslucent, true);
    assert.equal(
      tree.props.navigationBarTranslucent,
      undefined,
      "Android retains its original modal window bounds",
    );
    assert.equal(tree.props.onShow, undefined, "correct padding does not wait for Modal onShow");
    const moving = nodes(tree).find(
      (node) => node.type === "AnimatedView" && style(node).transform,
    );
    assert.deepEqual(
      style(moving!).transform,
      [{ translateY: translation }],
      "actual sheet translation reaches its moving parent",
    );
    const mounted = nodes(tree).filter((node) => node.type === surface.SheetSurface);
    assert.equal(mounted.length, 1, `${name} uses the actual shared surface`);
    assert.equal(mounted[0].props.onMoveShouldSetResponder, pan);
    assert.equal(mounted[0].props.edges, undefined, "no second native safe-area calculation");
    const output = renderSurface(mounted[0].props);
    assert.equal(output.type, platform.OS === "ios" ? "View" : "NativeSafeAreaView");
    if (platform.OS === "ios") {
      assert.equal(style(output).paddingBottom, insets.bottom);
      assert.equal(style(output).paddingLeft, insets.left);
      assert.equal(style(output).paddingRight, insets.right);
    } else {
      assert.deepEqual(output.props.edges, ["bottom"]);
      assert.equal(style(output).paddingBottom, undefined);
      assert.equal(style(output).paddingLeft, undefined);
      assert.equal(style(output).paddingRight, undefined);
    }
    assert.equal(output.props.onMoveShouldSetResponder, pan, "surface drag remains forwarded");
    if (name === "OptionSheet") {
      assert.equal(
        style(output).maxHeight,
        Math.min(window.height * 0.75, window.height - insets.top - 12),
      );
      assert.equal(nodes(output).filter((node) => node.type === "Pressable").length, 200);
    }
    return output;
  }
  return { render, inspect, dismissals: () => dismissed, unmount: hooks.unmount };
}

for (const name of ["BottomSheet", "OptionSheet"] as const) {
  insets = { top: 59, bottom: 34, left: 0, right: 0 };
  window = { width: 390, height: 844, scale: 3, fontScale: 1 };
  translation = 600;
  const fixture = sheetFixture(name);
  fixture.inspect(fixture.render());
  for (translation of [275, 0, -10, 80, 900]) {
    fixture.inspect(fixture.render());
  }
  assert.equal(fixture.dismissals(), 0, "measuring/animating must not dismiss or invoke actions");
  assert.equal(fixture.render(false), null);
  fixture.inspect(fixture.render(true));
  window = { ...window, width: 844, height: 390, fontScale: 2.6 };
  insets = { top: 0, bottom: 21, left: 59, right: 0 };
  fixture.inspect(fixture.render());
  insets = { top: 0, bottom: 0, left: 0, right: 59 };
  fixture.inspect(fixture.render());
  assert.equal(fixture.render(false), null);
  fixture.inspect(fixture.render(true));
  fixture.unmount();
}
{
  // The physical Android review reported root bottom=0 and a window already
  // excluding the navigation bar. Keep the original native consumer there;
  // adding root insets or forcing a full-window Modal would change its geometry.
  platform.OS = "android";
  insets = { top: 24, bottom: 0, left: 0, right: 0 };
  window = { width: 392, height: 824, scale: 3, fontScale: 1 };
  const original = renderSurface({ maxHeightRatio: 0.75 });
  assert.equal(original.type, "NativeSafeAreaView");
  assert.deepEqual(original.props.edges, ["bottom"]);
  assert.equal(style(original).paddingBottom, undefined, "native Android determines the inset");
  assert.equal(style(original).maxHeight, 618);
  insets = { top: 24, bottom: 48, left: 12, right: 10 };
  const padded = renderSurface({ style: { paddingBottom: 4, paddingLeft: 2, paddingRight: 3 } });
  assert.equal(style(padded).paddingBottom, 4, "root inset must not double-pad native Android");
  assert.equal(style(padded).paddingLeft, 2);
  assert.equal(style(padded).paddingRight, 3);
  for (const name of ["BottomSheet", "OptionSheet"] as const) {
    const fixture = sheetFixture(name);
    fixture.inspect(fixture.render());
    assert.equal(fixture.render(false), null);
    fixture.inspect(fixture.render(true));
    fixture.unmount();
  }
  platform.OS = "ios";
}
console.log(
  "sheet-safe-area: iOS first-open/reopen/transform/live-inset regressions and Android native-safe-area preservation passed through real Surface/BottomSheet/OptionSheet (native boundaries mocked; no physical iPhone reproduction)",
);
