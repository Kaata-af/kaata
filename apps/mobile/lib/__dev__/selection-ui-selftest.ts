// Execute the real controls and translations with native primitives mocked.
// These checks cover interaction/accessibility contracts; Yoga, font rendering
// and screen-reader announcements still need an iOS/Android device check.
import assert from "node:assert/strict";
import { colors } from "../colors";
import { faDigits } from "../jalali";
import { compileUI, flattenStyle, jsx, nodes, type UINode } from "./ui-fixture";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
});
const direction = compileUI("../direction", {
  react: {
    useEffect: () => undefined,
    useState: (initial: () => boolean) => [initial(), () => undefined],
  },
  "./i18n": i18n,
  "./bidi": { ltrIsolate: (value: string) => value },
});
const fonts = {
  sansRegular: "Regular",
  sansMedium: "Medium",
  sansSemi: "Semi",
  sansBold: "Bold",
  monoRegular: "Mono",
  monoSemi: "MonoSemi",
  monoBold: "MonoBold",
};
const tokens = compileUI("../tokens", {
  "./fonts": {
    fonts,
    sansLineHeight: (_size: number, height: number) => height,
    monoLineHeight: (_size: number, height: number) => height,
  },
});
const native = {
  ActivityIndicator: "ActivityIndicator",
  Pressable: "Pressable",
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: "Text",
  View: "View",
};
const shared = {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": native,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "../lib/colors": { colors },
  "../lib/direction": direction,
  "../lib/i18n": i18n,
  "../lib/jalali": { faDigits },
  "../lib/tokens": tokens,
};
const { SelectionToolbar } = compileUI("../../components/SelectionToolbar", shared);
const { SelectionMark } = compileUI("../../components/SelectionMark", shared);
const { PersonRow } = compileUI("../../components/PersonRow", {
  ...shared,
  react: { memo: (component: unknown) => component },
  "./SharedAccountBadge": { SharedAccountBadge: "SharedAccountBadge" },
  "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
  "./SelectionMark": { SelectionMark },
  "../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
  "../lib/fonts": { fonts },
  "../lib/format": { formatAmount: String, formatRelative: () => "yesterday" },
});

const textContent = (tree: any): string =>
  typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : Array.isArray(tree)
      ? tree.map(textContent).join("")
      : tree?.props
        ? textContent(tree.props.children)
        : "";
const styleOf = (node: UINode) =>
  flattenStyle(
    typeof node.props.style === "function"
      ? node.props.style({ pressed: false })
      : node.props.style,
  );
