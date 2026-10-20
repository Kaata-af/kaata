// Real home + add/find screens and the real device-contacts hook. Storage,
// native controls and navigation are synthetic; no real ledger or phone book.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { toAsciiDigits } from "../digits";
import * as search from "../search";
import { colors } from "../colors";
import { sumAmounts } from "../money";
import { canPerformAction } from "../vault-roles";

type Node = { type: string; props: Record<string, any> };
type Effect = { deps?: unknown[]; cleanup?: () => void };
let slots: any[] = [],
  cursor = 0,
  dirty = false,
  tree: Node;
let effects: (() => void)[] = [];
const tParams = new Map<string, Record<string, unknown> | undefined>();
let screen: () => Node;
let role: "owner" | "editor" | "clerk" | "viewer" = "viewer";
let rtl = false,
  platform = "android",
  vaultId: string | null = "kaata";
let screenWidth = 390;
let routeParams: { mode?: string } = {};
let keyboardDismissals = 0;
let reducedMotion = false,
  homeToastOffset = 0;
const scheduledKeyboardLayouts: unknown[] = [];
const keyboardListeners = new Set<{ event: string; fn: (payload: any) => void }>();
const keyboardEvent = (event: string) => {
  const payload = {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { height: 300, screenY: 544 },
  };
  for (const listener of [...keyboardListeners]) if (listener.event === event) listener.fn(payload);
};
const springTargets: number[] = [];
let groupState = {
  groups: [] as { id: string; name: string; member_count: number }[],
  groupsByPerson: {} as Record<string, string[]>,
};
let archivedState: "active" | "archived" | "none" = "active";
let delayedGuard: Promise<{ state: string }> | null = null;
let delayedRole: Promise<void> | null = null;
let delayedPeople: Promise<void> | null = null;
type FixturePerson = (typeof people)[number] & { tab_id?: string; tab_unsynced?: 0 | 1 };
let peopleByVault: Map<string | null, FixturePerson[]>;
let activeVaultsOverride: { id: string; name: string; currency: string }[] | null = null;
const homeReadScopes: (string | null)[] = [];
let appState = "active";
let roleReadFails = false,
  focusEpoch = 0;
let homeOwnerFocused = true;
// app_meta.account_id survives sign-out; the in-memory cache does not.
let persistedAccountId: string | null = null,
  cachedAccountId: string | null = null;
const identityListeners = new Set<() => void>();
const routes: any[] = [],
  toasts: any[] = [],
  writes: any[] = [];
const homePreferenceMeta = new Map<string, string>();
const archivedPeople: { id: string; vaultId: string | null; accountId: string | null }[] = [];
const archiveFailures = new Set<string>();
let delayedArchive: Promise<void> | null = null;
const backListeners = new Set<() => boolean>();
let contactsReads = 0,
  permissionRequests = 0;
let nextTimer = 0;
const timers = new Map<number, () => void>();
const appListeners = new Set<(state: string) => void>();
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const react = {
  useState(initial: any) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
    return [
      slots[i],
      (value: any) => {
        const next = typeof value === "function" ? value(slots[i]) : value;
        if (!Object.is(next, slots[i])) {
          slots[i] = next;
          dirty = true;
        }
      },
    ];
  },
  useRef(initial: any) {
    const i = cursor++;
    return (slots[i] ??= { current: initial });
  },
  useMemo(fn: () => any, deps: unknown[]) {
    const i = cursor++;
    if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() };
    return slots[i].value;
  },
  useCallback(fn: (...args: any[]) => any, deps: unknown[]) {
    return react.useMemo(() => fn, deps);
  },
  useDeferredValue(value: any) {
    return react.useMemo(() => value, [value]);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const i = cursor++;
    const before: Effect | undefined = slots[i];
    if (before && same(before.deps, deps)) return;
    slots[i] = { deps };
    effects.push(() => {
      before?.cleanup?.();
      slots[i].cleanup = fn();
    });
  },
};
const jsx = (type: string, props: any): Node => ({
  type,
  props:
    type === "SearchFieldTrigger" ? { ...props, accessibilityLabel: props.placeholder } : props,
});
const nodes = (node: any): Node[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== "object"
      ? []
      : [
          node,
          ...nodes(
            node.type === "SearchSheet"
              ? node.props.visible
                ? [
                    typeof node.props.children === "function"
                      ? node.props.children(0)
                      : node.props.children,
                    node.props.filters,
                    node.props.footer,
                    { type: "ConfirmDialog", props: node.props.confirmation },
                  ]
                : null
              : node.type === "SearchControlSlot" && !node.props.visible
                ? null
                : node.props?.children,
          ),
        ];
const text = (node: any): string =>
  Array.isArray(node)
    ? node.map(text).join("")
    : typeof node === "string"
      ? node
      : node?.props
        ? text(node.props.children)
        : "";
const find = (type: string) => nodes(tree).find((node) => node.type === type);
const byLabel = (label: string) =>
  nodes(tree).find((node) => node.props.accessibilityLabel === label);
const flattenStyle = (value: any): any =>
  Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flattenStyle)) : value;
