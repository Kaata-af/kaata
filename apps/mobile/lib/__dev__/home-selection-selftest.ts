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
const react = hooks.react;
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
const toasts: { message: string; kind: string }[] = [];
const toast = {
  push: (message: string, kind: string) => toasts.push({ message, kind }),
};
const router = { push: noop, replace: noop };
const metadata = new Map<string, string>();
const pan = () => {
  const chain: any = {};
  for (const name of [
    "enabled",
    "activeOffsetX",
    "failOffsetY",
    "onStart",
    "onUpdate",
    "onEnd",
    "onFinalize",
  ])
    chain[name] = () => chain;
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
  Platform: { OS: "ios" },
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
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
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
  "react-native-gesture-handler": { Gesture: { Pan: pan }, GestureDetector: "GestureDetector" },
  "react-native-reanimated": {
    __esModule: true,
    default: { View: "RailView" },
    useSharedValue: (value: unknown) => react.useRef({ value }).current,
    useAnimatedStyle: (read: () => unknown) => read(),
    withSpring: (target: number) => target,
    cancelAnimation: noop,
  },
  "react-native-worklets": {
    scheduleOnUI: (work: () => void) => work(),
    scheduleOnRN: (work: (...args: any[]) => void, ...args: any[]) => work(...args),
  },
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
    onShopModeStatusChange: () => noop,
    getShopModeStatus: () => ({ activePeers: 0 }),
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
const Home = compileUI("../../app/index", mocks, { __DEV__: false }).default;

// Home-local list components are real; imported visual components remain opaque.
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand);
  if (!value?.props) return value;
  if (typeof value.type === "function") return expand(value.type(value.props));
  return { ...value, props: { ...value.props, children: expand(value.props.children) } };
}
let tree: UINode;
const render = () => (tree = expand(hooks.render(Home)));
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
const outsideSheet = (node: any): UINode[] =>
  Array.isArray(node)
    ? node.flatMap(outsideSheet)
    : !node?.props || node.type === "SearchSheet"
      ? []
      : [node, ...outsideSheet(node.props.children)];
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
  assert.equal(sheet().props.visible, false);
  assert.equal(
    outsideSheet(tree).some((node) => node.type === "SelectionToolbar"),
    false,
  );
  for (const row of outsideSheet(tree).filter((node) => node.type === "PersonRow"))
    assert.ok(!row.props.selecting, "Homepage rows have no selection checkboxes");
  const initialListReads = listRequests.length;
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
  vault = "vault-b";
  render();
  assert.equal(sheet().props.visible, false, "A vault switch immediately hides old selection data");
  await reload();
  await flush();
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
  const trigger = outsideSheet(tree).find((node) => node.type === "SearchFieldTrigger")!;
  trigger.props.onPress();
  render();
  assert.equal(sheet().props.autoFocus, true, "Ordinary search still focuses its input");
  assert.equal(sheet().props.footer, null, "Ordinary search starts outside selection mode");
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
  hooks.unmount();
  console.log(
    "PASS home selection: instant count and financial totals without per-tap reads, coherent background snapshots, stale vault/account reads, shared sheet, scoped select-all, search/group preservation, modal confirmation, cancel/totals, duplicate and stale guards, dismissal",
  );
}
void main();
