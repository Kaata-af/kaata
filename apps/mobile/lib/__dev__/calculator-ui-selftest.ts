// Real keyboard/controller/arithmetic with native boundaries replaced. Font
// rendering, Yoga layout and native selection still need a phone check.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks, type UINode } from "./ui-fixture";
import * as calculator from "../calculator";
import * as controller from "../calculator-input";
import type { LocaleCode } from "../i18n";
import type { EntryCalculator } from "../../components/EntryCalculator";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node?.props
        ? words(node.props.children)
        : "";
const style = (node: UINode) =>
  flattenStyle(
    typeof node.props.style === "function"
      ? node.props.style({ pressed: false })
      : node.props.style,
  );
const labels: Record<string, Parameters<typeof language.t>[0]> = {
  AC: "calculator.clear",
  sign: "calculator.sign",
  "%": "calculator.percent",
  "/": "calculator.divide",
  "*": "calculator.multiply",
  "-": "calculator.subtract",
  "+": "calculator.add",
  "=": "calculator.equals",
  ".": "calculator.decimal",
  "()": "calculator.parentheses",
  delete: "calculator.delete",
  MC: "calculator.memoryClear",
  MR: "calculator.memoryRecall",
  "M+": "calculator.memoryAdd",
  "M−": "calculator.memorySubtract",
  next: "calculator.nextNote",
};
type Options = {
  os?: "android" | "ios";
  locale?: LocaleCode;
  expression?: string;
  width?: number;
  height?: number;
  fontScale?: number;
  availableHeight?: number;
  footerHeight?: number;
};
function fixture({
  os = "android",
  locale = "en",
  expression = "",
  width = 390,
  height = 844,
  fontScale = 1,
  availableHeight,
  footerHeight,
}: Options = {}) {
  const hooks = uiHooks();
  const changed: controller.CalculatorDraft[] = [],
    recorded: controller.CalculatorRecord[] = [];
  let nextCount = 0,
    cleared = 0,
    draft = controller.calculatorDraft(expression);
  const fonts = compileUI("../fonts", {
    "react-native": { Platform: { OS: os } },
    "@expo-google-fonts/inter": {},
    "@expo-google-fonts/jetbrains-mono": {},
    "@expo-google-fonts/vazirmatn": {},
  });
  const tokens = compileUI("../tokens", { "./fonts": fonts });
  const direction = compileUI("../direction", {
    react: hooks.react,
    "./i18n": { getLocale: () => locale, subscribeLocale: () => () => {} },
    "./bidi": require("../bidi"),
  });
  const translate = (
    key: Parameters<typeof language.t>[0],
    vars?: Record<string, string | number>,
  ) => language.tIn(locale, key, vars);
  const compiled = compileUI("../../components/EntryCalculator", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Ionicon" },
    "react-native": {
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (s: unknown) => s },
      useWindowDimensions: () => ({ width, height, fontScale, scale: 3 }),
    },
    "../lib/colors": require("../colors"),
    "../lib/calculator": calculator,
    "../lib/calculator-input": controller,
    "../lib/direction": direction,
    "../lib/fonts": fonts,
    "../lib/i18n": { t: translate },
    "../lib/tokens": tokens,
  });
  const props: Parameters<typeof EntryCalculator>[0] = {
    draft,
    getDraft: () => draft,
    onChange: (value) => {
      changed.push(value);
      draft = value;
      props.draft = value;
    },
    history: [],
    onRecord: (record) => {
      recorded.push(record);
      props.history = controller.rememberCalculation(props.history, record);
    },
    onClearHistory: () => {
      cleared++;
      props.history = [];
    },
    onNext: () => nextCount++,
    availableHeight,
    footerHeight,
  };
  // Immutable props per render expose stale callbacks just as React does.
  const render = () => hooks.render(() => compiled.EntryCalculator({ ...props }));
  const labelled = (key: Parameters<typeof language.t>[0]) =>
    nodes(hooks.tree).find((node) => node.props.accessibilityLabel === translate(key))!;
  const key = (value: string) =>
    nodes(hooks.tree).find(
      (node) =>
        node.type === "Pressable" &&
        node.props.accessibilityLabel === (value in labels ? translate(labels[value]) : value),
    )!;
  const press = (...values: string[]) => {
    for (const value of values) {
      assert.ok(key(value), `Visible key: ${value}`);
      key(value).props.onPress();
      render();
    }
  };
  const replace = (value: string) => {
    draft = controller.calculatorDraft(value);
    props.draft = draft;
    render();
  };
  render();
  return {
    hooks,
    props,
    translate,
    render,
    labelled,
    key,
    press,
    replace,
    changed,
    recorded,
    get expression() {
      return draft.expression;
    },
    result() {
      return calculator.evaluateCalculation(draft.expression);
    },
    get nextCount() {
      return nextCount;
    },
    get cleared() {
      return cleared;
    },
  };
}
let cases = 0;
const failures: string[] = [];
function check(label: string, run: () => void) {
  try {
    run();
    cases++;
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.stack : error}`);
  }
}
for (const os of ["android", "ios"] as const)
  for (const locale of ["en", "fa", "ps"] as const)
    for (const [width, height, fontScale] of [
      [320, 568, 1],
      [390, 844, 2],
      [844, 390, 1],
    ])
      check(`${os}/${locale}/${width}x${height}/${fontScale}`, () => {
        const f = fixture({ os, locale, width, height, fontScale, expression: "125.50" });
        assert.equal(f.expression, "125.50");
        assert.deepEqual(f.changed, []);
        assert.deepEqual(f.recorded, []);
        for (const value of [...Object.keys(labels), ..."0123456789"])
          assert.ok(f.key(value), value);
        assert.equal(
          nodes(f.hooks.tree).filter((node) =>
            ["Modal", "TextInput", "SheetBackdrop"].includes(node.type),
          ).length,
          0,
        );
        assert.equal(f.labelled("calculator.useAmount"), undefined);
        assert.equal(f.labelled("calculator.close"), undefined);
        assert.equal(style(f.hooks.tree).direction, "ltr", "the whole keypad stays English/LTR");
        for (const [first, values] of [
          ["AC", ["AC", "M+", "M−", "delete"]],
          ["%", ["%", "/", "*", "-"]],
          ["7", ["7", "8", "9", "+"]],
          ["4", ["4", "5", "6", "="]],
          ["1", ["1", "2", "3"]],
          ["0", ["0", "."]],
        ] as const) {
          const row = nodes(f.hooks.tree).find(
            (node) =>
              node.type === "View" &&
              style(node).flexDirection === "row" &&
              nodes(node).includes(f.key(first)) &&
              nodes(node).filter((child) => child.type === "Pressable").length === values.length,
          )!;
          assert.equal(style(row).flexDirection, "row");
          assert.equal(style(row).direction, "ltr", "inherited RTL cannot reverse a row");
          assert.deepEqual(
            nodes(row)
              .filter((node) => node.type === "Pressable")
              .map((node) => node.props.accessibilityLabel),
            values.map((value) => (value in labels ? f.translate(labels[value]) : value)),
          );
        }
        const tools = nodes(f.hooks.tree).find(
          (node) =>
            Array.isArray(node.props.children) &&
            nodes(node.props.children).includes(f.key("MC")) &&
            nodes(node.props.children).length < 20,
        )!;
        assert.equal(style(tools).direction, "ltr");
        const controls = nodes(tools).filter((node) => node.type === "Pressable");
        assert.deepEqual(controls.slice(0, 4).map(words), ["( )", "+/−", "MC", "MR"]);
        for (const [value, glyph] of [
          ["/", "÷"],
          ["*", "×"],
          ["-", "−"],
          ["7", "7"],
        ])
          assert.equal(words(f.key(value)), glyph);
        for (const control of nodes(f.hooks.tree).filter((node) => node.type === "Pressable"))
          assert.ok(
            style(control).minHeight >= 44,
            `44pt target: ${control.props.accessibilityLabel}`,
          );
        const digit = nodes(f.key("7")).find((node) => node.type === "Text")!;
        assert.ok(
          style(f.key("7")).minHeight >= style(digit).lineHeight * fontScale + 8,
          "key targets expand with accessibility text",
        );
        assert.ok(style(f.key("next")).minHeight >= style(f.key("7")).minHeight * 2);
        const slot = (value: string) =>
          nodes(f.hooks.tree).find((node) => node.props.children === f.key(value))!;
        assert.ok(style(slot("0")).flex > style(slot(".")).flex, "zero spans two columns");
        const scroll = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
        assert.equal(scroll.props.keyboardShouldPersistTaps, "always");
        assert.ok(style(scroll).maxHeight > 0 && style(scroll).maxHeight < height);
        for (const text of nodes(f.hooks.tree).filter((node) => node.type === "Text")) {
          const s = style(text);
          assert.equal(s.writingDirection, "ltr");
          if (s.fontFamily?.startsWith("JetBrainsMono") && os === "ios")
            assert.ok(s.lineHeight >= Math.ceil(s.fontSize * 1.32), "real mono metrics fit iOS");
        }
        f.hooks.unmount();
      });
check("measured short landscape leaves room for the amount and preserves full-size keys", () => {
  const f = fixture({ width: 844, height: 390, availableHeight: 280, footerHeight: 65 });
  const panel = () => nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
  assert.equal(style(panel()).maxHeight, 90);
  assert.equal(style(f.key("7")).minHeight, 44);
  assert.equal(
    280 - 65 - 44 - 1 - style(panel()).maxHeight,
    80,
    "the form retains an 80dp viewport below its fixed header",
  );
  assert.equal(panel().props.bounces, false);
  f.labelled("calculator.history").props.onPress();
  f.render();
  const history = nodes(f.hooks.tree).find(
    (node) =>
      node.type === "View" &&
      nodes(node).some((child) => words(child) === f.translate("calculator.historyTitle")),
  )!;
  const historyView = nodes(panel()).find(
    (node) => node.type === "View" && style(node).minHeight !== undefined,
  )!;
  assert.ok(history);
  assert.ok(
    style(historyView).minHeight +
      flattenStyle(panel().props.contentContainerStyle).paddingBottom <=
      style(panel()).maxHeight,
    "empty History does not reserve hidden rows below its visible panel",
  );
  f.hooks.unmount();
});
check("measured footer and toolbar growth reduce the keys without changing the draft", () => {
  const f = fixture({ height: 844, availableHeight: 590, footerHeight: 65, expression: "12+3" });
  const panelHeight = () =>
    style(nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!).maxHeight;
  assert.equal(panelHeight(), 320);
  f.props.footerHeight = 89;
  f.render();
  assert.equal(panelHeight(), 296, "Save's measured extra height is reserved once");
  const tools = nodes(f.hooks.tree).find((node) => node.type === "View" && node.props.onLayout)!;
  tools.props.onLayout({ nativeEvent: { layout: { height: 64 } } });
  f.render();
  assert.equal(panelHeight(), 276, "a taller utility row uses its real layout height");
  f.props.availableHeight = 690;
  f.render();
  assert.equal(panelHeight(), 345, "extra space stops at the natural six-row height");
  assert.equal(f.expression, "12+3");
  assert.deepEqual(f.changed, []);
  f.hooks.unmount();
});
check("large text retains readable keys and budgets wrapped command feedback", () => {
  const f = fixture({
    os: "ios",
    width: 320,
    height: 844,
    fontScale: 2,
    availableHeight: 650,
    footerHeight: 65,
  });
  const panelHeight = () =>
    style(nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!).maxHeight;
  const normalHeight = panelHeight();
  assert.equal(style(f.key("7")).minHeight, 70);
  assert.equal(normalHeight, 380);
  f.press("MR");
  assert.ok(panelHeight() < normalHeight, "feedback consumes actual keyboard space");
  const feedback = nodes(f.hooks.tree).find((node) => node.type === "Text" && node.props.onLayout)!;
  feedback.props.onLayout({ nativeEvent: { layout: { height: 80 } } });
  f.render();
  assert.equal(panelHeight(), 300, "wrapped localized feedback preserves the form reserve");
  f.press("MC");
  assert.equal(panelHeight(), normalHeight, "clearing feedback returns its space to the keys");
  assert.equal(style(f.key("7")).minHeight, 70, "layout never shrinks the text or touch target");
  const lateLayout = feedback.props.onLayout;
  f.hooks.unmount();
  lateLayout({ nativeEvent: { layout: { height: 100 } } });
  assert.equal(f.hooks.lateWrites, 0);
});
check("tablets center the controls while leaving the keyboard background full width", () => {
  const f = fixture({ width: 1024, height: 1366, availableHeight: 1100, footerHeight: 65 });
  const panel = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
  const tools = nodes(f.hooks.tree).find((node) => node.type === "View" && node.props.onLayout)!;
  for (const region of [panel, tools]) {
    assert.equal(style(region).maxWidth, 640);
    assert.equal(style(region).width, "100%");
    assert.equal(style(region).alignSelf, "center");
  }
  assert.equal(style(f.hooks.tree).maxWidth, undefined);
  assert.equal(style(panel).maxHeight, 345, "tablet whitespace never stretches the six key rows");
  f.hooks.unmount();
});
check("the keyboard changes smoothly around the former 700dp breakpoint", () => {
  const heights = [699, 700, 701].map((height) => {
    const f = fixture({ height, availableHeight: height - 140, footerHeight: 65 });
    const panel = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
    const value = style(panel).maxHeight;
    f.hooks.unmount();
    return value;
  });
  assert.deepEqual(heights, [289, 290, 291]);
});
check("unmeasured and invalid layout inputs retain a finite usable fallback", () => {
  const f = fixture({ height: 568, availableHeight: 0, footerHeight: Number.NaN });
  const panelHeight = () =>
    style(nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!).maxHeight;
  const fallback = panelHeight();
  assert.ok(Number.isFinite(fallback) && fallback >= 44 && fallback < 297);
  f.props.availableHeight = Number.NaN;
  f.props.footerHeight = -1;
  f.render();
  assert.equal(panelHeight(), fallback);
  f.props.availableHeight = 430;
  f.props.footerHeight = 65;
  f.render();
  assert.ok(
    panelHeight() < fallback,
    "the real smaller frame replaces the initial window estimate",
  );
  f.hooks.unmount();
});
for (const locale of ["en", "fa", "ps"] as const) {
  check(`${locale}: direct edits and financial preview`, () => {
    const f = fixture({ locale });
    f.press("2", "+", "3", "*", "4");
    assert.equal(f.expression, "2+3*4");
    assert.equal(f.result().amount, "14", "parent can save before Equals");
    assert.equal(f.changed.length, 5);
    assert.deepEqual(f.recorded, []);
    f.press("=");
    assert.deepEqual(f.recorded, [{ expression: "2+3*4", result: "14" }]);
    f.press("AC", "()", "2", "+", "3", "()", "*", "4");
    assert.equal(f.result().amount, "20");
    f.press("AC", "2", "0", "0", "+", "1", "0", "%", "=", "=");
    assert.equal(f.result().amount, "242");
    assert.deepEqual(
      f.recorded.slice(-2),
      [
        { expression: "200+10%", result: "220" },
        { expression: "220+10%", result: "242" },
      ],
      "history records the newly evaluated repeated operation",
    );
    f.press("AC", ".", "5", "sign");
    assert.equal(f.result().canApply, false);
    f.press("sign");
    assert.equal(f.result().amount, "0.50");
    f.press("delete");
    assert.equal(f.expression, "0.");
    f.key("delete").props.onLongPress();
    f.render();
    assert.equal(f.expression, "");
    f.replace("12+34");
    f.props.onChange(controller.selectCalculation(f.props.getDraft(), 1, 2));
    f.render();
    f.press("9");
    assert.equal(f.expression, "19+34");
    assert.equal(f.result().amount, "53");
    f.replace("۱٢٫۵۰+٢");
    assert.equal(f.expression, "12.50+2");
    f.press("=");
    assert.equal(f.result().amount, "14.50");
    f.replace("1/3");
    f.press("=");
    assert.equal(f.result().amount, "0.33");
    const before = [...f.changed];
    f.press("next");
    assert.equal(f.nextCount, 1);
    assert.deepEqual(
      f.changed,
      before,
      "Next delegates Note focus without rounding/replacing the draft",
    );
    f.hooks.unmount();
  });
  check(`${locale}: same-frame keys read the synchronous draft`, () => {
    const f = fixture({ locale });
    ["1", "2", "+", "3", "="]
      .map((value) => f.key(value).props.onPress)
      .forEach((press) => press());
    assert.equal(f.expression, "12+3", "Equals keeps the arithmetic visible in the amount field");
    assert.equal(f.result().amount, "15");
    assert.equal(f.props.getDraft().evaluated, true);
    assert.deepEqual(f.recorded, [{ expression: "12+3", result: "15" }]);
    assert.deepEqual(
      f.changed.map((draft) => draft.expression),
      ["1", "12", "12+", "12+3", "12+3"],
    );
    f.render();
    f.hooks.unmount();
  });
  check(`${locale}: memory survives switching to Note`, () => {
    const f = fixture({ locale, expression: "2" });
    f.press("MR");
    assert.ok(words(f.hooks.tree).includes(f.translate("calculator.memoryEmpty")));
    const add = f.key("M+").props.onPress;
    add();
    add();
    f.render();
    f.props.visible = false;
    f.render();
    assert.equal(f.hooks.tree, null);
    f.props.visible = true;
    f.render();
    f.press("AC", "MR");
    assert.equal(f.result().amount, "4");
    f.replace("1");
    f.press("M−", "AC", "MR");
    assert.equal(f.result().amount, "3");
    f.press("MC", "AC", "MR");
    assert.equal(f.expression, "");
    assert.ok(words(f.hooks.tree).includes(f.translate("calculator.memoryEmpty")));
    f.replace("10%");
    f.press("M+", "M+", "AC", "MR");
    assert.equal(
      f.result().amount,
      "0.20",
      "memory adds monetary values, not contextual percentage syntax",
    );
    f.hooks.unmount();
  });
  check(`${locale}: memory preserves exact fractions until the tally is saved`, () => {
    const f = fixture({ locale, expression: "1/3" });
    const addThird = f.key("M+").props.onPress;
    addThird();
    addThird();
    addThird();
    f.render();
    f.press("AC", "MR");
    assert.equal(f.result().amount, "1", "three thirds must not become 0.99 in memory");
    f.replace("1/3");
    f.press("M−", "M−", "M−", "AC", "MR");
    assert.equal(f.result().display, "0", "exact cancellation does not leave a phantom cent");
    assert.equal(f.result().canApply, false);
    f.press("MC");
    f.replace("0.004");
    f.press("M+", "M+", "M+", "AC", "MR", "*", "2", "5", "0", "=");
    assert.equal(f.result().amount, "3", "sub-cent memory values survive later multiplication");
    f.press("MC");
    f.replace("-0.004");
    f.press("M+", "AC", "MR", "*", "2", "5", "0", "=");
    assert.equal(f.result().display, "-1", "a displayed zero must not discard an exact negative");
    assert.equal(f.result().canApply, false);
    f.press("MC");
    f.replace("7");
    f.press("M+");
    for (const invalid of ["300+", "1/0", "1..2", "9".repeat(257)]) {
      f.replace(invalid);
      f.press("M+", "M−", "AC", "MR");
      assert.equal(f.result().amount, "7", "an unavailable draft cannot corrupt memory");
    }
    f.replace(`1/${"3".repeat(150)}`);
    f.press("M+");
    assert.ok(words(f.hooks.tree).includes(f.translate("calculator.tooLarge")));
    f.press("AC", "MR");
    assert.equal(f.result().amount, "7", "an unrepresentable exact sum cannot replace good memory");
    f.hooks.unmount();
  });
  check(`${locale}: failed repeated equals cannot leave a stale savable result or history`, () => {
    const f = fixture({ locale, expression: `1+1/${"3".repeat(120)}` });
    f.press("=");
    assert.equal(f.result().canApply, true);
    assert.equal(f.recorded.length, 1);
    f.press("=");
    assert.equal(f.result().status, "error");
    assert.equal(f.result().amount, null);
    assert.equal(f.result().canApply, false);
    assert.equal(
      f.recorded.length,
      1,
      "an errored repeated operation never records the old result",
    );
    f.press("AC", "7", "=");
    assert.equal(f.result().amount, "7", "Clear restores ordinary calculation after the limit");
    f.hooks.unmount();
  });
  check(`${locale}: history retains its expression across hiding`, () => {
    const f = fixture({ locale });
    f.labelled("calculator.history").props.onPress();
    f.render();
    assert.ok(words(f.hooks.tree).includes(f.translate("calculator.historyEmpty")));
    f.labelled("calculator.backToCalculator").props.onPress();
    f.render();
    f.replace("2*3-1");
    f.press("=");
    f.labelled("calculator.history").props.onPress();
    f.render();
    const recallLabel = f.translate("calculator.recallCalculation", { expression: "2×3−1" });
    const recall = () =>
      nodes(f.hooks.tree).find((node) => node.props.accessibilityLabel === recallLabel)!;
    assert.ok(recall());
    for (const text of nodes(recall()).filter((node) => node.type === "Text"))
      assert.equal(style(text).writingDirection, "ltr");
    f.props.visible = false;
    f.render();
    f.props.visible = true;
    f.render();
    assert.ok(recall());
    recall().props.onPress();
    f.render();
    assert.equal(f.expression, "2*3-1");
    assert.equal(f.result().amount, "5");
    assert.ok(f.key("7"));
    f.labelled("calculator.history").props.onPress();
    f.render();
    f.labelled("calculator.clearHistory").props.onPress();
    f.render();
    assert.equal(f.cleared, 1);
    assert.deepEqual(f.props.history, []);
    assert.ok(words(f.hooks.tree).includes(f.translate("calculator.historyEmpty")));
    f.hooks.unmount();
  });
}
check("invalid current draft never exposes the previous monetary amount", () => {
  const f = fixture({ expression: "99" });
  f.press("+");
  assert.equal(f.result().status, "incomplete");
  assert.equal(f.result().amount, null);
  for (const expression of ["0", "-2", "12/0", "12+", "1..2", "10000000000", "7".repeat(257)]) {
    f.replace(expression);
    f.press("=");
    assert.equal(f.result().canApply, false, expression);
    assert.equal(f.result().amount, null, expression);
  }
  assert.equal(f.expression.length, 257, "oversized input is never silently truncated");
  f.hooks.unmount();
});
for (const exit of ["hidden", "disabled", "unmount"] as const)
  check(`all queued callbacks are inert after ${exit}`, () => {
    const f = fixture({ expression: "12.50" });
    f.press("=");
    f.labelled("calculator.history").props.onPress();
    f.render();
    const recall = nodes(f.hooks.tree).find(
      (node) =>
        node.props.accessibilityLabel ===
        f.translate("calculator.recallCalculation", { expression: "12.50" }),
    )!.props.onPress;
    const clear = f.labelled("calculator.clearHistory").props.onPress;
    f.labelled("calculator.backToCalculator").props.onPress();
    f.render();
    const callbacks = ["7", "M+", "MR", "=", "next"].map((value) => f.key(value).props.onPress);
    callbacks.push(
      f.key("delete").props.onLongPress,
      f.labelled("calculator.history").props.onPress,
      recall,
      clear,
    );
    const changed = [...f.changed],
      recorded = [...f.recorded],
      history = [...f.props.history];
    if (exit === "unmount") f.hooks.unmount();
    else {
      if (exit === "hidden") f.props.visible = false;
      else f.props.disabled = true;
      f.render();
    }
    callbacks.forEach((callback) => callback());
    assert.deepEqual(f.changed, changed);
    assert.deepEqual(f.recorded, recorded);
    assert.deepEqual(f.props.history, history);
    assert.equal(f.nextCount, 0);
    assert.equal(f.cleared, 0);
    assert.equal(f.hooks.lateWrites, 0);
    if (exit !== "unmount") f.hooks.unmount();
  });
if (failures.length) {
  console.error(failures.join("\n\n"));
  throw new Error(`calculator-ui selftest: ${failures.length} failures, ${cases} checks passed`);
}
console.log(`calculator-ui selftest: ${cases} checks passed`);
