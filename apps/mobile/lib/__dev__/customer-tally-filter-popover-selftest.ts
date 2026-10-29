import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import * as filters from "../tally-list-filter";
import { colors } from "../colors";

function fixture(isRTL = false, availableCodes = ["AFN", "USD", "AUD"]) {
  const hooks = uiHooks();
  const changes: filters.TallyListFilter[] = [];
  let clears = 0;
  let props = {
    visible: true,
    contextKey: "account:kaata:person",
    anchor: { x: 300, y: 700, width: 44, height: 44 },
    viewport: { width: 390, height: 844, topInset: 44 },
    blurTarget: { current: null },
    disabled: false,
    hasDateFilter: false,
    keyboardVisible: false,
    onDismissKeyboard() {},
    onDismiss() {},
    renderToggle: ({ onPress, disabled }: { onPress: () => void; disabled: boolean }) =>
      jsx("Pressable", { testID: "customer-sharp-toggle", onPress, disabled }),
    filter: { ...filters.DEFAULT_TALLY_LIST_FILTER, currencies: [] as string[] },
    availableCodes,
    isRTL,
    onChange: (next: filters.TallyListFilter) => changes.push(next),
    onClear: () => clears++,
  };
  const { CustomerTallyFilterPopover } = compileUI("../../components/CustomerTallyFilterPopover", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (value: unknown) => value, hairlineWidth: 0.5 },
    },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "../lib/colors": { colors },
    "../lib/fonts": { fonts: { sansSemi: "sans-semibold", monoMedium: "mono-medium" } },
    "../lib/tokens": {
      radius: { sm: 8 },
      TOUCH_MIN: 44,
      typography: { bodySm: { fontSize: 13 }, hint: { fontSize: 12 } },
    },
    "../lib/direction": {
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({
        textAlign: rtl ? "right" : "left",
        writingDirection: rtl ? "rtl" : "ltr",
      }),
    },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/tally-list-filter": filters,
    "./HomeFilterPopover": { HomeFilterPopover: "HomeFilterPopover" },
  });
  const render = () => hooks.render(() => CustomerTallyFilterPopover(props));
  const button = (id: string) =>
    nodes(hooks.tree).find((node) => node.props.testID === `tally-filter-${id}`)!;
  render();
  return {
    hooks,
    changes,
    button,
    get clears() {
      return clears;
    },
    get props() {
      return props;
    },
    update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      render();
    },
    flush() {
      if (changes.length) props = { ...props, filter: changes.at(-1)! };
      render();
    },
  };
}

for (const rtl of [false, true]) {
  const f = fixture(rtl);
  assert.equal(f.hooks.tree.type, "HomeFilterPopover");
  assert.equal(f.hooks.tree.props.anchor, f.props.anchor);
  assert.equal(f.hooks.tree.props.viewport, f.props.viewport);
  assert.equal(
    f.hooks.tree.props.renderToggle,
    f.props.renderToggle,
    "The customer filter content forwards its sharp close-toggle renderer to the shared overlay",
  );
  assert.equal(
    f.hooks.tree.props.blurTarget,
    f.props.blurTarget,
    "Uses the same full-navigation blur target as Home",
  );
  assert.equal(f.button("direction-received").props.accessibilityRole, "radio");
  assert.equal(f.button("clear"), undefined, "Default view has no filters to clear");
  assert.equal(f.button("currency-USD").props.accessibilityRole, "checkbox");
  assert.equal(f.button("sort-amount_asc").props.disabled, true);
  assert.equal(
    flattenStyle(f.button("sort-amount_asc").props.style({ pressed: false })).opacity,
    0.4,
  );
  f.button("sort-amount_asc").props.onPress();
  assert.equal(f.changes.length, 0, "Disabled mixed-currency amount sorting cannot dispatch");

  f.button("currency-USD").props.onPress();
  f.button("currency-AUD").props.onPress();
  assert.deepEqual(
    f.changes.at(-1)!.currencies,
    ["AUD", "USD"],
    "Consecutive native taps retain both currency selections before a parent render",
  );
  f.flush();
  assert.equal(f.button("currency-USD").props.accessibilityState.checked, true);
  assert.equal(f.button("currency-AUD").props.accessibilityState.checked, true);
  assert.equal(f.button("currency-all").props.accessibilityState.checked, false);
  assert.equal(f.button("sort-amount_asc").props.disabled, true);
  const codeLabel = nodes(f.button("currency-USD")).find((node) => node.type === "Text")!;
  assert.equal(
    codeLabel.props.children,
    "USD",
    "Currency choices use one code without a redundant symbol",
  );
  assert.equal(flattenStyle(codeLabel.props.style).writingDirection, "ltr");

  f.button("currency-AUD").props.onPress();
  f.flush();
  assert.equal(f.button("sort-amount_asc").props.disabled, false);
  f.button("sort-amount_asc").props.onPress();
  f.flush();
  assert.equal(f.changes.at(-1)!.sort, "amount_asc");
  f.button("currency-all").props.onPress();
  f.flush();
  assert.deepEqual(
    f.changes.at(-1),
    { direction: "all", currencies: [], sort: "recent" },
    "Widening to all currencies retires incomparable amount sorting",
  );
  f.button("direction-gave").props.onPress();
  f.flush();
  assert.equal(f.button("direction-gave").props.accessibilityState.checked, true);
  f.button("clear").props.onPress();
  assert.equal(f.clears, 1);
}

