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
const { SettledHistoryToggle } = compileUI("../../components/SettledHistoryToggle", {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "react-native": {
    Pressable: "Pressable",
    Text: "Text",
    View: "View",
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
const { SettledAccountsSection } = compileUI("../../components/SettledAccountsSection", {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "./SettledHistoryToggle": { SettledHistoryToggle },
});

for (const locale of ["en", "fa", "ps"] as const) {
  language.setLocale(locale);
  for (const kind of ["accounts", "tallies"] as const) {
    let toggles = 0;
    const render = (expanded = false, disabled = false, count = 3, horizontalInset = 0) =>
      SettledHistoryToggle({
        kind,
        expanded,
        disabled,
        count,
        horizontalInset,
        onToggle: () => toggles++,
      });
    const labelKey = (expanded: boolean) =>
      kind === "accounts"
        ? expanded
          ? "home.settled.hide"
          : "home.settled.show"
        : expanded
          ? "person.history.hideSettled"
          : "person.history.seeSettled";
    const countKey = kind === "accounts" ? "home.settled.count" : "person.history.settledCount";
    const collapsed = render();
    assert.equal(collapsed.type, "Pressable", "the toggle adds no outer native wrapper");
    assert.equal(collapsed.props.testID, `settled-${kind}-toggle`);
    assert.equal(collapsed.props.accessibilityRole, "button");
    assert.equal(collapsed.props.accessibilityLabel, language.t(labelKey(false)));
    assert.deepEqual(collapsed.props.accessibilityValue, {
      text: language.t(countKey, { count: 3 }),
    });
    assert.deepEqual(collapsed.props.accessibilityState, { expanded: false, disabled: false });
    const layout = flattenStyle(collapsed.props.style({ pressed: false }));
    assert.ok(layout.minHeight >= 44);
    assert.equal(layout.flexDirection, locale === "en" ? "row" : "row-reverse");
    assert.equal(layout.position, undefined, "the toggle stays in normal scroll flow");
    assert.equal(layout.marginHorizontal ?? 0, 0, "customer pages already supply their gutter");
    assert.equal(
      flattenStyle(render(false, false, 3, 16).props.style({ pressed: false })).marginHorizontal,
      16,
      "homepage inset is applied once on the control",
    );
    assert.ok(
      nodes(collapsed).some(
        (node) => node.type === "Icon" && node.props.name === "checkmark-done-outline",
      ),
      "settled history has a visual aid distinct from an active balance",
    );
    assert.ok(
      nodes(collapsed).some((node) => node.type === "Icon" && node.props.name === "chevron-down"),
    );
    const label = nodes(collapsed).find(
      (node) => node.type === "Text" && node.props.children === language.t(labelKey(false)),
    )!;
    assert.ok(label);
    assert.equal(label.props.numberOfLines, undefined, "translated labels can wrap");
    assert.notEqual(label.props.allowFontScaling, false);
    const labelStyle = flattenStyle(label.props.style);
    assert.equal(labelStyle.minWidth, 0);
    assert.equal(labelStyle.flex, 1);
    assert.equal(labelStyle.writingDirection, locale === "en" ? "ltr" : "rtl");
    assert.ok(nodes(collapsed).some((node) => node.type === "Text" && node.props.children === 3));
    collapsed.props.onPress();
    assert.equal(toggles, 1);

    const expanded = render(true);
    assert.equal(expanded.props.accessibilityLabel, language.t(labelKey(true)));
    assert.deepEqual(expanded.props.accessibilityState, { expanded: true, disabled: false });
    assert.ok(
      nodes(expanded).some((node) => node.type === "Icon" && node.props.name === "chevron-up"),
    );
    expanded.props.onPress();
    assert.equal(toggles, 2);

    const blocked = render(true, true);
    assert.equal(blocked.props.disabled, true);
    assert.deepEqual(blocked.props.accessibilityState, { expanded: true, disabled: true });
    blocked.props.onPress();
    assert.equal(toggles, 2, "retained disabled controls cannot collapse history mid-action");
    assert.equal(render(false, false, 0), null, "empty history adds no control or gap");
    assert.ok(
      nodes(render(false, false, 155)).some(
        (node) => node.type === "Text" && node.props.children === 155,
      ),
    );
  }

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
  const trigger = collapsed.props.children[1];
  assert.equal(trigger.type, SettledHistoryToggle);
  assert.equal(trigger.props.kind, "accounts");
  assert.equal(trigger.props.horizontalInset, 16);
  trigger.props.onToggle();
  assert.equal(toggles, 1);

  const expanded = render(true);
  const children = expanded.props.children;
  assert.equal(children[0], accountsCard, "revealed accounts take the toggle's former position");
  const close = children[1];
  assert.equal(close.type, SettledHistoryToggle, "the close control follows all settled accounts");
  assert.equal(close.props.expanded, true);
  close.props.onToggle();
  assert.equal(toggles, 2);

  const blocked = render(true, true).props.children[1];
  assert.equal(blocked.props.disabled, true);
  assert.equal(render(false, false, 0), null, "no settled accounts leaves no separator or gap");
  assert.equal(render(false, false, 155).props.children[1].props.count, 155);
}
console.log(
  "PASS settled history controls: account/tally EN/FA/PS labels, RTL/wrapping/accessibility, disabled guards, one gutter and collapsed account child unmount",
);
