// Render the real person screen with synthetic native/storage/network edges.
// This exercises its event handlers and hooks, not Yoga or an actual WhatsApp
// launch. Fixtures are local and synthetic; no account, phone or backend is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { filterTallies, noteSearchTerms } from "../tally-search";
import type { Calendar } from "../calendar";
import { toJalali, toQamari } from "../jalali";
import { afterSharedSettlement, sharedHistory, visibleTally } from "../tabs/chapters";
import { sumAmounts } from "../money";
import { tallyScrollTarget } from "../tally-viewport";
import { compareTallyReviews } from "../tally-review-feedback";

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
  Array.isArray(n) ? n.flatMap(nodes) : n?.props ? [n, ...nodes(n.props.children)] : [];
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
const pingButton = () => nodes(tree).find((n) => n.props.testID === "whatsapp-reminder")!;

let params: Record<string, string> = { id: "person" };
let platform = "android",
  rtl = false,
  appState = "active";
let calendar: Calendar = "gregorian";
let person: any, entries: any[], preLink: any[], failed: any[], link: any;
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
const dummyError = class extends Error {};
const native: any = {
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  ScrollView: "ScrollView",
  ActivityIndicator: "Spinner",
  KeyboardAvoidingView: "Keyboard",
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
    "Chip",
    "ConfirmDialog",
    "EmptyState",
    "TallyHighlight",
    "EntryRow",
    "SharedAccountBadge",
    "LinkAccountDialog",
    "OverflowMenu",
    "OptionSheet",
  ].map((name) => [`../../components/${name}`, { [name]: name }]),
);
const mocks: Record<string, any> = {
  ...components,
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react,
  "react-native": native,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-crypto": { randomUUID: () => "uuid" },
  "expo-router": {
    useLocalSearchParams: () => params,
    useRouter: () => ({ push: (route: any) => routes.push(route), back() {} }),
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
  },
  "../../lib/attribution": { loadRelationshipAttribution: async () => new Map() },
  "../../lib/colors": require("../colors"),
  "../../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
  "../../lib/db": {
    getPerson: async () => person,
    listEntries: async () => [...entries],
    getLocalSelf: async () => ({ name: "Synthetic owner", shop_name: "Synthetic shop" }),
    getSettlementSummary: async () => settlement,
    listSettlementBoundaries: async () => boundaries,
    setAppMeta: async () => {},
    softDeleteEntry: async () => {},
    SettledChapterError: dummyError,
  },
  "../../lib/db-tx": {
    getAccountIdSync: () => "account",
    getActiveVaultIdSyncMaybe: () => "vault",
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
  "../../lib/ledger-events": { useLedgerRefresh() {} },
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
    useActiveVaultWriteCaps: () => ({ canCreate: true, canAmend: true }),
  },
  "../../lib/use-vault-summary": { useMembersCount: () => 1 },
  "../../lib/tally-viewport": { tallyScrollTarget },
  "../../lib/tally-review-feedback": { compareTallyReviews },
};
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
  params = { id: "person" };
  appState = "active";
  preference = "en";
  calendar = "gregorian";
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

async function main() {
  for (const p of ["android", "ios"])
    for (const r of [false, true]) {
      platform = p;
      rtl = r;
      fixture();
      await flush();
      const avoid = find("Keyboard")!;
      assert.equal(avoid.props.enabled, p === "android", "only Android uses KAV");
      assert.equal(find("ScrollView")?.props.automaticallyAdjustKeyboardInsets, p === "ios");
      assert.deepEqual(rowIds(), ["new-rice", "new-tea"], "settled history starts folded");
      query("rice");
      await flush();
      assert.deepEqual(rowIds(), ["new-rice", "old-rice"], "search spans settled chapters");
      assert.equal(
        tallies().find((n) => n.props.entry.id === "old-rice")?.props.onLongPress,
        undefined,
      );
      assert.ok(tallies().find((n) => n.props.entry.id === "new-rice")?.props.onLongPress);
      assert.ok(words(tree).includes("amount:3"), "search does not narrow the hero balance");
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
      assert.equal(words(tree).includes("person.ping.preparing"), false, "no loading text above the page");
      assert.ok(nodes(pingButton()).some((n) => n.type === "Spinner"), "the reminder button shows its spinner");
      shares[0].args[6]("opening");
      await flush();
      assert.equal(pingButton().props.accessibilityLabel, "person.ping.opening");
      assert.equal(words(tree).includes("person.ping.opening"), false, "opening uses only the spinner visually");
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

  fixture(true);
  const datedAt = new Date(2026, 9, 11, 12).getTime();
  entries[0].created_at = datedAt;
  await flush();
  query("rice 99");
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "note and amount terms combine on the real screen");
  query("۵۰۰");
  await flush();
  assert.deepEqual(rowIds(), ["pre-rice"], "numeric search includes pre-link tallies and Persian digits");
  query("7");
  await flush();
  assert.deepEqual(rowIds(), ["failed-rice"], "numeric search includes not-sent tallies");
  query("2026");
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "Gregorian year matches the tally date");
  calendar = "jalali";
  dirty = true;
  await flush();
  assert.deepEqual(rowIds(), [], "changing calendar re-evaluates the existing date filter");
  const j = toJalali(datedAt);
  query(`${j.jy}/${j.jm}/${j.jd}`);
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "the selected Shamsi date is searchable");
  calendar = "qamari";
  rtl = true;
  dirty = true;
  await flush();
  assert.deepEqual(rowIds(), [], "a Shamsi numeric date does not silently match Qamari");
  const q = toQamari(datedAt);
  query(`${q.hy}/${q.hm}/${q.hd}`.replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]));
  await flush();
  assert.deepEqual(rowIds(), ["rejected-rice"], "the selected Qamari date works in Dari digits");
  assert.ok(words(tree).includes("amount:5"), "date filters keep the whole shared balance");
  console.log("PASS: amount/date search spans shared, pre-link and failed tallies and refreshes with calendar preferences");

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
  await flush();
  review("disputed");
  await flush();
  assert.equal(toasts.at(-1)?.[0], "tab.feedback.rejected");
  blur();
  await flush();
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

  fixture(true);
  await flush();
  appState = "background";
  appListeners.forEach((fn) => fn(appState));
  review("accepted");
  await flush();
  appState = "active";
  appListeners.forEach((fn) => fn(appState));
  review("accepted");
  await flush();
  assert.equal(toasts.length, 0, "foreground resumption starts a fresh baseline");
  console.log(
    "PASS: confirmed live reviews pulse once; optimistic, hidden, cold and background decisions stay quiet",
  );

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
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
