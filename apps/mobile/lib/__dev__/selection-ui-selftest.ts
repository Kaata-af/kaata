// Execute the real controls and translations with native primitives mocked.
// These checks cover interaction/accessibility contracts; Yoga, font rendering
// and screen-reader announcements still need an iOS/Android device check.
import assert from "node:assert/strict";
import { colors } from "../colors";
import { faDigits } from "../jalali";
import { formatMoneyAmount } from "../money";
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
  "../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
  "../lib/direction": direction,
  "../lib/format": { formatAmount: formatMoneyAmount },
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

  const balanceTotals = { collect: 0.3, pay: 1.05, pending: false };
  const totals = SelectionToolbar({ ...props, count: 2, balanceTotals });
  for (const [side, amount, color] of [
    ["collect", "0.30", colors.collectStrong],
    ["pay", "1.05", colors.payStrong],
  ] as const) {
    const metric = nodes(totals).find(
      (node) =>
        node.props.accessibilityLabel === `${i18n.t(`home.total.label.${side}`)}, ${amount} AFN`,
    );
    assert.ok(
      metric?.props.accessible,
      "Each selected balance has a readable direction and currency",
    );
    assert.equal(metric.props.accessibilityLiveRegion, "polite");
    const value = nodes(metric).find(
      (node) => node.type === "Text" && textContent(node) === amount,
    )!;
    assert.equal(styleOf(value).color, color);
    assert.equal(styleOf(value).writingDirection, "ltr", "Amounts retain their Latin digit order");
    assert.equal(value.props.numberOfLines, undefined, "Large balance text may wrap");
    assert.equal(styleOf(metric).height, undefined);
  }
  assert.equal(
    nodes(totals).filter((node) => textContent(node) === "AFN" && node.type === "Text").length,
    2,
    "Both selected totals identify the kaata currency",
  );
  const pendingTotals = SelectionToolbar({
    ...props,
    balanceTotals: { ...balanceTotals, pending: true },
  });
  assert.ok(textContent(pendingTotals).includes(i18n.t("selection.balancesPending")));
  assert.equal(
    textContent(pendingTotals).includes("0.30"),
    false,
    "Unknown shared balances never show a partial total",
  );
  assert.equal(textContent(pendingTotals).includes("1.05"), false);
  const emptyTotals = SelectionToolbar({ ...props, count: 0, balanceTotals });
  assert.ok(textContent(emptyTotals).includes(i18n.t("selection.empty")));
  assert.equal(
    textContent(emptyTotals).includes("AFN"),
    false,
    "Empty selection keeps the selection hint",
  );

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

  // A mixed search list carries direction on each known live balance. The
  // homepage's existing single-direction tabs keep their neutral row style.
  for (const [balance, key, color] of [
    [20, "home.tab.collect", colors.collectText],
    [-20, "home.tab.pay", colors.payText],
  ] as const) {
    const row = PersonRow({
      person: { ...person, balance },
      showDirection: true,
      creditStatus: "near",
      onPress: () => undefined,
    });
    const rowNodes = nodes(row);
    const label = rowNodes.find(
      (node) => node.type === "Text" && textContent(node) === i18n.t(key),
    )!;
    assert.ok(label, "Mixed search balances identify which direction the money goes");
    assert.equal(styleOf(label).color, color);
    assert.equal(styleOf(label).writingDirection, rtl ? "rtl" : "ltr");
    assert.equal(styleOf(label).textAlign, rtl ? "right" : "left");
    assert.notEqual(label.props.allowFontScaling, false);
    assert.equal(label.props.numberOfLines, undefined, "Direction labels may grow with large text");
    assert.equal(styleOf(row).height, undefined, "The row can grow for its direction label");
    const amount = rowNodes.find((node) => node.type === "Text" && textContent(node) === "20")!;
    assert.equal(styleOf(amount).color, color);
    assert.ok(
      rowNodes.indexOf(label) < rowNodes.findIndex((node) => node.type === "CreditStatusBadge"),
      "Direction stays below the amount and before the credit-limit status",
    );

    const home = PersonRow({ person: { ...person, balance }, onPress: () => undefined });
    assert.equal(
      nodes(home).some((node) => node.type === "Text" && textContent(node) === i18n.t(key)),
      false,
      "Ordinary homepage rows do not repeat their containing tab's direction",
    );
    const homeAmount = nodes(home).find(
      (node) => node.type === "Text" && textContent(node) === "20",
    )!;
    assert.equal(styleOf(homeAmount).color, colors.textEmphasis);
  }
  for (const state of [
    { balance: 0, is_settled: 0 },
    { balance: 20, is_settled: 1 },
    { balance: 20, is_settled: 0, tab_unsynced: 1 },
  ]) {
    const row = PersonRow({
      person: { ...person, ...state },
      showDirection: true,
      onPress: () => undefined,
    });
    for (const node of nodes(row).filter((candidate) => candidate.type === "Text")) {
      assert.notEqual(textContent(node), i18n.t("home.tab.collect"));
      assert.notEqual(textContent(node), i18n.t("home.tab.pay"));
      assert.notEqual(styleOf(node).color, colors.collectText);
      assert.notEqual(styleOf(node).color, colors.payText);
    }
    if (state.tab_unsynced) {
      assert.ok(textContent(row).includes("…"), "Unknown balances keep their download placeholder");
      assert.equal(textContent(row).includes("20"), false);
    } else if (state.is_settled) {
      assert.ok(
        nodes(row).some((node) => node.type === "Icon" && node.props.name === "checkmark"),
        "Settled balances keep their neutral checkmark",
      );
    } else {
      const amount = nodes(row).find((node) => node.type === "Text" && textContent(node) === "0")!;
      assert.equal(styleOf(amount).color, colors.textMuted);
    }
  }

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
