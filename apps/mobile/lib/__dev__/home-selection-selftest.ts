// Execute the home screen, its real list/filter logic, and selection arithmetic.
// Native presentation and the ordinary list refresh are controlled boundaries.
import assert from "node:assert/strict";
import { colors } from "../colors";
import * as customerList from "../customer-list";
import * as search from "../search";
import * as digits from "../digits";
import * as money from "../money";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks, type UINode } from "./ui-fixture";

const hooks = uiHooks();
const react = { ...hooks.react, useLayoutEffect: hooks.react.useEffect,
  createContext(initial: any) {
    const context: any = { _fixtureValue: initial };
    context.Provider = { _fixtureContext: context };
    return context;
  },
  useContext: (context: any) => context._fixtureValue,
  memo: (component: any) => component,
};
let nativeClock = 1000;
let nextHomeFrame = 0;
const homeFrames = new Map<number, () => void>();
const homeFrameGlobals = {
  requestAnimationFrame: (work: () => void) => {
    const id = ++nextHomeFrame;
    homeFrames.set(id, work);
    return id;
  },
  cancelAnimationFrame: (id: number) => homeFrames.delete(id),
};
const flushHomeFrame = () => {
  const current = [...homeFrames.values()];
  homeFrames.clear();
  nativeClock += 16;
  current.forEach((work) => work());
};
let nativeMaxY = Infinity, nativeY = 0;
const scrollCommands: { x: number; y: number; animated: boolean }[] = [];
const nativeScroll = {
  scrollTo: (command: { x: number; y: number; animated: boolean }) => {
    scrollCommands.push({ ...command });
    nativeY = Math.min(nativeMaxY, Math.max(0, command.y));
  },
};
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
const router = { push: noop, replace: noop };
const metadata = new Map<string, string>();
let queueSwipeCommit = false;
const swipeCommits: (() => void)[] = [];
let swipeHandoffs = 0;
const homeImpactHaptics: string[] = [];
const swipeSharedValues: { value: any; writes: any[] }[] = [];
const homeTimings: { target: number; duration: number; reduceMotion: string }[] = [];
let reducedHomeMotion = false;
const swipeReactions = new Set<() => void>();
const flushSwipeReactions = () => swipeReactions.forEach((run) => run());
const animatedReaction = (hookReact: typeof react) =>
  (prepare: () => unknown, respond: (value: any, previous: any) => void) => {
    const latest = hookReact.useRef({ prepare, respond, previous: undefined as unknown, initialized: false });
    latest.current.prepare = prepare;
    latest.current.respond = respond;
    hookReact.useEffect(() => {
      const run = () => {
        const state = latest.current;
        const value = state.prepare();
        if (state.initialized && Object.is(value, state.previous)) return;
        const previous = state.initialized ? state.previous : null;
        state.previous = value;
        state.initialized = true;
        state.respond(value, previous);
      };
      swipeReactions.add(run);
      run();
      return () => { swipeReactions.delete(run); };
    }, []);
  };
