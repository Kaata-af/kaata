// Execute the home screen, its real list/filter logic, and selection arithmetic.
// Native presentation and the ordinary list refresh are controlled boundaries.
import assert from "node:assert/strict";
import {
  currencyBalances,
  personCurrencyRows,
  selectedPeopleByCurrency,
} from "../multi-currency-view";
import { colors } from "../colors";
import * as customerList from "../customer-list";
import * as search from "../search";
import * as digits from "../digits";
import * as money from "../money";
import {
  compileUI,
  deferred,
  flattenStyle,
  jsx,
  nodes,
  settleUI,
  uiHooks,
  type UINode,
} from "./ui-fixture";

const hooks = uiHooks();
let activeReact: any = hooks.react;
const react: any = Object.fromEntries(
  Object.keys(hooks.react).map((name) => [name, (...args: any[]) => activeReact[name](...args)]),
);
// This host fixture treats layout effects as its synchronous commit boundary.
react.useLayoutEffect = react.useEffect;
let vault = "vault-a",
  account = "account-a";
let selectedCurrency = "AFN";
let enabledCurrencies = ["AFN"];
const scopedCreditPolicies = new Map<string, Record<string, { limit: number }>>();
const currencyListeners = new Set<(code: string) => void>();
type KeyboardPayload = {
  duration: number;
  easing: string;
  endCoordinates: { height: number; screenY: number };
};
const keyboardListeners = new Map<string, Set<(payload: KeyboardPayload) => void>>();
const scheduledKeyboardLayouts: KeyboardPayload[] = [];
const changeCurrency = (code: string) => {
  selectedCurrency = code;
  for (const listener of currencyListeners) listener(code);
};
const emitKeyboard = (event: string) => {
  keyboardOpen = event.includes("Show");
  const payload = {
    duration: 280,
    easing: "keyboard",
    endCoordinates: { height: keyboardOpen ? 300 : 0, screenY: keyboardOpen ? 544 : 844 },
  };
  for (const listener of keyboardListeners.get(event) ?? []) listener(payload);
  return payload;
};
let reload: () => Promise<void> = async () => undefined;
const identityListeners = new Set<() => void>();
const people = [
  {
    id: "a",
    name: "Ahmad",
    balance: 100,
    selection_totals: { debtCount: 2, creditCount: 1, debtMinor: 15000, creditMinor: 5000 },
  },
  {
    id: "b",
    name: "Babar",
    balance: -40,
    selection_totals: { debtCount: 1, creditCount: 1, debtMinor: 1000, creditMinor: 5000 },
  },
  {
    id: "c",
    name: "Cyrus",
    balance: 30,
    selection_totals: { debtCount: 1, creditCount: 0, debtMinor: 3000, creditMinor: 0 },
  },
].map((person) => ({
  ...person,
  phone: null,
  is_settled: 0,
  last_entry_at: 1,
  last_entry_type: "debt",
  tab_pending: 0,
}));
type People = typeof people;
const storedPeople = people;
const peopleByCurrency = new Map<string, People>();
const listRequests: {
  vault: string | null;
  account: string;
  currency: string;
}[] = [];
const blockedListReads: ReturnType<typeof deferred<People>>[] = [];
const blockNextListRead = () => {
  const pending = deferred<People>();
  blockedListReads.push(pending);
  return pending;
};
const archived: { id: string; scope: { vaultId: string; accountId: string } }[] = [];
let archivePending: ReturnType<typeof deferred<void>> | null = null;
let keyboardDismissals = 0;
let keyboardOpen = false;
let nativeSearchFocused = false;
let nativeSearchBlurCalls = 0;
let searchMatchRuns = 0;
let searchSortRuns = 0;
const scrollToCalls: { ref: any; y: number; animated: boolean }[] = [];
let filterMeasurements = 0;
let deferFilterMeasurement = false;
const pendingFilterMeasurements: (() => void)[] = [];
const homeJsx: typeof jsx = (type, props, key?: string | number) => {
  if (type === "ScrollView" && props.ref && !props.ref.current)
    props.ref.current = {
      scrollTo: (options: { y: number; animated: boolean }) =>
        scrollToCalls.push({ ref: props.ref, ...options }),
    };
  if (props.ref && !props.ref.current && type === "View")
    props.ref.current = {
      measureInWindow: (callback: any) => {
        filterMeasurements++;
        const finish = () => callback(0, 0, 390, 600);
        if (deferFilterMeasurement) pendingFilterMeasurements.push(finish);
        else finish();
      },
    };
  if (props.ref && !props.ref.current && type === "Pressable")
    props.ref.current = {
      measureInWindow: (callback: any) => {
        filterMeasurements++;
        callback(260, 548, 52, 52);
      },
    };
  if (props.ref && !props.ref.current && type === "TextInput")
    props.ref.current = {
      focus: () => {
        nativeSearchFocused = true;
      },
      isFocused: () => nativeSearchFocused,
      blur: () => {
        nativeSearchFocused = false;
        nativeSearchBlurCalls++;
        keyboardOpen = false;
      },
    };
  return Object.assign(jsx(type, props), { key });
};
const noop = () => undefined;
const asyncNoop = async () => undefined;
let meshImports = 0;
let meshSnapshots = 0,
  meshSubscriptions = 0,
  meshRemovals = 0,
  meshSnapshotPeers = 3;
let meshImportPending: ReturnType<typeof deferred<any>> | null = null;
const meshListeners = new Set<(status: { activePeers: number }) => void>();
const meshCallbacks: ((status: { activePeers: number }) => void)[] = [];
const toasts: { message: string; kind: string }[] = [];
const toast = {
  push: (message: string, kind: string) => toasts.push({ message, kind }),
};
const navigations: unknown[] = [];
const router = { push: (target: unknown) => navigations.push(target), replace: noop };
const metadata = new Map<string, string>();
let extraCurrencyBalances: { currency: string; collect: number; pay: number; pending: boolean }[] =
  [];
