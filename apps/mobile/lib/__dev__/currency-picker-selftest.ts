// Executes the picker at native UI boundaries. Actual keyboard animation,
// typography, and finger/responder transfer still need a device review.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const currencies = [
  { code: "AFN", name: "Afghan Afghani", symbol: "؋" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "KWD", name: "Kuwaiti Dinar", symbol: "KWD" },
  ...Array.from({ length: 160 }, (_, index) => ({
    code: `X${index}`,
    name: `Currency ${index}`,
    symbol: `X${index}`,
  })),
];
const find = (tree: any, type: string) => {
  const result = nodes(tree).find((node) => node.type === type);
  assert.ok(result, `Missing ${type}`);
  return result;
};
let scenarios = 0;
for (const platform of ["ios", "android"]) {
  for (const locale of ["en", "fa", "ps"]) {
    const hooks = uiHooks();
    const rtl = locale !== "en";
    let dimensions = { width: 320, height: 640 };
    let dismissed = 0,
      keyboardDismissed = 0,
      nativeScroll: unknown;
    const selected: string[] = [];
    const listeners = new Map<string, (event: any) => void>();
    const resets: unknown[] = [];
    const nativeList = {
      getNativeScrollRef: () => ({ native: true }),
      scrollToOffset: (options: unknown) => resets.push(options),
    };
    const dragScrollProps = {
      ref: (scroll: unknown) => (nativeScroll = scroll),
      onScroll: () => {},
      onTouchStart: () => {},
    };
    const { CurrencyPickerSheet } = compileUI("../../components/CurrencyPickerSheet", {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        Animated: { View: "AnimatedView" },
        FlatList: "FlatList",
        Modal: "Modal",
        Platform: { OS: platform },
        Pressable: "Pressable",
        StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
        useWindowDimensions: () => dimensions,
        Keyboard: {
          metrics: () => undefined,
          dismiss: () => keyboardDismissed++,
          scheduleLayoutAnimation: () => {},
          addListener: (name: string, callback: (event: any) => void) => {
            listeners.set(name, callback);
            return { remove: () => listeners.delete(name) };
          },
        },
      },
      "react-native-safe-area-context": {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => ({ top: 24, bottom: 20, left: 0, right: 0 }),
      },
      "../lib/colors": { colors: {} },
      "../lib/currency": {
        getCurrencyName: (code: string) =>
          `${locale}:${currencies.find((currency) => currency.code === code)?.name}`,
        currencyNeedsPrecisionHint: (code: string) => code === "KWD",
      },
      "../lib/currency-catalog": {
        searchCurrencies: (query: string, searchLocale: string) => {
          assert.equal(searchLocale, locale, "Search follows the current locale");
          return currencies.filter(
            (currency) =>
              currency.code.toLowerCase().includes(query.trim().toLowerCase()) ||
              currency.name.toLowerCase().includes(query.trim().toLowerCase()),
          );
        },
      },
      "../lib/direction": {
        useIsRTL: () => rtl,
        ltrIsolate: (text: string) => text,
        rowDir: (value: boolean) => ({ flexDirection: value ? "row-reverse" : "row" }),
        textDir: (value: boolean) => ({ textAlign: value ? "right" : "left" }),
        trackingSafe: (value: boolean) => (value ? { letterSpacing: 0 } : null),
      },
      "../lib/fonts": { fonts: {} },
      "../lib/i18n": { getLocale: () => locale, t: (key: string) => key },
      "../lib/tokens": {
        icon: { row: 22, trailing: 18 },
        radius: { sm: 8, sheet: 18 },
        typography: { caption: {}, hint: {} },
      },
      "../lib/use-overlay-animation": {
        useOverlayAnimation: (visible: boolean) => ({ rendered: visible, opacity: 1, position: 0 }),
      },
      "../lib/use-sheet-drag": {
        useSheetDrag: (_visible: boolean, _position: unknown, onDismiss: () => void) => ({
          translateY: 0,
          panHandlers: { testHandleDrag: true },
          surfacePanHandlers: { testSurfaceDrag: true },
          scrollProps: dragScrollProps,
          dismiss: () => {
            keyboardDismissed++;
            onDismiss();
          },
        }),
      },
      "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
      "./SheetHandle": { SheetHandle: "SheetHandle" },
    });
    let props = {
      visible: false,
      selectedCode: "EUR",
      onSelect: (code: string) => selected.push(code),
      onDismiss: () => dismissed++,
    };
    const render = (next: Partial<typeof props> = {}) => {
      props = { ...props, ...next };
      return hooks.render(() => CurrencyPickerSheet(props));
    };
    assert.equal(render(), null, "Closed picker mounts no native modal");
    let tree = render({ visible: true });
    let list = find(tree, "FlatList");
    assert.equal(list.props.data.length, currencies.length);
    assert.equal(list.props.data[0].code, "EUR", "Selected currency is immediately visible");
    assert.deepEqual(
      list.props.data.slice(1).map((currency: any) => currency.code),
      currencies.filter((currency) => currency.code !== "EUR").map((currency) => currency.code),
      "Other currencies retain the catalogue's popular/alphabetical order",
    );
    assert.equal(
      nodes(tree).filter((node) => node.type === "Pressable").length,
      0,
      "The long currency catalogue is virtualized rather than mounted as all rows",
    );
    assert.equal(
      find(tree, "TextInput").props.autoFocus,
      undefined,
      "Opening the picker leaves the keyboard closed",
    );
    assert.equal(list.props.keyboardShouldPersistTaps, "handled");
    list.props.ref(nativeList);
    const scrollRefCallback = list.props.ref;
    assert.deepEqual(nativeScroll, { native: true }, "Sheet drag tracks the actual scroll view");
    assert.equal(find(tree, "SafeAreaView").props.testSurfaceDrag, true);
    assert.equal(find(tree, "SheetHandle").props.panHandlers.testHandleDrag, true);
    const row = list.props.renderItem({ item: currencies[2] });
    assert.equal(row.props.accessibilityState.selected, true);
    assert.equal(
      flattenStyle(row.props.style({ pressed: false })).flexDirection,
      rtl ? "row-reverse" : "row",
    );
    const name = find(row, "Text");
    assert.equal(name.props.children, `${locale}:Euro`);
    assert.equal(name.props.numberOfLines, undefined, "Long translated labels may wrap");
    assert.equal(
      nodes(row).some((node) => node.props.children === "EUR  ·  €"),
      true,
      "ISO code distinguishes currencies with the same symbol",
    );
    const precisionRow = list.props.renderItem({ item: currencies[3] });
    assert.equal(
      nodes(precisionRow).some((node) => node.props.children === "currency.precisionHint"),
      true,
    );
    assert.equal(
      nodes(row).some((node) => node.props.children === "currency.precisionHint"),
      false,
    );

    find(tree, "TextInput").props.onChangeText("usd");
    tree = render();
    list = find(tree, "FlatList");
    assert.equal(
      list.props.ref,
      scrollRefCallback,
      "Renders retain the native ref so drag tracking does not reset while scrolled",
    );
    assert.deepEqual(
      list.props.data.map((currency: any) => currency.code),
      ["USD"],
    );
    assert.deepEqual(
      resets.at(-1),
      { offset: 0, animated: false },
      "A filtered result starts at the top even after scrolling the full catalogue",
    );
    list.props.renderItem({ item: currencies[1] }).props.onPress();
    assert.deepEqual(selected, ["USD"]);
    assert.equal(dismissed, 1);
    assert.equal(keyboardDismissed, 1, "Selection dismisses the search keyboard too");

    find(tree, "TextInput").props.onChangeText("no such currency");
    tree = render();
    assert.equal(find(tree, "FlatList").props.data.length, 0);
    assert.equal(
      find(tree, "FlatList").props.ListEmptyComponent.props.children,
      "currency.noMatch",
    );
    render({ visible: false });
    tree = render({ visible: true });
    assert.equal(find(tree, "TextInput").props.value, "", "Reopening clears the previous query");

    const showEvent = platform === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const modalViewport = () =>
      nodes(tree).find((node) => node.props.testID === "currency-picker-viewport")!;
    const measureModal = (height: number) => {
      modalViewport().props.onLayout({ nativeEvent: { layout: { height } } });
    };
    assert.equal(
      flattenStyle(modalViewport().props.style).flex,
      1,
      "Modal viewport measures available native space independently of the sheet",
    );
    // Android's Modal may resize even when the Activity's Dimensions stay full.
    measureModal(platform === "android" ? 300 : 640);
    listeners.get(showEvent)!({ endCoordinates: { screenY: 300 } });
    tree = render();
    assert.equal(
      flattenStyle(find(tree, "SafeAreaView").props.style).height,
      268,
      "Search uses the available modal viewport above the keyboard",
    );
    assert.deepEqual(
      find(tree, "SafeAreaView").props.edges,
      [],
      "Keyboard removes bottom safe padding even when Android's modal is already resized",
    );
    const container = nodes(tree).find(
      (node) => node.type === "AnimatedView" && node.props.pointerEvents,
    )!;
    assert.equal(
      flattenStyle(container.props.style).bottom,
      platform === "ios" ? 340 : 0,
      "The sheet avoids keyboard overlap without double-counting Android's independent modal resize",
    );
    dimensions = { width: 640, height: 320 };
    measureModal(platform === "android" ? 160 : 320);
    listeners.get(showEvent)!({ endCoordinates: { screenY: 160 } });
    tree = render();
    assert.equal(
      flattenStyle(find(tree, "SafeAreaView").props.style).height,
      128,
      "Landscape search fits the space above the keyboard rather than forcing a tall panel",
    );
    assert.equal(
      nodes(tree).some((node) => node.type === "SheetHandle"),
      false,
      "Compact search gives result space priority over the drag handle",
    );
    assert.equal(
      nodes(tree).some((node) => node.props.children === "currency.title"),
      false,
      "Compact search omits the extra title line",
    );
    assert.equal(
      find(tree, "SafeAreaView").props.testSurfaceDrag,
      true,
      "The panel still supports swipe dismissal without the handle",
    );
    const compactClose = nodes(tree).find(
      (node) => node.props.accessibilityLabel === "common.close",
    )!;
    assert.equal(compactClose.props.accessibilityRole, "button");
    const closeStyle = flattenStyle(compactClose.props.style);
    assert.ok(
      closeStyle.minHeight >= 44 && closeStyle.minWidth >= 44,
      "Compact search preserves an accessible close target",
    );
    const compactInput = find(tree, "TextInput");
    const searchRow = nodes(tree).find(
      (node) => node.type === "View" && [node.props.children].flat().includes(compactInput),
    )!;
    const sheetStyle = flattenStyle(find(tree, "SafeAreaView").props.style);
    const searchStyle = flattenStyle(searchRow.props.style);
    const inputStyle = flattenStyle(compactInput.props.style);
    const contentStyle = flattenStyle(find(tree, "FlatList").props.contentContainerStyle);
    const chromeHeight =
      sheetStyle.paddingTop +
      sheetStyle.borderTopWidth +
      Math.max(inputStyle.minHeight, closeStyle.minHeight) +
      searchStyle.borderWidth * 2 +
      searchStyle.marginBottom;
    assert.ok(
      sheetStyle.height - chromeHeight - contentStyle.paddingBottom >= 60,
      "Compact chrome leaves room for at least one full 60px result row in 128px",
    );
    compactClose.props.onPress();
    assert.equal(dismissed, 2, "Compact close dismisses the sheet and keyboard");
    measureModal(320);
    if (platform === "ios") {
      listeners.get(showEvent)!({ endCoordinates: { screenY: 320 } });
      tree = render();
      assert.equal(
        flattenStyle(find(tree, "SafeAreaView").props.style).height,
        240,
        "The iOS outgoing keyboard frame restores the normal sheet cap without a full-height jump",
      );
    }
    listeners.get("keyboardDidHide")!({});
    tree = render();
    assert.equal(flattenStyle(find(tree, "SafeAreaView").props.style).height, 240);
    assert.deepEqual(find(tree, "SafeAreaView").props.edges, ["bottom"]);
    find(tree, "Modal").props.onRequestClose();
    assert.equal(dismissed, 3, "Android back and native close share sheet dismissal");
    measureModal(160);
    render({ visible: false });
    tree = render({ visible: true });
    assert.equal(
      flattenStyle(find(tree, "SafeAreaView").props.style).height,
      240,
      "Reopening clears stale measurements left by the previous keyboard-sized modal",
    );
    hooks.unmount();
    assert.equal(listeners.size, 0, "Keyboard listeners do not outlive the picker");
    scenarios++;
  }
}
console.log(`Currency picker: ${scenarios} platform/locale scenarios passed.`);
