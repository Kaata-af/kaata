// Real country search and picker rendering with synthetic native boundaries.
// Native scrolling, fonts and keyboard geometry still need a phone check.
import assert from "node:assert/strict";
import { COUNTRIES } from "../phone-countries";
import { searchCountries } from "../country-search";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import type { LocaleCode } from "../i18n";
import phoneMetadata from "libphonenumber-js/metadata.min.json";

const phone = compileUI("../phone", {
  "./db": {},
  "./digits": require("../digits"),
  "./phone-countries": require("../phone-countries"),
  "libphonenumber-js/core": require("libphonenumber-js/core"),
  "libphonenumber-js/metadata.min.json": phoneMetadata,
}) as typeof import("../phone");

assert.equal(searchCountries(""), COUNTRIES);
assert.equal(searchCountries("  "), COUNTRIES);
for (const country of COUNTRIES) {
  for (const query of [
    country.name,
    country.nameFa,
    country.namePs,
    country.code,
    country.dialCode,
    country.dialCode.replace(/\d/g, (digit) => String.fromCharCode(0x06f0 + Number(digit))),
  ]) {
    assert(
      searchCountries(query).some((match) => match.code === country.code),
      `${country.code}: ${query}`,
    );
  }
}
for (const [query, code] of [
  ["Canada", "CA"],
  ["کاناډا", "CA"],
  ["کانادا", "CA"],
  ["jp", "JP"],
  ["Kosovo", "XK"],
  ["Ascension", "AC"],
  ["Tristan", "TA"],
  ["UAE", "AE"],
  ["United Arab Emirates", "AE"],
  ["USA", "US"],
  ["UK", "GB"],
  ["cote d'ivoire", "CI"],
  ["سويدن", "SE"],
] as const) {
  assert(
    searchCountries(query).some((country) => country.code === code),
    query,
  );
}
for (const query of ["+93", "+۹۳", "٩٣", "0093", "۰۰ ۹۳"]) {
  assert.deepEqual(
    searchCountries(query).map((country) => country.code),
    ["AF"],
    query,
  );
}
const sharedOne = searchCountries("+۱");
assert(sharedOne.some((country) => country.code === "US"));
assert(sharedOne.some((country) => country.code === "CA"));
assert(sharedOne.some((country) => country.code === "BS"));
assert(sharedOne.every((country) => country.dialCode === "+1"));
assert.deepEqual(searchCountries("a country that does not exist"), []);
assert.deepEqual(searchCountries("+999999"), []);
assert.equal(searchCountries("us")[0].code, "US", "exact ISO code comes before name fragments");
assert.equal(searchCountries("IN")[0].code, "IN");