const button = (tree: UINode, label: string) => {
  const found = nodes(tree).find(
    (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
  );
  assert.ok(found, `Missing action: ${label}`);
  return found;
};
const press = (node: UINode) => {
  // Match the native Pressable disabled boundary, not a direct callback call.
  if (!node.props.disabled) node.props.onPress?.();
};
const assertTarget = (node: UINode) => {
  const style = styleOf(node);
  assert.ok((style.minHeight ?? style.height ?? 0) >= 44, "44pt minimum height");
  assert.ok((style.minWidth ?? style.width ?? 0) >= 44, "44pt minimum width");
};

for (const locale of ["en", "fa"] as const) {
  i18n.setLocale(locale);
  const rtl = locale === "fa";
  let closed = 0,
    toggled = 0,
    removed = 0;
  const props = {
    count: 1,
    total: 3,
    onClose: () => closed++,
    onToggleAll: () => toggled++,
    actions: [
      {
        key: "remove",
        label: i18n.t("selection.remove"),
        icon: "trash-outline",
        destructive: true,
        onPress: () => removed++,
      },
      {
        key: "unavailable",
        label: locale === "fa" ? "گزینهٔ غیرفعال" : "Unavailable action",
        icon: "document-outline",
        disabled: true,
        onPress: () => assert.fail("An unavailable action ran"),
      },
    ],
  };
  const initial = SelectionToolbar(props);
  assert.ok(
    textContent(initial).includes(i18n.t("selection.count", { count: rtl ? faDigits("1") : 1 })),
    "The selected count uses the current language and digit script",
  );
  const count = nodes(initial).find((node) => node.props.accessibilityLiveRegion === "polite")!;
  assert.equal(styleOf(count).writingDirection, rtl ? "rtl" : "ltr");
  assert.equal(styleOf(count).textAlign, rtl ? "right" : "left");

  // Dynamic type can grow the panel: rows wrap, labels have no line clamp,
  // and neither panel nor controls impose a fixed height or hidden overflow.
  assert.equal(styleOf(initial).height, undefined);
  assert.equal(styleOf(initial).position, undefined, "The screen owns placement");
  const rows = nodes(initial).filter((node) => styleOf(node)?.flexWrap === "wrap");
  assert.equal(rows.length, 2, "Both the header and action row may wrap");
  for (const row of rows) assert.equal(styleOf(row).flexDirection, rtl ? "row-reverse" : "row");
  for (const node of nodes(initial)) {
    if (node.type === "Text") {
      assert.equal(node.props.numberOfLines, undefined, "Selection labels can wrap at large text");
      assert.notEqual(node.props.allowFontScaling, false, "Selection labels respect dynamic type");
    }
    if (node.type === "Pressable") {
      assertTarget(node);
      assert.equal(styleOf(node).height, undefined);
      assert.notEqual(styleOf(node).overflow, "hidden");
    }
  }
  press(button(initial, i18n.t("selection.close")));
  press(button(initial, i18n.t("selection.all")));
  press(button(initial, i18n.t("selection.remove")));
  press(button(initial, props.actions[1].label));
  assert.deepEqual([closed, toggled, removed], [1, 1, 1]);

  const all = SelectionToolbar({ ...props, count: 3 });
  assert.ok(button(all, i18n.t("selection.clear")));
  const empty = SelectionToolbar({ ...props, count: 0, total: 0 });
  assert.ok(textContent(empty).includes(i18n.t("selection.empty")));
  assert.equal(button(empty, i18n.t("selection.all")).props.disabled, true);
  assert.equal(button(empty, i18n.t("selection.remove")).props.disabled, true);
  assert.equal(button(empty, i18n.t("selection.remove")).props.accessibilityState.disabled, true);
  const noneSelected = SelectionToolbar({ ...props, count: 0 });
  assert.equal(button(noneSelected, i18n.t("selection.all")).props.disabled, false);
  assert.equal(button(noneSelected, i18n.t("selection.remove")).props.disabled, true);

  const busy = SelectionToolbar({ ...props, busy: true, summary: "Selection summary" });
  assert.ok(textContent(busy).includes("Selection summary"));
  assert.equal(nodes(busy).filter((node) => node.type === "ActivityIndicator").length, 1);
  for (const node of nodes(busy).filter((candidate) => candidate.type === "Pressable")) {
    assert.equal(node.props.disabled, true, "Busy blocks every control");
    assert.equal(node.props.accessibilityState.disabled, true);
    press(node);
  }
  assert.deepEqual([closed, toggled, removed], [1, 1, 1], "Busy cannot issue duplicate work");

  let opened = 0;
  const person = {
    id: "contact",
    name: rtl ? "احمد" : "Ahmad",
    balance: 20,
    is_settled: 0,
    last_entry_at: 1,
  };
  for (const selected of [false, true]) {
    const row = PersonRow({
      person,
      selecting: true,
      selected,
      disabled: true,
      onPress: () => opened++,
    });
    assert.equal(row.props.accessibilityRole, "checkbox");
    assert.deepEqual(row.props.accessibilityState, { checked: selected, disabled: true });
    assert.equal(row.props.disabled, true);
    press(row);
    assert.equal(opened, 0, "A busy contact checkbox cannot open a contact or change selection");
    const mark = SelectionMark({ selected });
    assert.equal(mark.props.accessible, false);
    assert.equal(mark.props.accessibilityElementsHidden, true);
    assert.equal(mark.props.importantForAccessibility, "no-hide-descendants");
    assert.equal(mark.props.pointerEvents, "none");
    assert.equal(nodes(mark).filter((node) => node.type === "Icon").length, selected ? 1 : 0);
  }
  assert.equal(PersonRow({ person, onPress: () => opened++ }).props.accessibilityRole, "button");

  for (const key of [
    "selection.removeContactsTitle",
    "selection.contactsRemoved",
    "selection.deleteTalliesTitle",
    "selection.talliesDeleted",
    "selection.partialFailure",
  ]) {
    assert.ok(i18n.t(key, { count: 7 }).includes("7"), `${key} interpolates the actual count`);
    assert.ok(!i18n.t(key, { count: 7 }).includes("{count}"));
  }
}
console.log(
  "PASS selection controls: English/Dari counts and direction, wrapping, 44pt targets, busy/empty/disabled actions, select-all and checkbox semantics",
);