const native = {
  ActivityIndicator: "ActivityIndicator",
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
  Image: "Image",
  RefreshControl: "RefreshControl",
  KeyboardAvoidingView: "KeyboardAvoidingView",
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1, absoluteFill: {} },
  AppState: { addEventListener: () => ({ remove: noop }) },
  BackHandler: { addEventListener: () => ({ remove: noop }) },
  Keyboard: {
    dismiss: () => {
      keyboardDismissals++;
      keyboardOpen = false;
    },
    isVisible: () => keyboardOpen,
    scheduleLayoutAnimation: (event: KeyboardPayload) => scheduledKeyboardLayouts.push(event),
    addListener: (event: string, callback: (payload: KeyboardPayload) => void) => {
      const listeners = keyboardListeners.get(event) ?? new Set();
      listeners.add(callback);
      keyboardListeners.set(event, listeners);
      return { remove: () => listeners.delete(callback) };
    },
  },
  Linking: {},
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Animated: { View: "AnimatedView" },
};
const contactQueries = compileUI("../contacts-merge", {
  "./phone-match": require("../phone-match"),
  "./digits": digits,
  "./search": search,
});
const selectionSummary = compileUI("../selection-summary", {
  "./money": money,
  "./currency-totals": require("../currency-totals"),
  "./db-tx": {
    getDb: () => assert.fail("Selection must use the displayed list, without a database read"),
  },
});
const mocks: Record<string, any> = {
  react,
  "react/jsx-runtime": { jsx: homeJsx, jsxs: homeJsx, Fragment: "Fragment" },
  "react-native": native,
  "expo-router": {
    Redirect: "Redirect",
    useRouter: () => router,
    useLocalSearchParams: () => ({}),
    useFocusEffect: (work: () => any) => react.useEffect(work, [work]),
  },
  "../lib/use-search-focus-effect": {
    useSearchFocusEffect: (work: () => any) => react.useEffect(work, [work]),
  },
  "expo-haptics": {
    selectionAsync: asyncNoop,
    impactAsync: asyncNoop,
    ImpactFeedbackStyle: { Soft: "soft" },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-blur": { BlurTargetView: "BlurTargetView" },
  "react-native-safe-area-context": {
    SafeAreaView: "SafeAreaView",
    useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
  },
  "../lib/selection-summary": selectionSummary,
  "../lib/multi-currency-view": { currencyBalances, personCurrencyRows, selectedPeopleByCurrency },
  "../lib/tabs/link-status": require("../tabs/link-status"),
  "../lib/profile-settings-context": { ProfileSettingsSource: "ProfileSettingsSheet" },
  "../components/Toast": { useToast: () => toast, useToastOffset: () => 0 },
  "../components/SearchKeyboardMotion": {
    SearchKeyboardFrame: "SearchKeyboardFrame",
    SearchKeyboardFooter: "SearchKeyboardFooter",
  },
  "../lib/app-meta-context": { useAppMeta: () => ({ forceUpdate: false }) },
  "../lib/colors": { colors },
  "../lib/contacts-merge": contactQueries,
  "../lib/search": {
    ...search,
    searchCustomerMatches: (...args: Parameters<typeof search.searchCustomerMatches>) => {
      searchMatchRuns++;
      return search.searchCustomerMatches(...args);
    },
  },
  "../lib/currency": {
    applyVaultCurrency: asyncNoop,
    getEnabledCurrencies: async () => [...enabledCurrencies],
    getCurrencyLabel: (code: string) => code,
    getCurrentCurrencySymbol: () => selectedCurrency,
    getCurrentCurrencyCode: () => selectedCurrency,
    setCurrentCurrency: changeCurrency,
    useCurrency: () => {
      const [code, setCode] = react.useState(selectedCurrency);
      react.useEffect(() => {
        currencyListeners.add(setCode);
        return () => currencyListeners.delete(setCode);
      }, []);
      return code;
    },
  },
  "../lib/auth": {
    getSessionUser: async () => ({ id: account, name: "Self" }),
    signOut: asyncNoop,
  },
  "../lib/db": {
    archivePerson: async (id: string, scope: { vaultId: string; accountId: string }) => {
      archived.push({ id, scope });
      await archivePending?.promise;
    },
    getActiveVaultArchivedAt: async () => null,
    getActiveVaultArchivedState: async () => ({ archived: false }),
    getAppMeta: async (key: string) => metadata.get(key) ?? null,
    getLocalSelf: async () => ({ id: "self", name: "Self", shop_name: vault }),
    listActiveVaults: async () => [{ id: vault, name: vault, currency: "AFN" }],
    listAllVaultsIncludingArchived: async () => [
      { id: vault, name: vault, currency: "AFN", archived: false },
    ],
    listCurrencyBalanceSummaries: async () => [
      {
        currency: selectedCurrency,
        collect: money.sumAmounts(storedPeople.filter((p) => p.balance > 0).map((p) => p.balance)),
        pay: money.sumAmounts(storedPeople.filter((p) => p.balance < 0).map((p) => -p.balance)),
        pending: false,
      },
      ...extraCurrencyBalances,
    ],
    listAllPeopleForSearch: async (requestedVault: string | null, currency = selectedCurrency) => {
      listRequests.push({ vault: requestedVault, account, currency });
      return blockedListReads.shift()?.promise ?? peopleByCurrency.get(currency) ?? storedPeople;
    },
    setAppMeta: async (key: string, value: string) => {
      metadata.set(key, value);
    },
  },
  "../lib/db-tx": {
    clearActiveVaultId: asyncNoop,
    getAccountIdSync: () => account,
    getActiveVaultId: async () => vault,
    getActiveVaultIdSyncMaybe: () => vault,
    onAccountIdentityChanged: (listener: () => void) => {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    },
    setActiveVaultId: async (next: string) => {
      vault = next;
    },
  },
  "../lib/customer-groups": {
    readCustomerGroups: async () => ({
      groups: [{ id: "g", name: "Group" }],
      groupsByPerson: { c: ["g"] },
    }),
  },
  "../lib/customer-list": {
    ...customerList,
    selectSearchCustomers: (...args: Parameters<typeof customerList.selectSearchCustomers>) => {
      if (args.length >= 5) searchSortRuns++;
      return customerList.selectSearchCustomers(...args);
    },
  },
  "../lib/credit-limits": {
    creditStatusForBalance: (policy: { limit: number } | null, balance: number) =>
      policy && balance > policy.limit ? "over" : "none",
    readCreditPoliciesForPeople: async (_vault: string, currency: string) =>
      scopedCreditPolicies.get(currency) ?? {},
    refreshCreditPolicies: asyncNoop,
  },
  "../lib/credit-policy-events": { onCreditPoliciesChanged: () => noop },
  "../lib/ledger-events": {
    useLedgerRefresh: (_vault: string, work: () => Promise<void>) => {
      reload = work;
    },
  },
  "../lib/sync/scheduler": { syncActiveVaultNow: asyncNoop },
  "../lib/tabs/sync": { syncAllTabs: asyncNoop },
  "../lib/direction": {
    useIsRTL: () => false,
    bidiIsolate: (value: string) => value,
    rowDir: () => ({ flexDirection: "row" }),
    textDir: () => ({}),
    trackingSafe: () => ({}),
  },
  "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
  "../lib/format": { formatAmount: String },
  "../lib/money": money,
  "../lib/i18n": {
    getLocale: () => "en",
    t: (key: string, params?: { count?: number }) =>
      key === "selection.contactsRemoved" ? `${params?.count} contacts removed` : key,
  },
  "../lib/tokens": { icon: {}, typography: {} },
  "../lib/use-vault-role": {
    useActiveVaultWriteCaps: () => ({ resolved: true, canCreate: true, canAmend: true }),
  },
  "../lib/battery-exemption": {},
  "../lib/mesh": {
    onShopModeStatusChange: (listener: (status: { activePeers: number }) => void) => {
      meshSubscriptions++;
      meshListeners.add(listener);
      meshCallbacks.push(listener);
      return () => {
        meshRemovals++;
        meshListeners.delete(listener);
      };
    },
    getShopModeStatus: () => {
      meshSnapshots++;
      return { activePeers: meshSnapshotPeers };
    },
  },
  "../lib/trust/backfill": { ensureChainBackfill: asyncNoop },
  "../lib/vault-api": { retryPendingVaultMaterialize: asyncNoop },
};
for (const [file, exported] of [
  ["BottomSheet", "BottomSheet"],
  ["CustomerListSheet", "CustomerListOptions"],
  ["ConfirmDialog", "ConfirmDialog"],
  ["Button", "Button"],
  ["EmptyState", "EmptyState"],
  ["InitialAvatar", "InitialAvatar"],
  ["HomeBalanceSummary", "HomeBalanceSummary"],
  ["HomeFilterPopover", "HomeFilterPopover"],
  ["NotificationInbox", "NotificationBell"],
  ["PersonRow", "PersonRow"],
  ["SelectionToolbar", "SelectionToolbar"],
  ["ProfileSettingsSheet", "ProfileSettingsSheet"],
  ["UpdateBanner", "UpdateBanner"],
  ["VaultPickerSheet", "VaultPickerSheet"],
])
  mocks[`../components/${file}`] = { [exported]: exported };
const meshMock = mocks["../lib/mesh"];
Object.defineProperty(mocks, "../lib/mesh", {
  enumerable: true,
  get: () => {
    meshImports++;
    return meshImportPending?.promise ?? meshMock;
  },
});
const Home = compileUI("../../app/index", mocks, { __DEV__: false }).default;

// Home-local list components are real; imported visual components remain opaque.
let pageHooks: { key: string | undefined; hooks: ReturnType<typeof uiHooks> } | undefined;
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand);
  if (!value?.props) return value;
  if (value.type === "HomeFilterPopover" && (!value.props.visible || !value.props.anchor))
    return null;
  if (typeof value.type === "function") {
    if (value.type.name === "HomePage") {
      // Model this page's actual keyed lifetime independently of Home's hooks.
      if (!pageHooks) pageHooks = { key: value.key, hooks: uiHooks() };
      const previousReact = activeReact;
      let page: UINode;
      try {
        activeReact = pageHooks.hooks.react;
        page = pageHooks.hooks.render(() => value.type(value.props));
      } finally {
        activeReact = previousReact;
      }
      return expand(page);
    }
    return expand(value.type(value.props));
  }
  return { ...value, props: { ...value.props, children: expand(value.props.children) } };
}
let tree: UINode;
let renderedPage: (UINode & { key?: string }) | undefined;
const render = () => {
  const screen = hooks.render(Home);
  const pages = nodes(screen).filter(
    (node) => typeof node.type === "function" && node.type.name === "HomePage",
  );
  assert.ok(pages.length <= 1, "Home mounts at most one customer page");
  renderedPage = pages[0];
  if (pageHooks && renderedPage?.key !== pageHooks.key) {
    pageHooks.hooks.unmount();
    pageHooks = undefined;
  }
  return (tree = expand(screen));
};
const flush = async () => {
  await settleUI();
  render();
  await settleUI();
  render();
};
const homeNodes = () => nodes(tree);
const resultCounts = () =>
  homeNodes().filter(
    (node) =>
      node.type === "Text" &&
      ["customers.search.result", "customers.search.results"].includes(node.props.children),
  );
const input = () =>
  homeNodes().find(
    (node) => node.type === "TextInput" && node.props.accessibilityLabel === "customers.search",
  )!;
const toolbar = () => homeNodes().find((node) => node.type === "SelectionToolbar")!;
const removalDialog = () =>
  homeNodes().find(
    (node) => node.type === "ConfirmDialog" && node.props.title === "selection.removeContactsTitle",
  )!;
const filterTrigger = () =>
  homeNodes().find((node) => node.props.accessibilityLabel === "customers.listOptions");
