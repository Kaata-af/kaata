// Render the real person screen with synthetic native/storage/network edges.
// This exercises its event handlers and hooks, not Yoga or an actual WhatsApp
// launch. Fixtures are local and synthetic; no account, phone or backend is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { filterTallies, noteSearchTerms } from "../tally-search";
import {
  filterTalliesByDate,
  dateRangeBetween,
  customDateRange,
  formatDateRangeLabel,
} from "../tally-date-filter";
import { summarizeTallyFlows } from "../tally-summary";
import type { Calendar } from "../calendar";
import { toJalali, toQamari } from "../jalali";
import { afterSharedSettlement, sharedHistory, visibleTally } from "../tabs/chapters";
import { sumAmounts } from "../money";
import * as money from "../money";
import { tallyScrollTarget } from "../tally-viewport";
import { compareTallyReviews } from "../tally-review-feedback";
import { entryTypeFor } from "../tabs/direction";
import { compileUI } from "./ui-fixture";

const { summarizeSelectionEntries } = compileUI("../selection-summary", {
  "./currency-totals": require("../currency-totals"),
  "./money": money,
  "./db-tx": { getDb: () => assert.fail("Tally selection totals are already loaded") },
}) as typeof import("../selection-summary");
const multiCurrencyView = compileUI("../multi-currency-view", {
  "./money": money,
  "./selection-summary": { summarizeSelectionEntries },
});
const translations = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");

type Node = { type: string; props: Record<string, any> };
type Effect = { deps?: unknown[]; cleanup?: () => void };
let slots: any[] = [],
  cursor = 0,
  dirty = false,
  tree: any;
let pendingEffects: (() => void)[] = [];
const same = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
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
  useMemo(factory: () => any, deps: unknown[]) {
    const i = cursor++;
    if (!(i in slots) || !same(slots[i].deps, deps)) slots[i] = { deps, value: factory() };
    return slots[i].value;
  },
  useCallback(fn: (...args: any[]) => any, deps: unknown[]) {
    return react.useMemo(() => fn, deps);
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const i = cursor++;
    const before: Effect | undefined = slots[i];
    if (before && same(before.deps, deps)) return;
    slots[i] = { deps };
    pendingEffects.push(() => {
      before?.cleanup?.();
      slots[i].cleanup = fn();
    });
  },
};
const jsx = (type: string, props: any): Node => ({ type, props });
const nodes = (n: any): Node[] =>
  Array.isArray(n)
    ? n.flatMap(nodes)
    : n?.props
      ? [n, ...nodes(n.type === "SearchControlSlot" && !n.props.visible ? null : n.props.children)]
      : [];
const kids = (n: any): Node[] => [n?.props?.children].flat(Infinity).filter((v) => v?.props);
const words = (n: any): string =>
  Array.isArray(n)
    ? n.map(words).join("")
    : typeof n === "string"
      ? n
      : n?.props
        ? words(n.props.children)
        : "";
const find = (type: string) => nodes(tree).find((n) => n.type === type);
const tallies = () => nodes(tree).filter((n) => n.type === "EntryRow");
const rowIds = () => tallies().map((n) => n.props.entry.id);
const query = (value: string) => find("TextInput")!.props.onChangeText(value);
const dateControl = () => find("TallyDateFilterSheet")!;
const searchFooter = () => find("SearchKeyboardFooter")!;
const pingButton = () => nodes(tree).find((n) => n.props.testID === "whatsapp-reminder")!;

const flattenStyle = (value: any): any =>
  Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flattenStyle)) : value;
