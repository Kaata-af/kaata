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
import { isSettledCustomer } from "../settled-customers";
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
let writeCaps = { resolved: false, canCreate: true, canAmend: true };
let archiveGuardReads = 0;
let hapticImpacts = 0;
let enabledCurrencies = ["AFN"];
let reviewPromptOptions: {
  context: { installId: string; accountId: string | null; vaultId: string | null } | null;
  ready: boolean;
} | null = null;
let reviewInteractionCancels = 0;
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
let homeToastOffset = 0;
let homeToastBottomOffset: number | undefined;
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
  "react-native-gesture-handler": {
    GestureDetector: "GestureDetector",
    Gesture: {
      Native: () => {
        const gesture = {
          kind: "native",
          shouldActivateOnStart: (_value: boolean) => gesture,
          disallowInterruption: (_value: boolean) => gesture,
        };
        return gesture;
      },
    },
  },
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
    impactAsync: async () => {
      hapticImpacts++;
    },
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
  "../components/Toast": {
    useToast: () => toast,
    useToastOffset: (bottom?: number) => {
      homeToastBottomOffset = bottom;
      return homeToastOffset;
    },
    TOAST_LIFT: 72,
  },
  "../components/SearchKeyboardMotion": {
    SearchKeyboardFrame: "SearchKeyboardFrame",
    SearchKeyboardFooter: "SearchKeyboardFooter",
  },
  "../lib/app-meta-context": { useAppMeta: () => ({ forceUpdate: false }) },
  "../lib/use-store-review-prompt": {
    useStoreReviewPrompt: (options: NonNullable<typeof reviewPromptOptions>) => {
      reviewPromptOptions = options;
      return () => reviewInteractionCancels++;
    },
  },
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
    getActiveVaultArchivedState: async () => {
      archiveGuardReads++;
      return { archived: false };
    },
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
    getInstallIdSync: () => "install",
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
  "../lib/settled-customers": { isSettledCustomer },
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
    useActiveVaultWriteCaps: () => writeCaps,
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
  ["HomeBalanceFilterSwipe", "HomeBalanceFilterSwipe"],
  ["HomeFilterPopover", "HomeFilterPopover"],
  ["NotificationInbox", "NotificationBell"],
  ["PersonRow", "PersonRow"],
  ["SelectionToolbar", "SelectionToolbar"],
  ["SettledAccountsSection", "SettledAccountsSection"],
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
  if (value.type === "SettledAccountsSection") {
    if (value.props.count <= 0) return null;
    return {
      ...value,
      props: {
        ...value.props,
        children: value.props.expanded ? expand(value.props.children) : null,
      },
    };
  }
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
const addButton = () =>
  homeNodes().find((node) => node.props.accessibilityLabel === "personAdd.new");
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
  const dockHost = children.find((node) => node.props.testID === "home-toast-dock");
  assert.ok(list && dockHost && list !== dockHost, "The input is fixed outside the scrolling list");
  assert.equal(dockHost.type, "AnimatedView");
  const dock = nodes(dockHost).find((node) => node.type === "SearchKeyboardFooter")!;
  assert.ok(dock, "Keyboard movement keeps its own footer inside the lifted dock");
  assert.equal(dock.props.closedPadding, 12);
  assert.equal(homeToastBottomOffset, 12, "Home's toast lift clears its 12px bottom spacing");
  assert.equal(dock.props.openPadding, 8);
  assert.equal(
    flattenStyle(list.props.style).flex,
    1,
    "The list uses the space above the reserved dock",
  );
  assert.notEqual(flattenStyle(dockHost.props.style).position, "absolute");
  const hostStyle = flattenStyle(dockHost.props.style);
  assert.equal(hostStyle.backgroundColor, colors.bgDefault);
  assert.equal(hostStyle.paddingBottom, 84, "The raised dock keeps an opaque background below it");
  assert.equal(hostStyle.paddingBottom + hostStyle.marginBottom, 0, "No skirt gap remains at rest");
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
    children.indexOf(dockHost) > children.indexOf(list),
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
const homeSwipe = () => homeNodes().find((node) => node.props.testID === "home-customer-content")!;
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
  assert.equal(renderedPage.props.direction, "all", "Default Home shows both balance directions");
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
    nodes(tree).some((node) => node.type === "Tabs"),
    false,
    "One ordinary list needs no direction tabs",
  );
  assert.equal(
    nodes(expand(renderedPage)).some((node) => node.type === "AnimatedView"),
    false,
    "The single customer list has no duplicate page-level animation wrapper",
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

async function settledHomeAccounts() {
  const cleared = {
    ...people[0],
    id: "settled",
    name: "Settled account",
    currency: "AFN",
    balance: 0,
    is_settled: 1,
    selection_totals: { debtCount: 1, creditCount: 1, debtMinor: 50000, creditMinor: 50000 },
  };
  const ordinaryZero = { ...people[1], id: "zero", name: "Zero account", balance: 0 };
  const pending = { ...cleared, id: "pending", name: "Pending account", tab_pending_count: 1 };
  const mixed = {
    ...cleared,
    id: "mixed",
    name: "Mixed account",
    currency_balances: [
      { ...cleared, currency: "AFN" },
      { ...cleared, currency: "USD", balance: 12, is_settled: 0 },
    ],
  };
  const fixturePeople = [...people, cleared, ordinaryZero, pending, mixed];
  const disclosure = () => homeNodes().find((node) => node.type === "SettledAccountsSection")!;
  const ids = () => searchIds().sort();
  const activeIds = ["a", "b", "c", "mixed", "pending", "zero"];
  peopleByCurrency.set("AFN", fixturePeople);
  enabledCurrencies = ["AFN", "USD"];
  await reload();
  await flush();
  assert.equal(disclosure().props.expanded, false, "Settled accounts start collapsed");
  assert.equal(disclosure().props.count, 1);
  assert.deepEqual(ids(), activeIds, "Zero, pending, and partially settled accounts stay visible");
  const completeBalances = homeNodes().find((node) => node.type === "HomeBalanceSummary")!.props;
  assert.equal(completeBalances.people.length, fixturePeople.length);
  const initialToggle = disclosure().props.onToggle;
  initialToggle();
  render();
  assert.deepEqual(ids(), [...activeIds, "settled"].sort());
  assert.deepEqual(
    homeNodes().find((node) => node.type === "HomeBalanceSummary")!.props.balances,
    completeBalances.balances,
    "Disclosure never changes the account totals",
  );
  const swipeRows = nodes(homeSwipe()).filter((node) => node.type === "PersonRow");
  assert.equal(swipeRows.at(-1)!.props.person.id, "settled", "Settled accounts follow active rows");
  disclosure().props.onToggle();
  render();

  // Currency projections must not hide an unsettled balance in another currency.
  options().props.onChange({ ...customerList.DEFAULT_CUSTOMER_LIST, currency: "AFN" });
  render();
  assert.ok(ids().includes("mixed"), "An AFN filter cannot settle a contact who still owes USD");
  assert.equal(disclosure().props.count, 1);
  options().props.onChange(customerList.DEFAULT_CUSTOMER_LIST);
  render();
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  render();

  input().props.onChangeText("Settled account");
  render();
  assert.equal(
    disclosure().props.expanded,
    true,
    "Direct search reveals matching settled accounts",
  );
  assert.deepEqual(ids(), ["settled"]);
  const oldQueryToggle = disclosure().props.onToggle;
  oldQueryToggle();
  render();
  assert.deepEqual(ids(), [], "A searched settled section can still be collapsed manually");
  assert.equal(
    homeNodes().some(
      (node) => node.type === "EmptyState" && node.props.title === "customers.noResults",
    ),
    false,
    "A collapsed match is not reported as an empty search",
  );
  input().props.onChangeText("");
  render();
  assert.equal(disclosure().props.expanded, false, "Leaving search returns to collapsed accounts");
  oldQueryToggle();
  render();
  assert.equal(
    disclosure().props.expanded,
    false,
    "A previous query's toggle cannot reopen accounts",
  );
  input().props.onChangeText("Settled account");
  render();
  oldQueryToggle();
  render();
  assert.equal(disclosure().props.expanded, true, "A reused query cannot revive its old toggle");
  input().props.onChangeText("");
  render();

  const originalAccount = account;
  const originalVault = vault;
  for (const scope of ["account", "vault"] as const) {
    disclosure().props.onToggle();
    render();
    const previousScopeToggle = disclosure().props.onToggle;
    if (scope === "account") account = "settled-other-account";
    else vault = "settled-other-vault";
    render();
    identityListeners.forEach((listener) => listener());
    await reload();
    await flush();
    assert.equal(disclosure().props.expanded, false, `A new ${scope} starts collapsed`);
    previousScopeToggle();
    render();
    assert.equal(
      disclosure().props.expanded,
      false,
      `Old ${scope} toggles cannot affect the new scope`,
    );
    account = originalAccount;
    vault = originalVault;
    render();
    identityListeners.forEach((listener) => listener());
    await reload();
    await flush();
    previousScopeToggle();
    render();
    assert.equal(
      disclosure().props.expanded,
      false,
      `Returning to a ${scope} cannot revive stale expansion`,
    );
  }

  startFromContactMenu();
  toolbar().props.onToggleAll();
  render();
  assert.equal(toolbar().props.total, activeIds.length);
  assert.equal(toolbar().props.count, activeIds.length, "Select all excludes collapsed accounts");
  assert.equal(disclosure().props.disabled, true);
  initialToggle();
  render();
  assert.equal(
    disclosure().props.expanded,
    false,
    "Retained toggles cannot change selection scope",
  );
  toolbar().props.onClose();
  render();
  disclosure().props.onToggle();
  render();
  const expandedToggle = disclosure().props.onToggle;
  startFromContactMenu();
  toolbar().props.onToggleAll();
  render();
  assert.equal(toolbar().props.total, fixturePeople.length);
  assert.equal(
    toolbar().props.count,
    fixturePeople.length,
    "Select all includes expanded accounts",
  );
  expandedToggle();
  render();
  assert.equal(disclosure().props.expanded, true, "Selection cannot hide its settled rows");
  toolbar().props.onClose();
  render();
  disclosure().props.onToggle();
  render();

  startFromContactMenu();
  peopleByCurrency.set(
    "AFN",
    fixturePeople.map((person) =>
      person.id === "a" ? { ...person, balance: 0, is_settled: 1 } : person,
    ),
  );
  await reload();
  await flush();
  assert.equal(toolbar().props.count, 1, "A remote settlement retains the selected contact");
  assert.equal(disclosure().props.expanded, true, "A newly settled selection remains visible");
  assert.ok(homeRows().some((row) => row.props.person.id === "a" && row.props.selected));
  toolbar().props.onClose();
  render();
  assert.equal(disclosure().props.expanded, false);

  peopleByCurrency.set(
    "AFN",
    fixturePeople.map((person) =>
      person.id === "settled" ? { ...person, balance: 5, is_settled: 0 } : person,
    ),
  );
  await reload();
  await flush();
  assert.equal(
    disclosure(),
    undefined,
    "No stale disclosure remains after the last settled account reopens",
  );
  assert.ok(ids().includes("settled"), "A new balance returns its contact to the main list");
  peopleByCurrency.delete("AFN");
  enabledCurrencies = ["AFN"];
  await reload();
  await flush();
  assert.deepEqual(ids(), ["a", "b", "c"]);
}

async function main() {
  render();
  await flush();
  assert.deepEqual(reviewPromptOptions?.context, {
    installId: "install",
    accountId: "account-a",
    vaultId: "vault-a",
  });
  assert.equal(reviewPromptOptions?.ready, true, "A loaded Home supplies the idle review context");
  assert.equal(typeof tree.props.onTouchStart, "function");
  tree.props.onTouchStart();
  assert.equal(reviewInteractionCancels, 1, "The review coordinator sees Home interactions");
  assert.equal(addButton(), undefined, "Cold unresolved permissions never invent a writer action");
  const searchBeforePermissions = input().props.ref;
  writeCaps = { resolved: true, canCreate: true, canAmend: true };
  render();
  const confirmedAdd = addButton()!;
  assert.ok(confirmedAdd, "Confirmed writer permissions reveal Add");
  assert.equal(confirmedAdd.props.disabled, false);
  const nativeSearchBeforeRefresh = input().props.ref.current;
  const addGeometry = (node: UINode) => {
    const style = flattenStyle(node.props.style({ pressed: false }));
    return {
      width: style.width,
      height: style.height,
      minHeight: style.minHeight,
      flexShrink: style.flexShrink,
    };
  };
  const confirmedGeometry = addGeometry(confirmedAdd);
  assert.ok(
    confirmedGeometry.width > 0 && confirmedGeometry.height > 0,
    "The existing writer button reserves real layout space",
  );
  const dockOrder = () => {
    const footer = homeNodes().find((node) => node.type === "SearchKeyboardFooter")!;
    const button = addButton()!;
    const row = nodes(footer).find(
      (node) => node.type === "View" && [node.props.children].flat().includes(button),
    )!;
    assert.ok(row, "Add and the search field keep the same layout row");
    return [row.props.children]
      .flat()
      .filter((node) => node?.props)
      .map((node) => [node.type, node.props.accessibilityLabel ?? "search-field"]);
  };
  const confirmedOrder = dockOrder();
  const guardReadsBeforeRefresh = archiveGuardReads;
  const impactsBeforeRefresh = hapticImpacts;
  const navigationsBeforeRefresh = navigations.length;
  // Native modal dismissal refocuses Home while its role is re-read.
  writeCaps = { ...writeCaps, resolved: false };
  render();
  assert.ok(addButton(), "A same-scope role refresh retains the writer button footprint");
  assert.deepEqual(
    dockOrder(),
    confirmedOrder,
    "Search does not gain and lose a sibling on sheet dismissal",
  );
  assert.deepEqual(
    addGeometry(addButton()!),
    confirmedGeometry,
    "Disabling the pending action does not change its reserved width or height",
  );
  assert.equal(input().props.ref, searchBeforePermissions);
  assert.equal(
    input().props.ref.current,
    nativeSearchBeforeRefresh,
    "The native search input is never remounted during the refresh",
  );
  assert.equal(addButton()!.props.disabled, true);
  assert.equal(addButton()!.props.accessibilityState.disabled, true);
  await confirmedAdd.props.onPress();
  await addButton()!.props.onPress();
  assert.equal(
    archiveGuardReads,
    guardReadsBeforeRefresh,
    "A retained or current disabled callback cannot query write guards",
  );
  assert.equal(
    hapticImpacts,
    impactsBeforeRefresh,
    "A pending role refresh cannot haptic-confirm a write action",
  );
  assert.equal(
    navigations.length,
    navigationsBeforeRefresh,
    "A pending role refresh cannot open Add customer",
  );
  writeCaps = { ...writeCaps, resolved: true };
  render();
  assert.deepEqual(dockOrder(), confirmedOrder);
  assert.deepEqual(addGeometry(addButton()!), confirmedGeometry);
  assert.equal(addButton()!.props.disabled, false);
  assert.equal(input().props.ref.current, nativeSearchBeforeRefresh);
  writeCaps = { resolved: true, canCreate: false, canAmend: false };
  render();
  assert.equal(addButton(), undefined, "A confirmed viewer role removes the writer action");
  writeCaps = { ...writeCaps, resolved: false };
  render();
  assert.equal(
    addButton(),
    undefined,
    "An unresolved viewer refresh never revives the old writer action",
  );
  writeCaps = { resolved: true, canCreate: true, canAmend: true };
  render();
  const originalPermissionVault = vault;
  const originalPermissionAccount = account;
  writeCaps = { ...writeCaps, resolved: false };
  vault = "vault-permission-refresh";
  render();
  assert.equal(
    addButton(),
    undefined,
    "A different live vault cannot reuse the prior vault's writer footprint",
  );
  await reload();
  await flush();
  assert.equal(
    addButton(),
    undefined,
    "Loading the new vault cannot authorize its unresolved writer action",
  );
  writeCaps = { ...writeCaps, resolved: true };
  render();
  assert.ok(addButton());
  writeCaps = { ...writeCaps, resolved: false };
  account = "account-permission-refresh";
  render();
  assert.equal(
    addButton(),
    undefined,
    "A different live account cannot reuse the prior account's writer footprint",
  );
  await reload();
  await flush();
  assert.equal(
    addButton(),
    undefined,
    "Loading the new account does not revive another account's permissions",
  );
  vault = originalPermissionVault;
  account = originalPermissionAccount;
  await reload();
  await flush();
  writeCaps = { resolved: true, canCreate: true, canAmend: true };
  render();
  assert.ok(searchSortRuns > 0, "Inline results are sorted on the homepage");
  expectPage();
  expectBottomDock();
  const toastDock = () => homeNodes().find((node) => node.props.testID === "home-toast-dock")!;
  const toastDockOffset = () => flattenStyle(toastDock().props.style).transform[0].translateY;
  const inputBeforeToast = input().props.ref.current;
  const sortRunsBeforeToast = searchSortRuns;
  const matchesBeforeToast = searchMatchRuns;
  const rowsBeforeToast = homeRows().map((row) => row.props.person);
  homeToastOffset = -72;
  render();
  assert.equal(toastDockOffset(), -72, "The toast moves Home search and Add as one dock");
  assert.ok(nodes(toastDock()).includes(input()));
  assert.ok(nodes(toastDock()).includes(addButton()!));
  assert.equal(input().props.ref.current, inputBeforeToast);
  assert.deepEqual(
    homeRows().map((row) => row.props.person),
    rowsBeforeToast,
  );
  assert.equal(searchSortRuns, sortRunsBeforeToast, "Toast motion does not rerun customer sorting");
  assert.equal(
    searchMatchRuns,
    matchesBeforeToast,
    "Toast motion does not rerun customer matching",
  );
  homeToastOffset = 0;
  render();
  assert.equal(toastDockOffset(), 0, "An empty queue restores the ordinary dock position");
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
  writeCaps = { resolved: true, canCreate: false, canAmend: false };
  render();
  assert.equal(homeSwipe().props.enabled, true, "View-only members retain list filtering");
  homeSwipe().props.onDirectionChange("collect");
  render();
  assert.equal(renderedPage!.props.direction, "collect");
  homeSwipe().props.onDirectionChange("all");
  render();
  assert.equal(
    renderedPage!.props.direction,
    "all",
    "A repeated-side swipe can clear viewer filters",
  );
  assert.equal(addButton(), undefined, "Filtering never grants write controls");
  writeCaps = { resolved: true, canCreate: true, canAmend: true };
  render();
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
    initialSummary().props.searchOpen,
    false,
    "iOS tap leaves keyboard motion to the native frame",
  );
  input().props.onFocus();
  render();
  assert.equal(
    initialSummary().props.searchOpen,
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
    initialSummary().props.searchOpen,
    true,
    "Opening the keyboard marks the summary search session open",
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
    initialSummary().props.searchOpen,
    true,
    "blur retains the search state while the native keyboard remains shown",
  );
  input().props.onFocus();
  render();
  expectSameInput();
  const hideEvent = emitKeyboard("keyboardWillHide");
  assert.equal(scheduledKeyboardLayouts.length, layoutsBeforePreparation);
  render();
  assert.equal(
    initialSummary().props.searchOpen,
    false,
    "interactive will-hide clears search state even while the input remains focused",
  );
  const layoutsBeforeCancelledHide = scheduledKeyboardLayouts.length;
  emitKeyboard("keyboardDidShow");
  render();
  assert.equal(
    initialSummary().props.searchOpen,
    true,
    "A cancelled interactive hide restores the search state",
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
    initialSummary().props.searchOpen,
    true,
    "explicit dismissal waits for will-hide before clearing the search state",
  );
  expectSameInput();
  emitKeyboard("keyboardWillHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(initialSummary().props.searchOpen, false);
  assert.ok(homeNodes().some((node) => node.props.accessibilityLabel === "personAdd.new"));
  emitKeyboard("keyboardWillShow");
  render();
  assert.equal(
    initialSummary().props.searchOpen,
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
  assert.equal(initialSummary().props.searchOpen, true, "the new keyboard session remains usable");
  expectSameInput();
  inputInstance.blur();
  emitKeyboard("keyboardWillHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(initialSummary().props.searchOpen, false);
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
  assert.ok(filterTrigger(), "Open filters retain their trigger after the keyboard hides");
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    true,
    "Hiding the keyboard leaves the filters open",
  );
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  render();
  assert.equal(filterTrigger(), undefined);
  assert.equal(
    homeNodes().some((node) => node.type === "HomeFilterPopover"),
    false,
    "Explicitly closing filters removes the idle trigger",
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
  for (const complete of pendingFilterMeasurements.splice(0)) complete();
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
  const clearFilters = () =>
    homeNodes().find((node) => node.props.accessibilityLabel === "search.clearAll");
  for (const sort of [
    "name_asc",
    "name_desc",
    "date_asc",
    "outstanding_name",
    "amount_asc",
    "amount_desc",
  ] as const) {
    options().props.onChange({ ...options().props.preference, sort });
    render();
    assert.equal(clearFilters(), undefined, "Sorting alone is not a clearable filter");
    assert.equal(renderedPage!.props.controls, null, "Sort-only lists have no empty filter gap");
    assert.equal(options().props.preference.sort, sort);
  }
  input().props.onChangeText("Cyrus");
  render();
  assert.ok(clearFilters(), "A search query is still clearable with a custom sort");
  input().props.onChangeText("  ");
  render();
  assert.equal(clearFilters(), undefined, "Whitespace does not make sort-only lists filtered");
  input().props.onChangeText("");
  options().props.onChange({ ...options().props.preference, group: ["g"] });
  render();
  const retainedClearFilters = clearFilters()!.props.onPress;
  assert.ok(clearFilters(), "Actual group filters remain clearable with a custom sort");
  options().props.onChange({ ...options().props.preference, group: "all" });
  render();
  assert.equal(clearFilters(), undefined);
  retainedClearFilters();
  render();
  assert.equal(
    options().props.preference.sort,
    "amount_desc",
    "A removed Clear control cannot reset a sort-only preference",
  );
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
  options().props.onChange({
    ...options().props.preference,
    currency: "USD",
    direction: "pay",
    sort: "name_asc",
    group: ["g"],
  });
  input().props.onChangeText("Cyrus");
  render();
  homeNodes()
    .find((node) => node.type === "HomeFilterPopover")!
    .props.onDismiss();
  render();
  homeNodes()
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  emitKeyboard(native.Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide");
  emitKeyboard("keyboardDidHide");
  render();
  assert.equal(homeSwipe().props.direction, "pay");
  assert.equal(homeSwipe().props.enabled, true);
  // The shared gesture resolves a repeated-side drag to "all" before calling Home.
  homeSwipe().props.onDirectionChange("all");
  render();
  assert.equal(renderedPage!.props.direction, "all");
  assert.equal(renderedPage!.props.directionCurrencyKey, "[]");
  assert.equal(input().props.value, "Cyrus", "Swipe reset preserves the customer query");
  assert.equal(
    JSON.parse(metadata.get("customer_home:account-a:vault-a")!).sort,
    "name_asc",
    "Swipe reset preserves a compatible sort",
  );
  assert.deepEqual(JSON.parse(metadata.get("customer_home:account-a:vault-a")!).group, ["g"]);
  assert.deepEqual(searchIds(), ["c"]);
  assert.deepEqual(initialSummary().props.balances, fullCurrencyCards);
  assert.equal(initialSummary().props.people, fullCurrencyPeople);
  homeSwipe().props.onDirectionChange("collect");
  render();
  assert.equal(renderedPage!.props.direction, "collect");
  homeSwipe().props.onDirectionChange("all");
  render();
  assert.equal(renderedPage!.props.direction, "all", "Both repeated sides restore all directions");
  assert.equal(input().props.value, "Cyrus");
  input().props.onChangeText("");
  options().props.onChange(customerList.DEFAULT_CUSTOMER_LIST);
  render();
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
  const beforeSelectionSwipe = homeSwipe().props.onDirectionChange;
  startFromContactMenu();
  const selectedCurrencyPreference = JSON.parse(metadata.get("customer_home:account-a:vault-a")!);
  beforeSelectionSwipe("all");
  render();
  assert.equal(homeSwipe().props.enabled, false);
  assert.equal(toolbar().props.count, 1, "A retained list swipe preserves contact selection");
  assert.deepEqual(
    JSON.parse(metadata.get("customer_home:account-a:vault-a")!),
    selectedCurrencyPreference,
    "Selection rejects a retained swipe that would remove its currency filter",
  );
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
  await settledHomeAccounts();
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
    "PASS home selection: one mixed list and simultaneous totals, settled accounts disclosure/search/scoped selection, full-source currency classification, direction labels, stable customer keys, native overscroll without pull-refresh, scoped scroll restoration, instant financial totals without per-tap reads, coherent background snapshots, stale vault/account reads, settings-only mesh leases, fixed bottom search and compact filters, query-only counts, scoped select-all, search/group preservation, confirmation, duplicate/stale guards, cleanup",
  );
}
void main();
