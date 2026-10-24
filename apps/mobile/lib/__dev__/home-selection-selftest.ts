// Execute the home screen, its real list/filter logic, and selection arithmetic.
// Native presentation and the ordinary list refresh are controlled boundaries.
import assert from "node:assert/strict";
import { colors } from "../colors";
import * as customerList from "../customer-list";
import * as search from "../search";
import * as digits from "../digits";
import * as money from "../money";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks, type UINode } from "./ui-fixture";

const hooks = uiHooks();
let activeReact: any = hooks.react;
const react: any = Object.fromEntries(
  Object.keys(hooks.react).map((name) => [name, (...args: any[]) => activeReact[name](...args)]),
);
// This host fixture treats layout effects as its synchronous commit boundary.
react.useLayoutEffect = react.useEffect;
let vault = "vault-a",
  account = "account-a";
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
const listRequests: {
  vault: string | null;
  account: string;
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
let searchMatchRuns = 0;
let searchSortRuns = 0;
let rowElements = 0;
const scrollToCalls: { ref: any; y: number; animated: boolean }[] = [];
let noTalliesSection: ((props: any) => UINode) | undefined;
const homeJsx: typeof jsx = (type, props, key?: string | number) => {
  if (type === "PersonRow") rowElements++;
  if (typeof type === "function" && type.name === "NoTalliesSection") noTalliesSection = type;
  if (type === "ScrollView" && props.ref && !props.ref.current)
    props.ref.current = {
      scrollTo: (options: { y: number; animated: boolean }) =>
        scrollToCalls.push({ ref: props.ref, ...options }),
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
const pan = () => {
  const chain: any = {};
  for (const name of ["activeOffsetX", "failOffsetY", "runOnJS", "onUpdate", "onEnd"])
    chain[name] = () => chain;
  return chain;
};
type Timing = {
  config: { toValue: number; duration: number; useNativeDriver: boolean; isInteraction: boolean };
  stopped: boolean;
  settled: boolean;
  finish: () => void;
  replay: () => void;
  start: (callback: (result: { finished: boolean }) => void) => void;
  stop: () => void;
};
const timings: Timing[] = [];
const native = {
  ActivityIndicator: "ActivityIndicator",
  View: "View",
  Text: "Text",
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
    },
  },
  Linking: {},
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Animated: {
    View: "AnimatedView",
    Value: class {
      constructor(public value: number) {}
      setValue(value: number) {
        this.value = value;
      }
    },
    spring: () => ({ start: noop, stop: noop }),
    timing: (value: { setValue: (value: number) => void }, config: Timing["config"]) => {
      let callback: ((result: { finished: boolean }) => void) | undefined;
      const animation: Timing = {
        config,
        stopped: false,
        settled: false,
        finish: () => {
          assert.equal(animation.settled, false, "An animation completes only once");
          animation.settled = true;
          value.setValue(config.toValue);
          callback?.({ finished: true });
        },
        // A native completion already queued before stop can arrive late.
        replay: () => callback?.({ finished: true }),
        start: (next) => {
          callback = next;
          timings.push(animation);
        },
        stop: () => {
          animation.stopped = true;
          if (animation.settled) return;
          animation.settled = true;
          callback?.({ finished: false });
        },
      };
      return animation;
    },
  },
};
const pageTransition = compileUI("../use-home-page-transition", {
  // This fixture has no native commit phase; layout effects run at its effect boundary.
  react: { ...react, useLayoutEffect: react.useEffect },
  "react-native": native,
});
const contactQueries = compileUI("../contacts-merge", {
  "./phone-match": require("../phone-match"),
  "./digits": digits,
  "./search": search,
});
const selectionSummary = compileUI("../selection-summary", {
  "./money": money,
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
  "../lib/use-home-page-transition": pageTransition,
  "expo-haptics": {
    selectionAsync: asyncNoop,
    impactAsync: asyncNoop,
    ImpactFeedbackStyle: { Soft: "soft" },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "react-native-gesture-handler": { Gesture: { Pan: pan }, GestureDetector: "GestureDetector" },
  "react-native-safe-area-context": {
    SafeAreaView: "SafeAreaView",
    useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
  },
  "../lib/native-search": { afterNativeSearchClosed: () => false },
  "../lib/selection-summary": selectionSummary,
  "../components/Toast": { useToast: () => toast, useToastOffset: () => 0 },
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
  "../lib/currency": { applyVaultCurrency: asyncNoop, getCurrentCurrencySymbol: () => "AFN" },
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
    listAllPeopleForSearch: async (requestedVault: string | null) => {
      listRequests.push({ vault: requestedVault, account });
      return blockedListReads.shift()?.promise ?? storedPeople;
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
      searchSortRuns++;
      return customerList.selectSearchCustomers(...args);
    },
  },
  "../lib/credit-limits": {
    creditStatusForBalance: () => "none",
    readCreditPoliciesForPeople: async () => ({}),
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
  ["NotificationInbox", "NotificationBell"],
  ["PersonRow", "PersonRow"],
  ["SearchFieldTrigger", "SearchFieldTrigger"],
  ["SearchSheet", "SearchSheet"],
  ["SelectionToolbar", "SelectionToolbar"],
  ["ProfileSettingsSheet", "ProfileSettingsSheet"],
  ["Tabs", "Tabs"],
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
  if (typeof value.type === "function") {
    if (value.type.name === "TabPage") {
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
    (node) => typeof node.type === "function" && node.type.name === "TabPage",
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
const sheet = () => nodes(tree).find((node) => node.type === "SearchSheet")!;
const toolbar = () => sheet().props.footer as UINode;
const askRemove = () => {
  toolbar().props.actions[0].onPress();
  render();
  assert.equal(sheet().props.confirmation.visible, true);
  assert.equal(sheet().props.confirmation.destructive, true);
  assert.equal(sheet().props.confirmation.title, "selection.removeContactsTitle");
  assert.equal(sheet().props.confirmation.description, "selection.removeContactsDescription");
  assert.equal(toolbar().type, "SelectionToolbar", "Confirmation keeps the summary card mounted");
  return sheet().props.confirmation;
};
const searchContent = () =>
  expand(
    typeof sheet().props.children === "function"
      ? sheet().props.children(160)
      : sheet().props.children,
  );
const searchRows = () => nodes(searchContent()).filter((node) => node.type === "PersonRow");
const searchIds = () => searchRows().map((node) => node.props.person.id);
const outsideSheet = (node: any): UINode[] =>
  Array.isArray(node)
    ? node.flatMap(outsideSheet)
    : !node?.props || node.type === "SearchSheet"
      ? []
      : [node, ...outsideSheet(node.props.children)];
const homeRows = () => outsideSheet(tree).filter((node) => node.type === "PersonRow");
const rowKeys = (value: any) =>
  nodes(value)
    .filter(
      (node) =>
        node.type === "View" &&
        [node.props.children].flat().some((child) => child?.type === "PersonRow"),
    )
    .map((node) => (node as UINode & { key?: string | number }).key);
const homeScroll = () =>
  outsideSheet(tree).find(
    (node) => node.type === "ScrollView" && node.props.ref === renderedPage!.props.scrollRef,
  )!;
const scrollHome = (y: number) =>
  homeScroll().props.onScroll({ nativeEvent: { contentOffset: { y } } });
const homeScrollCalls = () =>
  scrollToCalls.filter((call) => call.ref === renderedPage!.props.scrollRef);
const expectPage = (direction: "collect" | "pay", active = true) => {
  assert.ok(renderedPage, "Loaded Home has one customer page");
  assert.equal(renderedPage.props.direction, direction);
  assert.equal(renderedPage.props.active, active, "Rows are interactive only after the transition");
  assert.deepEqual(
    homeRows().map((row) => row.props.person.id),
    direction === "collect" ? ["a", "c"] : ["b"],
  );
  const text = outsideSheet(tree)
    .filter((node) => node.type === "Text")
    .map((node) => node.props.children);
  assert.ok(
    text.includes(`home.total.label.${direction}`),
    "The hero belongs to the rendered side",
  );
  assert.ok(
    text.includes(direction === "collect" ? "130" : "40"),
    "The hero shows that side's total",
  );
};
const changeTab = (direction: "collect" | "pay") => {
  nodes(tree)
    .find((node) => node.type === "Tabs")!
    .props.onChange(direction);
  render();
};
const latestTiming = (duration: number) => {
  const timing = timings.at(-1)!;
  assert.ok(timing && !timing.settled, "A requested transition waits for native completion");
  assert.equal(timing.config.duration, duration);
  assert.equal(timing.config.useNativeDriver, true);
  assert.equal(timing.config.isInteraction, false);
  return timing;
};
const finishSwitch = () => {
  latestTiming(100).finish();
  render();
  latestTiming(160).finish();
  render();
};
const startFromContactMenu = () => {
  const row = outsideSheet(tree).find(
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
    toolbar().props.financialSummary,
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
  assert.equal(searchMatchRuns, 0, "Startup does not match customers for closed search");
  assert.equal(searchSortRuns, 0, "Startup does not sort customers for closed search");
  expectPage("collect");
  assert.equal(timings.length, 0, "The first page is visible without an animation");
  const collectKey = renderedPage!.key;
  const collectRef = renderedPage!.props.scrollRef;
  const originalScopeScroll = renderedPage!.props.onScrollOffset;
  assert.equal(renderedPage!.props.initialScrollY, 0);
  assert.deepEqual(rowKeys(tree), [0, 1], "Idle financial rows use stable native slot keys");
  assert.deepEqual(homeScrollCalls().at(-1), { ref: collectRef, y: 0, animated: false });
  scrollHome(128);
  const beforeOrdinaryScroll = homeScrollCalls().length;
  homeScroll().props.onContentSizeChange(390, 1200);
  render();
  assert.equal(
    homeScrollCalls().length,
    beforeOrdinaryScroll,
    "Active layout or ordinary updates never restore an old offset",
  );
  assert.equal(renderedPage!.props.initialScrollY, 128);
  const collectRow = homeRows()[0];
  const initialRowElements = rowElements;
  changeTab("pay");
  expectPage("collect", false);
  assert.equal(homeScroll().props.scrollEnabled, false);
  scrollHome(999);
  render();
  assert.equal(
    renderedPage!.props.initialScrollY,
    128,
    "Outgoing native scroll events do not overwrite saved offsets",
  );
  assert.equal(
    rowElements,
    initialRowElements,
    "The target rows are not built before the exit finishes",
  );
  collectRow.props.onPress(people[0]);
  assert.deepEqual(navigations, [], "The outgoing page cannot open a customer while switching");
  latestTiming(100).finish();
  render();
  expectPage("pay", false);
  assert.equal(renderedPage!.key, collectKey, "Changing sides preserves the same page instance");
  assert.equal(
    renderedPage!.props.scrollRef,
    collectRef,
    "Both sides share one native ScrollView ref",
  );
  assert.deepEqual(rowKeys(tree), [0], "Incoming idle rows reuse the first native slot");
  assert.deepEqual(homeScrollCalls().at(-1), { ref: collectRef, y: 0, animated: false });
  const beforePayLayout = homeScrollCalls().length;
  homeScroll().props.onContentSizeChange(390, 1800);
  assert.equal(
    homeScrollCalls().length,
    beforePayLayout + 1,
    "An inactive native layout repeats destination restoration",
  );
  assert.deepEqual(homeScrollCalls().at(-1), { ref: collectRef, y: 0, animated: false });
  assert.equal(
    renderedPage!.props.initialScrollY,
    0,
    "A new side does not inherit the other side's offset",
  );
  assert.equal(
    rowElements,
    initialRowElements + 1,
    "Only the incoming side's rows are built after exit",
  );
  latestTiming(160).finish();
  render();
  expectPage("pay");
  assert.equal(homeScroll().props.scrollEnabled, true);
  scrollHome(240);
  collectRow.props.onPress(people[0]);
  assert.deepEqual(
    navigations,
    [],
    "A retained row callback cannot open the previous side's customer",
  );
  homeRows()[0].props.onPress(people[1]);
  assert.deepEqual(navigations, [{ pathname: "/person/[id]", params: { id: "b" } }]);
  changeTab("collect");
  latestTiming(100).finish();
  render();
  expectPage("collect", false);
  homeScroll().props.onContentSizeChange(390, 3000);
  assert.deepEqual(
    homeScrollCalls().at(-1),
    { ref: collectRef, y: 128, animated: false },
    "A longer incoming layout restores its saved offset before becoming interactive",
  );
  latestTiming(160).finish();
  render();
  expectPage("collect");
  assert.equal(renderedPage!.key, collectKey);
  assert.equal(renderedPage!.props.scrollRef, collectRef);
  assert.deepEqual(homeScrollCalls().at(-1), { ref: collectRef, y: 128, animated: false });
  assert.equal(
    renderedPage!.props.initialScrollY,
    128,
    "Returning to Collect restores its own offset",
  );
  changeTab("pay");
  finishSwitch();
  expectPage("pay");
  assert.equal(renderedPage!.props.initialScrollY, 240, "Pay also restores its own offset");
  assert.deepEqual(homeScrollCalls().at(-1), { ref: collectRef, y: 240, animated: false });
  changeTab("collect");
  finishSwitch();
  const beforeSupersededRows = rowElements;
  changeTab("pay");
  const supersededExit = latestTiming(100);
  changeTab("collect");
  assert.equal(supersededExit.stopped, true);
  expectPage("collect");
  supersededExit.replay();
  render();
  expectPage("collect");
  assert.equal(
    rowElements,
    beforeSupersededRows,
    "A canceled transition never builds the superseded side",
  );
  const beforeSameTab = timings.length;
  changeTab("collect");
  assert.equal(timings.length, beforeSameTab, "Tapping the current tab starts no animation");
  assert.ok(noTalliesSection);
  const neutral = expand(
    jsx(noTalliesSection, {
      ...renderedPage!.props,
      people: [
        { ...people[0], id: "neutral", balance: 0, last_entry_at: null, last_entry_type: null },
      ],
    }),
  );
  assert.deepEqual(rowKeys(neutral), ["neutral"], "Neutral contacts retain customer-ID keys");
  await reload();
  await flush();
  assert.equal(searchMatchRuns, 0, "Closed-search background refresh does not match customers");
  assert.equal(searchSortRuns, 0, "Closed-search background refresh does not sort customers");
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
  assert.equal(sheet().props.visible, false);
  assert.equal(
    outsideSheet(tree).some((node) => node.type === "SelectionToolbar"),
    false,
  );
  for (const row of outsideSheet(tree).filter((node) => node.type === "PersonRow"))
    assert.ok(!row.props.selecting, "Homepage rows have no selection checkboxes");
  const initialListReads = listRequests.length;
  startFromContactMenu();
  assert.ok(searchMatchRuns > 0, "Opening search computes current customer matches");
  assert.ok(searchSortRuns > 0, "Opening search applies its current sort and filters");
  assert.equal(sheet().props.visible, true);
  assert.equal(
    sheet().props.autoFocus,
    false,
    "Select opens the search sheet without bringing up the keyboard",
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
  assert.equal(sheet().props.confirmation.visible, false);
  assert.equal(toolbar().props.count, 2, "Cancel preserves the selected contacts");
  expectSummary(2, pairSummary);
  assert.deepEqual(archived, [], "A canceled confirmation cannot later remove contacts");
  assert.deepEqual(toasts, [], "Cancel never reports a removal");

  sheet().props.onChangeQuery("Cyrus");
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
  sheet().props.onChangeQuery("");
  render();
  const options = nodes(sheet().props.filters).find((node) => node.type === "CustomerListOptions")!;
  options.props.onChange({ ...options.props.preference, group: ["g"] });
  render();
  assert.deepEqual(searchIds(), ["c"]);
  assert.equal(toolbar().props.count, 2, "Changing groups also retains hidden selections");
  expectSummary(2, pairSummary);
  assert.equal(
    listRequests.length,
    initialListReads,
    "Toggling, select all, searching, and changing filters perform no extra database reads",
  );
  assert.equal(
    outsideSheet(tree).some((node) => node.type === "SelectionToolbar"),
    false,
    "The toolbar only lives in the sheet footer",
  );

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
  render();
  expectSummary(2, pairSummary);
  sheet().props.onChangeQuery("");
  render();
  const clearOptions = nodes(sheet().props.filters).find(
    (node) => node.type === "CustomerListOptions",
  )!;
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
  sheet().props.onDismiss();
  staleConfirmation.onConfirm();
  render();
  assert.equal(sheet().props.visible, false);
  assert.equal(sheet().props.footer, undefined);
  startFromContactMenu();
  staleConfirmation.onConfirm();
  assert.deepEqual(archived, [], "A closed sheet's confirmation cannot affect a new selection");
  assert.deepEqual(searchIds(), ["a", "b", "c"], "Starting a fresh selection clears old filters");
  assert.equal(toolbar().props.count, 1, "Dismissal discards the previous selection");
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
  vault = "vault-b";
  render();
  assert.equal(sheet().props.visible, false, "A vault switch immediately hides old selection data");
  await reload();
  await flush();
  expectPage("collect");
  assert.notEqual(renderedPage!.key, collectKey, "A new vault remounts the scoped page");
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
  account = "account-b";
  render();
  assert.equal(
    sheet().props.visible,
    false,
    "An account switch immediately hides old selection data",
  );
  identityListeners.forEach((listener) => listener());
  await flush();
  expectPage("collect");
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

  sheet().props.onDismiss();
  render();
  changeTab("pay");
  const beforeSearchExit = latestTiming(100);
  const trigger = outsideSheet(tree).find((node) => node.type === "SearchFieldTrigger")!;
  trigger.props.onPress();
  render();
  assert.equal(beforeSearchExit.stopped, true, "Opening search cancels the pending page animation");
  const beforeLateSearchPage = renderedPage!.key;
  const beforeLateSearchTimings = timings.length;
  beforeSearchExit.replay();
  render();
  assert.equal(
    renderedPage!.key,
    beforeLateSearchPage,
    "A stale transition cannot replace the page behind search",
  );
  assert.equal(
    timings.length,
    beforeLateSearchTimings,
    "A stale transition cannot animate behind search",
  );
  assert.equal(sheet().props.visible, true);
  assert.equal(sheet().props.autoFocus, true, "Ordinary search still focuses its input");
  assert.equal(sheet().props.footer, null, "Ordinary search starts outside selection mode");
  sheet().props.onDismiss();
  render();
  expectPage("pay");
  changeTab("collect");
  finishSwitch();
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
  assert.equal(sheet().props.confirmation.visible, false);
  assert.equal(toolbar().props.busy, true);
  assert.deepEqual(toasts, [], "Success waits for customer removal to finish");
  sheet().props.onDismiss();
  confirmation.onCancel();
  render();
  assert.equal(sheet().props.visible, true, "Removal keeps its sheet available until it finishes");
  assert.deepEqual(
    archived,
    [{ id: "a", scope: { vaultId: "vault-b", accountId: "account-b" } }],
    "Repeated confirm starts one removal batch in the current scope",
  );
  archivePending.resolve();
  await flush();
  assert.equal(sheet().props.footer, null);
  assert.deepEqual(archived, [
    { id: "a", scope: { vaultId: "vault-b", accountId: "account-b" } },
    { id: "b", scope: { vaultId: "vault-b", accountId: "account-b" } },
  ]);
  assert.deepEqual(toasts, [{ message: "2 contacts removed", kind: "success" }]);
  assert.equal(sheet().props.visible, true, "Success is visible while search stays open");
  sheet().props.onDismiss();
  render();
  changeTab("pay");
  const beforeUnmountExit = latestTiming(100);
  hooks.unmount();
  assert.equal(beforeUnmountExit.stopped, true);
  const writesAfterCleanup = hooks.lateWrites;
  beforeUnmountExit.replay();
  assert.equal(
    hooks.lateWrites,
    writesAfterCleanup,
    "A late native completion cannot update unmounted Home",
  );
  console.log(
    "PASS home selection: stable single page/native slots, deferred rendering, canceled/stale transitions, scoped side scroll restoration, search/neutral ID keys, instant financial totals without per-tap reads, coherent background snapshots, stale vault/account reads, settings-only mesh leases, shared sheet, scoped select-all, search/group preservation, modal confirmation, duplicate/stale guards, dismissal",
  );
}
void main();