function contrastOverWhite(foreground: string, background: string, opacity = 1): number {
  const luminance = (hex: string) => {
    assert.match(hex, /^#[\da-f]{6}$/i, "action colors are opaque RGB values");
    return [1, 3, 5]
      .map((at) => (parseInt(hex.slice(at, at + 2), 16) / 255) * opacity + 1 - opacity)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

let params: Record<string, string> = { id: "person" };
let selectedCurrency = "AFN";
let justSaved: string | null = null;
let platform = "android",
  rtl = false,
  appState = "active";
let calendar: Calendar = "gregorian";
let canCreate = true,
  canAmend = true;
const deletedEntries: string[] = [];
const deletionScopes: unknown[] = [];
let deleteEntryImpl: (id: string) => Promise<void> = async () => {};
const backListeners = new Set<() => boolean>();
let ledgerRefresh = async () => {};
let person: any, entries: any[], preLink: any[], failed: any[], link: any;
const currencyPeriods = new Map<
  string,
  { settlement?: any; boundaries?: number[]; tab?: any; markers?: any[]; preLink?: any[] }
>();
const personReads: any[][] = [],
  entryReads: any[][] = [],
  settledWrites: any[] = [];
let priorPeriods: any[] = [],
  historyReadGate: Promise<any[]> | null = null;
let accountId = "account",
  vaultId = "vault";
let balanceLabelLocale: "en" | "fa" | "ps" | null = null;
const tabLinksById = new Map<string, any>();
let tabLinkReadGate: Promise<any> | null = null;
const sharedActions: Array<{ name: string; link: any; entryId: string }> = [];
const identityListeners = new Set<() => void>();
let reminderRows: any[] = [],
  reminderReadGate: Promise<any[]> | null = null;
let intentSequence = 0;
const intents = compileUI("../reminder-ping-intent", {
  "expo-crypto": { randomUUID: () => `trusted-reminder-${++intentSequence}` },
});
const reminderOwner = () => `account:${accountId}`;
let settlement: any, markers: any[], boundaries: number[];
let preference = "en",
  preferenceReads = 0;
const shares: any[] = [],
  seen: any[] = [],
  exports: any[] = [],
  routes: any[] = [],
  toasts: any[] = [];
const tabListeners = new Set<(event: any) => void>();
const appListeners = new Set<(state: string) => void>();
// Tabs the screen keeps on the sync loop's 5 s backstop (watchTab refcounts).
const watched = new Map<string, number>();
const focusEffects = new Set<{
  start: () => void | (() => void);
  cleanup?: () => void;
  active: boolean;
}>();
function blur() {
  for (const effect of focusEffects) {
    effect.cleanup?.();
    effect.cleanup = undefined;
    effect.active = false;
  }
}
function refocus() {
  for (const effect of focusEffects)
    if (!effect.active) {
      effect.cleanup = effect.start() || undefined;
      effect.active = true;
    }
}
let timerId = 0,
  now = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
const frames = new Map<number, () => void>();
const timeout = (fn: () => void, ms: number) => {
  const id = ++timerId;
  timers.set(id, { at: now + ms, fn });
  return id;
};
const frame = (fn: () => void) => {
  const id = ++timerId;
  frames.set(id, fn);
  return id;
};
function runFrames() {
  for (const [id, work] of [...frames]) {
    frames.delete(id);
    work();
  }
}
function advance(ms: number) {
  now += ms;
  for (const [id, timer] of timers)
    if (timer.at <= now) {
      timers.delete(id);
      timer.fn();
    }
}
const toastOffset = { addListener: () => "toast", removeListener() {} };
const TOAST_LIFT = 78; // iOS worst case: a two-line toast
let reducedMotion = false;
const scheduledKeyboardLayouts: unknown[] = [];
const keyboardListeners = new Set<{ event: string; fn: (payload: any) => void }>();
let keyboardDismissals = 0;
const keyboardEvent = (event: string) => {
  const payload = {
    duration: 250,
    easing: "keyboard",
    endCoordinates: { height: 300, screenY: 544 },
  };
  for (const listener of [...keyboardListeners]) if (listener.event === event) listener.fn(payload);
};
const dummyError = class extends Error {};
const native: any = {
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  ActivityIndicator: "Spinner",
  KeyboardAvoidingView: "Keyboard",
  BackHandler: {
    addEventListener: (_: string, fn: () => boolean) => {
      backListeners.add(fn);
      return { remove: () => backListeners.delete(fn) };
    },
  },
  Keyboard: {
    dismiss() {
      keyboardDismissals++;
    },
    scheduleLayoutAnimation: (event: unknown) => scheduledKeyboardLayouts.push(event),
    addListener(event: string, fn: (payload: any) => void) {
      const listener = { event, fn };
      keyboardListeners.add(listener);
      return { remove: () => keyboardListeners.delete(listener) };
    },
  },
  Animated: { View: "AnimatedView" },
  Platform: {
    get OS() {
      return platform;
    },
    select: (values: any) => values[platform],
  },
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
  AppState: {
    get currentState() {
      return appState;
    },
    addEventListener: (_: string, fn: (state: string) => void) => {
      appListeners.add(fn);
      return { remove: () => appListeners.delete(fn) };
    },
  },
};
const components = Object.fromEntries(
  [
    "BottomSheet",
    "TallyDateFilterSheet",
    "SearchControlSlot",
    "Chip",
    "ConfirmDialog",
    "EmptyState",
    "TallyHighlight",
    "TallyFlowSummary",
    "CustomerBalanceCarousel",
    "CreditIntentList",
    "CreditStatusBadge",
    "EntryRow",
    "SelectionToolbar",
    "SharedAccountBadge",
    "LinkAccountDialog",
    "OverflowMenu",
    "OptionSheet",
  ].map((name) => [`../../components/${name}`, { [name]: name }]),
);
const mocks: Record<string, any> = {
  ...components,
  "../../components/SearchKeyboardMotion": {
    SearchKeyboardFrame: "SearchKeyboardFrame",
    SearchKeyboardFooter: "SearchKeyboardFooter",
  },
  "../../components/SheetBackdrop": { useSheetMotionPreference: () => reducedMotion },
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react,
  "react-native": native,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-crypto": { randomUUID: () => "uuid" },
  "expo-router": {
    useLocalSearchParams: () => params,
    useRouter: () => ({
      push: (route: any) => routes.push(route),
      back: () => routes.push("back"),
    }),
    useFocusEffect: (fn: () => void | (() => void)) =>
      react.useEffect(() => {
        const effect = { start: fn, cleanup: fn() || undefined, active: true };
        focusEffects.add(effect);
        return () => {
          effect.cleanup?.();
          focusEffects.delete(effect);
        };
      }, [fn]),
  },
  "react-native-safe-area-context": {
    SafeAreaView: "Safe",
    useSafeAreaInsets: () => ({ bottom: 0 }),
  },
  "../../components/Toast": {
    useToast: () => ({ push: (...args: any[]) => toasts.push(args) }),
    useToastOffset: () => toastOffset,
    TOAST_LIFT,
  },
  "../../lib/attribution": { loadRelationshipAttribution: async () => new Map() },
  "../../lib/colors": require("../colors"),
  "../../components/CurrencySelector": { CurrencySelector: "CurrencySelector" },
  "../../lib/currency": {
    getCurrentCurrencySymbol: () => "AFN",
    getCurrentCurrencyCode: () => selectedCurrency,
    getCurrencyLabel: (code: string) => code,
    getCurrencySymbol: (code: string) => code,
    useCurrency: () => selectedCurrency,
    setCurrentCurrency: (code: string) => {
      selectedCurrency = code;
    },
  },
  "../../lib/db": {
    getPerson: async (...args: any[]) => {
      personReads.push(args);
      return person;
    },
    listEntries: async (...args: any[]) => {
      entryReads.push(args);
      return [...entries];
    },
    listArchivedSharedPeriodsForExport: async () => historyReadGate ?? priorPeriods,
    getLocalSelf: async () => ({ name: "Synthetic owner", shop_name: "Synthetic shop" }),
    getSettlementSummary: async (_: string, code: string) =>
      currencyPeriods.get(code)?.settlement ?? settlement,
    listSettlementBoundaries: async (_: string, code: string) =>
      currencyPeriods.get(code)?.boundaries ?? boundaries,
    setAppMeta: async () => {},
    softDeleteEntry: async (id: string, scope?: unknown) => {
      deletedEntries.push(id);
      deletionScopes.push(scope);
      await deleteEntryImpl(id);
      entries = entries.filter((entry) => entry.id !== id);
    },
    SettledChapterError: dummyError,
  },
  "../../lib/db-tx": {
    getAccountIdSync: () => accountId,
    getActiveVaultIdSyncMaybe: () => vaultId,
    onAccountIdentityChanged: (fn: () => void) => {
      identityListeners.add(fn);
      return () => identityListeners.delete(fn);
    },
  },
  "../../lib/effective-account": { resolveAccountIdCandidates: async () => ["account"] },
  "../../lib/event-log": {
    appendEntrySettled: async (args: any) => {
      settledWrites.push(args);
    },
    RoleGateRejectionError: dummyError,
    SettleNotZeroError: dummyError,
  },
  "../../lib/export": {
    exportPersonStatement: async (...args: any[]) => {
      exports.push(args);
      return null;
    },
    savedMessage: () => null,
  },
  "../../lib/export/shared-record": require("../export/shared-record"),
  "../../lib/ledger-events": {
    useLedgerRefresh(_: string, load: () => Promise<void>) {
      ledgerRefresh = load;
    },
  },
  "../../lib/direction": {
    bidiIsolate: (value: string) => value,
    ltrIsolate: (value: string) => value,
    rowDir: (r: boolean) => ({ flexDirection: r ? "row-reverse" : "row" }),
    textDir: (r: boolean) => ({ textAlign: r ? "right" : "left" }),
    trackingSafe: () => ({}),
    useIsRTL: () => rtl,
  },
  "../../lib/fonts": { fonts: {}, sansLineHeight: (_: number, h: number) => h },
  "../../lib/format": {
    formatAmount: (amount: number) => `amount:${Math.abs(amount)}`,
    formatDate: () => "fixture date",
  },
  "../../lib/money": { sumAmounts },
  "../../lib/i18n": {
    getLocale: () => balanceLabelLocale ?? (rtl ? "fa" : "en"),
    getShareLangPref: async () => {
      preferenceReads++;
      return preference;
    },
    resolveShareLang: (value: string) => value,
    t: (key: string, values?: Record<string, any>) =>
      balanceLabelLocale && (key === "tab.balance.confirmed" || key === "tab.balance.pending")
        ? translations.tIn(balanceLabelLocale, key, values)
        : key + (values?.count == null ? "" : `:${values.count}`),
  },
  "../../lib/jalali": { formatSettlementDate: () => "fixture date" },
  "../../lib/calendar": { useCalendar: () => calendar },
  "../../lib/share": {
    shareKaataCurrenciesViaWhatsApp: (...args: any[]) => {
      const call: any = { args };
      shares.push(call);
      args[4]?.("preparing");
      return new Promise<boolean>((resolve) => {
        call.resolve = resolve;
      });
    },
  },
  "../../lib/tally-search": { filterTallies, noteSearchTerms },
  "../../lib/tally-date-filter": { filterTalliesByDate, formatDateRangeLabel },
  "../../lib/tally-summary": { summarizeTallyFlows },
  "../../lib/selection-summary": { summarizeSelectionEntries },
  "../../lib/multi-currency-view": multiCurrencyView,
  "../../lib/recent-entry": {
    takeSavedEntry: () => {
      const taken = justSaved;
      justSaved = null;
      return taken;
    },
  },
  "../../lib/use-customer-groups": {
    useCustomerGroups: () => ({
      groups: [{ id: "family", name: "Family", member_count: 1 }],
      groupsByPerson: { [params.id]: ["family"] },
      loaded: true,
      failed: false,
    }),
  },
  "../../lib/tabs/db": {
    getTabLink: async (id: string) => {
      if (tabLinkReadGate) return tabLinkReadGate;
      const target = tabLinksById.get(id) ?? (link?.tab_id === id ? link : null);
      return target ? { ...target } : null;
    },
    getLatestTabLinkForPerson: async (_: string, code: string) =>
      currencyPeriods.has(code)
        ? (currencyPeriods.get(code)!.tab ?? null)
        : link && (link.currency ?? "AFN") === code
          ? { ...link }
          : null,
    listPreLinkEntries: async (tab: any) => [
      ...(currencyPeriods.get(tab.currency)?.preLink ?? preLink),
    ],
    listFailedTabEntries: async () => [...failed],
    listTabSettlements: async (tabId: string) => [
      ...([...currencyPeriods.values()].find((period) => period.tab?.tab_id === tabId)?.markers ??
        markers),
    ],
  },
  "../../lib/tabs/inbox-reads": {
    markTabNoticesSeen: (value: any, context: any) => seen.push({ rev: value.rev, ...context }),
  },
  "../../lib/tabs/link": {
    ...Object.fromEntries(
      [
        "acceptEntry",
        "disputeEntry",
        "regenerateInviteLink",
        "unlinkContact",
        "voidEntry",
        "settleSharedTab",
      ].map((name) => [
        name,
        async (target: any, entryId: string) => {
          sharedActions.push({ name, link: { ...target }, entryId });
        },
      ]),
    ),
    TabAuthUnavailableError: dummyError,
    TabClosedError: dummyError,
    TabPermissionError: dummyError,
  },
  "../../lib/tabs/sync": {
    requestTabSync() {},
    watchTab(tabId: string) {
      watched.set(tabId, (watched.get(tabId) ?? 0) + 1);
      return () => watched.set(tabId, (watched.get(tabId) ?? 1) - 1);
    },
    onTabApplied: (fn: (event: any) => void) => {
      tabListeners.add(fn);
      return () => tabListeners.delete(fn);
    },
  },
  "../../lib/tabs/errors": {
    TabApiError: dummyError,
    TabInputError: dummyError,
    TabReviewFinalError: dummyError,
  },
  "../../lib/projection": { applyEventMutex: { runExclusive: (fn: () => any) => fn() } },
  "../../lib/tabs/chapters": { afterSharedSettlement, sharedHistory, visibleTally },
  "../../lib/tokens": {
    icon: {},
    radius: {},
    TOUCH_MIN: 44,
    typography: { heading: { fontSize: 20 } },
  },
  "../../lib/use-vault-role": {
    useVaultPermission: () => true,
    useActiveVaultWriteCaps: () => ({
      canCreate,
      canAmend,
      canConfigureCredit: true,
      resolved: true,
    }),
  },
  "../../lib/use-vault-summary": { useMembersCount: () => 1 },
  "../../lib/tally-viewport": { tallyScrollTarget },
  "../../lib/tally-review-feedback": { compareTallyReviews },
  "../../lib/customer-reminders": { reminderOwnerScope: reminderOwner },
};
// Execute the real automatic handoff hook inside the actual person screen.
mocks["../../lib/use-search-focus-effect"] = {
  useSearchFocusEffect: mocks["expo-router"].useFocusEffect,
};
mocks["../../lib/native-search"] = { afterNativeSearchClosed: () => false };
mocks["../../lib/use-reminder-ping"] = compileUI("../use-reminder-ping", {
  react,
  "react-native": native,
  "expo-router": mocks["expo-router"],
  "./db-tx": mocks["../../lib/db-tx"],
  "./customer-reminders": {
    reminderOwnerScope: reminderOwner,
    reminderTimezone: () => "Asia/Kabul",
    listCustomerReminders: async () => reminderReadGate ?? reminderRows,
  },
  "./reminder-ping-intent": intents,
});
const out: any = {};
new Function(
  "require",
  "exports",
  "setTimeout",
  "clearTimeout",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "__DEV__",
  ts.transpileModule(readFileSync(require.resolve("../../app/person/[id]"), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
)(
  (name: string) => {
    assert.ok(name in mocks, name);
    return mocks[name];
  },
  out,
  timeout,
  (id: number) => timers.delete(id),
  frame,
  (id: number) => frames.delete(id),
  false,
);
function render() {
  cursor = 0;
  dirty = false;
  tree = out.default();
}
async function flush() {
  // Loads use real async ordering (mutex/Promise.all/focus continuation).
  // Re-render changed state and apply effects until those microtasks settle.
  for (let i = 0; i < 15; i++) {
    if (dirty || !tree) render();
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach((effect) => effect());
    await Promise.resolve();
  }
  if (dirty) render();
}
function unmount() {
  for (const slot of slots) if (slot?.cleanup) slot.cleanup();
  tree = null;
  slots = [];
  cursor = 0;
  pendingEffects = [];
  frames.clear();
}
const tally = (
  id: string,
  note: string,
  amount: number,
  date: number,
  tab?: any,
  type = "debt",
) => ({
  id,
  relationship_id: "relationship",
  type,
  amount_afn: amount,
  created_at: date,
  note,
  tab,
});
function fixture(shared = false) {
  currencyPeriods.clear();
  personReads.length = 0;
  entryReads.length = 0;
  settledWrites.length = 0;
  selectedCurrency = "AFN";
  unmount();
  reminderRows = [];
  reminderReadGate = null;
  reducedMotion = false;
  scheduledKeyboardLayouts.length = 0;
  params = { id: "person" };
  appState = "active";
  preference = "en";
  calendar = "gregorian";
  canCreate = true;
  canAmend = true;
  deletedEntries.length = 0;
  deletionScopes.length = 0;
  deleteEntryImpl = async () => {};
  preferenceReads = 0;
  shares.length = 0;
  seen.length = 0;
  exports.length = 0;
  routes.length = 0;
  toasts.length = 0;
  now = 0;
  timers.clear();
  tabListeners.clear();
  appListeners.clear();
  person = {
    id: "person",
    name: "Synthetic person",
    phone: "+93700000001",
    balance: shared ? 5 : 3,
  };
  settlement = { count: 1, lastSettledAtMs: 200 };
  boundaries = [200];
  preLink = [];
  priorPeriods = [];
  historyReadGate = null;
  accountId = "account";
  vaultId = "vault";
  balanceLabelLocale = null;
  tabLinksById.clear();
  tabLinkReadGate = null;
  sharedActions.length = 0;
  failed = [];
  markers = [];
  link = null;
  entries = [
    tally("new-rice", "rice bought", 2, 400, undefined, "payment"),
    tally("new-tea", "tea", 5, 300),
    tally("old-cash", "cash returned", 10, 150, undefined, "payment"),
    tally("old-rice", "rice old", 10, 100),
  ];
  if (shared) {
    const meta = (seq: number, status = "accepted", voided = false) => ({
      seq,
      status,
      kind: "tally",
      by: "them",
      voided,
    });
    link = {
      currency: "AFN",
      tab_id: "tab",
      relationship_id: "relationship",
      vault_id: "vault",
      closed_at: null,
      other_joined_at: 1,
      rev: 5,
    };
    entries = [
      tally("rejected-rice", "rice wrong", 99, 500, meta(5, "disputed")),
      tally("voided-rice", "rice cancelled", 99, 400, meta(4, "pending", true)),
      tally("new-tea", "tea", 5, 300, meta(3, "pending")),
      tally("old-cash", "cash returned", 10, 150, meta(2), "payment"),
      tally("old-rice", "rice old", 10, 100, meta(1)),
    ];
    preLink = [
      tally("pre-rice", "rice before link", 500, 50),
      tally("pre-tea", "tea before link", 1, 60),
    ];
    failed = [tally("failed-rice", "rice refused", 7, 600)];
    markers = [
      { id: "settlement", through_seq: 2, settled_at_ms: 200, actor_name: "Synthetic owner" },
    ];
  }
  dirty = true;
}

async function notificationReminderFlowTests() {
  const reminderId = "12345678-1234-1234-1234-123456789abc";
  const action = (notificationKey: string) => {
    const row = { id: reminderId, updated_at: 1, schedule_json: "{}" };
    reminderRows = [row];
    const key = intents.queueReminderPing({
      reminderId,
      personId: "person",
      vaultId,
      ownerScope: reminderOwner(),
      notificationKey,
      fingerprint: `${row.updated_at}:${row.schedule_json}:Asia/Kabul`,
    });
    params = { id: "person", reminderId, reminderActionKey: key };
    return key;
  };
  for (const os of ["ios", "android"])
    for (const locale of [false, true]) {
      accountId = "account";
      vaultId = "vault";
      fixture();
      platform = os;
      rtl = locale;
      action(`native:${os}:${locale}`);
      assert.equal(shares.length, 0, "notification can't share before the ledger loads");
      await flush();
      await flush();
      assert.equal(
        shares.length,
        1,
        "native reminder intent automatically starts the real WhatsApp flow",
      );
      assert.deepEqual(
        shares[0].args[2].flatMap((section: any) => section.entries.map((e: any) => e.id)),
        entries.map((e) => e.id),
      );
      assert.ok(nodes(pingButton()).some((n) => n.type === "Spinner"));
      shares[0].resolve(true);
      await flush();
      blur();
      refocus();
      await flush();
      assert.equal(shares.length, 1, "returning to the customer doesn't prepare another draft");
    }
  fixture();
  params = { id: "person", reminderId, reminderActionKey: "made-up-url-flag" };
  await flush();
  await flush();
  assert.equal(shares.length, 0, "an arbitrary deep link can't automatically upload a statement");
  fixture();
  params = { id: "person", reminderId };
  await flush();
  await flush();
  assert.equal(shares.length, 0, "in-app reminder View keeps its normal manual flow");

  fixture();
  preference = "ask";
  action("native:ask");
  await flush();
  await flush();
  assert.equal(shares.length, 0);
  assert.equal(find("OptionSheet")?.props.visible, true, "Ask language opens automatically");
  find("OptionSheet")!.props.onSelect("fa");
  advance(220);
  await flush();
  assert.equal(shares.length, 1);
  assert.equal(shares[0].args[3], "fa");
  shares[0].resolve(true);
  await flush();

  fixture();
  appState = "background";
  action("native:foreground");
  await flush();
  await flush();
  assert.equal(shares.length, 0);
  appState = "active";
  appListeners.forEach((fn) => fn(appState));
  await flush();
  await flush();
  assert.equal(shares.length, 1, "cold launch waits for foreground");
  appState = "background";
  appListeners.forEach((fn) => fn(appState));
  assert.equal(shares[0].args[5].aborted, true, "leaving during automatic preparation aborts it");
  shares[0].resolve(false);
  await flush();
  appState = "active";
  appListeners.forEach((fn) => fn(appState));
  await flush();
  assert.equal(shares.length, 1, "aborted work doesn't replay on resume");

  fixture();
  action("native:changed-reminder");
  reminderRows[0].updated_at = 2;
  await flush();
  await flush();
  assert.equal(shares.length, 0, "edited/marked-done reminders don't auto-run stale notices");
  fixture();
  action("native:deleted-reminder");
  reminderRows = [];
  await flush();
  await flush();
  assert.equal(shares.length, 0);
  fixture();
  action("native:no-tallies");
  entries = [];
  await flush();
  await flush();
  assert.equal(shares.length, 0, "an empty ledger doesn't prepare a bogus statement");

  fixture();
  action("native:account-aba");
  let release!: (rows: any[]) => void;
  reminderReadGate = new Promise((resolve) => {
    release = resolve;
  });
  await flush();
  accountId = "other";
  identityListeners.forEach((fn) => fn());
  accountId = "account";
  identityListeners.forEach((fn) => fn());
  reminderReadGate = null;
  release(reminderRows);
  await flush();
  await flush();
  assert.equal(shares.length, 0, "account ABA invalidates an in-flight handoff");

  fixture();
  const key = action("native:leave-before-ready");
  await flush(); // if preparation starts, the normal blur abort still protects it
  blur();
  await flush();
  refocus();
  await flush();
  assert.equal(
    intents.hasReminderPing(key, {
      reminderId,
      personId: "person",
      vaultId,
      ownerScope: reminderOwner(),
    }),
    false,
  );
  assert.ok(shares.length <= 1, "leaving/revisiting can never prepare twice");
  unmount();
  assert.equal(identityListeners.size, 0, "all handoff identity listeners are removed");
  console.log(
    "PASS: real notification handoff auto-prepares once, respects Ask language, loading/foreground, deep-link isolation, reminder versions and account ABA",
  );
}

async function tallySelectionTests() {
  const start = () => {
    find("OverflowMenu")!
      .props.actions.find((action: any) => action.label === "selection.start")
      .onPress();
  };
  const toolbar = () => find("SelectionToolbar")!;
  const chooseAll = async () => {
    toolbar().props.onToggleAll();
    await flush();
  };
  const askDelete = async () => {
    toolbar().props.actions[0].onPress();
    await flush();
  };
  const nativeDialog = () =>
    nodes(tree).find(
      (node) =>
        node.type === "ConfirmDialog" &&
        node.props.visible &&
        node.props.title.startsWith("selection.deleteTalliesTitle"),
    )!;
  const dialog = () => {
    const confirmation = nativeDialog().props;
    assert.equal(confirmation.visible, true);
    assert.equal(confirmation.destructive, true);
    assert.ok(confirmation.title.startsWith("selection.deleteTalliesTitle"));
    assert.ok(confirmation.description.startsWith("selection.deleteTalliesDescription"));
    assert.ok(toolbar(), "The inline summary remains mounted behind confirmation");
    return { props: confirmation };
  };
  for (const direction of [false, true]) {
    rtl = direction;
    fixture();
    await flush();
    start();
    await flush();
    assert.equal(toolbar().props.count, 0);
    assert.equal(toolbar().props.total, 2, "select all includes only current, private tallies");
    assert.equal(find("SearchSheet"), undefined, "Tally search and selection remain on the page");
    assert.equal(
      nodes(tree).some((node) => node.type === "SelectionToolbar"),
      true,
    );
    assert.ok(
      nodes(tree)
        .filter((node) => node.type === "EntryRow")
        .every((node) => node.props.selecting),
    );
    assert.equal(
      nodes(tree).some((node) => node.props.testID === "select-tallies"),
      false,
    );
    assert.equal(words(tree).includes("selection.tallies"), false);
    const selectionTop = nodes(tree).find(
      (node) => node.props.testID === "customer-selection-controls",
    )!;
    assert.ok(selectionTop, "selection controls remain fixed over the scrolling list");
    const screenChildren = kids(find("Safe"));
    assert.ok(
      nodes(screenChildren[0]).some((node) => node.props.accessibilityLabel === "common.back"),
    );
    assert.equal(
      screenChildren[1].type,
      "SearchKeyboardFrame",
      "selection does not move the keyboard-aware viewport below the header",
    );
    const frameContent = kids(find("SearchKeyboardFrame"))[0];
    assert.deepEqual(
      kids(frameContent).slice(0, 2),
      [selectionTop, find("ScrollView")],
      "selection controls precede their scrolling sibling for accessibility",
    );
    assert.ok(kids(selectionTop).includes(toolbar()));
    const overlayStyle = flattenStyle(selectionTop.props.style);
    assert.equal(overlayStyle.position, "absolute");
    assert.equal(overlayStyle.top, 0);
    assert.equal(selectionTop.props.pointerEvents, "box-none");
    assert.ok(overlayStyle.zIndex > 0);
    assert.equal(overlayStyle.elevation, undefined, "the toolbar owns its existing shadow");
    assert.equal(overlayStyle.overflow, "visible", "the card's shadow is not clipped");
    assert.equal(overlayStyle.backgroundColor, undefined, "rounded margins reveal the list below");
    assert.equal(nodes(tree).filter((node) => node.type === "SelectionToolbar").length, 1);
    assert.equal(
      nodes(find("SearchKeyboardFrame")).includes(toolbar()),
      true,
      "the overlay shares the list's stable keyboard-aware frame",
    );
    assert.equal(
      nodes(find("ScrollView")).includes(toolbar()),
      false,
      "selection controls do not scroll away",
    );
    assert.ok(find("TextInput"), "Search remains available while selecting tallies");
    assert.ok(nodes(searchFooter()).includes(find("TextInput")!));
    assert.equal(
      nodes(searchFooter()).includes(toolbar()),
      false,
      "bottom search has no duplicate selection toolbar",
    );
    const bottomInset = flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingBottom;
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop,
      12,
      "the initial gap belongs to scroll content, outside the floating panel",
    );
    const retainedSelectionLayout = selectionTop.props.onLayout;
    retainedSelectionLayout({ nativeEvent: { layout: { height: 220 } } });
    await flush();
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop,
      232,
      "the first tally starts below the measured controls plus breathing room",
    );
    find("ScrollView")!.props.onScroll({ nativeEvent: { contentOffset: { y: 300 } } });
    retainedSelectionLayout({ nativeEvent: { layout: { height: 220 } } });
    await flush();
    assert.equal(flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop, 232);
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingBottom,
      bottomInset,
      "selection spacing leaves the search dock's bottom reservation unchanged",
    );
    const balances = nodes(tree).find((node) => node.props.testID === "customer-balances")!;
    assert.equal(
      flattenStyle(balances.props.style).display,
      "none",
      "selection removes the whole balance section from layout",
    );
    assert.equal(balances.props.pointerEvents, "none");
    assert.equal(balances.props.accessibilityElementsHidden, true);
    assert.equal(balances.props.importantForAccessibility, "no-hide-descendants");
    assert.ok(
      nodes(balances).includes(find("CustomerBalanceCarousel")!),
      "the retained carousel preserves the visit's page and manual-stop state",
    );
    assert.equal(
      find("CustomerBalanceCarousel")!.props.active,
      false,
      "hidden balance cards cannot advance automatically",
    );
    assert.ok(
      nodes(balances).some((node) => flattenStyle(node.props.style)?.height === 16),
      "the hidden section includes its leading spacer",
    );
    assert.equal(toolbar().props.actions[0].disabled, true);
    const first = tallies().find((row) => row.props.entry.id === "new-rice")!;
    first.props.onToggleSelection(first.props.entry);
    await flush();
    assert.equal(toolbar().props.count, 1);
    assert.equal(tallies()[0].props.selected, true);
    assert.deepEqual(toolbar().props.financialSummary, {
      debtCount: 0,
      creditCount: 1,
      debt: 0,
      credit: 2,
      collect: 0,
      pay: 2,
      net: -2,
      pending: false,
    });
    await chooseAll();
    assert.equal(toolbar().props.count, 2);
    assert.deepEqual(
      toolbar().props.financialSummary,
      {
        debtCount: 1,
        creditCount: 1,
        debt: 5,
        credit: 2,
        collect: 3,
        pay: 0,
        net: 3,
        pending: false,
      },
      "Selected tally totals pair each direction's transaction count and amount, with a separate remaining balance",
    );
    await chooseAll();
    assert.equal(toolbar().props.count, 0);
    assert.ok(
      [...backListeners].some((back) => back()),
      "Android back clears selection before leaving the contact",
    );
    await flush();
    assert.equal(toolbar(), undefined);
    assert.equal(
      nodes(tree).find((node) => node.props.testID === "customer-selection-controls"),
      undefined,
    );
    assert.equal(flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop, 0);
    retainedSelectionLayout({ nativeEvent: { layout: { height: 480 } } });
    await flush();
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop,
      0,
      "a late closed-panel measurement cannot retain blank space",
    );
    assert.equal(find("CustomerBalanceCarousel")!.props.active, true);
    const restoredBalances = nodes(tree).find((node) => node.props.testID === "customer-balances")!;
    assert.equal(flattenStyle(restoredBalances.props.style)?.display, undefined);
    assert.equal(restoredBalances.props.pointerEvents, "auto");
    assert.equal(restoredBalances.props.accessibilityElementsHidden, false);
    tallies()[0].props.onLongPress(tallies()[0].props.entry);
    await flush();
    const sheet = nodes(tree).find((node) => node.type === "BottomSheet" && node.props.visible)!;
    sheet.props.actions.find((action: any) => action.label === "selection.start").onPress();
    await flush();
    assert.equal(toolbar().props.count, 1, "selecting from a tally's options seeds that tally");
    retainedSelectionLayout({ nativeEvent: { layout: { height: 480 } } });
    await flush();
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop,
      232,
      "a reopened selection rejects the previous panel's late layout event",
    );
    nodes(tree)
      .find((node) => node.props.testID === "customer-selection-controls")!
      .props.onLayout({ nativeEvent: { layout: { height: 260 } } });
    await flush();
    assert.equal(
      flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingTop,
      272,
      "current controls can grow for wrapping content without obscuring the first row",
    );
    const selectedSummary = toolbar().props.financialSummary;
    const keyboardBeforeDelete = keyboardDismissals;
    await askDelete();
    assert.equal(keyboardDismissals, keyboardBeforeDelete + 1);
    const cancelled = dialog().props;
    cancelled.onCancel();
    cancelled.onConfirm();
    await flush();
    assert.equal(nativeDialog(), undefined);
    assert.equal(toolbar().props.count, 1, "Cancel preserves the selected tally");
    assert.deepEqual(toolbar().props.financialSummary, selectedSummary, "Cancel preserves totals");
    assert.deepEqual(deletedEntries, [], "cancel is non-destructive");
    await chooseAll();
    await askDelete();
    const visibleConfirmation = dialog().props;
    assert.equal(visibleConfirmation.title, "selection.deleteTalliesTitle:2");
    const confirm = visibleConfirmation.onConfirm;
    confirm();
    confirm();
    await flush();
    assert.deepEqual(
      deletedEntries,
      ["new-rice", "new-tea"],
      "double confirmation writes each selected tally once",
    );
    assert.deepEqual(
      deletionScopes,
      [
        { vaultId: "vault", accountId: "account" },
        { vaultId: "vault", accountId: "account" },
      ],
      "each write carries the selection's captured account and vault",
    );
    assert.equal(toolbar(), undefined);
    const closingConfirmation = nodes(tree).find(
      (node) =>
        node.type === "ConfirmDialog" &&
        node.props.title.startsWith("selection.deleteTalliesTitle"),
    )!;
    assert.equal(closingConfirmation.props.visible, false);
    assert.equal(
      closingConfirmation.props.title,
      visibleConfirmation.title,
      "Fast deletion retains the last visible count throughout the dialog's closing animation",
    );
    assert.equal(closingConfirmation.props.description, visibleConfirmation.description);
    assert.ok(
      entries.some((entry) => entry.id === "old-rice"),
      "settled history remains intact",
    );
  }

  fixture();
  await flush();
  query("tea");
  await flush();
  start();
  await flush();
  await chooseAll();
  query("rice");
  await flush();
  assert.equal(
    toolbar().props.count,
    1,
    "Changing search preserves selected tallies outside its results",
  );
  assert.equal(toolbar().props.total, 1, "Only one current matching tally is selectable");
  assert.equal(toolbar().props.allSelected, false);
  await chooseAll();
  assert.equal(
    toolbar().props.count,
    2,
    "Select all adds current results to the existing selection",
  );
  assert.equal(toolbar().props.allSelected, true);
  await chooseAll();
  assert.equal(toolbar().props.count, 1, "Clear all only removes current search results");
  assert.equal(
    toolbar().props.financialSummary.net,
    5,
    "Hidden selected tallies remain in the totals",
  );
  assert.equal(toolbar().props.financialSummary.debtCount, 1);
  assert.equal(toolbar().props.financialSummary.creditCount, 0);
  dateControl().props.onChange({ start: 1000, end: 2000 });
  await flush();
  assert.equal(toolbar().props.count, 1, "Date filtering also preserves selected tallies");
  assert.equal(toolbar().props.total, 0);

  fixture();
  await flush();
  start();
  await flush();
  await chooseAll();
  deleteEntryImpl = async (id) => {
    if (id === "new-tea") throw new Error("synthetic failure");
  };
  await askDelete();
  dialog().props.onConfirm();
  await flush();
  assert.equal(toolbar().props.count, 1, "successful rows leave selection after a partial failure");
  assert.equal(tallies().find((row) => row.props.entry.id === "new-tea")?.props.selected, true);
  assert.ok(toasts.some((toast) => toast[0].startsWith("selection.partialFailure")));
  deleteEntryImpl = async () => {};
  await askDelete();
  dialog().props.onConfirm();
  await flush();
  assert.deepEqual(
    deletedEntries,
    ["new-rice", "new-tea", "new-tea"],
    "retry excludes an already deleted tally",
  );

  fixture();
  await flush();
  start();
  await flush();
  await chooseAll();
  let release!: () => void;
  deleteEntryImpl = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await askDelete();
  dialog().props.onConfirm();
  await flush();
  assert.equal(toolbar().props.busy, true);
  toolbar().props.onClose();
  toolbar().props.onToggleAll();
  assert.ok([...backListeners].some((back) => back()));
  await flush();
  assert.equal(toolbar().props.count, 2, "in-flight controls cannot change the batch");
  vaultId = "another-vault";
  dirty = true;
  await flush();
  release();
  await flush();
  assert.deepEqual(
    deletedEntries,
    ["new-rice"],
    "vault change stops the batch before its next write",
  );
  assert.equal(toolbar(), undefined);
  assert.equal(toasts.length, 0, "old-scope completion does not notify the new vault");

  fixture();
  await flush();
  start();
  await flush();
  await chooseAll();
  canAmend = false;
  dirty = true;
  await flush();
  assert.equal(toolbar(), undefined, "role demotion clears selection immediately");
  assert.equal(
    nodes(tree).find((node) => node.props.testID === "select-tallies"),
    undefined,
  );

  fixture();
  await flush();
  start();
  await flush();
  await chooseAll();
  settlement = { count: 2, lastSettledAtMs: 1000 };
  boundaries = [200, 1000];
  await ledgerRefresh();
  await flush();
  assert.equal(toolbar(), undefined, "remote settlement removes all selection eligibility");

  fixture();
  await flush();
  query("tea");
  await flush();
  const pendingQuery = find("TextInput")!.props.onChangeText;
  const pendingDate = dateControl().props.onChange;
  start();
  await flush();
  await chooseAll();
  let finishSearchDelete!: () => void;
  deleteEntryImpl = () =>
    new Promise((resolve) => {
      finishSearchDelete = resolve;
    });
  await askDelete();
  dialog().props.onConfirm();
  await flush();
  assert.equal(toolbar().props.busy, true);
  pendingQuery("rice");
  pendingDate(dateRangeBetween(0, 0));
  toolbar().props.onClose();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "common.back")!
    .props.onPress();
  await flush();
  assert.equal(
    find("TextInput")!.props.value,
    "tea",
    "in-flight selection keeps query eligibility fixed",
  );
  assert.equal(dateControl().props.range, null);
  assert.ok(toolbar(), "In-flight removal prevents leaving selection");
  assert.deepEqual(routes, [], "Busy header back cannot navigate away from removal");
  finishSearchDelete();
  await flush();
  assert.equal(toolbar(), undefined);
  assert.deepEqual(deletedEntries, ["new-tea"]);
  fixture();
  await flush();
  query("tea");
  await flush();
  start();
  await flush();
  assert.equal(
    toolbar().props.total,
    1,
    "filtered select all is limited to matching amendable tallies",
  );
  await chooseAll();
  await askDelete();
  assert.ok(nativeDialog(), "The page owns a standalone removal confirmation");
  const staleConfirmation = dialog().props;
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "common.back")!
    .props.onPress();
  staleConfirmation.onConfirm();
  await flush();
  assert.equal(toolbar(), undefined, "Header back ends selection and its pending confirmation");
  assert.equal(find("TextInput")!.props.value, "tea");
  assert.deepEqual(routes, [], "Header back clears selection before navigating");
  start();
  await flush();
  staleConfirmation.onConfirm();
  await flush();
  assert.deepEqual(deletedEntries, [], "A closed confirmation cannot delete a new selection");
  params = { id: "another-person" };
  dirty = true;
  await flush();
  assert.equal(toolbar(), undefined, "route changes never retain selection");

  fixture(true);
  await flush();
  assert.equal(
    nodes(tree).find((node) => node.props.testID === "select-tallies"),
    undefined,
    "shared tallies retain individual review/cancel workflows",
  );
  unmount();
  assert.equal(backListeners.size, 0);
  console.log(
    "PASS: tally selection, scoped select all, cancel/back, duplicate guards, partial retries, remote settlement and route/vault/role isolation in EN/FA",
  );
}

