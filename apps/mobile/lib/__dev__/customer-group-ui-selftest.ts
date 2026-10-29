// Executes the actual sheet and scoped data hook. Native animation/timer frames
// are controlled so stopped callbacks can still be delivered adversarially.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { searchContacts } from "../search";
import { colors } from "../colors";
import {
  compareCustomerNames,
  DEFAULT_CUSTOMER_LIST,
  CUSTOMER_BALANCE_FILTERS,
  CUSTOMER_SORTS,
  selectedCustomerGroupIds,
  selectedCustomerCurrencyCodes,
  toggleCustomerCurrencyFilter,
  toggleCustomerGroupFilter,
  type CustomerListPreference,
} from "../customer-list";

export async function customerGroupUIChecks() {
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
    "./db": { getAppMeta: async () => null },
  }) as typeof import("../i18n");
  let translate: typeof language.t = (key) => key;
  const hooks = uiHooks(),
    timers = new Map<number, () => void>(),
    frames = new Map<number, () => void>();
  let sequence = 0,
    managed = 0,
    dismissed = 0,
    reducedMotion = false;
  const animations: { callback?: (event: { finished: boolean }) => void; stopped: boolean }[] = [];
  class Value {
    constructor(public value: number) {}
    setValue(value: number) {
      this.value = value;
    }
    stopAnimation() {}
    // The backdrop's opacity follows the slide.
    interpolate(config: { inputRange: number[]; outputRange: number[] }) {
      return { interpolation: config, source: this };
    }
  }
  const animate = () => {
    const record = {
      stopped: false,
      callback: undefined as ((event: { finished: boolean }) => void) | undefined,
    };
    animations.push(record);
    return {
      start: (callback?: typeof record.callback) => {
        record.callback = callback;
      },
      stop: () => {
        record.stopped = true;
      },
    };
  };
  const props = {
    visible: true,
    preference: DEFAULT_CUSTOMER_LIST,
    groups: [{ id: "g", name: "Family", member_count: 1 }],
    contextKey: "a:v1",
    canManage: true,
    isRTL: false,
    onChange: () => {},
    onManage: () => managed++,
    onDismiss: () => {
      dismissed++;
      props.visible = false;
    },
  };
  const { CustomerListSheet, CustomerListOptions } = compileUI(
    "../../components/CustomerListSheet.tsx",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "@expo/vector-icons": { Ionicons: "Ionicons" },
      "./Button": { Button: "Button" },
      "react-native": {
        Animated: { Value, spring: animate, timing: animate, View: "AnimatedView" },
        Dimensions: { get: () => ({ height: 800 }) },
        Modal: "Modal",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (s: any) => s, absoluteFill: {} },
      },
      "./SheetSurface": { SheetSurface: "SheetSurface" },
      "../lib/colors": { colors },
      "../lib/currency": {
        getCurrencyLabel: (code: string) => code,
      },
      "../lib/fonts": { fonts: {} },
      "../lib/direction": {
        rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
        textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
      },
      "../lib/i18n": { t: (key: Parameters<typeof language.t>[0]) => translate(key) },
      "../lib/customer-list": {
        CUSTOMER_BALANCE_FILTERS,
        CUSTOMER_SORTS,
        selectedCustomerGroupIds,
        selectedCustomerCurrencyCodes,
        toggleCustomerCurrencyFilter,
        toggleCustomerGroupFilter,
      },
      "./SheetBackdrop": {
        SheetBackdrop: "SheetBackdrop",
        useSheetMotionPreference: () => reducedMotion,
      },
      "./SheetHandle": { SheetHandle: "SheetHandle" },
      "../lib/use-sheet-drag": {
        useSheetDrag: (_visible: boolean, entrance: unknown, onDismiss: () => void) => ({
          translateY: entrance,
          panHandlers: {},
          dismiss: onDismiss,
        }),
      },
      "../lib/tokens": {
        radius: { sheet: 18, grabber: 2, md: 12, lg: 16 },
        space: { xs: 4, sm: 8, md: 12, lg: 16 },
        TOUCH_MIN: 44,
        typography: { bodySm: {}, labelBold: {} },
      },
    },
    {
      requestAnimationFrame: (fn: () => void) => {
        const id = ++sequence;
        frames.set(id, fn);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      setTimeout: (fn: () => void) => {
        const id = ++sequence;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  // Compact controls retain every sort and group combination in both directions.
  // Actual glyph sizing/line wrapping is still a phone check; these checks protect
  // the target floor, wrapping constraints, and visible/announced selection states.
  for (const isRTL of [false, true]) {
    let preference: CustomerListPreference = { sort: "outstanding_name", group: "all" };
    const longName = "مشتری‌های خانوادگی و همسایه‌های نزدیک خانه و دوستان قدیمی";
    const optionProps = () => ({
      compact: true,
      preference,
      groups: [
        { id: "family", name: "Family", member_count: 1 },
        { id: "neighbors", name: longName, member_count: 1 },
      ],
      isRTL,
      onChange: (next: CustomerListPreference) => (preference = next),
    });
    const options = () => CustomerListOptions(optionProps());
    const choice = (label: string) => {
      const control = nodes(options()).find((node) => node.props.accessibilityLabel === label);
      assert.ok(control, `Missing filter choice ${label}`);
      return control;
    };
    const style = (control: any) => flattenStyle(control.props.style({ pressed: false }));
    assert.equal(
      nodes(options()).some((node) => node.type === "ScrollView"),
      false,
    );
    assert.equal(
      nodes(options()).filter((node) => node.props.accessibilityRole === "radio").length,
      CUSTOMER_SORTS.length + CUSTOMER_BALANCE_FILTERS.length,
    );
    const radioGroups = nodes(options()).filter(
      (node) => node.props.accessibilityRole === "radiogroup",
    );
    assert.deepEqual(
      radioGroups.map((node) => node.props.accessibilityLabel),
      ["customers.balanceFilter", "customers.sort"],
      "balance direction and sort use separate radio groups in that order",
    );
    assert.equal(
      nodes(radioGroups[0]).filter((node) => node.props.accessibilityRole === "radio").length,
      3,
    );
    const rowChoices = (group: any) =>
      [group.props.children]
        .flat()
        .filter((row) => row?.type === "View")
        .map((row) => nodes(row).filter((node) => node.props.accessibilityRole === "radio"));
    assert.deepEqual(
      rowChoices(radioGroups[0]).map((row) => row.map((node) => node.props.accessibilityLabel)),
      [
        [
          "customers.balanceFilter.all",
          "customers.balanceFilter.collect",
          "customers.balanceFilter.pay",
        ],
      ],
      "All three balance choices share one equal-width row",
    );
    assert.deepEqual(
      rowChoices(radioGroups[1]).map((row) => row.map((node) => node.props.accessibilityLabel)),
      [
        ["customers.sort.recent"],
        ["customers.sort.date_asc"],
        ["customers.sort.name_asc", "customers.sort.name_desc"],
        ["customers.sort.amount_asc", "customers.sort.amount_desc"],
        ["customers.sort.outstanding_name"],
      ],
      "chronological choices remain first, related name/amount choices share rows, and balance priority is a distinct mode",
    );
    assert.equal(
      style(choice("customers.sort.recent")).flexBasis,
      "100%",
      "Recent activity stays first and full width",
    );
    for (const group of radioGroups)
      for (const row of [group.props.children].flat().filter((node) => node?.type === "View")) {
        const layout = flattenStyle(row.props.style);
        assert.equal(layout.flexDirection, isRTL ? "row-reverse" : "row");
        assert.equal(
          layout.alignItems,
          "stretch",
          "paired targets grow to the same natural height",
        );
        for (const control of nodes(row).filter(
          (node) => node.props.accessibilityRole === "radio",
        )) {
          assert.equal(style(control).flex, 1);
          assert.equal(style(control).minWidth, 0, "paired labels can wrap on narrow phones");
        }
      }
    for (const direction of CUSTOMER_BALANCE_FILTERS) {
      const previous = { sort: preference.sort, group: preference.group };
      const control = choice(`customers.balanceFilter.${direction}`);
      assert.ok(style(control).minHeight >= 44);
      assert.equal(style(control).flexDirection, isRTL ? "row-reverse" : "row");
      control.props.onPress();
      assert.deepEqual(
        preference,
        { ...previous, direction },
        "direction changes preserve the sort and group choice",
      );
      assert.equal(
        choice(`customers.balanceFilter.${direction}`).props.accessibilityState.checked,
        true,
      );
      const balanceGroup = nodes(options()).find(
        (node) =>
          node.props.accessibilityRole === "radiogroup" &&
          node.props.accessibilityLabel === "customers.balanceFilter",
      )!;
      assert.equal(
        nodes(balanceGroup).filter(
          (node) =>
            node.props.accessibilityRole === "radio" && node.props.accessibilityState.checked,
        ).length,
        1,
      );
    }
    for (const sort of CUSTOMER_SORTS) {
      const control = choice(`customers.sort.${sort}`);
      assert.ok(style(control).minHeight >= 44);
      control.props.onPress();
      assert.equal(preference.sort, sort);
      const selected = choice(`customers.sort.${sort}`);
      assert.equal(selected.props.accessibilityState.checked, true);
      assert.equal(style(selected).backgroundColor, colors.bgSubtle);
      assert.equal(style(selected).borderColor, colors.borderEmphasis);
      assert.equal(
        nodes(selected).find((node) => node.type === "Ionicons")?.props.color,
        colors.textEmphasis,
      );
      assert.equal(
        nodes(options()).filter(
          (node) =>
            node.props.accessibilityRole === "radio" && node.props.accessibilityState.checked,
        ).length,
        2,
        "each independent radio group keeps one checked option",
      );
    }
    choice("Family").props.onPress();
    choice(longName).props.onPress();
    assert.deepEqual(selectedCustomerGroupIds(preference.group), ["family", "neighbors"]);
    for (const label of ["Family", longName]) {
      const control = choice(label);
      assert.equal(control.props.accessibilityRole, "checkbox");
      assert.equal(control.props.accessibilityState.checked, true);
      assert.equal(style(control).borderColor, colors.borderEmphasis);
      assert.ok(style(control).minHeight >= 44);
      assert.equal(style(control).maxWidth, "100%");
      assert.equal(style(control).flexDirection, isRTL ? "row-reverse" : "row");
      const text = nodes(control).find((node) => node.type === "Text")!;
      assert.equal(text.props.numberOfLines, undefined, "long group names are never truncated");
      assert.equal(flattenStyle(text.props.style).flexShrink, 1);
    }
    choice("groups.all").props.onPress();
    assert.equal(preference.group, "all");
    choice("groups.ungrouped").props.onPress();
    assert.equal(preference.group, "ungrouped");
    assert.equal(choice("Family").props.accessibilityState.checked, false);
    assert.equal(
      preference.direction,
      "pay",
      "sort and group changes preserve the chosen balance filter",
    );
  }
  for (const locale of ["en", "fa", "ps"] as const) {
    language.setLocale(locale);
    translate = language.t;
    for (const embedded of [false, true]) {
      let preference: CustomerListPreference = {
        sort: "recent",
        group: ["family"],
        direction: "pay",
      };
      const renderOptions = (amountSortAvailable = true) =>
        CustomerListOptions({
          compact: true,
          embedded,
          amountSortAvailable,
          isRTL: locale !== "en",
          preference,
          groups: [{ id: "family", name: "Family", member_count: 1 }],
          onChange: (next: CustomerListPreference) => {
            preference = next;
          },
        });
      const tree = renderOptions();
      const balanceGroup = nodes(tree).find(
        (node) =>
          node.props.accessibilityRole === "radiogroup" &&
          node.props.accessibilityLabel === language.t("customers.balanceFilter"),
      )!;
      assert.ok(balanceGroup);
      const radios = nodes(balanceGroup).filter((node) => node.props.accessibilityRole === "radio");
      assert.deepEqual(
        radios.map((node) => node.props.accessibilityLabel),
        CUSTOMER_BALANCE_FILTERS.map((direction) =>
          language.t(`customers.balanceFilter.${direction}`),
        ),
      );
      assert.deepEqual(
        radios.map((node) => node.props.accessibilityState.checked),
        [false, false, true],
      );
      assert.equal(
        nodes(tree).some(
          (node) =>
            node.type === "Text" &&
            node.props.children === language.t("customers.balanceFilter.help"),
        ),
        false,
        "a single-currency book needs no multi-currency balance explanation",
      );
      assert.ok(
        radios.every((node) => flattenStyle(node.props.style({ pressed: false })).minHeight >= 44),
      );
      radios[1].props.onPress();
      assert.deepEqual(preference, { sort: "recent", group: ["family"], direction: "collect" });
      const updated = nodes(renderOptions()).filter(
        (node) =>
          node.props.accessibilityRole === "radio" &&
          node.props.accessibilityLabel === language.t("customers.balanceFilter.collect"),
      );
      assert.equal(updated[0].props.accessibilityState.checked, true);
      assert.ok(!language.t("customers.balanceFilter.clear").startsWith("customers."));
      const multipleCurrencies = renderOptions(false);
      assert.ok(
        nodes(multipleCurrencies).some(
          (node) =>
            node.type === "Text" &&
            node.props.children === language.t("customers.balanceFilter.help"),
        ),
        "mixed-currency balances keep their any-currency explanation",
      );
      const sortGroup = nodes(multipleCurrencies).find(
        (node) =>
          node.props.accessibilityRole === "radiogroup" &&
          node.props.accessibilityLabel === language.t("customers.sort"),
      )!;
      const availableSorts = nodes(sortGroup).filter(
        (node) => node.props.accessibilityRole === "radio",
      );
      assert.deepEqual(
        availableSorts.map((node) => node.props.accessibilityLabel),
        (["recent", "date_asc", "name_asc", "name_desc", "outstanding_name"] as const).map((sort) =>
          language.t(`customers.sort.${sort}`),
        ),
        "mixed-currency controls omit both amount orderings",
      );
      assert.ok(
        availableSorts.every(
          (node) => flattenStyle(node.props.style({ pressed: false })).minHeight >= 44,
        ),
      );
      for (const node of nodes(tree).filter((node) =>
        ["radio", "checkbox"].includes(node.props.accessibilityRole),
      )) {
        const label = nodes(node).find((child) => child.type === "Text")!;
        assert.equal(
          label.props.numberOfLines,
          undefined,
          `${locale}: labels remain complete at 320px/large text`,
        );
        assert.equal(flattenStyle(label.props.style).flexShrink, 1);
        assert.equal(
          flattenStyle(node.props.style({ pressed: false })).height,
          undefined,
          "long localized labels can grow their touch target rather than clip",
        );
      }
      const hasAmountHelp = (tree: any) =>
        nodes(tree).some(
          (node) =>
            node.type === "Text" &&
            node.props.children === language.t("customers.sort.multiCurrencyHelp"),
        );
      assert.equal(hasAmountHelp(multipleCurrencies), true);
      assert.equal(
        hasAmountHelp(tree),
        false,
        "single-currency forms retain all sorts without extra help",
      );
      availableSorts
        .find((node) => node.props.accessibilityLabel === language.t("customers.sort.name_desc"))!
        .props.onPress();
      assert.deepEqual(
        preference,
        { sort: "name_desc", group: ["family"], direction: "collect" },
        "remaining sorts preserve both filters when amount ordering is unavailable",
      );
      const afterSort = nodes(renderOptions(false)).find(
        (node) =>
          node.props.accessibilityRole === "radio" &&
          node.props.accessibilityLabel === language.t("customers.sort.name_desc"),
      )!;
      assert.equal(afterSort.props.accessibilityState.checked, true);

      const currencyOptions = (currencies: readonly string[] = ["AFN", "USD", "XYZ", "USD"]) =>
        CustomerListOptions({
          compact: true,
          embedded,
          currencies,
          isRTL: locale !== "en",
          preference,
          amountSortAvailable: selectedCustomerCurrencyCodes(preference.currency).length === 1,
          groups: [{ id: "family", name: "Family", member_count: 1 }],
          onChange: (next: CustomerListPreference) => {
            preference = next;
          },
        });
      assert.ok(!language.t("customers.currencyFilter").startsWith("customers."));
      assert.ok(!language.t("customers.currencyFilter.all").startsWith("customers."));
      assert.ok(!language.t("customers.sort.selectCurrencyHelp").startsWith("customers."));
      const currencyGroup = (tree: any) =>
        nodes(tree).find(
          (node) =>
            node.props.accessibilityRole === "none" &&
            node.props.accessibilityLabel === language.t("customers.currencyFilter"),
        );
      const currencyButtons = (tree: any) =>
        nodes(currencyGroup(tree)).filter((node) => node.props.accessibilityRole === "checkbox");
      const allCurrencies = currencyOptions();
      assert.deepEqual(
        nodes(allCurrencies)
          .filter((node) => node.props.accessibilityRole === "radiogroup")
          .map((node) => node.props.accessibilityLabel),
        [language.t("customers.balanceFilter"), language.t("customers.sort")],
        "balance and sort remain radio groups while currencies support independent selection",
      );
      assert.deepEqual(
        currencyButtons(allCurrencies).map((node) => node.props.accessibilityLabel),
        [language.t("customers.currencyFilter.all"), "AFN", "USD", "XYZ"],
        "currency choices deduplicate codes and label unknown historic codes honestly",
      );
      assert.deepEqual(
        currencyButtons(allCurrencies).map((node) => node.props.accessibilityState.checked),
        [true, false, false, false],
      );
      const strip = nodes(currencyGroup(allCurrencies)).find((node) => node.type === "ScrollView")!;
      assert.equal(strip.props.horizontal, true);
      assert.equal(
        strip.props.keyboardShouldPersistTaps,
        "handled",
        "choosing a currency does not dismiss the native keyboard",
      );
      assert.equal(strip.props.nestedScrollEnabled, true);
      assert.equal(flattenStyle(strip.props.contentContainerStyle).flexDirection, "row");
      assert.equal(flattenStyle(strip.props.style).flexGrow, 0);
      assert.equal(
        nodes(allCurrencies).some((node) => node.type === "Modal"),
        false,
        "currency selection stays in the existing popup",
      );
      assert.ok(
        nodes(allCurrencies).some(
          (node) => node.props.children === language.t("customers.sort.selectCurrencyHelp"),
        ),
      );
      for (const control of currencyButtons(allCurrencies)) {
        const style = flattenStyle(control.props.style({ pressed: false }));
        assert.ok(style.minHeight >= 44);
        assert.equal(style.flexShrink, 0);
        const label = nodes(control).find((node) => node.type === "Text")!;
        assert.equal(label.props.numberOfLines, undefined);
      }
      const beforeCurrency = { ...preference };
      currencyButtons(allCurrencies)
        .find((node) => node.props.accessibilityLabel === "USD")!
        .props.onPress();
      assert.deepEqual(
        preference,
        { ...beforeCurrency, currency: "USD" },
        "currency selection retains sort, direction and groups",
      );
      const oneCurrency = currencyOptions();
      assert.equal(
        currencyButtons(oneCurrency).find((node) => node.props.accessibilityLabel === "USD")!.props
          .accessibilityState.checked,
        true,
      );
      const smallest = nodes(oneCurrency).find(
        (node) => node.props.accessibilityLabel === language.t("customers.sort.amount_asc"),
      )!;
      assert.ok(smallest, "a scoped currency exposes amount sorting in the same controls");
      smallest.props.onPress();
      assert.equal(preference.currency, "USD");
      assert.equal(preference.sort, "amount_asc");
      assert.deepEqual(preference.group, ["family"]);
      assert.equal(preference.direction, "collect");
      currencyButtons(currencyOptions())
        .find((node) => node.props.accessibilityLabel === "AFN")!
        .props.onPress();
      assert.deepEqual(preference.currency, ["AFN", "USD"]);
      const severalCurrencies = currencyOptions();
      assert.deepEqual(
        currencyButtons(severalCurrencies).map((node) => node.props.accessibilityState.checked),
        [false, true, true, false],
      );
      assert.ok(
        !nodes(severalCurrencies).some(
          (node) => node.props.accessibilityLabel === language.t("customers.sort.amount_asc"),
        ),
      );
      currencyButtons(severalCurrencies)
        .find((node) => node.props.accessibilityLabel === "USD")!
        .props.onPress();
      assert.equal(preference.currency, "AFN", "a selected currency toggles off independently");
      currencyButtons(currencyOptions())
        .find((node) => node.props.accessibilityLabel === "AFN")!
        .props.onPress();
      assert.equal(preference.currency, undefined, "deselecting the last currency returns to All");
      const beforeAll = { ...preference };
      currencyButtons(currencyOptions())[0].props.onPress();
      assert.deepEqual(preference, { ...beforeAll, currency: undefined });
      assert.equal(
        currencyGroup(currencyOptions(["AFN"])),
        undefined,
        "a sole implicit currency needs no redundant chooser",
      );
      const many = Array.from(
        { length: 64 },
        (_, index) =>
          `A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`,
      );
      const manyOptions = currencyOptions(many);
      assert.equal(
        currencyButtons(manyOptions).length,
        65,
        "all available denominations remain reachable without a tall grid",
      );
      assert.equal(
        nodes(currencyGroup(manyOptions)).filter((node) => node.type === "ScrollView").length,
        1,
      );
      // Native callbacks are opaque to assertion-based TypeScript narrowing.
      preference = { ...beforeAll, currency: "AFN" };
      assert.equal(
        currencyButtons(currencyOptions(["AFN"])).length,
        2,
        "an explicit one-currency filter still offers All to clear it",
      );
    }
  }
  translate = (key: string) => key;
  const render = () => hooks.render(() => CustomerListSheet(props));
  const flushFrames = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((fn) => fn());
  };
  const clickManage = () =>
    nodes(hooks.tree)
      .find((n) => n.props.accessibilityLabel === "groups.manage")!
      .props.onPress();
  render();
  flushFrames();
  const surface = nodes(hooks.tree).find((node) => node.type === "SheetSurface")!;
  assert.equal(hooks.tree.props.navigationBarTranslucent, undefined);
  assert.equal(
    surface.props.maxHeightRatio,
    0.78,
    "the plain surface owns the viewport height cap",
  );
  assert.equal(surface.props.edges, undefined);
  assert.ok(
    !nodes(hooks.tree).some(
      (node) => node.type === "AnimatedView" && flattenStyle(node.props.style)?.maxHeight != null,
    ),
    "the transformed frame has no percentage height cap",
  );
  const rowLabels = () =>
    nodes(hooks.tree)
      .map((n) => n.props.accessibilityLabel)
      .filter(Boolean);
  assert.ok(rowLabels().includes("groups.ungrouped"), "group rows show once a group exists");
  props.groups = [];
  render();
  assert.ok(
    !rowLabels().includes("groups.all") && !rowLabels().includes("groups.ungrouped"),
    "no All/Ungrouped filter rows before any group exists",
  );
  assert.ok(rowLabels().includes("groups.manage"), "managers can still create the first group");
  props.groups = [{ id: "g", name: "Family", member_count: 1 }];
  render();
  props.visible = false;
  render();
  const staleClose = animations.at(-1)!;
  props.visible = true;
  render();
  staleClose.callback?.({ finished: true });
  render();
  assert.ok(
    nodes(hooks.tree).some((n) => n.type === "Modal"),
    "stopped close callback cannot hide reopened sheet",
  );
  assert.ok(staleClose.stopped);
  flushFrames();
  clickManage();
  clickManage();
  assert.equal(dismissed, 1, "double tap coalesces");
  render();
  const callbacks = [...timers.values()];
  timers.clear();
  callbacks.forEach((fn) => fn());
  assert.equal(managed, 1, "manage opens only after sheet dismiss");
  props.visible = true;
  render();
  clickManage();
  render();
  props.contextKey = "b:v2";
  render();
  assert.equal(timers.size, 0, "context change cancels pending navigation");
  props.visible = true;
  render();
  clickManage();
  render();
  props.visible = true;
  render();
  assert.equal(timers.size, 0, "rapid reopen cancels deferred action");
  reducedMotion = true;
  render();
  assert.equal(frames.size, 0, "reduced motion does not enqueue animation frame");
  props.visible = false;
  render();
  assert.equal(hooks.tree, null, "reduced-motion close is immediate");
  props.visible = true;
  render();
  clickManage();
  render();
  const delayed = [...timers.values()];
  hooks.unmount();
  reducedMotion = false;
  await settleUI();
  delayed.forEach((fn) => fn());
  staleClose.callback?.({ finished: true });
  assert.equal(managed, 1);
  assert.equal(hooks.lateWrites, 0, "late native/timer callbacks do not write after unmount");
  console.log(
    "PASS real sort/filter sheet rapid reopen, coalesced manage, scope/unmount guards and reduced motion",
  );

  const dataHooks = uiHooks();
  let vault = "v1",
    account = "a",
    pause: Promise<any> | null = null;
  const ledgerListeners = new Set<() => void>();
  const read = async (id: string) => {
    const captured = pause;
    return captured
      ? await captured
      : {
          groups: [{ id: id + "-group", name: id, member_count: 1 }],
          groupByPerson: { p: id + "-group" },
          groupsByPerson: { p: [id + "-group"] },
        };
  };
  const { useCustomerGroups } = compileUI("../use-customer-groups.ts", {
    react: dataHooks.react,
    "expo-router": { useFocusEffect: (fn: any) => dataHooks.react.useEffect(fn, [fn]) },
    "./db-tx": { getAccountIdSync: () => account },
    "./customer-groups": { readCustomerGroups: read },
    "./ledger-events": {
      useLedgerRefresh: (_vault: string | null, fn: () => void) =>
        dataHooks.react.useEffect(() => {
          ledgerListeners.add(fn);
          return () => {
            ledgerListeners.delete(fn);
          };
        }, [fn]),
    },
  });
  const dataRender = () => dataHooks.render(() => jsx("State", useCustomerGroups(vault)));
  dataRender();
  await settleUI();
  dataRender();
  assert.equal(dataHooks.tree.props.groups[0].id, "v1-group");
  const late = deferred<any>();
  pause = late.promise;
  for (const fn of [...ledgerListeners]) fn();
  account = "b";
  vault = "v2";
  pause = null;
  dataRender();
  assert.equal(
    dataHooks.tree.props.groups.length,
    0,
    "old group list is hidden on scope-change render",
  );
  await settleUI();
  dataRender();
  assert.equal(dataHooks.tree.props.groups[0].id, "v2-group");
  late.resolve({
    groups: [{ id: "stale", name: "stale", member_count: 1 }],
    groupByPerson: { p: "stale" },
    groupsByPerson: { p: ["stale"] },
  });
  await settleUI();
  dataRender();
  assert.equal(
    dataHooks.tree.props.groups[0].id,
    "v2-group",
    "late old account/kaata read rejected",
  );
  const lateUnmount = deferred<any>();
  pause = lateUnmount.promise;
  for (const fn of [...ledgerListeners]) fn();
  dataHooks.unmount();
  lateUnmount.resolve({ groups: [], groupByPerson: {}, groupsByPerson: {} });
  await settleUI();
  assert.equal(dataHooks.lateWrites, 0);
  assert.equal(ledgerListeners.size, 0);
  console.log(
    "PASS real group hook scope-bound reads, live ledger refresh, late results and unmount cleanup",
  );

  const personHooks = uiHooks();
  let currentAccount = "a",
    currentVault = "v",
    personId = "p",
    backCount = 0;
  let editable = true;
  let personState = {
    groups: [
      { id: "g", name: "Family", member_count: 1 },
      { id: "h", name: "Neighbors", member_count: 0 },
    ],
    groupByPerson: { p: "g", q: "h" },
    groupsByPerson: { p: ["g"], q: ["h"] },
    loaded: true,
    failed: false,
  };
  const written: string[][] = [];
  const pendingSave = deferred<void>();
  let failSave = false;
  let preventRemove = false;
  let preventCallback: ((options: { repeat: () => void }) => void) | null = null;
  const dispatched: unknown[] = [];
  const groupNavigation: unknown[] = [];
  const compilePersonGroup = (react: typeof personHooks.react) =>
    compileUI("../../app/person/[id]/group.tsx", {
      react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "expo-router": {
        useRouter: () => ({
          back: () => backCount++,
          push: (route: unknown) => groupNavigation.push(route),
        }),
        useLocalSearchParams: () => ({ id: personId, vaultId: "v" }),
        usePreventRemove: (prevent: boolean, callback: typeof preventCallback) => {
          preventRemove = prevent;
          preventCallback = callback;
          return () => {
            preventRemove = false;
          };
        },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        StyleSheet: { create: (s: any) => s },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../../../components/Button": { Button: "Button" },
      "../../../components/SettingsScreen": { ScreenHeader: "Header" },
      "../../../lib/customer-groups": {
        assignCustomerGroups: async (_vault: string, _id: string, ids: string[]) => {
          written.push([...ids]);
          await pendingSave.promise;
          if (failSave) throw new Error("synthetic save failure");
        },
      },
      "../../../lib/db-tx": {
        getAccountIdSync: () => currentAccount,
        getActiveVaultIdSyncMaybe: () => currentVault,
      },
      "../../../lib/colors": { colors: {} },
      "../../../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../../../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../../../lib/fonts": { fonts: {} },
      "../../../lib/i18n": { t: (key: string) => key },
      "../../../lib/use-customer-groups": { useCustomerGroups: () => personState },
      "../../../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend: editable }),
      },
      "../../../lib/tokens": { icon: { row: 22 } },
    }).default;
  const PersonGroupScreen = compilePersonGroup(personHooks.react);
  let personRender = () => personHooks.render(() => PersonGroupScreen());
  // The harness ignores state after unmount, so every remount is a fresh one.
  const remountPersonGroup = () => {
    const hooks = uiHooks();
    const Screen = compilePersonGroup(hooks.react);
    personRender = () => hooks.render(() => Screen());
    personTree = () => hooks.tree;
    return hooks;
  };
  let personTree = () => personHooks.tree;
  const personRow = (label: string) =>
    nodes(personTree()).find((n) => n.props.accessibilityLabel === label)!;
  personRender();
  const personActions = nodes(personTree()).filter((n) =>
    ["groups.manage", "common.done"].includes(n.props.accessibilityLabel),
  );
  assert.deepEqual(
    personActions.map((n) => n.props.accessibilityLabel),
    ["groups.manage", "common.done"],
    "Manage groups sits above the final Done action",
  );
  assert.equal(personActions[0].type, "Button", "Manage groups has button geometry");
  assert.equal(personActions[0].props.icon, "add-outline", "Manage groups offers a plus");
  personRow("groups.manage").props.onPress();
  assert.deepEqual(groupNavigation, [{ pathname: "/groups", params: { vaultId: "v" } }]);
  assert.equal(
    backCount,
    0,
    "Manage groups pushes a screen without losing the customer's selection",
  );
  assert.equal(personRow("Family").props.accessibilityState.selected, true);
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(personRow("Family").props.accessibilityState.selected, true);
  assert.equal(personRow("Neighbors").props.accessibilityState.selected, true);
  assert.equal(written.length, 0, "multi-selection edits stay local until Done");
  personState = { ...personState, groupsByPerson: { p: [], q: ["h"] } };
  personRender();
  assert.equal(
    personRow("Family").props.accessibilityState.selected,
    true,
    "live refresh keeps explicit draft",
  );
  personId = "q";
  personRender();
  assert.equal(
    personRow("Family").props.accessibilityState.selected,
    false,
    "route change never carries another person's draft",
  );
  assert.equal(personRow("Neighbors").props.accessibilityState.selected, true);
  personRow("common.done").props.onPress();
  personRow("common.done").props.onPress();
  await settleUI();
  assert.deepEqual(written, [["h"]], "Done serializes one complete set");
  pendingSave.resolve();
  await settleUI();
  personRender();
  assert.equal(backCount, 1);
  editable = false;
  personRender();
  assert.equal(personRow("Neighbors").props.disabled, true, "viewer cannot change classification");
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "common.done"),
    false,
  );
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "groups.manage"),
    false,
    "viewer cannot open group management",
  );
  currentAccount = "b";
  currentVault = "other";
  editable = true;
  personRender();
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "common.done"),
    false,
    "scope change hides write action",
  );
  assert.equal(
    nodes(personHooks.tree).some((n) => n.props.accessibilityLabel === "groups.manage"),
    false,
    "scope change also hides group management",
  );
  personHooks.unmount();

  // Leaving with unsaved checks saves them, whichever way the user leaves.
  currentAccount = "a";
  currentVault = "v";
  editable = true;
  personId = "p";
  personState = { ...personState, groupsByPerson: { p: ["g"], q: ["h"] } };
  let mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  assert.equal(preventRemove, false, "nothing unsaved: leaving is not intercepted");
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(preventRemove, true, "unsaved checks intercept leaving");
  const writesBeforeBack = written.length;
  preventCallback!({ repeat: () => dispatched.push({ type: "GO_BACK" }) });
  await settleUI();
  assert.deepEqual(written.slice(writesBeforeBack), [["g", "h"]], "Back saves the checked groups");
  assert.equal(dispatched.length, 1, "and then leaves");
  personRender();
  assert.equal(preventRemove, false, "SDK 58 repeat keeps the prevention condition released");
  mounted.unmount();

  // A group removed before Done drops out of the draft instead of sticking.
  personState = {
    ...personState,
    groups: personState.groups.slice(),
    groupsByPerson: { p: ["g"], q: ["h"] },
  };
  mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  personRow("Neighbors").props.onPress();
  personRender();
  assert.equal(preventRemove, true);
  personState = {
    ...personState,
    groups: personState.groups.filter((group) => group.id !== "h"),
  };
  personRender();
  assert.equal(preventRemove, false, "a removed group leaves the draft");
  mounted.unmount();

  // A failed save is shown, and the next Back may discard instead of trapping.
  personState = {
    ...personState,
    groups: [
      { id: "g", name: "Family", member_count: 1 },
      { id: "h", name: "Neighbors", member_count: 0 },
    ],
  };
  failSave = true;
  mounted = remountPersonGroup();
  personRender();
  await settleUI();
  personRender();
  personRow("Neighbors").props.onPress();
  personRender();
  preventCallback!({ repeat: () => assert.fail("a failed save must not repeat navigation") });
  await settleUI();
  personRender();
  assert.ok(
    nodes(personTree()).some((n) => n.props.children === "entry.saveFailed"),
    "the failed save is visible",
  );
  assert.equal(preventRemove, false, "after a failed save, Back can leave");
  failSave = false;
  mounted.unmount();

  // Manage groups: Android keyboard avoidance (CLAUDE.md) and ref focus, not
  // autoFocus under the closing BottomSheet modal.
  const manageSource = readFileSync(require.resolve("../../app/groups.tsx"), "utf8");
  assert.ok(
    /behavior="height"\s+enabled=\{Platform\.OS === "android"\}/.test(manageSource),
    "Manage groups lifts the name field and Save above Android's keyboard",
  );
  assert.ok(manageSource.includes("automaticallyAdjustKeyboardInsets"), "iOS keyboard insets");
  assert.ok(
    !/^\s*autoFocus(=|\s*$)/m.test(manageSource),
    "group name focuses by ref after the sheet closes",
  );

  // Execute Manage groups too: the delayed editor reveal keeps its native
  // focus timing, and reads motion at dispatch rather than capturing a mode.
  for (const [initialReduced, currentReduced] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    const managerHooks = uiHooks();
    const managerTimers = new Map<number, { delay: number; run: () => void }>();
    const scrolls: unknown[] = [];
    let timerId = 0,
      focused = 0,
      reducedMotion = initialReduced;
    const { default: ManageGroups } = compileUI(
      "../../app/groups.tsx",
      {
        react: managerHooks.react,
        "react/jsx-runtime": { jsx, jsxs: jsx },
        "react-native": {
          ActivityIndicator: "ActivityIndicator",
          KeyboardAvoidingView: "KeyboardAvoidingView",
          Platform: { OS: "android" },
          Pressable: "Pressable",
          ScrollView: "ScrollView",
          Text: "Text",
          TextInput: "TextInput",
          View: "View",
          StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
        },
        "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
        "@expo/vector-icons": { Ionicons: "Ionicons" },
        "expo-router": {
          useRouter: () => ({ back() {}, push() {} }),
          useLocalSearchParams: () => ({ vaultId: "v" }),
        },
        "../components/BottomSheet": { BottomSheet: "BottomSheet" },
        "../components/Button": { Button: "Button" },
        "../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
        "../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
        "../lib/colors": { colors },
        "../lib/customer-groups": { archiveCustomerGroup() {}, saveCustomerGroup() {} },
        "../lib/db-tx": {
          getAccountIdSync: () => "a",
          getActiveVaultIdSyncMaybe: () => "v",
        },
        "../lib/direction": {
          useIsRTL: () => false,
          rowDir: () => ({}),
          textDir: () => ({}),
        },
        "../lib/event-log": { RoleGateRejectionError: class extends Error {} },
        "../lib/fonts": { fonts: {} },
        "../lib/i18n": { t: (key: string) => key },
        "../lib/motion-preference": {
          getMotionPreferenceSnapshot: () => ({ effectiveReducedMotion: reducedMotion }),
        },
        "../lib/use-customer-groups": {
          useCustomerGroups: () => ({ groups: [], loaded: true, failed: false, refresh() {} }),
        },
        "../lib/use-vault-role": {
          useActiveVaultWriteCaps: () => ({ resolved: true, canAmend: true }),
        },
        "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8 } },
      },
      {
        setTimeout: (run: () => void, delay: number) => {
          const id = ++timerId;
          managerTimers.set(id, { run, delay });
          return id;
        },
        clearTimeout: (id: number) => managerTimers.delete(id),
      },
    );
    const managerRender = () => managerHooks.render(() => ManageGroups());
    managerRender();
    const scroll = nodes(managerHooks.tree).find((node) => node.type === "ScrollView")!;
    scroll.props.ref.current = { scrollToEnd: (options: unknown) => scrolls.push(options) };
    const add = nodes(managerHooks.tree).find(
      (node) =>
        node.type === "Pressable" &&
        nodes(node).some((child) => child.props.children === "groups.add"),
    )!;
    add.props.onPress();
    managerRender();
    const input = nodes(managerHooks.tree).find((node) => node.type === "TextInput")!;
    input.props.ref.current = { focus: () => focused++ };
    assert.equal(focused, 0, "group editor does not focus under the closing sheet");
    assert.equal(managerTimers.size, 1);
    const timer = [...managerTimers.values()][0];
    assert.equal(timer.delay, 280, "motion changes retain the existing modal/focus delay");
    reducedMotion = currentReduced;
    timer.run();
    assert.deepEqual(scrolls, [{ animated: !currentReduced }]);
    assert.equal(focused, 1, "group editor focuses once after its reveal");
    managerHooks.unmount();
    assert.equal(managerTimers.size, 0, "closing the screen clears the delayed editor work");
  }

  // Group members: who is in a group, and many customers in or out at once.
  {
    const hooks = uiHooks();
    let canAmend = true;
    const assignments: [string, string[]][] = [];
    let membersPrevent = false;
    let membersCallback: ((options: { repeat: () => void }) => void) | null = null;
    const membersDispatched: unknown[] = [];
    let membersBack = 0;
    const roster = [
      { id: "p1", name: "Zarif", phone: null },
      { id: "p2", name: "Ahmad 10", phone: "+93700000002" },
      { id: "p3", name: "Ahmad 2", phone: null },
    ];
    const groupState = {
      groups: [
        { id: "g", name: "Family", member_count: 1 },
        { id: "h", name: "Shop", member_count: 1 },
      ],
      groupByPerson: { p1: "g", p2: "h", p3: null },
      groupsByPerson: { p1: ["g"], p2: ["h"], p3: [] as string[] },
      loaded: true,
      failed: false,
    };
    const { default: GroupMembers } = compileUI("../../app/group-members.tsx", {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        useRouter: () => ({ back: () => membersBack++, push() {} }),
        useLocalSearchParams: () => ({ vaultId: "v", groupId: "g" }),
        useFocusEffect: (fn: () => void) => hooks.react.useEffect(fn, [fn]),
        usePreventRemove: (prevent: boolean, callback: typeof membersCallback) => {
          membersPrevent = prevent;
          membersCallback = callback;
          return () => {
            membersPrevent = false;
          };
        },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        KeyboardAvoidingView: "KAV",
        Platform: { OS: "android" },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../components/Button": { Button: "Button" },
      "../components/SettingsScreen": { ScreenHeader: "Header" },
      "../lib/colors": { colors: {} },
      "../lib/contacts-merge": {
        splitSearchQuery: (q: string) => ({ first: q.trim(), last: "", phoneDigits: "" }),
      },
      "../lib/customer-groups": {
        assignCustomerGroups: async (_vault: string, personId: string, ids: string[]) => {
          assignments.push([personId, [...ids].sort()]);
        },
      },
      "../lib/customer-list": { compareCustomerNames },
      "../lib/db": { listAllPeopleForSearch: async () => roster },
      "../lib/db-tx": { getAccountIdSync: () => "a", getActiveVaultIdSyncMaybe: () => "v" },
      "../lib/bidi": { ltrIsolate: (value: string) => value },
      "../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../lib/fonts": { fonts: {} },
      "../lib/i18n": { t: (key: string) => key, getLocale: () => "en" },
      "../lib/search": { searchContacts },
      "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8 } },
      "../lib/use-customer-groups": { useCustomerGroups: () => groupState },
      "../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend }),
      },
    });
    const renderMembers = () => hooks.render(() => GroupMembers());
    const listed = () =>
      nodes(hooks.tree)
        .filter((n) => n.type === "Pressable" && typeof n.props.accessibilityLabel === "string")
        .map((n) => n.props.accessibilityLabel);
    const memberRow = (name: string) =>
      nodes(hooks.tree).find((n) => n.type === "Pressable" && n.props.accessibilityLabel === name)!;
    renderMembers();
    await settleUI();
    renderMembers();
    assert.deepEqual(
      listed(),
      ["Zarif", "Ahmad 2", "Ahmad 10"],
      "members first, then everyone else in number-aware name order",
    );
    assert.equal(memberRow("Zarif").props.accessibilityState.checked, true);
    memberRow("Ahmad 2").props.onPress();
    memberRow("Ahmad 10").props.onPress();
    renderMembers();
    memberRow("Zarif").props.onPress();
    renderMembers();
    assert.deepEqual(listed(), ["Zarif", "Ahmad 2", "Ahmad 10"], "ticking never reorders rows");
    assert.equal(membersPrevent, true, "unsaved ticks intercept leaving");
    membersCallback!({ repeat: () => membersDispatched.push({ type: "GO_BACK" }) });
    await settleUI();
    assert.deepEqual(
      assignments.sort((a, b) => a[0].localeCompare(b[0])),
      [
        ["p1", []],
        ["p2", ["g", "h"]],
        ["p3", ["g"]],
      ],
      "Done writes each changed customer's complete set, keeping their other groups",
    );
    assert.equal(membersBack + membersDispatched.length, 1, "and leaves once");
    renderMembers();
    assert.equal(membersPrevent, false, "successful save clears the prevention condition");
    nodes(hooks.tree)
      .find((n) => n.type === "TextInput")!
      .props.onChangeText("Ahmad");
    renderMembers();
    assert.deepEqual(listed(), ["Ahmad 2", "Ahmad 10"], "search narrows the roster");
    hooks.unmount();

    const viewerHooks = uiHooks();
    canAmend = false;
    const { default: ViewerMembers } = compileUI("../../app/group-members.tsx", {
      react: viewerHooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "expo-router": {
        useRouter: () => ({ back() {}, push() {} }),
        useLocalSearchParams: () => ({ vaultId: "v", groupId: "g" }),
        useFocusEffect: (fn: () => void) => viewerHooks.react.useEffect(fn, [fn]),
        usePreventRemove: () => () => {},
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": {
        ActivityIndicator: "Spinner",
        KeyboardAvoidingView: "KAV",
        Platform: { OS: "ios" },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s, hairlineWidth: 1 },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
      "../components/Button": { Button: "Button" },
      "../components/SettingsScreen": { ScreenHeader: "Header" },
      "../lib/colors": { colors: {} },
      "../lib/contacts-merge": {
        splitSearchQuery: (q: string) => ({ first: q.trim(), last: "", phoneDigits: "" }),
      },
      "../lib/customer-groups": { assignCustomerGroups: async () => assert.fail("viewer write") },
      "../lib/customer-list": { compareCustomerNames },
      "../lib/db": { listAllPeopleForSearch: async () => roster },
      "../lib/db-tx": { getAccountIdSync: () => "a", getActiveVaultIdSyncMaybe: () => "v" },
      "../lib/bidi": { ltrIsolate: (value: string) => value },
      "../lib/direction": { rowDir: () => ({}), textDir: () => ({}), useIsRTL: () => false },
      "../lib/event-log": { RoleGateRejectionError: class extends Error {} },
      "../lib/fonts": { fonts: {} },
      "../lib/i18n": { t: (key: string) => key, getLocale: () => "en" },
      "../lib/search": { searchContacts },
      "../lib/tokens": { icon: { row: 22 }, radius: { sm: 8 } },
      "../lib/use-customer-groups": { useCustomerGroups: () => groupState },
      "../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend }),
      },
    });
    viewerHooks.render(() => ViewerMembers());
    await settleUI();
    viewerHooks.render(() => ViewerMembers());
    const viewerRows = nodes(viewerHooks.tree).filter(
      (n) => n.type === "Pressable" && typeof n.props.accessibilityLabel === "string",
    );
    assert.deepEqual(
      viewerRows.map((n) => n.props.accessibilityLabel),
      ["Zarif"],
      "a viewer sees who is in the group",
    );
    assert.ok(
      viewerRows.every((n) => n.props.disabled),
      "and cannot change it",
    );
    assert.equal(
      nodes(viewerHooks.tree).some((n) => n.type === "Button"),
      false,
      "no Done for a viewer",
    );
    viewerHooks.unmount();
  }
  console.log(
    "PASS real customer group multi-selection, explicit Done, route refresh, viewer and scope guards",
  );
}