const router = {
  push: (route: any) => routes.push(route),
  replace: (route: any) => routes.push(route),
  back() {},
};
const toast = { push: (...args: any[]) => toasts.push(args) };
const people = [
  {
    id: "ahmad",
    name: "Ahmad Karimi",
    phone: "+93700123456",
    balance: 500,
    last_entry_at: 100,
    created_at: 10,
    direction: "collect",
  },
  {
    id: "fatima",
    name: "فاطمه احمدی",
    phone: "+93700987654",
    balance: 0,
    last_entry_at: null,
    created_at: 20,
    direction: "collect",
  },
];
const deviceContacts = [
  {
    id: "phone-contact",
    name: "Zarif Rahimi",
    firstName: "Zarif",
    lastName: "Rahimi",
    phone: "+93788111111",
  },
];
const native: Record<string, any> = {
  View: "View",
  Text: "Text",
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Image: "Image",
  ActivityIndicator: "Spinner",
  RefreshControl: "RefreshControl",
  KeyboardAvoidingView: "Keyboard",
  Keyboard: {
    dismiss: () => {
      keyboardDismissals++;
    },
    scheduleLayoutAnimation: (event: unknown) => scheduledKeyboardLayouts.push(event),
    addListener(event: string, fn: (payload: any) => void) {
      const listener = { event, fn };
      keyboardListeners.add(listener);
      return { remove: () => keyboardListeners.delete(listener) };
    },
  },
  Platform: {
    get OS() {
      return platform;
    },
    select: (values: any) => values[platform],
  },
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ width: screenWidth, height: 844 }),
  BackHandler: {
    addEventListener: (_: string, listener: () => boolean) => {
      backListeners.add(listener);
      return { remove: () => backListeners.delete(listener) };
    },
    exitApp() {},
  },
  Linking: {
    openSettings: async () => {
      permissionRequests++;
    },
  },
  AppState: {
    get currentState() {
      return appState;
    },
    addEventListener: (_: string, listener: any) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    },
  },
  Animated: {
    View: "AnimatedView",
    Value: class {
      constructor(public value: number) {}
      setValue(value: number) {
        this.value = value;
      }
    },
    spring: (_value: unknown, options: { toValue: number }) => {
      springTargets.push(options.toValue);
      return { start() {}, stop() {} };
    },
  },
};
const fonts = {
  sansRegular: "Regular",
  sansMedium: "Medium",
  sansSemi: "Semi",
  sansBold: "Bold",
  monoMedium: "Mono",
  monoSemi: "MonoSemi",
  monoBold: "MonoBold",
};
const tokens = {
  TOUCH_MIN: 44,
  radius: { sm: 8, md: 12, pill: 999 },
  icon: { header: 24, row: 20, trailing: 16 },
  typography: {},
};
function compile(file: string, mocks: Record<string, any>) {
  const exports: any = {};
  const js = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "exports", "setTimeout", "clearTimeout", "__DEV__", js)(
    (name: string) => {
      assert.ok(name in mocks, `${file}: unexpected dependency ${name}`);
      return mocks[name];
    },
    exports,
    (fn: () => void) => {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    (id: number) => timers.delete(id),
    false,
  );
  return exports;
}
const contactsHook = compile("../use-device-contacts", {
  react,
  "react-native": native,
  "./contacts-sync": {
    readDeviceContacts: async ({ requestPermission = false } = {}) => {
      contactsReads++;
      if (requestPermission) permissionRequests++;
      return { contacts: deviceContacts, granted: false, canAskAgain: true, limited: false };
    },
  },
});
const merge = compile("../contacts-merge", {
  "./contacts-sync": {
    phoneKey: (phone: string | null) =>
      phone ? toAsciiDigits(phone).replace(/\D/g, "").slice(-8) : null,
  },
  "./digits": { toAsciiDigits },
  "./search": search,
});
const ledgerEvents = compile("../ledger-events", { react, "react-native": native });
const roleHooks = compile("../use-vault-role", {
  react,
  "react-native": native,
  "./ledger-events": ledgerEvents,
  "expo-router": { useFocusEffect: (fn: any) => react.useEffect(fn, [fn, focusEpoch]) },
  "./db-tx": {
    getAccountIdSync: () => "account",
    getDb: async () => ({
      getAllAsync: async () => {
        const capturedRole = role;
        if (delayedRole) await delayedRole;
        if (roleReadFails) throw new Error("fixture role read failed");
        return [{ account_id: "account", role: capturedRole, revoked_at: null }];
      },
    }),
  },
  "./effective-account": { resolveAccountIdCandidates: async () => ["account"] },
  "./projection/role-gate": { invalidateRoleGateCache() {} },
  "./vault-roles": { canPerformAction },
});
const sharedMocks: Record<string, any> = {
  react,
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  "react-native": native,
  "expo-router": {
    useRouter: () => router,
    useLocalSearchParams: () => routeParams,
    Redirect: "Redirect",
    useFocusEffect: (fn: any) => react.useEffect(
      () => homeOwnerFocused ? fn() : undefined, [fn, focusEpoch, homeOwnerFocused],
    ),
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "react-native-safe-area-context": {
    SafeAreaView: "SafeArea",
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  },
};
const libMocks: Record<string, any> = {
  colors: { colors },
  currency: { applyVaultCurrency: async () => {}, getCurrentCurrencySymbol: () => "AFN" },
  direction: {
    useIsRTL: () => rtl,
    rowDir: (value: boolean) => ({ flexDirection: value ? "row-reverse" : "row" }),
    textDir: (value: boolean) => ({ textAlign: value ? "right" : "left" }),
    trackingSafe: () => ({}),
    bidiIsolate: (value: string) => value,
    ltrIsolate: (value: string) => value,
  },
  fonts: { fonts, sansLineHeight: (_: number, height: number) => height },
  format: { formatAmount: String },
  i18n: {
    t: (key: string, params?: Record<string, unknown>) => {
      tParams.set(key, params);
      return key;
    },
    getLocale: () => (rtl ? "fa" : "en"),
  },
  "customer-list": require("../customer-list"),
  "selection-summary": require("../selection-summary"),
  "customer-groups": { readCustomerGroups: async () => ({ ...groupState, groupByPerson: {} }) },
  "credit-limits": {
    readCreditPoliciesForPeople: async () => ({}),
    creditStatusForBalance: () => "none",
    refreshCreditPolicies: async () => {},
  },
  "credit-policy-events": { onCreditPoliciesChanged: () => () => {} },
  "sync/scheduler": { syncActiveVaultNow: async () => {} },
  "tabs/sync": { syncAllTabs: async () => {} },
  tokens,
  "use-vault-role": roleHooks,
  "use-search-focus-effect": {
    useSearchFocusEffect: sharedMocks["expo-router"].useFocusEffect,
  },
  "native-search": { afterNativeSearchClosed: () => false },
  "db-tx": {
    clearActiveVaultId: async () => {
      vaultId = null;
    },
    getAccountIdSync: () => cachedAccountId,
    onAccountIdentityChanged: (fn: () => void) => {
      identityListeners.add(fn);
      return () => {
        identityListeners.delete(fn);
      };
    },
    getActiveVaultIdSyncMaybe: () => vaultId,
    getActiveVaultId: async () => vaultId,
    setActiveVaultId: async (id: string | null) => {
      vaultId = id;
    },
  },
  db: {
    getLocalSelf: async () => ({ name: "Owner", shop_name: "Shop", phone: null }),
    listAllPeople: async (scope: string | null = vaultId) => {
      homeReadScopes.push(scope);
      return peopleByVault.get(scope) ?? [];
    },
    listAllPeopleForSearch: async (scope: string | null = vaultId) => {
      if (screen === home) homeReadScopes.push(scope);
      const rows = peopleByVault.get(scope) ?? [];
      if (delayedPeople) await delayedPeople;
      return rows.map((person) => ({
        ...person,
        selection_totals: {
          debtCount: person.balance > 0 ? 1 : 0,
          creditCount: person.balance < 0 ? 1 : 0,
          debtMinor: Math.round(Math.max(0, person.balance) * 100),
          creditMinor: Math.round(Math.max(0, -person.balance) * 100),
        },
      }));
    },
    getActiveVaultArchivedAt: async () => null,
    getActiveVaultArchivedState: async () => delayedGuard ?? { state: archivedState },
    getAppMeta: async (key: string) =>
      key === "account_id" ? persistedAccountId : (homePreferenceMeta.get(key) ?? null),
    setAppMeta: async (key: string, value: string) => {
      homePreferenceMeta.set(key, value);
    },
    listActiveVaults: async () =>
      activeVaultsOverride ?? (vaultId ? [{ id: vaultId, name: "Shop", currency: "AFN" }] : []),
    listAllVaultsIncludingArchived: async () =>
      vaultId ? [{ id: vaultId, name: "Shop", currency: "AFN", archived: false }] : [],
    archivePerson: async (id: string) => {
      const scope = vaultId;
      archivedPeople.push({ id, vaultId: scope, accountId: cachedAccountId });
      if (delayedArchive) await delayedArchive;
      if (archiveFailures.has(id)) throw new Error("fixture archive failed");
      peopleByVault.set(
        scope,
        (peopleByVault.get(scope) ?? []).filter((person) => person.id !== id),
      );
    },
    createPerson: async (...args: any[]) => {
      writes.push(args);
      return { ok: true, id: "created" };
    },
  },
  auth: { getSessionUser: async () => null, signOut: async () => {} },
  "ledger-events": ledgerEvents,
  "app-meta-context": { useAppMeta: () => ({ forceUpdate: false }) },
  money: { sumAmounts },
  "battery-exemption": new Proxy({}, { get: () => async () => false }),
  "trust/backfill": { ensureChainBackfill: async () => {} },
  "vault-api": { retryPendingVaultMaterialize: async () => {} },
  "contacts-merge": merge,
  "contacts-sync": {
    joinName: (first: string, last: string) => [first, last].filter(Boolean).join(" ").trim(),
  },
  digits: { toAsciiDigits },
  "event-log": {
    EventSigningUnavailableError: class extends Error {},
    RoleGateRejectionError: class extends Error {},
  },
  phone: {
    getCountry: () => ({ code: "AF", flag: "AF", dialCode: "+93" }),
    getCurrentDefaultCountryCode: () => "AF",
    inferCountryFromE164: () => "AF",
  },
  "person-save-error": {
    classifyPersonSaveError: () => "unknown",
    recordPersonSaveError: async () => {},
  },
  search,
  "use-device-contacts": contactsHook,
};
const componentMocks: Record<string, any> = {
  CustomerListSheet: {
    CustomerListSheet: "CustomerListSheet",
    CustomerListOptions: "CustomerListOptions",
  },
  SearchSheet: { SearchSheet: "SearchSheet" },
  SearchFieldTrigger: { SearchFieldTrigger: "SearchFieldTrigger" },
  SearchControlSlot: { SearchControlSlot: "SearchControlSlot" },
  SheetBackdrop: { useSheetMotionPreference: () => reducedMotion },
  BottomSheet: { BottomSheet: "BottomSheet" },
  ConfirmDialog: { ConfirmDialog: "ConfirmDialog" },
  Button: { Button: "Button" },
  EmptyState: { EmptyState: "EmptyState" },
  InitialAvatar: { InitialAvatar: "Avatar" },
  NotificationInbox: { NotificationBell: "Bell" },
  PersonRow: { PersonRow: "PersonRow" },
  SelectionToolbar: { SelectionToolbar: "SelectionToolbar", SelectionMark: "SelectionMark" },
  SelectionMark: { SelectionMark: "SelectionMark" },
  ProfileSettingsSheet: { ProfileSettingsSheet: "Settings" },
  Tabs: { Tabs: "Tabs" },
  Toast: { useToast: () => toast, useToastOffset: () => homeToastOffset },
  UpdateBanner: { UpdateBanner: "UpdateBanner" },
  VaultPickerSheet: { VaultPickerSheet: "VaultPicker" },
  CountryPickerSheet: { CountryPickerSheet: "CountryPicker" },
  SettingsScreen: { ScreenHeader: "Header" },
  SharedAccountBadge: { SharedAccountBadge: "SharedBadge" },
};
function screenMocks(prefix: string) {
  return {
    ...sharedMocks,
    ...Object.fromEntries(
      Object.entries(libMocks).map(([name, value]) => [`${prefix}lib/${name}`, value]),
    ),
    ...Object.fromEntries(
      Object.entries(componentMocks).map(([name, value]) => [`${prefix}components/${name}`, value]),
    ),
  };
}
const gesture: any = {};
const gestureHandlers: Record<string, (event: any) => void> = {};
for (const name of ["activeOffsetX", "failOffsetY", "runOnJS"]) gesture[name] = () => gesture;
for (const name of ["onUpdate", "onEnd"])
  gesture[name] = (handler: (event: any) => void) => {
    gestureHandlers[name] = handler;
    return gesture;
  };
const home = compile("../../app/index", {
  ...screenMocks("../"),
  "expo-haptics": {
    impactAsync: async () => {},
    selectionAsync: async () => {},
    ImpactFeedbackStyle: { Light: "light", Soft: "soft" },
  },
  "react-native-gesture-handler": { Gesture: { Pan: () => gesture }, GestureDetector: "Gesture" },
}).default;
const addOrFind = compile("../../app/person/new", screenMocks("../../")).default;
function unmount() {
  for (const slot of slots) slot?.cleanup?.();
  slots = [];
  effects = [];
  timers.clear();
  appListeners.clear();
  identityListeners.clear();
  backListeners.clear();
}
function fixture(
  component: () => Node,
  nextRole: typeof role,
  nextRtl = false,
  nextPlatform = "android",
) {
  unmount();
  screen = component;
  role = nextRole;
  rtl = nextRtl;
  platform = nextPlatform;
  vaultId = "kaata";
  archivedState = "active";
  delayedGuard = null;
  delayedRole = null;
  delayedPeople = null;
  peopleByVault = new Map([["kaata", people]]);
  appState = "active";
  roleReadFails = false;
  persistedAccountId = null;
  cachedAccountId = null;
  screenWidth = 390;
  routeParams = {};
  keyboardDismissals = 0;
  reducedMotion = false;
  homeToastOffset = 0;
  scheduledKeyboardLayouts.length = 0;
  springTargets.length = 0;
  groupState = { groups: [], groupsByPerson: {} };
  focusEpoch = 0;
  homeOwnerFocused = true;
  routes.length = 0;
  toasts.length = 0;
  writes.length = 0;
  homePreferenceMeta.clear();
  archivedPeople.length = 0;
  archiveFailures.clear();
  delayedArchive = null;
  contactsReads = 0;
  permissionRequests = 0;
  activeVaultsOverride = null;
  homeReadScopes.length = 0;
  dirty = true;
}
async function flush() {
  for (let turn = 0; turn < 30; turn++) {
    if (dirty) {
      dirty = false;
      cursor = 0;
      tree = screen();
    }
    const batch = effects.splice(0);
    batch.forEach((effect) => effect());
    await Promise.resolve();
  }
  assert.equal(dirty, false, "fixture reached a stable render");
}
async function runTimers() {
  const scheduled = [...timers.values()];
  timers.clear();
  scheduled.forEach((fn) => fn());
  await flush();
}
function changeAppState(next: string) {
  appState = next;
  for (const listener of [...appListeners]) listener(next);
}
function applyRole(next: typeof role) {
  role = next;
  roleHooks.invalidateVaultRoleCache(vaultId!);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
}
const personRows = () =>
  nodes(tree).filter(
    (node) =>
      node.type === "Pressable" &&
      node.props.accessibilityRole === "button" &&
      nodes(node).some(
        (child) =>
          child.type === "Text" &&
          [...peopleByVault.values()].flat().some((person) => child.props.children === person.name),
      ),
  );

async function main() {
  fixture(addOrFind, "viewer");
  let resolveInitialRole!: () => void;
  delayedRole = new Promise((resolve) => {
    resolveInitialRole = resolve;
  });
  await flush();
  assert.equal(
    find("Header")?.props.title,
    "personFind.title",
    "role lookup starts in find-only mode",
  );
  assert.equal(find("Button"), undefined);
  assert.equal(contactsReads, 0, "unresolved role never starts a phone-book read");
  resolveInitialRole();
  await flush();
  assert.equal(contactsReads, 0, "resolved viewer never starts a phone-book read");

  const homePages = () => nodes(tree).filter((node) => "filterTotal" in node.props);
  const homeSearch = () => {
    const sheet = find("SearchSheet");
    return sheet?.props.visible
      ? nodes(
          typeof sheet.props.children === "function"
            ? sheet.props.children(0)
            : sheet.props.children,
        ).find((node) => "people" in node.props)
      : undefined;
  };
  const homeIds = () => {
    const results = homeSearch();
    return results
      ? results.props.people.map((person: any) => person.id)
      : [
          ...new Set(
            homePages().flatMap((page) =>
              [...page.props.people, ...page.props.neverTalliedPeople].map(
                (person: any) => person.id,
              ),
            ),
          ),
        ];
  };
  // Expand the stateless local list views so assertions reach actual headings,
  // empty states and row handlers, rather than just their parent props.
  const renderList = (node: any): any => {
    if (Array.isArray(node)) return node.map(renderList);
    if (!node?.props) return node;
    if (typeof node.type === "function") return renderList(node.type(node.props));
    return { ...node, props: { ...node.props, children: renderList(node.props.children) } };
  };

  // Exercise the real home handlers, not a second implementation of selection.
  // Selection lives in the combined search sheet. Its select-all includes
  // both financial directions and each no-tally contact exactly once.
  const homeRows = () =>
    nodes(renderList(homeSearch() ?? homePages())).filter((node) => node.type === "PersonRow");
  const homeRow = (id: string) => homeRows().find((node) => node.props.person.id === id)!;
  const selection = () => find("SelectionToolbar");
  const balanceTotals = () => {
    const { collect, pay, pending } = selection()!.props.financialSummary;
    return { collect, pay, pending };
  };
  const openHomeSearch = async () => {
    await flush();
    if (!find("SearchSheet")?.props.visible) {
      if (selection()) {
        selection()!.props.onClose();
        await flush();
      }
      byLabel("customers.search")!.props.onPress();
      await flush();
    }
    assert.equal(find("SearchSheet")!.props.visible, true);
  };
  const changeHomeQuery = async (query: string) => {
    await openHomeSearch();
    find("SearchSheet")!.props.onChangeQuery(query);
    await flush();
  };
  const closeHomeSearch = async () => {
    find("SearchSheet")!.props.onDismiss();
    await flush();
  };
  const selectedHomeIds = () => [
    ...new Set(
      homeRows()
        .filter((row) => row.props.selected)
        .map((row) => row.props.person.id),
    ),
  ];
  const openSelection = async () => {
    assert.equal(
      byLabel("selection.contacts"),
      undefined,
      "the page indicators do not have a duplicate selection trigger",
    );
    const row = homeRows().find((candidate) => typeof candidate.props.onLongPress === "function");
    assert.ok(row, "eligible members can select contacts");
    row.props.onLongPress(row.props.person);
    await flush();
    if (homeSearch()) {
      assert.equal(
        find("BottomSheet")!.props.visible,
        false,
        "search long press selects directly without stacking a modal",
      );
    } else {
      const sheet = find("BottomSheet")!;
      assert.equal(sheet.props.visible, true);
      const action = sheet.props.actions.find((item: any) => item.label === "selection.start");
      assert.ok(action, "the contact action sheet offers Select");
      sheet.props.onDismiss();
      await flush();
      action.onPress();
      await flush();
    }
    assert.ok(selection(), "the sheet's Select action opens the selection toolbar");
    assert.equal(selection()!.props.count, 1, "Select preselects the long-pressed contact");
    assert.deepEqual(selectedHomeIds(), [row.props.person.id]);
    homeRow(row.props.person.id).props.onPress(row.props.person);
    await flush();
    assert.equal(selection()!.props.count, 0, "the starting contact can be deselected");
  };
  const removeSelected = async () => {
    const action = selection()?.props.actions.find((item: any) => item.key === "remove");
    assert.ok(action, "selected contacts offer Remove");
    action.onPress();
    await flush();
    const dialog = nodes(tree).find(
      (node) =>
        node.type === "ConfirmDialog" && node.props.title === "selection.removeContactsTitle",
    );
    assert.ok(dialog?.props.visible, "bulk removal waits for a count-specific confirmation");
    return dialog;
  };

  // Both real pages remain mounted, with separate native scroll owners. The
  // off-screen page must not expose touch or accessibility targets.
  for (const nextRtl of [false, true]) {
    fixture(home, "owner", nextRtl);
    const payPerson = { ...people[0], id: "pay-person", balance: -200 };
    peopleByVault.set("kaata", [...people, payPerson]);
    await flush();
    const pages = homePages();
    assert.deepEqual(pages.map((page) => page.props.direction), ["collect", "pay"]);
    assert.notEqual(pages[0].props.scrollRef, pages[1].props.scrollRef,
      "Each side retains its own native scroll owner");
    const collectRef = pages[0].props.scrollRef, payRef = pages[1].props.scrollRef;
    const hiddenPage = renderList(pages[1]);
    assert.equal(hiddenPage.props.pointerEvents, "none");
    assert.equal(hiddenPage.props.accessibilityElementsHidden, true);
    assert.equal(hiddenPage.props.importantForAccessibility, "no-hide-descendants");
    pages[1].props.onPersonPress(payPerson);
    pages[1].props.onPersonLongPress(payPerson);
    await flush();
    assert.equal(routes.length, 0, "Inactive financial-side callbacks cannot navigate");
    assert.equal(find("BottomSheet")!.props.visible, false);
    const oldCollectRow = homeRow("ahmad");
    find("Tabs")!.props.onChange("pay");
    await flush();
    assert.equal(homePages()[0].props.scrollRef, collectRef);
    assert.equal(homePages()[1].props.scrollRef, payRef,
      "Tab changes retain both independent native scroll owners");
    oldCollectRow.props.onPress(people[0]);
    oldCollectRow.props.onLongPress(people[0]);
    await flush();
    assert.equal(routes.length, 0, "A queued Collect callback cannot navigate from Pay");
    assert.equal(find("BottomSheet")!.props.visible, false);
    const activePage = renderList(homePages()[1]);
    assert.equal(activePage.props.pointerEvents, "auto");
    assert.equal(activePage.props.accessibilityElementsHidden, false);
    find("Tabs")!.props.onChange("collect");
    await flush();
    const coveredRow = homeRow("ahmad");
    await openHomeSearch();
    coveredRow.props.onPress(people[0]);
    coveredRow.props.onLongPress(people[0]);
    await flush();
    assert.equal(routes.length, 0, "Covered Home rows cannot navigate while search is open");
    assert.equal(find("BottomSheet")!.props.visible, false,
      "Covered Home rows cannot open a second action sheet");
  }
  for (const invalidation of ["vault", "account", "blur", "unmount"]) {
    fixture(home, "owner");
    await flush();
    const row = homeRow("ahmad");
    if (invalidation === "vault") vaultId = "replacement-kaata";
    if (invalidation === "account") cachedAccountId = "replacement-account";
    if (invalidation === "blur") {
      homeOwnerFocused = false;
      dirty = true;
      await flush();
    }
    if (invalidation === "unmount") unmount();
    dirty = false;
    row.props.onPress(people[0]);
    row.props.onLongPress(people[0]);
    assert.equal(routes.length, 0, `${invalidation}: old row cannot navigate`);
    assert.equal(dirty, false, `${invalidation}: old row cannot open actions or update state`);
  }

  for (const nextRtl of [false, true]) {
    fixture(home, "owner", nextRtl);
    const payPerson = { ...people[0], id: "pay-person", name: "Pay Person", balance: -200 };
    peopleByVault.set("kaata", [...people, payPerson]);
    await flush();
    await openSelection();
    assert.equal(selection()!.props.count, 0, "the preselected contact was cleared by the helper");
    assert.equal(
      selection()!.props.total,
      3,
      "both financial sides and no-tally contacts are selectable together",
    );
    assert.ok(
      homeRows().some((row) => row.props.selecting),
      "rows expose selection mode",
    );
    homeRow("ahmad").props.onPress(people[0]);
    await flush();
    assert.equal(routes.length, 0, "selection taps do not navigate into the contact");
    assert.equal(selection()!.props.count, 1);
    assert.deepEqual(selectedHomeIds(), ["ahmad"]);
    homeRow("ahmad").props.onPress(people[0]);
    await flush();
    assert.equal(selection()!.props.count, 0, "a selected row can be deselected");
    selection()!.props.onToggleAll();
    await flush();
    assert.equal(selection()!.props.count, 3, "select-all includes no-tally contacts once");
    assert.deepEqual(selectedHomeIds().sort(), ["ahmad", "fatima", "pay-person"]);
    find("Tabs")!.props.onChange("pay");
    await flush();
    assert.equal(selection()!.props.count, 3, "overview tabs do not prune sheet selections");
    assert.deepEqual(selectedHomeIds().sort(), ["ahmad", "fatima", "pay-person"]);
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(selectedHomeIds(), []);
    find("Tabs")!.props.onChange("collect");
    await flush();
    assert.deepEqual(selectedHomeIds(), []);
    selection()!.props.onToggleAll();
    await flush();
    selection()!.props.onToggleAll();
    await flush();
    assert.equal(selection()!.props.count, 0, "select-all toggles back to an empty selection");
    selection()!.props.onToggleAll();
    await flush();
    selection()!.props.onClose();
    await flush();
    await openHomeSearch();
    assert.equal(selection(), undefined, "Done returns the sheet to ordinary search");
    const changeSelectionQuery = find("SearchSheet")!.props.onChangeQuery;
    await openSelection();
    selection()!.props.onToggleAll();
    await flush();
    changeSelectionQuery("فاطمه");
    await flush();
    assert.equal(
      selection()!.props.count,
      3,
      "search retains selected contacts outside the result",
    );
    assert.deepEqual(selectedHomeIds(), ["fatima"]);
    changeSelectionQuery("nobody");
    await flush();
    assert.equal(selection()!.props.count, 3, "empty search retains existing selected contacts");
    assert.equal(selection()!.props.total, 0);
    changeSelectionQuery("");
    await flush();
    assert.equal(
      selection()!.props.count,
      3,
      "clearing search reveals the same retained selections",
    );
    selection()!.props.onClose();
    await flush();
    assert.equal(selection(), undefined, "Done exits selection mode");
    assert.ok(homeRows().every((row) => !row.props.selecting && !row.props.selected));
    assert.equal(archivedPeople.length, 0, "selecting and closing do not write ledger data");
  }

  // Search can select both financial sides. Keep each side's current balance,
  // including cents, instead of netting debts and credits or summing tallies.
  for (const nextRtl of [false, true]) {
    fixture(home, "owner", nextRtl);
    const creditA = { ...people[0], id: "credit-a", name: "Team Alpha", balance: 0.1 };
    const creditB = { ...people[0], id: "credit-b", name: "Team Beta", balance: 0.2 };
    const payA = { ...people[0], id: "pay-a", name: "Team Gamma", balance: -0.29 };
    const payB = { ...people[0], id: "pay-b", name: "Team Delta", balance: -0.11 };
    const neutral = { ...people[1], id: "neutral", name: "Team Neutral" };
    const outsideSearch = { ...people[0], id: "other", name: "Other", balance: 999 };
    peopleByVault.set("kaata", [creditA, creditB, payA, payB, neutral, outsideSearch]);
    groupState = {
      groups: [{ id: "family", name: "Family", member_count: 2 }],
      groupsByPerson: { "credit-b": ["family"], "pay-b": ["family"] },
    };
    await flush();
    await openHomeSearch();
    const changeTotalsQuery = find("SearchSheet")!.props.onChangeQuery;
    changeTotalsQuery("Team");
    await flush();
    await openSelection();
    assert.deepEqual(balanceTotals(), { collect: 0, pay: 0, pending: false });
    selection()!.props.onToggleAll();
    await flush();
    assert.equal(selection()!.props.count, 5, "mixed search selects both sides and neutral once");
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.3, pay: 0.4, pending: false },
      "selected debt and credit balances sum independently with exact cents",
    );
    homeRow("credit-b").props.onPress(creditB);
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.1, pay: 0.4, pending: false });
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.3, pay: 0.4, pending: false });
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(
      balanceTotals(),
      { collect: 0, pay: 0, pending: false },
      "deselect-all immediately clears both amounts",
    );
    homeRow("credit-a").props.onPress(creditA);
    homeRow("pay-a").props.onPress(payA);
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.1, pay: 0.29, pending: false });
    find("CustomerListOptions")!.props.onChange({ sort: "recent", group: "family" });
    await flush();
    assert.equal(selection()!.props.count, 2, "a group filter retains both hidden selections");
    assert.deepEqual(balanceTotals(), { collect: 0.1, pay: 0.29, pending: false });
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.3, pay: 0.4, pending: false });
    find("CustomerListOptions")!.props.onChange({ sort: "recent", group: "all" });
    await flush();
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.3, pay: 0.4, pending: false },
      "clearing a filter never adds the newly visible contacts to the sums",
    );

    const changedCredit = { ...creditB, balance: -10.01 };
    peopleByVault.set("kaata", [creditA, changedCredit, payA, payB, neutral, outsideSearch]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.equal(selection()!.props.count, 4);
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.1, pay: 10.41, pending: false },
      "live balance changes move a selected contact between debt and credit totals",
    );
    peopleByVault.set("kaata", [creditA, payA, payB, neutral, outsideSearch]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.1, pay: 0.4, pending: false },
      "a remotely removed contact leaves the sum together with the selection",
    );
    changeTotalsQuery("Team Alpha");
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.1, pay: 0.4, pending: false });
    assert.equal(selection()!.props.count, 3, "narrowing search retains all selected balances");

    selection()!.props.onClose();
    changeTotalsQuery("Team");
    const unknown: FixturePerson = {
      ...people[0],
      id: "unknown",
      name: "Team Unsynced",
      balance: 500,
      tab_id: "shared-ledger",
      tab_unsynced: 1,
    };
    peopleByVault.set("kaata", [creditA, creditB, payA, payB, neutral, unknown]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    await openSelection();
    selection()!.props.onToggleAll();
    await flush();
    assert.equal(selection()!.props.count, 6, "an unsynced shared contact remains selectable");
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.3, pay: 0.4, pending: true },
      "an unknown shared balance marks totals pending and excludes its stale amount",
    );
    homeRow("unknown").props.onPress(unknown);
    await flush();
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.3, pay: 0.4, pending: false },
      "deselecting the unknown contact restores precise selected totals",
    );
    homeRow("unknown").props.onPress(unknown);
    await flush();
    peopleByVault.set("kaata", [
      creditA,
      creditB,
      payA,
      payB,
      neutral,
      { ...unknown, balance: -2.25, tab_unsynced: 0 },
    ]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.deepEqual(
      balanceTotals(),
      { collect: 0.3, pay: 2.65, pending: false },
      "the first shared sync replaces pending state with the current signed balance",
    );
    assert.equal(archivedPeople.length, 0, "selection totals never write financial data");
  }

  fixture(home, "owner");
  groupState = {
    groups: [{ id: "family", name: "Family", member_count: 1 }],
    groupsByPerson: { ahmad: ["family"] },
  };
  await flush();
  await openHomeSearch();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  find("CustomerListOptions")!.props.onChange({ sort: "recent", group: "family" });
  await flush();
  assert.equal(selection()!.props.count, 2, "group filtering retains hidden selected contacts");
  assert.deepEqual(selectedHomeIds(), ["ahmad"]);
  selection()!.props.onToggleAll();
  await flush();
  assert.equal(selection()!.props.count, 1, "clear visible keeps the hidden selected contact");
  selection()!.props.onToggleAll();
  await flush();
  assert.equal(selection()!.props.count, 2, "select-all adds only the visible group to selection");
  applyRole("viewer");
  await flush();
  await runTimers();
  assert.equal(selection(), undefined, "a role downgrade closes contact selection");
  assert.equal(byLabel("selection.contacts"), undefined);
  assert.deepEqual(selectedHomeIds(), []);

  fixture(home, "owner");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  peopleByVault.set("kaata", [people[1]]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(selection()!.props.count, 1, "a remotely removed contact leaves the selection");
  assert.deepEqual(selectedHomeIds(), ["fatima"]);

  fixture(home, "owner");
  persistedAccountId = cachedAccountId = "first-account";
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  cachedAccountId = "next-account";
  for (const listener of [...identityListeners]) listener();
  await flush();
  assert.equal(selection(), undefined, "switching account clears contact selection");
  assert.deepEqual(selectedHomeIds(), []);

  fixture(home, "owner");
  await flush();
  await openSelection();
  homeRow("ahmad").props.onPress(people[0]);
  await flush();
  // The native search modal owns Android Back. Model its dismissal boundary;
  // the parent home's Back handler is not dispatched through an open modal.
  await closeHomeSearch();
  assert.equal(selection(), undefined, "dismissing search leaves selection before leaving home");
  assert.equal(
    toasts.some((message) => message[0] === "home.exit.hint"),
    false,
  );

  fixture(home, "owner");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  const cancelRemoval = await removeSelected();
  assert.equal(tParams.get("selection.removeContactsTitle")?.count, 2);
  cancelRemoval.props.onCancel();
  await flush();
  assert.equal(archivedPeople.length, 0, "cancelling bulk confirmation never removes contacts");
  assert.equal(selection()!.props.count, 2, "cancel keeps the selection available");
  const staleRemoval = await removeSelected();
  vaultId = "second-kaata";
  peopleByVault.set(vaultId, [{ ...people[0], id: "second-person" }]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(selection(), undefined, "switching kaata clears selection and its toolbar");
  await staleRemoval.props.onConfirm();
  await flush();
  assert.equal(archivedPeople.length, 0, "a stale confirmation cannot mutate the next kaata");

  fixture(home, "owner");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  let finishArchive!: () => void;
  delayedArchive = new Promise((resolve) => {
    finishArchive = resolve;
  });
  const doubleRemoval = await removeSelected();
  const firstRemoval = doubleRemoval.props.onConfirm();
  const secondRemoval = doubleRemoval.props.onConfirm();
  await flush();
  assert.equal(archivedPeople.length, 1, "a double confirmation starts only one batch");
  assert.equal(selection()!.props.busy, true, "the toolbar locks while a batch is in flight");
  finishArchive();
  await Promise.all([firstRemoval, secondRemoval]);
  await flush();
  assert.deepEqual(archivedPeople.map((person) => person.id).sort(), ["ahmad", "fatima"]);
  assert.ok(archivedPeople.every((person) => person.vaultId === "kaata"));
  assert.deepEqual(homeIds(), [], "completed removals refresh the visible contact list");
  assert.equal(
    tParams.get("selection.contactsRemoved")?.count,
    2,
    "success counts completed writes",
  );

  fixture(home, "owner");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  let finishScopedArchive!: () => void;
  delayedArchive = new Promise((resolve) => {
    finishScopedArchive = resolve;
  });
  const scopedRemoval = await removeSelected();
  scopedRemoval.props.onConfirm();
  await flush();
  assert.equal(archivedPeople.length, 1);
  vaultId = "next-kaata";
  peopleByVault.set(vaultId, [{ ...people[0], id: "next-person" }]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  finishScopedArchive();
  await flush();
  assert.equal(archivedPeople.length, 1, "a scope switch during a batch stops remaining writes");
  assert.equal(archivedPeople[0].vaultId, "kaata");
  assert.deepEqual(
    homeIds(),
    ["next-person"],
    "the finished old write cannot replace the new kaata",
  );

  fixture(home, "owner");
  archiveFailures.add("fatima");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  const partialRemoval = await removeSelected();
  await partialRemoval.props.onConfirm();
  await flush();
  assert.deepEqual(archivedPeople.map((person) => person.id).sort(), ["ahmad", "fatima"]);
  assert.deepEqual(homeIds(), ["fatima"], "a failed archive does not conceal the failed contact");
  assert.equal(selection()!.props.count, 1, "failed contacts remain selected for retry");
  assert.equal(selection()!.props.busy, false, "a failed batch releases its busy guard");
  assert.deepEqual(selectedHomeIds(), ["fatima"]);
  assert.ok(
    toasts.some((message) => message[1] === "error"),
    "partial failure is reported",
  );
  assert.equal(
    tParams.get("selection.contactsRemoved")?.count,
    1,
    "partial success counts completed writes",
  );
  assert.equal(tParams.get("selection.partialFailure")?.count, 1);
  archiveFailures.clear();
  const retryRemoval = await removeSelected();
  retryRemoval.props.onConfirm();
  await flush();
  assert.deepEqual(
    archivedPeople.map((person) => person.id),
    ["ahmad", "fatima", "fatima"],
    "retry only writes the previously failed contact",
  );
  assert.deepEqual(homeIds(), []);

  for (const nextRole of ["viewer", "owner", "editor", "clerk"] as const)
    for (const nextPlatform of ["android", "ios"])
      for (const nextRtl of [false, true]) {
        fixture(home, nextRole, nextRtl, nextPlatform);
        screenWidth = 320;
        await flush();
        const trigger = byLabel("customers.search")!;
        const button = byLabel("personAdd.new");
        assert.ok(trigger, `${nextRole} has an input-style search trigger`);
        assert.equal(trigger.type, "SearchFieldTrigger");
        assert.equal(
          trigger.props.onChangeText,
          undefined,
          "the overview field opens the sheet instead of editing its list",
        );
        assert.equal(trigger.props.isRTL, nextRtl);
        assert.equal(
          byLabel("customers.listOptions"),
          undefined,
          "home has no filter or sort button",
        );
        assert.equal(button != null, nextRole !== "viewer", "only writers get Add");
        assert.equal(
          byLabel("selection.contacts"),
          undefined,
          "no duplicate Select beside page indicators",
        );
        const canSelect = nextRole === "owner" || nextRole === "editor";
        assert.equal(typeof homeRows()[0].props.onLongPress === "function", canSelect);
        assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
        const overviewScrolls = nodes(renderList(homePages())).filter(
          (node) => node.type === "ScrollView",
        );
        assert.equal(overviewScrolls.length, 2);
        assert.ok(
          overviewScrolls.every(
            (node) =>
              node.props.refreshControl?.type === "RefreshControl" &&
              typeof node.props.refreshControl.props.onRefresh === "function",
          ),
          "both homepage lists retain pull-to-refresh",
        );
        const overviewBefore = homePages().map((page) => ({
          people: page.props.people.map((person: any) => person.id),
          neutral: page.props.neverTalliedPeople.map((person: any) => person.id),
          total: page.props.allPeople.reduce((sum: number, person: any) => sum + person.balance, 0),
        }));
        await openHomeSearch();
        assert.deepEqual(
          homeIds(),
          ["ahmad", "fatima"],
          "an empty query shows both sides in the sheet",
        );
        assert.equal(find("SearchSheet")!.props.title, "customers.search.title");
        assert.equal(find("SearchSheet")!.props.resultSummary, "customers.search.results");
        assert.equal(tParams.get("customers.search.results")?.count, 2);
        assert.ok(
          find("CustomerListOptions"),
          "sort and group controls are inside the search sheet",
        );
        await changeHomeQuery("فاطمه");
        assert.deepEqual(homeIds(), ["fatima"], "Dari search reaches no-tally contacts");
        const results = homeSearch()!;
        const resultTree = renderList(results);
        assert.equal(find("SearchSheet")!.props.resultSummary, "customers.search.result");
        assert.equal(tParams.get("customers.search.result")?.count, 1);
        assert.equal(
          nodes(resultTree).some(
            (node) =>
              node.type === "Text" &&
              ["customers.search.result", "customers.search.results"].includes(node.props.children),
          ),
          false,
          "The scrolling list does not duplicate the shared summary count",
        );
        assert.equal(
          nodes(resultTree).filter((node) => node.type === "ScrollView").length,
          1,
          "all matches share one scroll list",
        );
        const resultScroll = nodes(resultTree).find((node) => node.type === "ScrollView")!;
        assert.equal(
          resultScroll.props.refreshControl,
          undefined,
          "search has no refresh spinner to intercept a downward sheet gesture",
        );
        assert.equal(
          resultScroll.props.keyboardDismissMode,
          "on-drag",
          "search dismisses the keyboard on drag like Add Customer",
        );
        assert.notEqual(
          resultScroll.props.bounces,
          false,
          "search preserves native overscroll for iOS modal gesture handoff",
        );
        assert.equal(results.props.refreshing, undefined);
        assert.equal(results.props.onRefresh, undefined);
        assert.equal(
          nodes(resultTree).filter((node) => node.type === "Tabs" || node.type === "Gesture")
            .length,
          0,
          "results never require switching pages",
        );
        assert.equal(results.props.onPersonLongPress != null, canSelect);
        assert.deepEqual(
          homePages().map((page) => ({
            people: page.props.people.map((person: any) => person.id),
            neutral: page.props.neverTalliedPeople.map((person: any) => person.id),
            total: page.props.allPeople.reduce(
              (sum: number, person: any) => sum + person.balance,
              0,
            ),
          })),
          overviewBefore,
          "search never changes the overview rows, order or totals",
        );
        await changeHomeQuery("۰۷۰۰۱۲۳۴۵۶");
        assert.deepEqual(homeIds(), ["ahmad"], "localized phone digits find E.164 customers");
        await changeHomeQuery("nobody");
        assert.deepEqual(homeIds(), []);
        assert.equal(find("SearchSheet")!.props.resultSummary, "customers.search.results");
        assert.equal(tParams.get("customers.search.results")?.count, 0);
        assert.equal(
          nodes(renderList(homeSearch()!)).filter((node) => node.type === "EmptyState").length,
          1,
        );
        const staleQuery = find("SearchSheet")!.props.onChangeQuery;
        await closeHomeSearch();
        assert.equal(homeSearch(), undefined);
        assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
        assert.equal(
          trigger.props.placeholder,
          "customers.search",
          "the overview trigger never displays a persisted search",
        );
        staleQuery("stale callback");
        await flush();
        await openHomeSearch();
        assert.equal(
          find("SearchSheet")!.props.query,
          "nobody",
          "close and reopen remembers the query and ignores stale updates",
        );
        find("SearchSheet")!.props.onClearAll();
        await flush();
        assert.equal(find("SearchSheet")!.props.query, "");
        assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
        await closeHomeSearch();
        assert.equal(contactsReads, 0, "search never reads the phone book");
        assert.equal(permissionRequests, 0);
        assert.equal(writes.length, 0, "search never creates ledger data");
        if (button) {
          await button.props.onPress();
          assert.deepEqual(routes.at(-1), { pathname: "/person/new", params: { mode: "add" } });
          archivedState = "archived";
          await button.props.onPress();
          assert.equal(routes.length, 1, "archived kaata cannot enter add");
        }
      }

  for (const nextPlatform of ["android", "ios"]) {
    fixture(home, "viewer", false, nextPlatform);
    await flush();
    await changeHomeQuery("RemoteMatch");
    assert.deepEqual(homeIds(), []);
    const remotePerson = { ...people[0], id: "search-live", name: "RemoteMatch", balance: 75 };
    peopleByVault.set("kaata", [...people, remotePerson]);
    ledgerEvents.emitLedgerApplied("kaata", "remote");
    await runTimers();
    assert.equal(find("SearchSheet")!.props.visible, true);
    assert.equal(find("SearchSheet")!.props.query, "RemoteMatch");
    assert.deepEqual(
      homeIds(),
      ["search-live"],
      "synced contacts update open search without a pull",
    );

    changeAppState("background");
    peopleByVault.set("kaata", [
      ...people,
      remotePerson,
      { ...remotePerson, id: "search-resume", name: "RemoteMatch Resume" },
    ]);
    changeAppState("active");
    await flush();
    assert.deepEqual(
      homeIds(),
      ["search-live", "search-resume"],
      "resuming the app reloads open search without its own refresh control",
    );
    await closeHomeSearch();
    assert.deepEqual(
      new Set(homeIds()),
      new Set(["ahmad", "fatima", "search-live", "search-resume"]),
      "the overview receives the same live and resume updates",
    );
  }

  fixture(home, "owner");
  await flush();
  await changeHomeQuery("Ahmad");
  const staleSearchRow = homeSearch()!.props.onPersonPress;
  await openSelection();
  homeRow("ahmad").props.onPress(people[0]);
  await flush();
  assert.equal(selection()!.props.count, 1);
  assert.equal(
    find("SearchSheet")!.props.footer.type,
    "SelectionToolbar",
    "selected totals live in the search sheet footer",
  );
  assert.ok(
    homePages().every((page) => !page.props.selecting),
    "underlying home rows never enter the sheet's selection mode",
  );
  selection()!.props.actions[0].onPress();
  await flush();
  const searchConfirmation = find("SearchSheet")!.props.confirmation;
  assert.equal(searchConfirmation.visible, true, "search owns its removal confirmation");
  assert.equal(
    find("SearchSheet")!.props.footer.type,
    "SelectionToolbar",
    "confirmation leaves the selected financial summary mounted",
  );
  searchConfirmation.onCancel();
  await flush();
  assert.equal(selection()!.props.count, 1, "cancelling keeps the search selection");
  await closeHomeSearch();
  assert.equal(selection(), undefined, "closing search ends its selection");
  staleSearchRow(people[0]);
  await flush();
  assert.equal(routes.length, 0, "a result callback cannot navigate after search closes");
  await openHomeSearch();
  assert.equal(find("SearchSheet")!.props.query, "Ahmad");
  staleSearchRow(people[0]);
  await flush();
  assert.equal(
    routes.length,
    0,
    "a result from the previous search session cannot navigate after reopening",
  );
  await openSelection();
  homeRow("ahmad").props.onPress(people[0]);
  await flush();
  selection()!.props.actions[0].onPress();
  await flush();
  let finishSearchRemoval!: () => void;
  delayedArchive = new Promise((resolve) => {
    finishSearchRemoval = resolve;
  });
  find("SearchSheet")!.props.confirmation.onConfirm();
  await flush();
  assert.equal(
    find("SearchSheet")!.props.dismissDisabled,
    true,
    "search drag and dismiss are disabled while removal is running",
  );
  find("SearchSheet")!.props.onChangeQuery("queued input");
  find("CustomerListOptions")!.props.onChange({ sort: "name_desc", group: "all" });
  find("SearchSheet")!.props.onClearAll();
  await flush();
  assert.equal(
    find("SearchSheet")!.props.query,
    "Ahmad",
    "queued search and Clear all callbacks cannot change an in-flight removal",
  );
  assert.equal(
    find("CustomerListOptions")!.props.preference.sort,
    "outstanding_name",
    "queued filter callbacks cannot change an in-flight removal",
  );
  find("SearchSheet")!.props.onDismiss();
  await flush();
  assert.equal(find("SearchSheet")!.props.visible, true);
  finishSearchRemoval();
  await flush();
  assert.equal(find("SearchSheet")!.props.dismissDisabled, false);
  assert.deepEqual(
    archivedPeople.map((person) => person.id),
    ["ahmad"],
  );

  fixture(home, "viewer");
  persistedAccountId = cachedAccountId = "first-account";
  groupState = {
    groups: [{ id: "family", name: "Family", member_count: 1 }],
    groupsByPerson: { ahmad: ["family"] },
  };
  homePreferenceMeta.set(
    "customer_search:first-account:kaata",
    JSON.stringify({ sort: "amount_asc", group: "family" }),
  );
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad", "fatima"],
    "stored search filters never apply to the home overview",
  );
  await openHomeSearch();
  assert.deepEqual(homeIds(), ["ahmad"], "stored search preference is loaded only into its sheet");
  await changeHomeQuery("Ahmad");
  const oldScopeQuery = find("SearchSheet")!.props.onChangeQuery;
  const oldScopePreference = find("CustomerListOptions")!.props.onChange;
  const oldScopeTrigger = byLabel("customers.search")!.props.onPress;
  cachedAccountId = "second-account";
  for (const listener of [...identityListeners]) listener();
  await flush();
  assert.equal(find("SearchSheet")!.props.visible, false, "an account change closes search");
  assert.equal(find("SearchSheet")!.props.query, "", "an account change clears the old query");
  oldScopeQuery("old account query");
  oldScopePreference({ sort: "name_desc", group: "family" });
  oldScopeTrigger();
  await flush();
  assert.equal(
    find("SearchSheet")!.props.visible,
    false,
    "stale field callbacks cannot reopen another account's search",
  );
  await openHomeSearch();
  assert.deepEqual(find("CustomerListOptions")!.props.preference, {
    sort: "outstanding_name",
    group: "all",
  });
  assert.deepEqual(
    homeIds(),
    ["ahmad", "fatima"],
    "another account starts with its own search preferences",
  );
  find("CustomerListOptions")!.props.onChange({ sort: "name_desc", group: "all" });
  await flush();
  assert.equal(
    JSON.parse(homePreferenceMeta.get("customer_search:second-account:kaata")!).sort,
    "name_desc",
  );
  cachedAccountId = "first-account";
  for (const listener of [...identityListeners]) listener();
  await flush();
  await openHomeSearch();
  assert.deepEqual(
    find("CustomerListOptions")!.props.preference,
    { sort: "amount_asc", group: ["family"] },
    "returning to an account restores only its own saved preference",
  );
  assert.equal(find("SearchSheet")!.props.query, "");
  vaultId = "next-kaata";
  peopleByVault.set(vaultId, [{ ...people[0], id: "next-person", name: "Next Person" }]);
  activeVaultsOverride = [{ id: vaultId, name: "Next", currency: "AFN" }];
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(find("SearchSheet")!.props.visible, false);
  await openHomeSearch();
  assert.deepEqual(
    find("CustomerListOptions")!.props.preference,
    { sort: "outstanding_name", group: "all" },
    "new kaata does not inherit the old kaata's search filters",
  );
  assert.deepEqual(homeIds(), ["next-person"]);

  fixture(home, "owner");
  let finishHomeRole!: () => void;
  delayedRole = new Promise((resolve) => {
    finishHomeRole = resolve;
  });
  await flush();
  assert.equal(byLabel("personAdd.new"), undefined, "unresolved role never flashes the plus");
  assert.ok(
    !nodes(tree).some((node) => node.type === "Text" && node.props.children === "readonly.badge"),
    "owner role lookup never temporarily labels the kaata read-only",
  );
  assert.ok(byLabel("customers.search"));
  delayedRole = null;
  finishHomeRole();
  await flush();
  const staleHomeAdd = byLabel("personAdd.new")!.props.onPress;
  let finishHomeGuard!: (value: { state: string }) => void;
  delayedGuard = new Promise((resolve) => {
    finishHomeGuard = resolve;
  });
  const lateAdd = staleHomeAdd();
  applyRole("viewer");
  await flush();
  finishHomeGuard({ state: "active" });
  await lateAdd;
  assert.equal(routes.length, 0, "role downgrade during add guard blocks navigation");
  assert.equal(byLabel("personAdd.new"), undefined);
  assert.ok(
    nodes(tree).some((node) => node.type === "Text" && node.props.children === "readonly.badge"),
    "completed downgrade labels the resolved viewer correctly",
  );
  assert.ok(byLabel("customers.search"));

  fixture(home, "viewer");
  await flush();
  await changeHomeQuery("Ahmad");
  await flush();
  const oldHomePersonTap = homeSearch()!.props.onPersonPress;
  const otherPerson = { ...people[0], id: "nadia", name: "Nadia", last_entry_at: 200 };
  vaultId = "second-kaata";
  peopleByVault.set(vaultId, [otherPerson]);
  activeVaultsOverride = [{ id: vaultId, name: "Second", currency: "AFN" }];
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(find("SearchSheet")!.props.query, "", "kaata switch clears the old query");
  assert.deepEqual(homeIds(), ["nadia"]);
  oldHomePersonTap(people[0]);
  assert.equal(routes.length, 0, "old search row cannot navigate after a kaata switch");

  for (const nextPlatform of ["android", "ios"]) {
    fixture(home, "viewer", false, nextPlatform);
    const mixedDefaultPeople = [
      { ...people[0], id: "zara", name: "Zara collect", balance: 100, last_entry_at: 100 },
      { ...people[0], id: "ali", name: "Ali pay", balance: -700, last_entry_at: 10 },
      {
        ...people[0],
        id: "shared-unknown",
        name: "Aaron shared",
        balance: 500,
        tab_id: "shared-tab",
        tab_unsynced: 1 as const,
      },
      {
        ...people[0],
        id: "settled",
        name: "Behram settled",
        balance: 0,
        is_settled: 1,
        last_entry_at: 600,
      },
      { ...people[0], id: "zero", name: "Ahmad zero", balance: 0, last_entry_at: 500 },
      { ...people[1], id: "empty", name: "Zaid empty", created_at: 900 },
    ];
    peopleByVault.set("kaata", mixedDefaultPeople);
    await flush();
    const overviewBefore = homePages().map((page) => ({
      people: page.props.people.map((person: any) => person.id),
      neutral: page.props.neverTalliedPeople.map((person: any) => person.id),
      total: page.props.allPeople.reduce((sum: number, person: any) => sum + person.balance, 0),
    }));
    await openHomeSearch();
    assert.deepEqual(find("CustomerListOptions")!.props.preference, {
      sort: "outstanding_name",
      group: "all",
    });
    assert.equal(
      find("SearchSheet")!.props.filtersActive,
      false,
      "the default sort is not a filter",
    );
    assert.deepEqual(
      homeIds(),
      ["ali", "zara", "shared-unknown", "zero", "settled", "empty"],
      "blank search lists known balances alphabetically, then unknown, then zero/settled contacts",
    );
    const unifiedResults = renderList(homeSearch()!);
    for (const key of ["home.tab.collect", "home.tab.pay", "customers.noTallies"]) {
      assert.equal(
        text(unifiedResults).includes(key),
        false,
        "search has no financial section headings",
      );
    }
    assert.equal(
      nodes(unifiedResults).filter((node) => node.type === "PersonRow").length,
      mixedDefaultPeople.length,
      "every contact appears exactly once in the combined list",
    );
    find("CustomerListOptions")!.props.onChange({ sort: "name_asc", group: "all" });
    await flush();
    assert.deepEqual(
      homeIds(),
      ["shared-unknown", "zero", "ali", "settled", "empty", "zara"],
      "the pure name option orders both directions and zero/settled contacts together",
    );
    assert.deepEqual(
      homePages().map((page) => ({
        people: page.props.people.map((person: any) => person.id),
        neutral: page.props.neverTalliedPeople.map((person: any) => person.id),
        total: page.props.allPeople.reduce((sum: number, person: any) => sum + person.balance, 0),
      })),
      overviewBefore,
      "changing the unified search sort preserves homepage rows, ordering and totals",
    );

    // Screenshot regression: recent scattered-character matches used to push
    // names containing the actual word احمد down the list. A later name token
    // is still a literal match, on either balance side and even at zero.
    fixture(home, "viewer", true, nextPlatform);
    const screenshotPeople = [
      {
        ...people[0],
        id: "fuzzy-newest",
        name: "اکبر حامد",
        balance: 900,
        last_entry_at: 1000,
      },
      {
        ...people[0],
        id: "literal-collect",
        name: "محمد شفیق احمد آباد",
        balance: 1600,
        last_entry_at: 10,
      },
      {
        ...people[0],
        id: "literal-pay",
        name: "نصیر احمد حمیدی",
        balance: -11840,
        last_entry_at: 20,
      },
      {
        ...people[0],
        id: "literal-zero",
        name: "فرید احمد",
        balance: 0,
        last_entry_at: 30,
      },
    ];
    peopleByVault.set("kaata", screenshotPeople);
    await flush();
    await changeHomeQuery("احمد");
    const literalIds = ["literal-collect", "literal-pay", "literal-zero"];
    for (const sort of ["outstanding_name", "recent"] as const) {
      find("CustomerListOptions")!.props.onChange({ sort, group: "all" });
      await flush();
      const ids = homeIds();
      assert.equal(ids.length, screenshotPeople.length, "loose abbreviations remain findable");
      assert.equal(
        ids.at(-1),
        "fuzzy-newest",
        `${sort} keeps literal names above a recent fuzzy match`,
      );
      assert.deepEqual(new Set(ids.slice(0, 3)), new Set(literalIds));
      if (sort === "outstanding_name") {
        assert.equal(ids[2], "literal-zero", "within literal matches, zero follows known balances");
      } else {
        assert.deepEqual(
          ids,
          ["literal-zero", "literal-pay", "literal-collect", "fuzzy-newest"],
          "recent orders equally relevant literal matches across all balance states",
        );
      }
    }
    await changeHomeQuery("۰۷۰۰۱۲۳۴۵۶");
    assert.deepEqual(
      new Set(homeIds()),
      new Set(screenshotPeople.map((person) => person.id)),
      "customer-name ranking preserves Persian-digit phone matching",
    );
    assert.equal(contactsReads, 0);
    assert.equal(writes.length, 0, "ranking never changes contact or ledger data");
  }

  fixture(home, "viewer");
  const ahmadLow = { ...people[0], id: "ahmad-low", name: "Ahmad Amini", balance: 100 };
  const ahmadHigh = { ...people[0], id: "ahmad-high", name: "Ahmad Zia", balance: 900 };
  const ahmadOther = { ...people[0], id: "ahmad-other", name: "Ahmad Hamidi", balance: -700 };
  peopleByVault.set("kaata", [people[0], ahmadLow, ahmadHigh, ahmadOther]);
  groupState = {
    groups: [
      { id: "family", name: "Family", member_count: 2 },
      { id: "shop", name: "Shop", member_count: 1 },
    ],
    groupsByPerson: {
      ahmad: ["family"],
      "ahmad-high": ["family", "shop"],
      "ahmad-other": ["shop"],
    },
  };
  await flush();
  await changeHomeQuery("Ahmad");
  await flush();
  find("CustomerListOptions")!.props.onChange({ sort: "amount_asc", group: ["family", "shop"] });
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad", "ahmad-other", "ahmad-high"],
    "search composes with multi-group OR and one amount order across both sides",
  );
  const mixedResults = renderList(homeSearch()!);
  assert.ok(!text(mixedResults).includes("home.tab.collect"));
  assert.ok(!text(mixedResults).includes("home.tab.pay"));
  assert.ok(
    nodes(mixedResults)
      .filter((node) => node.type === "PersonRow")
      .every((node) => node.props.showDirection === true),
    "direction belongs to each mixed row instead of separate section headings",
  );
  assert.equal(
    nodes(mixedResults).filter((node) => node.type === "PersonRow").length,
    3,
    "customers in multiple groups appear once across the combined list",
  );
  // A match on the opposite balance side is immediately visible, even when
  // searching started from To collect; no tab-switch link is required.
  await changeHomeQuery("Hamidi");
  await flush();
  assert.deepEqual(homeIds(), ["ahmad-other"]);
  const oppositeResults = renderList(homeSearch()!);
  assert.ok(!text(oppositeResults).includes("home.tab.pay"));
  assert.ok(!text(oppositeResults).includes("home.tab.collect"));
  assert.equal(nodes(oppositeResults).filter((node) => node.type === "EmptyState").length, 0);
  const oppositeRow = nodes(oppositeResults).find((node) => node.type === "PersonRow")!;
  assert.equal(oppositeRow.props.showDirection, true);
  oppositeRow.props.onPress(oppositeRow.props.person);
  assert.deepEqual(
    routes.at(-1),
    { pathname: "/person/[id]", params: { id: "ahmad-other" } },
    "opposite-side result opens that customer",
  );
  await changeHomeQuery("Ahmad");
  await flush();
  // Active filters are named and removable only inside the sheet.
  const groupedPage = homeSearch()!;
  assert.equal(groupedPage.props.groupFilterLabel, "Family, Shop", "home names the active groups");
  assert.equal(groupedPage.props.groupFilterCount, 2);
  assert.equal(
    byLabel("customers.listOptions"),
    undefined,
    "no homepage filter button or badge appears for search filters",
  );
  assert.equal(find("SearchSheet")!.props.filtersActive, true);
  assert.ok(
    homePages().every((page) => !page.props.filtered && page.props.groupFilterLabel === null),
  );
  const groupedTree = renderList(groupedPage);
  assert.ok(
    !text(groupedTree).includes("customers.filtered"),
    "search does not refer to a hidden total",
  );
  const groupChip = nodes(groupedTree).find(
    (node) => node.type === "Pressable" && node.props.accessibilityHint === "groups.clearFilter",
  );
  assert.ok(groupChip, "the active group filter is a chip on home");
  groupChip!.props.onPress();
  await flush();
  assert.equal(homeSearch()!.props.groupFilterLabel, null, "the chip clears the group filter");
  find("CustomerListOptions")!.props.onChange({ sort: "name_desc", group: "all" });
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad-high", "ahmad", "ahmad-other", "ahmad-low"],
    "name sorting orders both money directions together during search",
  );
  // Both previous pages survive a complete search session. A delayed swipe
  // callback from the old rail must not change that remembered page.
  await closeHomeSearch();
  await flush();
  assert.equal(find("Tabs")!.props.value, "collect");
  for (const previousDirection of ["collect", "pay"]) {
    find("Tabs")!.props.onChange(previousDirection);
    await flush();
    const oldGestureEnd = gestureHandlers.onEnd;
    await changeHomeQuery("Ahmad");
    await flush();
    assert.deepEqual(homeIds(), ["ahmad-high", "ahmad", "ahmad-other", "ahmad-low"]);
    oldGestureEnd({ translationX: previousDirection === "collect" ? -200 : 200, velocityX: 0 });
    await flush();
    await closeHomeSearch();
    await flush();
    assert.equal(find("Tabs")!.props.value, previousDirection);
    assert.equal(springTargets.at(-1), previousDirection === "collect" ? 0 : -screenWidth);
    oldGestureEnd({ translationX: previousDirection === "collect" ? -200 : 200, velocityX: 0 });
    await flush();
    assert.equal(
      find("Tabs")!.props.value,
      previousDirection,
      "a pre-search swipe remains invalid even after the original tab is restored",
    );
    assert.equal(
      homePages()
        .find((page) => page.props.direction === "collect")!
        .props.allPeople.reduce((sum: number, person: any) => sum + person.balance, 0),
      1500,
      "combined search never changes the normal overview totals",
    );
  }
  await changeHomeQuery("   ");
  await flush();
  assert.ok(homeSearch(), "whitespace keeps the combined search sheet open");
  await closeHomeSearch();
  assert.equal(find("Tabs")!.props.value, "pay");

  // Return to To pay after adding a contact with no financial activity. The
  // focus reload must keep it visible without assigning it a debt direction.
  fixture(home, "owner");
  await flush();
  find("Tabs")!.props.onChange("pay");
  await flush();
  const freshPerson = {
    ...people[1],
    id: "new-person",
    name: "Zarif New",
    created_at: 200,
  };
  peopleByVault.set("kaata", [...people, freshPerson]);
  focusEpoch++;
  dirty = true;
  await flush();
  assert.equal(find("Tabs")!.props.value, "pay", "adding a person does not jump balance tabs");
  for (const page of homePages()) {
    assert.deepEqual(
      page.props.neverTalliedPeople.map((person: any) => person.id),
      ["new-person", "fatima"],
      "the latest addition leads the neutral section on both pages",
    );
    const freshRow = nodes(renderList(page)).find(
      (node) => node.type === "PersonRow" && node.props.person.id === "new-person",
    )!;
    assert.ok(freshRow, "the saved no-tally contact is rendered and reachable");
    freshRow.props.onPress(freshRow.props.person);
    assert.deepEqual(routes.at(-1), { pathname: "/person/[id]", params: { id: "new-person" } });
    assert.ok(!page.props.allPeople.some((person: any) => person.id === "new-person"));
  }
  await changeHomeQuery("Zarif");
  await flush();
  assert.deepEqual(homeIds(), ["new-person"], "home search finds a saved no-tally contact");
  const neutralSearch = renderList(homeSearch()!);
  assert.equal(
    nodes(neutralSearch).filter((node) => node.type === "PersonRow").length,
    1,
    "the neutral contact is rendered once in combined search",
  );
  assert.ok(!text(neutralSearch).includes("home.tab.collect"));
  assert.ok(!text(neutralSearch).includes("home.tab.pay"));
  assert.ok(!text(neutralSearch).includes("customers.noTallies"));
  assert.equal(
    nodes(neutralSearch).find((node) => node.type === "PersonRow")!.props.showDirection,
    true,
    "empty contacts share the same mixed row presentation without a separate heading",
  );
  await closeHomeSearch();
  await flush();
  assert.equal(find("Tabs")!.props.value, "pay");

  // An active group filter remains explicit and removable; search should not
  // silently discard the user's filter just because the person is new.
  groupState = {
    groups: [
      { id: "family", name: "Family", member_count: 1 },
      { id: "newcomers", name: "Newcomers", member_count: 2 },
    ],
    groupsByPerson: { ahmad: ["family"], fatima: ["newcomers"], "new-person": ["newcomers"] },
  };
  focusEpoch++;
  dirty = true;
  await flush();
  await openHomeSearch();
  find("CustomerListOptions")!.props.onChange({ sort: "recent", group: "newcomers" });
  await flush();
  for (const page of homePages()) {
    assert.equal(page.props.filtered, false);
    assert.equal(page.props.groupFilterLabel, null);
    assert.equal(
      page.props.neverTalliedPeople.length,
      2,
      "search group filters never hide neutral contacts from home",
    );
  }
  find("CustomerListOptions")!.props.onChange({ sort: "recent", group: "family" });
  await flush();
  await changeHomeQuery("Zarif");
  await flush();
  assert.deepEqual(homeIds(), [], "selected groups still filter a new ungrouped contact");
  const clearNewPersonFilter = nodes(renderList(homeSearch()!)).find(
    (node) => node.type === "Pressable" && node.props.accessibilityHint === "groups.clearFilter",
  )!;
  assert.ok(clearNewPersonFilter, "the limiting group filter can be cleared from empty search");
  clearNewPersonFilter.props.onPress();
  await flush();
  assert.deepEqual(homeIds(), ["new-person"], "clearing the visible filter restores that match");
  assert.equal(writes.length, 0, "visibility and search do not create fake financial entries");

  peopleByVault.set("kaata", [...people, { ...freshPerson, balance: -250, last_entry_at: 300 }]);
  focusEpoch++;
  dirty = true;
  await flush();
  await openHomeSearch();
  assert.deepEqual(
    homeIds(),
    ["new-person"],
    "the first tally keeps the same saved contact findable",
  );
  const firstTallyResults = homeSearch()!;
  assert.deepEqual(
    firstTallyResults.props.people.map((person: any) => person.id),
    ["new-person"],
  );
  assert.deepEqual(
    firstTallyResults.props.people[0].balance,
    -250,
    "first activity updates the same mixed-list contact's balance",
  );
  assert.equal(
    nodes(renderList(firstTallyResults)).filter((node) => node.type === "PersonRow").length,
    1,
    "adding financial activity does not duplicate the contact",
  );

  fixture(home, "owner");
  peopleByVault = new Map([["kaata", []]]);
  dirty = true;
  await flush();
  assert.equal(
    byLabel("customers.listOptions"),
    undefined,
    "an empty kaata has nothing to sort or filter",
  );

  for (const nextRole of ["owner", "clerk"] as const) {
    fixture(addOrFind, nextRole);
    routeParams = { mode: "add" };
    deviceContacts.push({
      id: "duplicate-ahmad",
      name: "Ahmad Karimi",
      firstName: "Ahmad",
      lastName: "Karimi",
      phone: "+93700123456",
    });
    await flush();
    assert.equal(find("Header")!.props.title, "personAdd.new");
    assert.equal(personRows().length, 0, "add mode hides existing-person find results");
    assert.ok(
      text(tree).includes("Zarif Rahimi"),
      "new phone-book contact remains a creation shortcut",
    );
    assert.ok(
      !text(tree).includes("Ahmad Karimi"),
      "hidden app contact still deduplicates phone-book shortcut",
    );
    byLabel("personEdit.firstName.label")!.props.onChangeText("Ahmad");
    await flush();
    assert.ok(
      personRows().length > 0 && text(tree).includes("personAdd.section.existing"),
      "typing an existing customer's name shows them as already in this kaata",
    );
    byLabel("personEdit.firstName.label")!.props.onChangeText("");
    await flush();
    assert.equal(personRows().length, 0, "clearing the name hides them again");
    assert.equal(find("Button")!.props.label, "personAdd.new");
    byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
    await flush();
    find("Button")!.props.onPress();
    await flush();
    assert.equal(writes.length, 1, "add-only mode still creates authorized people");
    deviceContacts.pop();
  }
  fixture(addOrFind, "viewer");
  routeParams = { mode: "add" };
  await flush();
  assert.equal(
    find("Header")!.props.title,
    "personFind.title",
    "direct add link remains read-only for viewer",
  );
  assert.equal(find("Button"), undefined);
  assert.equal(contactsReads, 0);
  assert.equal(personRows().length, 2);
  fixture(home, "viewer");
  vaultId = "archived-kaata";
  const replacementPerson = { ...people[0], id: "replacement", name: "Replacement" };
  peopleByVault.set("archived-kaata", people);
  peopleByVault.set("surviving-kaata", [replacementPerson]);
  activeVaultsOverride = [{ id: "surviving-kaata", name: "Second", currency: "AFN" }];
  await flush();
  assert.equal(vaultId, "surviving-kaata");
  assert.equal(
    homeReadScopes.at(-1),
    "surviving-kaata",
    "archive fallback reloads the replacement kaata's complete list",
  );
  const renderedPeople = nodes(tree).flatMap((node) =>
    Array.isArray(node.props.people) ? node.props.people : [],
  );
  assert.ok(renderedPeople.some((person) => person.id === "replacement"));
  assert.ok(
    renderedPeople.every((person) => person.id === "replacement"),
    "old kaata customers cannot remain beneath the replacement header",
  );
  assert.equal(find("ActivityIndicator"), undefined, "fallback load reaches a stable, usable home");

  fixture(home, "viewer");
  activeVaultsOverride = [];
  await flush();
  assert.equal(vaultId, null, "archiving the final kaata clears the active cache");
  assert.equal(byLabel("customers.search"), undefined);
  assert.equal(find("ActivityIndicator"), undefined);

  fixture(home, "viewer");
  vaultId = null;
  await flush();
  assert.equal(
    byLabel("customers.search"),
    undefined,
    "no search destination without an active kaata",
  );

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(addOrFind, "viewer", nextRtl, nextPlatform);
      await flush();
      assert.equal(find("Header")?.props.title, "personFind.title");
      const input = byLabel("personFind.placeholder")!;
      assert.ok(input);
      assert.equal(
        nodes(tree).filter((node) => node.type === "TextInput").length,
        1,
        "viewers get one search field",
      );
      assert.equal(find("Button"), undefined, "viewers have no Add action");
      assert.equal(find("CountryPicker"), undefined);
      assert.equal(contactsReads, 0, "read-only lookup does not read the phone book");
      assert.equal(permissionRequests, 0);
      assert.equal(personRows().length, 2, "zero-tally people remain findable");
      assert.equal(
        find("Keyboard")?.props.behavior,
        nextPlatform === "android" ? "height" : "padding",
      );
      assert.equal(flattenStyle(input.props.style).textAlign, nextRtl ? "right" : "left");
      input.props.onChangeText("احمدی");
      await flush();
      assert.equal(personRows().length, 1);
      assert.ok(text(personRows()[0]).includes("فاطمه احمدی"));
      byLabel("personFind.placeholder")!.props.onChangeText("۷۰۰۱۲۳۴۵۶");
      await flush();
      assert.equal(personRows().length, 1, "Persian-digit phone search finds an existing person");
      personRows()[0].props.onPress();
      assert.deepEqual(routes.at(-1), { pathname: "/person/[id]", params: { id: "ahmad" } });
      assert.equal(writes.length, 0);
      byLabel("personFind.placeholder")!.props.onSubmitEditing();
      assert.equal(writes.length, 0, "keyboard Search never submits a create");
    }

  fixture(addOrFind, "clerk");
  await flush();
  assert.equal(find("Header")?.props.title, "personAdd.title");
  assert.ok(find("Button"), "append-only clerks retain creation");
  assert.equal(contactsReads, 1, "writable flow still loads phone contacts silently");
  byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
  await flush();
  const staleAdd = find("Button")!.props.onPress;
  const staleAccess = byLabel("personAdd.contacts.allow")!.props.onPress;
  const listenersWithContacts = appListeners.size;
  applyRole("viewer");
  await flush();
  staleAdd();
  staleAccess();
  await flush();
  assert.equal(writes.length, 0, "stale writable controls cannot create after a role downgrade");
  assert.equal(permissionRequests, 0, "stale contacts button cannot prompt after a downgrade");
  assert.equal(
    appListeners.size,
    listenersWithContacts - 1,
    "disabled contacts hook removes its resume listener",
  );
  assert.equal(find("Button"), undefined);
  assert.equal(focusEpoch, 0, "the synced downgrade does not depend on navigation focus");
  await runTimers();
  assert.equal(find("Button"), undefined, "committed role re-read preserves viewer gates");

  fixture(addOrFind, "owner");
  await flush();
  byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
  await flush();
  let finishGuard!: (value: { state: string }) => void;
  delayedGuard = new Promise((resolve) => {
    finishGuard = resolve;
  });
  find("Button")!.props.onPress();
  await flush();
  applyRole("viewer");
  await flush();
  finishGuard({ state: "active" });
  await flush();
  assert.equal(writes.length, 0, "downgrade during an awaited archive check prevents creation");
  assert.equal(find("Header")?.props.title, "personFind.title");

  fixture(addOrFind, "owner");
  await flush();
  const staleOwnerAdd = find("Button")!.props.onPress;
  const ownerReads = contactsReads;
  let resolveNextVault!: () => void;
  delayedRole = new Promise((resolve) => {
    resolveNextVault = resolve;
  });
  vaultId = "view-only-kaata";
  role = "viewer";
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  await flush();
  assert.equal(
    find("Header")?.props.title,
    "personFind.title",
    "previous vault's owner role cannot authorize the next vault while its role is loading",
  );
  assert.equal(find("Button"), undefined);
  staleOwnerAdd();
  await flush();
  assert.equal(writes.length, 0);
  assert.equal(
    contactsReads,
    ownerReads,
    "vault switch does not fetch phone contacts with stale owner caps",
  );
  resolveNextVault();
  await flush();
  assert.equal(find("Button"), undefined);

  fixture(addOrFind, "owner");
  let finishOldOwner!: () => void;
  delayedRole = new Promise((resolve) => {
    finishOldOwner = resolve;
  });
  await flush();
  assert.equal(find("Button"), undefined);
  delayedRole = null;
  applyRole("viewer");
  await flush();
  assert.equal(find("Header")?.props.title, "personFind.title");
  finishOldOwner();
  await flush();
  assert.equal(find("Button"), undefined, "late owner query cannot overwrite a newer downgrade");
  assert.equal(contactsReads, 0);

  fixture(addOrFind, "owner");
  await flush();
  const readsBeforeBackground = contactsReads;
  const backgroundAdd = find("Button")!.props.onPress;
  const backgroundAccess = byLabel("personAdd.contacts.allow")!.props.onPress;
  changeAppState("background");
  applyRole("viewer");
  await flush();
  assert.equal(
    find("Button"),
    undefined,
    "background invalidation immediately clears resolved write caps",
  );
  changeAppState("active");
  await flush();
  await runTimers();
  backgroundAdd();
  backgroundAccess();
  await flush();
  assert.equal(find("Header")?.props.title, "personFind.title");
  assert.equal(
    contactsReads,
    readsBeforeBackground,
    "resuming a downgraded kaata never reads the phone book",
  );
  assert.equal(permissionRequests, 0);
  assert.equal(writes.length, 0);
  assert.equal(focusEpoch, 0);

  fixture(addOrFind, "owner");
  await flush();
  const readsBeforeTally = contactsReads;
  byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
  await flush();
  let finishTallyRoleRead!: () => void;
  delayedRole = new Promise((resolve) => {
    finishTallyRoleRead = resolve;
  });
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(
    find("Header")?.props.title,
    "personAdd.title",
    "ordinary tally refresh does not switch Add to Find",
  );
  assert.equal(byLabel("personEdit.firstName.label")?.props.value, "Nadia");
  assert.ok(find("Button"));
  assert.equal(
    contactsReads,
    readsBeforeTally,
    "ordinary tally refresh leaves the contacts hook enabled",
  );
  finishTallyRoleRead();
  await flush();
  assert.equal(find("Header")?.props.title, "personAdd.title");

  fixture(addOrFind, "viewer");
  await flush();
  const nadia = { ...people[0], id: "nadia", name: "Nadia", last_entry_at: null };
  peopleByVault.set("kaata", [...people, nadia]);
  ledgerEvents.emitLedgerApplied("kaata", "remote");
  await runTimers();
  assert.equal(
    personRows().length,
    3,
    "a person added by another member appears without navigation",
  );
  const zarif = { ...people[0], id: "zarif", name: "Zarif" };
  changeAppState("background");
  peopleByVault.set("kaata", [...people, nadia, zarif]);
  ledgerEvents.emitLedgerApplied("kaata", "remote");
  await flush();
  assert.equal(personRows().length, 3, "background applies wait for the visible list to resume");
  changeAppState("active");
  await flush();
  await runTimers();
  assert.equal(
    personRows().length,
    4,
    "foreground catches up while navigation focus stays unchanged",
  );
  assert.equal(focusEpoch, 0);

  fixture(addOrFind, "viewer");
  await flush();
  const oldPersonTap = personRows()[0].props.onPress;
  let finishOldPeople!: () => void;
  delayedPeople = new Promise((resolve) => {
    finishOldPeople = resolve;
  });
  ledgerEvents.emitLedgerApplied("kaata", "remote");
  await runTimers();
  vaultId = "second-kaata";
  peopleByVault.set(vaultId, [nadia]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(
    personRows().length,
    0,
    "the old kaata's rows disappear while the next scoped read waits",
  );
  oldPersonTap();
  assert.equal(routes.length, 0, "a stale person tap cannot open another kaata's person");
  delayedPeople = null;
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(personRows().length, 1);
  assert.ok(text(personRows()[0]).includes("Nadia"));
  finishOldPeople();
  await flush();
  assert.equal(
    personRows().length,
    1,
    "old-vault and superseded list reads cannot replace current rows",
  );
  assert.ok(text(personRows()[0]).includes("Nadia"));
  assert.equal(contactsReads, 0);

  fixture(addOrFind, "viewer");
  let finishUnmountedRole!: () => void;
  let finishUnmountedPeople!: () => void;
  delayedRole = new Promise((resolve) => {
    finishUnmountedRole = resolve;
  });
  delayedPeople = new Promise((resolve) => {
    finishUnmountedPeople = resolve;
  });
  await flush();
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  unmount();
  dirty = false;
  finishUnmountedRole();
  finishUnmountedPeople();
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  assert.equal(dirty, false, "pending role/list reads do not set state after unmount");
  assert.equal(appListeners.size, 0);
  assert.equal(timers.size, 0);

  fixture(addOrFind, "owner");
  roleReadFails = true;
  await flush();
  assert.equal(find("Button"), undefined, "failed role lookup remains search-only");
  assert.equal(contactsReads, 0);
  roleReadFails = false;
  focusEpoch++;
  dirty = true;
  await flush();
  assert.ok(find("Button"), "a successful focus refresh recovers the writable role");
  assert.equal(contactsReads, 1);

  // Sign-out keeps app_meta.account_id (only the next sign-in overwrites it)
  // and clears the in-memory account. Home must scope itself to the in-memory
  // value: comparing the two hid the add button and blocked row taps until a
  // relaunch (35/55).
  const openFirstRow = () => {
    const page = nodes(tree).find(
      (node) => "filterTotal" in node.props && node.props.people.length > 0,
    )!;
    page.props.onPersonPress(page.props.people[0]);
  };
  fixture(home, "owner");
  persistedAccountId = "acc-1";
  await flush();
  assert.ok(byLabel("personAdd.new"), "a signed-out owner with a stale account id keeps the plus");
  openFirstRow();
  assert.deepEqual(
    routes.at(-1),
    { pathname: "/person/[id]", params: { id: "ahmad" } },
    "a signed-out owner can open a customer",
  );
  fixture(home, "owner");
  persistedAccountId = cachedAccountId = "acc-1";
  await flush();
  assert.ok(byLabel("personAdd.new"), "a signed-in owner has the plus");
  cachedAccountId = null; // signOut() or a 401 clears the cache in place
  for (const listener of [...identityListeners]) listener();
  await flush();
  assert.ok(byLabel("personAdd.new"), "the plus survives an in-session sign-out");
  routes.length = 0;
  openFirstRow();
  assert.deepEqual(
    routes.at(-1),
    { pathname: "/person/[id]", params: { id: "ahmad" } },
    "rows still open after an in-session sign-out",
  );

  fixture(addOrFind, "owner");
  await flush();
  byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
  await flush();
  find("Button")!.props.onPress();
  await flush();
  assert.equal(writes.length, 1, "authorized writable flow still creates");
  assert.deepEqual(routes.at(-1), { pathname: "/person/[id]", params: { id: "created" } });
  unmount();
  console.log(
    "PASS: contact action-sheet entry into combined-sheet multi-select, exact selected debt/credit totals and pending shared balances, visible-result select-all, search/group retention and remote pruning, role/account/vault clearing, modal dismissal/Done/cancel, guarded bulk removal and partial-failure retry; two real Home pages with independent retained scroll refs, inactive-page touch/accessibility guards, covered/search/scope/blur/unmount row guards; input-triggered search sheet, sheet-only groups/sort/query with unchanged home rows and totals, combined collect/pay results, remembered-tab/stale-swipe guards, EN/FA and 320px access, zero-tally/phone searches, multi-group/sort composition, scoped live/resume reloads, in-place role downgrades, late-read and unmount guards, no viewer phone-book reads/prompts or writes, stable writable tally refresh and authorized creation",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
