// Execute the real controls and translations with native primitives mocked.
// These checks cover interaction/accessibility contracts; Yoga, font rendering
// and screen-reader announcements still need an iOS/Android device check.
import assert from "node:assert/strict";
import { colors } from "../colors";
import { formatMoneyAmount } from "../money";
import { compileUI, flattenStyle, jsx, nodes, type UINode } from "./ui-fixture";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
});
const direction = compileUI("../direction", {
  react: {
    useEffect: () => undefined,
    useState: (initial: unknown) => [
      typeof initial === "function" ? initial() : initial,
      () => undefined,
    ],
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
  ScrollView: "ScrollView",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
};
const shared = {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": native,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "../lib/colors": { colors },
  "../lib/currency": {
    getCurrentCurrencySymbol: () => "AFN",
    getCurrentCurrencyCode: () => "AFN",
    getCurrencyLabel: (code: string) => code,
  },
  "../lib/direction": direction,
  "../lib/format": { formatAmount: formatMoneyAmount },
  "../lib/i18n": i18n,
  "../lib/fonts": { fonts, monoLineHeight: (_size: number, height: number) => height },
  "../lib/tokens": tokens,
};
const { SelectionToolbar } = compileUI("../../components/SelectionToolbar", shared);
const { SelectionMark } = compileUI("../../components/SelectionMark", shared);
const { PersonRow } = compileUI("../../components/PersonRow", {
  ...shared,
  react: { memo: (component: unknown) => component, useRef: (current: unknown) => ({ current }) },
  "./SharedAccountBadge": { SharedAccountBadge: "SharedAccountBadge" },
  "./CreditStatusBadge": { CreditStatusBadge: "CreditStatusBadge" },
  "./SelectionMark": { SelectionMark },
  "../lib/currency": shared["../lib/currency"],
  "../lib/multi-currency-view": {
    personCurrencyRows: (person: any) => person.currency_balances ?? [person],
  },
  "../lib/tabs/link-status": require("../tabs/link-status"),
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
const visibleText = (tree: any): string =>
  typeof tree === "string" || typeof tree === "number"
    ? String(tree)
    : Array.isArray(tree)
      ? tree.map(visibleText).join("")
      : tree?.props && styleOf(tree)?.opacity !== 0
        ? visibleText(tree.props.children)
        : "";
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

for (const locale of ["en", "fa", "ps"] as const) {
  i18n.setLocale(locale);
  const rtl = locale !== "en";
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
        label:
          locale === "ps"
            ? "ناچالان انتخاب"
            : locale === "fa"
              ? "گزینهٔ غیرفعال"
              : "Unavailable action",
        icon: "document-outline",
        disabled: true,
        onPress: () => assert.fail("An unavailable action ran"),
      },
    ],
  };
  const initial = SelectionToolbar(props);
  assert.ok(
    textContent(initial).includes(i18n.t("selection.count", { count: 1 })),
    "The selected count keeps English digits in either language",
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

  const financialSummary = {
    debtCount: 3,
    creditCount: 1,
    debt: 30.2,
    credit: 20.1,
    collect: 15.2,
    pay: 5.1,
    net: 10.1,
    pending: false,
  };
  const financial = SelectionToolbar({
    ...props,
    count: 2,
    total: 1,
    allSelected: true,
    financialSummary,
  });
  assert.ok(
    button(financial, i18n.t("selection.clearResults")),
    "Visible Select all is independent of hidden selections",
  );
  assert.equal(
    textContent(financial).includes(i18n.t("selection.summary.transactions", { count: 4 })),
    false,
    "There is no combined transaction count",
  );
  assert.equal(textContent(financial).includes("50.30"), false, "There is no combined amount");
  assert.ok(visibleText(financial).includes(i18n.t("selection.summary.collect")));
  assert.equal(visibleText(financial).includes(i18n.t("selection.summary.pay")), false);
  assert.ok(textContent(financial).includes("10.10"));
  const payable = SelectionToolbar({
    ...props,
    financialSummary: { ...financialSummary, net: -10.1 },
  });
  assert.ok(visibleText(payable).includes(i18n.t("selection.summary.pay")));
  const balanced = SelectionToolbar({
    ...props,
    financialSummary: { ...financialSummary, net: 0 },
  });
  assert.ok(visibleText(balanced).includes(i18n.t("selection.summary.remaining")));
  const unavailable = SelectionToolbar({
    ...props,
    financialSummary: { ...financialSummary, pending: true },
  });
  const multi = SelectionToolbar({
    ...props,
    financialSummaries: [
      { currency: "AFN", summary: financialSummary },
      {
        currency: "USD",
        summary: { ...financialSummary, debt: 0, collect: 0, credit: 20.2, pay: 20.2, net: -20.2 },
      },
    ],
  });
  assert.ok(textContent(multi).includes("AFN") && textContent(multi).includes("USD"));
  assert.ok(nodes(multi).some((node) => node.props.accessibilityLabel?.includes("20.20 USD")));
  const metricScroll = nodes(multi).find((node) => node.type === "ScrollView")!;
  assert.equal(styleOf(metricScroll).maxHeight, 160);
  assert.equal(metricScroll.props.nestedScrollEnabled, true);
  assert.equal(
    nodes(metricScroll).some((node) => node.props.accessibilityLabel === i18n.t("selection.close")),
    false,
    "Summary scroll leaves controls fixed",
  );
  assert.ok(visibleText(unavailable).includes(i18n.t("selection.summary.unavailable")));
  assert.ok(visibleText(unavailable).includes(i18n.t("selection.summary.remaining")));
  assert.equal(
    nodes(unavailable).filter((node) =>
      node.props.accessibilityLabel?.includes(i18n.t("selection.summary.unavailable")),
    ).length,
    3,
    "Missing restored account data is identified on every financial field",
  );
  assert.equal(
    nodes(unavailable).filter((node) => node.type === "Text" && textContent(node) === "—").length,
    5,
    "Unavailable amounts and separate transaction counts never show a partial sum",
  );
  for (const amount of ["50.30", "30.20", "20.10", "10.10"])
    assert.equal(textContent(unavailable).includes(amount), false);

  for (const tree of [financial, payable, balanced, unavailable]) {
    assert.equal(
      nodes(tree).some((node) => node.type === "ActivityIndicator"),
      false,
    );
    assert.equal(
      nodes(tree).some((node) => node.props.accessibilityState?.busy),
      false,
    );
    assert.equal(
      nodes(tree).some((node) => node.props.testID?.includes("skeleton")),
      false,
    );
    assert.equal(textContent(tree).includes("0,000.00"), false, "No hidden layout placeholder");
    for (const node of nodes(tree)) {
      assert.equal(styleOf(node)?.height, undefined, "Financial values can grow with text size");
      assert.notEqual(styleOf(node)?.overflow, "hidden");
      assert.notEqual(styleOf(node)?.opacity, 0, "No invisible sizing labels");
      if (node.type === "Text") {
        assert.equal(node.props.numberOfLines, undefined);
        assert.notEqual(node.props.allowFontScaling, false);
      }
    }
    const remaining = nodes(tree).find(
      (node) =>
        node.props.accessible &&
        ["selection.summary.collect", "selection.summary.pay", "selection.summary.remaining"].some(
          (key) => node.props.accessibilityLabel?.startsWith(`${i18n.t(key)},`),
        ),
    )!;
    assert.ok(remaining, "The selected balance stays in its own summary row");
    assert.equal(styleOf(remaining).justifyContent, "space-between");
    assert.equal(styleOf(remaining).flexDirection, rtl ? "row-reverse" : "row");
    const [remainingLabel, remainingAmount] = remaining.props.children;
    assert.equal(styleOf(remainingLabel).textAlign, rtl ? "right" : "left");
    assert.equal(styleOf(remainingAmount).justifyContent, "flex-end");
    assert.equal(styleOf(remainingAmount).flexGrow, undefined);
    assert.equal(styleOf(remainingAmount).flexBasis, undefined);
    const balanceValue = remainingAmount.props.children[0];
    assert.equal(styleOf(balanceValue).fontFamily, fonts.monoBold);
    assert.equal(styleOf(balanceValue).fontSize, 17);
    assert.equal(styleOf(balanceValue).lineHeight, 24);
  }
  for (const [key, amount, count, color] of [
    ["debt", "30.20", 3, colors.collectStrong],
    ["credit", "20.10", 1, colors.payStrong],
  ] as const) {
    const countLabel = i18n.t(
      count === 1 ? "selection.summary.transaction" : "selection.summary.transactions",
      { count },
    );
    const metric = nodes(financial).find(
      (node) =>
        node.props.accessibilityLabel ===
        `${i18n.t(`selection.summary.${key}`)}, ${amount} AFN, ${countLabel}`,
    )!;
    assert.ok(metric, "Each grey card identifies its own amount and transaction count");
    assert.ok(metric.props.accessible);
    assert.equal(metric.props.accessibilityLiveRegion, "polite");
    assert.equal(styleOf(metric).backgroundColor, colors.bgMuted);
    assert.ok(
      styleOf(metric).flexDirection === undefined || styleOf(metric).flexDirection === "column",
      "Each grey card stacks its label row above its value row",
    );
    const metricRows = metric.props.children;
    assert.equal(metricRows.length, 2, "Each grey card has exactly two rows");
    for (const row of metricRows) {
      assert.equal(row.type, "View");
      assert.equal(styleOf(row).flexDirection, rtl ? "row-reverse" : "row");
      assert.equal(styleOf(row).justifyContent, "space-between");
      assert.equal(row.props.children.length, 2, "Each row places content at opposite ends");
    }
    const [label, transactionsLabel] = metricRows[0].props.children;
    assert.equal(label.type, "Text");
    assert.equal(textContent(label), i18n.t(`selection.summary.${key}`));
    assert.equal(styleOf(label).textAlign, rtl ? "right" : "left");
    assert.equal(transactionsLabel.type, "Text");
    assert.equal(textContent(transactionsLabel), i18n.t("selection.summary.transactionsLabel"));
    assert.equal(styleOf(transactionsLabel).textAlign, rtl ? "left" : "right");
    const [amountRow, transactionCount] = metricRows[1].props.children;
    assert.equal(amountRow.type, "View");
    assert.equal(styleOf(amountRow).alignItems, "baseline");
    assert.equal(styleOf(amountRow).flexDirection, rtl ? "row-reverse" : "row");
    assert.equal(transactionCount.type, "Text");
    assert.equal(textContent(transactionCount), String(count));
    assert.equal(styleOf(transactionCount).textAlign, rtl ? "left" : "right");
    assert.equal(styleOf(transactionCount).writingDirection, rtl ? "rtl" : "ltr");
    assert.equal(styleOf(transactionCount).fontFamily, tokens.typography.numRow.fontFamily);
    const value = nodes(amountRow).find(
      (node) => node.type === "Text" && textContent(node) === amount,
    )!;
    assert.equal(styleOf(value).color, color);
    assert.equal(styleOf(value).writingDirection, "ltr");
    assert.ok(nodes(amountRow).some((node) => node.type === "Text" && textContent(node) === "AFN"));
  }
  assert.equal(
    nodes(financial).filter((node) => textContent(node) === "AFN" && node.type === "Text").length,
    3,
    "Every financial amount identifies its currency",
  );
  const zeroCredit = SelectionToolbar({
    ...props,
    financialSummary: { ...financialSummary, credit: 0, creditCount: 0 },
  });
  const zeroCreditMetric = nodes(zeroCredit).find((node) =>
    node.props.accessibilityLabel?.startsWith(`${i18n.t("selection.summary.credit")},`),
  )!;
  assert.equal(
    textContent(zeroCreditMetric.props.children[1].props.children[1]),
    "0",
    "A side with no transactions shows a standalone zero count",
  );
  const emptyTotals = SelectionToolbar({ ...props, count: 0, financialSummary });
  assert.ok(textContent(emptyTotals).includes(i18n.t("selection.empty")));
  assert.equal(textContent(emptyTotals).includes("AFN"), false);

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

  // Mixed home and search rows use a sign beside each known live balance.
  // Callers that omit showDirection retain the component's unsigned option.
  for (const [balance, key, color] of [
    [20, "home.tab.collect", colors.collectStrong],
    [-20, "home.tab.pay", colors.payStrong],
  ] as const) {
    const row = PersonRow({
      person: { ...person, balance },
      showDirection: true,
      creditStatus: "near",
      onPress: () => undefined,
    });
    const rowNodes = nodes(row);
    assert.equal(
      rowNodes.some((node) => node.type === "Text" && textContent(node) === i18n.t(key)),
      false,
      "Mixed rows do not repeat direction as a subtitle",
    );
    const signedAmount = balance > 0 ? "+20" : "−20";
    const amount = rowNodes.find(
      (node) => node.type === "Text" && textContent(node) === signedAmount,
    )!;
    assert.ok(amount, "The sign and amount share one text node");
    assert.equal(styleOf(amount).color, color);
    assert.equal(styleOf(amount).writingDirection, "ltr", "The sign stays before the number");
    assert.equal(amount.props.accessibilityLabel, `${i18n.t(key)}, 20 AFN`);
    assert.ok(
      rowNodes.indexOf(amount) < rowNodes.findIndex((node) => node.type === "CreditStatusBadge"),
      "Credit-limit status stays below the signed amount",
    );

    const unsigned = PersonRow({ person: { ...person, balance }, onPress: () => undefined });
    assert.equal(
      nodes(unsigned).some((node) => node.type === "Text" && textContent(node) === i18n.t(key)),
      false,
      "Unsigned rows do not add a direction label",
    );
    const unsignedAmount = nodes(unsigned).find(
      (node) => node.type === "Text" && textContent(node) === "20",
    )!;
    assert.equal(styleOf(unsignedAmount).color, color);
    assert.equal(unsignedAmount.props.accessibilityLabel, `${i18n.t(key)}, 20 AFN`);
    assert.equal(
      nodes(unsigned).some((node) => node.type === "Text" && textContent(node) === signedAmount),
      false,
    );
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
      assert.equal(
        /[+−]\d/.test(textContent(node)),
        false,
        "Neutral and unknown amounts have no sign",
      );
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
  "PASS selection controls: English/Dari/Pashto counts and direction, wrapping, 44pt targets, busy/empty/disabled actions, select-all and checkbox semantics",
);