async function inlineSearchScopeTests() {
  const actionSheet = () =>
    nodes(tree).find((node) => node.type === "BottomSheet" && node.props.visible);
  fixture();
  await flush();
  query("tea");
  await flush();
  tallies()[0].props.onLongPress(tallies()[0].props.entry);
  await flush();
  assert.ok(actionSheet(), "A tally long press opens its action menu");
  assert.equal(find("SelectionToolbar"), undefined, "Selection begins from the action menu");
  const select = actionSheet()!.props.actions.find(
    (action: any) => action.label === "selection.start",
  );
  actionSheet()!.props.onDismiss();
  select.onPress();
  await flush();
  assert.equal(find("SelectionToolbar")!.props.count, 1);
  assert.equal(tallies()[0].props.selected, true);

  for (const depart of ["person", "vault", "account", "blur"] as const) {
    fixture();
    await flush();
    query("tea");
    await flush();
    const staleRow = tallies()[0];
    const staleQuery = find("TextInput")!.props.onChangeText;
    const staleDate = dateControl().props.onChange;
    if (depart === "person") params = { id: "another-person" };
    else if (depart === "vault") vaultId = "another-vault";
    else if (depart === "account") accountId = "another-account";
    else blur();
    dirty = true;
    await flush();
    const beforeQuery = find("TextInput")?.props.value;
    const beforeRange = dateControl()?.props.range;
    staleRow.props.onLongPress(staleRow.props.entry);
    staleQuery("stale text");
    staleDate(dateRangeBetween(0, 0));
    await flush();
    assert.equal(actionSheet(), undefined, `${depart} invalidates the old tally gesture`);
    assert.equal(find("SelectionToolbar"), undefined);
    assert.equal(find("TextInput")?.props.value, beforeQuery, `${depart} rejects stale input`);
    assert.deepEqual(dateControl()?.props.range, beforeRange, `${depart} rejects stale dates`);
  }
}

