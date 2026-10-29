import assert from "node:assert/strict";
import { formatMoneyAmount } from "../money";
import { summarizeTallyFlows } from "../tally-summary";
import type { Entry } from "../types";

const tally = (
  id: string,
  amount: number,
  type: Entry["type"] = "debt",
  overrides: Partial<Entry> = {},
): Entry => ({
  id,
  relationship_id: "r",
  type,
  amount_afn: amount,
  note: null,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  proposed_by_user_id: null,
  accepted_at: null,
  disputed_at: null,
  disputed_reason: null,
  settled_at: null,
  ...overrides,
});
const entryMeta = {
  tab_id: "tab",
  seq: 1,
  created_by: "a",
  by: "me",
  dispute_reason: null,
  other_label: "Peer",
  status: "accepted",
  kind: "entry",
  voided: false,
  local_pending: false,
} as const;

assert.deepEqual(summarizeTallyFlows([]), {
  gave: { count: 0, amount: 0 },
  received: { count: 0, amount: 0 },
});
const preLink = tally("pre", 10.01, "payment", { settled_at: 2 });
const entries = [
  tally("a", 0.1),
  tally("b", 0.2),
  tally("c", 12.34, "payment"),
  tally("pending", 5, "debt", { tab: { ...entryMeta, status: "pending", local_pending: true } }),
  tally("pending-repayment", 99, "payment", { tab: { ...entryMeta, status: "pending" } }),
  tally("unsynced-accept", 88, "payment", { tab: { ...entryMeta, local_pending: true } }),
  tally("confirmed-handover", 7, "debt", { tab: entryMeta }),
  tally("opening", 500, "debt", { tab: { ...entryMeta, kind: "opening" } }),
  tally("reject", 60, "payment", { tab: { ...entryMeta, status: "disputed" } }),
  tally("local-reject", 60, "debt", { disputed_at: 3 }),
  tally("voided", 70, "debt", { tab: { ...entryMeta, voided: true } }),
  tally("void", 70, "payment", { tab: { ...entryMeta, kind: "void" } }),
  tally("deleted", 80, "debt", { deleted_at: 2 }),
  preLink,
  preLink,
];
const before = JSON.stringify(entries);
assert.deepEqual(summarizeTallyFlows(entries), {
  gave: { count: 3, amount: 7.3 },
  received: { count: 2, amount: 22.35 },
});
assert.equal(JSON.stringify(entries), before, "summary cannot mutate ledger evidence");
assert.throws(
  () => summarizeTallyFlows([tally("bad", 0.001)]),
  RangeError,
  "never round a corrupt sub-cent tally",
);
console.log(
  "PASS flow totals: exact cents, known pre-link and acknowledged shared handovers; pending repayments, unacked acceptances, rejected/cancelled/opening/deleted and duplicates excluded",
);

// Audit #23: the summary beside the balance stays as small as the balance side.
// One line per direction, the app's own "I gave / I received" words, nothing
// for a contact without tallies.
{
  const { compileUI, flattenStyle, jsx, nodes } =
    require("./ui-fixture") as typeof import("./ui-fixture");
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
    "./db": { getAppMeta: async () => null },
  }) as typeof import("../i18n");
  let translate: typeof language.t = (key, vars) => `${key}(${vars?.count ?? ""})`;
  const { TallyFlowSummary } = compileUI("../../components/TallyFlowSummary", {
    react: {},
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      StyleSheet: { create: (s: any) => s },
      Pressable: "Pressable",
      Text: "Text",
      View: "View",
    },
    "react-native-reanimated": {
      __esModule: true,
      default: { createAnimatedComponent: () => "Animated.Pressable" },
    },
    "./SheetBackdrop": { useSheetMotionPreference: () => false },
    "../lib/tokens": { TOUCH_MIN: 44 },
    "../lib/colors": { colors: { textEmphasis: "neutral", borderDefault: "separator" } },
    "../lib/currency": {
      getCurrentCurrencySymbol: () => "AFN",
      getCurrencyLabel: (code: string) => code,
    },
    "../lib/direction": {
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
    },
    "../lib/format": { formatAmount: formatMoneyAmount },
    "../lib/fonts": { fonts: {}, monoLineHeight: () => 20, sansLineHeight: () => 18 },
    "../lib/i18n": {
      t: (...args: Parameters<typeof language.t>) => translate(...args),
    },
    "../lib/jalali": { faDigits: (s: string) => s },
  });
  const empty = { gave: { count: 0, amount: 0 }, received: { count: 0, amount: 0 } };
  assert.equal(TallyFlowSummary({ summary: empty, isRTL: false }), null, "no rows of zeros");
  const tree = TallyFlowSummary({
    summary: { gave: { count: 3, amount: 1500 }, received: { count: 1, amount: 200 } },
    isRTL: false,
  });
  const lines = nodes(tree).filter((n: any) => n.props.accessible === true);
  assert.equal(lines.length, 2, "one accessible line per direction");
  for (const line of lines) {
    assert.equal(line.props.style[1].flexDirection, "row", "label and amount share one line");
    assert.ok(line.props.accessibilityHint, "the explanation is announced on each line");
  }
  assert.ok(tree.props.style.maxWidth === "50%", "never wider than half the header row");
  assert.deepEqual(
    TallyFlowSummary({
      summary: { gave: { count: 3, amount: 1500 }, received: { count: 1, amount: 200 } },
      isRTL: false,
      variant: "inline",
    }),
    tree,
    "the explicit inline variant preserves the existing default layout",
  );

  translate = language.t;
  assert.equal(
    TallyFlowSummary({ summary: empty, isRTL: false, variant: "footer", allTime: true }),
    null,
    "an empty footer has no caption, separator or rows of zeros",
  );
  const largeAmount = 90_000_000_000_000.25;
  const footerSummary = {
    gave: { count: 1_234_567, amount: largeAmount },
    received: { count: 2, amount: 12.34 },
  };
  assert.equal(formatMoneyAmount(largeAmount), "90,000,000,000,000.25");
  for (const locale of ["en", "fa", "ps"] as const) {
    language.setLocale(locale);
    const footer = TallyFlowSummary({
      summary: footerSummary,
      isRTL: locale !== "en",
      currency: "USD",
      variant: "footer",
      allTime: true,
    });
    assert.equal(
      footer.props.accessible,
      undefined,
      "the footer does not merge flow announcements",
    );
    assert.equal(footer.props.style.width, "100%", "the footer uses the complete card width");
    assert.equal(footer.props.style.maxWidth, "100%");
    const [caption, columns] = footer.props.children;
    assert.equal(caption.props.children, language.t("person.flows.allTime"));
    assert.equal(flattenStyle(columns.props.style).direction, "ltr");
    assert.equal(flattenStyle(columns.props.style).flexDirection, "row");
    const flows = nodes(columns).filter((node) => node.props.accessible === true);
    assert.equal(flows.length, 2, "each handover direction has its own announcement");
    for (const [index, direction] of (["received", "gave"] as const).entries()) {
      const flow = flows[index];
      const expected = footerSummary[direction];
      const label = language.t(
        direction === "received" ? "person.flows.received" : "person.flows.gave",
        { count: expected.count },
      );
      assert.equal(
        flow.props.accessibilityLabel,
        `${label}, ${formatMoneyAmount(expected.amount)} USD`,
        "received stays left and gave stays right with their independent values and currency code",
      );
      assert.equal(flow.props.accessibilityHint, language.t("person.flows.hint"));
      const [labelNode, amountNode] = flow.props.children;
      assert.equal(labelNode.props.children, label, "the localized count remains visible");
      assert.equal(
        labelNode.props.numberOfLines,
        undefined,
        "large-text count labels wrap fully instead of truncating the transaction count",
      );
      assert.equal(
        amountNode.props.children,
        formatMoneyAmount(expected.amount),
        "all exact digits remain in the visible amount",
      );
      assert.equal(amountNode.props.numberOfLines, 1);
      assert.equal(amountNode.props.adjustsFontSizeToFit, true);
      assert.equal(
        amountNode.props.minimumFontScale,
        0.1,
        "narrow columns can fit long exact amounts",
      );
      assert.equal(amountNode.props.maxFontSizeMultiplier, 1.3);
      assert.equal(
        amountNode.props.ellipsizeMode,
        undefined,
        "money is fitted rather than shortened",
      );
      assert.equal(flattenStyle(amountNode.props.style).writingDirection, "ltr");
      assert.equal(flattenStyle(amountNode.props.style).textAlign, "left");
      assert.equal(flattenStyle(amountNode.props.style).color, "neutral");
    }
  }
  language.setLocale("en");
  const oneDirection = TallyFlowSummary({
    summary: { received: { count: 0, amount: 0 }, gave: { count: 1, amount: 0.01 } },
    isRTL: false,
    currency: "AFN",
    variant: "footer",
  });
  assert.deepEqual(
    nodes(oneDirection)
      .filter((node) => node.props.accessible === true)
      .map((node) => node.props.accessibilityLabel),
    ["I received (0), 0 AFN", "I gave (1), 0.01 AFN"],
    "a nonempty footer retains both columns without borrowing the other direction's value",
  );
}
console.log("PASS flow summary: one line per direction, no empty rows, half-row cap, spoken hint");
console.log(
  "PASS flow footer: independent exact currency totals, received-left/gave-right in EN/FA/PS, wrapped counts, separate announcements and no empty separator",
);

