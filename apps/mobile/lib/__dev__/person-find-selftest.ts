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
import { uiHooks } from "./ui-fixture";

type Node = { type: any; props: Record<string, any>; key?: string | number };
type Effect = { deps?: unknown[]; cleanup?: () => void };
let slots: any[] = [],
  cursor = 0,
  dirty = false,
  tree: Node;
let effects: (() => void)[] = [];
let pageHooks: { key: string | number; hooks: ReturnType<typeof uiHooks> } | undefined;
const customerRowHooks = new Map<string | number, ReturnType<typeof uiHooks>>();
let activePageReact: ReturnType<typeof uiHooks>["react"] | null = null;
const tParams = new Map<string, Record<string, unknown> | undefined>();
let screen: () => Node;
let role: "owner" | "editor" | "clerk" | "viewer" = "viewer";
let rtl = false,
  platform = "android",
  vaultId: string | null = "kaata";
let selectedCurrency = "AFN";
let enabledCurrencies = ["AFN"];
const enabledCurrenciesByVault = new Map<string, string[]>();
const delayedEnabledCurrencies = new Map<string, Promise<string[]>>();
const failedEnabledCurrencies = new Set<string>();
const currencyListeners = new Set<(code: string) => void>();
const changeCurrency = (code: string) => {
  selectedCurrency = code;
  for (const listener of currencyListeners) listener(code);
};
let screenWidth = 390,
  screenFontScale = 1;
let routeParams: { mode?: string } = {};
let keyboardDismissals = 0;
let searchInputBlurs = 0,
  searchInputFocuses = 0,
  searchInputFocused = false;
let filterViewportHeight = 600,
  filterTriggerY = 548,
  delayFilterMeasurements = false;
const pendingFilterMeasurements: (() => void)[] = [];
let reducedMotion = false,
  homeToastOffset = 0;
let homeToastBottomOffset: number | undefined;
let reviewPromptOptions: {
  context: { installId: string; accountId: string | null; vaultId: string | null } | null;
  ready: boolean;
} | null = null;
let reviewInteractionCancels = 0;
const scheduledKeyboardLayouts: unknown[] = [];
const keyboardListeners = new Set<{ event: string; fn: (payload: any) => void }>();
const keyboardEvent = (event: string) => {
  const payload = {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { height: 300, screenY: 544 },
  };
  for (const listener of [...keyboardListeners]) if (listener.event === event) listener.fn(payload);
  return payload;
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
type FixturePerson = (typeof people)[number] & {
  tab_id?: string;
  tab_unsynced?: 0 | 1;
  tab_closed_at?: number | null;
  tab_other_joined?: 0 | 1;
  currency?: string;
  currency_balances?: FixturePerson[];
  selection_totals?: import("../types").PersonWithBalance["selection_totals"];
};
let peopleByVault: Map<string | null, FixturePerson[]>;
let activeVaultsOverride: { id: string; name: string; currency: string }[] | null = null;
const homeReadScopes: (string | null)[] = [];
const contactReadRequests: unknown[][] = [];
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
    if (activePageReact) return activePageReact.useState(initial);
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
    if (activePageReact) return activePageReact.useRef(initial);
    const i = cursor++;
    return (slots[i] ??= { current: initial });
  },
  useMemo(fn: () => any, deps: unknown[]) {
    if (activePageReact) return activePageReact.useMemo(fn, deps);
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
  useLayoutEffect(fn: () => void | (() => void), deps?: unknown[]) {
    react.useEffect(fn, deps);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    if (activePageReact) return activePageReact.useEffect(fn, deps);
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
const jsx = (type: string, props: any, key?: string | number): Node => {
  if (props?.ref && !props.ref.current && type === "View")
    props.ref.current = {
      measureInWindow: (callback: any) => callback(0, 0, screenWidth, filterViewportHeight),
    };
  if (props?.ref && !props.ref.current && type === "Pressable")
    props.ref.current = {
      measureInWindow: (callback: any) => {
        const x = screenWidth - 130,
          y = filterTriggerY;
        const complete = () => callback(x, y, 52, 52);
        if (delayFilterMeasurements) pendingFilterMeasurements.push(complete);
        else complete();
      },
    };
  if (props?.ref && !props.ref.current && type === "TextInput")
    props.ref.current = {
      blur: () => {
        searchInputBlurs++;
        searchInputFocused = false;
      },
      focus: () => {
        searchInputFocuses++;
        searchInputFocused = true;
      },
      isFocused: () => searchInputFocused,
    };
  return {
    type,
    key,
    props:
      type === "SearchFieldTrigger" ? { ...props, accessibilityLabel: props.placeholder } : props,
  };
};
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
              : node.type === "HomeFilterPopover" && (!node.props.visible || !node.props.anchor)
                ? null
                : node.type === "SettledAccountsSection" &&
                    (node.props.count <= 0 || !node.props.expanded)
                  ? null
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
let homeRenderedNodes: () => Node[] = () => [];
const find = (type: string) =>
  nodes(tree).find((node) => node.type === type) ??
  homeRenderedNodes().find((node) => node.type === type);
const byLabel = (label: string) =>
  nodes(tree).find((node) => node.props.accessibilityLabel === label) ??
  homeRenderedNodes().find((node) => node.props.accessibilityLabel === label);
const flattenStyle = (value: any): any =>
  Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flattenStyle)) : value;