async function sharedClosureReviewTests() {
  const entryRow = (id: string) => {
    const row = tallies().find((node) => node.props.entry.id === id);
    assert.ok(row, `shared tally ${id} is visible`);
    return row;
  };
  const prepareClosed = (reason: "account_deleted" | null) => {
    fixture(true);
    markers = [];
    boundaries = [];
    settlement = { count: 0, lastSettledAtMs: null };
    link = { ...link, closed_at: 10_000, closed_reason: reason };
    const meta = (by: string, status = "pending") => ({
      tab_id: link.tab_id,
      seq: 1,
      kind: "entry",
      by,
      status,
      voided: false,
    });
    entries = [
      tally("incoming", "awaiting my review", 10, 600, meta("them")),
      tally("mine", "awaiting their review", 20, 500, meta("me")),
      tally("accepted", "accepted permanently", 30, 400, meta("me", "accepted")),
      tally("rejected", "rejected permanently", 40, 300, meta("me", "disputed")),
    ];
  };
  for (const os of ["ios", "android"])
    for (const reason of [null, "account_deleted"] as const) {
      platform = os;
      prepareClosed(reason);
      await flush();
      assert.equal(watched.get("tab"), 1, `${os}: closed history keeps live sync while focused`);
      const incoming = entryRow("incoming");
      const mine = entryRow("mine");
      assert.equal(typeof incoming.props.onAccept, "function");
      assert.equal(typeof incoming.props.onReject, "function");
      assert.equal(typeof mine.props.onCancel, "function");
      await incoming.props.onAccept(incoming.props.entry);
      await incoming.props.onReject(incoming.props.entry);
      await mine.props.onCancel(mine.props.entry);
      assert.deepEqual(
        sharedActions.map(({ name, link: target, entryId }) => [
          name,
          target.tab_id,
          target.closed_at,
          entryId,
        ]),
        [
          ["acceptEntry", "tab", 10_000, "incoming"],
          ["disputeEntry", "tab", 10_000, "incoming"],
          ["voidEntry", "tab", 10_000, "mine"],
        ],
        "the screen dispatches final decisions without reopening sharing",
      );
      sharedActions.length = 0;
      for (const id of ["accepted", "rejected", "incoming"]) {
        const row = entryRow(id);
        await row.props.onCancel(row.props.entry);
      }
      assert.deepEqual(
        sharedActions,
        [],
        "reviewed tallies and another party's tally cannot be cancelled",
      );
      blur();
      assert.equal(watched.get("tab"), 0);
      refocus();
      await flush();
      assert.equal(watched.get("tab"), 1);
    }

  prepareClosed(null);
  const old = { ...link, tab_id: "old-period" };
  link = { ...link, tab_id: "latest-period", closed_at: null };
  tabLinksById.set(old.tab_id, old);
  entries[0].tab.tab_id = old.tab_id;
  await flush();
  const historical = entryRow("incoming");
  await historical.props.onAccept(historical.props.entry);
  await historical.props.onReject(historical.props.entry);
  assert.deepEqual(
    sharedActions.map(({ link: target }) => target.tab_id),
    ["old-period", "old-period"],
    "entry metadata selects the original period instead of the newest link",
  );

  prepareClosed(null);
  delete entries[0].tab.tab_id;
  await flush();
  const legacy = entryRow("incoming");
  await legacy.props.onAccept(legacy.props.entry);
  assert.equal(
    sharedActions[0]?.link.tab_id,
    "tab",
    "old cached rows without a period ID use their displayed history link",
  );

  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const mismatch of ["missing", "vault", "relationship"] as const) {
      prepareClosed(null);
      entries[0].tab.tab_id = "foreign-period";
      if (mismatch !== "missing")
        tabLinksById.set("foreign-period", {
          ...link,
          tab_id: "foreign-period",
          ...(mismatch === "vault"
            ? { vault_id: "other-vault" }
            : { relationship_id: "other-person" }),
        });
      await flush();
      const incoming = entryRow("incoming");
      await incoming.props.onAccept(incoming.props.entry);
      await incoming.props.onReject(incoming.props.entry);
      assert.deepEqual(
        sharedActions,
        [],
        `${mismatch}: a row cannot review an unknown or out-of-scope period`,
      );
      assert.equal(toasts.length, 2, "scope failures give feedback without dispatching mutations");
    }
    for (const depart of ["account", "vault", "blur"] as const) {
      prepareClosed(null);
      await flush();
      const incoming = entryRow("incoming");
      let release!: (target: any) => void;
      const target = { ...link };
      tabLinkReadGate = new Promise((resolve) => {
        release = resolve;
      });
      const reviewing = incoming.props.onAccept(incoming.props.entry);
      if (depart === "account") accountId = "another-account";
      else if (depart === "vault") vaultId = "another-vault";
      else blur();
      release(target);
      await reviewing;
      await flush();
      assert.deepEqual(
        sharedActions,
        [],
        `${depart}: a lookup finishing after departure cannot submit a stale review`,
      );
    }
  } finally {
    console.warn = warn;
    tabLinkReadGate = null;
  }
  console.log(
    "PASS: closed-period reviews stay available, resolve the exact tally period, preserve finality, and reject wrong or departed scopes",
  );

  for (const locale of ["en", "fa", "ps"] as const) {
    prepareClosed(null);
    rtl = locale !== "en";
    balanceLabelLocale = locale;
    person = {
      ...person,
      balance: 30,
      tab_confirmed_balance: 30,
      tab_pending_count: 2,
      tab_pending_balance: 10,
    };
    await flush();
    const confirmed = translations.tIn(locale, "tab.balance.confirmed", {
      amount: "+amount:30",
      currency: "AFN",
    });
    const pending = translations.tIn(locale, "tab.balance.pending", {
      count: 2,
      amount: "+amount:10",
      currency: "AFN",
    });
    assert.ok(
      words(tree).includes("amount:30"),
      `${locale}: the confirmed headline remains visible`,
    );
    assert.ok(
      words(tree).includes(confirmed),
      `${locale}: confirmed money has its own localized label`,
    );
    assert.ok(
      words(tree).includes(pending),
      `${locale}: pending transaction count and signed net change remain explicit`,
    );
    assert.notEqual(confirmed, "tab.balance.confirmed");
    assert.notEqual(pending, "tab.balance.pending");
    person = { ...person, balance: 0, tab_confirmed_balance: -30, tab_pending_balance: -10 };
    await ledgerRefresh();
    await flush();
    for (const [key, amount] of [
      ["tab.balance.confirmed", "−amount:30"],
      ["tab.balance.pending", "−amount:10"],
    ] as const)
      assert.ok(
        words(tree).includes(translations.tIn(locale, key, { count: 2, amount, currency: "AFN" })),
        `${locale}: negative shared balances and pending repayments retain their direction`,
      );
    person = { ...person, tab_pending_balance: 0 };
    await ledgerRefresh();
    await flush();
    assert.ok(
      words(tree).includes(
        translations.tIn(locale, "tab.balance.pending", {
          count: 2,
          amount: "amount:0",
          currency: "AFN",
        }),
      ),
      "opposite pending tallies remain visible even when their net is zero",
    );
    person = { ...person, tab_pending_count: 0 };
    await ledgerRefresh();
    await flush();
    assert.ok(
      !words(tree).includes(
        translations.tIn(locale, "tab.balance.pending", {
          count: 0,
          amount: "amount:0",
          currency: "AFN",
        }),
      ),
      "no empty pending label after the last review",
    );
  }
  balanceLabelLocale = null;
  console.log(
    "PASS: the real person screen labels confirmed balance and pending count/net separately in English, Dari and Pashto",
  );
}