for (const locale of ["en", "fa", "ps"] as LocaleCode[]) {
  const hooks = uiHooks();
  const events: string[] = [];
  const scrollRefs: unknown[] = [];
  const resets: unknown[] = [];
  const isRTL = locale !== "en";
  let height = 800;
  const scrollHandlers = {
    ref: (value: unknown) => scrollRefs.push(value),
    onTouchStart: () => {},
    onScroll: () => {},
    scrollEventThrottle: 16,
  };
  const dismiss = () => events.push("dismiss");
  const native = {
    Animated: { View: "AnimatedView" },
    FlatList: "FlatList",
    Modal: "Modal",
    Pressable: "Pressable",
    View: "View",
    Text: "Text",
    TextInput: "TextInput",
    Platform: { OS: "ios" },
    StyleSheet: { create: (styles: unknown) => styles, flatten: flattenStyle, absoluteFill: {} },
    useWindowDimensions: () => ({ height, width: 360 }),
  };
  const safeArea = {
    SafeAreaView: "NativeSafeAreaView",
    useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
  };
  const surface = compileUI("../../components/SheetSurface", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "react-native-safe-area-context": safeArea,
  });
  const module = compileUI("../../components/CountryPickerSheet", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "./SheetSurface": surface,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./SheetHandle": { SheetHandle: "SheetHandle" },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: (visible: boolean) => ({ rendered: visible, opacity: 1, position: 0 }),
    },
    "../lib/use-sheet-drag": {
      useSheetDrag: () => ({
        translateY: 0,
        scrollProps: scrollHandlers,
        dismiss,
        panHandlers: { onMoveShouldSetPanResponderCapture: "handle-drag" },
        surfacePanHandlers: { onMoveShouldSetPanResponderCapture: "panel-drag" },
      }),
    },
    "../lib/colors": { colors: {} },
    "../lib/fonts": { fonts: {} },
    "../lib/tokens": { icon: { trailing: 18, row: 22 }, radius: { sm: 8, sheet: 18 } },
    "../lib/direction": {
      ltrIsolate: (text: string) => `\u2066${text}\u2069`,
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
      trackingSafe: () => ({}),
      useIsRTL: () => isRTL,
    },
    "../lib/i18n": { getLocale: () => locale, t: (key: string) => key },
    "../lib/phone": phone,
    "../lib/country-search": { searchCountries },
  });
  let props = {
    visible: true,
    selectedCode: "CA",
    onSelect: (code: string) => events.push(code),
    onDismiss: dismiss,
  };
  const render = () => hooks.render(() => module.CountryPickerSheet(props));
  let tree = render();
  const find = (type: string) => {
    const found = nodes(tree).find((node) => node.type === type);
    assert(found, `${locale}: missing ${type}`);
    return found;
  };
  const sheetSurface = () => {
    const mounted = nodes(tree).find((node) => node.type === surface.SheetSurface);
    assert(mounted, "the picker retains the shared safe-area surface");
    assert.equal(mounted.props.maxHeightRatio, 0.75);
    return surface.SheetSurface(mounted.props);
  };
  let list = find("FlatList");
  assert.equal(list.props.data.length, 245);
  assert(
    list.props.initialNumToRender < list.props.data.length,
    "opening does not mount all countries",
  );
  assert.equal(list.props.onScroll, scrollHandlers.onScroll);
  assert.equal(list.props.onTouchStart, scrollHandlers.onTouchStart);
  assert.equal(list.props.keyboardShouldPersistTaps, "handled");
  assert.equal(list.props.extraData, `${locale}:CA`);
  const nativeHost = {};
  list.props.ref({
    getNativeScrollRef: () => nativeHost,
    scrollToOffset: (config: unknown) => resets.push(config),
  });
  assert.equal(scrollRefs.at(-1), nativeHost, "drag receives native scroll identity");
  assert.equal(flattenStyle(sheetSurface().props.style).maxHeight, 600);
  assert.equal(sheetSurface().props.onMoveShouldSetPanResponderCapture, "panel-drag");
  assert.equal(sheetSurface().type, "View", "iOS uses context insets before native measurement");
  assert.equal(flattenStyle(sheetSurface().props.style).paddingBottom, 34);
  assert.equal(find("Modal").props.statusBarTranslucent, true);
  assert.equal(find("Modal").props.navigationBarTranslucent, undefined);
  assert.equal(
    find("SheetHandle").props.panHandlers.onMoveShouldSetPanResponderCapture,
    "handle-drag",
  );
  const search = find("TextInput");
  assert.equal(search.props.accessibilityLabel, "country.search");
  search.props.onChangeText("+۹۳");
  tree = render();
  list = find("FlatList");
  assert.deepEqual(
    list.props.data.map((country: any) => country.code),
    ["AF"],
  );
  assert.deepEqual(resets.at(-1), { offset: 0, animated: false }, "new search starts at the top");
  find("TextInput").props.onChangeText("Canada");
  tree = render();
  list = find("FlatList");
  const canada = list.props.data.find((country: any) => country.code === "CA");
  assert(canada);
  const row = list.props.renderItem({ item: canada });
  assert.equal(row.props.accessibilityState.selected, true);
  assert.equal(row.props.accessibilityRole, "button");
  assert.equal(row.props.accessibilityLabel, `${phone.getCountryName("CA", locale)} +1`);
  assert.equal(
    flattenStyle(row.props.style({ pressed: false })).flexDirection,
    isRTL ? "row-reverse" : "row",
  );
  assert(nodes(row).some((node) => node.props.children === phone.getCountryName("CA", locale)));
  assert(nodes(row).some((node) => node.props.children === "\u2066+1\u2069"));
  row.props.onPress();
  assert.deepEqual(events.slice(-2), ["CA", "dismiss"], "selection reaches caller before closing");
  find("TextInput").props.onChangeText("not a country");
  tree = render();
  assert.equal(find("FlatList").props.data.length, 0);
  assert(
    nodes(find("FlatList").props.ListEmptyComponent).some(
      (node) => node.props.children === "country.noMatch",
    ),
  );
  props = { ...props, visible: false };
  tree = render();
  assert.equal(tree, null);
  props = { ...props, visible: true };
  height = 600;
  tree = render();
  assert.equal(find("TextInput").props.value, "");
  assert.equal(find("FlatList").props.data.length, 245);
  assert.equal(flattenStyle(sheetSurface().props.style).maxHeight, 450);
  find("Modal").props.onRequestClose();
  assert.equal(events.at(-1), "dismiss");
  find("FlatList").props.ref(null);
  assert.equal(scrollRefs.at(-1), null);
  hooks.unmount();
}
console.log(
  "PASS: all-country search, localized code digits, virtualized selection, scroll reset, drag wiring and EN/FA/PS picker",
);
