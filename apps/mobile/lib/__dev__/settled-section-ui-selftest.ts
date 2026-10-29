import assert from "node:assert/strict";
import { colors } from "../colors";
import { compileUI, flattenStyle, jsx, nodes } from "./ui-fixture";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const tokens = compileUI("../tokens", {
  "./fonts": {
    fonts: {},
    sansLineHeight: (_size: number, line: number) => line,
    monoLineHeight: (_size: number, line: number) => line,
  },
});
const { SettledAccountsSection } = compileUI("../../components/SettledAccountsSection", {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "react-native": {
    Pressable: "Pressable",
    Text: "Text",
    StyleSheet: { create: (style: unknown) => style, hairlineWidth: 1 },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "../lib/colors": { colors },
  "../lib/direction": {
    rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
    textDir: (rtl: boolean) => ({ writingDirection: rtl ? "rtl" : "ltr" }),
    useIsRTL: () => language.getLocale() !== "en",
  },
  "../lib/i18n": language,
  "../lib/tokens": tokens,
});

for (const locale of ["en", "fa", "ps"] as const) {
  language.setLocale(locale);
  const accountsCard = jsx("AccountsCard", { children: jsx("Customer", { id: "settled-row" }) });
  let toggles = 0;
  const render = (expanded = false, disabled = false, count = 3) =>
    SettledAccountsSection({
      expanded,
      disabled,
      count,
      onToggle: () => toggles++,
      children: accountsCard,
    });
  const collapsed = render();
  assert.equal(collapsed.type, "Fragment", "no native wrapper changes the card's measured origin");
  assert.ok(!nodes(collapsed).includes(accountsCard), "collapsed settled accounts are not mounted");
  const trigger = nodes(collapsed).find((node) => node.type === "Pressable")!;
  assert.equal(trigger.props.accessibilityRole, "button");
  assert.equal(trigger.props.accessibilityLabel, language.t("home.settled.show"));
  assert.deepEqual(trigger.props.accessibilityValue, {
    text: language.t("home.settled.count", { count: 3 }),
  });
  assert.deepEqual(trigger.props.accessibilityState, { expanded: false, disabled: false });
  const layout = flattenStyle(trigger.props.style({ pressed: false }));
  assert.ok(layout.minHeight >= 44);
  assert.equal(layout.flexDirection, locale === "en" ? "row" : "row-reverse");
  assert.equal(layout.marginBottom, undefined, "the collapsed section adds no empty content gap");
  assert.equal(layout.position, undefined, "the toggle stays in normal scroll flow");
  trigger.props.onPress();
  assert.equal(toggles, 1);

  const expanded = render(true);
  const children = expanded.props.children;
  assert.equal(children[1], accountsCard, "the accounts card stays a direct sibling of the toggle");
  const close = nodes(expanded).find((node) => node.type === "Pressable")!;
  assert.equal(close.props.accessibilityLabel, language.t("home.settled.hide"));
  assert.deepEqual(close.props.accessibilityState, { expanded: true, disabled: false });
  assert.ok(
    nodes(expanded).some((node) => node.type === "Icon" && node.props.name === "chevron-up"),
  );
  const label = nodes(close).find((node) => node.type === "Text")!;
  assert.equal(
    label.props.numberOfLines,
    undefined,
    "translated labels can wrap with dynamic type",
  );
  assert.notEqual(label.props.allowFontScaling, false);
  close.props.onPress();
  assert.equal(toggles, 2);

  const blocked = nodes(render(true, true)).find((node) => node.type === "Pressable")!;
  assert.equal(blocked.props.disabled, true);
  assert.deepEqual(blocked.props.accessibilityState, { expanded: true, disabled: true });
  blocked.props.onPress();
  assert.equal(
    toggles,
    2,
    "disabled selection controls cannot collapse selected accounts mid-action",
  );
  assert.equal(render(false, false, 0), null, "no settled accounts leaves no separator or gap");
  assert.ok(
    nodes(render(false, false, 155)).some(
      (node) => node.type === "Text" && node.props.children === 155,
    ),
  );
}
console.log(
  "PASS settled-accounts disclosure: EN/FA/PS, collapsed unmount, direct card sibling, accessible counts/expanded state, wrapping and disabled controls",
);
