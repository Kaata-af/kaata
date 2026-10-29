import assert from "node:assert/strict";
import { colors } from "../colors";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const hooks = uiHooks();
const backHandlers = new Set<() => boolean>();
let dismissals = 0;
let keyboardDismissals = 0;
const { HomeFilterPopover, filterPopoverLayout } = compileUI("../../components/HomeFilterPopover", {
  react: hooks.react,
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "react-native": {
    View: "View",
    ScrollView: "ScrollView",
    Pressable: "Pressable",
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {}, absoluteFillObject: {} },
    BackHandler: {
      addEventListener: (_name: string, callback: () => boolean) => {
        backHandlers.add(callback);
        return { remove: () => backHandlers.delete(callback) };
      },
    },
  },
  "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
  "../lib/colors": { colors },
  "../lib/i18n": { t: (key: string) => key },
  "../lib/tokens": { lift: { elevation: 4 } },
});
const customerList = require("../customer-list") as typeof import("../customer-list");
const { CustomerListOptions } = compileUI("../../components/CustomerListSheet", {
  react: hooks.react,
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "react-native": {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    StyleSheet: { create: (styles: unknown) => styles },
  },
  "./SheetSurface": { SheetSurface: "SheetSurface" },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "../lib/colors": { colors },
  "../lib/currency": {
    getCurrencyLabel: (code: string) => code,
  },
  "../lib/fonts": { fonts: {} },
  "../lib/direction": {
    rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
    textDir: () => ({}),
  },
  "../lib/i18n": { t: (key: string) => key },
  "../lib/customer-list": customerList,
  "../lib/tokens": {
    radius: {},
    space: { xs: 4, sm: 8, md: 12, lg: 16 },
    TOUCH_MIN: 44,
    typography: {},
  },
  "./Button": {},
  "./ProtectedModal": { ProtectedModal: "Modal" },
  "./SheetBackdrop": {},
  "./SheetHandle": {},
  "../lib/use-sheet-drag": {},
});
const optionsProps = {
  compact: true,
  preference: customerList.DEFAULT_CUSTOMER_SEARCH,
  groups: [{ id: "family", name: "Family", member_count: 2 }],
  isRTL: false,
  onChange: (_preference: typeof customerList.DEFAULT_CUSTOMER_SEARCH) => {},
};

for (const viewport of [
  { width: 320, height: 620 },
  { width: 390, height: 720 },
  { width: 390, height: 280 },
  { width: 430, height: 800 },
  { width: 440, height: 812 },
  { width: 440, height: 320 },
  { width: 800, height: 320 },
]) {
  for (const x of [16, viewport.width - 120, viewport.width - 60]) {
    const anchor = { x, y: viewport.height - 72, width: 52, height: 52 };
    const layout = filterPopoverLayout(anchor, viewport);
    assert.ok(layout.left >= 12);
    assert.ok(layout.left + layout.width <= viewport.width - 12);
    assert.equal(
      layout.left,
      viewport.width - layout.left - layout.width,
      "The popup is centered independently of the filter button's position",
    );
    assert.equal(
      layout.width,
      viewport.width - 24,
      "Large phones and landscape use the full available width with equal edge margins",
    );
    const panelBottom = viewport.height - layout.bottom;
    assert.equal(panelBottom, anchor.y - 8, "Popup ends directly above its physical trigger");
    assert.equal(
      panelBottom - layout.maxHeight,
      12,
      "The content-sized popup can grow up to the safe top edge before scrolling",
    );
    assert.ok(layout.arrowLeft >= 12 && layout.arrowLeft <= layout.width - 22);
    assert.equal(
      layout.left + layout.arrowLeft + 5,
      anchor.x + anchor.width / 2,
      "Centering the panel keeps its arrow pointed at the filter button",
    );
  }
}

for (const topInset of [24, 47, 59]) {
  const fullWindow = { width: 440, height: 874, topInset };
  // The host still spans the whole screen while keyboard avoidance moves its
  // trigger upward. The panel follows that trigger, not the screen bottom.
  const keyboardAnchor = { x: 310, y: 390, width: 52, height: 52 };
  const layout = filterPopoverLayout(keyboardAnchor, fullWindow);
  const bottom = fullWindow.height - layout.bottom;
  assert.equal(bottom, keyboardAnchor.y - 8);
  assert.equal(bottom - layout.maxHeight, topInset + 12);
  assert.equal(layout.width, fullWindow.width - 24);
  assert.equal(layout.left, 12);
}

