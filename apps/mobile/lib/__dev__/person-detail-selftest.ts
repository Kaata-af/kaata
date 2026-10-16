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
  "./money": money,
  "./db-tx": { getDb: () => assert.fail("Tally selection totals are already loaded") },
}) as typeof import("../selection-summary");

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
const pingButton = () => nodes(tree).find((n) => n.props.testID === "whatsapp-reminder")!;

let params: Record<string, string> = { id: "person" };
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
let priorPeriods: any[] = [],
  historyReadGate: Promise<any[]> | null = null;
let accountId = "account",
  vaultId = "vault";
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
  "../../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
  "../../lib/db": {
    getPerson: async () => person,
    listEntries: async () => [...entries],
    listArchivedSharedPeriodsForExport: async () => historyReadGate ?? priorPeriods,
    getLocalSelf: async () => ({ name: "Synthetic owner", shop_name: "Synthetic shop" }),
    getSettlementSummary: async () => settlement,
    listSettlementBoundaries: async () => boundaries,
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
    appendEntrySettled: async () => {},
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
  "../../lib/format": { formatAmount: (amount: number) => `amount:${amount}` },
  "../../lib/money": { sumAmounts },
  "../../lib/i18n": {
    getLocale: () => (rtl ? "fa" : "en"),
    getShareLangPref: async () => {
      preferenceReads++;
      return preference;
    },
    resolveShareLang: (value: string) => value,
    t: (key: string, values?: Record<string, any>) =>
      key + (values?.count == null ? "" : `:${values.count}`),
  },
  "../../lib/jalali": { formatSettlementDate: () => "fixture date" },
  "../../lib/calendar": { useCalendar: () => calendar },
  "../../lib/share": {
    shareKaataViaWhatsApp: (...args: any[]) => {
      const call: any = { args };
      shares.push(call);
      args[6]?.("preparing");
      return new Promise<boolean>((resolve) => {
        call.resolve = resolve;
      });
    },
  },
  "../../lib/tally-search": { filterTallies, noteSearchTerms },
  "../../lib/tally-date-filter": { filterTalliesByDate, formatDateRangeLabel },
  "../../lib/tally-summary": { summarizeTallyFlows },
  "../../lib/selection-summary": { summarizeSelectionEntries },
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
    getLatestTabLinkForPerson: async () => (link ? { ...link } : null),
    listPreLinkEntries: async () => [...preLink],
    listFailedTabEntries: async () => [...failed],
    listTabSettlements: async () => [...markers],
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
      ].map((name) => [name, async () => {}]),
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
        shares[0].args[3].map((e: any) => e.id),
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
  assert.equal(shares[0].args[4], "fa");
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
  assert.equal(shares[0].args[7].aborted, true, "leaving during automatic preparation aborts it");
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
    const selectionDock = nodes(tree).find(
      (node) => node.type === "AnimatedView" && nodes(node).includes(toolbar()),
    );
    assert.ok(selectionDock, "The summary lives in the bottom dock");
    assert.ok(find("TextInput"), "Search remains available while selecting tallies");
    assert.ok(
      nodes(selectionDock).indexOf(toolbar()) < nodes(selectionDock).indexOf(find("TextInput")!),
      "The selection summary sits above inline search",
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
    tallies()[0].props.onLongPress(tallies()[0].props.entry);
    await flush();
    const sheet = nodes(tree).find((node) => node.type === "BottomSheet" && node.props.visible)!;
    sheet.props.actions.find((action: any) => action.label === "selection.start").onPress();
    await flush();
    assert.equal(toolbar().props.count, 1, "selecting from a tally's options seeds that tally");
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

async function main() {
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
        dockStyle.paddingBottom + dockStyle.bottom,
        20,
        "at rest the controls stay 20pt above the safe area",
      );
      assert.equal(dockStyle.transform[0].translateY, toastOffset, "toasts still lift the dock");
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      assert.equal(find("TextInput")!.props.submitBehavior, "blurAndSubmit");
      let inputBlurs = 0;
      find("TextInput")!.props.ref.current = { blur: () => inputBlurs++ };
      find("TextInput")!.props.onFocus();
      if (p === "ios") {
        keyboardEvent("keyboardWillShow");
        await flush();
        assert.ok(
          !words(tree).includes("person.action.iGave"),
          "the dock compacts when the keyboard begins moving, not afterward",
        );
        assert.equal(scheduledKeyboardLayouts.length, 1);
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
          beforeLeavingRoute + 1,
          "returning restores the route's keyboard synchronization",
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
      assert.ok(
        typingStyle.paddingBottom + typingStyle.bottom < 20,
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
      closeEmptySearch.props.onPress();
      await flush();
      assert.equal(keyboardDismissals, beforeEmptyClose + 1);
      assert.equal(inputBlurs, beforeCloseBlurs + 1, "down releases the tally input itself");
      assert.equal(find("TextInput")!.props.value, "");
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      keyboardEvent("keyboardDidHide");
      await flush();
      const dockNodes = nodes(dock);
      assert.ok(
        dockNodes.findIndex((node) => words(node) === "person.action.iReceived") <
          dockNodes.findIndex((node) => node.type === "TextInput"),
        "search appears below I received/I gave",
      );
      const avoid = find("Keyboard")!;
      assert.equal(
        avoid.props.behavior,
        p === "android" ? "height" : "padding",
        "lower search dock stays above keyboard on both platforms",
      );
      assert.equal(
        find("ScrollView")?.props.automaticallyAdjustKeyboardInsets,
        false,
        "KAV owns keyboard avoidance; do not add duplicate automatic scroll insets",
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
      keyboardEvent("keyboardDidHide");
      await flush();
      assert.equal(
        nodes(tree).find((node) => node.props.accessibilityLabel === "common.hideKeyboard"),
        undefined,
      );
      // The dated settlement line stays between a current and a settled
      // result, so an old paid tally never reads as current (audit #3).
      assert.deepEqual(
        nodes(tree).flatMap((n) =>
          n.type === "EntryRow"
            ? [n.props.entry.id]
            : n.props?.children === "person.history.settledOn"
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
        shares[0].args[3].map((e: any) => e.id),
        entries.map((e) => e.id),
        "reminder is not narrowed by search",
      );
      assert.equal(shares[0].args[1], 3);
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
      shares[0].args[6]("opening");
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
      gave: { count: 4, amount: 516 },
      received: { count: 1, amount: 10 },
    },
    "known pre-link handovers count once; rejected/cancelled and failed intents do not count",
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
  assert.equal(shares[0].args[4], "fa", "the first language choice wins");
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
  console.log(
    "PASS: real-screen language picker choice is single-use, deferred, guarded against duplicate taps and cancelled on unmount",
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
  assert.equal(oldPing.args[7].aborted, false);
  blur();
  await flush();
  assert.equal(oldPing.args[7].aborted, true, "leaving focus aborts the in-flight reminder");
  assert.equal(pingButton().props.accessibilityLabel, "person.ping.button");
  refocus();
  await flush();
  pingButton().props.onPress();
  await flush();
  assert.equal(shares.length, 2, "returning to the screen permits a new reminder");
  const newPing = shares[1];
  assert.equal(newPing.args[7].aborted, false);
  oldPing.args[6]("opening");
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
  assert.equal(leavingPing.args[7].aborted, true, "unmount aborts the snapshot preparation");
  leavingPing.args[6]("opening");
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
      link: { tab_id: "closed-a", role: "a" },
      entries: [
        shared("a-gave", 2, "a", "a_to_b"),
        shared("a-received", 3, "a", "b_to_a"),
        shared("old-opening", 100, "a", "a_to_b", { kind: "opening" }),
        shared("old-rejected", 800, "a", "a_to_b", { status: "disputed" }),
      ],
    },
    {
      link: { tab_id: "closed-b", role: "b" },
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
    { gave: { count: 0, amount: 0 }, received: { count: 0, amount: 0 } },
    "account switch immediately gates old summary",
  );
  accountId = "account";
  vaultId = "another-vault";
  dirty = true;
  await flush();
  assert.deepEqual(
    find("TallyFlowSummary")?.props.summary,
    { gave: { count: 0, amount: 0 }, received: { count: 0, amount: 0 } },
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
