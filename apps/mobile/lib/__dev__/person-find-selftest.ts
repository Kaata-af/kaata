// Real home + add/find screens and the real device-contacts hook. Storage,
// native controls and navigation are synthetic; no real ledger or phone book.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { toAsciiDigits } from "../digits";
import * as search from "../search";
import { colors } from "../colors";
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
let role: "owner" | "clerk" | "viewer" = "viewer";
let rtl = false,
  platform = "android",
  vaultId: string | null = "kaata";
let screenWidth = 390;
let routeParams: { mode?: string } = {};
let keyboardDismissals = 0;
const keyboardListeners = new Set<{ event: string; fn: () => void }>();
const keyboardEvent = (event: string) => {
  for (const listener of [...keyboardListeners]) if (listener.event === event) listener.fn();
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
let peopleByVault: Map<string | null, typeof people>;
let activeVaultsOverride: { id: string; name: string; currency: string }[] | null = null;
const homeReadScopes: (string | null)[] = [];
let appState = "active";
let roleReadFails = false,
  focusEpoch = 0;
// app_meta.account_id survives sign-out; the in-memory cache does not.
let persistedAccountId: string | null = null,
  cachedAccountId: string | null = null;
const identityListeners = new Set<() => void>();
const routes: any[] = [],
  toasts: any[] = [],
  writes: any[] = [];
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
const jsx = (type: string, props: any): Node => ({ type, props });
const nodes = (node: any): Node[] =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== "object"
      ? []
      : [node, ...nodes(node.props?.children)];
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
    addListener(event: string, fn: () => void) {
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
  BackHandler: { addEventListener: () => ({ remove() {} }), exitApp() {} },
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
    useFocusEffect: (fn: any) => react.useEffect(fn, [fn, focusEpoch]),
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
      return rows;
    },
    getActiveVaultArchivedAt: async () => null,
    getActiveVaultArchivedState: async () => delayedGuard ?? { state: archivedState },
    getAppMeta: async (key: string) => (key === "account_id" ? persistedAccountId : null),
    setAppMeta: async () => {},
    listActiveVaults: async () =>
      activeVaultsOverride ?? (vaultId ? [{ id: vaultId, name: "Shop", currency: "AFN" }] : []),
    listAllVaultsIncludingArchived: async () =>
      vaultId ? [{ id: vaultId, name: "Shop", currency: "AFN", archived: false }] : [],
    archivePerson: async () => {
      throw new Error("unexpected archive");
    },
    createPerson: async (...args: any[]) => {
      writes.push(args);
      return { ok: true, id: "created" };
    },
  },
  auth: { getSessionUser: async () => null, signOut: async () => {} },
  "ledger-events": ledgerEvents,
  "app-meta-context": { useAppMeta: () => ({ forceUpdate: false }) },
  money: { sumAmounts: (values: number[]) => values.reduce((a, b) => a + b, 0) },
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
  CustomerListSheet: { CustomerListSheet: "CustomerListSheet" },
  BottomSheet: { BottomSheet: "BottomSheet" },
  ConfirmDialog: { ConfirmDialog: "ConfirmDialog" },
  Button: { Button: "Button" },
  EmptyState: { EmptyState: "EmptyState" },
  InitialAvatar: { InitialAvatar: "Avatar" },
  NotificationInbox: { NotificationBell: "Bell" },
  PersonRow: { PersonRow: "PersonRow" },
  ProfileSettingsSheet: { ProfileSettingsSheet: "Settings" },
  Tabs: { Tabs: "Tabs" },
  Toast: { useToast: () => toast, useToastOffset: () => 0 },
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
  springTargets.length = 0;
  groupState = { groups: [], groupsByPerson: {} };
  focusEpoch = 0;
  routes.length = 0;
  toasts.length = 0;
  writes.length = 0;
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
  const homeSearch = () =>
    nodes(tree).find((node) => "collectPeople" in node.props && "payPeople" in node.props);
  const homeIds = () => {
    const results = homeSearch();
    return results
      ? [
          ...results.props.collectPeople,
          ...results.props.payPeople,
          ...results.props.neverTalliedPeople,
        ].map((person: any) => person.id)
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
  for (const nextRole of ["viewer", "owner", "clerk"] as const)
    for (const nextPlatform of ["android", "ios"])
      for (const nextRtl of [false, true]) {
        fixture(home, nextRole, nextRtl, nextPlatform);
        screenWidth = 320;
        await flush();
        const input = byLabel("customers.search")!;
        const sort = byLabel("customers.listOptions")!;
        const button = byLabel("personAdd.new");
        assert.ok(input && sort, `${nextRole} has persistent search and sort`);
        assert.equal(button != null, nextRole !== "viewer", "only writers get the plus");
        assert.equal(
          nodes(tree).some(
            (node) => node.type === "Text" && node.props.children === "readonly.badge",
          ),
          nextRole === "viewer",
          "only a resolved viewer displays the read-only badge",
        );
        const dock = nodes(tree).find(
          (node) => node.type === "AnimatedView" && nodes(node).includes(input),
        )!;
        assert.equal(
          flattenStyle(dock.props.style).flexDirection,
          "row",
          "sort stays physically left and add right in both languages",
        );
        assert.deepEqual(
          nodes(dock.props.children)
            .filter((node) =>
              ["customers.listOptions", "customers.search", "personAdd.new"].includes(
                node.props.accessibilityLabel,
              ),
            )
            .map((node) => node.props.accessibilityLabel),
          nextRole === "viewer"
            ? ["customers.listOptions", "customers.search"]
            : ["customers.listOptions", "customers.search", "personAdd.new"],
          "sort/search/add are neighboring dock controls",
        );
        assert.equal(
          flattenStyle(input.props.style).minWidth,
          0,
          "search can shrink on a 320px screen",
        );
        assert.equal(flattenStyle(input.props.style).textAlign, nextRtl ? "right" : "left");
        const keyboard = find("Keyboard")!;
        assert.equal(keyboard.props.behavior, nextPlatform === "ios" ? "padding" : "height");
        const body = nodes(keyboard.props.children).find(
          (node) => node.type === "View" && node.props.children && nodes(node).includes(dock),
        )!;
        assert.equal(
          flattenStyle(body.props.style).flex,
          1,
          "dock containing block shrinks above keyboard",
        );
        assert.equal(
          byLabel("common.hideKeyboard"),
          undefined,
          "idle search adds no dismiss control",
        );
        assert.equal(input.props.submitBehavior, "blurAndSubmit");
        let inputBlurs = 0;
        input.props.ref.current = { blur: () => inputBlurs++ };
        input.props.onFocus();
        await flush();
        const closeEmptySearch = byLabel("common.hideKeyboard")!;
        assert.ok(
          closeEmptySearch,
          "every role can dismiss a focused empty search without blank space",
        );
        assert.equal(
          byLabel("personAdd.new"),
          undefined,
          "the down control uses the home add slot while typing",
        );
        assert.ok(byLabel("customers.listOptions"), "sort remains available while typing");
        const dismissStyle = flattenStyle(closeEmptySearch.props.style({ pressed: false }));
        assert.ok(
          dismissStyle.width >= 44 && dismissStyle.height >= 44,
          "dismiss target is easy to hit",
        );
        closeEmptySearch.props.onPress();
        await flush();
        assert.equal(inputBlurs, 1, "the down control releases the focused input itself");
        assert.equal(
          byLabel("customers.search")!.props.value,
          "",
          "closing empty search does not insert a query",
        );
        assert.equal(byLabel("common.hideKeyboard"), undefined);
        assert.equal(byLabel("personAdd.new") != null, nextRole !== "viewer");
        for (const page of homePages())
          assert.equal(
            nodes(renderList(page)).find((node) => node.type === "ScrollView")!.props
              .keyboardDismissMode,
            nextPlatform === "ios" ? "interactive" : "on-drag",
            "both idle home lists allow keyboard dismissal by dragging",
          );
        assert.deepEqual(homeIds(), ["ahmad", "fatima"], "idle home retains zero-tally contacts");
        for (const page of homePages()) {
          assert.deepEqual(
            page.props.neverTalliedPeople.map((person: any) => person.id),
            ["fatima"],
            "a new contact remains visible from either previous tab",
          );
          assert.ok(
            !page.props.allPeople.some((person: any) => person.id === "fatima"),
            "no-tally contacts stay outside financial totals and counts",
          );
          assert.equal(
            nodes(renderList(page)).filter((node) => node.type === "EmptyState").length,
            0,
            "existing no-tally contacts replace the otherwise empty financial list",
          );
        }
        input.props.onFocus();
        input.props.onChangeText("فاطمه");
        await flush();
        assert.deepEqual(homeIds(), ["fatima"], "Dari search reaches zero-tally customers");
        const results = homeSearch()!;
        assert.ok(results, "search uses one combined result view");
        assert.equal(homePages().length, 0, "directional overview is hidden during search");
        assert.equal(find("Tabs"), undefined, "a selected tab cannot mislabel mixed results");
        assert.equal(find("Gesture"), undefined, "search results do not swipe between sides");
        const resultTree = renderList(results);
        assert.equal(nodes(resultTree).filter((node) => node.type === "ScrollView").length, 1);
        assert.equal(
          nodes(resultTree).find((node) => node.type === "ScrollView")!.props.keyboardDismissMode,
          nextPlatform === "ios" ? "interactive" : "on-drag",
          "combined results support the same drag dismissal",
        );
        const beforeClose = keyboardDismissals;
        byLabel("common.hideKeyboard")!.props.onPress();
        await flush();
        assert.equal(keyboardDismissals, beforeClose + 1, "down explicitly dismisses the keyboard");
        assert.equal(byLabel("customers.search")!.props.value, "فاطمه");
        assert.deepEqual(homeIds(), ["fatima"], "hiding the keyboard retains search results");
        assert.ok(
          byLabel("customers.search.clear"),
          "query clear stays separate from keyboard dismissal",
        );
        assert.equal(byLabel("common.hideKeyboard"), undefined);
        assert.ok(text(resultTree).includes("customers.noTallies"));
        assert.ok(!text(resultTree).includes("home.tab.collect"));
        assert.ok(!text(resultTree).includes("home.tab.pay"), "empty result sections stay hidden");
        assert.ok(
          !text(resultTree).includes("home.total.label"),
          "search has no directional total",
        );
        assert.equal(
          results.props.onPersonLongPress != null,
          nextRole === "owner",
          "combined results keep clerks and viewers out of edit/delete actions",
        );
        byLabel("customers.search")!.props.onChangeText("۰۷۰۰۱۲۳۴۵۶");
        byLabel("customers.search")!.props.onFocus();
        await flush();
        assert.deepEqual(
          homeIds(),
          ["ahmad"],
          "localized trunk-format numbers find E.164 customers",
        );
        byLabel("customers.search")!.props.onSubmitEditing();
        await flush();
        assert.equal(
          byLabel("common.hideKeyboard"),
          undefined,
          "Search return closes the keyboard",
        );
        assert.deepEqual(homeIds(), ["ahmad"], "Search return preserves the current query");
        byLabel("customers.search")!.props.onFocus();
        await flush();
        keyboardEvent("keyboardDidHide");
        await flush();
        assert.equal(
          byLabel("common.hideKeyboard"),
          undefined,
          "native Back or drag-hide restores idle controls",
        );
        assert.equal(byLabel("personAdd.new") != null, nextRole !== "viewer");
        byLabel("customers.search")!.props.onChangeText("nobody");
        byLabel("customers.search")!.props.onFocus();
        await flush();
        assert.deepEqual(homeIds(), []);
        assert.equal(
          nodes(renderList(homeSearch()!)).filter((node) => node.type === "EmptyState").length,
          1,
          "no match produces one empty state for both sides",
        );
        byLabel("customers.search.clear")!.props.onPress();
        await flush();
        assert.ok(
          byLabel("common.hideKeyboard"),
          "Clear removes the query without dismissing typing",
        );
        byLabel("common.hideKeyboard")!.props.onPress();
        await flush();
        assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
        assert.equal(find("Tabs")!.props.value, "collect");
        assert.equal(homeSearch(), undefined);
        assert.deepEqual(
          homePages()[0].props.allPeople.map((person: any) => person.id),
          ["ahmad"],
        );
        sort.props.onPress();
        await flush();
        assert.equal(find("CustomerListSheet")!.props.visible, true, "sort sheet opens from dock");
        assert.ok(keyboardDismissals >= 4, "dismissal and sort all hide the keyboard explicitly");
        assert.equal(contactsReads, 0, "home search does not read the phone book");
        assert.equal(permissionRequests, 0);
        assert.equal(writes.length, 0);
        if (button) {
          assert.equal(
            flattenStyle(button.props.style({ pressed: false })).backgroundColor,
            "#000000",
          );
          assert.equal(nodes(button).find((node) => node.type === "Icon")?.props.name, "add");
          await button.props.onPress();
          assert.deepEqual(routes.at(-1), { pathname: "/person/new", params: { mode: "add" } });
          archivedState = "archived";
          await button.props.onPress();
          assert.equal(routes.length, 1, "archived kaata cannot enter add");
          assert.equal(toasts.at(-1)?.[0], "home.fab.blockedArchived");
        }
      }

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
  byLabel("customers.search")!.props.onChangeText("Ahmad");
  await flush();
  const oldHomePersonTap = homeSearch()!.props.onPersonPress;
  const otherPerson = { ...people[0], id: "nadia", name: "Nadia", last_entry_at: 200 };
  vaultId = "second-kaata";
  peopleByVault.set(vaultId, [otherPerson]);
  activeVaultsOverride = [{ id: vaultId, name: "Second", currency: "AFN" }];
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.equal(byLabel("customers.search")!.props.value, "", "kaata switch clears the old query");
  assert.deepEqual(homeIds(), ["nadia"]);
  oldHomePersonTap(people[0]);
  assert.equal(routes.length, 0, "old search row cannot navigate after a kaata switch");

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
  byLabel("customers.search")!.props.onChangeText("Ahmad");
  await flush();
  find("CustomerListSheet")!.props.onChange({ sort: "amount_asc", group: ["family", "shop"] });
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad", "ahmad-high", "ahmad-other"],
    "search composes with multi-group OR and amount order on each side",
  );
  const mixedResults = renderList(homeSearch()!);
  assert.ok(text(mixedResults).includes("home.tab.collect"));
  assert.ok(text(mixedResults).includes("home.tab.pay"));
  assert.equal(
    nodes(mixedResults).filter((node) => node.type === "PersonRow").length,
    3,
    "customers in multiple groups appear once across the combined list",
  );
  // A match on the opposite balance side is immediately visible, even when
  // searching started from To collect; no tab-switch link is required.
  byLabel("customers.search")!.props.onChangeText("Hamidi");
  await flush();
  assert.deepEqual(homeIds(), ["ahmad-other"]);
  const oppositeResults = renderList(homeSearch()!);
  assert.ok(text(oppositeResults).includes("home.tab.pay"));
  assert.ok(!text(oppositeResults).includes("home.tab.collect"));
  assert.equal(nodes(oppositeResults).filter((node) => node.type === "EmptyState").length, 0);
  const oppositeRow = nodes(oppositeResults).find((node) => node.type === "PersonRow")!;
  oppositeRow.props.onPress(oppositeRow.props.person);
  assert.deepEqual(
    routes.at(-1),
    { pathname: "/person/[id]", params: { id: "ahmad-other" } },
    "opposite-side result opens that customer",
  );
  byLabel("customers.search")!.props.onChangeText("Ahmad");
  await flush();
  // The active group filter is named on home, the sort button carries a dot,
  // and the chip's clear restores every customer.
  const groupedPage = homeSearch()!;
  assert.equal(groupedPage.props.groupFilterLabel, "Family, Shop", "home names the active groups");
  assert.equal(groupedPage.props.groupFilterCount, 2);
  const listOptions = byLabel("customers.listOptions")!;
  assert.equal(listOptions.props.accessibilityState.selected, true);
  assert.ok(
    nodes(listOptions.props.children).some((node) => node.type === "View"),
    "a customized sort or filter shows a dot on the sort button",
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
  find("CustomerListSheet")!.props.onChange({ sort: "name_desc", group: "all" });
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad-high", "ahmad", "ahmad-low", "ahmad-other"],
    "name sorting remains effective during search",
  );
  // Both previous pages survive a complete search session. A delayed swipe
  // callback from the old rail must not change that remembered page.
  byLabel("customers.search.clear")!.props.onPress();
  await flush();
  assert.equal(find("Tabs")!.props.value, "collect");
  for (const previousDirection of ["collect", "pay"]) {
    find("Tabs")!.props.onChange(previousDirection);
    await flush();
    const oldGestureEnd = gestureHandlers.onEnd;
    byLabel("customers.search")!.props.onChangeText("Ahmad");
    await flush();
    assert.deepEqual(homeIds(), ["ahmad-high", "ahmad", "ahmad-low", "ahmad-other"]);
    oldGestureEnd({ translationX: previousDirection === "collect" ? -200 : 200, velocityX: 0 });
    await flush();
    byLabel("customers.search.clear")!.props.onPress();
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
  byLabel("customers.search")!.props.onChangeText("   ");
  await flush();
  assert.equal(homeSearch(), undefined, "whitespace restores the normal overview");
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
  byLabel("customers.search")!.props.onChangeText("Zarif");
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
  assert.ok(text(neutralSearch).includes("customers.noTallies"));
  byLabel("customers.search.clear")!.props.onPress();
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
  find("CustomerListSheet")!.props.onChange({ sort: "recent", group: "newcomers" });
  await flush();
  for (const page of homePages()) {
    const neutralGroupTree = renderList(page);
    assert.equal(nodes(neutralGroupTree).filter((node) => node.type === "PersonRow").length, 2);
    assert.equal(tParams.get("customers.filtered")?.shown, 0);
    assert.equal(
      tParams.get("customers.filtered")?.direction,
      page.props.direction === "collect" ? "home.tab.collect" : "home.tab.pay",
      "the zero financial match count explicitly names its side, separate from neutral rows",
    );
  }
  find("CustomerListSheet")!.props.onChange({ sort: "recent", group: "family" });
  await flush();
  byLabel("customers.search")!.props.onChangeText("Zarif");
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
  assert.deepEqual(
    homeIds(),
    ["new-person"],
    "the first tally keeps the same saved contact findable",
  );
  const firstTallyResults = homeSearch()!;
  assert.deepEqual(
    firstTallyResults.props.payPeople.map((person: any) => person.id),
    ["new-person"],
  );
  assert.deepEqual(
    firstTallyResults.props.neverTalliedPeople,
    [],
    "first activity removes the neutral row",
  );
  assert.equal(
    nodes(renderList(firstTallyResults)).filter((node) => node.type === "PersonRow").length,
    1,
    "moving into the financial section does not duplicate the contact",
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
    "PASS: combined collect/pay home search, direction headings and remembered-tab/stale-swipe guards, persistent sort/add controls, EN/FA and 320px keyboard layout, zero-tally/phone searches, multi-group/sort composition, scoped live/resume reloads, in-place role downgrades, late-read and unmount guards, no viewer phone-book reads/prompts or writes, stable writable tally refresh and authorized creation",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
