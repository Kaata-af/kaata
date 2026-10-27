import assert from "node:assert/strict";
import { colors } from "../colors";
import { formatMoneyAmount, fromMinorUnits } from "../money";
import { currencyBalances, personCurrencyRows } from "../multi-currency-view";
import type { PersonWithBalance } from "../types";
import {
  compileUI,
  deferred,
  flattenStyle,
  jsx,
  nodes,
  settleUI,
  uiHooks,
  type UINode,
} from "./ui-fixture";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const style = (node: UINode) => flattenStyle(node.props.style) ?? {};
const text = (node: any): string =>
  Array.isArray(node)
    ? node.map(text).join(" ")
    : node && typeof node === "object"
      ? text(node.props?.children)
      : node == null
        ? ""
        : String(node);
const children = (node: UINode) =>
  [node.props.children].flat().filter((row): row is UINode => !!row && typeof row === "object");
const byId = (root: UINode, id: string) => nodes(root).find((node) => node.props.testID === id)!;
const isBalanceCell = (node: UINode) =>
  /^home-balance-(collect|pay)-/.test(node.props.testID ?? "");
const balanceCells = (page: UINode) => nodes(page).filter(isBalanceCell);
const quoteRow = (page: UINode) =>
  nodes(page).find((node) => children(node).filter(isBalanceCell).length === 2)!;