let props = {
  visible: true,
  contextKey: "account-a:vault-a:AFN",
  anchor: { x: 260, y: 548, width: 52, height: 52 },
  viewport: { width: 390, height: 620 },
  disabled: false,
  keyboardVisible: false,
  onDismissKeyboard: () => keyboardDismissals++,
  blurTarget: { current: null },
  onDismiss: () => dismissals++,
  renderToggle: ({ onPress, disabled }: { onPress: () => void; disabled: boolean }) =>
    jsx("Pressable", {
      testID: "sharp-filter-toggle",
      accessibilityRole: "button",
      accessibilityState: { expanded: true, disabled },
      disabled,
      onPress,
    }),
  children: CustomerListOptions({ ...optionsProps, embedded: true }),
};
const render = () => hooks.render(() => HomeFilterPopover(props));
render();
const popup = () => nodes(hooks.tree);
const backdrop = () => popup().find((node) => node.type === "SheetBackdrop")!;
const foreground = () => popup().find((node) => node.props.testID === "filter-popover-toggle")!;
const toggle = () => popup().find((node) => node.props.testID === "sharp-filter-toggle")!;
assert.deepEqual(
  { ...flattenStyle(foreground().props.style) },
  { position: "absolute", left: 260, top: 548, width: 52, height: 52 },
  "The sharp toggle occupies exactly the original trigger's measured rectangle",
);
assert.equal(toggle().props.accessibilityState.expanded, true);
assert.equal(toggle().props.disabled, false);
assert.ok(
  !nodes(backdrop()).includes(foreground()),
  "The clear toggle is a foreground sibling, outside the backdrop's blur layer",
);
const overlayChildren = [hooks.tree.props.children].flat().filter(Boolean);
assert.ok(
  overlayChildren.indexOf(foreground()) > overlayChildren.indexOf(backdrop()),
  "The toggle is drawn after the blur and remains the topmost close target",
);
props = { ...props, anchor: { x: 16, y: 310, width: 60, height: 44 } };
render();
assert.deepEqual(flattenStyle(foreground().props.style), {
  position: "absolute",
  left: 16,
  top: 310,
  width: 60,
  height: 44,
});
props = { ...props, anchor: { x: 260, y: 548, width: 52, height: 52 } };
render();
assert.equal(
  backdrop().props.blurTarget,
  props.blurTarget,
  "the backdrop samples the explicit Home target rather than an ancestor containing the popup",
);
assert.equal(backdrop().props.disabled, false);
assert.notEqual(
  hooks.tree.props.accessible,
  true,
  "the overlay preserves individual filter controls rather than merging accessibility",
);
assert.equal(popup().filter((node) => node.type === "ScrollView").length, 1);
assert.equal(popup().filter((node) => node.type === "Modal").length, 0);
assert.equal(flattenStyle(hooks.tree.props.style).zIndex, 40);
assert.equal(popup().find((node) => node.type === "ScrollView")!.props.nestedScrollEnabled, true);
assert.equal(
  flattenStyle(popup().find((node) => node.type === "ScrollView")!.props.style).flexGrow,
  0,
  "Short filter controls use their own content height rather than filling the available panel",
);
assert.equal(
  flattenStyle(popup().find((node) => node.type === "ScrollView")!.props.style).flexShrink,
  1,
  "Long filter controls shrink and scroll within the available panel height",
);
assert.equal(
  popup().filter(
    (node) => node.type === "View" && flattenStyle(node.props.style)?.borderWidth === 1,
  ).length,
  1,
  "the real embedded filter options sit directly in one popup card",
);
assert.equal(
  flattenStyle(popup().find((node) => node.type === "ScrollView")!.props.contentContainerStyle).gap,
  8,
  "the existing popup scroll container owns spacing before Manage groups",
);
const oldDismiss = backdrop().props.onDismiss;
const oldTogglePress = toggle().props.onPress;
oldTogglePress();
assert.equal(dismissals, 1);
assert.equal([...backHandlers][0](), true);
assert.equal(dismissals, 2, "Android Back dismisses the popup before leaving Home");
props = { ...props, keyboardVisible: true };
render();
assert.equal([...backHandlers][0](), true);
assert.equal(keyboardDismissals, 1, "Back dismisses a remaining keyboard first");
assert.equal(dismissals, 2, "The filters stay open while the keyboard closes");
props = { ...props, keyboardVisible: false };
render();
assert.equal([...backHandlers][0](), true);
assert.equal(dismissals, 3, "A subsequent Back closes filters after the keyboard is hidden");
props = { ...props, disabled: true };
render();
assert.equal(
  popup().find((node) => node.type === "ScrollView")!.props.pointerEvents,
  "none",
  "the popup itself freezes controls without an extra Home wrapper",
);
assert.equal(backdrop().props.disabled, true, "busy state reaches the shared blur backdrop");
assert.equal(toggle().props.disabled, true, "The sharp close toggle shares the busy guard");
oldTogglePress();
assert.equal(dismissals, 3, "A retained sharp toggle cannot dismiss during a busy operation");
backdrop().props.onDismiss();
assert.equal(dismissals, 3, "A busy selection freezes popup actions");
props = { ...props, disabled: false, contextKey: "account-b:vault-b:USD" };
render();
oldDismiss();
oldTogglePress();
assert.equal(dismissals, 3, "A retained backdrop callback cannot dismiss another account's popup");
props = { ...props, visible: false };
render();
assert.equal(hooks.tree, null);
assert.equal(backHandlers.size, 0);
props = { ...props, visible: true };
render();
const dismissedAfterUnmount = backdrop().props.onDismiss;
const toggleAfterUnmount = toggle().props.onPress;
hooks.unmount();
dismissedAfterUnmount();
toggleAfterUnmount();
assert.equal(dismissals, 3);
assert.equal(backHandlers.size, 0);