{
  const { compileUI, flattenStyle, jsx, nodes, uiHooks } =
    require("./ui-fixture") as typeof import("./ui-fixture");
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
    "./db": { getAppMeta: async () => null },
  }) as typeof import("../i18n");
  function filterFooter(locale: "en" | "fa" | "ps") {
    const hooks = uiHooks();
    let windowWidth = 390,
      fontScale = 1,
      reducedMotion = false;
    const animations: { target: number; duration: number }[] = [];
    const taps: string[] = [];
    let props = {
      summary: {
        received: { count: 2, amount: 90_000_000_000_000.25 },
        gave: { count: 1_234_567, amount: 12.34 },
      },
      isRTL: locale !== "en",
      currency: "USD",
      variant: "footer" as const,
      filter: "all" as "all" | "received" | "gave",
      allTime: true,
      interactionEnabled: true,
      onDirectionChange: (direction: string) => taps.push(direction),
    };
    language.setLocale(locale);
    const { TallyFlowSummary } = compileUI("../../components/TallyFlowSummary", {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        StyleSheet: { create: (value: unknown) => value },
        Pressable: "Pressable",
        Text: "Text",
        View: "View",
        useWindowDimensions: () => ({ width: windowWidth, fontScale }),
      },
      "react-native-reanimated": {
        __esModule: true,
        default: { createAnimatedComponent: () => "Animated.Pressable" },
        ReduceMotion: { System: "system" },
        useSharedValue: (initial: unknown) => hooks.react.useRef({ value: initial }).current,
        useAnimatedStyle: (compute: () => any) => ({
          get width() {
            return compute().width;
          },
        }),
        withTiming: (target: number, config: { duration: number }) => {
          animations.push({ target, duration: config.duration });
          return target;
        },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "./SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
      "../lib/tokens": { TOUCH_MIN: 44 },
      "../lib/colors": require("../colors"),
      "../lib/currency": {
        getCurrentCurrencySymbol: () => "AFN",
        getCurrencyLabel: (code: string) => code,
      },
      "../lib/direction": {
        rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      },
      "../lib/format": { formatAmount: formatMoneyAmount },
      "../lib/fonts": { fonts: {}, monoLineHeight: () => 20, sansLineHeight: () => 18 },
      "../lib/i18n": { t: language.t },
    });
    const render = () =>
      hooks.render(() => {
        const root = TallyFlowSummary(props);
        return typeof root.type === "function" ? root.type(root.props) : root;
      });
    render();
    return {
      hooks,
      taps,
      animations,
      buttons: () => nodes(hooks.tree).filter((node) => node.type === "Animated.Pressable"),
      update(next: Partial<typeof props>) {
        props = { ...props, ...next };
        render();
      },
      resize(width: number, scale = fontScale) {
        windowWidth = width;
        fontScale = scale;
        render();
      },
      motion(value: boolean) {
        reducedMotion = value;
        render();
      },
      measure(width: number) {
        hooks.tree.props.onLayout({ nativeEvent: { layout: { width } } });
        render();
      },
    };
  }
  for (const locale of ["en", "fa", "ps"] as const) {
    const f = filterFooter(locale);
    f.measure(360);
    const [received, gave] = f.buttons();
    assert.equal(flattenStyle(hooksColumns(f.hooks.tree).props.style).direction, "ltr");
    assert.equal(received.props.testID, "tally-flow-filter-received");
    assert.equal(gave.props.testID, "tally-flow-filter-gave");
    assert.equal(flattenStyle(received.props.style).width, 180);
    assert.equal(flattenStyle(gave.props.style).width, 180);
    assert.ok(received.props.accessibilityLabel.includes("90,000,000,000,000.25 USD"));
    assert.ok(gave.props.accessibilityLabel.includes("12.34 USD"));
    for (const button of f.buttons()) {
      assert.equal(button.props.accessibilityRole, "button");
      assert.deepEqual(button.props.accessibilityState, { selected: false, disabled: false });
      assert.ok(flattenStyle(button.props.style).minHeight >= 44);
      const amounts = nodes(button).filter(
        (node) => node.type === "Text" && node.props.adjustsFontSizeToFit,
      );
      assert.equal(amounts.length, 1);
      assert.equal(flattenStyle(amounts[0].props.style).writingDirection, "ltr");
      assert.equal(amounts[0].props.minimumFontScale, 0.1);
    }
    received.props.onPress();
    gave.props.onPress();
    assert.deepEqual(f.taps, ["received", "gave"]);
    f.update({ filter: "received" });
    const [expanded, compact] = f.buttons();
    assert.equal(flattenStyle(expanded.props.style).width, 280);
    assert.equal(flattenStyle(compact.props.style).width, 80);
    assert.equal(expanded.props.accessibilityState.selected, true);
    assert.equal(compact.props.accessibilityState.selected, false);
    assert.equal(expanded.props.accessibilityHint, language.t("customers.balanceFilter.clear"));
    assert.ok(
      !nodes(compact).some((node) => node.type === "Text" && node.props.adjustsFontSizeToFit),
    );
    assert.equal(f.animations.at(-1)!.duration, 200);
    expanded.props.onPress();
    assert.equal(
      f.taps.at(-1),
      "received",
      "a repeated tap is delegated so the parent can clear its scope",
    );
    const animationCount = f.animations.length;
    f.update({
      summary: { received: { count: 5, amount: 1.01 }, gave: { count: 6, amount: 2.02 } },
    });
    assert.equal(
      f.animations.length,
      animationCount,
      "amount-only refreshes do not restart expansion",
    );
    f.resize(430, 1.8);
    f.measure(400);
    const widths = f.buttons().map((button) => flattenStyle(button.props.style).width);
    assert.deepEqual(widths, [296, 104]);
    f.motion(true);
    f.update({ filter: "gave" });
    assert.deepEqual(
      f.buttons().map((button) => flattenStyle(button.props.style).width),
      [104, 296],
    );
    assert.equal(
      f.animations.length,
      animationCount,
      "rotation and reduced motion update widths immediately",
    );
    const retained = f.buttons()[0].props.onPress;
    f.update({ interactionEnabled: false });
    retained();
    assert.equal(f.taps.length, 3, "retained press callbacks respect the latest disabled state");
    assert.ok(
      f
        .buttons()
        .every((button) => button.props.disabled && button.props.accessibilityState.disabled),
    );
    f.update({
      interactionEnabled: true,
      filter: "all",
      summary: { received: { count: 0, amount: 0 }, gave: { count: 0, amount: 0 } },
    });
    assert.equal(f.buttons().length, 2, "empty directions still have filter controls");
    f.hooks.unmount();
    f.buttons()[0].props.onPress();
    assert.equal(f.taps.length, 3, "an unmounted card cannot change filters");
    assert.equal(f.hooks.lateWrites, 0);
  }
  function hooksColumns(tree: any) {
    return nodes(tree).find((node) => flattenStyle(node.props.style).flexDirection === "row")!;
  }
  language.setLocale("en");
}
console.log(
  "PASS flow filter footer: accessible LTR received/gave controls, independent expansion, exact totals, live disable guard, large text, reduced motion and cleanup in EN/FA/PS",
);