const currencySymbols: Record<string, string> = { AFN: "؋", USD: "$", EUR: "€" };
const currencyLabel = (code: string) => `${code} ${currencySymbols[code] ?? "¤"}`;
const luminance = (color: string) => {
  assert.match(color, /^#[\da-f]{6}$/i);
  return [1, 3, 5]
    .map((at) => {
      const channel = parseInt(color.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
};
const contrast = (foreground: string, background: string) => {
  const values = [luminance(foreground), luminance(background)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
};
const pageStep = (scroll: UINode): number =>
  scroll.props.snapToOffsets[1] ??
  style(children(scroll)[0]).width + flattenStyle(scroll.props.contentContainerStyle).gap;
type Balance = { currency: string; collect: number; pay: number; pending: boolean };
type SummaryProps = {
  people: readonly PersonWithBalance[];
  balances?: readonly Balance[];
  currency?: string;
  compact?: boolean;
  active?: boolean;
};
function fixture(
  locale: "en" | "fa" | "ps",
  width = 390,
  fontScale = 1,
  height = 844,
  platform = "ios",
) {
  language.setLocale(locale);
  const hooks = uiHooks();
  let focused = true;
  let props: SummaryProps = { people: [] };
  const readerQuery = deferred<boolean>();
  const motionQuery = deferred<boolean>();
  const accessibility = new Map<string, Set<(value: boolean) => void>>();
  const appListeners = new Map<string, Set<(value: string) => void>>();
  const calls: { x: number; animated?: boolean }[] = [];
  const timers = new Map<number, { ms: number; run: () => void }>();
  const timerHistory: { ms: number; run: () => void }[] = [];
  let nextTimer = 0;
  const subscribe = <T>(
    map: Map<string, Set<(value: T) => void>>,
    event: string,
    callback: (value: T) => void,
  ) => {
    const listeners = map.get(event) ?? new Set();
    listeners.add(callback);
    map.set(event, listeners);
    return { remove: () => listeners.delete(callback) };
  };
  const summaryJsx: typeof jsx = (type, props) => {
    if (type === "ScrollView" && props.ref && !props.ref.current)
      props.ref.current = {
        scrollTo: (options: { x: number; animated?: boolean }) => calls.push(options),
      };
    return jsx(type, props);
  };
  const module = compileUI(
    "../../components/HomeBalanceSummary",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx: summaryJsx, jsxs: summaryJsx },
      "expo-router": { useIsFocused: () => focused },
      "react-native": {
        View: "View",
        Text: "Text",
        ScrollView: "ScrollView",
        Platform: { OS: platform },
        AppState: {
          currentState: "active",
          addEventListener: (event: string, callback: (value: string) => void) =>
            subscribe(appListeners, event, callback),
        },
        AccessibilityInfo: {
          isScreenReaderEnabled: () => readerQuery.promise,
          isReduceMotionEnabled: () => motionQuery.promise,
          addEventListener: (event: string, callback: (value: boolean) => void) =>
            subscribe(accessibility, event, callback),
        },
        StyleSheet: { create: (v: any) => v },
        useWindowDimensions: () => ({ width, fontScale, height }),
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "../lib/colors": { colors },
      "../lib/currency": {
        getCurrentCurrencyCode: () => "AFN",
        getCurrencyLabel: currencyLabel,
        getCurrencySymbol: (code: string) => currencySymbols[code] ?? code,
      },
      "../lib/direction": {
        textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
        useIsRTL: () => locale !== "en",
      },
      "../lib/fonts": { fonts: { sansSemi: "sans", sansMedium: "sans", monoBold: "mono" } },
      "../lib/format": { formatAmount: formatMoneyAmount },
      "../lib/i18n": language,
      "../lib/multi-currency-view": { currencyBalances },
    },
    {
      setTimeout: (run: () => void, ms: number) => {
        const timer = { ms, run };
        const id = ++nextTimer;
        timers.set(id, timer);
        timerHistory.push(timer);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ) as typeof import("../../components/HomeBalanceSummary");
  const render = (next: Partial<SummaryProps> = {}) => {
    props = { ...props, ...next };
    return hooks.render(() => module.HomeBalanceSummary(props));
  };
  const flush = async () => {
    await settleUI();
    render();
    await settleUI();
    render();
  };
  const scroll = () => nodes(hooks.tree).find((node) => node.type === "ScrollView")!;
  const measure = (measuredWidth = width - 32) => {
    scroll().props.onLayout({ nativeEvent: { layout: { width: measuredWidth, height: 132 } } });
    render();
  };
  const onScroll = (x: number) => {
    scroll().props.onScroll({ nativeEvent: { contentOffset: { x, y: 0 } } });
    render();
  };
  const advance = (emitNativeScroll = true) => {
    assert.equal(timers.size, 1, "auto movement owns one timeout");
    const [id, timer] = [...timers][0];
    assert.equal(timer.ms, 5000, "auto movement waits five seconds");
    timers.delete(id);
    timer.run();
    render();
    const call = calls.at(-1)!;
    assert.equal(call.animated, true);
    if (emitNativeScroll) onScroll(call.x);
    return call;
  };
  render();
  return {
    module,
    hooks,
    render,
    flush,
    scroll,
    measure,
    onScroll,
    advance,
    calls,
    timers,
    timerHistory,
    ready: async (reader = false, motion = false) => {
      readerQuery.resolve(reader);
      motionQuery.resolve(motion);
      await flush();
    },
    setFocused: (value: boolean) => {
      focused = value;
      render();
    },
    setWidth: (value: number) => {
      width = value;
      render();
    },
    emitAccessibility: (event: string, value: boolean) => {
      for (const callback of accessibility.get(event) ?? []) callback(value);
      render();
    },
    emitApp: (event: string, value = "") => {
      for (const callback of appListeners.get(event) ?? []) callback(value);
      render();
    },
    accessibility,
    appListeners,
  };
}
const balances = [
  { currency: "AFN", collect: 100, pay: 100, pending: false },
  { currency: "USD", collect: 0.3, pay: 9.12, pending: false },
  { currency: "EUR", collect: 0, pay: 0, pending: false },
];
async function main() {
  for (const locale of ["en", "fa", "ps"] as const) {
    for (const compact of [false, true]) {
      const current = fixture(locale);
      const root = current.render({
        people: [],
        balances,
        currency: "AFN",
        compact,
      }) as UINode;
      assert.equal(style(root).direction, "ltr");
      assert.ok(
        children(current.scroll()).every(
          (page) =>
            style(quoteRow(page)).flexDirection === "row" &&
            style(quoteRow(page)).direction === "ltr",
        ),
        "collect/pay positions stay physical LTR on every page",
      );
      assert.equal(
        style(root).marginBottom,
        compact ? 8 : 16,
        "cards retain their normal and keyboard spacing",
      );
      const pages = children(current.scroll());
      const cards = pages.flatMap(balanceCells);
      assert.equal(cards.length, 4);
      assert.ok(
        pages.every(
          (page) => luminance(style(page).backgroundColor) > 0.8 && style(page).borderWidth === 1,
        ),
        "each denomination has one bordered light board",
      );
      assert.ok(text(cards[0]).includes(language.t("home.total.label.collect")));
      assert.ok(text(cards[1]).includes(language.t("home.total.label.pay")));
      for (const [index, page] of pages.entries()) {
        const row = balances[index];
        const [collect, pay] = balanceCells(page);
        assert.equal(collect.props.testID, `home-balance-collect-${row.currency}`);
        assert.equal(pay.props.testID, `home-balance-pay-${row.currency}`);
        assert.equal(
          text(byId(page, `home-balance-currency-${row.currency}`)),
          currencyLabel(row.currency),
        );
        assert.equal(
          text(page).split(row.currency).length - 1,
          1,
          "the denomination is printed once in its shared header",
        );
        assert.ok(!text(collect).includes(row.currency) && !text(pay).includes(row.currency));
        assert.deepEqual(
          nodes(page)
            .filter((node) => node.type === "Text")
            .map(text),
          [
            currencyLabel(row.currency),
            language.t("home.total.title"),
            language.t("home.total.label.collect"),
            formatMoneyAmount(row.collect),
            language.t("home.total.label.pay"),
            formatMoneyAmount(row.pay),
          ],
          "the board contains the currency, both labeled balances, and no invented rates, trends or percentages",
        );
        assert.equal(style(pay).borderLeftWidth, 1, "a fine separator divides the paired values");
        const amounts = nodes(page).filter((node) => node.props.minimumFontScale !== undefined);
        const header = children(page)[0];
        const headerTexts = nodes(header).filter((node) => node.type === "Text");
        for (const label of nodes(page).filter((node) => node.type === "Text")) {
          const background = headerTexts.includes(label)
            ? style(header).backgroundColor
            : style(page).backgroundColor;
          assert.ok(
            contrast(style(label).color, background) >= 4.5,
            "currency, captions and exact balances stay readable against their light surfaces",
          );
        }
        assert.ok(
          amounts.every(
            (amount) =>
              style(amount).fontFamily === "mono" &&
              style(amount).fontVariant.includes("tabular-nums"),
          ),
          "financial digits retain stable mono columns",
        );
      }
      assert.ok(text(root).includes("AFN") && text(root).includes("USD"));
      assert.ok(!text(root).includes("EUR"), "unused zero currency omitted");
      assert.ok(
        text(cards[0]).includes("100") && text(cards[1]).includes("100"),
        "opposing balances never cancel",
      );
      assert.ok(text(cards[2]).includes("0.30") && text(cards[3]).includes("9.12"));
      assert.equal(current.scroll().props.horizontal, true);
      assert.equal(current.scroll().props.pagingEnabled, undefined);
      assert.equal(style(current.scroll()).direction, "ltr");
      assert.equal(
        style(current.scroll()).height,
        compact ? 104 : 132,
        "more currencies never increase the sticky header height",
      );
      current.measure();
      assert.equal(
        current.scroll().props.snapToInterval,
        undefined,
        "native snapping uses absolute page boundaries",
      );
      assert.deepEqual(current.scroll().props.snapToOffsets, [0, 370]);
      assert.ok(
        children(current.scroll()).every((page) => style(page).width === 358),
        "every 390px-screen currency page fills the measured 358px viewport",
      );
      const contentStyle = flattenStyle(current.scroll().props.contentContainerStyle);
      assert.equal(contentStyle.paddingRight ?? 0, 0, "the final page has no peek padding");
      const pageCount = children(current.scroll()).length;
      const contentWidth = pageCount * 358 + (pageCount - 1) * contentStyle.gap;
      assert.equal(
        contentWidth - 358,
        current.scroll().props.snapToOffsets.at(-1),
        "the last snap lands at the content end without a clipped sliver",
      );
      assert.equal(
        byId(current.hooks.tree, "home-balance-edge-fades"),
        undefined,
        "the light board has no edge-fade overlay",
      );
      await current.ready();
      assert.equal(current.timers.size, compact ? 0 : 1);
      current.hooks.unmount();
    }
  }
  for (const locale of ["en", "fa", "ps"] as const) {
    for (const platform of ["ios", "android"]) {
      const current = fixture(locale, 320, 1.8, 568, platform);
      for (const currency of ["AFN", "USD", "XYZ"]) {
        const root = current.render({
          currency,
          balances: [
            { currency, collect: 12.34, pay: 5.67, pending: false },
            { currency: "EUR", collect: 0, pay: 0, pending: false },
          ],
        }) as UINode;
        const page = children(current.scroll())[0];
        assert.equal(children(current.scroll()).length, 1);
        assert.equal(byId(root, `home-balance-currency-${currency}`), undefined);
        assert.ok(
          !nodes(page).some((node) => style(node).backgroundColor === colors.bgMuted),
          "one visible currency has no gray header or reserved header row",
        );
        assert.deepEqual(
          nodes(page)
            .filter((node) => node.props.minimumFontScale !== undefined)
            .map(text),
          ["12.34", "5.67"],
          "each amount keeps its exact digits",
        );
        for (const side of ["collect", "pay"]) {
          const symbol = byId(root, `home-balance-symbol-${side}-${currency}`);
          assert.equal(text(symbol), currencySymbols[currency] ?? currency);
          const valueRow = nodes(page).find((node) => children(node).includes(symbol))!;
          assert.equal(style(valueRow).direction, "ltr");
          assert.equal(style(valueRow).flexDirection, "row");
          assert.equal(
            children(valueRow)[0],
            symbol,
            "the symbol stays beside the number in every language",
          );
        }
        assert.equal(style(quoteRow(page)).direction, "ltr");
        assert.equal(current.scroll().props.scrollEnabled, false);
        assert.equal(style(current.scroll()).height, 112);
        assert.ok(root.props.accessibilityLabel.includes(currency));
      }
      current.hooks.unmount();
    }
  }
  {
    const current = fixture("fa", 320, 1.8, 568);
    const root = current.render({
      people: [],
      compact: true,
      balances: [{ currency: "USD", collect: 123456789.01, pay: 8.76, pending: false }],
    }) as UINode;
    assert.equal(
      style(quoteRow(children(current.scroll())[0])).flexDirection,
      "row",
      "collect/pay positions stay LTR on small screens",
    );
    assert.equal(style(current.scroll()).height, 86, "one currency omits the header's height");
    const numbers = nodes(root).filter((node) => node.props.minimumFontScale !== undefined);
    assert.equal(numbers.length, 2);
    assert.equal(
      text(numbers[0]),
      "123,456,789.01",
      "complete amount, no abbreviation or rounding",
    );
    assert.equal(text(numbers[1]), "8.76");
    current.measure();
    await current.ready();
    assert.equal(current.scroll().props.scrollEnabled, false);
    assert.equal(current.timers.size, 0, "a single denomination never rotates");
    current.hooks.unmount();
  }
  {
    const current = fixture("en");
    const { module } = current;
    const rows = module.visibleCurrencyBalances(balances, "AFN");
    assert.deepEqual(
      rows.map((row) => row.currency),
      ["AFN", "USD"],
    );
    assert.deepEqual(module.visibleCurrencyBalances([], "USD"), [
      { currency: "USD", collect: 0, pay: 0, pending: false },
    ]);
    const pending = current.render({
      people: [],
      balances: [{ currency: "USD", collect: 500, pay: 12, pending: true }],
    }) as UINode;
    assert.ok(text(pending).includes("…"));
    assert.ok(
      !text(pending).includes("500"),
      "unknown shared values are not presented as confirmed",
    );
    const pendingAmounts = nodes(pending).filter(
      (node) => node.props.minimumFontScale !== undefined,
    );
    assert.deepEqual(pendingAmounts.map(text), ["…", "…"]);
    assert.ok(
      pendingAmounts.every((amount) => style(amount).color === colors.textSubtle),
      "unknown balances are neutral rather than directional claims",
    );
    const empty = current.render({ balances: [], currency: "USD" });
    const zeroAmounts = nodes(empty).filter((node) => node.props.minimumFontScale !== undefined);
    assert.deepEqual(zeroAmounts.map(text), ["0", "0"]);
    assert.ok(zeroAmounts.every((amount) => style(amount).color === colors.textSubtle));
    assert.equal(byId(empty, "home-balance-currency-USD"), undefined);
    assert.ok(empty.props.accessibilityLabel.includes("USD $"));
    current.hooks.unmount();
  }
  {
    const current = fixture("en");
    const many = ["AFN", "USD", "EUR", "PKR", "IRR", "AED", "SAR", "INR", "GBP", "JPY", "CHF"].map(
      (currency, index) => ({ currency, collect: index + 1, pay: index + 2, pending: false }),
    );
    many.push({ currency: "CAD", collect: 0, pay: 0, pending: true });
    const root = current.render({ balances: many });
    const pairs = children(current.scroll());
    assert.equal(pairs.length, many.length, "no currency count cap hides active denominations");
    for (const row of many)
      assert.ok(text(root).includes(row.currency), `${row.currency} remains reachable by swipe`);
    assert.equal(pairs.flatMap(balanceCells).length, many.length * 2);
    current.hooks.unmount();
  }
  // Android converts each absolute DIP offset to physical pixels. Rounding
  // one interval first would accumulate over many currencies at this density.
  {
    const current = fixture("en", 390, 1, 844, "android");
    const many = Array.from({ length: 64 }, (_, index) => ({
      currency: `A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
      collect: index + 1,
      pay: index + 2,
      pending: false,
    }));
    current.render({ balances: many });
    current.measure();
    const scroll = current.scroll();
    const pages = children(scroll);
    const gap = flattenStyle(scroll.props.contentContainerStyle).gap;
    const pageWidth = style(pages[0]).width;
    const step = pageStep(scroll);
    const offsets: number[] = scroll.props.snapToOffsets;
    assert.equal(scroll.props.snapToInterval, undefined);
    assert.deepEqual(
      offsets,
      pages.map((_, index) => index * (pageWidth + gap)),
    );
    const contentWidth = pages.length * pageWidth + (pages.length - 1) * gap;
    assert.equal(
      offsets.at(-1),
      contentWidth - pageWidth,
      "all 64 denominations end at the final complete page",
    );
    const density = 2.625;
    assert.ok(
      offsets.every((offset) => Math.abs(Math.floor(offset * density) / density - offset) < 1),
      "absolute native pixel rounding stays within one DIP on every page",
    );
    const roundedIntervalEnd = (Math.floor(step * density) / density) * (pages.length - 1);
    assert.ok(
      Math.abs(roundedIntervalEnd - offsets.at(-1)!) > 1,
      "the regression density would expose accumulated interval drift",
    );
    current.hooks.unmount();
  }
  // Safe integer cents near the maximum cannot all round-trip through major
  // units. This largest nearby round-trippable total retains every digit.
  const largestExactTotal = fromMinorUnits(Number.MAX_SAFE_INTEGER - 1);
  const largestExactText = "90,071,992,547,409.90";
  assert.equal(formatMoneyAmount(largestExactTotal), largestExactText);
  for (const compact of [false, true]) {
    const current = fixture("fa", 320, 1.8);
    current.render({
      compact,
      balances: [
        { currency: "USD", collect: largestExactTotal, pay: largestExactTotal, pending: false },
      ],
    });
    current.measure(288);
    const root = current.hooks.tree;
    const page = children(current.scroll())[0];
    const cards = balanceCells(page);
    const amounts = nodes(page).filter((node) => node.props.minimumFontScale !== undefined);
    assert.equal(amounts.length, 2);
    for (const [index, amount] of amounts.entries()) {
      assert.equal(
        text(amount),
        largestExactText,
        "maximum totals keep every grouped digit and cent in visible JSX",
      );
      assert.equal(amount.props.adjustsFontSizeToFit, true);
      assert.equal(amount.props.numberOfLines, 1);
      assert.equal(style(amount).writingDirection, "ltr");
      const card = style(cards[index]);
      const availableWidth =
        (style(page).width - style(page).borderWidth * 2) / 2 -
        card.paddingHorizontal * 2 -
        (card.borderLeftWidth ?? 0) -
        (compact ? 12 : 14) * 0.8 * 1.2 -
        6;
      const cappedFontScale = Math.min(1.8, amount.props.maxFontSizeMultiplier);
      const monoEstimate = text(amount).length * style(amount).fontSize * 0.65 * cappedFontScale;
      assert.ok(
        amount.props.minimumFontScale > 0 && amount.props.minimumFontScale < 0.5,
        "the largest totals can shrink beyond the old half-size floor",
      );
      assert.ok(
        monoEstimate * amount.props.minimumFontScale <= availableWidth + 1e-7,
        "the minimum scale permits all mono digits inside the actual padded card width",
      );
    }
    assert.equal(
      root.props.accessibilityLabel.split(largestExactText).length - 1,
      2,
      "assistive output preserves the entire collect and pay totals",
    );
    assert.ok(root.props.accessibilityLabel.includes("USD"));
    current.hooks.unmount();
  }
  const rotatingBalances = [
    balances[0],
    balances[1],
    { currency: "EUR", collect: 7, pay: 3, pending: false },
  ];
  for (const height of [844, 400]) {
    const current = fixture("ps", 320, 1.8, height);
    current.render({ balances: rotatingBalances });
    current.measure(288);
    await current.ready();
    assert.equal(style(current.scroll()).height, height < 500 ? 114 : 144);
    assert.ok(
      children(current.scroll()).every((pair) => style(pair).width === 288),
      "narrow screens use the full viewport for both cards",
    );
    assert.equal(
      current.timers.size,
      height < 500 ? 0 : 1,
      "short landscape pauses motion and reserves list space",
    );
    current.hooks.unmount();
  }
  {
    const current = fixture("en");
    current.render({ balances: rotatingBalances });
    assert.equal(
      current.timers.size,
      0,
      "unknown accessibility preferences prevent automatic motion",
    );
    await current.ready();
    assert.equal(current.timers.size, 0, "auto movement waits for the real viewport measurement");
    current.measure();
    const step = pageStep(current.scroll());
    assert.ok(step > 0);
    const markerX = () => {
      const thumb = nodes(current.hooks.tree).find((node) =>
        style(node).transform?.some((transform: any) => "translateX" in transform),
      )!;
      return style(thumb).transform.find((transform: any) => "translateX" in transform).translateX;
    };
    assert.equal(markerX(), 0);
    const firstMove = current.advance(false);
    assert.equal(
      current.hooks.tree.props.accessibilityValue.now,
      1,
      "requesting an animated move does not announce its target early",
    );
    assert.equal(
      markerX(),
      0,
      "the marker stays on the displayed page before native scroll events",
    );
    current.onScroll(0);
    assert.equal(
      markerX(),
      0,
      "the native animation's first old-position frame cannot make the marker jump back",
    );
    current.onScroll(firstMove.x);
    assert.equal(current.hooks.tree.props.accessibilityValue.now, 2);
    assert.ok(markerX() > 0, "the marker moves once native scrolling reaches the next page");
    const positions = [firstMove.x, current.advance().x, current.advance().x, current.advance().x];
    assert.deepEqual(
      positions,
      [step, step * 2, step, 0],
      "automatic movement advances one neighbor and reverses at the ends",
    );
    assert.equal(current.timers.size, 1);
    current.hooks.unmount();
  }
  for (const interaction of [
    "touch",
    "drag",
    "accessibilityTap",
    "increment",
    "decrement",
  ] as const) {
    const current = fixture("en");
    current.render({ balances: rotatingBalances });
    await current.ready();
    current.measure();
    const obsolete = [...current.timers.values()][0];
    if (interaction === "touch") current.hooks.tree.props.onTouchStart();
    else if (interaction === "drag") current.scroll().props.onScrollBeginDrag();
    else if (interaction === "accessibilityTap") current.hooks.tree.props.onAccessibilityTap();
    else
      current.hooks.tree.props.onAccessibilityAction({ nativeEvent: { actionName: interaction } });
    current.render();
    assert.equal(current.timers.size, 0, `${interaction} permanently stops automatic motion`);
    if (interaction === "increment" || interaction === "decrement")
      assert.equal(
        current.calls.at(-1)!.animated,
        false,
        "assistive adjustments announce their target immediately without an animation",
      );
    if (interaction === "increment") {
      assert.equal(current.hooks.tree.props.accessibilityValue.now, 2);
      assert.ok(current.hooks.tree.props.accessibilityLabel.includes("USD"));
      assert.ok(
        current.hooks.tree.props.accessibilityLabel.includes("0.30") &&
          current.hooks.tree.props.accessibilityLabel.includes("9.12"),
        "assistive navigation announces the complete pair for the selected currency",
      );
    }
    const callsAfterInteraction = current.calls.length;
    obsolete.run();
    current.render();
    assert.equal(
      current.calls.length,
      callsAfterInteraction,
      "a canceled auto frame cannot override manual interaction",
    );
    current.render({ active: false });
    current.render({ active: true });
    current.setFocused(false);
    current.setFocused(true);
    current.render({ compact: true });
    current.render({ compact: false });
    assert.equal(
      current.timers.size,
      0,
      "temporary pauses never undo the mounted book's manual stop",
    );
    current.hooks.unmount();
  }
  for (const pause of [
    "inactive",
    "keyboard",
    "route",
    "background",
    "androidBlur",
    "reader",
    "motion",
  ] as const) {
    const current = fixture("en", 390, 1, 844, "android");
    current.render({ balances: rotatingBalances });
    await current.ready();
    current.measure();
    const obsolete = [...current.timers.values()][0];
    const change = (paused: boolean) => {
      if (pause === "inactive") current.render({ active: !paused });
      else if (pause === "keyboard") current.render({ compact: paused });
      else if (pause === "route") current.setFocused(!paused);
      else if (pause === "background") current.emitApp("change", paused ? "background" : "active");
      else if (pause === "androidBlur") current.emitApp(paused ? "blur" : "focus");
      else if (pause === "reader") current.emitAccessibility("screenReaderChanged", paused);
      else current.emitAccessibility("reduceMotionChanged", paused);
    };
    change(true);
    assert.equal(current.timers.size, 0, `${pause} pauses automatic movement`);
    const pausedCalls = current.calls.length;
    obsolete.run();
    current.render();
    assert.equal(current.calls.length, pausedCalls);
    change(false);
    assert.equal(current.timers.size, 1, `${pause} can resume before manual interaction`);
    obsolete.run();
    current.render();
    assert.equal(current.calls.length, pausedCalls, "the old timeout remains stale after resuming");
    current.hooks.unmount();
  }
  for (const preference of ["screenReaderChanged", "reduceMotionChanged"] as const) {
    const current = fixture("en");
    current.render({ balances: rotatingBalances });
    current.measure();
    current.emitAccessibility(preference, true);
    await current.ready();
    assert.equal(
      current.timers.size,
      0,
      "a late initial query cannot undo a newer accessibility preference",
    );
    current.emitAccessibility(preference, false);
    assert.equal(current.timers.size, 1);
    current.hooks.unmount();
  }
  {
    const current = fixture("fa");
    current.render({ balances: rotatingBalances });
    current.measure();
    await current.ready(true, true);
    assert.equal(current.timers.size, 0);
    assert.equal(current.hooks.tree.props.accessibilityRole, "adjustable");
    assert.deepEqual(
      current.hooks.tree.props.accessibilityActions.map((action: { name: string }) => action.name),
      ["increment", "decrement"],
    );
    current.hooks.tree.props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } });
    current.render();
    assert.equal(
      current.hooks.tree.props.accessibilityValue.now,
      2,
      "screen-reader users can reach every currency without autoplay",
    );
    assert.equal(
      current.calls.at(-1)!.animated,
      false,
      "manual assistive navigation respects Reduce Motion",
    );
    current.hooks.unmount();
  }
  {
    const current = fixture("en");
    current.render({ balances: rotatingBalances });
    await current.ready();
    current.measure();
    const step = pageStep(current.scroll());
    current.onScroll(step);
    current.render({ balances: [rotatingBalances[2], rotatingBalances[0], rotatingBalances[1]] });
    assert.deepEqual(
      current.calls.at(-1),
      { x: step * 2, animated: false },
      "reordering currencies keeps the currently viewed denomination",
    );
    current.setWidth(320);
    current.measure(288);
    assert.equal(current.scroll().props.snapToInterval, undefined);
    assert.deepEqual(current.scroll().props.snapToOffsets, [0, 300, 600]);
    assert.ok(
      children(current.scroll()).every((page) => style(page).width === 288),
      "rotation gives every currency the full new viewport",
    );
    assert.deepEqual(
      current.calls.at(-1),
      { x: current.scroll().props.snapToOffsets[2], animated: false },
      "orientation/viewport changes align the same currency without animation",
    );
    const staleTimer = [...current.timers.values()][0];
    const staleReader = [...current.accessibility.get("screenReaderChanged")!][0];
    const staleApp = [...current.appListeners.get("change")!][0];
    const finalCalls = current.calls.length;
    current.hooks.unmount();
    const lateWrites = current.hooks.lateWrites;
    staleTimer.run();
    staleReader(true);
    staleApp("background");
    assert.equal(current.calls.length, finalCalls, "unmounted summary timers cannot scroll");
    assert.equal(current.hooks.lateWrites, lateWrites);
    assert.equal(current.timers.size, 0);
    const replacement = fixture("en");
    replacement.render({ balances: rotatingBalances });
    await replacement.ready();
    replacement.measure();
    assert.equal(
      replacement.timers.size,
      1,
      "a newly mounted book starts a fresh automatic session",
    );
    replacement.hooks.unmount();
  }
  {
    const rowModule = compileUI("../../components/PersonRow", {
      react: { memo: (fn: any) => fn, useRef: (value: any) => ({ current: value }) },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        View: "View",
        Text: "Text",
        Pressable: "Pressable",
        StyleSheet: { create: (value: any) => value },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "./SharedAccountBadge": { SharedAccountBadge: "SharedAccountBadge" },
      "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
      "./SelectionMark": { SelectionMark: "SelectionMark" },
      "../lib/colors": { colors },
      "../lib/currency": {
        getCurrentCurrencyCode: () => "AFN",
        getCurrencyLabel: (code: string) => code,
      },
      "../lib/direction": {
        rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
        textDir: () => ({}),
        useIsRTL: () => true,
      },
      "../lib/fonts": {
        fonts: { sansSemi: "sans", sansRegular: "sans", sansMedium: "sans", monoSemi: "mono" },
      },
      "../lib/format": { formatAmount: formatMoneyAmount, formatRelative: () => "today" },
      "../lib/i18n": language,
      "../lib/tokens": { icon: { row: 22 } },
      "../lib/multi-currency-view": { personCurrencyRows },
      "../lib/tabs/link-status": require("../tabs/link-status"),
    });
    const base = {
      id: "customer",
      name: "One customer",
      balance: 100,
      currency: "AFN",
      last_entry_at: 1,
      tab_id: null,
      tab_pending: 0,
    };
    const root = rowModule.PersonRow({
      person: { ...base, currency_balances: [base, { ...base, currency: "USD", balance: -100 }] },
      showDirection: true,
      onPress: () => {},
    }) as UINode;
    assert.ok(text(root).includes("+100") && text(root).includes("−100"));
    assert.ok(
      text(root).includes("AFN") && text(root).includes("USD"),
      "one customer row shows opposing currencies together",
    );
    assert.equal(
      nodes(root).filter((node) => node.type === "Pressable").length,
      1,
      "one customer stays one navigation target",
    );
  }
  console.log(
    "PASS home balances: all currency pairs reachable, exact independent amounts, EN/FA/PS LTR, bounded compact layout, adjacent/reversing auto movement, permanent manual stop, keyboard/route/AppState/accessibility pauses and stale-work cleanup; customer-row currencies preserved",
  );
}
void main();