for (const isRTL of [false, true]) {
  let changed = optionsProps.preference;
  const props = {
    ...optionsProps,
    isRTL,
    onChange: (next: typeof changed) => {
      changed = next;
    },
  };
  const ordinary = CustomerListOptions(props);
  const embedded = CustomerListOptions({ ...props, embedded: true });
  const views = (tree: any) => nodes(tree).filter((node) => node.type === "View");
  const bordered = (tree: any) =>
    views(tree).filter((node) => flattenStyle(node.props.style)?.borderWidth === 1);
  assert.equal(
    bordered(ordinary).length,
    3,
    "standalone balance/sort/group sections retain their card presentation",
  );
  assert.equal(bordered(embedded).length, 0);
  assert.equal(
    views(ordinary).length - views(embedded).length,
    3,
    "embedded mode removes the decorative section Views rather than just hiding borders",
  );
  const choices = (tree: any) =>
    nodes(tree).filter((node) => ["radio", "checkbox"].includes(node.props.accessibilityRole));
  const signature = (tree: any) =>
    choices(tree).map((node) => [
      node.props.accessibilityRole,
      node.props.accessibilityLabel,
      node.props.accessibilityState,
    ]);
  assert.deepEqual(
    signature(embedded),
    signature(ordinary),
    "balance/sort/group semantics survive in both directions",
  );
  const radioGroups = nodes(embedded).filter(
    (node) => node.props.accessibilityRole === "radiogroup",
  );
  assert.deepEqual(
    radioGroups.map((node) => node.props.accessibilityLabel),
    ["customers.balanceFilter", "customers.sort"],
  );
  assert.equal(
    nodes(radioGroups[0]).filter((node) => node.props.accessibilityRole === "radio").length,
    customerList.CUSTOMER_BALANCE_FILTERS.length,
  );
  const rows = (group: any) =>
    [group.props.children]
      .flat()
      .filter((row) => row?.type === "View")
      .map((row) => nodes(row).filter((node) => node.props.accessibilityRole === "radio"));
  assert.deepEqual(
    rows(radioGroups[0]).map((row) => row.map((node) => node.props.accessibilityLabel)),
    [
      [
        "customers.balanceFilter.all",
        "customers.balanceFilter.collect",
        "customers.balanceFilter.pay",
      ],
    ],
  );
  assert.equal(
    nodes(embedded).some((node) => node.props.children === "customers.balanceFilter.help"),
    false,
  );
  assert.deepEqual(
    rows(radioGroups[1]).map((row) => row.map((node) => node.props.accessibilityLabel)),
    [
      ["customers.sort.recent"],
      ["customers.sort.date_asc"],
      ["customers.sort.name_asc", "customers.sort.name_desc"],
      ["customers.sort.amount_asc", "customers.sort.amount_desc"],
      ["customers.sort.outstanding_name"],
    ],
    "the actual embedded popup keeps opposite name/amount choices together",
  );
  choices(embedded)
    .find((node) => node.props.accessibilityLabel === "customers.sort.name_asc")!
    .props.onPress();
  assert.equal(changed.sort, "name_asc");
  const rerendered = CustomerListOptions({ ...props, embedded: true, preference: changed });
  choices(rerendered)
    .find((node) => node.props.accessibilityLabel === "Family")!
    .props.onPress();
  assert.equal(changed.sort, "name_asc");
  assert.deepEqual(customerList.selectedCustomerGroupIds(changed.group), ["family"]);
  const filtered = CustomerListOptions({ ...props, embedded: true, preference: changed });
  choices(filtered)
    .find((node) => node.props.accessibilityLabel === "customers.balanceFilter.collect")!
    .props.onPress();
  assert.deepEqual(
    changed,
    { sort: "name_asc", group: ["family"], direction: "collect" },
    "balance controls inside the actual popup preserve sort and groups",
  );
  const collected = CustomerListOptions({ ...props, embedded: true, preference: changed });
  assert.equal(
    choices(collected).find(
      (node) => node.props.accessibilityLabel === "customers.balanceFilter.collect",
    )!.props.accessibilityState.checked,
    true,
  );
  choices(collected)
    .find((node) => node.props.accessibilityLabel === "customers.balanceFilter.all")!
    .props.onPress();
  assert.equal(changed.direction, "all");
  assert.equal(changed.sort, "name_asc");
  assert.deepEqual(customerList.selectedCustomerGroupIds(changed.group), ["family"]);
  const restricted = CustomerListOptions({
    ...props,
    embedded: true,
    preference: changed,
    amountSortAvailable: false,
  });
  assert.equal(
    bordered(restricted).length,
    0,
    "mixed-currency help does not introduce another card inside the popup",
  );
  assert.ok(
    !choices(restricted).some((node) =>
      ["customers.sort.amount_asc", "customers.sort.amount_desc"].includes(
        node.props.accessibilityLabel,
      ),
    ),
  );
  assert.ok(
    nodes(restricted).some((node) => node.props.children === "customers.sort.multiCurrencyHelp"),
  );
  assert.ok(
    nodes(restricted).some((node) => node.props.children === "customers.balanceFilter.help"),
  );
  const restrictedSortGroup = nodes(restricted).find(
    (node) =>
      node.props.accessibilityRole === "radiogroup" &&
      node.props.accessibilityLabel === "customers.sort",
  )!;
  assert.deepEqual(
    rows(restrictedSortGroup).map((row) => row.map((node) => node.props.accessibilityLabel)),
    [
      ["customers.sort.recent"],
      ["customers.sort.date_asc"],
      ["customers.sort.name_asc", "customers.sort.name_desc"],
      ["customers.sort.outstanding_name"],
    ],
    "hiding cross-currency amount sorts removes their whole row without mixing neighboring options",
  );
  const remainingSort = choices(restricted).find(
    (node) => node.props.accessibilityLabel === "customers.sort.recent",
  )!;
  assert.ok(flattenStyle(remainingSort.props.style({ pressed: false })).minHeight >= 44);
  remainingSort.props.onPress();
  assert.deepEqual(changed, { sort: "recent", group: ["family"], direction: "all" });

  const currencyOptions = () =>
    CustomerListOptions({
      ...props,
      embedded: true,
      preference: changed,
      currencies: ["AFN", "USD"],
      amountSortAvailable:
        customerList.selectedCustomerCurrencyCodes(changed.currency).length === 1,
    });
  const allCurrencies = currencyOptions();
  const currencyGroup = (tree: any) =>
    nodes(tree).find(
      (node) =>
        node.props.accessibilityRole === "none" &&
        node.props.accessibilityLabel === "customers.currencyFilter",
    )!;
  const strip = nodes(currencyGroup(allCurrencies)).find((node) => node.type === "ScrollView")!;
  assert.ok(strip);
  assert.equal(strip.props.horizontal, true);
  assert.equal(strip.props.keyboardShouldPersistTaps, "handled");
  assert.equal(bordered(allCurrencies).length, 0, "currency choices add no card inside the popup");
  assert.ok(
    nodes(allCurrencies).some(
      (node) => node.props.children === "customers.sort.selectCurrencyHelp",
    ),
  );
  choices(currencyGroup(allCurrencies))
    .find((node) => node.props.accessibilityLabel === "USD")!
    .props.onPress();
  assert.deepEqual(changed, {
    sort: "recent",
    group: ["family"],
    direction: "all",
    currency: "USD",
  });
  const scoped = currencyOptions();
  assert.ok(
    choices(scoped).some((node) => node.props.accessibilityLabel === "customers.sort.amount_asc"),
  );
  choices(scoped)
    .find((node) => node.props.accessibilityLabel === "customers.sort.amount_asc")!
    .props.onPress();
  assert.equal(changed.currency, "USD");
  assert.equal(changed.sort, "amount_asc");
  choices(currencyGroup(currencyOptions()))
    .find((node) => node.props.accessibilityLabel === "customers.currencyFilter.all")!
    .props.onPress();
  assert.equal(changed.currency, undefined);
  assert.equal(changed.sort, "amount_asc");
}

console.log(
  "PASS single-card filter popup, actual embedded balance/sort/group controls, independent radio groups, viewport/keyboard bounds and retained scope guards",
);