async function main() {
  {
    fixture();
    const afn = { ...person, currency: "AFN", balance: 100 };
    const usd = { ...person, currency: "USD", balance: -100 };
    person = { ...afn, currency_balances: [afn, usd] };
    entries = [
      { ...tally("afn", "local", 100, 400), currency: "AFN" },
      { ...tally("usd", "dollar", 100, 300, undefined, "payment"), currency: "USD" },
    ];
    settlement = { count: 0, lastSettledAtMs: null };
    boundaries = [];
    currencyPeriods.set("AFN", {
      settlement: { count: 1, lastSettledAtMs: 350 },
      boundaries: [350],
    });
    await flush();
    assert.equal(personReads[0][2].allCurrencies, true);
    assert.equal(entryReads[0][2].allCurrencies, true);
    assert.equal(find("CurrencySelector"), undefined);
    assert.deepEqual(
      find("CustomerBalanceCarousel")!.props.currencies,
      ["AFN", "USD"],
      "Both independent balances share the horizontal carousel",
    );
    assert.deepEqual(
      rowIds(),
      ["afn", "usd"],
      "A foreign entry is not hidden behind another currency's chapter boundary",
    );
    const flows = nodes(tree).filter((node) => node.type === "TallyFlowSummary");
    assert.deepEqual(
      flows.map((node) => [
        node.props.currency,
        node.props.summary.gave.amount,
        node.props.summary.received.amount,
      ]),
      [
        ["AFN", 100, 0],
        ["USD", 0, 100],
      ],
      "Flows never add or net different currencies",
    );
    assert.equal(
      nodes(tree).some((node) => node.props.accessibilityLabel?.startsWith("person.settle.row")),
      false,
      "Opposite foreign balances cannot create a false zero settle action",
    );
    find("OverflowMenu")!
      .props.actions.find((action: any) => action.label === "selection.start")
      .onPress();
    await flush();
    find("SelectionToolbar")!.props.onToggleAll();
    await flush();
    assert.deepEqual(
      find("SelectionToolbar")!.props.financialSummaries.map((item: any) => [
        item.currency,
        item.summary.net,
      ]),
      [
        ["AFN", 100],
        ["USD", -100],
      ],
    );
    assert.equal(find("SelectionToolbar")!.props.financialSummary, undefined);
    find("SelectionToolbar")!.props.onClose();
    await flush();
    person = { ...afn, currency_balances: [afn, { ...usd, balance: 0 }] };
    entries.push({ ...tally("usd-returned", "returned", 100, 500), currency: "USD" });
    await ledgerRefresh!();
    await flush();
    assert.deepEqual(
      find("CustomerBalanceCarousel")!.props.currencies,
      ["AFN", "USD"],
      "A zero balance stays reachable beside its currency's history and settlement state",
    );
    const settle = nodes(tree).filter((node) =>
      node.props.accessibilityLabel?.startsWith("person.settle.row"),
    );
    assert.equal(settle.length, 1);
    assert.ok(settle[0].props.accessibilityLabel.includes("USD"));
    settle[0].props.onPress();
    await flush();
    const confirm = nodes(tree).find(
      (node) =>
        node.type === "ConfirmDialog" &&
        node.props.visible &&
        node.props.title === "person.settle.confirm.title",
    )!;
    await confirm.props.onConfirm();
    await flush();
    assert.equal(
      settledWrites[0].currency,
      "USD",
      "A currency-specific ruling-off never settles the nonzero AFN account",
    );
    assert.ok(
      nodes(tree)
        .filter((node) => node.type === "TallyFlowSummary")
        .some((node) => node.props.currency === "AFN" && node.props.summary.gave.amount === 100),
    );
    unmount();
    console.log(
      "PASS all-currency person: one timeline, separate balances/flows/selection, currency-scoped chapters and zero-only settlements",
    );
  }
  await sharedClosureReviewTests();
  {
    fixture(true);
    const dollarTab = { ...link, tab_id: "usd-tab", currency: "USD", other_joined_at: 1 };
    const incoming = {
      ...entries[2],
      id: "usd-incoming",
      currency: "USD",
      amount_afn: 50,
      tab: {
        ...entries[2].tab,
        tab_id: "usd-tab",
        by: "other",
        status: "pending",
        local_pending: false,
      },
    };
    const afn = { ...person, currency: "AFN", balance: 100, tab_id: null };
    const usd = { ...person, currency: "USD", balance: 0, tab_id: "usd-tab", tab_pending_count: 1 };
    const aud = { ...person, currency: "AUD", balance: -25, tab_id: null };
    person = { ...afn, currency_balances: [afn, usd, aud] };
    entries = [
      { ...tally("afn-local", "private", 100, 400), currency: "AFN" },
      incoming,
      { ...tally("aud-payment", "dollars", 25, 250, undefined, "payment"), currency: "AUD" },
      { ...tally("afn-old-payment", "settled", 10, 150, undefined, "payment"), currency: "AFN" },
      { ...tally("afn-old-debt", "settled", 10, 100), currency: "AFN" },
    ];
    settlement = { count: 0, lastSettledAtMs: null };
    boundaries = [];
    preLink = [];
    markers = [];
    link = null;
    currencyPeriods.set("AFN", {
      settlement: { count: 1, lastSettledAtMs: 200 },
      boundaries: [200],
    });
    currencyPeriods.set("USD", { tab: dollarTab, settlement, boundaries: [], markers: [] });
    tabLinksById.set("usd-tab", dollarTab);
    await flush();
    await flush();
    assert.ok(
      (watched.get("usd-tab") ?? 0) > 0,
      "A foreign shared tab stays watched even when the primary account is private",
    );
    await tallies()
      .find((node) => node.props.entry.id === "usd-incoming")!
      .props.onAccept(incoming);
    assert.equal(sharedActions.at(-1)?.link.currency, "USD");
    assert.equal(sharedActions.at(-1)?.link.tab_id, "usd-tab");
    query("no matching tally");
    dateControl().props.onChange(dateRangeBetween(Date.UTC(2026, 9, 26), Date.UTC(2026, 9, 26)));
    await flush();
    assert.deepEqual(rowIds(), [], "The screen filters hide all tallies before sharing");
    pingButton().props.onPress();
    await flush();
    const chooseCurrency = nodes(tree).find(
      (node) =>
        node.type === "OptionSheet" &&
        node.props.visible &&
        node.props.title === "entry.currency.label",
    );
    assert.equal(chooseCurrency, undefined, "A full bill never asks to narrow it to one currency");
    assert.equal(shares.length, 1);
    assert.deepEqual(
      shares[0].args[2].map((section: any) => [section.currency, section.balance]),
      [
        ["AFN", 100],
        ["USD", 0],
        ["AUD", -25],
      ],
      "The full bill carries separate private and shared currency balances",
    );
    assert.deepEqual(
      shares[0].args[2].map((section: any) => section.entries.map((entry: any) => entry.id)),
      [["afn-local", "afn-old-payment", "afn-old-debt"], ["usd-incoming"], ["aud-payment"]],
      "Every currency and folded chapter is shared even when search/date filters hide it",
    );
    assert.deepEqual(
      shares[0].args[2][0].settled,
      {
        settledChapters: 1,
        settledBoundaryMs: 200,
        settledBoundaries: [200],
      },
      "A private statement retains its own settled chapters",
    );
    assert.deepEqual(
      shares[0].args[2][1].settled,
      {
        settledChapters: 0,
        settledBoundaryMs: null,
        settledBoundaries: [],
      },
      "A shared statement never inherits private settlement boundaries",
    );
    shares[0].resolve(true);
    await flush();
    find("OverflowMenu")!
      .props.actions.find((action: any) => action.icon === "link-outline")
      .onPress();
    await flush();
    const linkChoice = nodes(tree).find(
      (node) =>
        node.type === "OptionSheet" &&
        node.props.visible &&
        node.props.title === "entry.currency.label",
    )!;
    linkChoice.props.onSelect("USD");
    advance(220);
    await flush();
    const managed = nodes(tree).find(
      (node) =>
        node.type === "BottomSheet" && node.props.visible && node.props.title.includes("USD"),
    )!;
    managed.props.actions.find((action: any) => action.label === "tab.unlink").onPress();
    await flush();
    const confirm = nodes(tree).find(
      (node) =>
        node.type === "ConfirmDialog" &&
        node.props.visible &&
        node.props.title === "tab.unlink.title",
    )!;
    await confirm.props.onConfirm();
    await flush();
    assert.equal(sharedActions.at(-1)?.name, "unlinkContact");
    assert.equal(
      sharedActions.at(-1)?.link.currency,
      "USD",
      "Management actions never fall back to the global AFN view",
    );
    person = {
      ...person,
      currency_balances: [afn, { ...usd, tab_unsynced: 1 }, aud],
    };
    await ledgerRefresh();
    await flush();
    pingButton().props.onPress();
    await flush();
    assert.equal(shares.length, 1, "An unknown foreign balance blocks the entire bill");
    assert.equal(toasts.at(-1)?.[0], "tab.notDownloaded");
    unmount();
    console.log(
      "PASS all-currency shared person: foreign tab watch/review, complete bill, and exact shared-management target",
    );
  }
  await tallySelectionTests();
  await inlineSearchScopeTests();
  await notificationReminderFlowTests();
  for (const p of ["android", "ios"])
    for (const r of [false, true]) {
      platform = p;
      rtl = r;
      fixture();
      await flush();
      const dock = nodes(tree).find(
        (node) =>
          node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
      )!;
      assert.ok(dock, "search lives in the bottom action dock");
      // Read the composed styles from the real controls, including press
      // feedback. A palette can change without losing readable text or arrows.
      for (const [label, arrowName] of [
        ["person.action.iReceived", "arrow-down-outline"],
        ["person.action.iGave", "arrow-up-outline"],
      ]) {
        const button = nodes(dock).find(
          (node) => node.type === "Pressable" && words(node) === label,
        )!;
        assert.ok(button, `${label} is an entry button`);
        const text = nodes(button).find((node) => node.type === "Text")!;
        const arrow = nodes(button).find((node) => node.type === "Icon")!;
        const coin = nodes(button).find(
          (node) => node.type === "View" && nodes(node).includes(arrow),
        )!;
        const ink = flattenStyle(text.props.style).color;
        assert.equal(arrow.props.name, arrowName);
        assert.equal(arrow.props.color, ink, `${label} arrow and label share readable ink`);
        for (const pressed of [false, true]) {
          const face = flattenStyle(button.props.style({ pressed }));
          const opacity = face.opacity ?? 1;
          assert.ok(
            contrastOverWhite(ink, face.backgroundColor, opacity) >= 4.5,
            `${label} text is readable with pressed=${pressed}`,
          );
          assert.ok(
            contrastOverWhite(ink, flattenStyle(coin.props.style).backgroundColor, opacity) >= 3,
            `${label} arrow is readable with pressed=${pressed}`,
          );
        }
      }
      assert.ok(words(tree).includes("Family"), "The customer's group name is visible");
      assert.equal(words(tree).includes("groups.view"), false, "Group names have no Group prefix");
      const nameRow = nodes(tree).find(
        (node) =>
          node.type === "View" &&
          nodes(node).some((child) => child.type === "Text" && words(child) === person.name) &&
          nodes(node).some((child) => child.type === "Text" && words(child) === "Family") &&
          Object.assign({}, ...[node.props.style].flat(2).filter(Boolean)).justifyContent ===
            "space-between",
      );
      assert.ok(nameRow, "Group badges sit in the customer's name row");
      assert.equal(dateControl().props.visible, false);
      const calendarButton = nodes(dock).find(
        (node) => node.props.accessibilityLabel === "person.date.title",
      );
      assert.ok(calendarButton, "The calendar trigger stays beside inline search in the dock");
      calendarButton.props.onPress();
      await flush();
      assert.equal(dateControl().props.visible, true);
      dateControl().props.onDismiss();
      await flush();
      assert.equal(dateControl().props.visible, false);
      // The dock is opaque: "box-none" passed taps on its background to the
      // hidden tally rows underneath, including final Accept/Reject pills.
      assert.notEqual(dock.props.pointerEvents, "box-none", "the opaque dock takes its own taps");
      const dockStyle = Object.assign({}, ...[dock.props.style].flat(2).filter(Boolean));
      assert.ok(
        -dockStyle.bottom >= TOAST_LIFT,
        "the dock's own background reaches past the full toast lift",
      );
      assert.equal(
        searchFooter().props.closedPadding + dockStyle.bottom,
        20,
        "at rest the controls stay 20pt above the safe area",
      );
      assert.equal(
        dockStyle.paddingBottom,
        undefined,
        "only the native footer owns keyboard padding",
      );
      assert.equal(searchFooter().props.keyboardShown, false);
      assert.equal(dockStyle.transform[0].translateY, toastOffset, "toasts still lift the dock");
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      assert.equal(find("TextInput")!.props.submitBehavior, "blurAndSubmit");
      const keyboardSlot = nodes(tree).find(
        (node) => node.type === "SearchControlSlot" && node.props.collapse,
      )!;
      assert.equal(
        keyboardSlot.props.animate,
        false,
        "a hidden keyboard-dismiss slot has no independent width animation",
      );
      const clearSlot = nodes(tree).find(
        (node) => node.type === "SearchControlSlot" && !node.props.collapse,
      )!;
      assert.equal(clearSlot.props.animate, undefined, "fixed Clear keeps its default animation");
      let inputBlurs = 0;
      find("TextInput")!.props.ref.current = {
        blur: () => inputBlurs++,
        isFocused: () => false,
      };
      assert.equal(
        typeof find("TextInput")!.props.onPress,
        p === "android" ? "function" : "undefined",
      );
      find("TextInput")!.props.onPress?.();
      await flush();
      const pressedDock = nodes(tree).find(
        (node) =>
          node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
      )!;
      assert.equal(
        words(pressedDock).includes("person.action.iGave"),
        p === "ios",
        "Android press prepares the dock before native focus; iOS has no press-time layout change",
      );
      if (p === "android") {
        assert.ok(
          nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
          "Android press shows the immediate down arrow before onFocus or keyboard events",
        );
        assert.equal(scheduledKeyboardLayouts.length, 0);
      }
      find("TextInput")!.props.onFocus();
      await flush();
      const openingSlot = nodes(tree).find(
        (node) => node.type === "SearchControlSlot" && node.props.collapse,
      )!;
      assert.equal(openingSlot.props.visible, true);
      assert.equal(
        openingSlot.props.animate,
        p === "ios",
        "iOS preserves the existing opening motion while Android commits its slot immediately",
      );
      const focusedDock = nodes(tree).find(
        (node) =>
          node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
      )!;
      const focusedDockStyle = flattenStyle(focusedDock.props.style);
      assert.equal(
        words(focusedDock).includes("person.action.iGave"),
        p === "ios",
        "Android prepares the compact dock before the IME arrives; iOS waits for its will event",
      );
      if (p === "android") {
        assert.equal(searchFooter().props.openPadding + focusedDockStyle.bottom, 8);
        assert.equal(searchFooter().props.keyboardShown, true);
        assert.equal(focusedDockStyle.transform[0].translateY, 0);
        assert.equal(scheduledKeyboardLayouts.length, 0);
      }
      if (p === "ios") {
        keyboardEvent("keyboardWillShow");
        await flush();
        assert.ok(
          !words(tree).includes("person.action.iGave"),
          "the dock compacts when the keyboard begins moving, not afterward",
        );
        assert.equal(
          scheduledKeyboardLayouts.length,
          0,
          "native motion has no second layout clock",
        );
        keyboardEvent("keyboardWillHide");
        await flush();
        assert.equal(inputBlurs, 0, "interactive closing does not blur before completion");
        assert.ok(
          nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        );
        keyboardEvent("keyboardWillShow");
        await flush();
        assert.ok(
          !words(tree).includes("person.action.iGave"),
          "cancelled close returns the compact dock without losing focus",
        );
        const beforeLeavingRoute = scheduledKeyboardLayouts.length;
        blur();
        keyboardEvent("keyboardWillShow");
        keyboardEvent("keyboardWillHide");
        await flush();
        assert.equal(
          scheduledKeyboardLayouts.length,
          beforeLeavingRoute,
          "a retained hidden route does not animate another page's keyboard",
        );
        refocus();
        find("TextInput")!.props.onFocus();
        keyboardEvent("keyboardWillShow");
        await flush();
        assert.equal(
          scheduledKeyboardLayouts.length,
          beforeLeavingRoute,
          "returning still delegates physical keyboard movement to the native frame",
        );
      }
      keyboardEvent("keyboardDidShow");
      await flush();
      const typingDock = nodes(tree).find(
        (node) =>
          node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
      )!;
      // Audit #31: typing a search leaves room for results above the keyboard.
      const typingStyle = Object.assign({}, ...[typingDock.props.style].flat(2).filter(Boolean));
      if (p === "android") {
        assert.deepEqual(
          typingStyle,
          focusedDockStyle,
          "Android didShow does not change the dock a second time after native resize",
        );
        assert.equal(scheduledKeyboardLayouts.length, 0);
        find("TextInput")!.props.onBlur();
        await flush();
        const blurredDock = nodes(tree).find(
          (node) =>
            node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
        )!;
        assert.deepEqual(
          flattenStyle(blurredDock.props.style),
          typingStyle,
          "Android blur does not expand the dock while the native keyboard is still visible",
        );
        assert.equal(words(blurredDock).includes("person.action.iGave"), false);
        find("TextInput")!.props.onFocus();
        await flush();
      }
      assert.ok(
        searchFooter().props.openPadding + typingStyle.bottom < 20,
        "no safe-area band under the search while the keyboard covers it",
      );
      assert.equal(
        words(typingDock).includes("person.action.iGave"),
        false,
        "the entry buttons step aside while typing",
      );
      assert.equal(
        Object.assign({}, ...[typingDock.props.style].flat(2).filter(Boolean)).transform[0]
          .translateY,
        0,
        "a toast behind the keyboard does not make the dock jump while typing",
      );
      const closeEmptySearch = nodes(tree).find(
        (node) => node.props.accessibilityLabel === "common.hideKeyboard",
      )!;
      assert.ok(
        closeEmptySearch,
        `${p}/${r ? "fa" : "en"}: empty tally search has a reachable keyboard close control`,
      );
      const closeStyle = Object.assign(
        {},
        ...[closeEmptySearch.props.style].flat(2).filter(Boolean),
      );
      assert.ok(
        (closeStyle.width ?? closeStyle.minWidth) >= 44 &&
          (closeStyle.height ?? closeStyle.minHeight) >= 44,
        "tally dismiss target is at least 44pt",
      );
      const beforeEmptyClose = keyboardDismissals;
      const beforeCloseBlurs = inputBlurs;
      const beforeCloseLayouts = scheduledKeyboardLayouts.length;
      closeEmptySearch.props.onPress();
      await flush();
      assert.equal(keyboardDismissals, beforeEmptyClose + 1);
      assert.equal(inputBlurs, beforeCloseBlurs + 1, "down releases the tally input itself");
      assert.equal(find("TextInput")!.props.value, "");
      if (p === "ios") {
        assert.ok(
          nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
          "explicit blur retains the dismiss slot until native willHide starts the close",
        );
        assert.equal(
          scheduledKeyboardLayouts.length,
          beforeCloseLayouts,
          "the button does not guess a keyboard animation before its native event",
        );
        assert.equal(
          words(tree).includes("person.action.iGave"),
          false,
          "explicit blur keeps the compact dock until the keyboard begins hiding",
        );
        keyboardEvent("keyboardWillHide");
        await flush();
        assert.equal(scheduledKeyboardLayouts.length, beforeCloseLayouts);
        assert.equal(searchFooter().props.keyboardShown, false);
        const closingSlot = nodes(tree).find(
          (node) => node.type === "SearchControlSlot" && node.props.collapse,
        )!;
        assert.equal(closingSlot.props.visible, false);
        assert.equal(
          closingSlot.props.animate,
          false,
          "willHide commits the collapsed width without an extra160ms JS animation",
        );
        assert.ok(
          words(tree).includes("person.action.iGave"),
          "the dock restores in that same close",
        );
      }
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(
        scheduledKeyboardLayouts.length,
        beforeCloseLayouts,
        "didHide adds no trailing keyboard layout animation",
      );
      const dockNodes = nodes(dock);
      assert.ok(
        dockNodes.findIndex((node) => words(node) === "person.action.iReceived") <
          dockNodes.findIndex((node) => node.type === "TextInput"),
        "search appears below I received/I gave",
      );
      assert.equal(
        find("Keyboard"),
        undefined,
        "the customer has no competing JS keyboard avoider",
      );
      assert.equal(flattenStyle(find("SearchKeyboardFrame")!.props.style).flex, 1);
      assert.ok(nodes(find("SearchKeyboardFrame")).includes(find("ScrollView")!));
      assert.equal(
        find("ScrollView")?.props.automaticallyAdjustKeyboardInsets,
        false,
        "native resize or the iOS native-motion frame owns avoidance without duplicate scroll insets",
      );
      assert.equal(
        find("ScrollView")!.props.keyboardDismissMode,
        p === "ios" ? "interactive" : "on-drag",
      );
      assert.deepEqual(rowIds(), ["new-rice", "new-tea"], "settled history starts folded");
      query("rice");
      find("TextInput")!.props.onFocus();
      await flush();
      assert.deepEqual(rowIds(), ["new-rice", "old-rice"], "search spans settled chapters");
      nodes(tree)
        .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
        .props.onPress();
      await flush();
      assert.equal(find("TextInput")!.props.value, "rice", "down keeps tally search text");
      assert.deepEqual(
        rowIds(),
        ["new-rice", "old-rice"],
        "down keeps current/settled search matches",
      );
      find("TextInput")!.props.onFocus();
      await flush();
      find("TextInput")!.props.onSubmitEditing();
      await flush();
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      assert.equal(find("TextInput")!.props.value, "rice", "Search return keeps tally search text");
      find("TextInput")!.props.onFocus();
      await flush();
      keyboardEvent("keyboardDidShow");
      await flush();
      const beforeNativeHideBlurs = inputBlurs;
      const beforeNativeHideDismissals = keyboardDismissals;
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      if (p === "android") {
        assert.equal(
          inputBlurs,
          beforeNativeHideBlurs + 1,
          "native Back hide releases input focus",
        );
        assert.equal(
          keyboardDismissals,
          beforeNativeHideDismissals,
          "Back-driven didHide does not need a second dismiss request",
        );
        const restoredDock = nodes(tree).find(
          (node) =>
            node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
        )!;
        assert.ok(words(restoredDock).includes("person.action.iGave"));
        assert.deepEqual(flattenStyle(restoredDock.props.style), dockStyle);
        assert.equal(find("TextInput")!.props.value, "rice", "Back keeps the tally search query");
      }
      // The dated settlement line stays between a current and a settled
      // result, so an old paid tally never reads as current (audit #3).
      assert.deepEqual(
        nodes(tree).flatMap((n) =>
          n.type === "EntryRow"
            ? [n.props.entry.id]
            : n.type === "Text" && words(n) === "person.history.settledOn"
              ? ["settled-line"]
              : [],
        ),
        ["new-rice", "settled-line", "old-rice"],
      );
      assert.equal(
        tallies().find((n) => n.props.entry.id === "old-rice")?.props.onLongPress,
        undefined,
      );
      assert.ok(tallies().find((n) => n.props.entry.id === "new-rice")?.props.onLongPress);
      assert.ok(words(tree).includes("amount:3"), "search does not narrow the hero balance");
      assert.deepEqual(
        find("TallyFlowSummary")?.props.summary,
        {
          gave: { count: 2, amount: 15 },
          received: { count: 2, amount: 12 },
        },
        "flow totals include settled history and do not narrow with search",
      );
      const exportSheet = nodes(tree).find(
        (n) => n.type === "BottomSheet" && n.props.title === "personEdit.export",
      )!;
      exportSheet.props.actions[0].onPress();
      await flush();
      assert.deepEqual(
        exports,
        [["person", "pdf", "share"]],
        "export still reads the entire person statement",
      );
      const firstPing = pingButton();
      assert.equal(firstPing.props.accessibilityLabel, "person.ping.button");
      const menu = find("OverflowMenu")!;
      const group = nodes(tree).find((n) => kids(n).includes(firstPing) && kids(n).includes(menu));
      assert.ok(group, "WhatsApp sits beside the menu in one header action group");
      assert.equal(
        menu.props.actions.some((a: any) => a.icon === "logo-whatsapp"),
        false,
      );
      assert.equal(nodes(tree).filter((n) => n.props.testID === "whatsapp-reminder").length, 1);
      firstPing.props.onPress();
      firstPing.props.onPress();
      await flush();
      assert.equal(shares.length, 1, "duplicate reminder taps share one preparation");
      assert.equal(preferenceReads, 1);
      assert.deepEqual(
        shares[0].args[2].flatMap((section: any) => section.entries.map((e: any) => e.id)),
        entries.map((e) => e.id),
        "reminder is not narrowed by search",
      );
      assert.equal(shares[0].args[2][0].balance, 3);
      assert.equal(pingButton().props.accessibilityLabel, "person.ping.preparing");
      assert.equal(
        words(tree).includes("person.ping.preparing"),
        false,
        "no loading text above the page",
      );
      assert.ok(
        nodes(pingButton()).some((n) => n.type === "Spinner"),
        "the reminder button shows its spinner",
      );
      shares[0].args[4]("opening");
      await flush();
      assert.equal(pingButton().props.accessibilityLabel, "person.ping.opening");
      assert.equal(
        words(tree).includes("person.ping.opening"),
        false,
        "opening uses only the spinner visually",
      );
      assert.ok(nodes(pingButton()).some((n) => n.type === "Spinner"));
      assert.equal(pingButton().props.accessibilityState.busy, true);
      shares[0].resolve(true);
      await flush();
      assert.equal(pingButton().props.accessibilityLabel, "person.ping.button");
      nodes(tree)
        .find((n) => n.props.accessibilityLabel === "person.search.clear")!
        .props.onPress();
      await flush();
      assert.deepEqual(
        rowIds(),
        ["new-rice", "new-tea"],
        "clearing returns to the previous chapter view",
      );
    }
  console.log(
    "PASS: real person screen search spans settled history without narrowing balances/export/reminders; Android/iOS EN/FA keyboard gates and spinner-only reminder/duplicate guard",
  );

  fixture();
  platform = "ios";
  await flush();
  runFrames();
  runFrames();
  await flush();
  const nativeDock = () =>
    nodes(tree).find(
      (node) =>
        node.type === "AnimatedView" && nodes(node).some((child) => child.type === "TextInput"),
    )!;
  const dockSkirt = -flattenStyle(nativeDock().props.style).bottom;
  const measureDock = (height: number) =>
    nativeDock().props.onLayout({ nativeEvent: { layout: { height: height + dockSkirt } } });
  const listPadding = () =>
    flattenStyle(find("ScrollView")!.props.contentContainerStyle).paddingBottom;
  const stableInputRef = find("TextInput")!.props.ref;
  measureDock(200);
  await flush();
  assert.equal(listPadding(), 224, "ordinary resting dock layout reserves visible controls");
  keyboardEvent("keyboardWillShow");
  await flush();
  for (const height of [180, 156, 128]) {
    measureDock(height);
    await flush();
    assert.equal(listPadding(), 224, "intermediate native motion does not rerender list spacing");
  }
  keyboardEvent("keyboardDidShow");
  await flush();
  measureDock(120);
  await flush();
  assert.equal(
    listPadding(),
    224,
    "didShow waits for final native layout before publishing height",
  );
  runFrames();
  await flush();
  assert.equal(listPadding(), 224);
  runFrames();
  await flush();
  assert.equal(listPadding(), 144, "one settled publication reserves the compact dock");
  keyboardEvent("keyboardWillHide");
  await flush();
  for (const height of [145, 180]) {
    measureDock(height);
    await flush();
    assert.equal(listPadding(), 144, "closing native frames do not feed back into React layout");
  }
  keyboardEvent("keyboardDidHide");
  await flush();
  measureDock(200);
  runFrames();
  runFrames();
  await flush();
  assert.equal(listPadding(), 224, "finished close restores resting list space once");
  assert.equal(
    find("TextInput")!.props.ref,
    stableInputRef,
    "keyboard motion never remounts search",
  );
  assert.equal(
    scheduledKeyboardLayouts.length,
    0,
    "native motion never schedules a fixed JS clock",
  );
  keyboardEvent("keyboardWillShow");
  measureDock(150);
  keyboardEvent("keyboardDidShow");
  const departedFrames = [...frames.values()];
  assert.ok(departedFrames.length > 0);
  blur();
  await flush();
  departedFrames.forEach((work) => work());
  await flush();
  assert.equal(
    listPadding(),
    224,
    "retained stable-layout callbacks cannot repaint a hidden route",
  );
  refocus();
  await flush();
  measureDock(190);
  await flush();
  assert.equal(listPadding(), 214, "returning permits ordinary stable measurements again");
  console.log(
    "PASS: native keyboard dock frames do not rerender list padding until settled or repaint hidden routes",
  );

  fixture();
  platform = "ios";
  await flush();
  let nativeSearchFocused = false,
    nativeSearchBlurs = 0;
  const reopeningInput = find("TextInput")!.props.ref;
  reopeningInput.current = {
    focus: () => {
      nativeSearchFocused = true;
    },
    blur: () => {
      nativeSearchFocused = false;
      nativeSearchBlurs++;
    },
    isFocused: () => nativeSearchFocused,
  };
  reopeningInput.current.focus();
  find("TextInput")!.props.onFocus();
  keyboardEvent("keyboardWillShow");
  keyboardEvent("keyboardDidShow");
  query("rice");
  await flush();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  keyboardEvent("keyboardWillHide");
  await flush();
  assert.equal(nativeSearchFocused, false, "Down resigns the old native input focus");
  const blursBeforeReopen = nativeSearchBlurs;
  reopeningInput.current.focus();
  // Native focus is synchronous, but the new onFocus/WillShow JS events can
  // arrive after the old hide completion, exactly as on the physical iPhone.
  keyboardEvent("keyboardDidHide");
  await flush();
  assert.equal(nativeSearchFocused, true, "old hide completion cannot resign a newer native focus");
  assert.equal(nativeSearchBlurs, blursBeforeReopen);
  keyboardEvent("keyboardWillShow");
  keyboardEvent("keyboardDidShow");
  find("TextInput")!.props.onFocus();
  await flush();
  assert.equal(find("TextInput")!.props.ref, reopeningInput);
  assert.ok(nodes(tree).some((node) => node.props.accessibilityLabel === "common.hideKeyboard"));
  assert.equal(searchFooter().props.keyboardShown, true);
  assert.equal(find("TextInput")!.props.value, "rice");
  assert.deepEqual(rowIds(), ["new-rice", "old-rice"]);
  nativeSearchFocused = false;
  keyboardEvent("keyboardWillHide");
  keyboardEvent("keyboardDidHide");
  await flush();
  assert.equal(nativeSearchBlurs, blursBeforeReopen + 1, "a committed native hide still cleans up");
  assert.equal(searchFooter().props.keyboardShown, false);
  assert.equal(
    nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
    undefined,
  );
  console.log(
    "PASS: late iOS hide completion preserves native refocus before the new JS focus event",
  );

  fixture();
  canCreate = false;
  canAmend = false;
  await flush();
  assert.ok(find("TextInput"), "viewers keep tally search");
  assert.equal(
    nodes(tree).some((node) => words(node) === "person.action.iReceived"),
    false,
    "viewers do not get tally creation buttons",
  );
  assert.ok(
    nodes(tree).some((node) => node.props.accessibilityLabel === "person.date.title"),
    "viewers keep date filter",
  );
  assert.equal(
    tallies().some((row) => row.props.onLongPress),
    false,
  );
  find("TextInput")!.props.onFocus();
  await flush();
  const viewerDismiss = nodes(tree).find(
    (node) => node.props.accessibilityLabel === "common.hideKeyboard",
  )!;
  assert.ok(viewerDismiss, "viewers can close the tally keyboard too");
  viewerDismiss.props.onPress();
  await flush();
  assert.equal(
    nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
    undefined,
  );
  if (platform === "ios") {
    reducedMotion = true;
    dirty = true;
    await flush();
    const beforeReducedLayouts = scheduledKeyboardLayouts.length;
    keyboardEvent("keyboardWillShow");
    keyboardEvent("keyboardWillHide");
    await flush();
    assert.equal(
      scheduledKeyboardLayouts.length,
      beforeReducedLayouts,
      "Reduce Motion skips added tally keyboard animation scheduling",
    );
  }
  fixture(true);
  const datedAt = new Date(2026, 9, 11, 12).getTime();
  entries[0].created_at = datedAt;
  await flush();
  query("rice 99");
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "note and amount terms combine on the real screen");
  query("۵۰۰");
  await flush();
  assert.deepEqual(
    rowIds(),
    ["pre-rice"],
    "numeric search includes pre-link tallies and Persian digits",
  );
  query("7");
  await flush();
  assert.deepEqual(rowIds(), ["failed-rice"], "numeric search includes not-sent tallies");
  query("2026");
  await flush();
  assert.deepEqual(rowIds(), [], "date text no longer matches timestamp fields");
  query("");
  find("TallyDateFilterSheet")!.props.onChange(dateRangeBetween(datedAt, datedAt));
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "proper range selects the tally business day");
  const selectedRange = find("TallyDateFilterSheet")!.props.range;
  query("rice");
  find("TextInput")!.props.onFocus();
  await flush();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "common.hideKeyboard")!
    .props.onPress();
  await flush();
  assert.deepEqual(
    find("TallyDateFilterSheet")!.props.range,
    selectedRange,
    "closing the keyboard retains the date range",
  );
  assert.equal(find("TextInput")!.props.value, "rice");
  assert.deepEqual(
    rowIds(),
    ["rejected-rice"],
    "note/date matches stay in place after keyboard dismissal",
  );
  find("TextInput")!.props.onFocus();
  await flush();
  nodes(tree)
    .find((node) => node.props.accessibilityLabel === "person.search.clear")!
    .props.onPress();
  await flush();
  assert.ok(
    nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
    "tally Clear leaves typing available",
  );
  keyboardEvent("keyboardDidHide");
  await flush();
  for (const selected of ["jalali", "qamari"] as Calendar[]) {
    calendar = selected;
    rtl = true;
    dirty = true;
    await flush();
    assert.deepEqual(
      rowIds(),
      ["rejected-rice"],
      "calendar changes render labels without changing selected business dates",
    );
  }
  for (const selected of ["gregorian", "jalali", "qamari"] as Calendar[]) {
    calendar = selected;
    for (const language of ["en", "fa"] as const) {
      rtl = language === "fa";
      entries[0].created_at = datedAt + 59_999;
      find("TallyDateFilterSheet")!.props.onChange(
        customDateRange(datedAt, datedAt, 12 * 60, 12 * 60),
      );
      await flush();
      assert.deepEqual(rowIds(), ["rejected-rice"], "custom end includes its entire minute");
      const label = formatDateRangeLabel(
        customDateRange(datedAt, datedAt, 12 * 60, 12 * 60),
        language,
        selected,
      );
      assert.ok(
        words(tree).includes(label),
        "active custom range visibly includes localized clocks with the dates",
      );
      if (language === "fa")
        assert.ok(!label.includes("·"), "no middle dot beside Persian digits in the Dari label");
      assert.equal(
        nodes(tree).find((node) => node.type === "Text" && words(node).includes(label))?.props
          .numberOfLines,
        2,
        "timed summaries allow two lines so the end clock is not squeezed into one line",
      );
      entries[0].created_at = datedAt + 60_000;
      find("TallyDateFilterSheet")!.props.onChange(
        customDateRange(datedAt, datedAt, 12 * 60, 12 * 60),
      );
      await flush();
      assert.deepEqual(rowIds(), [], "custom time excludes the next minute on the actual screen");
    }
  }
  entries[0].created_at = datedAt;
  find("TallyDateFilterSheet")!.props.onChange(null);
  // Audit #3: a tally just saved from this page clears an active search so it
  // shows, instead of vanishing behind the filter it does not match.
  query("no such words");
  await flush();
  justSaved = "new-entry";
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "local" }));
  await flush();
  assert.equal(find("TextInput")!.props.value, "", "the search clears for the new tally");
  query("rice 10");
  await flush();
  const searchRows = nodes(tree).filter((n) => n.type === "EntryRow");
  assert.ok(
    searchRows.length > 0 && searchRows.every((n) => n.props.showFullNote === true),
    "a note search shows whole notes, so a late match is visible (audit #3)",
  );
  assert.ok(words(tree).includes("amount:5"), "date filters keep the whole shared balance");
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    {
      gave: { count: 3, amount: 511 },
      received: { count: 1, amount: 10 },
    },
    "known pre-link handovers count once; pending, rejected/cancelled and failed intents do not count",
  );
  console.log(
    "PASS: amount search and explicit date ranges span shared, pre-link and failed tallies; selected dates survive calendar preferences",
  );

  fixture(true);
  await flush();
  query("rice");
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice", "old-rice", "failed-rice", "pre-rice"]);
  assert.ok(words(tree).includes("person.search.results:4"));
  assert.equal(
    rowIds().includes("voided-rice"),
    false,
    "cancelled originals stay hidden during search",
  );
  assert.equal(
    tallies().find((n) => n.props.entry.id === "pre-rice")?.props.onLongPress,
    undefined,
  );
  const beforeSeen = seen.length;
  link.rev = 6;
  entries.unshift(
    tally("incoming-rent", "rent", 1, 700, {
      seq: 6,
      status: "pending",
      by: "them",
      kind: "tally",
    }),
  );
  person.balance = 6;
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "pull" }));
  await flush();
  assert.equal(rowIds().includes("incoming-rent"), false);
  assert.equal(seen.length, beforeSeen, "a filtered pull cannot acknowledge unseen tallies");
  appListeners.forEach((fn) => fn("active"));
  await flush();
  assert.equal(seen.length, beforeSeen, "foreground does not acknowledge hidden search results");
  query("");
  await flush();
  assert.equal(seen.at(-1)?.rev, 6, "clearing search acknowledges the displayed revision");
  query("rice");
  await flush();
  params = { id: "person", entryId: "incoming-rent", notificationKey: "notification-1" };
  dirty = true;
  await flush();
  assert.equal(
    find("TextInput")?.props.value,
    "",
    "notification navigation clears an obstructing filter",
  );
  assert.ok(rowIds().includes("incoming-rent"));
  const scroll = find("ScrollView")!;
  scroll.props.ref.current = { scrollTo() {} };
  scroll.props.onLayout({ nativeEvent: { layout: { height: 700 } } });
  const target = tallies().find((n) => n.props.entry.id === "incoming-rent")!;
  const row = nodes(tree).find((n) => n.props.onLayout && kids(n).includes(target))!;
  const card = nodes(tree).find((n) => n.props.onLayout && kids(n).includes(row))!;
  card.props.onLayout({ nativeEvent: { layout: { y: 200 } } });
  row.props.onLayout({ nativeEvent: { layout: { y: 0, height: 60 } } });
  await flush();
  assert.ok(nodes(row).some((n) => n.type === "EntryRow"));
  assert.ok(
    nodes(tree).some((n) => n.type === "TallyHighlight"),
    "the notification target can still be highlighted",
  );
  console.log(
    "PASS: shared search includes rejected, settled, pre-link and Not sent records; filtered pulls stay unread; clearing and notification targets restore visibility",
  );

  fixture(true);
  await flush();
  assert.equal(toasts.length, 0, "cold load of reviewed history is quiet");
  const review = (status: string, local_pending = false, origin = "pull") => {
    entries = entries.map((e) =>
      e.id === "new-tea" ? { ...e, tab: { ...e.tab, status, local_pending } } : e,
    );
    tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin }));
  };
  review("accepted", true, "local");
  await flush();
  assert.equal(toasts.length, 0, "queued review is not a confirmed decision");
  review("accepted");
  await flush();
  assert.equal(toasts.at(-1)?.[0], "tab.feedback.accepted");
  assert.ok(nodes(tree).some((n) => n.type === "TallyHighlight"));
  review("accepted");
  await flush();
  assert.equal(toasts.length, 1, "repeated pull never repeats feedback");
  advance(1800);
  await flush();
  assert.equal(
    nodes(tree).some((n) => n.type === "TallyHighlight"),
    false,
  );

  fixture(true);
  await flush();
  query("rice");
  await flush();
  review("disputed");
  await flush();
  assert.equal(toasts.length, 0, "a filtered-out tally is not announced");
  query("");
  await flush();
  assert.equal(toasts.length, 0, "revealing search results does not replay a decision");

  fixture(true);
  watched.clear();
  await flush();
  assert.equal(watched.get("tab"), 1, "the shared account on screen stays on the 5 s backstop");
  review("disputed");
  await flush();
  assert.equal(toasts.at(-1)?.[0], "tab.feedback.rejected");
  blur();
  await flush();
  assert.equal(watched.get("tab"), 0, "leaving the screen releases its fast backstop");
  assert.equal(
    nodes(tree).some((n) => n.type === "TallyHighlight"),
    false,
  );
  const beforeBlur = toasts.length;
  review("pending");
  await flush();
  review("accepted");
  await flush();
  refocus();
  await flush();
  assert.equal(
    toasts.length,
    beforeBlur,
    "returning to the contact does not replay background reviews",
  );

  // Audit #13: a decision made while the phone was locked is cued once on
  // return, and an app round trip never eats the next live decision.
  fixture(true);
  await flush();
  appState = "background";
  appListeners.forEach((fn) => fn(appState));
  review("accepted");
  await flush();
  assert.equal(toasts.length, 0, "nothing is announced while the app is away");
  appState = "active";
  appListeners.forEach((fn) => fn(appState));
  await flush();
  assert.deepEqual(
    toasts.map((toast) => toast[0]),
    ["tab.feedback.accepted"],
    "the decision made while away is cued on return",
  );
  const accepted = nodes(tree).find((n) => n.type === "TallyHighlight");
  assert.equal(accepted?.props.tone, "accepted", "the flash takes the outcome's colour");
  review("accepted");
  await flush();
  assert.equal(toasts.length, 1, "and is never replayed");
  fixture(true);
  await flush();
  appState = "background";
  appListeners.forEach((fn) => fn(appState));
  appState = "active";
  appListeners.forEach((fn) => fn(appState));
  await flush();
  review("disputed");
  await flush();
  assert.equal(
    toasts.at(-1)?.[0],
    "tab.feedback.rejected",
    "the next live decision after a round trip is cued",
  );
  console.log(
    "PASS: confirmed live reviews pulse once; optimistic, hidden and cold decisions stay quiet; decisions made while away are cued on return",
  );

  // Audit #1: right after a tally is saved, the page offers the WhatsApp ping.
  fixture();
  await flush();
  const nudgeSend = () =>
    nodes(tree).find(
      (n) =>
        n.type === "Pressable" &&
        nodes(n).some((c) => c.type === "Text" && c.props.children === "person.ping.nudgeSend"),
    );
  assert.equal(nudgeSend(), undefined, "no nudge on a plain visit");
  blur();
  await flush();
  justSaved = "fresh-tally";
  refocus();
  await flush();
  assert.ok(nudgeSend(), "a new tally offers the WhatsApp ping");
  nudgeSend()!.props.onPress();
  await flush();
  assert.equal(nudgeSend(), undefined, "the nudge goes once used");
  assert.equal(shares.length, 1, "Send starts the WhatsApp ping");
  shares[0].resolve(true);
  await flush();

  fixture();
  preference = "ask";
  await flush();
  pingButton().props.onPress();
  await flush();
  const picker = find("OptionSheet")!;
  assert.equal(picker.props.visible, true);
  picker.props.onSelect("fa");
  picker.props.onSelect("en");
  await flush();
  assert.equal(timers.size, 1, "one language selection per opening");
  assert.equal(shares.length, 0, "share waits for the native language sheet to close");
  pingButton().props.onPress();
  await flush();
  assert.equal(preferenceReads, 1, "the deferred selection reserves the ping guard");
  advance(219);
  await flush();
  assert.equal(shares.length, 0);
  advance(1);
  await flush();
  assert.equal(shares.length, 1);
  assert.equal(shares[0].args[3], "fa", "the first language choice wins");
  shares[0].resolve(true);
  await flush();
  picker.props.onSelect("en");
  await flush();
  assert.equal(timers.size, 0, "an old picker callback cannot queue another reminder");
  fixture();
  preference = "ask";
  await flush();
  pingButton().props.onPress();
  await flush();
  find("OptionSheet")!.props.onSelect("fa");
  await flush();
  unmount();
  assert.equal(timers.size, 0, "leaving the person screen cancels its deferred share");
  advance(220);
  await Promise.resolve();
  assert.equal(shares.length, 0);
  fixture();
  preference = "ask";
  await flush();
  pingButton().props.onPress();
  await flush();
  find("OptionSheet")!.props.onSelect("fa");
  await flush();
  assert.equal(timers.size, 1);
  selectedCurrency = "USD";
  dirty = true;
  await flush();
  assert.equal(timers.size, 0, "switching ledger currency cancels a deferred language choice");
  advance(220);
  await flush();
  assert.equal(shares.length, 0, "an AFN reminder cannot launch after switching to USD");
  console.log(
    "PASS: real-screen language picker choice is single-use, deferred, guarded against duplicate taps and cancelled on unmount/currency change",
  );

  fixture();
  preference = "ask";
  await flush();
  pingButton().props.onPress();
  await flush();
  const departingPicker = find("OptionSheet")!;
  blur();
  await flush();
  assert.equal(find("OptionSheet")!.props.visible, false, "blur closes the language picker");
  departingPicker.props.onSelect("fa");
  await flush();
  assert.equal(timers.size, 0, "a departing picker's callback cannot queue a new reminder");
  assert.equal(shares.length, 0);

  fixture();
  await flush();
  pingButton().props.onPress();
  await flush();
  const oldPing = shares[0];
  assert.equal(oldPing.args[5].aborted, false);
  blur();
  await flush();
  assert.equal(oldPing.args[5].aborted, true, "leaving focus aborts the in-flight reminder");
  assert.equal(pingButton().props.accessibilityLabel, "person.ping.button");
  refocus();
  await flush();
  pingButton().props.onPress();
  await flush();
  assert.equal(shares.length, 2, "returning to the screen permits a new reminder");
  const newPing = shares[1];
  assert.equal(newPing.args[5].aborted, false);
  oldPing.args[4]("opening");
  oldPing.resolve(false);
  await flush();
  assert.equal(toasts.length, 0, "an aborted reminder cannot show a late error toast");
  assert.equal(pingButton().props.accessibilityLabel, "person.ping.preparing");
  assert.equal(pingButton().props.accessibilityState.busy, true);
  pingButton().props.onPress();
  await flush();
  assert.equal(shares.length, 2, "old completion must not unlock the new reminder's guard");
  newPing.resolve(true);
  await flush();
  assert.equal(pingButton().props.accessibilityLabel, "person.ping.button");

  fixture();
  await flush();
  pingButton().props.onPress();
  await flush();
  const leavingPing = shares[0];
  unmount();
  assert.equal(leavingPing.args[5].aborted, true, "unmount aborts the snapshot preparation");
  leavingPing.args[4]("opening");
  leavingPing.resolve(false);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(
    slots.length,
    0,
    "late stage/completion callbacks do not update an unmounted screen",
  );
  assert.equal(toasts.length, 0);
  console.log(
    "PASS: blur/unmount abort reminders; late stages, failures and completion cannot overwrite a newer reminder or notify a departed screen",
  );

  fixture(true);
  markers = [];
  boundaries = [];
  settlement = { count: 0, lastSettledAtMs: null };
  const shared = (
    id: string,
    amount: number,
    role: "a" | "b",
    direction: "a_to_b" | "b_to_a",
    overrides: any = {},
  ) =>
    tally(
      id,
      id,
      amount,
      300,
      { seq: 1, status: "accepted", kind: "entry", by: "them", voided: false, ...overrides },
      entryTypeFor(role, direction),
    );
  link = { ...link, tab_id: "relinked", role: "b", rev: 2 };
  entries = [
    shared("current-opening", 500, "b", "b_to_a", { kind: "opening" }),
    shared("current-received", 7, "b", "a_to_b", { seq: 2 }),
  ];
  preLink = [tally("local-before-first-link", "old local", 10, 1)];
  priorPeriods = [
    {
      link: { tab_id: "closed-a", role: "a", last_synced_at: 1 },
      entries: [
        shared("a-gave", 2, "a", "a_to_b"),
        shared("a-received", 3, "a", "b_to_a"),
        shared("old-opening", 100, "a", "a_to_b", { kind: "opening" }),
        shared("old-rejected", 800, "a", "a_to_b", { status: "disputed" }),
      ],
    },
    {
      link: { tab_id: "closed-b", role: "b", last_synced_at: 1 },
      entries: [
        shared("b-received", 4, "b", "a_to_b"),
        shared("b-gave", 5, "b", "b_to_a"),
        shared("old-voided", 300, "b", "b_to_a", { voided: true }),
      ],
    },
  ];
  person.balance = 493;
  await flush();
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    { gave: { count: 3, amount: 17 }, received: { count: 3, amount: 14 } },
    "re-link preserves known handovers from every earlier shared period with each party's perspective",
  );
  assert.deepEqual(
    rowIds(),
    ["current-opening", "current-received"],
    "earlier periods are summary-only, never injected into current money/list",
  );
  assert.ok(words(tree).includes("amount:493"), "flow history cannot change the hero balance");
  const olderCache = {
    link: { tab_id: "older-unrestored", last_synced_at: null as number | null },
    entries: [],
  };
  priorPeriods.push(olderCache);
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "pull" }));
  await flush();
  pingButton().props.onPress();
  await flush();
  assert.equal(
    shares.length,
    0,
    "A synced current ledger cannot publish a bill while an earlier empty cache is unknown",
  );
  assert.equal(toasts.at(-1)?.[0], "tab.notDownloaded");
  assert.ok(
    words(tree).includes("amount:493"),
    "Missing historical cache does not hide the known current balance",
  );
  olderCache.link.last_synced_at = 1;
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "pull" }));
  await flush();
  pingButton().props.onPress();
  await flush();
  assert.equal(shares.length, 1);
  assert.equal(
    shares[0].args[2][0].balance,
    493,
    "The bill preserves the confirmed current balance",
  );
  assert.deepEqual(
    shares[0].args[2][0].entries.map((entry: any) => entry.id),
    ["current-opening", "current-received"],
  );
  assert.deepEqual(
    shares[0].args[2][0].history.map((group: any) => [
      group.kind,
      group.entries.map((entry: any) => entry.id),
    ]),
    [
      ["pre_link", ["local-before-first-link"]],
      ["closed_shared", ["a-gave", "a-received", "old-opening", "old-rejected"]],
      ["closed_shared", ["b-received", "b-gave", "old-voided"]],
      ["closed_shared", []],
    ],
    "The sharing layer receives every historical book separately, with original review evidence for its confirmed-only filter",
  );
  assert.ok(
    shares[0].args[2][0].history.slice(1).every((group: any) => Array.isArray(group.settlements)),
    "Each earlier shared book loads its own clearance markers",
  );
  shares[0].resolve(true);
  await flush();
  let release!: (value: any[]) => void;
  historyReadGate = new Promise((resolve) => {
    release = resolve;
  });
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "pull" }));
  await flush();
  historyReadGate = null;
  priorPeriods = [];
  tabListeners.forEach((fn) => fn({ relationshipId: "relationship", origin: "pull" }));
  await flush();
  assert.deepEqual(find("TallyFlowSummary")?.props.summary, {
    gave: { count: 1, amount: 10 },
    received: { count: 1, amount: 7 },
  });
  release([{ entries: [shared("stale-gave", 9999, "a", "a_to_b")] }]);
  await flush();
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    { gave: { count: 1, amount: 10 }, received: { count: 1, amount: 7 } },
    "older deferred history cannot overwrite a newer load",
  );
  accountId = "another-account";
  dirty = true;
  await flush();
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    undefined,
    "account switch immediately gates old summary",
  );
  accountId = "account";
  vaultId = "another-vault";
  dirty = true;
  await flush();
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    undefined,
    "kaata switch immediately gates old summary",
  );
  console.log(
    "PASS: closed/relinked known flow history keeps role perspective, excludes openings/rejected/cancelled, stays outside current money and resists stale/account/kaata paints",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