let homeOwnerFocused = true;
const pan = () => {
  const chain: any = { config: {}, callbacks: {} };
  for (const name of ["enabled", "maxPointers", "activeOffsetX", "failOffsetY", "hitSlop"])
    chain[name] = (value: unknown) => { chain.config[name] = value; return chain; };
  chain.withRef = (ref: { current: unknown }) => { ref.current = chain; return chain; };
  for (const name of ["onTouchesDown", "onTouchesMove", "onStart", "onUpdate", "onEnd", "onFinalize"])
    chain[name] = (work: unknown) => { chain.callbacks[name] = work; return chain; };
  return chain;
};
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
  Platform: { OS: "android" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Animated: {
    View: "AnimatedView",
    Value: class {
      constructor(_value: number) {}
      setValue(_value: number) {}
    },
    spring: () => ({ start: noop, stop: noop }),
  },
};
const contactQueries = compileUI("../contacts-merge", {
  "./contacts-sync": { phoneKey: (value: string) => value },
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
  "react/jsx-runtime": {
    jsx: (type: any, props: Record<string, any>, key?: string) => ({ ...jsx(type, props), key }),
    jsxs: (type: any, props: Record<string, any>, key?: string) => ({ ...jsx(type, props), key }),
    Fragment: "Fragment",
  },
  "react-native": native,
  "expo-router": {
    Redirect: "Redirect",
    useRouter: () => router,
    useLocalSearchParams: () => ({}),
    useFocusEffect: (work: () => any) => react.useEffect(work, [work]),
  },
  "../lib/use-search-focus-effect": {
    useSearchFocusEffect: (work: () => any) => react.useEffect(
      () => homeOwnerFocused ? work() : undefined, [work, homeOwnerFocused],
    ),
  },
  "expo-haptics": {
    selectionAsync: asyncNoop,
    impactAsync: async (style: string) => { homeImpactHaptics.push(style); },
    ImpactFeedbackStyle: { Soft: "soft" },
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "react-native-gesture-handler": {
    Gesture: { Pan: pan }, GestureDetector: "GestureDetector",
    ScrollView: "ScrollView", RefreshControl: "RefreshControl",
    createNativeWrapper: (component: unknown) => component,
  },
  "react-native-reanimated": {
    __esModule: true,
    default: { View: "HomeAnimatedBody", ScrollView: "ScrollView", createAnimatedComponent: (component: unknown) => component },
    useSharedValue: (value: unknown) => {
      const slot = react.useRef(null);
      if (!slot.current) {
        let current = value;
        slot.current = { get value() { return current; }, set value(next: unknown) {
          current = next; slot.current.writes.push(next);
        }, writes: [] };
      }
      const shared = slot.current;
      if (!swipeSharedValues.includes(shared)) swipeSharedValues.push(shared);
      return shared;
    },
    useAnimatedReaction: animatedReaction(react),
    useEvent: (worklet: unknown, eventNames: string[]) => react.useRef({ workletEventHandler: { worklet, eventNames } }).current,
    useAnimatedStyle: (read: () => unknown) => Object.assign(react.useRef({}).current, read()),
    withTiming: (target: number, config: { duration: number; reduceMotion: string }) => {
      homeTimings.push({ target, ...config });
      return target;
    },
    ReduceMotion: { System: "system" },
    withSpring: (target: number) => target,
    cancelAnimation: noop,
  },
  "react-native-worklets": {
    scheduleOnUI: (work: () => void) => work(),
    scheduleOnRN: (work: (...args: any[]) => void, ...args: any[]) => {
      swipeHandoffs++;
      if (queueSwipeCommit) swipeCommits.push(() => work(...args));
      else work(...args);
    },
  },
  "react-native-safe-area-context": {
    SafeAreaView: "SafeAreaView",
    useSafeAreaInsets: () => ({ bottom: 0, top: 0 }),
  },
  "../lib/native-search": { afterNativeSearchClosed: () => false },
  "../lib/selection-summary": selectionSummary,
  "../components/Toast": { useToast: () => toast, useToastOffset: () => 0 },
  "../lib/app-meta-context": { useAppMeta: () => ({ forceUpdate: false }) },
  "../components/SheetBackdrop": { useSheetMotionPreference: () => reducedHomeMotion },
  "../lib/colors": { colors },
  "../lib/contacts-merge": contactQueries,
  "../lib/search": search,
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
  "../lib/customer-list": customerList,
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
const Home = compileUI("../../app/index", mocks, {
  __DEV__: false,
  performance: { now: () => nativeClock },
  ...homeFrameGlobals,
}).default;

// Home-local list components are real; imported visual components remain opaque.
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand);
  if (!value?.props) return value;
  const fixtureContext = value.type?._fixtureContext;
  if (fixtureContext) {
    const previous = fixtureContext._fixtureValue;
    fixtureContext._fixtureValue = value.props.value;
    try { return expand(value.props.children); }
    finally { fixtureContext._fixtureValue = previous; }
  }
  if (typeof value.type === "function") return expand(value.type(value.props));
  return { ...value, props: { ...value.props, children: expand(value.props.children) } };
}
let tree: UINode;
const render = () => {
  tree = expand(hooks.render(Home));
  flushSwipeReactions();
  for (const node of nodes(tree)) {
    if (node.type === "ScrollView" && node.props.ref) node.props.ref.current = nativeScroll;
  }
  return tree;
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
const searchRows = () =>
  nodes(
    expand(
      typeof sheet().props.children === "function"
        ? sheet().props.children(160)
        : sheet().props.children,
    ),
  ).filter((node) => node.type === "PersonRow");
const searchIds = () => searchRows().map((node) => node.props.person.id);
const cachedHidden = (node: UINode) => {
  const style = flattenStyle(node.props.style);
  return style?.position === "absolute" && style.opacity === 0
    && style.left === 0 && style.right === 0 && style.top === 0;
};
const cachedBoundaryFor = (value: any, id: string, boundary: UINode | null = null): UINode | null => {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = cachedBoundaryFor(child, id, boundary);
      if (found) return found;
    }
    return null;
  }
  if (!value?.props || value.type === "SearchSheet") return null;
  const current = cachedHidden(value) ? value : boundary;
  if (value.type === "PersonRow" && value.props.person.id === id) return current;
  return cachedBoundaryFor(value.props.children, id, current);
};
const outsideSheet = (node: any, includeHidden = false): UINode[] =>
  Array.isArray(node)
    ? node.flatMap((child) => outsideSheet(child, includeHidden))
    : !node?.props || node.type === "SearchSheet" ||
        (!includeHidden && (flattenStyle(node.props.style)?.display === "none" || cachedHidden(node)))
      ? []
      : [node, ...outsideSheet(node.props.children, includeHidden)];
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
  assert.equal(meshImports, 0, "Closed settings never imports the mesh status module");
  assert.equal(meshSubscriptions, 0, "Closed settings owns no peer listener");
  assert.equal(meshSnapshots, 0, "Closed settings reads no peer snapshot");
  const settings = () => nodes(tree).find((node) => node.type === "ProfileSettingsSheet")!;
  const openSettings = () => {
    nodes(tree).find((node) => node.props.accessibilityLabel === "menu.title.profile")!.props.onPress();
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
  assert.equal(settings().props.activePeers, 3, "Opening settings immediately seeds current peer status");
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
  assert.equal(settings().props.activePeers, 0, "An already queued hidden-sheet callback is ignored");
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
  assert.equal(settings().props.activePeers, 5, "Reopening acquires one fresh status lease and snapshot");
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
  const homeRows = () => outsideSheet(tree).filter((node) => node.type === "PersonRow");
  const retainedRows = () => outsideSheet(tree, true).filter((node) => node.type === "PersonRow");
  const retainedKeys = () => outsideSheet(tree, true)
    .filter((node) => node.type === "View" && ["a", "b", "c"].includes((node as any).key))
    .map((node) => (node as any).key).sort();
  const homeScroll = () => {
    const scrolls = outsideSheet(tree).filter((node) => node.type === "ScrollView");
    assert.equal(scrolls.length, 1, "One native Home scroll view owns both money directions");
    return scrolls[0];
  };
  const changeTab = (side: "collect" | "pay") => {
    nativeClock += 10;
    nodes(tree).find((node) => node.type === "Tabs")!.props.onChange(side);
    render();
  };
  const scrollEvent = (y: number, timestamp = ++nativeClock) => ({
    nativeEvent: { contentOffset: { x: 0, y }, timestamp },
  });
  const expectCommand = (y: number, work: () => void, message: string) => {
    const before = scrollCommands.length;
    work();
    assert.equal(scrollCommands.length, before + 1, message);
    assert.deepEqual(scrollCommands.at(-1), { x: 0, y, animated: false }, message);
  };
  const beginDrag = (scroll: UINode, y: number) => scroll.props.onScrollBeginDrag(scrollEvent(y));
  const swipeGesture = () => nodes(tree).find((node) => node.type === "GestureDetector")!.props.gesture;
  const swipe = (dx: number, dy = 0, options: { hold?: number; duration?: number; success?: boolean; pointers?: number; velocityX?: number;
    earlyMove?: { dx: number; dy?: number; at: number } } = {}) => {
    const gesture = swipeGesture();
    assert.equal(gesture.config.enabled, true);
    let failures = 0;
    const manager = { fail: () => failures++ };
    gesture.callbacks.onTouchesDown({ numberOfTouches: 1, allTouches: [{ absoluteX: 200, absoluteY: 300 }] }, manager);
    if (options.earlyMove) {
      nativeClock += options.earlyMove.at;
      gesture.callbacks.onTouchesMove({ numberOfTouches: 1,
        allTouches: [{ absoluteX: 200 + options.earlyMove.dx, absoluteY: 300 + (options.earlyMove.dy ?? 0) }] }, manager);
    }
    nativeClock += (options.hold ?? 20) - (options.earlyMove?.at ?? 0);
    const move = { numberOfTouches: options.pointers ?? 1, allTouches: [{ absoluteX: 200 + dx, absoluteY: 300 + dy }] };
    gesture.callbacks.onTouchesMove(move, manager);
    const beforePreviewSide = nodes(tree).find((node) => node.type === "Tabs")!.props.value;
    const beforePreviewHandoffs = swipeHandoffs;
    gesture.callbacks.onUpdate({ absoluteX: 200 + dx, absoluteY: 300 + dy, numberOfPointers: options.pointers ?? 1 });
    assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, beforePreviewSide,
      "Dragging previews the same content without committing a tab");
    assert.equal(swipeHandoffs, beforePreviewHandoffs, "UI preview never crosses to RN");
    gesture.callbacks.onStart();
    nativeClock += options.duration ?? 100;
    gesture.callbacks.onTouchesMove(move, manager);
    gesture.callbacks.onEnd({ absoluteX: 200 + dx, absoluteY: 300 + dy,
      // The Android activation reset must not be used as the full displacement.
      translationX: dx - Math.sign(dx) * 12, velocityX: options.velocityX ?? 0,
      numberOfPointers: options.pointers ?? 1 }, options.success !== false);
    gesture.callbacks.onFinalize();
    return failures;
  };
  assert.deepEqual(swipeGesture().config, { enabled: true, maxPointers: 1,
    activeOffsetX: [-12, 12], failOffsetY: [-12, 12], hitSlop: { left: -24, right: -24 } });
  assert.equal(typeof swipeGesture().callbacks.onUpdate, "function", "Preview has a UI worklet, without RN/React move traffic");
  assert.equal(swipeGesture().callbacks.onChange, undefined);
  assert.equal(swipeReactions.size, 1, "Home owns a useful UI reaction before native events arrive");
  const uiSwipeLease = swipeSharedValues.find((shared) =>
    shared.value && typeof shared.value === "object" && "scope" in shared.value)!;
  const uiSwipeStroke = swipeSharedValues.find((shared) => shared.value && typeof shared.value === "object" && "activated" in shared.value)!;
  const uiSwipeOffset = swipeSharedValues.find((shared) => typeof shared.value === "number")!;
  assert.ok(uiSwipeLease && uiSwipeStroke, "The UI lease and live stroke are separate shared values");
  assert.equal(nodes(tree).filter((node) => node.type === "HomeAnimatedBody").length, 1,
    "The existing body is the single animated native host, around one ScrollView");
  assert.equal(nodes(tree).find((node) => node.type === "HomeAnimatedBody")!.props.collapsable, false);
  const previewGesture = swipeGesture();
  previewGesture.callbacks.onTouchesDown({ numberOfTouches: 1,
    allTouches: [{ absoluteX: 200, absoluteY: 300 }] }, { fail: noop });
  nativeClock += 20;
  previewGesture.callbacks.onStart();
  previewGesture.callbacks.onUpdate({ absoluteX: 100, absoluteY: 300 });
  assert.equal(uiSwipeOffset.value, -65, "A valid drag previews65% of its displacement");
  previewGesture.callbacks.onUpdate({ absoluteX: -800, absoluteY: 300 });
  assert.equal(uiSwipeOffset.value, -96, "The preview remains bounded to96points");
  previewGesture.callbacks.onUpdate({ absoluteX: 300, absoluteY: 300 });
  assert.equal(uiSwipeOffset.value, 0, "The outward Collect boundary has no preview");
  previewGesture.callbacks.onUpdate({ absoluteX: 100, absoluteY: 380 });
  assert.equal(uiSwipeOffset.value, 0, "A diagonal has no horizontal preview");
  previewGesture.callbacks.onUpdate({ absoluteX: NaN, absoluteY: 300 });
  assert.equal(uiSwipeOffset.value, 0);
  previewGesture.callbacks.onUpdate({ absoluteX: 100, absoluteY: 300 });
  previewGesture.callbacks.onFinalize();
  assert.equal(uiSwipeOffset.value, 0, "A canceled active gesture settles tozero without a commit");
  const canceledGesture = swipeGesture();
  canceledGesture.callbacks.onTouchesDown({ numberOfTouches: 1,
    allTouches: [{ absoluteX: 200, absoluteY: 300 }] }, { fail: noop });
  const capturedEpoch = uiSwipeStroke.value.epoch;
  assert.equal(uiSwipeStroke.value.from, "collect");
  assert.equal(uiSwipeStroke.value.blocked, false);
  nodes(tree).find((node) => typeof node.props.onTouchStart === "function")!.props.onTouchStart();
  assert.ok(uiSwipeLease.value.epoch > capturedEpoch, "Immediate invalidation publishes the next UI epoch");
  assert.equal(uiSwipeLease.value.from, "collect", "The new epoch and its physical source tab publish together");
  flushSwipeReactions();
  assert.equal(uiSwipeStroke.value.blocked, true, "The actual Home reaction cancels a live stale UI stroke");
  const handoffsBeforeCanceledStroke = swipeHandoffs;
  canceledGesture.callbacks.onStart();
  canceledGesture.callbacks.onEnd({ absoluteX: 100, absoluteY: 300, numberOfPointers: 1 }, true);
  canceledGesture.callbacks.onFinalize();
  assert.equal(swipeHandoffs, handoffsBeforeCanceledStroke, "UI cancellation prevents a stale end from crossing to RN");
  assert.equal(homeScroll().props.disallowInterruption, false,
    "A scroll stopping its native fling cannot cancel the coordinated horizontal recognizer");
  assert.equal(homeScroll().props.shouldActivateOnStart, false);
  assert.equal(homeScroll().props.simultaneousHandlers.current, swipeGesture(),
    "The official scroll wrapper points to the current Pan handler");
  assert.equal(homeScroll().props.refreshControl.props.simultaneousHandlers.current, swipeGesture(),
    "The official refresh wrapper participates in the same relation");
  assert.equal(homeScroll().props.refreshControl.props.disallowInterruption, false);
  assert.equal(homeScroll().props.waitFor, homeScroll().props.refreshControl.props.ref,
    "The scroll handler waits for the registered refresh handler, like RNGH's official wrapper");
  assert.equal(homeScroll().props.onGestureEvent, homeScroll().props.refreshControl.props.onGestureEvent,
    "Both native handlers receive the same real UI event holder");
  assert.deepEqual(homeScroll().props.onGestureEvent.workletEventHandler.eventNames,
    ["onGestureHandlerEvent", "onGestureHandlerStateChange"]);
  const initialSwipeHandoffs = swipeHandoffs;
  const initialSwipeHaptics = homeImpactHaptics.length;
  for (const [dx, dy, options] of [
    [-100, 0, { success: false }], [-100, 80, {}], [0, 100, {}], [-31, 0, {}],
    [-17, 0, { velocityX: -900 }], [-18, 0, { velocityX: -449 }],
    [-18, 0, { velocityX: 900 }], [-18, 0, { velocityX: NaN }], [-18, 0, { velocityX: -Infinity }],
    [-32, 0, { hold: 400 }],
    [-32, 0, { hold: 400, earlyMove: { dx: -5, at: 200 } }],
    [-32, 0, { hold: 400, earlyMove: { dx: -6, dy: 4, at: 200 } }],
    [-32, 0, { hold: 400, earlyMove: { dx: -30, dy: 13, at: 200 } }],
    [-100, 0, { hold: 350 }], [-100, 0, { pointers: 2 }], [100, 0, {}],
  ] as const) {
    swipe(dx, dy, options);
    assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect");
  }
  assert.equal(swipeHandoffs, initialSwipeHandoffs, "Canceled/held/multi/diagonal/short/outward swipes never cross to JS");
  assert.equal(homeImpactHaptics.length, initialSwipeHaptics, "Rejected swipes never vibrate");
  const beforeSwipeCommands = scrollCommands.length;
  const panBeforeDirectionChange = swipeGesture();
  swipe(-32, 0, { duration: 700 });
  render();
  assert.equal(swipeGesture(), panBeforeDirectionChange,
    "Changing only the direction retains the recognizer and its UI callbacks");
  assert.equal(uiSwipeLease.value.from, "pay", "The stable recognizer receives the committed destination atomically");
  assert.ok(uiSwipeOffset.writes.includes(24), "Committed Pay enters from the physical right");
  assert.ok(homeTimings.some((timing) => timing.duration === 170 && timing.target === 0 && timing.reduceMotion === "system"));
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "pay",
    "A slowly completed swipe activated before the hold threshold still changes sides");
  assert.equal(swipeHandoffs, initialSwipeHandoffs + 1, "One successful end schedules one RN handoff");
  assert.deepEqual(homeImpactHaptics.slice(initialSwipeHaptics), ["soft"], "A gentle32-point swipe restores one original Soft impact");
  assert.equal(scrollCommands.length, beforeSwipeCommands + 1, "Swipe reuses the exact native offset restoration path");
  swipe(32); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect");
  assert.ok(uiSwipeOffset.writes.includes(-24), "Committed Collect enters from the physical left");
  assert.deepEqual(homeImpactHaptics.slice(initialSwipeHaptics), ["soft", "soft"], "Each actual swipe change vibrates once");
  swipe(-18, 0, { velocityX: -450 }); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "pay", "An18-point matching fast flick commits Pay");
  swipe(18, 0, { velocityX: 450 }); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect", "An18-point matching fast flick commits Collect");
  assert.deepEqual(homeImpactHaptics.slice(initialSwipeHaptics), ["soft", "soft", "soft", "soft"]);
  swipe(-32, 0, { hold: 400, earlyMove: { dx: -6, at: 200 } }); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "pay",
    "Meaningful6-point early movement preserves a deliberate slow swipe beyond350ms");
  swipe(32, 0, { hold: 400, earlyMove: { dx: 6, at: 200 } }); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "The slow-movement allowance works in both physical directions");
  assert.deepEqual(homeImpactHaptics.slice(initialSwipeHaptics), Array(6).fill("soft"));
  const hapticsBeforeTaps = homeImpactHaptics.length;
  changeTab("pay"); changeTab("pay"); changeTab("collect");
  assert.equal(homeImpactHaptics.length, hapticsBeforeTaps, "Plain tab changes and same-tab taps preserve their original no-haptic behavior");
  reducedHomeMotion = true; render();
  const timingsBeforeReduced = homeTimings.length;
  swipe(-100); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "pay",
    "Reduced motion keeps swipe navigation available");
  assert.equal(uiSwipeOffset.value, 0);
  assert.equal(homeTimings.length, timingsBeforeReduced, "Live reduced motion disables preview and entry timing");
  reducedHomeMotion = false; render();
  changeTab("collect");
  const hapticsBeforeQueuedStale = homeImpactHaptics.length;
  queueSwipeCommit = true;
  swipe(-100);
  changeTab("collect");
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "Even tapping the current tab invalidates a queued swipe completion");
  swipe(-100);
  changeTab("pay"); changeTab("collect");
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "Collect→Pay→Collect cannot revive a queued swipe from the old Collect lifetime");
  swipe(-100);
  openSettings(); await flush();
  assert.equal(swipeGesture().config.enabled, false, "A settings sheet disables Home recognition");
  closeSettings(); await flush();
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "Opening/closing a sheet cannot revive its covered Home's completed swipe");
  swipe(-100);
  nodes(tree).find((node) => typeof node.props.onTouchStart === "function")!.props.onTouchStart();
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "A header interaction, including the bell's own modal, invalidates a queued body swipe");
  swipe(-100);
  nodes(tree).find((node) => node.type === "SearchFieldTrigger")!.props.onPress(); render();
  assert.equal(swipeGesture().config.enabled, false, "Search disables Home's covered recognizer");
  sheet().props.onDismiss(); render();
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "Search open/close cannot revive a queued Home swipe");
  swipe(-100);
  vault = "vault-swipe-b"; render(); await reload(); await flush();
  vault = "vault-a"; render(); await reload(); await flush();
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "A vault ABA invalidates the original body gesture lease");
  swipe(-100);
  account = "account-swipe-b"; identityListeners.forEach((listener) => listener());
  account = "account-a"; identityListeners.forEach((listener) => listener());
  // Do not render between the two identity events or before delivering the old end.
  swipeCommits.shift()!(); render(); await flush();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "Identity events invalidate account ABA even when React never painted the intermediate account");
  swipe(-100);
  homeOwnerFocused = false; render();
  swipeCommits.shift()!(); render();
  assert.equal(nodes(tree).find((node) => node.type === "Tabs")!.props.value, "collect",
    "A blurred owner rejects a queued swipe before any reload");
  homeOwnerFocused = true; render(); await flush();
  queueSwipeCommit = false;
  assert.equal(homeImpactHaptics.length, hapticsBeforeQueuedStale, "A queued swipe rejected by any lifetime/scope guard never vibrates");
  assert.deepEqual(homeRows().map((row) => row.props.person.id), ["a", "c"]);
  assert.deepEqual(retainedRows().map((row) => row.props.person.id).sort(), ["a", "b", "c"],
    "Off-side financial rows stay mounted once, while the exact cached-hidden style excludes their layout from visible traversal");
  assert.deepEqual(retainedKeys(), ["a", "b", "c"], "Retained row owners use stable customer IDs");
  const hiddenPayOwner = cachedBoundaryFor(tree, "b")!;
  assert.ok(hiddenPayOwner, "The inactive financial row belongs to a cached hidden boundary");
  assert.equal(cachedHidden(hiddenPayOwner), true);
  assert.equal(hiddenPayOwner.props.pointerEvents, "none", "Cached rows cannot intercept touches");
  assert.equal(hiddenPayOwner.props.accessibilityElementsHidden, true);
  assert.equal(hiddenPayOwner.props.importantForAccessibility, "no-hide-descendants",
    "Cached rows are absent from Android accessibility traversal");
  assert.equal(homeScroll().props.contentOffset, undefined,
    "An imperative restoration cannot depend on React diffing equal contentOffset values");
  const homeScopeKey = (homeScroll() as UINode & { key: string }).key;
  assert.equal(typeof homeScopeKey, "string", "The native scroll owner is keyed by account/vault scope");
  expectCommand(0, () => changeTab("pay"), "Collect0 to Pay0 still sends a real native scroll command");
  assert.deepEqual(homeRows().map((row) => row.props.person.id), ["b"]);
  assert.deepEqual(retainedKeys(), ["a", "b", "c"], "A tab switch retains the same financial row keys");
  assert.equal((homeScroll() as UINode & { key: string }).key, homeScopeKey,
    "Changing tabs preserves the same scope-keyed native scroll view");
  expectCommand(0, () => changeTab("collect"), "Pay0 to Collect0 also restores natively");
  const firstCollectScroll = homeScroll();
  firstCollectScroll.props.onScroll(scrollEvent(999));
  firstCollectScroll.props.onMomentumScrollEnd(scrollEvent(999));
  expectCommand(0, () => changeTab("pay"), "Automatic native scroll events cannot acquire a user-drag lease");
  expectCommand(0, () => changeTab("collect"), "Unleased automatic events cannot corrupt the old tab's offset");
  const firstRestoreFence = nativeClock;
  nativeClock = firstRestoreFence + 20;
  expectCommand(0, () => homeScroll().props.onContentSizeChange(390, 2000),
    "A late content-size callback still aborts native momentum with a restore command");
  expectCommand(0, () => homeScroll().props.onContentSizeChange(390, 2100),
    "Repeated late content-size callbacks may reapply the same native target");
  homeScroll().props.onScrollBeginDrag(scrollEvent(0, firstRestoreFence + 10));
  homeScroll().props.onScroll(scrollEvent(77, firstRestoreFence + 11));
  expectCommand(0, () => changeTab("pay"), "Queued genuine dragging leaves the other side unchanged");
  expectCommand(77, () => changeTab("collect"),
    "Native begin110/scroll111 remain valid when late content-size work runs at JS120 after the first fence100");
  const missingRefCommands = scrollCommands.length;
  homeScroll().props.ref.current = null;
  changeTab("pay");
  assert.equal(scrollCommands.length, missingRefCommands, "A missing native ref cannot issue a restore command");
  const missingRefPageTime = nativeClock;
  nativeClock = missingRefPageTime + 20;
  expectCommand(0, () => homeScroll().props.onContentSizeChange(390, 2000),
    "The first actual ref-backed restore establishes its fence after the ref becomes available");
  homeScroll().props.onScrollBeginDrag(scrollEvent(0, missingRefPageTime + 10));
  homeScroll().props.onScroll(scrollEvent(888, missingRefPageTime + 11));
  expectCommand(77, () => changeTab("collect"), "A ref-less attempted restore cannot change the other side");
  expectCommand(0, () => changeTab("pay"),
    "A no-ref attempt must not consume the first-actual-restore fence or accept an earlier drag");
  expectCommand(77, () => changeTab("collect"), "The valid pre-existing Collect offset survives ref restoration");
  const draggedCollectScroll = homeScroll();
  beginDrag(draggedCollectScroll, 0);
  draggedCollectScroll.props.onScroll(scrollEvent(145));
  draggedCollectScroll.props.onScrollEndDrag(scrollEvent(145));
  const commandsBeforeRender = scrollCommands.length;
  render();
  assert.equal(scrollCommands.length, commandsBeforeRender,
    "An unrelated render cannot issue a native command that rewinds an ongoing scroll");
  expectCommand(0, () => changeTab("pay"), "The other side starts at its own offset");
  assert.deepEqual(homeRows().map((row) => row.props.person.id), ["b"]);
  beginDrag(homeScroll(), 0);
  homeScroll().props.onMomentumScrollEnd(scrollEvent(60));
  expectCommand(145, () => changeTab("collect"), "Collect restores its independent offset");
  homeScroll().props.onScroll(scrollEvent(0));
  expectCommand(145, () => homeScroll().props.onContentSizeChange(390, 2000),
    "A layout clamp before fresh dragging reapplies the saved restoration target");
  assert.equal(homeFrames.size, 1, "Content-size work queues one native post-mount correction");
  flushHomeFrame();
  nativeMaxY = 0;
  const preMountScroll = homeScroll();
  preMountScroll.props.onContentSizeChange(390, 2000);
  assert.equal(nativeY, 0, "Immediate commands can clamp against the old short native content");
  const supersededFrame = [...homeFrames.values()][0];
  preMountScroll.props.onContentSizeChange(390, 2100);
  assert.equal(homeFrames.size, 1, "Repeated shadow-layout callbacks coalesce into one frame");
  const commandsBeforeSupersededFrame = scrollCommands.length;
  supersededFrame();
  assert.equal(scrollCommands.length, commandsBeforeSupersededFrame,
    "A canceled coalesced callback cannot execute against its replacement");
  nativeMaxY = 1000;
  changeTab("collect");
  nodes(tree).find((node) => typeof node.props.onTouchStart === "function")!.props.onTouchStart();
  assert.equal(homeFrames.size, 1, "Same-tab and header touches preserve the required scroll completion");
  expectCommand(145, flushHomeFrame, "One frame after native mount restores the exact saved target");
  assert.equal(nativeY, 145, "Post-mount correction reaches the real target instead of the old short clamp");
  assert.equal(homeFrames.size, 0, "Restoration never starts a permanent frame loop");
  preMountScroll.props.onContentSizeChange(390, 2100);
  const oldPageFrame = [...homeFrames.values()][0];
  expectCommand(60, () => changeTab("pay"), "A new tab cancels the old page's pending frame");
  assert.equal(homeFrames.size, 0);
  homeScroll().props.onContentSizeChange(390, 900);
  assert.equal(homeFrames.size, 1);
  const beforeStaleContent = scrollCommands.length;
  preMountScroll.props.onContentSizeChange(390, 2100);
  oldPageFrame();
  assert.equal(homeFrames.size, 1, "Stale page content callbacks cannot cancel the new page's completion");
  assert.equal(scrollCommands.length, beforeStaleContent, "Stale page/frame callbacks cannot issue commands");
  expectCommand(60, flushHomeFrame, "The matching new page keeps its queued completion");
  expectCommand(145, () => changeTab("collect"), "The post-mount check preserves independent offsets");
  homeScroll().props.onContentSizeChange(390, 2100);
  const canceledByDrag = [...homeFrames.values()][0];
  beginDrag(homeScroll(), 145);
  const beforeCanceledDragFrame = scrollCommands.length;
  assert.equal(homeFrames.size, 0, "A fresh native drag cancels pending restoration");
  canceledByDrag();
  assert.equal(scrollCommands.length, beforeCanceledDragFrame, "A canceled frame cannot rewind a fresh drag");
  expectCommand(60, () => changeTab("pay"), "Pay restores its independent offset");
  expectCommand(145, () => changeTab("collect"), "Rapid tab changes restore the matching side");
  const staleTimestamp = nativeClock - 1;
  homeScroll().props.onScrollBeginDrag(scrollEvent(0, staleTimestamp));
  homeScroll().props.onScroll(scrollEvent(888, staleTimestamp));
  firstCollectScroll.props.onScrollBeginDrag(scrollEvent(0));
  firstCollectScroll.props.onScroll(scrollEvent(999));
  expectCommand(60, () => changeTab("pay"), "Stale automatic/old-drag events cannot change Pay");
  expectCommand(145, () => changeTab("collect"),
    "Rapid Collect/Pay/Collect does not reactivate an earlier Collect lease");
  beginDrag(homeScroll(), 145);
  homeScroll().props.onScroll(scrollEvent(170));
  const commandsBeforeContentChange = scrollCommands.length;
  homeScroll().props.onContentSizeChange(390, 2100);
  assert.equal(scrollCommands.length, commandsBeforeContentChange,
    "Content changes must not rewind the user after a fresh drag begins");
  expectCommand(60, () => changeTab("pay"), "A fresh drag leaves the other side untouched");
  expectCommand(170, () => changeTab("collect"), "A fresh active drag updates only its own saved offset");
  const initialListReads = listRequests.length;
  assert.deepEqual(searchIds(), [], "Closed search does not filter or sort customer rows");
  startFromContactMenu();
  assert.equal(sheet().props.visible, true);
  assert.equal(
    sheet().props.autoFocus,
    false,
    "Select opens the search sheet without bringing up the keyboard",
  );
  assert.deepEqual(searchIds(), ["a", "b", "c"], "Both money directions share one selectable list");
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
  const priorVaultScroll = homeScroll();
  const priorVaultKey = (priorVaultScroll as UINode & { key: string }).key;
  const commandsBeforeVault = scrollCommands.length;
  nativeClock += 10;
  vault = "vault-b";
  render();
  assert.equal(sheet().props.visible, false, "A vault switch immediately hides old selection data");
  await reload();
  await flush();
  assert.notEqual((homeScroll() as UINode & { key: string }).key, priorVaultKey,
    "A different vault gets a fresh native scroll identity");
  assert.ok(scrollCommands.slice(commandsBeforeVault).some((command) => command.y === 0),
    "Vault transitions restore zero natively even while list data is being refreshed");
  priorVaultScroll.props.onScrollBeginDrag(scrollEvent(0));
  priorVaultScroll.props.onScroll(scrollEvent(900));
  expectCommand(0, () => changeTab("pay"), "An old vault's drag cannot transfer its offset");
  expectCommand(0, () => changeTab("collect"), "Both offsets reset in the new vault");
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
  const priorAccountScroll = homeScroll();
  const priorAccountKey = (priorAccountScroll as UINode & { key: string }).key;
  const commandsBeforeAccount = scrollCommands.length;
  nativeClock += 10;
  account = "account-b";
  render();
  assert.equal(
    sheet().props.visible,
    false,
    "An account switch immediately hides old selection data",
  );
  identityListeners.forEach((listener) => listener());
  await flush();
  assert.notEqual((homeScroll() as UINode & { key: string }).key, priorAccountKey,
    "A different account gets a fresh native scroll identity");
  assert.ok(scrollCommands.slice(commandsBeforeAccount).some((command) => command.y === 0),
    "Account transitions issue a native zero restore");
  priorAccountScroll.props.onScrollBeginDrag(scrollEvent(0));
  priorAccountScroll.props.onMomentumScrollEnd(scrollEvent(800));
  expectCommand(0, () => changeTab("pay"), "An old account's momentum cannot transfer its offset");
  expectCommand(0, () => changeTab("collect"), "Account changes reset both sides independently");
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
  const beforeOrdinarySearch = homeScroll();
  beginDrag(beforeOrdinarySearch, 0);
  beforeOrdinarySearch.props.onScroll(scrollEvent(33));
  const trigger = outsideSheet(tree).find((node) => node.type === "SearchFieldTrigger")!;
  trigger.props.onPress();
  render();
  assert.equal(sheet().props.autoFocus, true, "Ordinary search still focuses its input");
  assert.equal(sheet().props.footer, null, "Ordinary search starts outside selection mode");
  const coveredHomeRow = outsideSheet(tree).find(
    (node) => node.type === "PersonRow" && node.props.person.id === "a",
  )!;
  coveredHomeRow.props.onLongPress(coveredHomeRow.props.person);
  render();
  assert.equal(nodes(tree).some((node) => node.type === "BottomSheet" && node.props.visible), false,
    "A covered Home row cannot open its action menu underneath native search");
  beforeOrdinarySearch.props.onScroll(scrollEvent(444));
  sheet().props.onDismiss();
  render();
  homeScroll().props.onScroll(scrollEvent(555));
  expectCommand(0, () => changeTab("pay"), "Search cannot transfer an earlier Home drag to another side");
  expectCommand(33, () => changeTab("collect"),
    "A closed search cannot reactivate a drag lease from the previous search generation");
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
  openSettings();
  await flush();
  assert.equal(meshListeners.size, 1);
  const peerAtUnmount = meshCallbacks.at(-1)!;
  hooks.unmount();
  assert.equal(meshListeners.size, 0, "Home unmount removes the settings status listener");
  assert.equal(meshRemovals, meshSubscriptions, "Every settings lease is removed by close or final unmount");
  const lateWritesBeforePeerCallback = hooks.lateWrites;
  peerAtUnmount({ activePeers: 99 });
  assert.equal(hooks.lateWrites, lateWritesBeforePeerCallback, "A queued peer callback cannot write after unmount");
  for (const os of ["android", "ios", "web"]) {
    const fallbackHooks = uiHooks();
    const fallbackReact = {
      ...fallbackHooks.react,
      createContext: react.createContext, useContext: react.useContext, memo: react.memo,
      useLayoutEffect: fallbackHooks.react.useEffect,
    };
    const FallbackHome = compileUI("../../app/index", {
      ...mocks,
      react: fallbackReact,
      "react-native-reanimated": {
        ...mocks["react-native-reanimated"],
        useSharedValue: (value: unknown) => fallbackReact.useRef({ value }).current,
        useAnimatedStyle: (read: () => unknown) => Object.assign(fallbackReact.useRef({}).current, read()),
        useAnimatedReaction: animatedReaction(fallbackReact),
        useEvent: (worklet: unknown, eventNames: string[]) => fallbackReact.useRef({ workletEventHandler: { worklet, eventNames } }).current,
      },
      "react-native": { ...native, Platform: { OS: os } },
      "../lib/db": {
        ...mocks["../lib/db"],
        listAllPeopleForSearch: async () => os === "android" ? [...people, {
          ...people[0], id: "neutral", name: "Neutral", balance: 0,
          last_entry_at: null, last_entry_type: null,
          selection_totals: { debtCount: 0, creditCount: 0, debtMinor: 0, creditMinor: 0 },
        }] : people,
      },
      "expo-router": {
        ...mocks["expo-router"],
        useFocusEffect: (work: () => any) => fallbackReact.useEffect(work, [work]),
      },
      "../lib/use-search-focus-effect": {
        useSearchFocusEffect: (work: () => any) => fallbackReact.useEffect(work, [work]),
      },
    }, { __DEV__: false, performance: { now: () => nativeClock }, ...homeFrameGlobals }).default;
    let fallbackTree!: UINode;
    const fallbackRender = () => { fallbackTree = expand(fallbackHooks.render(FallbackHome)); };
    const fallbackScroll = () => outsideSheet(fallbackTree).find((node) => node.type === "ScrollView")!;
    const fallbackIds = () => outsideSheet(fallbackTree, true)
      .filter((node) => node.type === "PersonRow").map((node) => node.props.person.id);
    const fallbackTab = (side: "collect" | "pay") => {
      nodes(fallbackTree).find((node) => node.type === "Tabs")!.props.onChange(side);
      fallbackRender();
    };
    const nativeCommandsBeforeFallback = scrollCommands.length;
    fallbackRender();
    await settleUI();
    fallbackRender();
    await settleUI();
    fallbackRender();
    if (os === "android") {
      const visibleIds = () => outsideSheet(fallbackTree).filter((node) => node.type === "PersonRow")
        .map((node) => node.props.person.id);
      const visibleText = () => outsideSheet(fallbackTree).filter((node) => node.type === "Text")
        .map((node) => node.props.children);
      assert.deepEqual(visibleIds(), ["a", "c", "neutral"]);
      assert.equal(fallbackIds().filter((id) => id === "neutral").length, 1,
        "Both cached financial groups share one mounted neutral customer section");
      assert.ok(visibleText().includes("home.total.label.collect"));
      assert.ok(visibleText().includes("130"), "Only Collect's coherent financial total is visible");
      assert.equal(visibleText().includes("home.total.label.pay"), false);
      fallbackTab("pay");
      assert.deepEqual(visibleIds(), ["b", "neutral"]);
      assert.deepEqual(fallbackIds().sort(), ["a", "b", "c", "neutral"]);
      assert.equal(fallbackIds().filter((id) => id === "neutral").length, 1);
      assert.ok(visibleText().includes("home.total.label.pay"));
      assert.ok(visibleText().includes("40"), "Only Pay's coherent financial total is visible");
      assert.equal(visibleText().includes("home.total.label.collect"), false);
      const collectGroup: UINode = cachedBoundaryFor(fallbackTree, "a")!;
      assert.ok(collectGroup, "Inactive Collect rows and hero belong to a cached group");
      assert.equal(collectGroup.props.pointerEvents, "none");
      assert.equal(collectGroup.props.accessibilityElementsHidden, true);
      assert.equal(collectGroup.props.importantForAccessibility, "no-hide-descendants");
      const gesture = nodes(fallbackTree).find((node) => node.type === "GestureDetector")!.props.gesture;
      const manager = { fail: () => assert.fail("A valid down must remain eligible") };
      gesture.callbacks.onTouchesDown({ numberOfTouches: 1, allTouches: [{ absoluteX: 100, absoluteY: 300 }] }, manager);
      nativeClock += 20;
      gesture.callbacks.onStart();
      queueSwipeCommit = true;
      gesture.callbacks.onEnd({ absoluteX: 200, absoluteY: 300, numberOfPointers: 1 }, true);
      assert.equal(swipeCommits.length, 1);
      fallbackHooks.unmount();
      const writesAfterUnmount = fallbackHooks.lateWrites;
      swipeCommits.shift()!();
      assert.equal(fallbackHooks.lateWrites, writesAfterUnmount, "A queued swipe end cannot update an unmounted Home");
      queueSwipeCommit = false;
      continue;
    }
    assert.deepEqual(fallbackIds(), ["a", "c"], `${os} mounts only its active financial side`);
    assert.deepEqual(fallbackScroll().props.contentOffset, { x: 0, y: 0 });
    const collectKey = (fallbackScroll() as UINode & { key: string }).key;
    fallbackScroll().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 77 } } });
    fallbackRender();
    assert.deepEqual(fallbackScroll().props.contentOffset, { x: 0, y: 0 },
      `${os} rerenders preserve the initial mount offset`);
    fallbackTab("pay");
    assert.deepEqual(fallbackIds(), ["b"]);
    assert.notEqual((fallbackScroll() as UINode & { key: string }).key, collectKey,
      `${os} keeps its direction-keyed native owner`);
    fallbackScroll().props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0, y: 22 } } });
    fallbackTab("collect");
    assert.deepEqual(fallbackScroll().props.contentOffset, { x: 0, y: 77 },
      `${os} retains its existing timestamp-free per-tab restoration`);
    fallbackTab("pay");
    assert.deepEqual(fallbackScroll().props.contentOffset, { x: 0, y: 22 });
    assert.equal(scrollCommands.length, nativeCommandsBeforeFallback,
      `${os} never enters Android's imperative native-scroll lease path`);
    fallbackHooks.unmount();
  }
  console.log(
    "PASS home selection: visible-only mesh import/listener/snapshot leases, Android cached group rows/hero/accessibility with one neutral section, native equal-offset/first-actual-fence restoration, queued drag/search leases, stale/ABA/scope rejection, clamp restore without rewinds, preserved iOS/web offsets, closed-search gating, instant financial totals, coherent snapshots and scoped selection/modal guards",
  );
}
void main();