// Execute the real pager without replacing its hooks or event handlers.
{
  const { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } =
    require("./ui-fixture") as typeof import("./ui-fixture");
  const style = (node: any) => flattenStyle(node.props.style);
  function carousel(rtl: boolean, platform = "ios") {
    const hooks = uiHooks();
    let width = 390;
    let active = true,
      interactionActive = false,
      focused = true,
      nextTimer = 0;
    const readerQuery = deferred<boolean>(),
      motionQuery = deferred<boolean>();
    const timers = new Map<number, { run: () => void; ms: number }>();
    const accessibility = new Map<string, Set<(value: boolean) => void>>();
    const appListeners = new Map<string, Set<(value?: string) => void>>();
    const subscribe = (map: Map<string, Set<any>>, event: string, callback: any) => {
      const listeners = map.get(event) ?? new Set();
      listeners.add(callback);
      map.set(event, listeners);
      return { remove: () => listeners.delete(callback) };
    };
    const app = {
      currentState: "active",
      addEventListener: (event: string, callback: any) => subscribe(appListeners, event, callback),
    };
    let codes = ["AFN", "USD", "EUR"];
    const opened: string[] = [];
    const cards = (values: readonly string[], usd = "0.30 / 9.12") =>
      values.map((code) =>
        jsx("View", {
          currency: code,
          children: [
            jsx("Text", { children: `${code}: ${code === "USD" ? usd : "100 / 100"}` }),
            jsx("Pressable", { accessibilityRole: "button", onPress: () => opened.push(code) }),
          ],
        }),
      );
    let content = cards(codes);
    const calls: { x: number; animated: boolean }[] = [];
    const nativeJsx = (type: any, props: Record<string, any>, key?: any) => {
      if (type === "ScrollView" && props.ref && !props.ref.current)
        props.ref.current = { scrollTo: (call: (typeof calls)[number]) => calls.push(call) };
      return { ...jsx(type, props), key };
    };
    const { CustomerBalanceCarousel } = compileUI(
      "../../components/CustomerBalanceCarousel",
      {
        react: {
          ...hooks.react,
          Children: { toArray: (value: any) => [value].flat().filter(Boolean) },
        },
        "react/jsx-runtime": { jsx: nativeJsx, jsxs: nativeJsx },
        "react-native": {
          View: "View",
          Text: "Text",
          Pressable: "Pressable",
          ScrollView: "ScrollView",
          StyleSheet: { create: (value: any) => value },
          useWindowDimensions: () => ({ width, height: 844 }),
          Platform: { OS: platform },
          AppState: app,
          AccessibilityInfo: {
            isScreenReaderEnabled: () => readerQuery.promise,
            isReduceMotionEnabled: () => motionQuery.promise,
            addEventListener: (event: string, callback: any) =>
              subscribe(accessibility, event, callback),
          },
        },
        "expo-router": { useIsFocused: () => focused },
        "@expo/vector-icons": { Ionicons: "Icon" },
        "../lib/colors": require("../colors"),
        "../lib/currency": { getCurrencyLabel: (code: string) => `${code} unit` },
        "../lib/direction": { useIsRTL: () => rtl, ltrIsolate: require("../bidi").ltrIsolate },
        "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, line: number) => line },
        "../lib/i18n": { t: (key: string) => key },
      },
      {
        setTimeout: (run: () => void, ms: number) => {
          const id = ++nextTimer;
          timers.set(id, { run, ms });
          return id;
        },
        clearTimeout: (id: number) => timers.delete(id),
      },
    );
    const render = (nextCodes = codes, nextContent = content) => {
      codes = nextCodes;
      content = nextContent;
      return hooks.render(() =>
        CustomerBalanceCarousel({
          currencies: codes,
          children: content,
          active,
          interactionActive,
        }),
      );
    };
    const find = (id: string) =>
      nodes(hooks.tree).find((node) => node.props.testID === `customer-balance-${id}`)!;
    const event = (x: number, extra: Record<string, any> = {}) => ({
      nativeEvent: {
        contentOffset: { x },
        layoutMeasurement: { width: style(find(`page-${codes[0]}`)).width },
        contentSize: {
          width:
            find("scroll").props.children.length * style(find(`page-${codes[0]}`)).width +
            (find("scroll").props.children.length - 1) * 12,
        },
        ...extra,
      },
    });
    const measure = (next: number) => {
      find("carousel").props.onLayout({ nativeEvent: { layout: { width: next } } });
      render();
    };
    render();
    return {
      hooks,
      find,
      render,
      event,
      measure,
      calls,
      cards,
      opened,
      timers,
      accessibility,
      appListeners,
      queries: { reader: readerQuery, motion: motionQuery },
      ready: async (reader = false, motion = false) => {
        readerQuery.resolve(reader);
        motionQuery.resolve(motion);
        await settleUI();
        render();
      },
      emitAccessibility: (event: string, value: boolean) => {
        accessibility.get(event)?.forEach((run) => run(value));
        render();
      },
      emitApp: (event: string, value?: string) => {
        if (event === "change" && value) app.currentState = value;
        appListeners.get(event)?.forEach((run) => run(value));
        render();
      },
      setActive: (value: boolean) => {
        active = value;
        render();
      },
      setInteractionActive: (value: boolean) => {
        interactionActive = value;
        render();
      },
      setFocused: (value: boolean) => {
        focused = value;
        render();
      },
      tick: () => {
        const automatic = [...timers].filter(([, timer]) => timer.ms === 5000);
        assert.equal(automatic.length, 1, "customer autoplay waits five seconds");
        const [id, timer] = automatic[0];
        timers.delete(id);
        timer.run();
        render();
        return calls.at(-1)!;
      },
      settle: () => {
        const quiet = [...timers].filter(([, timer]) => timer.ms === 140);
        assert.equal(quiet.length, 1, "one quiet-period timer completes a slow boundary swipe");
        const [id, timer] = quiet[0];
        timers.delete(id);
        timer.run();
        render();
      },
      rotate: (next: number) => {
        width = next;
        render();
      },
      content: () => content,
      position: () => {
        const { accessibilityLabel, accessibilityValue } = find("indicator").props;
        return `${accessibilityLabel} · ${accessibilityValue.now}/${accessibilityValue.max}`;
      },
    };
  }
  for (const rtl of [false, true]) {
    const f = carousel(rtl);
    assert.deepEqual(f.find("scroll").props.snapToOffsets, [0, 370, 740]);
    assert.equal(f.find("scroll").props.snapToInterval, undefined);
    assert.equal(f.find("carousel").props.accessible, false);
    assert.equal(f.find("scroll").props.accessible, false);
    for (const [index, code] of ["AFN", "USD", "EUR"].entries()) {
      const page = f.find(`page-${code}`);
      assert.deepEqual(
        page.props.children.props,
        f.content()[index].props,
        "currency cards retain their independent exact content and controls",
      );
      assert.equal(page.props.accessible, false);
      assert.equal(page.props.accessibilityElementsHidden, index !== 0);
      assert.equal(page.props.importantForAccessibility, index ? "no-hide-descendants" : "auto");
    }
    assert.ok(f.position().includes("AFN unit") && f.position().endsWith("1/3"));
    for (const removed of ["previous", "next", "position"])
      assert.equal(f.find(removed), undefined);
    assert.equal(
      nodes(f.hooks.tree).filter((node) => node.type === "Text").length,
      3,
      "only the currency cards keep visible text; the bottom caption/counter is removed",
    );
    const indicator = f.find("indicator");
    assert.equal(indicator.props.accessibilityRole, "adjustable");
    assert.deepEqual(indicator.props.accessibilityValue, { min: 1, max: 3, now: 1 });
    assert.deepEqual(indicator.props.accessibilityActions, [
      { name: "increment", label: "home.total.nextCurrency" },
      { name: "decrement", label: "home.total.previousCurrency" },
    ]);
    assert.equal(f.find("thumb").props.accessible, false);
    const thumbX = () => style(f.find("thumb")).transform[0].translateX;
    assert.equal(thumbX(), 0);
    const rapidNext = indicator.props.onAccessibilityAction;
    rapidNext({ nativeEvent: { actionName: "increment" } });
    rapidNext({ nativeEvent: { actionName: "increment" } });
    f.render();
    assert.ok(f.position().includes("EUR unit") && f.position().endsWith("3/3"));
    assert.equal(
      thumbX(),
      358 - style(f.find("thumb")).width,
      "the thin line reaches its end for the final currency",
    );
    assert.deepEqual(f.calls.at(-1), { x: 740, animated: false });
    rapidNext({ nativeEvent: { actionName: "increment" } });
    f.render();
    assert.ok(
      f.position().includes("AFN unit"),
      "adjustable navigation wraps at its last currency",
    );
    assert.deepEqual(f.calls.at(-1), { x: 0, animated: false });
    f.find("indicator").props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
    f.render();
    assert.ok(f.position().includes("EUR unit"), "decrement wraps from the first to last currency");
    f.find("indicator").props.onAccessibilityAction({ nativeEvent: { actionName: "decrement" } });
    f.render();
    assert.ok(f.position().includes("USD unit"));
    const usd = f.find("page-USD");
    assert.equal(usd.props.accessibilityElementsHidden, false);
    assert.equal(usd.props.pointerEvents, "auto");
    nodes(usd)
      .find((node) => node.type === "Pressable")!
      .props.onPress();
    assert.deepEqual(
      f.opened,
      ["USD"],
      "the current card's own action remains independently reachable",
    );

    const beforeRefresh = f.calls.length;
    f.render(undefined, f.cards(["AFN", "USD", "EUR"], "8.76 / 1.23"));
    assert.equal(
      f.calls.length,
      beforeRefresh,
      "value-only refresh does not reset native position",
    );
    assert.equal(
      nodes(f.find("page-USD")).find((node) => node.type === "Text")!.props.children,
      "USD: 8.76 / 1.23",
      "the preserved page receives its refreshed independent values",
    );
    const obsoleteScroll = f.find("scroll").props.onScroll;
    const obsoleteEvent = f.event(0);
    f.render(["EUR", "AFN", "USD"], f.cards(["EUR", "AFN", "USD"]));
    assert.ok(f.position().includes("USD unit") && f.position().endsWith("3/3"));
    assert.deepEqual(f.calls.at(-1), { x: 740, animated: false });
    f.find("scroll").props.onScrollBeginDrag(f.event(740));
    obsoleteScroll(obsoleteEvent);
    f.render();
    assert.ok(
      f.position().includes("USD unit"),
      "old-geometry events cannot override a preserved currency",
    );

    f.measure(350.25);
    assert.deepEqual(f.find("scroll").props.snapToOffsets, [0, 362.25, 724.5]);
    assert.deepEqual(f.calls.at(-1), { x: 724.5, animated: false });
    const scroll = f.find("scroll").props;
    const contentWidth = f.event(0).nativeEvent.contentSize.width;
    const beforeSize = f.calls.length;
    scroll.onContentSizeChange(contentWidth - 12, 1);
    f.render();
    assert.equal(
      f.calls.length,
      beforeSize,
      "an obsolete native content width cannot retry alignment",
    );
    scroll.onContentSizeChange(contentWidth, 1);
    f.render();
    assert.equal(
      f.calls.length,
      beforeSize + 1,
      "matching native content retries a pending geometry once",
    );
    assert.deepEqual(
      f.calls.at(-1),
      { x: 724.5, animated: false },
      "a settled matching native content size retries the selected code",
    );
    scroll.onContentSizeChange(contentWidth, 3);
    f.render();
    assert.equal(
      f.calls.length,
      beforeSize + 1,
      "ordinary height changes cannot realign an already settled page",
    );
    scroll.onScrollBeginDrag(f.event(724.5));
    const duringDrag = f.calls.length;
    scroll.onContentSizeChange(contentWidth, 2);
    f.render();
    assert.equal(
      f.calls.length,
      duringDrag,
      "content-size changes cannot pull the page away from an active drag",
    );
    scroll.onScroll(f.event(362.25 * 0.6));
    f.render();
    assert.ok(
      f.position().includes("AFN unit") && f.position().endsWith("2/3"),
      "fractional native offsets select the nearest code",
    );
    scroll.onScrollEndDrag(f.event(362.25));
    scroll.onMomentumScrollEnd(f.event(362.25));
    f.render();
    f.rotate(320);
    f.measure(288);
    assert.deepEqual(f.find("scroll").props.snapToOffsets, [0, 300, 600]);
    assert.deepEqual(f.calls.at(-1), { x: 300, animated: false });
    f.find("scroll").props.onMomentumScrollEnd(f.event(600));
    f.render();
    assert.ok(
      f.position().includes("USD unit") && f.position().endsWith("3/3"),
      "a settled native assistive scroll updates reachable currency without a touch drag",
    );
    f.find("scroll").props.onMomentumScrollEnd(f.event(370));
    f.render();
    f.find("scroll").props.onMomentumScrollEnd(f.event(300 - 12));
    f.render();
    assert.ok(
      f.position().includes("AFN unit") && f.position().endsWith("2/3"),
      "a native viewport-width assistive scroll still selects the next currency",
    );
    assert.deepEqual(
      f.calls.at(-1),
      { x: 300, animated: false },
      "off-snap native settles align to the absolute page boundary",
    );
    f.render(["EUR", "USD"], f.cards(["EUR", "USD"]));
    assert.ok(
      f.position().includes("USD unit") && f.position().endsWith("2/2"),
      "removing the selected code chooses the nearest surviving page",
    );
    const oldNext = f.find("indicator").props.onAccessibilityAction;
    f.render(["USD"], f.cards(["USD"]));
    assert.equal(f.find("scroll").props.scrollEnabled, false);
    assert.equal(f.find("previous"), undefined);
    assert.equal(f.find("next"), undefined);
    assert.equal(f.find("position"), undefined);
    assert.equal(f.find("indicator"), undefined);
    assert.equal(f.find("thumb"), undefined);
    assert.equal(f.find("page-USD").props.accessibilityElementsHidden, false);
    const beforeUnmount = f.calls.length;
    f.hooks.unmount();
    oldNext({ nativeEvent: { actionName: "increment" } });
    assert.equal(f.calls.length, beforeUnmount);
    assert.equal(f.hooks.lateWrites, 0);
  }
  async function automaticMovement() {
    const acknowledge = (f: ReturnType<typeof carousel>, x: number) => {
      f.find("scroll").props.onScroll(f.event(x));
      f.find("scroll").props.onMomentumScrollEnd(f.event(x));
      f.render();
    };
    const f = carousel(false);
    assert.equal(f.timers.size, 0, "unknown accessibility preferences keep the carousel still");
    await f.ready();
    assert.equal(f.timers.size, 0, "automatic movement waits for the measured native viewport");
    f.measure(358);
    f.find("scroll").props.onMomentumScrollEnd(f.event(0));
    f.render();
    assert.equal(f.timers.size, 1, "same-page native layout alignment is not user navigation");
    const first = f.tick();
    assert.deepEqual(first, { x: 740, animated: true });
    assert.ok(
      f.position().includes("AFN unit"),
      "an animated request cannot announce its target before native movement",
    );
    acknowledge(f, first.x);
    assert.ok(f.position().includes("USD unit"));
    const positions = [first.x];
    for (let i = 0; i < 3; i++) {
      const next = f.tick();
      positions.push(next.x);
      acknowledge(f, next.x);
    }
    assert.deepEqual(
      positions,
      [740, 1110, 1480, 740],
      "five-second advances stay adjacent and loop forward through the trailing first card",
    );
    const cadence = [...f.timers.values()][0];
    f.render(undefined, f.cards(["AFN", "USD", "EUR"], "9.10 / 3.20"));
    assert.equal(
      [...f.timers.values()][0],
      cadence,
      "amount-only refreshes retain the automatic cadence",
    );
    f.hooks.unmount();

    for (const interaction of ["touch", "swipe", "indicator", "assistive", "filter"] as const) {
      const stopped = carousel(false, "android");
      await stopped.ready();
      stopped.measure(358);
      const queued = [...stopped.timers.values()][0];
      if (interaction === "touch") stopped.find("carousel").props.onTouchStart();
      else if (interaction === "swipe")
        stopped.find("scroll").props.onScrollBeginDrag(stopped.event(0));
      else if (interaction === "indicator")
        stopped
          .find("indicator")
          .props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
      else if (interaction === "assistive") stopped.find("indicator").props.onAccessibilityTap();
      else stopped.setInteractionActive(true);
      const afterInteraction = stopped.calls.length;
      queued.run();
      stopped.render();
      assert.equal(
        stopped.calls.length,
        afterInteraction,
        `${interaction} revokes a queued tick before React commits`,
      );
      assert.equal(stopped.timers.size, 0);
      stopped.setInteractionActive(false);
      assert.equal(
        stopped.timers.size,
        0,
        "clearing filters cannot resume autoplay after interaction",
      );
      stopped.rotate(320);
      stopped.measure(288);
      stopped.render(["EUR", "USD", "AFN"], stopped.cards(["EUR", "USD", "AFN"]));
      stopped.setFocused(false);
      stopped.setFocused(true);
      stopped.setActive(false);
      stopped.setActive(true);
      stopped.emitApp("change", "background");
      stopped.emitApp("change", "active");
      stopped.emitApp("blur");
      stopped.emitApp("focus");
      assert.equal(
        stopped.timers.size,
        0,
        "user control stays permanent across refresh, resize and lifecycle changes",
      );
      stopped.hooks.unmount();
    }

    const native = carousel(false);
    await native.ready(true, false);
    native.measure(358);
    native.find("scroll").props.onMomentumScrollEnd(native.event(370));
    native.render();
    assert.ok(native.position().includes("USD unit"));
    native.emitAccessibility("screenReaderChanged", false);
    assert.equal(native.timers.size, 0, "native assistive navigation also takes permanent control");
    native.hooks.unmount();

    for (const reason of ["active", "route", "background", "window", "reader", "motion"] as const) {
      const paused = carousel(false, "android");
      await paused.ready();
      paused.measure(358);
      const apply = (pause: boolean) => {
        if (reason === "active") paused.setActive(!pause);
        else if (reason === "route") paused.setFocused(!pause);
        else if (reason === "background") paused.emitApp("change", pause ? "background" : "active");
        else if (reason === "window") paused.emitApp(pause ? "blur" : "focus");
        else
          paused.emitAccessibility(
            reason === "reader" ? "screenReaderChanged" : "reduceMotionChanged",
            pause,
          );
      };
      const queued = [...paused.timers.values()][0];
      apply(true);
      assert.equal(paused.timers.size, 0, `${reason} pauses automatic movement`);
      const beforeTick = paused.calls.length;
      queued.run();
      paused.render();
      assert.equal(paused.calls.length, beforeTick, "a paused generation's queued tick is inert");
      apply(false);
      assert.equal(
        paused.timers.size,
        1,
        "an untouched carousel resumes only after the pause ends",
      );
      paused.hooks.unmount();
    }

    for (const preference of ["screenReaderChanged", "reduceMotionChanged"]) {
      const pending = carousel(false);
      pending.measure(358);
      pending.emitAccessibility(preference, true);
      await pending.ready(false, false);
      assert.equal(
        pending.timers.size,
        0,
        "a late native preference query cannot override a newer accessibility event",
      );
      pending.emitAccessibility(preference, false);
      assert.equal(pending.timers.size, 1);
      pending.hooks.unmount();
    }
    const single = carousel(false);
    single.render(["USD"], single.cards(["USD"]));
    await single.ready();
    single.measure(358);
    assert.equal(single.timers.size, 0, "one currency never rotates automatically");
    single.hooks.unmount();

    const resized = carousel(false);
    await resized.ready();
    resized.measure(358);
    const oldGeometry = [...resized.timers.values()][0];
    resized.rotate(320);
    resized.measure(288);
    const aligned = resized.calls.length;
    oldGeometry.run();
    resized.render();
    assert.equal(resized.calls.length, aligned, "an old geometry timer cannot move resized pages");
    const oldTimer = [...resized.timers.values()][0];
    const oldReader = [...resized.accessibility.get("screenReaderChanged")!][0];
    const oldApp = [...resized.appListeners.get("change")!][0];
    resized.hooks.unmount();
    oldTimer.run();
    oldReader(true);
    oldApp("background");
    assert.equal(resized.calls.length, aligned);
    assert.equal(resized.timers.size, 0);
    assert.equal(
      resized.hooks.lateWrites,
      0,
      "unmounted timer and native callbacks cannot repaint",
    );
    const unresolved = carousel(false);
    unresolved.hooks.unmount();
    unresolved.queries.reader.resolve(false);
    unresolved.queries.motion.resolve(false);
    await settleUI();
    assert.equal(
      unresolved.hooks.lateWrites,
      0,
      "late initial queries cannot revive an unmounted pager",
    );
    console.log(
      "PASS customer autoplay: adjacent five-second forward loop, native indicator timing, synchronous permanent interaction stop, lifecycle/accessibility pauses and stale-work cleanup",
    );
  }
  async function infiniteMovement() {
    const assertReachable = (f: ReturnType<typeof carousel>, currency: string) => {
      const pages = f.find("scroll").props.children;
      assert.equal(
        pages.filter((page: any) => !page.props.accessibilityElementsHidden).length,
        1,
        "only one logical real card is exposed to assistive navigation",
      );
      for (const page of pages) {
        const real = page.props.testID === `customer-balance-page-${currency}`;
        assert.equal(page.props.accessibilityElementsHidden, !real);
        assert.equal(page.props.importantForAccessibility, real ? "auto" : "no-hide-descendants");
        assert.equal(
          page.props.pointerEvents,
          page.props.children.props.currency === currency ? "auto" : "none",
          "a visible boundary copy keeps the same real-card actions reachable",
        );
      }
    };
    for (const rtl of [false, true]) {
      const f = carousel(rtl);
      await f.ready();
      f.measure(358);
      const native = () => f.find("scroll").props;
      assert.deepEqual(native().snapToOffsets, [0, 370, 740, 1110, 1480]);
      assert.deepEqual(native().contentOffset, { x: 370, y: 0 });
      assert.equal(native().bounces, false);
      assert.equal(native().overScrollMode, "never");
      assert.deepEqual(
        native().children.map((page: any) => page.props.testID),
        [
          "customer-balance-loop-leading-EUR",
          "customer-balance-page-AFN",
          "customer-balance-page-USD",
          "customer-balance-page-EUR",
          "customer-balance-loop-trailing-AFN",
        ],
        "one adjacent copy at either end makes both loop directions continuous",
      );
      assertReachable(f, "AFN");
      for (const [clone, real] of [
        ["loop-leading-EUR", "page-EUR"],
        ["loop-trailing-AFN", "page-AFN"],
      ])
        assert.deepEqual(
          f.find(clone).props.children.props,
          f.find(real).props.children.props,
          "boundary copies preserve the exact currency amounts and card actions",
        );

      // Swipe forward around a complete cycle, holding at the trailing edge.
      for (const [from, to, code] of [
        [370, 740, "USD"],
        [740, 1110, "EUR"],
        [1110, 1480, "AFN"],
      ] as const) {
        const before = f.calls.length;
        f.find("carousel").props.onTouchStart();
        native().onScrollBeginDrag(f.event(from));
        native().onScroll(f.event(to));
        f.render();
        native().onMomentumScrollEnd(f.event(to));
        f.render();
        assert.ok(f.position().includes(`${code} unit`));
        assert.equal(f.calls.length, before, "holding a boundary never recenters under the finger");
        assert.equal(
          f.timers.size,
          0,
          "active fingers never arm a boundary timer or restart autoplay",
        );
        assertReachable(f, code);
        if (to === 1480) {
          nodes(f.find("loop-trailing-AFN"))
            .find((node) => node.type === "Pressable")!
            .props.onPress();
          assert.deepEqual(f.opened, ["AFN"], "a held trailing copy retains its currency action");
        }
        native().onScrollEndDrag(f.event(to, { velocity: { x: 0 } }));
        f.find("carousel").props.onTouchEnd();
        native().onMomentumScrollEnd(f.event(to));
        f.render();
        if (code === "AFN") assert.deepEqual(f.calls.at(-1), { x: 370, animated: false });
        else assert.equal(f.calls.length, before);
      }

      // A slow reverse release without a native momentum-end still recycles.
      f.find("carousel").props.onTouchStart();
      native().onScrollBeginDrag(f.event(370));
      native().onScroll(f.event(0));
      f.render();
      assert.ok(f.position().includes("EUR unit") && f.position().endsWith("3/3"));
      nodes(f.find("loop-leading-EUR"))
        .find((node) => node.type === "Pressable")!
        .props.onPress();
      assert.deepEqual(f.opened, ["AFN", "EUR"], "a held leading copy retains its currency action");
      const beforeQuiet = f.calls.length;
      native().onScrollEndDrag(f.event(0));
      f.find("carousel").props.onTouchEnd();
      assert.equal(
        f.calls.length,
        beforeQuiet,
        "unknown native velocity waits for quiet before recycling",
      );
      const obsoleteQuiet = [...f.timers.values()].find((timer) => timer.ms === 140)!;
      f.find("carousel").props.onTouchStart();
      obsoleteQuiet.run();
      f.render();
      assert.equal(
        f.calls.length,
        beforeQuiet,
        "a new touch retires queued boundary work immediately",
      );
      assert.equal(f.timers.size, 0);
      f.find("carousel").props.onTouchEnd();
      f.settle();
      assert.deepEqual(f.calls.at(-1), { x: 1110, animated: false });
      assertReachable(f, "EUR");

      // Both late sentinel events and their saved timer stay inert after the
      // real page acknowledges its own nonanimated recenter.
      native().onScroll(f.event(1110));
      native().onMomentumScrollEnd(f.event(1110));
      const afterRecenter = f.calls.length;
      native().onScroll(f.event(0));
      native().onMomentumScrollEnd(f.event(0));
      obsoleteQuiet.run();
      f.render();
      assert.equal(f.calls.length, afterRecenter);
      assert.ok(f.position().includes("EUR unit") && f.position().endsWith("3/3"));
      nodes(f.find("page-EUR"))
        .find((node) => node.type === "Pressable")!
        .props.onPress();
      assert.deepEqual(
        f.opened,
        ["AFN", "EUR", "EUR"],
        "looping keeps the visible real card's action intact",
      );

      const action = f.find("indicator").props.onAccessibilityAction;
      action({ nativeEvent: { actionName: "increment" } });
      f.render();
      assert.ok(f.position().includes("AFN unit"));
      assert.deepEqual(f.calls.at(-1), { x: 370, animated: false });
      action({ nativeEvent: { actionName: "decrement" } });
      f.render();
      assert.ok(f.position().includes("EUR unit"));
      assert.deepEqual(f.calls.at(-1), { x: 1110, animated: false });

      // Retaining the same dimensions and currencies after A→B→A must not
      // revive callbacks from the first native scroller.
      const oldScroll = native();
      const scrollKey = () => (f.find("scroll") as ReturnType<typeof f.find> & { key: number }).key;
      const oldKey = scrollKey();
      const oldLayout = f.find("carousel").props.onLayout;
      const oldAction = f.find("indicator").props.onAccessibilityAction;
      const oldEvent = f.event(370);
      f.render(["EUR", "AFN", "USD"], f.cards(["EUR", "AFN", "USD"]));
      assert.ok(f.position().includes("EUR unit") && f.position().endsWith("1/3"));
      assert.deepEqual(f.calls.at(-1), { x: 370, animated: false });
      f.render(["AFN", "USD", "EUR"], f.cards(["AFN", "USD", "EUR"]));
      assert.notEqual(scrollKey(), oldKey, "native scroller epochs distinguish A→B→A");
      const beforeStale = f.calls.length;
      oldScroll.onScrollBeginDrag(oldEvent);
      oldScroll.onScroll(oldEvent);
      oldScroll.onScrollEndDrag(oldEvent);
      oldScroll.onMomentumScrollBegin();
      oldScroll.onMomentumScrollEnd(oldEvent);
      oldScroll.onContentSizeChange(oldEvent.nativeEvent.contentSize.width);
      oldLayout({ nativeEvent: { layout: { width: 123 } } });
      oldAction({ nativeEvent: { actionName: "increment" } });
      f.render();
      assert.equal(
        f.calls.length,
        beforeStale,
        "retired native handlers and layout cannot move new pages",
      );
      assert.ok(f.position().includes("EUR unit") && f.position().endsWith("3/3"));
      assert.deepEqual(native().snapToOffsets, [0, 370, 740, 1110, 1480]);

      f.measure(350.25);
      assert.deepEqual(native().snapToOffsets, [0, 362.25, 724.5, 1086.75, 1449]);
      assert.deepEqual(f.calls.at(-1), { x: 1086.75, animated: false });
      f.rotate(320);
      f.measure(288);
      assert.deepEqual(native().snapToOffsets, [0, 300, 600, 900, 1200]);
      assert.deepEqual(f.calls.at(-1), { x: 900, animated: false });
      f.render(["AFN", "USD"], f.cards(["AFN", "USD"]));
      assert.ok(f.position().includes("USD unit") && f.position().endsWith("2/2"));
      assert.deepEqual(native().snapToOffsets, [0, 300, 600, 900]);
      assert.deepEqual(f.calls.at(-1), { x: 600, animated: false });
      f.render(["USD"], f.cards(["USD"]));
      assert.equal(native().children.length, 1);
      assert.deepEqual(native().snapToOffsets, [0]);
      assert.deepEqual(native().contentOffset, { x: 0, y: 0 });
      assert.equal(native().scrollEnabled, false);
      assert.equal(f.find("indicator"), undefined);
      assert.equal(f.timers.size, 0);
      f.hooks.unmount();
    }

    // Two cards must wrap in both directions just like larger currency sets.
    const pair = carousel(false);
    pair.render(["AFN", "USD"], pair.cards(["AFN", "USD"]));
    await pair.ready();
    pair.measure(358);
    for (const [from, to, target, code] of [
      [370, 0, 740, "USD"],
      [740, 1110, 370, "AFN"],
    ] as const) {
      const scroll = pair.find("scroll").props;
      pair.find("carousel").props.onTouchStart();
      scroll.onScrollBeginDrag(pair.event(from));
      scroll.onScroll(pair.event(to));
      scroll.onScrollEndDrag(pair.event(to));
      scroll.onMomentumScrollBegin();
      assert.equal(
        [...pair.timers.values()].filter((timer) => timer.ms === 140).length,
        0,
        "native momentum cancels a quiet boundary timer",
      );
      scroll.onScroll(pair.event(to));
      pair.find("carousel").props.onTouchEnd();
      pair.settle();
      assert.deepEqual(pair.calls.at(-1), { x: target, animated: false });
      assert.ok(pair.position().includes(`${code} unit`));
    }
    pair.emitAccessibility("screenReaderChanged", true);
    assert.equal(pair.find("scroll").props.children.length, 2);
    assert.deepEqual(pair.find("scroll").props.snapToOffsets, [0, 370]);
    const action = pair.find("indicator").props.onAccessibilityAction;
    action({ nativeEvent: { actionName: "decrement" } });
    pair.render();
    assert.ok(pair.position().includes("USD unit"));
    assert.deepEqual(pair.calls.at(-1), { x: 370, animated: false });
    pair.hooks.unmount();

    // An absent native end still lets the next automatic tick normalize the
    // boundary before advancing another adjacent card, always forwards.
    const missed = carousel(false);
    missed.render(["AFN", "USD"], missed.cards(["AFN", "USD"]));
    await missed.ready();
    missed.measure(358);
    assert.deepEqual(missed.tick(), { x: 740, animated: true });
    assert.deepEqual(missed.tick(), { x: 1110, animated: true });
    const beforeNormalize = missed.calls.length;
    assert.deepEqual(missed.tick(), { x: 740, animated: true });
    assert.deepEqual(missed.calls.slice(beforeNormalize), [
      { x: 370, animated: false },
      { x: 740, animated: true },
    ]);
    missed.hooks.unmount();
    console.log(
      "PASS customer infinite loop: forward/reverse boundaries, held and slow swipes, two currencies, real-card accessibility/actions, stale recenter/ABA callbacks and geometry preservation in LTR/RTL",
    );
  }
  void automaticMovement().then(infiniteMovement);
}
console.log(
  "PASS customer balance carousel: independent cards/actions, manual code navigation, absolute fractional snaps, refresh/reorder/remove/rotation preservation and reachable-page accessibility in LTR/RTL",
);