const nodePath = (root: any, target: Node): string | undefined => {
  if (root === target) return `${String(root.type)}:${root.key ?? ""}`;
  if (!root || typeof root !== "object") return undefined;
  const children = Array.isArray(root) ? root : root?.props?.children;
  for (const [index, child] of [children].flat().entries()) {
    const path = nodePath(child, target);
    if (path !== undefined) return `${String(root?.type ?? "children")}[${index}]/${path}`;
  }
  return undefined;
};
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
  useWindowDimensions: () => ({ width: screenWidth, height: 844, fontScale: screenFontScale }),
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
  "./phone-match": require("../phone-match"),
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
    useRouter: () => router,
    useLocalSearchParams: () => routeParams,
    Redirect: "Redirect",
    useFocusEffect: (fn: any) =>
      react.useEffect(
        () => (homeOwnerFocused ? fn() : undefined),
        [fn, focusEpoch, homeOwnerFocused],
      ),
  },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-blur": { BlurTargetView: "BlurTargetView" },
  "react-native-safe-area-context": {
    SafeAreaView: "SafeArea",
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  },
};
const libMocks: Record<string, any> = {
  "customer-note": require("../customer-note"),
  "use-store-review-prompt": {
    useStoreReviewPrompt: (options: NonNullable<typeof reviewPromptOptions>) => {
      reviewPromptOptions = options;
      return () => reviewInteractionCancels++;
    },
  },
  colors: { colors },
  "tabs/link-status": require("../tabs/link-status"),
  currency: {
    applyVaultCurrency: async () => {},
    getEnabledCurrencies: async (id: string) => {
      if (failedEnabledCurrencies.has(id)) throw new Error("fixture currency read failed");
      return (
        delayedEnabledCurrencies.get(id) ?? [
          ...(enabledCurrenciesByVault.get(id) ?? enabledCurrencies),
        ]
      );
    },
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
  "multi-currency-view": require("../multi-currency-view"),
  "settled-customers": require("../settled-customers"),
  "profile-settings-context": { ProfileSettingsSource: "Settings" },
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
    getInstallIdSync: () => "install",
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
    listCurrencyBalanceSummaries: async () => [
      {
        currency: selectedCurrency,
        collect: sumAmounts(
          (peopleByVault.get(vaultId) ?? []).filter((p) => p.balance > 0).map((p) => p.balance),
        ),
        pay: sumAmounts(
          (peopleByVault.get(vaultId) ?? []).filter((p) => p.balance < 0).map((p) => -p.balance),
        ),
        pending: false,
      },
    ],
    listAllPeopleForSearch: async (
      scope: string | null = vaultId,
      currency?: string,
      options?: { allCurrencies?: boolean },
    ) => {
      if (screen === home) homeReadScopes.push(scope);
      else contactReadRequests.push([scope, currency, options]);
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
    archivePerson: async (
      id: string,
      expectedScope?: { vaultId: string; accountId: string | null },
    ) => {
      if (expectedScope) {
        assert.equal(expectedScope.vaultId, vaultId);
        assert.equal(expectedScope.accountId, cachedAccountId);
      }
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
  CustomerRows: compile("../../components/CustomerRows", {
    ...sharedMocks,
    "../lib/colors": { colors },
    "./PersonRow": { PersonRow: "PersonRow" },
  }),
  CustomerListSheet: {
    CustomerListSheet: "CustomerListSheet",
    CustomerListOptions: "CustomerListOptions",
  },
  SearchSheet: { SearchSheet: "SearchSheet" },
  SearchFieldTrigger: { SearchFieldTrigger: "SearchFieldTrigger" },
  SearchControlSlot: { SearchControlSlot: "SearchControlSlot" },
  SearchKeyboardMotion: {
    SearchKeyboardFrame: "SearchKeyboardFrame",
    SearchKeyboardFooter: "SearchKeyboardFooter",
  },
  SheetBackdrop: { useSheetMotionPreference: () => reducedMotion },
  BottomSheet: { BottomSheet: "BottomSheet" },
  ConfirmDialog: { ConfirmDialog: "ConfirmDialog" },
  Button: { Button: "Button" },
  EmptyState: { EmptyState: "EmptyState" },
  InitialAvatar: { InitialAvatar: "Avatar" },
  NotificationInbox: { NotificationBell: "Bell" },
  PersonRow: { PersonRow: "PersonRow" },
  HomeBalanceSummary: { HomeBalanceSummary: "HomeBalanceSummary" },
  HomeBalanceFilterSwipe: { HomeBalanceFilterSwipe: "HomeBalanceFilterSwipe" },
  HomeFilterPopover: { HomeFilterPopover: "HomeFilterPopover" },
  SettledAccountsSection: { SettledAccountsSection: "SettledAccountsSection" },
  SelectionToolbar: { SelectionToolbar: "SelectionToolbar", SelectionMark: "SelectionMark" },
  SelectionMark: { SelectionMark: "SelectionMark" },
  ProfileSettingsSheet: { ProfileSettingsSheet: "Settings" },
  Toast: {
    useToast: () => toast,
    useToastOffset: (bottom?: number) => {
      homeToastBottomOffset = bottom;
      return homeToastOffset;
    },
    TOAST_LIFT: 72,
  },
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
const home = compile("../../app/index", {
  ...screenMocks("../"),
  "expo-haptics": {
    impactAsync: async () => {},
    selectionAsync: async () => {},
    ImpactFeedbackStyle: { Light: "light", Soft: "soft" },
  },
}).default;
const addOrFind = compile("../../app/person/new", screenMocks("../../")).default;
function unmount() {
  pageHooks?.hooks.unmount();
  pageHooks = undefined;
  for (const rows of customerRowHooks.values()) rows.unmount();
  customerRowHooks.clear();
  activePageReact = null;
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
  selectedCurrency = "AFN";
  enabledCurrencies = ["AFN"];
  enabledCurrenciesByVault.clear();
  delayedEnabledCurrencies.clear();
  failedEnabledCurrencies.clear();
  screenWidth = 390;
  screenFontScale = 1;
  routeParams = {};
  keyboardDismissals = 0;
  searchInputBlurs = 0;
  searchInputFocuses = 0;
  searchInputFocused = false;
  filterViewportHeight = 600;
  filterTriggerY = 548;
  delayFilterMeasurements = false;
  pendingFilterMeasurements.length = 0;
  reducedMotion = false;
  homeToastOffset = 0;
  homeToastBottomOffset = undefined;
  reviewPromptOptions = null;
  reviewInteractionCancels = 0;
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
  contactReadRequests.length = 0;
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

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      const linked: FixturePerson = { ...people[0], tab_id: "link", tab_closed_at: null };
      const statuses: [FixturePerson, boolean, boolean][] = [
        [people[0], false, false],
        [{ ...linked, tab_other_joined: 0 }, false, true],
        [linked, false, true],
        [{ ...linked, tab_other_joined: 1 }, true, false],
        [{ ...linked, tab_other_joined: 1, tab_closed_at: 100 }, false, false],
        [
          {
            ...linked,
            tab_other_joined: 1,
            currency_balances: [
              { ...linked, currency: "AFN", tab_other_joined: 1, tab_closed_at: 100 },
              { ...linked, currency: "USD", tab_other_joined: 0 },
            ],
          },
          false,
          true,
        ],
        [
          {
            ...linked,
            tab_other_joined: 0,
            currency_balances: [
              { ...linked, currency: "AFN", tab_other_joined: 0 },
              { ...linked, currency: "USD", tab_other_joined: 1 },
            ],
          },
          true,
          false,
        ],
      ];
      for (const [person, joined, waiting] of statuses) {
        fixture(addOrFind, "viewer", nextRtl, nextPlatform);
        peopleByVault.set("kaata", [person]);
        await flush();
        assert.deepEqual(
          contactReadRequests[0],
          ["kaata", undefined, { allCurrencies: true }],
          "contact search loads authoritative join state across currencies",
        );
        const row = personRows()[0];
        assert.ok(row);
        assert.equal(
          nodes(row).some((node) => node.type === "SharedBadge"),
          joined,
          "only an open joined account gets a blue badge in contact search",
        );
        const waitingTexts = nodes(row).filter(
          (node) => node.type === "Text" && node.props.children === "tab.chip.waiting",
        );
        assert.equal(
          waitingTexts.length,
          waiting ? 1 : 0,
          "pending or unknown joins receive one explicit neutral waiting label",
        );
        if (waiting)
          assert.equal(flattenStyle(waitingTexts[0].props.style).color, colors.textSubtle);
        assert.equal(
          text(row).split(person.phone).length - 1,
          1,
          "the phone remains visible once alongside join status",
        );
        row.props.onPress();
        assert.deepEqual(
          routes.at(-1),
          { pathname: "/person/[id]", params: { id: person.id } },
          "status presentation does not change opening the contact",
        );
      }
    }

  for (const otherJoined of [0, 1] as const) {
    fixture(addOrFind, "viewer");
    const preferred: FixturePerson = {
      ...people[0],
      currency: "AFN",
      balance: 0,
      last_entry_at: null,
    };
    const foreign: FixturePerson = {
      ...people[0],
      currency: "USD",
      balance: 50,
      last_entry_at: 100,
      tab_id: "foreign-shared",
      tab_closed_at: null,
      tab_other_joined: otherJoined,
    };
    peopleByVault.set("kaata", [
      { ...preferred, last_entry_at: 100, currency_balances: [preferred, foreign] },
    ]);
    await flush();
    const row = personRows()[0];
    const amount = nodes(row).find(
      (node) => typeof node.type === "function" && node.type.name === "RightAmount",
    )!;
    assert.ok(amount);
    assert.equal(amount.props.balance, 0);
    assert.equal(
      amount.props.hasEntries,
      false,
      "a foreign tally does not invent preferred-currency activity",
    );
    const renderedAmount = amount.type(amount.props);
    assert.ok(text(renderedAmount).includes("personAdd.rightAmount.new"));
    assert.equal(
      text(renderedAmount).includes("personAdd.rightAmount.settled"),
      false,
      "AFN without tallies is not mislabeled settled because USD has activity",
    );
    assert.equal(
      nodes(row).some((node) => node.type === "SharedBadge"),
      otherJoined === 1,
      "join presentation still reads the actual foreign-currency account",
    );
    assert.equal(
      nodes(row).some((node) => node.type === "Text" && node.props.children === "tab.chip.waiting"),
      otherJoined === 0,
    );
  }

  const homePages = () =>
    nodes(tree).filter((node) => typeof node.type === "function" && node.type.name === "HomePage");
  const renderList = (node: any): any => {
    if (Array.isArray(node)) return node.map(renderList);
    if (!node?.props) return node;
    if (typeof node.type === "function" && node.type.name === "CustomerRows") {
      const key = node.key ?? "active";
      if (!customerRowHooks.has(key)) customerRowHooks.set(key, uiHooks());
      const rowHooks = customerRowHooks.get(key)!;
      const previous = activePageReact;
      let rows: any;
      try {
        activePageReact = rowHooks.react;
        rows = rowHooks.render(() => node.type(node.props));
      } finally {
        activePageReact = previous;
      }
      return renderList(rows);
    }
    if (typeof node.type === "function" && node.type.name === "HomePage") {
      const key = node.key ?? node.props.scrollScope;
      if (pageHooks?.key !== key) {
        pageHooks?.hooks.unmount();
        pageHooks = { key, hooks: uiHooks() };
      }
      const previous = activePageReact;
      let page: any;
      try {
        activePageReact = pageHooks!.hooks.react;
        page = pageHooks!.hooks.render(() => node.type(node.props));
      } finally {
        activePageReact = previous;
      }
      return renderList(page);
    }
    if (typeof node.type === "function") return renderList(node.type(node.props));
    return { ...node, props: { ...node.props, children: renderList(node.props.children) } };
  };
  homeRenderedNodes = () => (screen === home ? nodes(renderList(homePages())) : []);
  const homeInput = () => byLabel("customers.search")!;
  const settleHomeCommit = () => {
    for (let turn = 0; turn < 10 && (dirty || effects.length); turn++) {
      if (dirty) {
        dirty = false;
        cursor = 0;
        tree = screen();
      }
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    }
  };
  const homeOptions = () => {
    if (!byLabel("customers.listOptions")) {
      homeInput().props.onPress();
      homeInput().props.onFocus();
      keyboardEvent(platform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      settleHomeCommit();
    }
    if (!find("CustomerListOptions")) {
      byLabel("customers.listOptions")!.props.onPress();
      // The popover measures after its expanded commit in useLayoutEffect.
      // Settle that synchronous commit/effect sequence before inspecting it.
      settleHomeCommit();
    }
    return find("CustomerListOptions")!;
  };
  const homeRows = () => {
    const rendered = homeRenderedNodes();
    const hidden = new Set(
      rendered
        .filter((node) => flattenStyle(node.props.style)?.display === "none")
        .flatMap((node) => nodes(node).filter((child) => child.type === "PersonRow")),
    );
    return rendered.filter((node) => node.type === "PersonRow" && !hidden.has(node));
  };
  const resultCounts = () =>
    homeRenderedNodes().filter(
      (node) =>
        node.type === "Text" &&
        ["customers.search.result", "customers.search.results"].includes(node.props.children),
    );
  const homeRow = (id: string) => homeRows().find((node) => node.props.person.id === id)!;
  const homeIds = () => homeRows().map((node) => node.props.person.id);
  const summaryPeople = () => find("HomeBalanceSummary")!.props.people;
  const overviewTotals = () => ({
    collect: sumAmounts(
      summaryPeople()
        .filter((person: any) => !person.tab_unsynced && person.balance > 0)
        .map((person: any) => person.balance),
    ),
    pay: sumAmounts(
      summaryPeople()
        .filter((person: any) => !person.tab_unsynced && person.balance < 0)
        .map((person: any) => -person.balance),
    ),
  });
  const selection = () => find("SelectionToolbar");
  const expectBottomDock = (selecting = false) => {
    const keyboard = renderList(find("SearchKeyboardFrame")!);
    assert.equal(find("Keyboard"), undefined, "Home has one native-motion frame and no JS avoider");
    assert.equal(flattenStyle(keyboard.props.style).flex, 1);
    const surface = tree;
    const target = [surface.props.children].flat().find((node) => node?.type === "BlurTargetView")!;
    assert.ok(target, "Home supplies a dedicated content blur target");
    assert.ok(
      nodes(target).some((node) => node.props.accessibilityLabel === "menu.title.profile"),
      "the target contains the top navigation as well as the customer list",
    );
    assert.notEqual(target.props.accessible, true);
    assert.equal(
      nodes(target).some((node) => node.type === "HomeFilterPopover"),
      false,
    );
    const children = [keyboard.props.children].flat().filter((node) => node?.props);
    const list = children.find((node) => nodes(node).some((child) => child.type === "ScrollView"));
    const dockHost = children.find((node) => node.props.testID === "home-toast-dock");
    assert.ok(
      list && dockHost && list !== dockHost,
      "Search is a fixed footer outside the scroll area",
    );
    assert.equal(dockHost.type, "AnimatedView");
    const dock = nodes(dockHost).find((node) => node.type === "SearchKeyboardFooter")!;
    assert.ok(dock, "Native keyboard motion stays inside the toast-lift host");
    assert.equal(dock.props.closedPadding, 12);
    assert.equal(
      homeToastBottomOffset,
      12,
      "Toast clearance uses the homepage's own bottom spacing",
    );
    assert.equal(dock.props.openPadding, 8);
    assert.equal(flattenStyle(list.props.style).flex, 1, "The list fills the space above the dock");
    assert.ok(children.indexOf(dockHost) > children.indexOf(list));
    assert.notEqual(
      flattenStyle(dockHost.props.style).position,
      "absolute",
      "The dock reserves its own height",
    );
    const hostStyle = flattenStyle(dockHost.props.style);
    assert.equal(hostStyle.backgroundColor, colors.bgDefault);
    assert.equal(hostStyle.paddingBottom, 84, "Opaque background covers the toast lift");
    assert.equal(hostStyle.paddingBottom + hostStyle.marginBottom, 0, "The skirt adds no idle gap");
    assert.equal(nodes(dockHost).filter((node) => node.type === "SearchKeyboardFooter").length, 1);
    assert.equal(
      flattenStyle(dock.props.style).backgroundColor,
      colors.bgDefault,
      "the keyboard-aware controls retain the restored white footer surface",
    );
    assert.equal(nodes(list).filter((node) => node.type === "TextInput").length, 0);
    assert.equal(nodes(dock).filter((node) => node.type === "TextInput").length, 1);
    const physicalRow = nodes(dock).find(
      (node) =>
        node.type === "View" &&
        [node.props.children]
          .flat()
          .some(
            (child) =>
              child?.type === "View" && nodes(child).some((node) => node.type === "TextInput"),
          ),
    )!;
    assert.equal(
      flattenStyle(physicalRow.props.style).flexDirection,
      "row",
      "The dock keeps physical LTR placement in every language",
    );
    const rowChildren = [physicalRow.props.children].flat().filter((node) => node?.props);
    assert.ok(nodes(rowChildren[0]).some((node) => node.type === "TextInput"));
    assert.equal(
      byLabel("customers.listOptions") != null,
      dock.props.keyboardShown || find("HomeFilterPopover")!.props.visible,
      "Filter controls remain available while search or its popup is open",
    );
    if (dock.props.keyboardShown || find("HomeFilterPopover")!.props.visible)
      assert.equal(rowChildren[1].props.accessibilityLabel, "customers.listOptions");
    assert.equal(
      nodes(list).some((node) => node.type === "HomeBalanceSummary"),
      true,
    );
    const scrolling = nodes(list).find((node) => node.type === "ScrollView")!;
    const nativeScroll = nodes(list).find(
      (node) => node.type === "GestureDetector" && node.props.children === scrolling,
    )!;
    assert.ok(
      nativeScroll,
      "The existing native vertical scroll participates in gesture arbitration",
    );
    assert.equal(nativeScroll.props.gesture.kind, "native");
    assert.equal(
      nodes(scrolling).find((node) => node.type === "HomeBalanceFilterSwipe")!.props.nativeGesture,
      nativeScroll.props.gesture,
      "List filtering shares the native scroll relationship without wrapping the currency carousel",
    );
    assert.equal(
      nodes(scrolling).some((node) => node.type === "HomeBalanceSummary"),
      true,
      "Balance cards scroll away with customers",
    );
    const scrollChildren = [scrolling.props.children].flat().filter((node) => node?.props);
    assert.deepEqual(
      scrollChildren.map((node) => node.props.testID),
      ["home-balance-section", "home-nav-divider", "home-customer-content"],
    );
    assert.deepEqual(
      scrolling.props.stickyHeaderIndices,
      [1],
      "Only the divider pins below navigation",
    );
    const divider = scrollChildren[1];
    assert.equal(divider.props.pointerEvents, "none");
    assert.equal(divider.props.accessible, false);
    assert.equal(flattenStyle(divider.props.style).display, selecting ? "none" : undefined);
    const balanceSection = nodes(list).find(
      (node) => node.props.testID === "home-balance-section",
    )!;
    assert.ok(balanceSection, "balance cards retain a dedicated layout section");
    assert.equal(flattenStyle(balanceSection.props.style).display, selecting ? "none" : undefined);
    assert.equal(balanceSection.props.pointerEvents, selecting ? "none" : "auto");
    assert.equal(balanceSection.props.accessibilityElementsHidden, selecting);
    assert.equal(
      balanceSection.props.importantForAccessibility,
      selecting ? "no-hide-descendants" : "auto",
    );
    assert.ok(
      nodes(balanceSection).some((node) => node.type === "HomeBalanceSummary"),
      "hiding balances preserves their carousel state for this visit",
    );
    if (selecting) {
      const top = nodes(keyboard).find((node) => node.props.testID === "home-selection-toolbar")!;
      assert.ok(top && nodes(top).some((node) => node.type === "SelectionToolbar"));
      assert.equal(
        nodes(tree).some((node) => node.props.testID === "home-selection-toolbar"),
        false,
        "selection belongs to the keyboard-aware page rather than a separate root row",
      );
      assert.equal(flattenStyle(top.props.style).position, "absolute");
      assert.equal(top.props.pointerEvents, "box-none");
      assert.equal(
        flattenStyle(top.props.style).overflow,
        "visible",
        "the toolbar's rounded corners and shadow do not clip scrolling rows",
      );
      assert.equal(
        flattenStyle(top.props.style).backgroundColor,
        undefined,
        "the overlay wrapper leaves the area around the opaque toolbar clear",
      );
      assert.equal(
        nodes(keyboard).some((node) => node.type === "SelectionToolbar"),
        true,
      );
      assert.equal(
        nodes(dock).some((node) => node.type === "SelectionToolbar"),
        false,
      );
      assert.equal(
        nodes(scrolling).some((node) => node.type === "SelectionToolbar"),
        false,
      );
      assert.equal(nodes(keyboard).filter((node) => node.type === "SelectionToolbar").length, 1);
      top.props.onLayout({ nativeEvent: { layout: { height: 148 } } });
      const measured = renderList(find("SearchKeyboardFrame")!);
      const measuredContent = nodes(measured).find(
        (node) => node.props.testID === "home-customer-content",
      )!;
      assert.equal(
        flattenStyle(measuredContent.props.style).paddingTop,
        160,
        "the first customer starts below the measured overlay with a 12pt gap",
      );
      assert.equal(
        find("HomeBalanceSummary")!.props.active,
        false,
        "hidden cards cannot auto-advance",
      );
      assert.equal(
        byLabel("personAdd.new"),
        undefined,
        "Selection leaves room for search instead of Add",
      );
    } else {
      assert.equal(
        nodes(keyboard).some((node) => node.props.testID === "home-selection-toolbar"),
        false,
      );
      assert.equal(
        flattenStyle(scrollChildren[2].props.style).paddingTop,
        12,
        "ending selection restores ordinary list spacing",
      );
    }
  };
  const balanceTotals = () => {
    const { collect, pay, pending } = selection()!.props.financialSummaries[0].summary;
    return { collect, pay, pending };
  };
  const selectedHomeIds = () =>
    homeRows()
      .filter((row) => row.props.selected)
      .map((row) => row.props.person.id);
  const expectInlineSearch = async () => {
    await flush();
    assert.equal(homeInput().type, "TextInput");
  };
  const changeHomeQuery = async (query: string) => {
    homeInput().props.onChangeText(query);
    await flush();
  };
  const resetInlineSearch = async () => {
    selection()?.props.onClose();
    homeInput().props.onChangeText("");
    homeOptions().props.onChange({ sort: "recent", group: "all" });
    await flush();
  };
  const openSelection = async () => {
    const row = homeRows().find((candidate) => typeof candidate.props.onLongPress === "function");
    assert.ok(row, "eligible members can select contacts");
    row.props.onLongPress(row.props.person);
    await flush();
    if (!selection()) {
      const menu = find("BottomSheet")!;
      assert.equal(menu.props.visible, true);
      const action = menu.props.actions.find((item: any) => item.label === "selection.start");
      assert.ok(action);
      menu.props.onDismiss();
      await flush();
      action.onPress();
      await flush();
    }
    assert.equal(selection()!.props.count, 1);
    assert.equal(
      find("HomeBalanceSummary")!.props.active,
      false,
      "Contact selection pauses the balance carousel without hiding its figures",
    );
    expectBottomDock(true);
    homeRow(row.props.person.id).props.onPress(row.props.person);
    await flush();
    assert.equal(selection()!.props.count, 0);
  };
  const removeSelected = async () => {
    const action = selection()?.props.actions.find((item: any) => item.key === "remove");
    assert.ok(action);
    action.onPress();
    await flush();
    const dialog = find("ConfirmDialog")!;
    assert.ok(dialog.props.visible, "bulk removal waits for confirmation");
    return dialog;
  };

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(home, "owner", nextRtl, nextPlatform);
      await flush();
      assert.deepEqual(reviewPromptOptions?.context, {
        installId: "install",
        accountId: null,
        vaultId: "kaata",
      });
      assert.equal(reviewPromptOptions?.ready, true, "Only settled Home can offer an idle review");
      assert.equal(typeof tree.props.onTouchStart, "function");
      tree.props.onTouchStart();
      assert.equal(reviewInteractionCancels, 1, "Any Home touch cancels a pending review");
      find("Bell")!.props.onOpen();
      assert.equal(
        reviewInteractionCancels,
        2,
        "Opening notifications cancels reviews even without a touch event",
      );
      find("Bell")!.props.onVisibilityChange(true);
      await flush();
      assert.equal(
        reviewPromptOptions?.ready,
        false,
        "An already-open notification inbox also blocks newly arriving review opportunities",
      );
      find("Bell")!.props.onVisibilityChange(false);
      await flush();
      assert.equal(reviewPromptOptions?.ready, true, "Closing the inbox restores Home readiness");
      const beforeCard = reviewInteractionCancels;
      find("HomeBalanceSummary")!.props.onDirectionChange("collect", "AFN");
      await flush();
      assert.equal(reviewInteractionCancels, beforeCard + 1, "Card actions cancel pending reviews");
      find("HomeBalanceSummary")!.props.onDirectionChange("collect", "AFN");
      await flush();
      assert.deepEqual(routes, []);
      assert.deepEqual(writes, []);

      homeInput().props.onFocus();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      await flush();
      assert.equal(
        reviewPromptOptions?.ready,
        false,
        "Search keyboard takes priority over reviews",
      );
      homeInput().props.onChangeText("Ahmad");
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(reviewPromptOptions?.ready, false, "A search query is an ongoing task");
      homeInput().props.onChangeText("");
      await flush();
      assert.equal(reviewPromptOptions?.ready, true);

      homeOptions();
      await flush();
      assert.equal(reviewPromptOptions?.ready, false, "Open filters prevent a review request");
      find("HomeFilterPopover")!.props.onDismiss();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(reviewPromptOptions?.ready, true);
      await openSelection();
      assert.equal(
        reviewPromptOptions?.ready,
        false,
        "Contact selection prevents a review request",
      );
      selection()!.props.onClose();
      await flush();
      assert.equal(reviewPromptOptions?.ready, true);
      byLabel("menu.title.vaultSwitcher")!.props.onPress();
      await flush();
      assert.equal(reviewPromptOptions?.ready, false, "The Kaata picker blocks review UI");
      assert.equal(routes.length + writes.length, 0);
    }

  for (const nextRtl of [false, true]) {
    fixture(home, "owner", nextRtl);
    enabledCurrencies = ["AFN", "JPY"];
    const amountRow = (
      id: string,
      name: string,
      currency: string,
      balance: number,
    ): FixturePerson => ({
      ...people[0],
      id,
      name,
      currency,
      balance,
      last_entry_at: 100,
      selection_totals: {
        currency,
        debtCount: balance > 0 ? 1 : 0,
        creditCount: balance < 0 ? 1 : 0,
        debtMinor: Math.round(Math.max(0, balance) * 100),
        creditMinor: Math.round(Math.max(0, -balance) * 100),
      },
    });
    const a = amountRow("currency-a", "Alfa", "AFN", 500);
    const b = amountRow("currency-b", "Bravo", "AFN", -70);
    const fullPeople = [
      { ...a, currency_balances: [a, amountRow(a.id, a.name, "USD", -10)] },
      { ...b, currency_balances: [b, amountRow(b.id, b.name, "USD", 50)] },
    ];
    peopleByVault.set("kaata", fullPeople);
    await flush();
    const cards = find("HomeBalanceSummary")!.props.balances;
    const initialReads = homeReadScopes.length;
    assert.deepEqual(
      [...homeOptions().props.currencies].sort(),
      ["AFN", "JPY", "USD"],
      "both locales offer enabled and disabled historical denominations",
    );
    homeOptions().props.onChange({
      ...homeOptions().props.preference,
      currency: "USD",
      sort: "amount_desc",
    });
    await flush();
    assert.deepEqual(
      homeIds(),
      [b.id, a.id],
      "USD amount sorting is independent of opposite AFN balances",
    );
    assert.equal(homeOptions().props.amountSortAvailable, true);
    assert.ok(
      homeRows().every(
        (row) =>
          row.props.person.currency === "USD" && row.props.person.currency_balances.length === 1,
      ),
    );
    assert.equal(selectedCurrency, "AFN");
    assert.equal(
      homeReadScopes.length,
      initialReads,
      "local currency choices reuse the loaded snapshot",
    );
    assert.deepEqual(
      find("HomeBalanceSummary")!.props.balances,
      cards,
      "cards stay whole-book when list currency changes",
    );
    homeOptions().props.onChange({ ...homeOptions().props.preference, direction: "collect" });
    await flush();
    assert.deepEqual(homeIds(), [b.id]);
    assert.equal(resultCounts().length, 0);
    assert.equal(JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).currency, "USD");
    const oldOptions = homeOptions().props;
    vaultId = "other-currency-book";
    peopleByVault.set(vaultId, [amountRow("other", "Other", "AFN", 7)]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.equal(
      homeOptions().props.preference.currency,
      undefined,
      "another Kaata starts with its own All-currency preference",
    );
    assert.deepEqual(
      [...homeOptions().props.currencies].sort(),
      ["AFN", "JPY"],
      "historical choices cannot leak between Kaatas",
    );
    oldOptions.onChange({ ...oldOptions.preference, currency: "USD" });
    await flush();
    assert.equal(
      homePreferenceMeta.has("customer_home:local:other-currency-book"),
      false,
      "retained currency options cannot write the next Kaata's preference",
    );
    vaultId = "kaata";
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.equal(
      homeOptions().props.preference.currency,
      "USD",
      "returning to the Kaata restores its persisted currency",
    );
    assert.equal(homeOptions().props.preference.direction, "collect");
    assert.deepEqual(homeIds(), [b.id]);
    await changeHomeQuery("Bravo");
    // Chips expose the translated clear action as a hint, not their visible ISO label.
    const currencyChip = homeRenderedNodes().find(
      (node) => node.props.accessibilityHint === "customers.currencyFilter.clear",
    )!;
    assert.ok(currencyChip);
    currencyChip.props.onPress();
    await flush();
    assert.equal(homeInput().props.value, "Bravo");
    assert.equal(homeOptions().props.preference.direction, "collect");
    assert.equal(homeOptions().props.preference.currency, undefined);
    assert.equal(homeOptions().props.preference.sort, "recent");
    assert.equal(homeOptions().props.amountSortAvailable, false);
    assert.deepEqual(
      homeIds(),
      [b.id],
      "clearing only USD keeps query/direction and restores every currency row",
    );
    assert.equal(homeRows()[0].props.person.currency_balances.length, 2);
    byLabel("search.clearAll")!.props.onPress();
    await flush();
    homeOptions().props.onChange({ ...homeOptions().props.preference, currency: "JPY" });
    await flush();
    assert.deepEqual(
      homeIds(),
      [],
      "an enabled denomination without ledger rows is an honest empty result",
    );
    assert.ok(find("EmptyState")?.props.title === "customers.noResults");
    assert.deepEqual(find("HomeBalanceSummary")!.props.balances, cards);
    byLabel("search.clearAll")!.props.onPress();
    await flush();
    assert.equal(homeOptions().props.preference.currency, undefined);
    assert.deepEqual(homeIds().sort(), [a.id, b.id]);
    assert.equal(homeInput().props.value, "");
  }

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(home, "owner", nextRtl, nextPlatform);
      enabledCurrencies = ["AFN", "USD"];
      const amountRow = (
        id: string,
        name: string,
        currency: string,
        balance: number,
      ): FixturePerson => ({ ...people[0], id, name, currency, balance });
      const mixed = amountRow("card-mixed", "Card Alfa", "AFN", 100);
      const collecting = amountRow("card-collect", "Card Bravo", "AFN", 40);
      const paying = amountRow("card-pay", "Card Charlie", "AFN", -70);
      const neutral = amountRow("card-neutral", "Card Neutral", "AFN", 0);
      peopleByVault.set("kaata", [
        { ...mixed, currency_balances: [mixed, amountRow(mixed.id, mixed.name, "USD", -20)] },
        {
          ...collecting,
          currency_balances: [collecting, amountRow(collecting.id, collecting.name, "USD", 10)],
        },
        { ...paying, currency_balances: [paying, amountRow(paying.id, paying.name, "USD", -5)] },
        neutral,
      ]);
      groupState = {
        groups: [{ id: "card-members", name: "Card members", member_count: 3 }],
        groupsByPerson: {
          [mixed.id]: ["card-members"],
          [collecting.id]: ["card-members"],
          [paying.id]: ["card-members"],
        },
      };
      await flush();
      const summary = () => find("HomeBalanceSummary")!.props;
      const swipe = () => find("HomeBalanceFilterSwipe")!.props;
      const cards = summary().balances;
      const firstCardChange = summary().onDirectionChange;
      const firstSwipeChange = swipe().onDirectionChange;
      const allIds = [mixed.id, collecting.id, paying.id, neutral.id].sort();
      assert.equal(summary().direction, "all");
      assert.equal(summary().interactionEnabled, true);
      assert.equal(swipe().enabled, true);
      assert.deepEqual(homeIds().sort(), allIds);
      summary().onDirectionChange("collect", "AFN");
      await flush();
      assert.equal(summary().direction, "collect");
      assert.equal(swipe().direction, "collect");
      assert.equal(summary().currencyFilter, "AFN");
      assert.deepEqual(homeIds().sort(), [mixed.id, collecting.id].sort());
      assert.equal(
        JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).direction,
        "collect",
        "card selection uses the existing persisted direction preference",
      );
      assert.equal(
        JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).currency,
        "AFN",
        "a multi-currency card filters to the tapped denomination",
      );
      summary().onDirectionChange("pay", "AFN");
      await flush();
      assert.deepEqual(homeIds(), [paying.id], "AFN pay excludes a contact who only owes USD");
      summary().onDirectionChange("pay", "USD");
      await flush();
      assert.deepEqual(homeIds().sort(), [mixed.id, paying.id].sort());
      assert.equal(summary().currencyFilter, "USD", "another currency narrows to its own card");
      assert.equal(
        homeIds().filter((id) => id === mixed.id).length,
        1,
        "a contact owing different currencies in both directions appears once on either side",
      );
      summary().onDirectionChange("pay", "USD");
      await flush();
      assert.deepEqual(
        homeIds().sort(),
        allIds,
        "toggling the active card off restores both sides",
      );
      swipe().onDirectionChange("pay");
      await flush();
      assert.equal(summary().direction, "pay", "list swiping controls the same card selection");
      assert.equal(summary().currencyFilter, undefined, "list swipes affect every currency card");
      assert.deepEqual(homeIds().sort(), [mixed.id, paying.id].sort());
      summary().onDirectionChange("pay", "AFN");
      await flush();
      assert.deepEqual(homeIds(), [paying.id], "a same-side tap narrows a global direction");
      assert.equal(summary().currencyFilter, "AFN");
      swipe().onDirectionChange("pay");
      await flush();
      assert.equal(summary().direction, "pay");
      assert.equal(
        summary().currencyFilter,
        undefined,
        "swiping the already-selected side still clears the currency restriction",
      );
      assert.deepEqual(homeIds().sort(), [mixed.id, paying.id].sort());
      swipe().onDirectionChange("all");
      await flush();
      assert.deepEqual(homeIds().sort(), allIds);
      assert.deepEqual(summary().balances, cards, "direction controls keep the whole-book totals");
      assert.equal(
        JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).currency,
        undefined,
        "turning off the card filter or using a list swipe restores all currencies",
      );

      homeOptions().props.onChange({
        sort: "recent",
        group: "all",
        direction: "collect",
        currency: ["AFN", "USD"],
      });
      await flush();
      find("HomeFilterPopover")!.props.onDismiss();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      summary().onDirectionChange("collect", "USD");
      await flush();
      assert.deepEqual(homeIds(), [collecting.id]);
      assert.equal(
        summary().currencyFilter,
        "USD",
        "a highlighted card within a multi-selection narrows to that card rather than clearing",
      );
      const narrowedPreference = homePreferenceMeta.get("customer_home:local:kaata");
      summary().onDirectionChange("pay", "EUR");
      await flush();
      assert.equal(
        homePreferenceMeta.get("customer_home:local:kaata"),
        narrowedPreference,
        "retained taps for unavailable currencies cannot change preferences",
      );

      for (const sort of ["amount_asc", "amount_desc"]) {
        homeOptions().props.onChange({
          sort,
          group: "all",
          direction: "collect",
          currency: "USD",
        });
        await flush();
        find("HomeFilterPopover")!.props.onDismiss();
        keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
        keyboardEvent("keyboardDidHide");
        await flush();
        summary().onDirectionChange("pay", "AFN");
        await flush();
        assert.equal(
          JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).sort,
          sort,
          "changing to one other currency retains a valid denomination-specific amount sort",
        );
        swipe().onDirectionChange("pay");
        await flush();
        const global = JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!);
        assert.equal(global.currency, undefined);
        assert.equal(global.direction, "pay");
        assert.equal(
          global.sort,
          "recent",
          "a list swipe clearing currency never compares unlike amounts",
        );

        homeOptions().props.onChange({ sort, group: "all", direction: "pay", currency: "USD" });
        await flush();
        find("HomeFilterPopover")!.props.onDismiss();
        keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
        keyboardEvent("keyboardDidHide");
        await flush();
        summary().onDirectionChange("pay", "USD");
        await flush();
        const cleared = JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!);
        assert.equal(cleared.currency, undefined);
        assert.equal(cleared.direction, "all");
        assert.equal(cleared.sort, "recent", "same-card clearing also restores a valid sort");
      }
      const rapidCardChange = summary().onDirectionChange;
      rapidCardChange("collect", "USD");
      rapidCardChange("collect", "USD");
      await flush();
      assert.equal(summary().direction, "all");
      assert.equal(summary().currencyFilter, undefined);
      assert.deepEqual(
        homeIds().sort(),
        allIds,
        "two rapid card taps read the latest optimistic choice and toggle both filters off",
      );
      assert.deepEqual(summary().balances, cards, "rapid or sorted filtering leaves totals global");

      homeOptions().props.onChange({
        sort: "name_desc",
        group: ["card-members"],
        direction: "all",
        currency: "USD",
      });
      await flush();
      find("HomeFilterPopover")!.props.onDismiss();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      await changeHomeQuery("Card");
      assert.equal(summary().interactionEnabled, true);
      firstCardChange("collect", "USD");
      await flush();
      assert.deepEqual(homeIds(), [collecting.id], "card direction respects the chosen currency");
      const preference = JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!);
      assert.equal(preference.currency, "USD");
      assert.equal(preference.sort, "name_desc");
      assert.deepEqual(preference.group, ["card-members"]);
      assert.equal(preference.direction, "collect");
      assert.equal(homeInput().props.value, "Card");
      assert.deepEqual(summary().balances, cards);
      firstSwipeChange("pay");
      await flush();
      assert.deepEqual(homeIds(), [paying.id, mixed.id]);
      swipe().onDirectionChange("all");
      await flush();
      assert.deepEqual(homeIds(), [paying.id, collecting.id, mixed.id]);
      assert.equal(homeInput().props.value, "Card");

      const retainedCardChange = summary().onDirectionChange;
      const retainedSwipeChange = swipe().onDirectionChange;
      const saved = homePreferenceMeta.get("customer_home:local:kaata");
      homeInput().props.onPress();
      homeInput().props.onFocus();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      await flush();
      assert.equal(summary().interactionEnabled, true);
      assert.equal(swipe().enabled, false);
      retainedSwipeChange("pay");
      await flush();
      assert.equal(summary().direction, "all", "open search blocks retained list swipe controls");
      assert.equal(homePreferenceMeta.get("customer_home:local:kaata"), saved);
      const dismissalsBeforeCard = keyboardDismissals;
      retainedCardChange("pay", "USD");
      await flush();
      assert.equal(summary().direction, "pay", "card taps remain available during search");
      assert.ok(
        keyboardDismissals > dismissalsBeforeCard,
        "a card tap dismisses search's keyboard",
      );
      assert.equal(homeInput().props.value, "Card");
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      summary().onDirectionChange("pay", "USD");
      await flush();
      assert.equal(homePreferenceMeta.get("customer_home:local:kaata"), saved);
      homeOptions();
      await flush();
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      retainedCardChange("collect", "USD");
      retainedSwipeChange("collect");
      await flush();
      assert.equal(summary().direction, "all", "open filters block retained direction controls");
      find("HomeFilterPopover")!.props.onDismiss();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      await openSelection();
      assert.equal(summary().interactionEnabled, false);
      assert.equal(swipe().enabled, false);
      retainedCardChange("pay", "USD");
      retainedSwipeChange("pay");
      await flush();
      assert.equal(
        summary().direction,
        "all",
        "contact selection blocks hidden direction controls",
      );
      assert.equal(homePreferenceMeta.get("customer_home:local:kaata"), saved);
      selection()!.props.onClose();
      await flush();
      assert.equal(summary().interactionEnabled, true);
      assert.equal(swipe().enabled, true);
      byLabel("menu.title.vaultSwitcher")!.props.onPress();
      await flush();
      assert.equal(find("VaultPicker")!.props.visible, true);
      assert.equal(summary().interactionEnabled, false);
      retainedCardChange("pay", "USD");
      retainedSwipeChange("pay");
      await flush();
      assert.equal(summary().direction, "all", "the Kaata switcher blocks background controls");
      assert.equal(homePreferenceMeta.get("customer_home:local:kaata"), saved);
      assert.equal(routes.length, 0);
      assert.equal(writes.length, 0, "balance filtering never mutates ledger data");
    }

  fixture(home, "owner");
  activeVaultsOverride = [
    { id: "kaata", name: "Shop", currency: "AFN" },
    { id: "foreign", name: "Other shop", currency: "USD" },
  ];
  enabledCurrenciesByVault.set("kaata", ["USD", "EUR"]);
  enabledCurrenciesByVault.set("foreign", ["USD", "CAD", "AUD"]);
  await flush();
  const pickerCurrencies = () =>
    find("VaultPicker")!.props.vaults.map((book: any) => [book.id, book.currencies]);
  assert.deepEqual(
    pickerCurrencies(),
    [
      ["kaata", ["USD", "EUR"]],
      ["foreign", ["USD", "CAD", "AUD"]],
    ],
    "each switcher row keeps its own enabled list, without adding a disabled legacy currency",
  );
  enabledCurrenciesByVault.set("foreign", ["JPY", "USD"]);
  ledgerEvents.emitLedgerApplied("foreign", "remote");
  await runTimers();
  assert.deepEqual(
    pickerCurrencies()[1],
    ["foreign", ["JPY", "USD"]],
    "other-book settings refresh the switcher",
  );
  failedEnabledCurrencies.add("foreign");
  ledgerEvents.emitLedgerApplied("foreign", "remote");
  await runTimers();
  assert.deepEqual(
    pickerCurrencies(),
    [
      ["kaata", ["USD", "EUR"]],
      ["foreign", ["USD"]],
    ],
    "a failed other-book currency read falls back only that row and keeps switching available",
  );

  for (const invalidation of ["vault", "account", "unmount"]) {
    fixture(home, "owner");
    activeVaultsOverride = [
      { id: "kaata", name: "Shop", currency: "AFN" },
      { id: "foreign", name: "Other shop", currency: "USD" },
    ];
    await flush();
    let finishCurrencyRead!: (codes: string[]) => void;
    delayedEnabledCurrencies.set(
      "foreign",
      new Promise((resolve) => {
        finishCurrencyRead = resolve;
      }),
    );
    ledgerEvents.emitLedgerApplied("foreign", "remote");
    await runTimers();
    delayedEnabledCurrencies.delete("foreign");
    if (invalidation === "unmount") {
      unmount();
      dirty = false;
      finishCurrencyRead(["JPY"]);
      for (let tick = 0; tick < 30; tick++) await Promise.resolve();
      assert.equal(dirty, false, "late switcher currency reads cannot update an unmounted home");
      continue;
    }
    const currentVault = invalidation === "vault" ? "replacement" : "kaata";
    activeVaultsOverride = [{ id: currentVault, name: "Current shop", currency: "GBP" }];
    enabledCurrenciesByVault.set(currentVault, ["GBP", "EUR"]);
    if (invalidation === "vault") {
      vaultId = currentVault;
      peopleByVault.set(currentVault, people);
      ledgerEvents.emitLedgerApplied(currentVault, "remote");
      await runTimers();
    } else {
      cachedAccountId = "replacement-account";
      for (const listener of [...identityListeners]) listener();
      await flush();
    }
    const expected = [[currentVault, ["GBP", "EUR"]]];
    assert.deepEqual(pickerCurrencies(), expected);
    finishCurrencyRead(["JPY"]);
    await flush();
    assert.deepEqual(
      pickerCurrencies(),
      expected,
      `${invalidation}: a late currency list cannot replace the current switcher`,
    );
  }

  for (const nextRole of ["viewer", "editor", "clerk"] as const) {
    fixture(home, nextRole);
    await flush();
    assert.equal(
      find("HomeBalanceSummary")!.props.interactionEnabled,
      true,
      "read-only and restricted roles can filter their visible customer balances",
    );
    find("HomeBalanceSummary")!.props.onDirectionChange("collect", "AFN");
    await flush();
    assert.deepEqual(homeIds(), ["ahmad"]);
    assert.equal(
      find("HomeBalanceSummary")!.props.currencyFilter,
      undefined,
      "single-currency Kaata card taps need no separate currency restriction",
    );
    find("HomeBalanceFilterSwipe")!.props.onDirectionChange("all");
    await flush();
    assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
    assert.equal(writes.length, 0);
  }

  const activityNow = 1_720_000_000_000;
  const recencyPeople = [
    { ...people[0], id: "aa3h", name: "Aa3h", last_entry_at: activityNow - 60 * 60_000 },
    { ...people[0], id: "matee", name: "Matee Saafi", last_entry_at: activityNow - 12 * 60_000 },
    {
      ...people[0],
      id: "zain",
      name: "Zain",
      last_entry_at: activityNow - 30 * 60_000,
      balance: -100,
    },
  ];
  fixture(home, "owner");
  peopleByVault.set("kaata", recencyPeople);
  await flush();
  assert.equal(homeOptions().props.preference.sort, "recent");
  assert.deepEqual(
    homeIds(),
    ["matee", "zain", "aa3h"],
    "Fresh Home puts the latest tally ahead of alphabetically earlier customers",
  );
  assert.equal(
    homePreferenceMeta.has("customer_home:local:kaata"),
    false,
    "Loading does not persist a default preference",
  );
  await changeHomeQuery("   ");
  assert.deepEqual(
    homeIds(),
    ["matee", "zain", "aa3h"],
    "Whitespace retains ordinary Home recency",
  );
  assert.equal(resultCounts().length, 0);
  peopleByVault.set(
    "kaata",
    recencyPeople.map((person) =>
      person.id === "aa3h" ? { ...person, last_entry_at: activityNow } : person,
    ),
  );
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.deepEqual(
    homeIds(),
    ["aa3h", "matee", "zain"],
    "Remote tally activity moves the updated customer first",
  );
  peopleByVault.set(
    "kaata",
    recencyPeople.map((person) =>
      person.id === "matee" ? { ...person, last_entry_at: activityNow + 1 } : person,
    ),
  );
  focusEpoch++;
  dirty = true;
  await flush();
  assert.deepEqual(
    homeIds(),
    ["matee", "zain", "aa3h"],
    "Returning Home refreshes recent ordering",
  );
  assert.equal(homePreferenceMeta.has("customer_home:local:kaata"), false);

  fixture(home, "owner");
  peopleByVault.set("kaata", recencyPeople);
  groupState = {
    groups: [{ id: "family", name: "Family", member_count: 2 }],
    groupsByPerson: { aa3h: ["family"], matee: ["family"] },
  };
  const legacyHomePreference = JSON.stringify({ sort: "outstanding_name", group: "family" });
  homePreferenceMeta.set("customer_search:local:kaata", legacyHomePreference);
  await flush();
  assert.deepEqual(homeOptions().props.preference, {
    sort: "recent",
    group: ["family"],
    direction: "all",
  });
  assert.deepEqual(
    homeIds(),
    ["matee", "aa3h"],
    "Legacy search default migrates to recency while retaining the group",
  );
  assert.equal(homePreferenceMeta.get("customer_search:local:kaata"), legacyHomePreference);
  assert.equal(
    homePreferenceMeta.has("customer_home:local:kaata"),
    false,
    "Legacy fallback is read without writing either preference",
  );

  fixture(home, "owner");
  peopleByVault.set("kaata", recencyPeople);
  const legacySearchPreference = JSON.stringify({ sort: "amount_asc", group: "all" });
  homePreferenceMeta.set("customer_search:local:kaata", legacySearchPreference);
  homePreferenceMeta.set(
    "customer_home:local:kaata",
    JSON.stringify({ sort: "outstanding_name", group: "all" }),
  );
  await flush();
  assert.equal(
    homeOptions().props.preference.sort,
    "outstanding_name",
    "An explicit new Home choice wins over legacy search preferences",
  );
  assert.deepEqual(homeIds(), ["aa3h", "matee", "zain"]);
  homeOptions().props.onChange({ sort: "name_desc", group: "all" });
  await flush();
  assert.deepEqual(JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!), {
    sort: "name_desc",
    group: "all",
  });
  assert.equal(
    homePreferenceMeta.get("customer_search:local:kaata"),
    legacySearchPreference,
    "Home choices do not overwrite old search preferences",
  );
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.deepEqual(homeIds(), ["zain", "matee", "aa3h"], "Reload preserves an explicit Home sort");
  assert.equal(byLabel("search.clearAll"), undefined, "A sort choice alone is not a filter");
  find("TextInput")!.props.onChangeText("Matee");
  await flush();
  byLabel("search.clearAll")!.props.onPress();
  await flush();
  assert.deepEqual(homeOptions().props.preference, {
    sort: "recent",
    group: "all",
    direction: "all",
  });
  assert.deepEqual(
    homeIds(),
    ["matee", "zain", "aa3h"],
    "Clear all restores recent activity instead of A–Z",
  );
  assert.deepEqual(JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!), {
    sort: "recent",
    group: "all",
    direction: "all",
  });

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
    assert.equal(homePages().length, 1, "Selection uses the same inline list");
    assert.equal(selection()!.props.count, 3, "Both directions retain their inline selections");
    assert.deepEqual(selectedHomeIds().sort(), ["ahmad", "fatima", "pay-person"]);
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(selectedHomeIds(), []);
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
    await expectInlineSearch();
    assert.equal(selection(), undefined, "Done returns the homepage to ordinary search");
    const changeSelectionQuery = homeInput().props.onChangeText;
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
    assert.deepEqual(overviewTotals(), { collect: 999.3, pay: 0.4 });
    await expectInlineSearch();
    const changeTotalsQuery = homeInput().props.onChangeText;
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
    homeOptions().props.onChange({ sort: "recent", group: "family" });
    await flush();
    assert.equal(selection()!.props.count, 2, "a group filter retains both hidden selections");
    assert.deepEqual(balanceTotals(), { collect: 0.1, pay: 0.29, pending: false });
    selection()!.props.onToggleAll();
    await flush();
    assert.deepEqual(balanceTotals(), { collect: 0.3, pay: 0.4, pending: false });
    homeOptions().props.onChange({ sort: "recent", group: "all" });
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
    assert.ok(
      summaryPeople().some((person: any) => person.tab_unsynced === 1),
      "The cards receive unknown shared state",
    );
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
    assert.deepEqual(overviewTotals(), { collect: 0.3, pay: 2.65 });
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
  await expectInlineSearch();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  homeOptions().props.onChange({ sort: "recent", group: "family" });
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
  // Done clears the inline selection before the ordinary home Back behavior.
  await resetInlineSearch();
  assert.equal(
    selection(),
    undefined,
    "resetting inline search ends selection before leaving home",
  );
  assert.equal(
    toasts.some((message) => message[0] === "home.exit.hint"),
    false,
  );

  fixture(home, "owner");
  await flush();
  await openSelection();
  selection()!.props.onToggleAll();
  await flush();
  const retainedSearchPress = homeInput().props.onPress;
  const cancelRemoval = await removeSelected();
  assert.equal(tParams.get("selection.removeContactsTitle")?.count, 2);
  assert.equal(homeInput().props.editable, false);
  retainedSearchPress();
  homeInput().props.onPress();
  homeInput().props.onFocus();
  await flush();
  assert.equal(
    find("HomeBalanceSummary")!.props.searchOpen,
    false,
    "Confirmation blocks retained and disabled search taps/focus",
  );
  assert.equal(byLabel("common.hideKeyboard"), undefined);
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
  assert.equal(homeInput().props.editable, false);
  homeInput().props.onPress();
  homeInput().props.onFocus();
  await flush();
  assert.equal(
    find("HomeBalanceSummary")!.props.searchOpen,
    false,
    "An in-flight batch blocks disabled search preparation",
  );
  assert.equal(byLabel("common.hideKeyboard"), undefined);
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

  fixture(home, "owner");
  await flush();
  await changeHomeQuery("Ahmad");
  await openSelection();
  homeRow("ahmad").props.onPress(people[0]);
  await flush();
  homeOptions();
  await flush();
  const lockedRemoval = await removeSelected();
  let finishLockedRemoval!: () => void;
  delayedArchive = new Promise((resolve) => {
    finishLockedRemoval = resolve;
  });
  lockedRemoval.props.onConfirm();
  await flush();
  assert.equal(selection()!.props.busy, true);
  assert.equal(homeInput().props.editable, false);
  homeInput().props.onChangeText("queued query");
  homeOptions().props.onChange({ sort: "name_desc", group: "all" });
  selection()!.props.onClose();
  await flush();
  assert.equal(homeInput().props.value, "Ahmad", "Queued input cannot change a removal in flight");
  assert.equal(homeOptions().props.preference.sort, "recent");
  assert.equal(selection()!.props.busy, true);
  finishLockedRemoval();
  await flush();
  assert.equal(selection(), undefined);

  for (const changedScope of ["vault", "account"]) {
    fixture(home, "owner");
    await flush();
    homeRow("ahmad").props.onLongPress(people[0]);
    await flush();
    const menu = find("BottomSheet")!;
    const staleEdit = menu.props.actions.find(
      (action: any) => action.label === "person.sheet.edit",
    ).onPress;
    const staleRemove = menu.props.actions.find(
      (action: any) => action.label === "common.remove",
    ).onPress;
    staleRemove();
    await flush();
    const confirmation = nodes(tree).find(
      (node) => node.type === "ConfirmDialog" && node.props.title === "common.remove.title",
    )!;
    assert.equal(confirmation.props.visible, true);
    if (changedScope === "vault") {
      vaultId = "replacement-kaata";
      peopleByVault.set(vaultId, [{ ...people[0], name: "Replacement with same ID" }]);
      ledgerEvents.emitLedgerApplied(vaultId, "remote");
      await runTimers();
    } else {
      cachedAccountId = "replacement-account";
      for (const listener of [...identityListeners]) listener();
      await flush();
    }
    staleEdit();
    staleRemove();
    await confirmation.props.onConfirm();
    await flush();
    assert.equal(
      routes.length,
      0,
      changedScope + ": retained Edit cannot open a same-ID customer in another scope",
    );
    assert.equal(
      archivedPeople.length,
      0,
      changedScope + ": retained confirmation cannot remove a same-ID customer in another scope",
    );
  }

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(home, "owner", nextRtl, nextPlatform);
      await flush();
      const dockHost = () => nodes(tree).find((node) => node.props.testID === "home-toast-dock")!;
      const offset = () => flattenStyle(dockHost().props.style).transform[0].translateY;
      const nativeInput = homeInput().props.ref.current;
      const ids = homeIds();
      const reads = homeReadScopes.length;
      assert.equal(offset(), 0, "An empty toast queue leaves the dock at its normal position");
      homeToastOffset = -72;
      dirty = true;
      await flush();
      expectBottomDock();
      assert.equal(offset(), -72, "A toast lifts the whole homepage dock");
      assert.ok(nodes(dockHost()).includes(homeInput()), "Search moves with the lifted dock");
      assert.ok(
        nodes(dockHost()).some((node) => node.props.accessibilityLabel === "personAdd.new"),
      );
      assert.equal(
        homeInput().props.ref.current,
        nativeInput,
        "Toast motion preserves the native input",
      );
      assert.deepEqual(homeIds(), ids);
      assert.equal(
        homeReadScopes.length,
        reads,
        "Toast motion never reloads the customer snapshot",
      );

      homeInput().props.onPress();
      homeInput().props.onFocus();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      await flush();
      assert.equal(offset(), 0, "A toast cannot lift the dock again above the keyboard");
      byLabel("customers.listOptions")!.props.onPress();
      await flush();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      assert.equal(offset(), 0, "Open filters keep their dock anchor steady after keyboard hide");
      find("HomeFilterPopover")!.props.onDismiss();
      await flush();
      assert.equal(offset(), -72, "A still-visible toast lifts the dock again after filters close");
      homeToastOffset = 0;
      dirty = true;
      await flush();
      assert.equal(offset(), 0, "Dismissal or expiry returns the dock to its normal position");
      assert.equal(homeInput().props.ref.current, nativeInput);
      assert.equal(find("SearchKeyboardFooter")!.props.closedPadding, 12);
      assert.equal(find("SearchKeyboardFooter")!.props.openPadding, 8);
    }

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(home, "owner", nextRtl, nextPlatform);
      await flush();
      await changeHomeQuery("Ahmad");
      searchInputFocused = true;
      homeInput().props.onPress();
      homeInput().props.onFocus();
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      await flush();

      const blursBeforeOpen = searchInputBlurs,
        dismissalsBeforeOpen = keyboardDismissals;
      byLabel("customers.listOptions")!.props.onPress();
      await flush();
      assert.equal(searchInputBlurs, blursBeforeOpen + 1, "Opening filters blurs the search input");
      assert.equal(
        keyboardDismissals,
        dismissalsBeforeOpen + 1,
        "Opening filters requests native keyboard dismissal",
      );
      assert.equal(searchInputFocused, false);
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      assert.equal(find("HomeFilterPopover")!.props.keyboardVisible, true);
      assert.equal(find("HomeFilterPopover")!.props.anchor.y, 548);
      assert.equal(find("CustomerListOptions")!.props.compact, true);

      // Native dismissal is asynchronous: the existing popup must survive the
      // keyboard event and follow the footer's newly available screen space.
      filterViewportHeight = 844;
      filterTriggerY = 728;
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      const popup = find("HomeFilterPopover")!;
      assert.equal(popup.props.visible, true, "Hiding the keyboard does not close filters");
      assert.equal(popup.props.keyboardVisible, false);
      assert.ok(find("CustomerListOptions"), "Filter choices remain usable after keyboard hide");
      assert.equal(popup.props.anchor.y, 728, "The popup follows the footer after keyboard hide");
      assert.equal(popup.props.viewport.height, 844);
      assert.ok(byLabel("customers.listOptions"), "An open popup retains its anchor button");
      assert.equal(byLabel("common.hideKeyboard"), undefined);
      assert.equal(homeInput().props.value, "Ahmad");
      expectBottomDock();

      // Focus/show callbacks already in the native queue can arrive after the
      // popup opens. They must dismiss again instead of restoring editable search.
      searchInputFocused = true;
      const dismissalsBeforeLateFocus = keyboardDismissals;
      homeInput().props.onFocus();
      await flush();
      assert.equal(searchInputFocused, false, "A late focus cannot reclaim the popup's keyboard");
      assert.ok(keyboardDismissals > dismissalsBeforeLateFocus);
      assert.equal(find("HomeBalanceSummary")!.props.searchOpen, false);
      const dismissalsBeforeLateShow = keyboardDismissals;
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
      if (nextPlatform === "ios") keyboardEvent("keyboardDidShow");
      await flush();
      assert.ok(
        keyboardDismissals > dismissalsBeforeLateShow,
        "Late show events are dismissed again",
      );
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      assert.equal(find("HomeFilterPopover")!.props.keyboardVisible, false);
      assert.equal(homeInput().props.value, "Ahmad");

      const options = find("CustomerListOptions")!;
      options.props.onChange({ ...options.props.preference, sort: "name_desc" });
      await flush();
      assert.equal(find("HomeFilterPopover")!.props.visible, true);
      assert.equal(find("CustomerListOptions")!.props.preference.sort, "name_desc");
      assert.equal(homeInput().props.value, "Ahmad");
      assert.equal(searchInputFocused, false, "Choosing a filter does not reopen the keyboard");

      // An outstanding native anchor measurement must not revive a popup after
      // it closes, even if it arrives after the footer has hidden its trigger.
      delayFilterMeasurements = true;
      byLabel("customers.listOptions")!.props.onLayout();
      assert.ok(pendingFilterMeasurements.length > 0);
      const focusesBeforeClose = searchInputFocuses;
      find("HomeFilterPopover")!.props.onDismiss();
      await flush();
      for (const complete of pendingFilterMeasurements.splice(0)) complete();
      await flush();
      assert.equal(find("HomeFilterPopover")!.props.visible, false);
      assert.equal(find("HomeFilterPopover")!.props.anchor, null);
      assert.equal(find("CustomerListOptions"), undefined);
      assert.equal(byLabel("customers.listOptions"), undefined, "Idle Home hides filters again");
      assert.equal(
        searchInputFocuses,
        focusesBeforeClose,
        "Closing filters does not refocus search",
      );
      assert.equal(searchInputFocused, false);
      assert.equal(homeInput().props.value, "Ahmad");
      assert.equal(
        JSON.parse(homePreferenceMeta.get("customer_home:local:kaata")!).sort,
        "name_desc",
        "Closing filters preserves the chosen sort",
      );
      assert.equal(routes.length, 0);
      assert.equal(writes.length, 0);
    }

  for (const nextRole of ["viewer", "owner", "editor", "clerk"] as const)
    for (const nextPlatform of ["android", "ios"])
      for (const nextRtl of [false, true]) {
        fixture(home, nextRole, nextRtl, nextPlatform);
        screenWidth = 320;
        const pay = {
          ...people[0],
          id: "pay",
          name: "Babar",
          phone: "+93700177777",
          balance: -200,
        };
        peopleByVault.set("kaata", [...people, pay]);
        await flush();
        assert.equal(homePages().length, 1);
        assert.equal(
          nodes(renderList(tree)).filter((node) => node.type === "TextInput").length,
          1,
          "Home has one editable search input",
        );
        assert.equal(homeInput().type, "TextInput");
        expectBottomDock();
        assert.equal(byLabel("customers.listOptions"), undefined, "Idle Home keeps filters hidden");
        assert.equal(typeof homeInput().props.onChangeText, "function");
        assert.equal(find("SearchSheet"), undefined, "Inline search never opens a modal");
        assert.equal(find("Tabs"), undefined);
        assert.equal(byLabel("personAdd.new") != null, nextRole !== "viewer");
        const layoutsBeforeFocus = scheduledKeyboardLayouts.length;
        assert.equal(homeInput().props.onPress, homeInput().props.onFocus);
        assert.equal(
          homeInput().props.onPressIn,
          undefined,
          "native iOS movement needs no separate press-in layout mutation",
        );
        homeInput().props.onPress();
        await flush();
        assert.equal(
          find("HomeBalanceSummary")!.props.searchOpen,
          nextPlatform === "android",
          "Android prepares on tap while iOS waits for the native keyboard",
        );
        assert.equal(byLabel("common.hideKeyboard") != null, nextPlatform === "android");
        homeInput().props.onFocus();
        await flush();
        assert.equal(
          find("HomeBalanceSummary")!.props.searchOpen,
          nextPlatform === "android",
          "focus preserves Android preparation without starting a second iOS layout clock",
        );
        assert.equal(byLabel("common.hideKeyboard") != null, nextPlatform === "android");
        assert.equal(
          scheduledKeyboardLayouts.length,
          layoutsBeforeFocus,
          "Focus does not invent a keyboard animation",
        );
        keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
        await flush();
        assert.equal(
          scheduledKeyboardLayouts.length,
          layoutsBeforeFocus,
          "the native motion frame owns movement without scheduling a JS layout animation",
        );
        assert.equal(
          find("HomeBalanceSummary")!.props.searchOpen,
          true,
          "Every role and platform marks the search session open while typing",
        );
        assert.ok(byLabel("common.hideKeyboard"), "Every role can dismiss the keyboard");
        assert.equal(homeOptions().props.compact, true, "Open search exposes compact filters");
        find("HomeFilterPopover")!.props.onDismiss();
        await flush();
        assert.equal(byLabel("personAdd.new"), undefined);
        homeInput().props.onBlur();
        await flush();
        assert.equal(
          find("HomeBalanceSummary")!.props.searchOpen,
          true,
          "Blur retains search state until the native hide event",
        );
        byLabel("common.hideKeyboard")!.props.onPress();
        await flush();
        assert.equal(
          find("HomeBalanceSummary")!.props.searchOpen,
          true,
          "Explicit dismissal retains search state until the native hide event",
        );
        keyboardEvent(nextPlatform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
        keyboardEvent("keyboardDidHide");
        await flush();
        assert.equal(find("HomeBalanceSummary")!.props.searchOpen, false);
        assert.equal(byLabel("common.hideKeyboard"), undefined);
        assert.equal(
          byLabel("personAdd.new") != null,
          nextRole !== "viewer",
          "Add returns only for writers after keyboard dismissal",
        );
        if (nextPlatform === "android") {
          homeInput().props.onFocus();
          await flush();
          assert.equal(find("HomeBalanceSummary")!.props.searchOpen, true);
          keyboardEvent("keyboardDidShow");
          // Android may consume hardware Back without first blurring TextInput.
          keyboardEvent("keyboardDidHide");
          await flush();
          assert.equal(find("HomeBalanceSummary")!.props.searchOpen, false);
          assert.equal(
            byLabel("common.hideKeyboard"),
            undefined,
            "Hardware Back cannot leave a stuck arrow or open search state",
          );
          homeInput().props.onFocus();
          await flush();
          assert.equal(
            find("HomeBalanceSummary")!.props.searchOpen,
            true,
            "A second keyboard cycle prepares on focus again",
          );
          byLabel("common.hideKeyboard")!.props.onPress();
          await flush();
          assert.equal(
            find("HomeBalanceSummary")!.props.searchOpen,
            false,
            "Dismissing before did-show clears the focus intent",
          );
        }
        assert.equal(
          typeof homeRows()[0].props.onLongPress === "function",
          nextRole === "owner" || nextRole === "editor",
        );
        assert.deepEqual(homeIds(), ["ahmad", "pay", "fatima"]);
        assert.equal(
          resultCounts().length,
          0,
          "The ordinary homepage has no matching-customer count",
        );
        homeRow("ahmad").props.onPress(people[0]);
        assert.deepEqual(
          routes.pop(),
          { pathname: "/person/[id]", params: { id: "ahmad" } },
          "The first tap after cold load opens immediately before changing the query",
        );
        assert.ok(homeRows().every((row) => row.props.showDirection === true));
        assert.deepEqual(overviewTotals(), { collect: 500, pay: 200 });
        const summaryIds = summaryPeople().map((person: any) => person.id);
        const scrolls = homeRenderedNodes().filter((node) => node.type === "ScrollView");
        assert.equal(scrolls.length, 1);
        assert.equal(scrolls[0].props.refreshControl, undefined, "Home has no pull-to-refresh");
        assert.equal(scrolls[0].props.bounces, true);
        assert.equal(scrolls[0].props.alwaysBounceVertical, true);
        assert.equal(scrolls[0].props.overScrollMode, "always");
        assert.equal(scrolls[0].props.keyboardShouldPersistTaps, "always");
        await changeHomeQuery("فاطمه");
        assert.deepEqual(homeIds(), ["fatima"]);
        assert.deepEqual(
          resultCounts().map((node) => node.props.children),
          ["customers.search.result"],
        );
        assert.equal(tParams.get("customers.search.result")?.count, 1);
        assert.deepEqual(
          summaryPeople().map((person: any) => person.id),
          summaryIds,
          "Filtering does not narrow the two balance cards",
        );
        await changeHomeQuery("۰۷۰۰۱۲۳۴۵۶");
        assert.deepEqual(homeIds(), ["ahmad"]);
        keyboardEvent("keyboardDidShow");
        homeInput().props.onFocus?.();
        const timersBefore = timers.size;
        const dismissalsBefore = keyboardDismissals;
        homeRow("ahmad").props.onPress(people[0]);
        assert.deepEqual(
          routes.at(-1),
          { pathname: "/person/[id]", params: { id: "ahmad" } },
          "The first row tap navigates synchronously while the keyboard is open",
        );
        assert.equal(
          timers.size,
          timersBefore,
          "Navigation has no close delay or deferred callback",
        );
        assert.equal(keyboardDismissals, dismissalsBefore + 1);
        const staleFilteredRow = homeRow("ahmad");
        await changeHomeQuery("nobody");
        assert.deepEqual(
          resultCounts().map((node) => node.props.children),
          ["customers.search.results"],
        );
        assert.equal(tParams.get("customers.search.results")?.count, 0);
        const routeCount = routes.length;
        staleFilteredRow.props.onPress(people[0]);
        await flush();
        assert.equal(routes.length, routeCount, "A filtered-out row cannot navigate later");
        assert.equal(homeIds().length, 0);
        assert.equal(homeRenderedNodes().filter((node) => node.type === "EmptyState").length, 1);
        await resetInlineSearch();
        assert.equal(homeInput().props.value, "");
        assert.equal(resultCounts().length, 0, "Reset removes the visible query count");
        await changeHomeQuery("   ");
        assert.equal(resultCounts().length, 0, "Whitespace is not a query");
        await changeHomeQuery("");
        assert.deepEqual(homeIds(), ["ahmad", "pay", "fatima"]);
        assert.equal(contactsReads, 0);
        assert.equal(permissionRequests, 0);
        assert.equal(writes.length, 0);
      }

  for (const nextPlatform of ["android", "ios"]) {
    fixture(home, "viewer", false, nextPlatform);
    await flush();
    await changeHomeQuery("RemoteMatch");
    assert.deepEqual(homeIds(), []);
    const remote = { ...people[0], id: "remote", name: "RemoteMatch", balance: -75 };
    peopleByVault.set("kaata", [...people, remote]);
    ledgerEvents.emitLedgerApplied(vaultId, "remote");
    await runTimers();
    assert.deepEqual(homeIds(), ["remote"], "Remote changes refresh the current inline query");
    changeAppState("background");
    peopleByVault.set("kaata", [
      ...people,
      remote,
      { ...remote, id: "resume", name: "RemoteMatch Resume" },
    ]);
    changeAppState("active");
    await flush();
    assert.deepEqual(homeIds(), ["remote", "resume"], "Resume refreshes without a manual pull");
    assert.equal(homeInput().props.value, "RemoteMatch");
  }

  for (const invalidation of ["vault", "account", "blur", "unmount"]) {
    fixture(home, "owner");
    await flush();
    const row = homeRow("ahmad");
    const query = homeInput().props.onChangeText;
    const focusSearch = homeInput().props.onFocus;
    const pressSearch = homeInput().props.onPress;
    const blurSearch = homeInput().props.onBlur;
    const directionChange = find("HomeBalanceSummary")!.props.onDirectionChange;
    const swipeDirectionChange = find("HomeBalanceFilterSwipe")!.props.onDirectionChange;
    const retainedKeyboardCallbacks = [...keyboardListeners].map((listener) => listener.fn);
    const preference = homeOptions().props.onChange;
    find("HomeFilterPopover")!.props.onDismiss();
    keyboardEvent(platform === "ios" ? "keyboardWillHide" : "keyboardDidHide");
    keyboardEvent("keyboardDidHide");
    await flush();
    if (invalidation === "vault") vaultId = "replacement";
    if (invalidation === "account") cachedAccountId = "replacement";
    if (invalidation === "blur") {
      homeOwnerFocused = false;
      dirty = true;
      await flush();
    }
    if (invalidation === "unmount") unmount();
    const routeCount = routes.length;
    dirty = false;
    row.props.onPress(people[0]);
    row.props.onLongPress(people[0]);
    query("stale");
    focusSearch();
    pressSearch();
    blurSearch();
    directionChange("collect", "AFN");
    swipeDirectionChange("pay");
    const layoutsBeforeStaleKeyboard = scheduledKeyboardLayouts.length;
    for (const callback of retainedKeyboardCallbacks)
      callback({
        duration: 250,
        easing: "keyboard",
        endCoordinates: { height: 300, screenY: 544 },
      });
    assert.equal(scheduledKeyboardLayouts.length, layoutsBeforeStaleKeyboard);
    preference({ sort: "name_desc", group: "all" });
    assert.equal(routes.length, routeCount, invalidation + ": retained row cannot navigate");
    assert.equal(
      dirty,
      false,
      invalidation + ": retained controls cannot update the departed page",
    );
  }
  fixture(home, "owner");
  await flush();
  const removedRow = homeRow("ahmad");
  peopleByVault.set("kaata", [people[1]]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  removedRow.props.onPress(people[0]);
  removedRow.props.onLongPress(people[0]);
  await flush();
  assert.equal(routes.length, 0);

  fixture(home, "owner");
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
    ["ahmad"],
    "Remembered inline filters apply to their current account and kaata",
  );
  assert.equal(
    homeOptions().props.preference.sort,
    "amount_asc",
    "A legacy nondefault sort remains available",
  );
  homeOptions().props.onChange({ sort: "name_desc", group: "family" });
  await flush();
  assert.deepEqual(JSON.parse(homePreferenceMeta.get("customer_home:first-account:kaata")!), {
    sort: "name_desc",
    group: "family",
  });
  const previousQuery = homeInput().props.onChangeText;
  const previousPreference = homeOptions().props.onChange;
  cachedAccountId = "second-account";
  for (const listener of [...identityListeners]) listener();
  await flush();
  previousQuery("stale");
  previousPreference({ sort: "name_desc", group: "all" });
  await flush();
  assert.equal(homeInput().props.value, "");
  assert.equal(homeOptions().props.preference.sort, "recent");
  assert.equal(
    homePreferenceMeta.has("customer_home:second-account:kaata"),
    false,
    "The second account does not inherit or write the first account's choice",
  );
  assert.deepEqual(homeIds(), ["ahmad", "fatima"]);
  vaultId = "next-kaata";
  peopleByVault.set(vaultId, [{ ...people[0], id: "next-person" }]);
  homePreferenceMeta.set(
    "customer_home:second-account:next-kaata",
    JSON.stringify({ sort: "name_asc", group: "all" }),
  );
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.deepEqual(homeIds(), ["next-person"]);
  assert.equal(
    homeOptions().props.preference.sort,
    "name_asc",
    "A different kaata loads only its own Home choice",
  );
  assert.deepEqual(JSON.parse(homePreferenceMeta.get("customer_home:first-account:kaata")!), {
    sort: "name_desc",
    group: "family",
  });

  fixture(home, "viewer");
  const low = { ...people[0], id: "low", name: "Ahmad Amini", balance: 100 };
  const high = { ...people[0], id: "high", name: "Ahmad Zia", balance: 900 };
  const other = { ...people[0], id: "other", name: "Ahmad Hamidi", balance: -700 };
  peopleByVault.set("kaata", [people[0], low, high, other]);
  groupState = {
    groups: [
      { id: "family", name: "Family", member_count: 2 },
      { id: "shop", name: "Shop", member_count: 1 },
    ],
    groupsByPerson: { ahmad: ["family"], high: ["family", "shop"], other: ["shop"] },
  };
  await flush();
  await changeHomeQuery("Ahmad");
  homeOptions().props.onChange({ sort: "amount_asc", group: ["family", "shop"] });
  await flush();
  assert.deepEqual(
    homeIds(),
    ["ahmad", "other", "high"],
    "Inline search composes multi-group OR with mixed balance sorting",
  );
  assert.equal(new Set(homeIds()).size, 3, "Contacts in multiple groups appear once");
  assert.deepEqual(overviewTotals(), { collect: 1500, pay: 700 });
  homeOptions().props.onChange({ sort: "name_desc", group: "all" });
  await flush();
  assert.deepEqual(homeIds(), ["high", "ahmad", "other", "low"]);
  await changeHomeQuery("Hamidi");
  assert.deepEqual(homeIds(), ["other"]);

  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true]) {
      fixture(home, "viewer", nextRtl, nextPlatform);
      const ranked = [
        { ...people[0], id: "fuzzy", name: "اکبر حامد", last_entry_at: 1000 },
        { ...people[0], id: "literal-collect", name: "محمد شفیق احمد آباد", last_entry_at: 10 },
        { ...people[0], id: "literal-pay", name: "احمد یوسف", balance: -50, last_entry_at: 20 },
        { ...people[1], id: "literal-zero", name: "احمدی", last_entry_at: null },
      ];
      peopleByVault.set("kaata", ranked);
      await flush();
      await changeHomeQuery("احمد");
      assert.deepEqual(
        new Set(homeIds().slice(0, 3)),
        new Set(["literal-collect", "literal-pay", "literal-zero"]),
        "Literal name matches rank ahead of recent scattered-letter matches in either script",
      );
      assert.equal(homeIds().at(-1), "fuzzy");
    }

  fixture(home, "owner");
  await flush();
  const fresh = { ...people[1], id: "new-person", name: "Zarif New", created_at: 200 };
  peopleByVault.set("kaata", [...people, fresh]);
  focusEpoch++;
  dirty = true;
  await flush();
  assert.equal(homeIds().filter((id: string) => id === "new-person").length, 1);
  await changeHomeQuery("Zarif");
  assert.deepEqual(homeIds(), ["new-person"]);
  peopleByVault.set("kaata", [...people, { ...fresh, balance: -250, last_entry_at: 300 }]);
  ledgerEvents.emitLedgerApplied(vaultId, "remote");
  await runTimers();
  assert.deepEqual(homeIds(), ["new-person"]);
  assert.equal(
    homeRow("new-person").props.person.balance,
    -250,
    "First activity updates the same row without duplication",
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

  // A single viewport lets a short keyboard-open screen scroll the entire
  // form, note toggle and Add button instead of shrinking the form between
  // a fixed action dock and a second contacts scroller. Native geometry is
  // still subject to phone checks; these assertions catch competing scroll owners.
  for (const nextPlatform of ["android", "ios"])
    for (const nextRtl of [false, true])
      for (const mode of [undefined, "add"] as const) {
        fixture(addOrFind, "owner", nextRtl, nextPlatform);
        routeParams = { mode };
        screenWidth = 320;
        screenFontScale = 1.8;
        await flush();
        const scroll = nodes(tree).find((node) => node.props.testID === "person-add-scroll")!;
        assert.ok(scroll, "the add form has one bounded scrolling viewport");
        assert.equal(scroll.type, "ScrollView");
        assert.equal(flattenStyle(scroll.props.style).flex, 1);
        assert.equal(nodes(tree).filter((node) => node.type === "ScrollView").length, 1);
        assert.equal(scroll.props.keyboardShouldPersistTaps, "handled");
        const form = nodes(scroll).find((node) => node.props.testID === "person-add-form")!;
        const actions = nodes(scroll).find((node) => node.props.testID === "person-add-actions")!;
        const contacts = nodes(scroll).find((node) => node.props.testID === "person-contact-list")!;
        const noteToggle = nodes(form).find((node) => node.props.testID === "person-note-toggle")!;
        assert.ok(form && actions && contacts && noteToggle);
        assert.equal(form.type, "View");
        for (const section of [form, actions]) {
          const style = flattenStyle(section.props.style);
          assert.equal(style.height, undefined);
          assert.equal(style.maxHeight, undefined);
          assert.notEqual(style.overflow, "hidden");
        }
        assert.ok(nodes(scroll).indexOf(form) < nodes(scroll).indexOf(actions));
        assert.ok(nodes(scroll).indexOf(actions) < nodes(scroll).indexOf(contacts));
        assert.ok(nodes(form).includes(noteToggle), "the note toggle scrolls with the name fields");
        const noteLabel = nodes(noteToggle).find((node) => node.type === "Text")!;
        assert.equal(flattenStyle(noteLabel.props.style).flex, 1);
        assert.equal(noteLabel.props.numberOfLines, undefined, "long note labels can wrap");
        const labels = [
          "personEdit.firstName.label",
          "personEdit.lastName.label",
          "personEdit.phone.label",
        ];
        const inputs = labels.map((label) => ({
          label,
          ref: byLabel(label)!.props.ref,
          path: nodePath(tree, byLabel(label)!),
        }));
        inputs[0].ref.current.focus();
        keyboardEvent(nextPlatform === "ios" ? "keyboardWillShow" : "keyboardDidShow");
        for (const [index, value] of ["Zarif", "Draft", "788111111"].entries())
          byLabel(labels[index])!.props.onChangeText(value);
        await flush();
        nodes(tree)
          .find((node) => node.props.testID === "person-note-toggle")!
          .props.onPress();
        await flush();
        const noteInput = byLabel("customerNote.label")!;
        const expandedScroll = nodes(tree).find(
          (node) => node.props.testID === "person-add-scroll",
        )!;
        assert.ok(
          nodes(expandedScroll).includes(noteInput),
          "the note editor uses the same viewport",
        );
        assert.equal(nodes(tree).filter((node) => node.type === "ScrollView").length, 1);
        assert.equal(
          nodes(tree).find((node) => node.props.testID === "person-contact-list"),
          undefined,
          "editing a note keeps the contacts shortcuts out of that draft",
        );
        assert.ok(noteInput);
        noteInput.props.onChangeText("Remember Friday\nKeep this draft");
        await flush();
        nodes(tree)
          .find((node) => node.props.testID === "person-note-toggle")!
          .props.onPress();
        await flush();
        nodes(tree)
          .find((node) => node.props.testID === "person-note-toggle")!
          .props.onPress();
        await flush();
        assert.equal(
          byLabel("customerNote.label")!.props.value,
          "Remember Friday\nKeep this draft",
        );
        for (const [index, input] of inputs.entries()) {
          const current = byLabel(input.label)!;
          assert.equal(current.props.ref, input.ref);
          assert.equal(
            nodePath(tree, current),
            input.path,
            "filtering and notes retain input hosts",
          );
          assert.equal(current.props.value, ["Zarif", "Draft", "788111111"][index]);
        }
        assert.equal(searchInputFocused, true, "expanding the note does not remount a name field");
        assert.equal(writes.length, 0, "layout changes and draft edits do not create a customer");
      }
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
      assert.ok(
        !nodes(find("ScrollView")).includes(input),
        "read-only search stays available above the scrolling results",
      );
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
      (node) =>
        typeof node.type === "function" &&
        (node.type as Function).name === "HomePage" &&
        node.props.people.length > 0,
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

  fixture(addOrFind, "owner");
  await flush();
  byLabel("personEdit.firstName.label")!.props.onChangeText("Nadia");
  nodes(tree)
    .find((node) => node.props.testID === "person-note-toggle")!
    .props.onPress();
  await flush();
  byLabel("customerNote.label")!.props.onChangeText("  Call after Friday\nAsk for her son  ");
  await flush();
  find("Button")!.props.onPress();
  await flush();
  assert.equal(writes[0][4].note, "Call after Friday\nAsk for her son");

  fixture(addOrFind, "clerk");
  await flush();
  assert.equal(
    nodes(tree).find((node) => node.props.testID === "person-note-toggle"),
    undefined,
  );
  byLabel("personEdit.firstName.label")!.props.onChangeText("Clerk's customer");
  await flush();
  find("Button")!.props.onPress();
  await flush();
  assert.equal(writes[0].length, 4, "Clerks retain customer creation without authoring notes");

  // A malformed national number must keep its known native country even if
  // the form's current default would make those digits usable elsewhere.
  deviceContacts.push({
    id: "native-country-short",
    name: "Short AF",
    firstName: "Short",
    lastName: "AF",
    phone: "1234",
    countryCode: "AF",
  } as (typeof deviceContacts)[number]);
  fixture(addOrFind, "owner");
  await flush();
  nodes(tree)
    .find((node) => node.props.testID === "person-note-toggle")!
    .props.onPress();
  await flush();
  byLabel("customerNote.label")!.props.onChangeText("Unrelated manual customer's note");
  await flush();
  assert.equal(
    nodes(tree).find((node) => node.type === "Pressable" && text(node).includes("Short AF")),
    undefined,
    "Writing a customer note dedicates the form space to that draft",
  );
  nodes(tree)
    .find((node) => node.props.testID === "person-note-toggle")!
    .props.onPress();
  await flush();
  find("CountryPicker")!.props.onSelect("AC");
  await flush();
  const shortNativeRow = nodes(tree).find(
    (node) => node.type === "Pressable" && text(node).includes("Short AF"),
  );
  assert(shortNativeRow);
  shortNativeRow.props.onPress();
  await flush();
  assert.equal(writes[0][2], "1234", "native phone text reaches validation unchanged");
  assert.equal(writes[0][3], "AF", "a native AF number is not silently reinterpreted as AC");
  assert.equal(writes[0].length, 4, "Phone-book shortcuts never inherit a different draft's note");
  deviceContacts.pop();
  unmount();
  console.log(
    "PASS: contact action-sheet entry into inline multi-select, exact selected debt/credit totals and pending shared balances, visible-result select-all, search/group retention and remote pruning, role/account/vault clearing, Done/cancel, guarded bulk removal and partial-failure retry; one mixed Home list with simultaneous independent totals, unique financial/neutral rows, direction labels, one scroll owner, filtered/scope/blur/unmount row guards; fixed keyboard-aware bottom search, compact inline groups/sort, query-only counts, unfiltered balance card inputs, direct keyboard-open navigation, native overscroll without pull-refresh, combined collect/pay results, no balance tabs/swipe rail, EN/FA and 320px access, zero-tally/phone searches, multi-group/sort composition, scoped live/resume reloads, in-place role downgrades, late-read and unmount guards, no viewer phone-book reads/prompts or writes, stable writable tally refresh and authorized creation",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