const openSearch = () => {
  input().props.ref.current.focus();
  input().props.onFocus();
  emitKeyboard(native.Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow");
  render();
};
const options = () => {
  if (!filterTrigger()) openSearch();
  if (!homeNodes().some((node) => node.type === "CustomerListOptions")) {
    filterTrigger()!.props.onPress();
    render();
  }
  return homeNodes().find((node) => node.type === "CustomerListOptions")!;
};
const askRemove = () => {
  toolbar().props.actions[0].onPress();
  render();
  assert.equal(removalDialog().props.visible, true);
  assert.equal(removalDialog().props.destructive, true);
  assert.equal(removalDialog().props.description, "selection.removeContactsDescription");
  assert.equal(toolbar().type, "SelectionToolbar", "Confirmation keeps the summary card mounted");
  return removalDialog().props;
};
const searchContent = () => tree;
const searchRows = () => homeNodes().filter((node) => node.type === "PersonRow");
const searchIds = () => searchRows().map((node) => node.props.person.id);
const homeRows = searchRows;
const expectBottomDock = (selecting = false) => {
  const keyboard = homeNodes().find((node) => node.type === "SearchKeyboardFrame")!;
  assert.ok(keyboard, "native continuous keyboard movement owns the Home frame");
  assert.equal(
    keyboard.props.avoidAndroidKeyboard,
    true,
    "Home opts into measured Android keyboard avoidance",
  );
  assert.equal(
    homeNodes().some((node) => node.type === "KeyboardAvoidingView"),
    false,
  );
  const surface = tree;
  const target = [surface.props.children].flat().find((node) => node?.type === "BlurTargetView")!;
  assert.ok(target, "Home provides a dedicated native blur target");
  assert.ok(nodes(target).includes(keyboard), "the blur target includes the keyboard-aware body");
  assert.ok(
    nodes(target).some((node) => node.props.accessibilityLabel === "menu.title.profile"),
    "the same target also blurs the top navigation",
  );
  assert.equal(
    nodes(keyboard).some((node) => node.type === "HomeFilterPopover"),
    false,
    "the overlay is outside keyboard avoidance and covers the full header",
  );
  assert.notEqual(
    target.props.accessible,
    true,
    "the target preserves child controls and accessibility",
  );
  assert.equal(
    nodes(target).some((node) => node.type === "HomeFilterPopover"),
    false,
    "the popup stays outside the content being blurred",
  );
  const children = [keyboard.props.children].flat().filter((node) => node?.props);
  const list = children.find((node) => nodes(node).some((child) => child.type === "ScrollView"));
  const dock = children.find((node) => nodes(node).some((child) => child.type === "TextInput"));
  assert.ok(list && dock && list !== dock, "The input is fixed outside the scrolling list");
  assert.equal(dock.type, "SearchKeyboardFooter");
  assert.equal(dock.props.closedPadding, 12);
  assert.equal(dock.props.openPadding, 8);
  assert.equal(
    flattenStyle(list.props.style).flex,
    1,
    "The list uses the space above the reserved dock",
  );
  assert.notEqual(flattenStyle(dock.props.style).position, "absolute");
  assert.equal(
    flattenStyle(dock.props.style).backgroundColor,
    colors.bgDefault,
    "the fixed controls retain their white footer surface",
  );
  assert.equal(flattenStyle(dock.props.style).paddingTop, 8);
  const searchSurface = nodes(dock).find(
    (node) =>
      node.type === "View" &&
      flattenStyle(node.props.style)?.borderWidth === 1 &&
      nodes(node).some((child) => child.type === "TextInput"),
  )!;
  assert.equal(
    flattenStyle(searchSurface.props.style).backgroundColor,
    colors.bgDefault,
    "the actual search field stays readable on the neutral canvas",
  );
  assert.ok(
    children.indexOf(dock) > children.indexOf(list),
    "Search follows the list at the bottom",
  );
  assert.equal(
    nodes(homeScroll()).some((node) => node.type === "TextInput"),
    false,
  );
  if (selecting) {
    const contents = nodes(dock);
    assert.ok(
      contents.findIndex((node) => node.type === "SelectionToolbar") <
        contents.findIndex((node) => node.type === "TextInput"),
      "Selection actions sit above search without an overlay",
    );
    assert.equal(contents.filter((node) => node.type === "TextInput").length, 1);
    assert.equal(
      contents.some((node) => node.props.accessibilityLabel === "personAdd.new"),
      false,
    );
  }
};
const rowKeys = (value: any) =>
  nodes(value)
    .filter(
      (node) =>
        node.type === "View" &&
        [node.props.children].flat().some((child) => child?.type === "PersonRow"),
    )
    .map((node) => (node as UINode & { key?: string | number }).key);
const homeScroll = () =>
  nodes(tree).find(
    (node) => node.type === "ScrollView" && node.props.ref === renderedPage!.props.scrollRef,
  )!;
const customerContentTop = () =>
  flattenStyle(
    homeNodes().find((node) => node.props.testID === "home-customer-content")!.props.style,
  ).paddingTop;
const scrollHome = (y: number) =>
  homeScroll().props.onScroll({ nativeEvent: { contentOffset: { y } } });
const homeScrollCalls = () =>
  scrollToCalls.filter((call) => call.ref === renderedPage!.props.scrollRef);
const expectPage = (active = true) => {
  assert.ok(renderedPage, "Loaded Home has one customer list");
  assert.equal(
    renderedPage.props.active,
    active,
    "The home list is interactive in its current scope",
  );
  assert.equal("direction" in renderedPage.props, false, "Home has no selected balance direction");
  assert.deepEqual(
    homeRows().map((row) => row.props.person.id),
    ["a", "b", "c"],
  );
  assert.ok(
    homeRows().every((row) => row.props.showDirection === true),
    "Mixed financial rows identify whether to collect or pay",
  );
  assert.deepEqual(rowKeys(tree), ["a", "b", "c"], "Home rows preserve customer identity");
  const summary = homeNodes().find((node) => node.type === "HomeBalanceSummary")!;
  assert.deepEqual(
    summary.props.people.map((person: any) => person.id),
    ["a", "b", "c"],
    "Cards receive the full scoped snapshot independently of the visible results",
  );
  assert.equal(
    nodes(tree).some((node) => ["Tabs", "GestureDetector"].includes(node.type)),
    false,
    "One ordinary list needs no direction tabs or swipe rail",
  );
  assert.equal(
    nodes(expand(renderedPage)).some((node) => node.type === "AnimatedView"),
    false,
    "The customer list has no page transition",
  );
};
const startFromContactMenu = () => {
  const pageKey = renderedPage?.key;
  const scrollKey = (homeScroll() as UINode & { key?: string }).key;
  const row = nodes(tree).find(
    (node) => node.type === "PersonRow" && node.props.person.id === "a",
  )!;
  assert.ok(row, "Homepage contact remains available");
  row.props.onLongPress(row.props.person);
  render();
  const menu = nodes(tree).find((node) => node.type === "BottomSheet" && node.props.visible)!;
  const select = menu.props.actions.find((action: any) => action.label === "selection.start");
  assert.ok(select, "Select is available from the contact action sheet");
  menu.props.onDismiss();
  select.onPress();
  render();
  assert.equal(
    homeNodes().find((node) => node.type === "HomeBalanceSummary")!.props.active,
    false,
    "Selecting contacts pauses automatic balance-page changes",
  );
  const topSelection = homeNodes().find((node) => node.props.testID === "home-selection-toolbar")!;
  const balances = homeNodes().find((node) => node.props.testID === "home-balance-section")!;
  const frame = homeNodes().find((node) => node.type === "SearchKeyboardFrame")!;
  const footer = homeNodes().find((node) => node.type === "SearchKeyboardFooter")!;
  assert.ok(topSelection, "Selection controls are mounted at the top");
  assert.equal(homeNodes().filter((node) => node.type === "SelectionToolbar").length, 1);
  assert.ok(
    nodes(frame).includes(topSelection),
    "The selection panel floats within the list viewport",
  );
  const selectionStyle = flattenStyle(topSelection.props.style);
  assert.equal(selectionStyle.position, "absolute");
  assert.equal(selectionStyle.overflow, "visible", "Selection shadows remain unclipped over rows");
  assert.ok(selectionStyle.zIndex > 0);
  assert.equal(selectionStyle.backgroundColor, undefined, "Only the rounded card paints a surface");
  assert.equal(topSelection.props.pointerEvents, "box-none");
  assert.equal(nodes(homeScroll()).includes(toolbar()), false, "Selection controls stay fixed");
  assert.equal(
    nodes(footer).includes(toolbar()),
    false,
    "The search footer has no selection panel",
  );
  assert.equal(flattenStyle(balances.props.style).display, "none");
  assert.equal(balances.props.pointerEvents, "none");
  assert.equal(balances.props.accessibilityElementsHidden, true);
  assert.equal(balances.props.importantForAccessibility, "no-hide-descendants");
  assert.equal(renderedPage?.key, pageKey, "Selection preserves the customer page lifetime");
  assert.equal(
    (homeScroll() as UINode & { key?: string }).key,
    scrollKey,
    "Selection preserves the scoped customer list",
  );
  topSelection.props.onLayout({ nativeEvent: { layout: { height: 224 } } });
  render();
  assert.equal(
    customerContentTop(),
    236,
    "The initial 12px gap belongs to scroll content below the measured floating panel",
  );
};
const expectSummary = (
  count: number,
  expected: {
    debtCount: number;
    creditCount: number;
    debt: number;
    credit: number;
    collect: number;
    pay: number;
    net: number;
  },
) => {
  assert.equal(toolbar().props.count, count, "Selection count updates in the same render");
  assert.deepEqual(
    toolbar().props.financialSummaries[0].summary,
    { ...expected, pending: false },
    "Every amount updates with its selected rows, without waiting for storage or effects",
  );
};
const firstSummary = {
  debtCount: 2,
  creditCount: 1,
  debt: 150,
  credit: 50,
  collect: 100,
  pay: 0,
  net: 100,
};
const pairSummary = {
  debtCount: 3,
  creditCount: 2,
  debt: 160,
  credit: 100,
  collect: 100,
  pay: 40,
  net: 60,
};

async function main() {
  render();
  await flush();
  assert.ok(searchSortRuns > 0, "Inline results are sorted on the homepage");
  expectPage();
  expectBottomDock();
  assert.equal(filterTrigger(), undefined, "Idle Home has no filter button");
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
  );
  const canvas = homeNodes().find((node) => node.props.edges?.includes("top"))!;
  assert.equal(
    flattenStyle(canvas.props.style).backgroundColor,
    colors.bgDefault,
    "the homepage keeps its white canvas",
  );
  const kaataButton = homeNodes().find(
    (node) => node.props.accessibilityLabel === "menu.title.vaultSwitcher",
  )!;
  const idleKaata = flattenStyle(kaataButton.props.style({ pressed: false }));
  const pressedKaata = flattenStyle(kaataButton.props.style({ pressed: true }));
  assert.equal(idleKaata.borderWidth, 1);
  assert.ok(idleKaata.borderRadius > 0 && idleKaata.minHeight >= 44);
  assert.equal(idleKaata.backgroundColor, colors.bgDefault);
  assert.notEqual(pressedKaata.backgroundColor, idleKaata.backgroundColor);
  assert.equal(kaataButton.props.accessibilityState.expanded, false);
  assert.ok(kaataButton.props.accessibilityValue.text.length > 0);
  const initialSummary = () => homeNodes().find((node) => node.type === "HomeBalanceSummary")!;
  assert.equal(
    nodes(homeScroll()).some((node) => node.type === "HomeBalanceSummary"),
    true,
    "The summary scrolls away with the customer list",
  );
  assert.equal(initialSummary().props.currency, "AFN");
  assert.equal(initialSummary().props.active, true, "The current idle home may advance balances");
  assert.equal(
    metadata.has("customer_home:account-a:vault-a"),
    false,
    "Home does not save defaults during load",
  );
  assert.equal(
    initialSummary().props.onCurrencyChange,
    undefined,
    "Totals have no currency view switch",
  );
  const inputRef = input().props.ref;
  const inputInstance = inputRef.current;
  const expectSameInput = () => {
    assert.equal(homeNodes().filter((node) => node.type === "TextInput").length, 1);
    assert.equal(input().props.ref, inputRef, "keyboard preparation keeps the same input ref");
    assert.equal(
      input().props.ref.current,
      inputInstance,
      "keyboard preparation retains the native input instance",
    );
  };
  const layoutsBeforePreparation = scheduledKeyboardLayouts.length;
  assert.equal(input().props.onPressIn, undefined, "iOS adds no premature layout intent");
  input().props.onPress();
  render();
  assert.equal(
    initialSummary().props.compact,
    false,
    "iOS tap leaves keyboard motion to the native frame",
  );
  input().props.onFocus();
  render();
  assert.equal(
    initialSummary().props.compact,
    false,
    "iOS focus does not run an independent keyboard animation",
  );
  expectSameInput();
  assert.equal(
    scheduledKeyboardLayouts.length,
    layoutsBeforePreparation,
    "early preparation adds no invented keyboard animation",
  );
  const showEvent = emitKeyboard("keyboardWillShow");
  assert.equal(
    scheduledKeyboardLayouts.length,
    layoutsBeforePreparation,
    "semantic will-show adds no JavaScript layout clock",
  );
  render();
  assert.equal(
    initialSummary().props.compact,
    true,
    "Opening the keyboard reserves result space below the sticky summary",
  );
  assert.equal(
    homeNodes().find((node) => node.type === "SearchKeyboardFooter")!.props.keyboardShown,
    true,
    "the footer receives semantic visibility while native progress controls its padding",
  );
  assert.ok(homeNodes().some((node) => node.props.accessibilityLabel === "common.hideKeyboard"));
  assert.equal(
    homeNodes().some((node) => node.props.accessibilityLabel === "personAdd.new"),
    false,
  );
  input().props.onBlur();
  render();
  assert.equal(
    initialSummary().props.compact,
    true,
    "blur cannot expand the dock while the native keyboard remains shown",
  );
  input().props.onFocus();
  render();
  expectSameInput();
  const hideEvent = emitKeyboard("keyboardWillHide");
  assert.equal(scheduledKeyboardLayouts.length, layoutsBeforePreparation);
  render();
  assert.equal(
    initialSummary().props.compact,
    false,
    "interactive will-hide expands even while the input remains focused",
  );
  const layoutsBeforeCancelledHide = scheduledKeyboardLayouts.length;
  emitKeyboard("keyboardDidShow");
  render();
  assert.equal(
    initialSummary().props.compact,
    true,
    "A cancelled interactive hide restores the compact layout",
  );
  assert.equal(
    scheduledKeyboardLayouts.length,
    layoutsBeforeCancelledHide,
    "Did-show reconciliation adds no second animation",
  );
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  render();
  assert.equal(
    initialSummary().props.compact,
    true,
    "explicit dismissal waits for will-hide before expanding a shown keyboard layout",
  );
  expectSameInput();
  emitKeyboard("keyboardWillHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(initialSummary().props.compact, false);
  assert.ok(homeNodes().some((node) => node.props.accessibilityLabel === "personAdd.new"));
  emitKeyboard("keyboardWillShow");
  render();
  assert.equal(
    initialSummary().props.compact,
    true,
    "a later native opening still updates semantic controls",
  );
  assert.equal(scheduledKeyboardLayouts.length, layoutsBeforePreparation);
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  emitKeyboard("keyboardWillHide");
  render();
  inputInstance.focus();
  const blurCallsBeforeOldHide = nativeSearchBlurCalls;
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(
    inputInstance.isFocused(),
    true,
    "an old did-hide preserves refocus before the new native onFocus event",
  );
  assert.equal(
    nativeSearchBlurCalls,
    blurCallsBeforeOldHide,
    "old hide completion cannot issue a blur against the newly focused input",
  );
  input().props.onFocus();
  emitKeyboard("keyboardWillShow");
  render();
  assert.equal(initialSummary().props.compact, true, "the new keyboard session remains usable");
  expectSameInput();
  inputInstance.blur();
  emitKeyboard("keyboardWillHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(initialSummary().props.compact, false);
  const closedMeasures = filterMeasurements;
  homeNodes()
    .find((node) => node.type === "SearchKeyboardFooter")!
    .props.onLayout();
  assert.equal(filterTrigger(), undefined, "Closing search removes its filter button");
  assert.equal(
    filterMeasurements,
    closedMeasures,
    "closed search does not measure filters during keyboard layout",
  );
  openSearch();
  assert.equal(filterTrigger()!.props.accessibilityState.expanded, false);
  filterTrigger()!.props.onLayout();
  assert.equal(filterMeasurements, closedMeasures, "A closed popup needs no anchor measurement");
  const beforePopupScroll = homeScrollCalls().length;
  filterTrigger()!.props.onPress();
  render();
  const popup = homeNodes().find((node) => node.type === "HomeFilterPopover")!;
  assert.ok(popup.props.visible && popup.props.anchor);
  assert.ok(
    filterMeasurements > closedMeasures,
    "opening filters measures after the committed state",
  );
  assert.equal(
    popup.props.blurTarget,
    homeNodes().find((node) => node.type === "BlurTargetView")!.props.ref,
  );
  const blurredPage = homeNodes().find((node) => node.type === "BlurTargetView")!;
  assert.equal(blurredPage.props.accessibilityElementsHidden, true);
  assert.equal(blurredPage.props.importantForAccessibility, "no-hide-descendants");
  assert.equal(popup.props.viewport.topInset, 0);
  assert.equal(initialSummary().props.active, false, "The filter popup pauses automatic balances");
  assert.equal(
    nodes(popup.props.children).find((node) => node.type === "CustomerListOptions")!.props
      .preference.sort,
    "recent",
    "Home controls expose the recent-activity default",
  );
  assert.notEqual(
    popup.props.children.type,
    "View",
    "Home adds no second filter content container",
  );
  assert.equal(
    nodes(popup.props.children).find((node) => node.type === "CustomerListOptions")!.props.embedded,
    true,
    "Home uses the popup's card rather than nesting standalone section cards",
  );
  assert.equal(popup.props.disabled, false, "the popup owns the controls' interaction gate");
  assert.equal(
    homeScrollCalls().length,
    beforePopupScroll,
    "The filter popup never scrolls or reflows the list",
  );
  popup.props.onDismiss();
  render();
  assert.equal(
    homeNodes().find((node) => node.type === "BlurTargetView")!.props.importantForAccessibility,
    "auto",
    "closing filters restores navigation and customer accessibility",
  );
  assert.equal(initialSummary().props.active, true, "Closing filters resumes eligible balances");
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
  );
  const persistedOptions = options();
  persistedOptions.props.onChange({ ...persistedOptions.props.preference, group: ["g"] });
  input().props.onChangeText("Cyrus");
  render();
  const retainedTrigger = filterTrigger()!;
  deferFilterMeasurement = true;
  homeNodes()
    .find((node) => node.type === "SearchKeyboardFooter")!
    .props.onLayout();
  assert.equal(pendingFilterMeasurements.length, 1);
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  emitKeyboard("keyboardWillHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(filterTrigger(), undefined);
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
    "Closing search also closes its open popup",
  );
  const measurementsAfterClose = filterMeasurements;
  retainedTrigger.props.onPress();
  retainedTrigger.props.onLayout();
  render();
  assert.equal(
    filterMeasurements,
    measurementsAfterClose,
    "Retained trigger and layout callbacks cannot measure while search is closed",
  );
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
  );
  openSearch();
  assert.equal(filterTrigger()!.props.accessibilityState.expanded, false);
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
    "Reopening search starts with its popup closed",
  );
  deferFilterMeasurement = false;
  pendingFilterMeasurements.shift()!();
  render();
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
    "An old native measurement cannot reopen filters in the next search session",
  );
  assert.equal(input().props.value, "Cyrus", "Closing search preserves its query");
  assert.deepEqual(
    options().props.preference.group,
    ["g"],
    "Chosen filters survive search closure",
  );
  assert.deepEqual(searchIds(), ["c"]);
  options().props.onChange(customerList.DEFAULT_CUSTOMER_LIST);
  input().props.onChangeText("");
  render();
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  render();
  deferFilterMeasurement = true;
  filterTrigger()!.props.onPress();
  render();
  assert.equal(pendingFilterMeasurements.length, 1);
  filterTrigger()!.props.onPress();
  render();
  deferFilterMeasurement = false;
  pendingFilterMeasurements.shift()!();
  render();
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
    "a delayed native measurement cannot reopen dismissed filters",
  );
  assert.equal(options().props.amountSortAvailable, true);
  options().props.onChange({ ...options().props.preference, sort: "amount_desc" });
  render();
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  const savedAmountOrder = metadata.get("customer_home:account-a:vault-a");
  const mixedCurrencyPeople = people.map((person) =>
    person.id === "a"
      ? {
          ...person,
          currency_balances: [
            { ...person, currency: "AFN" },
            { ...person, currency: "USD", balance: -100 },
          ],
        }
      : person,
  );
  peopleByCurrency.set("AFN", mixedCurrencyPeople);
  await reload();
  await flush();
  assert.equal(options().props.amountSortAvailable, false);
  assert.equal(
    options().props.preference.sort,
    "recent",
    "A saved amount order has a safe fallback",
  );
  assert.equal(
    metadata.get("customer_home:account-a:vault-a"),
    savedAmountOrder,
    "Loading another currency does not rewrite saved preferences",
  );
  const fullBookBalances = initialSummary().props.balances;
  const filterListReads = listRequests.length;
  scrollHome(240);
  const directionOptions = options();
  directionOptions.props.onChange({ ...directionOptions.props.preference, direction: "collect" });
  render();
  assert.deepEqual(searchIds(), ["a", "c"], "Collect matches a positive balance in any currency");
  assert.equal(homeScrollCalls().at(-1)!.y, 0, "Changing balance direction resets the list scroll");
  scrollHome(0); // Native scrollTo reports its new position through onScroll.
  assert.equal(resultCounts().length, 0, "A balance filter alone adds no search-result count");
  assert.deepEqual(
    initialSummary().props.balances,
    fullBookBalances,
    "Cards retain full-book totals",
  );
  options().props.onChange({ ...options().props.preference, direction: "pay" });
  render();
  assert.deepEqual(searchIds(), ["a", "b"], "A mixed-currency customer also matches To pay");
  assert.equal(
    searchRows()[0].props.person.currency_balances.length,
    2,
    "Direction filters preserve all the customer's currency balances",
  );
  assert.equal(JSON.parse(metadata.get("customer_home:account-a:vault-a")!).direction, "pay");
  input().props.onChangeText("Ahmad");
  render();
  assert.deepEqual(searchIds(), ["a"], "Search and direction filters compose");
  assert.equal(
    options().props.amountSortAvailable,
    false,
    "Search cannot enable cross-currency sorting",
  );
  input().props.onChangeText("");
  options().props.onChange({ ...options().props.preference, group: ["g"] });
  render();
  assert.deepEqual(searchIds(), []);
  assert.equal(renderedPage!.props.filtered, true);
  assert.ok(
    homeNodes().some(
      (node) => node.type === "EmptyState" && node.props.title === "customers.noResults",
    ),
    "An empty balance/group match shows filtered results rather than the new-book welcome",
  );
  const balanceChip = homeNodes().find(
    (node) => node.props.accessibilityHint === "customers.balanceFilter.clear",
  )!;
  assert.equal(balanceChip.props.accessibilityLabel, "customers.balanceFilter.pay");
  balanceChip.props.onPress();
  render();
  assert.deepEqual(searchIds(), ["c"], "Clearing direction retains the chosen group");
  assert.equal(options().props.preference.direction, "all");
  assert.equal(
    listRequests.length,
    filterListReads,
    "Direction changes need no extra storage reads",
  );
  options().props.onChange({ ...options().props.preference, group: "all", direction: "pay" });
  render();
  await reload();
  await flush();
  assert.deepEqual(searchIds(), ["a", "b"], "Reload retains this account/book's balance filter");
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "search.clearAll")!
    .props.onPress();
  render();
  assert.deepEqual(searchIds(), ["a", "b", "c"]);
  assert.deepEqual(options().props.preference, customerList.DEFAULT_CUSTOMER_LIST);
  // The popup filters the existing all-currency snapshot; it does not change
  // the default currency, top cards, or whole-contact selection/removal scope.
  const currencyRichPeople = people.map((person) => {
    const afn = { ...person, currency: "AFN" };
    if (person.id === "a")
      return {
        ...afn,
        currency_balances: [
          { ...afn, tab_id: "joined-afn", tab_closed_at: null, tab_other_joined: 1 },
          {
            ...person,
            currency: "USD",
            balance: -100,
            selection_totals: {
              currency: "USD",
              debtCount: 0,
              creditCount: 1,
              debtMinor: 0,
              creditMinor: 10000,
            },
          },
        ],
      };
    if (person.id === "c")
      return {
        ...afn,
        currency_balances: [
          afn,
          {
            ...person,
            currency: "USD",
            balance: 5,
            selection_totals: {
              currency: "USD",
              debtCount: 1,
              creditCount: 0,
              debtMinor: 500,
              creditMinor: 0,
            },
          },
        ],
      };
    return {
      ...afn,
      currency_balances: [
        afn,
        {
          ...person,
          currency: "GBP",
          balance: 0,
          selection_totals: {
            currency: "GBP",
            debtCount: 1,
            creditCount: 1,
            debtMinor: 4000,
            creditMinor: 4000,
          },
        },
      ],
    };
  });
  enabledCurrencies = ["AFN", "JPY"];
  scopedCreditPolicies.set("AFN", { c: { limit: 10 } });
  scopedCreditPolicies.set("USD", { c: { limit: 10 } });
  peopleByCurrency.set("AFN", currencyRichPeople);
  await reload();
  await flush();
  const fullCurrencyCards = initialSummary().props.balances;
  const fullCurrencyPeople = initialSummary().props.people;
  assert.deepEqual(
    [...options().props.currencies].sort(),
    ["AFN", "GBP", "JPY", "USD"],
    "choices include unused enabled and disabled historical currencies",
  );
  assert.equal(searchRows().find((row) => row.props.person.id === "c")!.props.creditStatus, "over");
  const currencyReadCount = listRequests.length;
  const currencyInputRef = input().props.ref;
  options().props.onChange({ ...options().props.preference, currency: "USD", sort: "amount_desc" });
  render();
  assert.equal(
    selectedCurrency,
    "AFN",
    "a currency filter does not change the book default/view scope",
  );
  assert.equal(input().props.ref, currencyInputRef);
  assert.deepEqual(searchIds(), ["a", "c"], "USD amount order compares only actual USD rows");
  assert.deepEqual(
    searchRows().map((row) => row.props.person.balance),
    [-100, 5],
  );
  assert.ok(
    searchRows().every(
      (row) =>
        row.props.person.currency_balances.length === 1 &&
        row.props.person.currency_balances[0].currency === "USD",
    ),
  );
  assert.equal(
    searchRows()[0].props.sharedStatus,
    "joined",
    "an AFN shared identity remains visible beside private USD amounts",
  );
  assert.equal(
    searchRows()[1].props.creditStatus,
    "none",
    "USD credit status does not inherit an AFN excess",
  );
  assert.equal(options().props.amountSortAvailable, true);
  assert.deepEqual(initialSummary().props.balances, fullCurrencyCards);
  assert.equal(
    initialSummary().props.people,
    fullCurrencyPeople,
    "top cards retain the unfiltered snapshot",
  );
  options().props.onChange({ ...options().props.preference, direction: "collect" });
  render();
  assert.deepEqual(searchIds(), ["c"], "AFN collect cannot make a USD payable match collect");
  options().props.onChange({ ...options().props.preference, direction: "pay" });
  render();
  assert.deepEqual(searchIds(), ["a"]);
  assert.equal(
    resultCounts().length,
    0,
    "currency and direction alone add no matching-query count",
  );
  options().props.onChange({ ...options().props.preference, direction: "all" });
  render();
  startFromContactMenu();
  assert.deepEqual(
    toolbar().props.financialSummaries.map((row: any) => [
      row.currency,
      row.summary.collect,
      row.summary.pay,
    ]),
    [
      ["AFN", 100, 0],
      ["USD", 0, 100],
    ],
    "selection still reports every currency on the selected whole contact",
  );
  const currencyRemoval = askRemove();
  assert.equal(
    currencyRemoval.description,
    "selection.removeContactsDescription",
    "removal remains whole-contact, not a currency-specific ledger deletion",
  );
  currencyRemoval.onCancel();
  render();
  toolbar().props.onClose();
  render();
  assert.equal(
    listRequests.length,
    currencyReadCount,
    "currency filtering and selection need no extra people read",
  );
  assert.equal(JSON.parse(metadata.get("customer_home:account-a:vault-a")!).currency, "USD");
  await reload();
  await flush();
  assert.equal(
    options().props.preference.currency,
    "USD",
    "the per-Kaata currency choice survives refresh",
  );
  options().props.onChange({
    ...options().props.preference,
    currency: ["USD", "GBP"],
    sort: "amount_asc",
  });
  render();
  assert.deepEqual(options().props.preference.currency, ["GBP", "USD"]);
  assert.equal(
    options().props.preference.sort,
    "recent",
    "selecting several currencies cannot compare unlike amounts",
  );
  assert.equal(options().props.amountSortAvailable, false);
  assert.deepEqual(new Set(searchIds()), new Set(["a", "b", "c"]));
  assert.equal(searchIds().length, 3, "customers matching several currencies appear only once");
  assert.ok(
    searchRows().every((row) =>
      row.props.person.currency_balances.every((balance: any) =>
        ["GBP", "USD"].includes(balance.currency),
      ),
    ),
  );
  assert.equal(
    searchRows().find((row) => row.props.person.id === "c")!.props.creditStatus,
    "none",
    "unselected AFN cannot contribute a credit warning",
  );
  assert.deepEqual(initialSummary().props.balances, fullCurrencyCards);
  assert.ok(
    homeNodes().some(
      (node) =>
        node.props.accessibilityHint === "customers.currencyFilter.clear" &&
        node.props.accessibilityLabel.includes("GBP") &&
        node.props.accessibilityLabel.includes("USD"),
    ),
  );
  options().props.onChange({ ...options().props.preference, direction: "collect" });
  render();
  assert.deepEqual(searchIds(), ["c"]);
  options().props.onChange({ ...options().props.preference, direction: "pay" });
  render();
  assert.deepEqual(searchIds(), ["a"]);
  options().props.onChange({ ...options().props.preference, direction: "all" });
  render();
  await reload();
  await flush();
  assert.deepEqual(
    options().props.preference.currency,
    ["GBP", "USD"],
    "several selected currencies survive refresh without becoming All",
  );
  options().props.onChange({ ...options().props.preference, currency: "USD", sort: "amount_asc" });
  render();
  assert.equal(
    options().props.amountSortAvailable,
    true,
    "returning to a single selected currency enables amount order",
  );
  assert.deepEqual(searchIds(), ["c", "a"]);
  options().props.onChange({ ...options().props.preference, direction: "collect", group: ["g"] });
  render();
  homeNodes()
    .find((node) => node.props.accessibilityHint === "customers.currencyFilter.clear")!
    .props.onPress();
  render();
  assert.equal(options().props.preference.currency, undefined);
  assert.deepEqual(options().props.preference.group, ["g"]);
  assert.equal(
    options().props.preference.direction,
    "collect",
    "clearing only currency preserves other filters",
  );
  assert.equal(options().props.amountSortAvailable, false);
  assert.equal(
    options().props.preference.sort,
    "recent",
    "All currencies safely falls back from amount order",
  );
  options().props.onChange({
    ...options().props.preference,
    currency: "JPY",
    group: "all",
    direction: "all",
  });
  render();
  assert.deepEqual(searchIds(), [], "unused enabled currency never manufactures zero balances");
  assert.ok(
    homeNodes().some(
      (node) => node.type === "EmptyState" && node.props.title === "customers.noResults",
    ),
  );
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "search.clearAll")!
    .props.onPress();
  render();
  assert.deepEqual(options().props.preference, customerList.DEFAULT_CUSTOMER_LIST);
  assert.deepEqual(initialSummary().props.balances, fullCurrencyCards);
  const unknownCreditPeople = currencyRichPeople.map((person) =>
    person.id === "c"
      ? {
          ...person,
          currency_balances: person.currency_balances.map((row) =>
            row.currency === "USD"
              ? {
                  ...row,
                  balance: 999,
                  tab_unsynced: 1,
                  tab_id: "unknown-usd",
                  tab_closed_at: null,
                  tab_other_joined: 1,
                }
              : row,
          ),
        }
      : person,
  );
  peopleByCurrency.set("AFN", unknownCreditPeople);
  await reload();
  await flush();
  options().props.onChange({ ...options().props.preference, currency: "USD" });
  render();
  const unknownCreditRow = searchRows().find((row) => row.props.person.id === "c")!;
  assert.equal(unknownCreditRow.props.person.tab_unsynced, 1);
  assert.equal(
    unknownCreditRow.props.creditStatus,
    "none",
    "an unknown shared USD balance cannot trigger a stale over-limit warning",
  );
  options().props.onChange(customerList.DEFAULT_CUSTOMER_LIST);
  render();
  enabledCurrencies = ["AFN"];
  scopedCreditPolicies.clear();
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  peopleByCurrency.delete("AFN");
  await reload();
  await flush();
  extraCurrencyBalances = [{ currency: "USD", collect: 20, pay: 0, pending: false }];
  await reload();
  await flush();
  assert.deepEqual(
    initialSummary().props.balances,
    currencyBalances(initialSummary().props.people, "AFN"),
    "Totals use the same unfiltered customer snapshot without a second set of currency reads",
  );
  assert.equal(initialSummary().props.onCurrencyChange, undefined);
  assert.equal(resultCounts().length, 0, "An empty homepage query has no matching-customer count");
  const homeKey = renderedPage!.key;
  const homeRef = renderedPage!.props.scrollRef;
  assert.equal(homeScroll().props.refreshControl, undefined);
  assert.equal(homeScroll().props.bounces, true);
  assert.equal(homeScroll().props.alwaysBounceVertical, true);
  assert.equal(homeScroll().props.overScrollMode, "always");
  assert.equal(homeScroll().props.keyboardShouldPersistTaps, "always");
  const originalScopeScroll = renderedPage!.props.onScrollOffset;
  assert.equal(renderedPage!.props.initialScrollY, 0);
  assert.deepEqual(homeScrollCalls().at(-1), { ref: homeRef, y: 0, animated: false });
  scrollHome(128);
  const beforeOrdinaryScroll = homeScrollCalls().length;
  render();
  assert.equal(
    homeScrollCalls().length,
    beforeOrdinaryScroll,
    "Ordinary layout never restores an old offset",
  );
  assert.equal(renderedPage!.props.initialScrollY, 128);
  homeRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  assert.deepEqual(
    navigations,
    [{ pathname: "/person/[id]", params: { id: "b" } }],
    "A pay contact opens directly beside collect contacts",
  );
  navigations.length = 0;
  input().props.onChangeText("   ");
  render();
  assert.equal(resultCounts().length, 0, "Whitespace has no matching-customer count");
  input().props.onChangeText("Cyrus");
  render();
  assert.deepEqual(searchIds(), ["c"]);
  assert.deepEqual(
    resultCounts().map((node) => node.props.children),
    ["customers.search.result"],
  );
  input().props.onChangeText("");
  render();
  assert.equal(resultCounts().length, 0, "Clearing the query removes its result count");
  await reload();
  await flush();
  assert.deepEqual(searchIds(), ["a", "b", "c"], "Background refresh preserves the inline results");
  assert.equal(meshImports, 0, "Closed settings never imports the mesh status module");
  assert.equal(meshSubscriptions, 0, "Closed settings owns no peer listener");
  assert.equal(meshSnapshots, 0, "Closed settings reads no peer snapshot");
  const settings = () => nodes(tree).find((node) => node.type === "ProfileSettingsSheet")!;
  const openSettings = () => {
    nodes(tree)
      .find((node) => node.props.accessibilityLabel === "menu.title.profile")!
      .props.onPress();
    render();
  };
  const closeSettings = () => {
    settings().props.onDismiss();
    render();
  };
  openSettings();
  await flush();
  assert.equal(settings().props.visible, true);
  assert.equal(meshImports, 1);
  assert.equal(meshSubscriptions, 1);
  assert.equal(meshListeners.size, 1);
  assert.equal(meshSnapshots, 1);
  assert.equal(
    settings().props.activePeers,
    3,
    "Opening settings immediately seeds current peer status",
  );
  const firstPeerCallback = meshCallbacks[0];
  firstPeerCallback({ activePeers: 9 });
  render();
  assert.equal(settings().props.activePeers, 9, "Open settings receives live peer status");
  closeSettings();
  assert.equal(settings().props.activePeers, 0);
  assert.equal(meshListeners.size, 0, "Closing settings removes its peer listener immediately");
  assert.equal(meshRemovals, 1);
  firstPeerCallback({ activePeers: 77 });
  render();
  await flush();
  assert.equal(
    settings().props.activePeers,
    0,
    "An already queued hidden-sheet callback is ignored",
  );
  assert.equal(meshImports, 1, "Closed renders do not reload the mesh module");

  const lateMesh = deferred<any>();
  meshImportPending = lateMesh;
  openSettings();
  await settleUI();
  assert.equal(meshImports, 2);
  assert.equal(meshSubscriptions, 1, "An unresolved import cannot subscribe early");
  closeSettings();
  lateMesh.resolve(meshMock);
  meshImportPending = null;
  await flush();
  assert.equal(meshSubscriptions, 1, "An import resolving after close never subscribes");
  assert.equal(meshSnapshots, 1, "An import resolving after close never reads a stale snapshot");
  assert.equal(meshListeners.size, 0);

  meshSnapshotPeers = 5;
  openSettings();
  await flush();
  assert.equal(meshImports, 3);
  assert.equal(meshSubscriptions, 2);
  assert.equal(meshSnapshots, 2);
  assert.equal(meshListeners.size, 1);
  assert.equal(
    settings().props.activePeers,
    5,
    "Reopening acquires one fresh status lease and snapshot",
  );
  firstPeerCallback({ activePeers: 88 });
  render();
  assert.equal(settings().props.activePeers, 5, "An old lease cannot overwrite reopened settings");
  meshCallbacks.at(-1)!({ activePeers: 8 });
  render();
  assert.equal(settings().props.activePeers, 8);
  closeSettings();
  assert.equal(meshListeners.size, 0);
  assert.equal(meshRemovals, 2);
  assert.equal(toolbar(), undefined);
  assert.equal(toolbar(), undefined);
  for (const row of nodes(tree).filter((node) => node.type === "PersonRow"))
    assert.ok(!row.props.selecting, "Homepage rows have no selection checkboxes");
  const initialListReads = listRequests.length;
  startFromContactMenu();
  expectBottomDock(true);
  assert.equal(
    homeNodes().some((node) => node.type === "SearchSheet"),
    false,
    "Selection stays directly on the homepage",
  );
  assert.deepEqual(searchIds(), ["a", "b", "c"], "Both money directions share one selectable list");
  assert.deepEqual(
    rowKeys(searchContent()),
    ["a", "b", "c"],
    "Search and selection retain customer-ID keys",
  );
  assert.equal(toolbar().type, "SelectionToolbar");
  expectSummary(1, firstSummary);
  searchRows()
    .find((row) => row.props.person.id === "a")!
    .props.onPress(people[0]);
  render();
  expectSummary(0, {
    debtCount: 0,
    creditCount: 0,
    debt: 0,
    credit: 0,
    collect: 0,
    pay: 0,
    net: 0,
  });
  searchRows()
    .find((row) => row.props.person.id === "a")!
    .props.onPress(people[0]);
  render();
  expectSummary(1, firstSummary);
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  expectSummary(2, pairSummary);
  assert.equal(listRequests.length, initialListReads, "Selecting a contact never reloads the list");
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  expectSummary(1, firstSummary);
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  expectSummary(2, pairSummary);
  const keyboardBeforeRemove = keyboardDismissals;
  const cancelledConfirmation = askRemove();
  assert.equal(keyboardDismissals, keyboardBeforeRemove + 1);
  cancelledConfirmation.onCancel();
  cancelledConfirmation.onConfirm();
  render();
  assert.equal(removalDialog().props.visible, false);
  assert.equal(toolbar().props.count, 2, "Cancel preserves the selected contacts");
  expectSummary(2, pairSummary);
  assert.deepEqual(archived, [], "A canceled confirmation cannot later remove contacts");
  assert.deepEqual(toasts, [], "Cancel never reports a removal");

  input().props.onChangeText("Cyrus");
  render();
  assert.deepEqual(searchIds(), ["c"]);
  assert.deepEqual(
    rowKeys(searchContent()),
    ["c"],
    "Filtering search preserves the remaining customer identity",
  );
  assert.equal(
    toolbar().props.count,
    2,
    "Searching retains selected customers hidden by the query",
  );
  assert.equal(toolbar().props.allSelected, false);
  expectSummary(2, pairSummary);
  toolbar().props.onToggleAll();
  render();
  assert.equal(toolbar().props.count, 3, "Select all adds only the visible subset");
  assert.equal(toolbar().props.allSelected, true);
  expectSummary(3, {
    debtCount: 4,
    creditCount: 2,
    debt: 190,
    credit: 100,
    collect: 130,
    pay: 40,
    net: 90,
  });
  toolbar().props.onToggleAll();
  render();
  assert.equal(
    toolbar().props.count,
    2,
    "Clear visible selection retains selections outside the query",
  );
  expectSummary(2, pairSummary);
  input().props.onChangeText("");
  render();
  options().props.onChange({ ...options().props.preference, group: ["g"] });
  render();
  assert.deepEqual(JSON.parse(metadata.get("customer_home:account-a:vault-a")!), {
    sort: "recent",
    group: ["g"],
    direction: "all",
  });
  assert.equal(
    metadata.has("customer_search:account-a:vault-a"),
    false,
    "Home filters use their own account/book preference",
  );
  assert.equal(resultCounts().length, 0, "A group filter alone does not add a query-result count");
  assert.deepEqual(searchIds(), ["c"]);
  assert.equal(toolbar().props.count, 2, "Changing groups also retains hidden selections");
  expectSummary(2, pairSummary);
  assert.equal(
    listRequests.length,
    initialListReads,
    "Toggling, select all, searching, and changing filters perform no extra database reads",
  );
  assert.equal(toolbar().type, "SelectionToolbar", "Selection actions remain on the homepage");

  // A ledger refresh updates each row and its preloaded totals as one snapshot.
  // While that read is pending, the existing snapshot remains interactive.
  const updatedPeople = people.map((person) =>
    person.id === "a"
      ? {
          ...person,
          balance: 200,
          selection_totals: { debtCount: 3, creditCount: 1, debtMinor: 25000, creditMinor: 5000 },
        }
      : person,
  );
  const backgroundRead = blockNextListRead();
  const backgroundRefresh = reload();
  await settleUI();
  render();
  expectSummary(2, pairSummary);
  input().props.onChangeText("");
  render();
  const clearOptions = options();
  clearOptions.props.onChange({ ...clearOptions.props.preference, group: [] });
  render();
  assert.equal(searchRows()[0].props.person.balance, 100);
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  expectSummary(1, firstSummary);
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  expectSummary(2, pairSummary);
  assert.equal(listRequests.length, initialListReads + 1);
  backgroundRead.resolve(updatedPeople);
  await backgroundRefresh;
  await flush();
  assert.equal(searchRows()[0].props.person.balance, 200);
  expectSummary(2, {
    debtCount: 4,
    creditCount: 2,
    debt: 260,
    credit: 100,
    collect: 200,
    pay: 40,
    net: 160,
  });

  const staleConfirmation = askRemove();
  const staleSelectionLayout = homeNodes().find(
    (node) => node.props.testID === "home-selection-toolbar",
  )!.props.onLayout;
  toolbar().props.onClose();
  staleConfirmation.onConfirm();
  render();
  assert.equal(toolbar(), undefined);
  const restoredBalances = homeNodes().find(
    (node) => node.props.testID === "home-balance-section",
  )!;
  assert.notEqual(flattenStyle(restoredBalances.props.style).display, "none");
  assert.equal(restoredBalances.props.pointerEvents, "auto");
  assert.equal(restoredBalances.props.accessibilityElementsHidden, false);
  assert.equal(customerContentTop(), 12);
  assert.equal(
    homeNodes().some((node) => node.props.testID === "home-selection-toolbar"),
    false,
  );
  const remainingFilters = homeNodes().find((node) => node.type === "HomeFilterPopover");
  if (remainingFilters) {
    assert.equal(
      initialSummary().props.active,
      false,
      "Open filters keep balances paused after selection ends",
    );
    remainingFilters.props.onDismiss();
    render();
  }
  assert.equal(initialSummary().props.active, true, "Ending selection permits balance advancement");
  assert.equal(toolbar(), undefined);
  startFromContactMenu();
  staleSelectionLayout({ nativeEvent: { layout: { height: 500 } } });
  render();
  assert.equal(
    customerContentTop(),
    236,
    "An old selection measurement cannot move a newly opened list",
  );
  staleConfirmation.onConfirm();
  assert.deepEqual(
    archived,
    [],
    "A completed selection's confirmation cannot affect a new selection",
  );
  assert.deepEqual(
    searchIds(),
    ["a", "b", "c"],
    "Starting a fresh selection uses the current inline results",
  );
  assert.equal(toolbar().props.count, 1, "Done discards the previous selection");
  expectSummary(1, {
    debtCount: 3,
    creditCount: 1,
    debt: 250,
    credit: 50,
    collect: 200,
    pay: 0,
    net: 200,
  });

  const previousVault = blockNextListRead();
  const previousVaultRefresh = reload();
  await settleUI();
  vault = "vault-b";
  render();
  assert.equal(toolbar(), undefined, "A vault switch immediately hides old selection data");
  assert.equal(
    initialSummary().props.active,
    false,
    "The old balance snapshot pauses during a vault switch",
  );
  await reload();
  await flush();
  expectPage();
  assert.equal(initialSummary().props.active, true, "A fresh vault snapshot may advance again");
  assert.notEqual(renderedPage!.key, homeKey, "A new vault remounts the scoped page");
  assert.equal(
    renderedPage!.props.initialScrollY,
    0,
    "A new vault does not inherit old scroll offsets",
  );
  assert.equal(
    homeScrollCalls().at(-1)!.y,
    0,
    "The newly scoped page restores its own initial offset",
  );
  originalScopeScroll(999);
  render();
  assert.equal(
    renderedPage!.props.initialScrollY,
    0,
    "A retained prior-scope scroll callback cannot alter the new vault",
  );
  const secondVaultPageKey = renderedPage!.key;
  startFromContactMenu();
  expectSummary(1, firstSummary);
  previousVault.resolve(updatedPeople);
  await previousVaultRefresh;
  await flush();
  expectSummary(1, firstSummary);
  assert.equal(searchRows()[0].props.person.balance, 100, "A stale vault list cannot paint");
  assert.equal(listRequests.at(-1)!.vault, "vault-b");

  const previousAccount = blockNextListRead();
  const previousAccountRefresh = reload();
  await settleUI();
  account = "account-b";
  render();
  assert.equal(toolbar() != null, false, "An account switch immediately hides old selection data");
  identityListeners.forEach((listener) => listener());
  await flush();
  expectPage();
  assert.notEqual(renderedPage!.key, secondVaultPageKey, "A new account remounts the scoped page");
  assert.equal(
    renderedPage!.props.initialScrollY,
    0,
    "A new account does not inherit old scroll offsets",
  );
  assert.equal(homeScrollCalls().at(-1)!.y, 0, "The new account restores its own initial offset");
  startFromContactMenu();
  expectSummary(1, firstSummary);
  previousAccount.resolve(updatedPeople);
  await previousAccountRefresh;
  await flush();
  expectSummary(1, firstSummary);
  assert.equal(searchRows()[0].props.person.balance, 100, "A stale account list cannot paint");
  assert.equal(listRequests.at(-1)!.account, "account-b");

  toolbar().props.onClose();
  render();
  const liveRow = homeRows()[0];
  keyboardOpen = true;
  input().props.onFocus?.();
  const navigationCount = navigations.length;
  liveRow.props.onPress(liveRow.props.person);
  assert.equal(
    navigations.length,
    navigationCount + 1,
    "A row opens immediately while the inline keyboard is focused",
  );
  assert.deepEqual(navigations.at(-1), {
    pathname: "/person/[id]",
    params: { id: liveRow.props.person.id },
  });
  assert.equal(keyboardOpen, false, "The same row tap dismisses the open keyboard");
  assert.equal(
    homeNodes().some((node) => node.type === "SearchSheet"),
    false,
  );
  input().props.onChangeText("");
  options().props.onChange({ ...options().props.preference, group: [] });
  render();
  startFromContactMenu();
  searchRows()
    .find((row) => row.props.person.id === "b")!
    .props.onPress(people[1]);
  render();
  archivePending = deferred<void>();
  const confirmation = askRemove();
  confirmation.onConfirm();
  confirmation.onConfirm();
  render();
  assert.equal(removalDialog().props.visible, false);
  assert.equal(toolbar().props.busy, true);
  assert.deepEqual(toasts, [], "Success waits for customer removal to finish");
  toolbar().props.onClose();
  confirmation.onCancel();
  render();
  assert.equal(toolbar().props.busy, true, "In-flight removal keeps the homepage selection locked");
  assert.deepEqual(
    archived,
    [{ id: "a", scope: { vaultId: "vault-b", accountId: "account-b" } }],
    "Repeated confirm starts one removal batch in the current scope",
  );
  archivePending.resolve();
  await flush();
  assert.equal(toolbar(), undefined);
  assert.deepEqual(archived, [
    { id: "a", scope: { vaultId: "vault-b", accountId: "account-b" } },
    { id: "b", scope: { vaultId: "vault-b", accountId: "account-b" } },
  ]);
  assert.deepEqual(toasts, [{ message: "2 contacts removed", kind: "success" }]);
  assert.equal(input().type, "TextInput", "Success leaves inline search available");
  render();
  // A late currency read and retained callbacks cannot cross denominations, even for the same ID.
  input().props.onChangeText("");
  options().props.onChange({ ...options().props.preference, group: "all" });
  render();
  startFromContactMenu();
  const oldCurrencyConfirmation = askRemove();
  const oldCurrencyRow = homeRows()[0];
  const oldCurrencyInput = input().props.onChangeText;
  const staleCurrencyRead = blockNextListRead();
  const staleCurrencyRefresh = reload();
  await settleUI();
  peopleByCurrency.set("USD", [
    {
      ...people[0],
      balance: 7,
      selection_totals: { debtCount: 1, creditCount: 0, debtMinor: 700, creditMinor: 0 },
    },
  ]);
  const writesBeforeCurrency = archived.length;
  const navBeforeCurrency = navigations.length;
  changeCurrency("USD");
  await flush();
  assert.equal(
    toolbar(),
    undefined,
    "Changing currency clears selection before the new snapshot paints",
  );
  assert.deepEqual(
    homeRows().map((row) => [row.props.person.id, row.props.person.balance]),
    [["a", 7]],
  );
  oldCurrencyRow.props.onPress(oldCurrencyRow.props.person);
  oldCurrencyInput("stale other-currency query");
  oldCurrencyConfirmation.onConfirm();
  render();
  assert.equal(
    navigations.length,
    navBeforeCurrency,
    "A retained AFN row cannot open a same-ID USD row",
  );
  assert.equal(archived.length, writesBeforeCurrency, "An old-currency confirmation cannot write");
  assert.equal(input().props.value, "");
  staleCurrencyRead.resolve(updatedPeople);
  await staleCurrencyRefresh;
  await flush();
  assert.equal(
    homeRows()[0].props.person.balance,
    7,
    "A late AFN load cannot replace the USD snapshot",
  );
  assert.equal(listRequests.at(-1)!.currency, "USD");
  changeCurrency("AFN");
  await flush();
  const oldRow = homeRows()[0];
  const lateRead = blockNextListRead();
  const lateRefresh = reload();
  await settleUI();
  const unmountedShow = [...keyboardListeners.get("keyboardWillShow")!][0];
  const unmountedHide = [...keyboardListeners.get("keyboardDidHide")!][0];
  hooks.unmount();
  const writesAfterCleanup = hooks.lateWrites;
  const navigationsAfterCleanup = navigations.length;
  oldRow.props.onPress(oldRow.props.person);
  oldRow.props.onLongPress(oldRow.props.person);
  const layoutsAfterCleanup = scheduledKeyboardLayouts.length;
  unmountedShow(showEvent);
  unmountedHide(hideEvent);
  assert.equal(
    scheduledKeyboardLayouts.length,
    layoutsAfterCleanup,
    "Unmounted keyboard callbacks cannot schedule animations",
  );
  lateRead.resolve(updatedPeople);
  await lateRefresh;
  assert.equal(navigations.length, navigationsAfterCleanup, "Unmounted Home rows cannot navigate");
  assert.equal(
    hooks.lateWrites,
    writesAfterCleanup,
    "Late row callbacks and reads cannot update unmounted Home",
  );
  console.log(
    "PASS home selection: one mixed list and simultaneous totals, direction labels, stable customer keys, native overscroll without pull-refresh, scoped scroll restoration, instant financial totals without per-tap reads, coherent background snapshots, stale vault/account reads, settings-only mesh leases, fixed bottom search and compact filters, query-only counts, scoped select-all, search/group preservation, confirmation, duplicate/stale guards, cleanup",
  );
}
void main();