{
  const f = fixture(false, ["AFN"]);
  assert.equal(
    f.button("currency-AFN"),
    undefined,
    "Single-currency ledgers do not show a redundant picker",
  );
  assert.equal(f.button("sort-amount_desc").props.disabled, false);
  f.button("sort-date_asc").props.onPress();
  assert.equal(f.changes.at(-1)!.sort, "date_asc");
  f.button("direction-received").props.onPress();
  assert.equal(f.changes.at(-1)!.direction, "received");
  assert.equal(f.changes.at(-1)!.sort, "date_asc", "Changing a side preserves a compatible sort");
}

{
  const f = fixture();
  const staleCurrency = f.button("currency-USD").props.onPress;
  f.button("direction-gave").props.onPress();
  f.flush();
  const staleClear = f.button("clear").props.onPress;
  f.update({ visible: false });
  f.update({ contextKey: "other-contact", visible: true });
  f.update({ contextKey: "account:kaata:person" });
  staleCurrency();
  staleClear();
  assert.equal(f.changes.length, 1);
  assert.equal(f.clears, 0, "Old controls cannot revive after close/reopen or contact ABA");
  f.update({ disabled: true });
  for (const node of nodes(f.hooks.tree).filter((candidate) => candidate.type === "Pressable")) {
    assert.equal(node.props.disabled, true);
    assert.equal(
      flattenStyle(
        typeof node.props.style === "function"
          ? node.props.style({ pressed: false })
          : node.props.style,
      ).opacity,
      0.4,
    );
    node.props.onPress();
  }
  assert.equal(f.changes.length, 1);
  assert.equal(f.clears, 0);
  f.update({ disabled: false });
  const afterUnmount = f.button("direction-gave").props.onPress;
  f.hooks.unmount();
  afterUnmount();
  assert.equal(f.changes.length, 1);
  assert.equal(f.hooks.lateWrites, 0);
}

for (const rtl of [false, true]) {
  const f = fixture(rtl, ["AFN"]);
  for (const sort of ["date_asc", "amount_asc", "amount_desc"] as const) {
    const sorted = { ...filters.DEFAULT_TALLY_LIST_FILTER, currencies: [], sort };
    f.update({ filter: sorted });
    assert.equal(f.button("clear"), undefined, "Sorting alone never displays Clear all filters");
    assert.equal(f.button(`sort-${sort}`).props.accessibilityState.selected, true);
    f.button("direction-gave").props.onPress();
    f.flush();
    const heldClear = f.button("clear").props.onPress;
    f.update({ filter: sorted });
    heldClear();
    assert.equal(f.clears, 0, "A retained Clear button cannot clear a sort-only view");
    assert.equal(f.props.filter.sort, sort);
  }
  f.update({ hasDateFilter: true });
  assert.ok(f.button("clear"), "A date-only filter still displays Clear all filters");
  const dateClear = f.button("clear").props.onPress;
  f.update({ hasDateFilter: false });
  dateClear();
  assert.equal(f.clears, 0, "A removed date filter retires the old Clear callback");
  f.update({ hasDateFilter: true });
  f.button("clear").props.onPress();
  assert.equal(f.clears, 1);
}

console.log(
  "PASS customer tally filter overlay: full-screen host forwarding, rapid multi-currency checkboxes, comparable amount sorting, single-currency controls, RTL, disabled states and stale callback guards",
);
