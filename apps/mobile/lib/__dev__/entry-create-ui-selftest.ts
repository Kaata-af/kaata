// Execute the real entry modal with controlled native/session/storage edges.
// Delayed admissions remain durable; feedback belongs only to its tap's screen.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { normalizeAmountInput, parseAmountInput } from "../money";
import { ENTRY_NOTE_MAX_LENGTH } from "../types";
import { calculatorDraft, calculatorKey } from "../calculator-input";
import { ltrIsolate } from "../bidi";
import { EntryCurrencyBaselineRequiredError } from "../projection/errors";
import type { Entry } from "../types";

type PlatformOS = "android" | "ios";
const safeAreaInsets = { top: 0, left: 0, right: 0, bottom: 34 };
const fontEdges = Object.fromEntries(
  (["android", "ios"] as const).map((os) => [
    os,
    compileUI("../fonts", {
      "react-native": { Platform: { OS: os } },
      "@expo-google-fonts/inter": {},
      "@expo-google-fonts/jetbrains-mono": {},
      "@expo-google-fonts/vazirmatn": {},
    }),
  ]),
);
const directionEdges = (rtl: boolean) => ({
  ltrIsolate,
  useIsRTL: () => rtl,
  textDir: () => ({ textAlign: rtl ? "right" : "left", writingDirection: rtl ? "rtl" : "ltr" }),
  rowDir: () => ({ flexDirection: rtl ? "row-reverse" : "row" }),
  trackingSafe: () => ({}),
});

class SessionChangedError extends Error {}
class RoleGateRejectionError extends Error {}
class EventSigningUnavailableError extends Error {}
class SettledChapterError extends Error {}
class TabLinkedEntryError extends Error {}
class EntryEditChangedError extends Error {}
class EntryEditCurrencyDisabledError extends Error {}
class TabAuthUnavailableError extends Error {}
class TabClosedError extends Error {}
class TabInputError extends Error {}
class TabPermissionError extends Error {}
class TabApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
type Saved = {
  entry_id: string;
  duplicate_hint: object | null;
  admission_status?: "pending" | "refused";
  credit_warning?: boolean;
};
const normal: Saved = { entry_id: "entry", duplicate_hint: null };
let fixtureSequence = 0;
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string"
      ? node
      : node?.props
        ? words(node.props.children)
        : "";

const currencyMetadata = compileUI("../currency", {
  react: {},
  "./currency-scope": require("../currency-scope"),
  "./currency-settings": require("../currency-settings"),
  "./currency-catalog": require("../currency-catalog"),
  "./db": {},
  "./db-tx": {},
  "./i18n": { getLocale: () => "en" },
}) as typeof import("../currency");

function fixture({
  os = "android",
  rtl = false,
  nativeEdgeToEdge = true,
  statusBarHeight = 32,
  width = 390,
  height = 844,
  fontScale = 1,
  initialLedgerCurrency = "AFN",
  bookCurrency = "AFN",
  personCurrency = null,
  enabledCurrencies = ["AFN", "USD", "EUR"],
  editingEntry,
}: {
  os?: PlatformOS;
  rtl?: boolean;
  nativeEdgeToEdge?: boolean | "unknown";
  statusBarHeight?: number | null;
  width?: number;
  height?: number;
  fontScale?: number;
  initialLedgerCurrency?: string;
  bookCurrency?: string;
  personCurrency?: string | null;
  enabledCurrencies?: string[];
  editingEntry?: Entry;
} = {}) {
  const screenId = `entry-fixture-${++fixtureSequence}`;
  let selectedCurrency = initialLedgerCurrency;
  let defaultCurrencyGate: ReturnType<typeof deferred<string>> | null = null;
  let enabledCurrencyGate: ReturnType<typeof deferred<string[]>> | null = null;
  const ledgerListeners = new Set<(vaultId: string) => void>();
  const defaultCurrencyReads: (string | null)[] = [];
  const personCurrencyReads: [string, string][] = [];
  let personCurrencyGate: ReturnType<typeof deferred<string | null>> | null = null;
  const hooks = uiHooks(),
    routes: any[] = [],
    notices: any[] = [],
    queued: any[] = [],
    writes: any[] = [],
    creditChecks: any[] = [];
  let params = { personId: "customer", type: "debt" },
    account: string | null = "account",
    vault: string | null = "vault",
    install = "install",
    sessionVersion = 1;
  let active = true,
    focusStart: (() => void | (() => void)) | undefined,
    focusCleanup: (() => void) | undefined;
  let result: Saved = normal,
    saveError: Error | null = null;
  let saveGate: ReturnType<typeof deferred<Saved>> | null = null;
  let guardGate: ReturnType<typeof deferred<any>> | null = null;
  let captureGate: ReturnType<typeof deferred<void>> | null = null;
  let duplicateGate: ReturnType<typeof deferred<any>> | null = null;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  let onEndScroll: (() => void) | undefined;
  const scrolls: any[] = [],
    endScrolls: any[] = [];
  const keyboardEvents = new Map<string, Set<() => void>>();
  const backHandlers = new Set<() => boolean>();
  let nativeFocus: "amount" | "note" | null = null;
  let timerID = 0,
    keyboardFocuses = 0,
    keyboardDismissals = 0,
    amountBlurs = 0,
    noteBlurs = 0,
    noteFocuses = 0,
    overLimit = false;
  const currencyEdges = {
    DEFAULT_CURRENCY: "AFN",
    getCurrentCurrencyCode: () => selectedCurrency,
    getDefaultEntryCurrency: async (vaultId: string) => {
      defaultCurrencyReads.push(vaultId);
      const gate = defaultCurrencyGate;
      defaultCurrencyGate = null;
      return gate ? gate.promise : bookCurrency;
    },
    getEnabledCurrencies: async () => {
      const gate = enabledCurrencyGate;
      enabledCurrencyGate = null;
      return gate ? gate.promise : enabledCurrencies;
    },
    getCurrencyLabel: (code: string) => code,
    currencyNeedsPrecisionHint: currencyMetadata.currencyNeedsPrecisionHint,
    setCurrentCurrency: (code: string) => {
      selectedCurrency = code;
    },
  };
  const personCurrencyEdges = compileUI("../person-currency", {
    "./auth": {},
    "./db-tx": {
      getDb: async () => ({
        getAllAsync: async () => [],
        getFirstAsync: async (_sql: string, requestedVault: string, requestedPerson: string) => {
          personCurrencyReads.push([requestedVault, requestedPerson]);
          const gate = personCurrencyGate;
          personCurrencyGate = null;
          return {
            id: "relationship",
            default_entry_currency: gate ? await gate.promise : personCurrency,
          };
        },
      }),
    },
    "./currency-scope": require("../currency-scope"),
    "./event-log": {},
    "./projection": { applyEventMutex: { runExclusive: (work: () => Promise<unknown>) => work() } },
    "./currency": currencyEdges,
  });
  const Screen = compileUI(
    "../../app/entry/new",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: { ...hooks.react, useId: () => screenId },
      "expo-router": {
        useRouter: () => ({
          back: () => routes.push("back"),
          replace: (to: any) => routes.push(to),
        }),
        useLocalSearchParams: () => params,
        useFocusEffect: (fn: () => void | (() => void)) =>
          hooks.react.useEffect(() => {
            focusStart = fn;
            if (active) focusCleanup = fn() || undefined;
            return () => {
              focusCleanup?.();
              focusCleanup = undefined;
            };
          }, [fn]),
      },
      "react-native": {
        Keyboard: {
          dismiss: () => {
            keyboardDismissals++;
            nativeFocus = null;
          },
          addListener: (event: string, handler: () => void) => {
            const handlers = keyboardEvents.get(event) ?? new Set();
            keyboardEvents.set(event, handlers);
            handlers.add(handler);
            return { remove: () => handlers.delete(handler) };
          },
        },
        BackHandler: {
          addEventListener: (_event: string, handler: () => boolean) => {
            backHandlers.add(handler);
            return { remove: () => backHandlers.delete(handler) };
          },
        },
        InputAccessoryView: "InputAccessoryView",
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: os },
        StatusBar: { currentHeight: statusBarHeight ?? undefined },
        TurboModuleRegistry: {
          get: (name: string) => {
            assert.equal(name, "DeviceInfo");
            assert.equal(os, "android", "iOS does not need Android window coordinates");
            return {
              getConstants: () =>
                nativeEdgeToEdge === "unknown" ? {} : { isEdgeToEdge: nativeEdgeToEdge },
            };
          },
        },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
        useWindowDimensions: () => ({ width, height, fontScale, scale: 3 }),
      },
      "@expo/vector-icons": { Ionicons: "Ionicon" },
      "react-native-safe-area-context": {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => safeAreaInsets,
      },
      "../../components/Button": { Button: "Button" },
      "../../components/EntryCalculator": { EntryCalculator: "EntryCalculator" },
      "../../components/EntryDateField": { EntryDateField: "EntryDateField" },
      "../../components/CurrencySelector": { CurrencySelector: "CurrencySelector" },
      "../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
      "../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
      "../../components/Toast": {
        useToast: () => ({ push: (...args: any[]) => notices.push(args) }),
        queuePendingToast: (...args: any[]) => queued.push(args),
      },
      "../../lib/colors": { colors: require("../colors").colors },
      "../../lib/auth": {
        SessionChangedError,
        captureCurrentSession: async () => {
          const snapshot = { bindingVersion: sessionVersion, jwt: "session", accountId: account };
          if (captureGate) await captureGate.promise;
          return snapshot;
        },
        applyForUnchangedLocalSession: async (snapshot: any, work: () => Promise<any>) => {
          if (snapshot.bindingVersion !== sessionVersion || snapshot.accountId !== account)
            throw new SessionChangedError();
          return work();
        },
      },
      "../../lib/db-tx": {
        getAccountIdSync: () => account,
        getActiveVaultIdSyncMaybe: () => vault,
        getInstallIdSync: () => install,
      },
      "../../lib/currency": currencyEdges,
      "../../lib/person-currency": personCurrencyEdges,
      "../../lib/ledger-events": {
        onLedgerApplied: (listener: (vaultId: string) => void) => {
          ledgerListeners.add(listener);
          return () => ledgerListeners.delete(listener);
        },
      },
      "../../lib/db": {
        SettledChapterError,
        TabLinkedEntryError,
        EntryEditChangedError,
        EntryEditCurrencyDisabledError,
        updateEntry: async (...args: any[]) => {
          writes.push(args);
          if (saveGate) await saveGate.promise;
          if (saveError) throw saveError;
        },
        getActiveVaultArchivedState: async () => {
          const gate = guardGate;
          guardGate = null;
          return gate ? gate.promise : { state: "active" };
        },
        getPerson: async (id: string) => ({ id, name: `Customer:${id}`, balance: 0 }),
        createEntryDetailed: async (...args: any[]) => {
          writes.push(args);
          if (saveGate) return saveGate.promise;
          if (saveError) throw saveError;
          return result;
        },
      },
      "../../lib/direction": directionEdges(rtl),
      "../../lib/event-log": { EventSigningUnavailableError, RoleGateRejectionError },
      "../../lib/projection/errors": { EntryCurrencyBaselineRequiredError },
      "../../lib/fonts": fontEdges[os],
      "../../lib/i18n": { t: (key: string) => key },
      "../../lib/entry-date": require("../entry-date"),
      "../../lib/tally-date-filter": require("../tally-date-filter"),
      "../../lib/money": { normalizeAmountInput, parseAmountInput },
      "../../lib/calculator": require("../calculator"),
      "../../lib/calculator-input": require("../calculator-input"),
      "../../lib/credit-limits": {
        creditWarningForEdit: async (...args: any[]) => {
          creditChecks.push(args);
          return overLimit;
        },
        creditWarning: async (...args: any[]) => {
          creditChecks.push(args);
          return overLimit;
        },
      },
      "../../lib/recent-entry": {
        noteSavedEntry: (personId: string, entryId: string) => savedNotes.push([personId, entryId]),
      },
      "../../lib/tabs/db": {
        getTabLinkForPerson: async () =>
          duplicateGate ? duplicateGate.promise : { other_label: "Peer" },
      },
      "../../lib/tabs/errors": {
        TabAuthUnavailableError,
        TabApiError,
        TabClosedError,
        TabInputError,
        TabPermissionError,
      },
      "../../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
      "../../lib/types": { ENTRY_NOTE_MAX_LENGTH },
    },
    {
      setTimeout: (fn: () => void) => {
        const id = ++timerID;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
      requestAnimationFrame: (fn: () => void) => {
        const id = ++timerID;
        frames.set(id, fn);
        return id;
      },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    },
  ).default;
  const render = () =>
    hooks.render(() =>
      Screen({ editingEntry, editPersonId: editingEntry ? params.personId : undefined }),
    );
  const accessory = () => nodes(hooks.tree).find((n) => n.type === "InputAccessoryView");
  const accessoryButton = () =>
    nodes(accessory()).find(
      (n) =>
        n.type === "Button" &&
        n.props.label === (editingEntry ? "entry.saveChanges" : "entry.save"),
    );
  const bodyButton = () =>
    nodes(nodes(hooks.tree).find((n) => n.type === "KeyboardAvoidingView")).find(
      (n) =>
        n.type === "Button" &&
        n.props.label === (editingEntry ? "entry.saveChanges" : "entry.save"),
    );
  const button = () => (bodyButton() ?? accessoryButton())!;
  const input = () => nodes(hooks.tree).find((n) => n.type === "TextInput")!;
  const note = () =>
    nodes(hooks.tree).find(
      (n) => n.type === "TextInput" && n.props.accessibilityLabel === "entry.note.label",
    )!;
  const calculator = () => nodes(hooks.tree).find((n) => n.type === "EntryCalculator");
  const noteField = () =>
    nodes(hooks.tree).find((n) => n.type === "View" && [n.props.children].flat().includes(note()))!;
  const keyboardFrame = () =>
    nodes(hooks.tree).find(
      (n) => n.type === "View" && n.props.ref && n.props.collapsable === false,
    )!;
  const openCalculator = () => {
    input().props.onPressIn();
    render();
  };
  const flush = async () => {
    await settleUI();
    render();
  };
  async function ready() {
    render();
    await flush();
    if (!editingEntry) input().props.onChangeText("125.50");
    render();
    input().props.ref.current = {
      focus: () => {
        if (nativeFocus === "amount") return;
        nativeFocus = "amount";
        keyboardFocuses++;
        input().props.onFocus?.();
      },
      blur: () => {
        amountBlurs++;
        if (nativeFocus === "amount") nativeFocus = null;
      },
    };
    note().props.ref.current = {
      blur: () => {
        noteBlurs++;
        if (nativeFocus === "note") nativeFocus = null;
      },
      focus: () => {
        if (nativeFocus === "note") return;
        nativeFocus = "note";
        noteFocuses++;
        note().props.onFocus?.();
      },
    };
    nodes(hooks.tree).find((n) => n.type === "ScrollView")!.props.ref.current = {
      scrollTo: (options: any) => scrolls.push(options),
      scrollToEnd: (options: any) => {
        endScrolls.push(options);
        onEndScroll?.();
      },
    };
    nodes(hooks.tree)
      .find(
        (n) => n.type === "View" && !n.props.ref && n.props.onLayout && nodes(n).includes(input()),
      )!
      .props.onLayout({ nativeEvent: { layout: { x: 0, y: 96, width: 358, height: 148 } } });
    nodes(hooks.tree)
      .find((n) => n.type === "ScrollView")!
      .props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 500 } },
      });
    noteField().props.onLayout?.({
      nativeEvent: { layout: { x: 0, y: 264, width: 358, height: 146 } },
    });
  }
  const blur = () => {
    active = false;
    focusCleanup?.();
    focusCleanup = undefined;
  };
  const refocus = () => {
    active = true;
    focusCleanup = focusStart?.() || undefined;
    render();
  };
  const transitions = {
    blur,
    unmount: () => {
      blur();
      hooks.unmount();
    },
    account: () => {
      account = "different-account";
      render();
    },
    vault: () => {
      vault = "different-vault";
      render();
    },
    person: () => {
      params = { ...params, personId: "different-customer" };
      render();
    },
    type: () => {
      params = { ...params, type: "payment" };
      render();
    },
    install: () => {
      install = "different-install";
      render();
    },
    session: () => {
      sessionVersion++;
    },
    refocus: () => {
      blur();
      refocus();
    },
  };
  return {
    hooks,
    routes,
    notices,
    queued,
    writes,
    creditChecks,
    defaultCurrencyReads,
    personCurrencyReads,
    setPersonCurrency: (code: string | null) => {
      personCurrency = code;
    },
    delayedPersonCurrency: () => (personCurrencyGate = deferred<string | null>()),
    delayedDefaultCurrency: () => (defaultCurrencyGate = deferred<string>()),
    delayedEnabledCurrencies: () => (enabledCurrencyGate = deferred<string[]>()),
    setEnabledCurrencies: (codes: string[]) => {
      enabledCurrencies = codes;
    },
    emitLedger: (vaultId = vault ?? "") => ledgerListeners.forEach((listener) => listener(vaultId)),
    get selectedCurrency() {
      return selectedCurrency;
    },
    render,
    flush,
    ready,
    button,
    bodyButton,
    accessory,
    accessoryButton,
    input,
    note,
    openCalculator,
    calculator,
    noteField,
    keyboardFrame,
    scrolls,
    endScrolls,
    blur,
    refocus,
    transitions,
    delayedSave: () => (saveGate = deferred<Saved>()),
    delayedGuard: () => (guardGate = deferred<any>()),
    delayedCapture: () => (captureGate = deferred<void>()),
    delayedDuplicate: () => (duplicateGate = deferred<any>()),
    setResult: (next: Saved) => {
      saveGate = null;
      result = next;
    },
    setError: (next: Error) => {
      saveError = next;
    },
    fireKeyboardTimers: () => [...timers.values()].forEach((fn) => fn()),
    noteFrames: () => [...frames.values()],
    fireNoteFrames: () => {
      for (const [id, fn] of [...frames.entries()]) {
        frames.delete(id);
        fn();
      }
    },
    onEndScroll: (callback: () => void) => {
      onEndScroll = callback;
    },
    emitKeyboard: (event: string) => keyboardEvents.get(event)?.forEach((handler) => handler()),
    hardwareBack: () => [...backHandlers].reverse().some((handler) => handler()),
    nativeHandlers: () => [...keyboardEvents.values()].flatMap((handlers) => [...handlers]),
    get nativeSubscriptions() {
      return (
        [...keyboardEvents.values()].reduce((count, handlers) => count + handlers.size, 0) +
        backHandlers.size
      );
    },
    setOverLimit: (value: boolean) => {
      overLimit = value;
    },
    resizeWindow: (nextWidth: number, nextHeight: number, nextFontScale = fontScale) => {
      width = nextWidth;
      height = nextHeight;
      fontScale = nextFontScale;
      render();
    },
    get keyboardFocuses() {
      return keyboardFocuses;
    },
    get keyboardDismissals() {
      return keyboardDismissals;
    },
    get amountBlurs() {
      return amountBlurs;
    },
    get noteBlurs() {
      return noteBlurs;
    },
    get noteFocuses() {
      return noteFocuses;
    },
  };
}

// Exercise the shared form through its edit mode with the same native edges.
function editFixture(
  os: PlatformOS,
  rtl: boolean,
  initialNote: string,
  entryCurrency = "AFN",
  enabledCurrencies?: string[],
) {
  return fixture({
    os,
    rtl,
    ...(enabledCurrencies ? { enabledCurrencies } : {}),
    editingEntry: {
      id: "entry",
      relationship_id: "relationship",
      type: "debt",
      amount_afn: 125.5,
      currency: entryCurrency,
      note: initialNote,
      created_at: new Date(2025, 5, 20, 15, 7, 12, 345).getTime(),
      updated_at: 10,
    } as Entry,
  });
}

function assertMultilineForm(
  form: Pick<ReturnType<typeof fixture>, "hooks" | "input" | "note" | "button" | "writes">,
  os: PlatformOS,
  rtl: boolean,
  stickySave = false,
) {
  const note = form.note(),
    amount = form.input();
  assert.equal(note.props.multiline, true);
  assert.equal(note.props.submitBehavior, "newline");
  assert.equal(note.props.onSubmitEditing, undefined, "Return must never invoke Save");
  assert.notEqual(note.props.returnKeyType, "done");
  assert.notEqual(note.props.blurOnSubmit, true);
  assert.equal(note.props.scrollEnabled, true);
  assert.equal(note.props.maxLength, ENTRY_NOTE_MAX_LENGTH);
  assert.equal(ENTRY_NOTE_MAX_LENGTH, 500, "the fixture must use the real storage limit");
  let noteFocuses = 0;
  note.props.ref.current = { focus: () => noteFocuses++ };
  assert.equal(amount.props.returnKeyType, "next");
  assert.equal(amount.props.submitBehavior, "submit");
  amount.props.onSubmitEditing();
  assert.equal(noteFocuses, 1, "Amount Next focuses Note");
  assert.equal(form.writes.length, 0, "moving between fields never saves");

  const style = flattenStyle(note.props.style);
  assert.ok(Number.isFinite(style.minHeight) && style.minHeight > 0);
  assert.ok(Number.isFinite(style.maxHeight) && style.maxHeight >= style.minHeight);
  if (stickySave && os === "ios")
    assert.ok(
      Number.isFinite(style.height) && style.height >= style.minHeight,
      "iOS Add keeps a stable, readable note viewport",
    );
  else assert.equal(style.height, undefined, "the textarea can grow before scrolling");
  assert.equal(style.textAlignVertical, "top");
  assert.ok(style.paddingVertical > 0 && style.paddingHorizontal > 0);
  assert.equal(
    style.lineHeight,
    os === "ios" ? 24 : 22,
    "the real font helper keeps iOS ascenders inside the line box",
  );
  assert.ok(
    style.minHeight >= 3 * style.lineHeight + 2 * style.paddingVertical + 2 * style.borderWidth,
    "the textarea initially fits three complete lines without clipping padding or borders",
  );
  assert.equal(style.textAlign, rtl ? "right" : "left");
  assert.equal(style.writingDirection, rtl ? "rtl" : "ltr");

  const avoider = nodes(form.hooks.tree).find((node) => node.type === "KeyboardAvoidingView")!;
  const scroll = nodes(avoider).find((node) => node.type === "ScrollView")!;
  assert.ok(scroll, "form scrolls within its keyboard-aware viewport");
  assert.equal(avoider.props.behavior, "height");
  if (stickySave) {
    assert.equal(
      avoider.props.enabled,
      os === "android",
      "iOS Save uses its native keyboard accessory instead of measured avoidance",
    );
    assert.equal(
      scroll.props.automaticallyAdjustKeyboardInsets,
      os === "ios",
      "iOS keeps Note visible with native keyboard insets",
    );
  } else {
    assert.equal(avoider.props.enabled, os === "android");
    assert.equal(scroll.props.automaticallyAdjustKeyboardInsets, os === "ios");
  }
  assert.equal(scroll.props.keyboardShouldPersistTaps, "handled");
  assert.ok(nodes(scroll).includes(note), "the multiline Note stays in the scrollable form");
  assert.equal(
    nodes(scroll).includes(form.button()),
    !stickySave,
    stickySave ? "Save stays outside every form scroll" : "Edit keeps its existing scrollable Save",
  );
  assert.ok(
    nodes(avoider).includes(form.button()),
    "Save stays inside the keyboard-aware viewport",
  );
  assert.equal(
    flattenStyle(scroll.props.contentContainerStyle).flexGrow,
    stickySave ? undefined : 1,
    "the Add form must not stretch empty content beneath native keyboard insets",
  );
}

const layoutEvent = (height: number, width = 390) => ({
  nativeEvent: { layout: { x: 0, y: 0, width, height } },
});

const savedNotes: [string, string][] = [];
async function main() {
  let cases = 0;
  for (const os of ["android", "ios"] as const) {
    const f = editFixture(os, true, "Existing note", "USD");
    await f.ready();
    assert.equal(f.input().props.value, "125.5", "Edit starts with the stored amount");
    assert.equal(f.input().props.showSoftInputOnFocus, false);
    assert.equal(f.input().props.inputMode, "none", "Edit never opens the decimal keypad");
    f.openCalculator();
    const keypad = f.calculator()!;
    assert.equal(keypad.props.visible, true);
    keypad.props.onChange(calculatorDraft("125.5+24.5"));
    f.render();
    keypad.props.onNext();
    f.render();
    assert.equal(f.calculator()!.props.visible, false, "Next hands off to Note");
    assert.equal(f.noteFocuses, 1);
    assert.equal(f.writes.length, 0);
    f.emitKeyboard("keyboardDidShow");
    f.render();
    f.fireNoteFrames();
    f.fireNoteFrames();
    assert.equal(f.endScrolls.length, 1, "Edit reveals Note once after its keyboard arrives");
    assert.equal(f.calculator()!.props.visible, false);
    await f.button().props.onPress();
    assert.deepEqual(f.writes[0].slice(0, 3), ["entry", 150, "Existing note"]);
    assert.equal(
      f.writes[0][3],
      new Date(2025, 5, 20, 15, 7, 12, 345).getTime(),
      "Ordinary edits preserve the exact timestamp",
    );
    assert.equal(f.selectedCurrency, "AFN", "An edit does not change the currently viewed ledger");
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
    cases++;

    for (const error of [
      new SettledChapterError(),
      new TabLinkedEntryError(),
      new RoleGateRejectionError(),
      new EventSigningUnavailableError(),
      new EntryEditChangedError(),
      new EntryEditCurrencyDisabledError(),
      new EntryCurrencyBaselineRequiredError("entry"),
      Object.assign(new Error(), { name: "CreditMutationAdmissionError", status: "pending" }),
      Object.assign(new Error(), { name: "CreditMutationAdmissionError", status: "refused" }),
    ]) {
      const failed = editFixture(os, false, "unchanged");
      await failed.ready();
      failed.setError(error);
      await failed.button().props.onPress();
      failed.render();
      const expected =
        error instanceof SettledChapterError
          ? "entry.settledLocked"
          : error instanceof TabLinkedEntryError
            ? "tab.editLocked"
            : error instanceof RoleGateRejectionError
              ? "entry.roleDenied"
              : error instanceof EntryCurrencyBaselineRequiredError
                ? "entry.currency.needsSync"
                : error instanceof EntryEditChangedError
                  ? "entry.edit.changed"
                  : error instanceof EntryEditCurrencyDisabledError
                    ? "entry.currency.disabled"
                    : error instanceof EventSigningUnavailableError
                      ? "entry.signingUnavailable"
                      : (error as Error & { status: string }).status === "pending"
                        ? "credit.pendingChange"
                        : "credit.refusedChange";
      assert.ok(words(failed.hooks.tree).includes(expected));
      assert.deepEqual(failed.routes, [], "A failed edit stays open with its draft");
      assert.equal(failed.note().props.value, "unchanged");
      failed.hooks.unmount();
      cases++;
    }
  }
  for (const os of ["android", "ios"] as const)
    for (const currencyCode of ["AFN", "KWD"])
      for (const mode of ["create", "edit"] as const) {
        const f =
          mode === "create"
            ? fixture({
                os,
                bookCurrency: currencyCode,
                enabledCurrencies: [currencyCode],
                initialLedgerCurrency: currencyCode === "KWD" ? "AFN" : "KWD",
              })
            : editFixture(os, false, "", currencyCode);
        await f.ready();
        const precisionNotes = () =>
          nodes(f.hooks.tree).filter(
            (node) => node.type === "Text" && words(node) === "currency.precisionHint",
          );
        assert.equal(
          precisionNotes().length,
          currencyCode === "KWD" ? 1 : 0,
          `${mode}/${os}: precision guidance follows the form's denomination independently of the selected ledger`,
        );
        f.input().props.onChangeText("1.234");
        f.render();
        assert.equal(f.input().props.value, "1.234", "input retains the original precision");
        await f.button().props.onPress();
        await settleUI();
        f.render();
        if (mode === "create") {
          assert.ok(words(f.hooks.tree).includes("calculator.rounded"));
          assert.equal(f.writes[0][2], 1.23, "calculator applies its displayed two-decimal result");
          assert.equal(f.writes[0][4].currency, currencyCode);
        } else {
          assert.ok(words(f.hooks.tree).includes("calculator.rounded"));
          assert.equal(f.writes[0][1], 1.23, "Edit saves the same displayed result as Add");
          assert.equal(precisionNotes().length, currencyCode === "KWD" ? 1 : 0);
        }
        f.hooks.unmount();
        cases++;
      }
  {
    const hooks = uiHooks(),
      changes: string[] = [];
    let allowed = ["AFN", "USD"],
      disabled = false,
      readOnly = false;
    const symbols: Record<string, string> = { AFN: "؋", USD: "$", EUR: "€" };
    const Picker = compileUI("../../components/CurrencySelector", {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        View: "View",
        Text: "Text",
        Pressable: "Pressable",
        StyleSheet: { create: (styles: any) => styles },
      },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "../lib/currency": {
        CURRENCIES: Object.keys(symbols).map((code) => ({ code, symbol: symbols[code] })),
        getCurrencySymbol: (code: string) => symbols[code] ?? code,
        getCurrencyName: (code: string) => code,
        getCurrencyLabel: (code: string) => `${code} ${symbols[code] ?? code}`,
      },
      "../lib/colors": { colors: require("../colors").colors },
      "../lib/direction": directionEdges(true),
      "../lib/fonts": {
        fonts: { sansRegular: "Regular", sansMedium: "Medium" },
        sansLineHeight: (_size: number, tight: number) => tight,
      },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/tokens": { radius: { sm: 8, pill: 20 }, TOUCH_MIN: 44, typography: {} },
      "./OptionSheet": { OptionSheet: "OptionSheet" },
    });
    const render = () =>
      hooks.render(() =>
        Picker.CurrencySelector({
          compact: true,
          symbolOnly: true,
          value: "USD",
          allowedCurrencies: allowed,
          disabled,
          onChange: readOnly ? undefined : (code: string) => changes.push(code),
        }),
      );
    const sheet = () => nodes(hooks.tree).find((node) => node.type === "OptionSheet")!;
    render();
    const trigger = nodes(hooks.tree).find((node) => node.type === "Pressable")!;
    assert.equal(
      words(trigger),
      "$",
      "Result control shows the selected sign without a separate field label",
    );
    assert.deepEqual(trigger.props.accessibilityValue, { text: "USD $" });
    assert.equal(flattenStyle(trigger.props.style({ pressed: false })).direction, "ltr");
    assert.equal(flattenStyle(trigger.props.style({ pressed: false })).minHeight, 44);
    trigger.props.onPress();
    render();
    assert.equal(sheet().props.visible, true);
    assert.deepEqual(
      sheet().props.options.map((option: any) => option.key),
      ["AFN", "USD"],
      "Picker shows only this Kaata's enabled currencies",
    );
    const retainedSelect = sheet().props.onSelect;
    allowed = ["AFN"];
    render();
    assert.deepEqual(
      sheet().props.options.map((option: any) => option.key),
      ["AFN"],
      "A disabled current value is not reinserted into picker options",
    );
    retainedSelect("USD");
    assert.deepEqual(changes, []);
    sheet().props.onSelect("AFN");
    assert.deepEqual(changes, ["AFN"]);
    disabled = true;
    render();
    retainedSelect("AFN");
    assert.deepEqual(changes, ["AFN"]);
    readOnly = true;
    disabled = false;
    render();
    assert.equal(sheet(), undefined, "Immutable saved currencies have no picker");
    readOnly = false;
    allowed = ["USD", "USD"];
    render();
    assert.equal(sheet(), undefined, "One distinct enabled currency has no picker");
    assert.equal(
      nodes(hooks.tree).some((node) => node.type === "Pressable"),
      false,
      "The sole currency is a static label instead of an inactive selector",
    );
    assert.ok(words(hooks.tree).includes("$"), "The sole currency sign remains visible");
    trigger.props.onPress();
    retainedSelect("USD");
    render();
    assert.equal(sheet(), undefined, "Retained callbacks cannot reopen a single-currency picker");
    assert.deepEqual(
      changes,
      ["AFN"],
      "Collapsing to one currency never changes the amount's denomination",
    );
    allowed = ["USD", "EUR"];
    render();
    nodes(hooks.tree)
      .find((node) => node.type === "Pressable")!
      .props.onPress();
    render();
    assert.equal(
      sheet().props.visible,
      true,
      "The selector returns when another currency is enabled",
    );
    hooks.unmount();
    cases++;
  }
  const currencyField = (form: { hooks: ReturnType<typeof uiHooks> }) =>
    nodes(form.hooks.tree).find((node) => node.type === "CurrencySelector")!;
  for (const os of ["android", "ios"] as const) {
    const form = fixture({ os });
    await form.ready();
    assert.equal(
      currencyField(form).props.value,
      "AFN",
      "new tally starts in the kaata's default currency",
    );
    form.openCalculator();
    currencyField(form).props.onOpen();
    form.render();
    assert.equal(
      form.calculator()!.props.visible,
      false,
      "currency selection releases the amount keypad",
    );
    currencyField(form).props.onChange("USD");
    form.render();
    assert.equal(currencyField(form).props.value, "USD");
    assert.equal(
      form.selectedCurrency,
      "AFN",
      "Choosing a tally currency does not change the ledger view",
    );
    assert.equal(currencyField(form).props.compact, true);
    assert.equal(currencyField(form).props.symbolOnly, true);
    assert.deepEqual(currencyField(form).props.allowedCurrencies, ["AFN", "USD", "EUR"]);
    const result = nodes(form.hooks.tree).find(
      (node) => node.props.accessibilityLabel === "calculator.result",
    )!;
    const resultRow = nodes(form.hooks.tree).find(
      (node) => node.type === "View" && [node.props.children].flat().includes(result),
    )!;
    assert.ok(
      [resultRow.props.children].flat().includes(currencyField(form)),
      "The only currency control sits beside equals/result",
    );
    assert.equal(flattenStyle(resultRow.props.style).direction, "ltr");
    assert.equal(flattenStyle(resultRow.props.style).justifyContent, "space-between");
    assert.equal(
      [resultRow.props.children].flat()[0],
      currencyField(form),
      "Currency stays at the physical left edge",
    );
    assert.equal(flattenStyle(result.props.style).flex, 1);
    assert.equal(flattenStyle(result.props.style).minWidth, 0);
    assert.equal(flattenStyle(result.props.style).textAlign, "right");
    assert.equal(
      nodes(form.hooks.tree).filter((node) => node.type === "CurrencySelector").length,
      1,
    );
    await form.button().props.onPress();
    assert.equal(
      form.writes[0][4].currency,
      "USD",
      "saved denomination is explicit and independent of the book default",
    );
    assert.equal(form.selectedCurrency, "USD", "successful save opens the saved currency's ledger");
    form.hooks.unmount();
    const edit = editFixture(os, false, "Dollar tally", "USD");
    await edit.ready();
    assert.equal(
      currencyField(edit).props.value,
      "USD",
      "edit displays the tally currency even when the view is AFN",
    );
    assert.equal(
      typeof currencyField(edit).props.onChange,
      "function",
      "Edit has a currency changer",
    );
    assert.equal(currencyField(edit).props.disabled, false);
    assert.equal(currencyField(edit).props.compact, true);
    assert.equal(currencyField(edit).props.symbolOnly, true);
    edit.openCalculator();
    currencyField(edit).props.onOpen();
    edit.render();
    assert.equal(
      edit.calculator()!.props.visible,
      false,
      "The currency picker closes the calculator",
    );
    currencyField(edit).props.onChange("EUR");
    edit.render();
    assert.equal(currencyField(edit).props.value, "EUR");
    assert.equal(
      edit.input().props.value,
      "125.5",
      "Changing the unit never silently converts money",
    );
    assert.ok(words(edit.hooks.tree).includes("entry.currency.editHint"));
    await edit.button().props.onPress();
    assert.equal(edit.writes[0][4], "EUR");
    assert.equal(
      edit.writes[0][5].original.currency,
      "USD",
      "Save pins the original tally for stale guards",
    );
    edit.hooks.unmount();
    cases += 2;
    const historical = editFixture(os, false, "Original disabled currency", "USD", ["AFN"]);
    await historical.ready();
    assert.deepEqual(
      currencyField(historical).props.allowedCurrencies,
      ["AFN", "USD"],
      "Edit offers the enabled destination while retaining its historical current unit",
    );
    currencyField(historical).props.onChange("AFN");
    historical.render();
    assert.equal(currencyField(historical).props.value, "AFN");
    currencyField(historical).props.onChange("USD");
    historical.render();
    assert.equal(
      currencyField(historical).props.value,
      "USD",
      "A draft currency correction can be undone",
    );
    await historical.button().props.onPress();
    assert.equal(
      historical.writes[0][4],
      "USD",
      "Keeping a disabled recorded currency remains legal",
    );
    historical.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ enabledCurrencies: ["AFN", "USD"] });
    await f.ready();
    const originalChoice = currencyField(f).props.onChange;
    originalChoice("EUR");
    f.render();
    assert.equal(
      currencyField(f).props.value,
      "AFN",
      "A disabled currency cannot enter a draft through a retained picker callback",
    );
    originalChoice("USD");
    f.render();
    f.setEnabledCurrencies(["AFN"]);
    await f.button().props.onPress();
    f.render();
    assert.equal(
      f.writes.length,
      0,
      "A currency disabled since opening the form cannot save a new tally",
    );
    assert.ok(words(f.hooks.tree).includes("entry.currency.disabled"));
    assert.equal(
      currencyField(f).props.value,
      "USD",
      "A failed save never silently relabels the entered amount",
    );
    assert.equal(f.input().props.value, "125.50");
    assert.deepEqual(currencyField(f).props.allowedCurrencies, ["AFN"]);
    currencyField(f).props.onChange("AFN");
    f.render();
    await f.button().props.onPress();
    assert.equal(f.writes[0][4].currency, "AFN");
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ enabledCurrencies: ["AFN", "USD"] });
    await f.ready();
    const retained = currencyField(f);
    f.setEnabledCurrencies(["AFN"]);
    f.emitLedger("another-book");
    await f.flush();
    assert.deepEqual(currencyField(f).props.allowedCurrencies, ["AFN", "USD"]);
    f.emitLedger();
    await f.flush();
    assert.deepEqual(currencyField(f).props.allowedCurrencies, ["AFN"]);
    retained.props.onChange("USD");
    f.render();
    assert.equal(
      currencyField(f).props.value,
      "AFN",
      "Synced enabled settings invalidate retained choices",
    );
    f.transitions.vault();
    assert.equal(
      retained.props.onOpen(),
      false,
      "An old-book control cannot open a new currency sheet",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ enabledCurrencies: ["AFN", "USD"] });
    const old = f.delayedEnabledCurrencies();
    f.render();
    await f.flush();
    f.setEnabledCurrencies(["AFN"]);
    f.transitions.vault();
    await f.flush();
    assert.deepEqual(currencyField(f).props.allowedCurrencies, ["AFN"]);
    old.resolve(["USD"]);
    await f.flush();
    assert.deepEqual(
      currencyField(f).props.allowedCurrencies,
      ["AFN"],
      "A late prior-book enabled list cannot replace the new one",
    );
    f.hooks.unmount();
    cases++;
  }
  const dateField = (form: { hooks: ReturnType<typeof uiHooks> }) =>
    nodes(form.hooks.tree).find((node) => node.type === "EntryDateField")!;
  const moreOptions = (form: { hooks: ReturnType<typeof uiHooks> }) =>
    nodes(form.hooks.tree).find((node) => node.props.testID === "entry-more-options")!;
  const showDate = (form: { hooks: ReturnType<typeof uiHooks>; render: () => unknown }) => {
    if (!dateField(form)) {
      moreOptions(form).props.onPress();
      form.render();
    }
    return dateField(form);
  };
  for (const os of ["android", "ios"] as const)
    for (const rtl of [false, true]) {
      const chosen = new Date(2024, 1, 29).getTime();
      const f = fixture({ os, rtl });
      await f.ready();
      assert.equal(dateField(f), undefined, "new tallies keep Date collapsed by default");
      assert.equal(moreOptions(f).props.accessibilityRole, "button");
      assert.equal(moreOptions(f).props.accessibilityLabel, "entry.more.show");
      assert.equal(moreOptions(f).props.accessibilityState.expanded, false);
      assert.ok(
        nodes(f.hooks.tree).indexOf(f.input()) < nodes(f.hooks.tree).indexOf(f.note()) &&
          nodes(f.hooks.tree).indexOf(f.note()) < nodes(f.hooks.tree).indexOf(moreOptions(f)),
        "the basic form keeps Show more below Amount and Note",
      );
      f.openCalculator();
      moreOptions(f).props.onPress();
      f.render();
      assert.equal(f.calculator()!.props.visible, false, "Show more closes the amount keypad");
      assert.equal(moreOptions(f).props.accessibilityLabel, "entry.more.hide");
      assert.equal(moreOptions(f).props.accessibilityState.expanded, true);
      const newFields = nodes(f.hooks.tree);
      assert.ok(
        newFields.indexOf(f.note()) < newFields.indexOf(moreOptions(f)) &&
          newFields.indexOf(moreOptions(f)) < newFields.indexOf(dateField(f)),
        "expanded Date follows Show more below Note",
      );
      f.fireKeyboardTimers();
      f.render();
      assert.equal(f.calculator()!.props.visible, false, "expansion does not autofocus the keypad");
      dateField(f).props.onToggle();
      f.render();
      assert.equal(dateField(f).props.expanded, true);
      assert.equal(f.calculator()!.props.visible, false, "date selection closes the calculator");
      f.fireKeyboardTimers();
      f.render();
      assert.equal(f.calculator()!.props.visible, false, "autofocus cannot cover the date grid");
      dateField(f).props.onChange(chosen);
      dateField(f).props.onToggle();
      f.render();
      assert.equal(dateField(f).props.value, chosen);
      assert.equal(dateField(f).props.expanded, false);
      moreOptions(f).props.onPress();
      f.render();
      assert.equal(dateField(f), undefined, "Show less removes the optional date field");
      showDate(f);
      assert.equal(dateField(f).props.value, chosen, "reopening options preserves the chosen day");
      assert.equal(dateField(f).props.expanded, false, "reopening options leaves its popup closed");
      moreOptions(f).props.onPress();
      f.render();
      await f.button().props.onPress();
      const savedDate = new Date(f.writes[0][4].occurredAtMs);
      assert.deepEqual(
        [savedDate.getFullYear(), savedDate.getMonth(), savedDate.getDate()],
        [2024, 1, 29],
        "the selected business day reaches the create API even with options collapsed",
      );
      f.hooks.unmount();
      cases++;

      const edit = editFixture(os, rtl, "Original note");
      await edit.ready();
      assert.equal(dateField(edit), undefined, "Edit initially hides the date");
      assert.ok(
        nodes(edit.hooks.tree).indexOf(moreOptions(edit)) >
          nodes(edit.hooks.tree).indexOf(edit.note()),
        "Show more follows Note in Edit",
      );
      assert.equal(
        flattenStyle(moreOptions(edit).props.style({ pressed: false })).justifyContent,
        "center",
      );
      moreOptions(edit).props.onPress();
      edit.render();
      const editFields = nodes(edit.hooks.tree);
      assert.ok(
        editFields.indexOf(dateField(edit)) > editFields.indexOf(edit.note()),
        "Edit date is below Note and Show more",
      );
      const original = dateField(edit).props.value;
      assert.equal(original, new Date(2025, 5, 20, 15, 7, 12, 345).getTime());
      dateField(edit).props.onToggle();
      edit.render();
      dateField(edit).props.onChange(chosen);
      dateField(edit).props.onToggle();
      edit.render();
      await edit.button().props.onPress();
      assert.equal(
        edit.writes[0][3],
        new Date(2024, 1, 29, 15, 7, 12, 345).getTime(),
        "editing a tally changes its day and preserves its clock time",
      );
      assert.deepEqual(edit.writes[0].slice(0, 3), ["entry", 125.5, "Original note"]);
      edit.hooks.unmount();
      cases++;
    }
  for (const os of ["android", "ios"] as const) {
    const f = fixture({ os });
    await f.ready();
    f.note().props.onChangeText("A draft\n\nیادداشت");
    f.render();
    showDate(f).props.onToggle();
    f.render();
    const stalePicker = dateField(f);
    const originalDay = stalePicker.props.value;
    moreOptions(f).props.onPress();
    f.render();
    stalePicker.props.onChange(new Date(2020, 0, 1).getTime());
    stalePicker.props.onToggle();
    f.render();
    assert.equal(
      dateField(f),
      undefined,
      "a collapsed picker cannot reopen itself through old callbacks",
    );
    assert.equal(moreOptions(f).props.accessibilityState.expanded, false);
    showDate(f);
    assert.equal(dateField(f).props.expanded, false, "collapse cancels the open date popup");
    assert.equal(
      dateField(f).props.value,
      originalDay,
      "collapsed date callbacks cannot change the day",
    );
    assert.equal(f.input().props.value, "125.50");
    assert.equal(
      f.note().props.value,
      "A draft\n\nیادداشت",
      "options preserve the complete Note draft",
    );
    assert.equal(f.writes.length + f.routes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  for (const transition of ["account", "vault", "install", "person", "type", "refocus"] as const) {
    const f = fixture();
    await f.ready();
    showDate(f).props.onToggle();
    f.render();
    const chosen = new Date(2024, 1, 29).getTime();
    dateField(f).props.onChange(chosen);
    f.render();
    const staleMore = moreOptions(f),
      stalePicker = dateField(f);
    f.transitions[transition]();
    await f.flush();
    assert.equal(
      dateField(f),
      undefined,
      `${transition} resets the optional date field to collapsed`,
    );
    assert.equal(moreOptions(f).props.accessibilityState.expanded, false);
    staleMore.props.onPress();
    stalePicker.props.onToggle();
    stalePicker.props.onChange(new Date(2020, 0, 1).getTime());
    f.render();
    assert.equal(
      dateField(f),
      undefined,
      `${transition} invalidates retained More and date actions`,
    );
    assert.equal(moreOptions(f).props.accessibilityState.expanded, false);
    assert.equal(f.writes.length + f.routes.length, 0);
    showDate(f);
    if (transition === "refocus")
      assert.equal(dateField(f).props.value, chosen, "same-draft refocus preserves its chosen day");
    else
      assert.notEqual(
        dateField(f).props.value,
        chosen,
        `${transition} starts a new draft without the previous hidden past date`,
      );
    moreOptions(f).props.onPress();
    f.render();
    await f.button().props.onPress();
    assert.equal(f.writes.length, 1);
    const savedAt = f.writes[0][4].occurredAtMs;
    if (transition === "refocus") {
      const day = new Date(savedAt);
      assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate()], [2024, 1, 29]);
    } else
      assert.equal(savedAt, undefined, `${transition} saves the new draft at its default time`);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    showDate(f).props.onToggle();
    f.render();
    const retainedMore = moreOptions(f),
      retainedDate = dateField(f);
    const gate = f.delayedSave();
    const saving = f.button().props.onPress();
    await f.flush();
    assert.equal(
      moreOptions(f).props.disabled,
      true,
      "pending Save disables optional-field changes",
    );
    retainedMore.props.onPress();
    retainedDate.props.onChange(new Date(2020, 0, 1).getTime());
    f.render();
    assert.equal(moreOptions(f).props.accessibilityState.expanded, true);
    assert.equal(dateField(f).props.value, retainedDate.props.value);
    gate.resolve(normal);
    await saving;
    assert.equal(f.writes.length, 1);
    assert.equal(
      f.writes[0][4].occurredAtMs,
      undefined,
      "busy callbacks cannot backdate the saved tally",
    );
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["ios", "android"] as const)
    for (const rtl of [false, true]) {
      for (const personCurrency of [null, "USD", "JPY"]) {
        const f = fixture({
          os,
          rtl,
          personCurrency,
          initialLedgerCurrency: "EUR",
          bookCurrency: "AFN",
        });
        await f.ready();
        const expected = personCurrency === "USD" ? "USD" : "AFN";
        assert.deepEqual(f.personCurrencyReads, [["vault", "customer"]]);
        assert.equal(
          currencyField(f).props.value,
          expected,
          "An enabled contact preference seeds a new tally; inheritance or a disabled preference uses the Kaata default",
        );
        f.fireKeyboardTimers();
        await f.flush();
        assert.equal(
          f.creditChecks.at(-1)?.[4],
          expected,
          "credit warning uses the resolved draft currency",
        );
        await f.button().props.onPress();
        assert.equal(f.writes[0][4].currency, expected);
        f.hooks.unmount();
        cases++;
      }
    }
  {
    const f = fixture({ personCurrency: "USD" });
    await f.ready();
    currencyField(f).props.onChange("EUR");
    f.render();
    f.setPersonCurrency("AFN");
    f.refocus();
    await f.flush();
    assert.equal(
      currencyField(f).props.value,
      "EUR",
      "a later contact preference does not overwrite an explicit currency on the same draft",
    );
    assert.deepEqual(f.personCurrencyReads, [["vault", "customer"]]);
    f.emitLedger();
    await f.flush();
    assert.equal(
      currencyField(f).props.value,
      "EUR",
      "remote refresh updates permitted choices without relabeling the draft",
    );
    await f.button().props.onPress();
    assert.equal(f.writes[0][4].currency, "EUR");
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    const oldPreference = f.delayedPersonCurrency();
    f.render();
    await f.flush();
    assert.equal(currencyField(f), undefined);
    f.transitions.person();
    await f.flush();
    assert.equal(currencyField(f).props.value, "AFN");
    oldPreference.resolve("USD");
    await f.flush();
    assert.equal(
      currencyField(f).props.value,
      "AFN",
      "a late previous-contact preference cannot label a new contact's draft",
    );
    assert.deepEqual(f.personCurrencyReads, [
      ["vault", "customer"],
      ["vault", "different-customer"],
    ]);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ initialLedgerCurrency: "USD", bookCurrency: "AFN" });
    await f.ready();
    assert.deepEqual(f.defaultCurrencyReads, ["vault"]);
    assert.equal(
      currencyField(f).props.value,
      "AFN",
      "A rotating USD ledger view cannot change the new tally's AFN book default",
    );
    currencyField(f).props.onChange("EUR");
    f.render();
    assert.equal(f.selectedCurrency, "USD");
    f.refocus();
    await f.flush();
    assert.equal(
      currencyField(f).props.value,
      "EUR",
      "Refocusing the same form preserves its explicit currency choice",
    );
    await f.button().props.onPress();
    assert.equal(f.writes[0][4].currency, "EUR");
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ initialLedgerCurrency: "USD", bookCurrency: "AFN" });
    const oldDefault = f.delayedDefaultCurrency();
    f.render();
    await f.flush();
    assert.deepEqual(f.defaultCurrencyReads, ["vault"]);
    assert.equal(
      currencyField(f),
      undefined,
      "The form waits for its own book default before showing amounts",
    );
    f.transitions.vault();
    await f.flush();
    assert.equal(currencyField(f).props.value, "AFN");
    oldDefault.resolve("EUR");
    await f.flush();
    assert.equal(
      currencyField(f).props.value,
      "AFN",
      "A late prior-book default cannot repaint the new form",
    );
    assert.deepEqual(f.defaultCurrencyReads, ["vault", "different-vault"]);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    showDate(f).props.onToggle();
    f.render();
    const stalePicker = dateField(f);
    f.blur();
    stalePicker.props.onChange(new Date(2020, 0, 1).getTime());
    f.refocus();
    await f.flush();
    assert.equal(
      dateField(f),
      undefined,
      "returning to the route resets optional fields to collapsed",
    );
    assert.equal(moreOptions(f).props.accessibilityState.expanded, false);
    await f.button().props.onPress();
    assert.equal(
      f.writes[0][4].occurredAtMs,
      undefined,
      "expired picker cannot change a tally date",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    showDate(f).props.onToggle();
    f.render();
    assert.equal(f.hardwareBack(), true);
    f.render();
    assert.equal(dateField(f).props.expanded, false, "Android back closes the calendar first");
    await f.button().props.onPress();
    assert.equal(
      f.writes[0][4].occurredAtMs,
      undefined,
      "unchanged date retains save-time default",
    );
    f.hooks.unmount();
    cases++;
  }
  for (const rtl of [false, true]) {
    const f = fixture({ os: "ios", rtl, width: 440, height: 956 });
    await f.ready();
    f.openCalculator();
    f.calculator()!.props.onNext();
    f.render();
    const form = () => nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
    const initialHeight = flattenStyle(f.note().props.style).height;
    const accessoryID = f.accessory()!.props.nativeID;
    assert.ok(Number.isFinite(initialHeight) && initialHeight > 0);
    form().props.onLayout(layoutEvent(833 + 2 / 3, 440));
    f.emitKeyboard("keyboardWillShow");
    f.emitKeyboard("keyboardDidShow");
    f.render();
    f.scrolls.length = 0;
    f.endScrolls.length = 0;
    for (const lines of [3, 4, 5, 6, 7, 8, 9, 8, 7, 6, 5, 4, 3]) {
      const value = Array.from({ length: lines }, (_, index) => `Item ${index + 1}`).join("\n");
      f.note().props.onChangeText(value);
      f.render();
      assert.equal(f.note().props.value, value, "typing and deleting retain every note line");
      assert.equal(
        flattenStyle(f.note().props.style).height,
        initialHeight,
        "iOS retains one stable text viewport across the former growth and overflow boundaries",
      );
      assert.equal(f.note().props.scrollEnabled, true, "native inner scrolling stays available");
      form().props.onContentSizeChange(440, 384);
      form().props.onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentInset: { top: 0, bottom: lines >= 7 ? 412 : 0 },
        },
      });
      assert.deepEqual(f.scrolls, [], "note edits and late keyboard insets do not move the page");
      assert.deepEqual(f.endScrolls, []);
      assert.equal(f.accessory()!.props.nativeID, accessoryID);
    }
    f.note().props.onChangeText("");
    f.render();
    form().props.onContentSizeChange(440, 384);
    f.emitKeyboard("keyboardDidHide");
    f.render();
    assert.equal(f.note().props.value, "");
    assert.equal(flattenStyle(f.note().props.style).height, initialHeight);
    assert.equal(f.note().props.scrollEnabled, true);
    assert.deepEqual(f.scrolls, [], "clearing and keyboard dismissal add no forced scroll reset");
    assert.deepEqual(f.endScrolls, []);
    assert.equal(f.writes.length + f.routes.length, 0, "editing never submits or leaves the form");
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["ios", "android"] as const)
    for (const rtl of [false, true]) {
      const f = fixture({ os, rtl });
      await f.ready();
      f.openCalculator();
      const press = (key: string) => {
        const panel = f.calculator()!;
        panel.props.onChange(calculatorKey(panel.props.getDraft(), key));
        f.render();
      };
      const select = (start: number, end = start) => {
        f.input().props.onSelectionChange({ nativeEvent: { selection: { start, end } } });
        f.render();
      };
      press("AC");
      press("5");
      press("2");
      press("2");
      select(2);
      select(1);
      press("5");
      assert.equal(
        f.input().props.value,
        "5225",
        "delayed native caret echoes cannot reorder rapid keypad digits",
      );
      f.input().props.onPressIn();
      f.render();
      select(3);
      select(1);
      press("9");
      assert.equal(
        f.input().props.value,
        "59225",
        "deliberate caret dragging can insert in the middle",
      );
      f.input().props.onPressIn();
      f.render();
      select(1, 3);
      press("7");
      assert.equal(f.input().props.value, "5725", "deliberate range selection remains replaceable");
      f.input().props.onChangeText("57+25");
      f.render();
      select(3);
      press("9");
      assert.equal(
        f.input().props.value,
        "57+925",
        "native paste can retain its own insertion point",
      );
      f.input().props.onFocus();
      f.render();
      select(0, 2);
      press("8");
      assert.equal(
        f.input().props.value,
        "8+925",
        "native accessibility focus can still select and replace",
      );
      f.input().props.onKeyPress({ nativeEvent: { key: "ArrowLeft" } });
      select(2);
      press("1");
      assert.equal(
        f.input().props.value,
        "8+1925",
        "hardware selection remains available after keypad edits",
      );
      f.input().props.onPressIn();
      f.render();
      select(2);
      f.input().props.onBlur();
      select(0);
      press("2");
      assert.equal(
        f.input().props.value,
        "8+21925",
        "a blur closes selection intent before stale cursor events",
      );
      const beforeNoteSelection = f.input().props.selection;
      f.calculator()!.props.onNext();
      f.render();
      select(0);
      assert.equal(f.input().props.value, "8+21925", "Note handoff never edits the amount");
      assert.deepEqual(
        f.input().props.selection,
        beforeNoteSelection,
        "Note ignores late amount selection events",
      );
      assert.equal(f.writes.length, 0);
      f.hooks.unmount();
      cases++;
    }
  for (const os of ["ios", "android"] as const)
    for (const rtl of [false, true])
      for (const { width, height, fontScale } of [
        { width: 320, height: 568, fontScale: 1 },
        { width: 320, height: 568, fontScale: 2 },
        { width: 390, height: 844, fontScale: 1 },
        { width: 852, height: 393, fontScale: 1 },
        { width: 1024, height: 1366, fontScale: 1 },
        { width: 390, height: 844, fontScale: 2 },
      ]) {
        const f = fixture({ os, rtl, width, height, fontScale });
        await f.ready();
        f.input().props.onChangeText("1234567890.46+10");
        f.render();
        const result = nodes(f.hooks.tree).find(
          (node) => node.props.accessibilityLabel === "calculator.result",
        )!;
        const resultRow = nodes(f.hooks.tree).find(
          (node) => node.type === "View" && [node.props.children].flat().includes(result),
        )!;
        assert.equal(
          [resultRow.props.children].flat()[0],
          currencyField(f),
          "Currency stays left in narrow, large-text and RTL layouts",
        );
        assert.equal(flattenStyle(resultRow.props.style).direction, "ltr");
        assert.equal(flattenStyle(resultRow.props.style).flexDirection, "row");
        assert.equal(flattenStyle(resultRow.props.style).justifyContent, "space-between");
        assert.equal(flattenStyle(result.props.style).flex, 1);
        assert.equal(
          flattenStyle(result.props.style).minWidth,
          0,
          "Long totals can shrink within their own column without overlapping the currency control",
        );
        assert.equal(flattenStyle(result.props.style).textAlign, "right");
        assert.equal(flattenStyle(result.props.style).writingDirection, "ltr");
        assert.equal(result.props.numberOfLines, 1);
        assert.equal(result.props.adjustsFontSizeToFit, true);
        assert.equal(
          words(result),
          "= 1234567900.46",
          "The full exact result remains available to the fitting text",
        );
        const scroll = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
        const body = flattenStyle(scroll.props.contentContainerStyle);
        const noteStyle = () => flattenStyle(f.note().props.style);
        assert.equal(
          body.flexGrow,
          undefined,
          "keyboard insets cannot reveal stretched empty content",
        );
        assert.equal(body.minHeight, undefined);
        assert.equal(body.height, undefined);
        assert.equal(scroll.props.bounces, false);
        assert.equal(scroll.props.alwaysBounceVertical, false);
        assert.notEqual(scroll.props.scrollEnabled, false, "real overflow remains scrollable");
        assert.equal(body.maxWidth, 640, "wide windows retain a readable form column");
        assert.equal(body.width, "100%");
        assert.equal(body.alignSelf, "center");
        assert.ok(body.padding >= 16 && body.gap >= 16);
        const style = noteStyle();
        if (os === "ios")
          assert.ok(Number.isFinite(style.height), "iOS uses a stable native text viewport");
        else assert.equal(style.height, undefined, "Android short notes retain intrinsic growth");
        const threeLines = style.lineHeight * fontScale * 3 + 2 * style.paddingVertical + 2;
        assert.ok(style.minHeight >= threeLines, "three scaled lines fit within the note border");
        if (os === "ios")
          assert.ok(style.height >= threeLines, "the stable iOS viewport fits three scaled lines");
        assert.ok(
          style.maxHeight >= style.minHeight,
          "landscape never clips the minimum readable note",
        );
        assert.ok(
          style.maxHeight <= Math.max(style.minHeight, Math.floor(height * 0.24)),
          "long lists cannot consume the entire phone viewport",
        );
        assert.equal(
          f.note().props.scrollEnabled,
          true,
          "long-list scrolling is available from the first note edit",
        );
        if (os === "android")
          assert.equal(
            f.note().props.onLayout,
            undefined,
            "Android keeps its original input props",
          );
        const draft = "Rice\n\nروغن\nوریجې\n".repeat(12);
        f.note().props.onChangeText(draft);
        f.render();
        f.resizeWindow(height, width);
        assert.equal(f.note().props.value, draft, "resizing never truncates a multiline draft");
        assert.ok(noteStyle().maxHeight >= noteStyle().minHeight);
        if (os === "ios")
          assert.equal(
            noteStyle().height,
            style.height,
            "rotation preserves the readable note viewport",
          );
        assert.equal(f.writes.length, 0);
        f.hooks.unmount();
        cases++;
      }
  for (const os of ["ios", "android"] as const) {
    const f = fixture({ os });
    await f.ready();
    const saveBar = nodes(f.hooks.tree).find(
      (node) => node.type === "View" && node.props.children === f.bodyButton(),
    )!;
    saveBar.props.onLayout(layoutEvent(86));
    f.keyboardFrame().props.onLayout(layoutEvent(500));
    f.render();
    assert.equal(
      f.calculator()!.props.availableHeight,
      500 - (os === "ios" ? safeAreaInsets.bottom : 0),
    );
    assert.equal(
      f.calculator()!.props.footerHeight,
      86,
      "key capacity uses the actual Save height",
    );
    f.keyboardFrame().props.onLayout(layoutEvent(280, 852));
    saveBar.props.onLayout(layoutEvent(104));
    f.render();
    assert.equal(
      f.calculator()!.props.availableHeight,
      280 - (os === "ios" ? safeAreaInsets.bottom : 0),
    );
    assert.equal(
      f.calculator()!.props.footerHeight,
      104,
      "larger text cannot overlap the key panel",
    );
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["ios", "android"] as const)
    for (const rtl of [false, true]) {
      const f = fixture({ os, rtl });
      await f.ready();
      const form = () => nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
      const avoider = () =>
        nodes(f.hooks.tree).find((node) => node.type === "KeyboardAvoidingView")!;
      const safeArea = () => nodes(f.hooks.tree).find((node) => node.type === "SafeAreaView")!;
      const dock = () =>
        nodes(f.hooks.tree).find(
          (node) => node.type === "View" && [node.props.children].flat().includes(f.calculator()),
        )!;
      const viewportStyles = () => ({
        scroll: flattenStyle(form().props.style),
        avoider: flattenStyle(avoider().props.style),
        frame: flattenStyle(f.keyboardFrame().props.style),
      });
      const originalViewport = viewportStyles();
      const paddingBottom = () => {
        const body = flattenStyle(form().props.contentContainerStyle);
        return body.paddingBottom ?? body.padding;
      };
      const measureDock = (height: number) => {
        dock().props.onLayout(layoutEvent(height));
        f.render();
      };
      const bottomInset = os === "ios" ? safeAreaInsets.bottom : 0;
      const saveHeight = 86,
        calculatorHeight = 248;
      assert.equal(
        flattenStyle(dock().props.style).position,
        "absolute",
        "both platforms keep custom keys outside the form's viewport layout",
      );
      assert.ok([avoider().props.children].flat().includes(dock()), "the dock is a form sibling");
      assert.equal(
        nodes(form()).includes(dock()),
        false,
        "the fixed controls are outside form content",
      );
      assert.equal(avoider().props.enabled, os === "android");
      assert.equal(avoider().props.behavior, "height");
      if (os === "ios") {
        assert.deepEqual(safeArea().props.edges, ["top", "left", "right"]);
        const style = flattenStyle(dock().props.style);
        assert.deepEqual([style.bottom, style.left, style.right], [0, 0, 0]);
        assert.equal(style.paddingBottom, safeAreaInsets.bottom);
      }
      measureDock(saveHeight + bottomInset);
      assert.equal(paddingBottom(), 16 + saveHeight + bottomInset);
      f.openCalculator();
      measureDock(saveHeight + calculatorHeight + bottomInset);
      assert.equal(
        paddingBottom(),
        16 + saveHeight + calculatorHeight + bottomInset,
        "the measured Save, keypad and safe-area height reserve content instead of shrinking its viewport",
      );
      assert.deepEqual(viewportStyles(), originalViewport);
      assert.ok(f.scrolls.length > 0, "a measured overlay reveals an amount obscured by its keys");
      if (os === "ios") {
        assert.equal(flattenStyle(dock().props.style).paddingBottom, safeAreaInsets.bottom);
        assert.deepEqual(safeArea().props.edges, ["top", "left", "right"]);
      }
      f.calculator()!.props.onNext();
      f.render();
      measureDock(saveHeight + bottomInset);
      assert.deepEqual(
        f.endScrolls,
        [],
        "closing custom keys does not scroll before native keyboard readiness",
      );
      f.emitKeyboard("keyboardWillShow");
      f.render();
      if (os === "ios") {
        assert.equal(f.bodyButton(), undefined);
        assert.equal(dock().props.pointerEvents, "none");
        assert.equal(flattenStyle(dock().props.style).paddingBottom, 0);
        measureDock(0);
        assert.equal(
          paddingBottom(),
          16,
          "the accessory replaces the body-dock content reservation",
        );
        assert.deepEqual(safeArea().props.edges, ["top", "left", "right"]);
      } else {
        assert.ok(f.bodyButton());
        assert.equal(flattenStyle(dock().props.style).position, "absolute");
        assert.equal(
          paddingBottom(),
          16 + saveHeight,
          "Android keeps Save reserved above the native resized keyboard window",
        );
      }
      assert.deepEqual(
        viewportStyles(),
        originalViewport,
        "closing custom keys does not change either platform's form frame styles",
      );
      f.emitKeyboard("keyboardDidShow");
      f.render();
      f.fireNoteFrames();
      f.fireNoteFrames();
      assert.deepEqual(f.endScrolls, [{ animated: true }]);
      assert.deepEqual(viewportStyles(), originalViewport);
      f.emitKeyboard("keyboardDidHide");
      f.render();
      measureDock(saveHeight + bottomInset);
      assert.ok(f.bodyButton());
      assert.equal(paddingBottom(), 16 + saveHeight + bottomInset);
      assert.deepEqual(viewportStyles(), originalViewport);
      if (os === "ios") {
        assert.deepEqual(safeArea().props.edges, ["top", "left", "right"]);
        assert.equal(dock().props.pointerEvents, "auto");
      } else assert.equal(safeArea().props.edges.includes("bottom"), true);
      assert.equal(f.endScrolls.length, 1, "restoring body Save does not replay the Note scroll");
      assert.equal(f.writes.length + f.routes.length, 0);
      f.hooks.unmount();
      cases++;
    }
  for (const rtl of [false, true]) {
    const f = fixture({ os: "ios", rtl, nativeEdgeToEdge: false, statusBarHeight: 32 });
    f.render();
    assert.equal(f.accessory(), undefined, "the loading screen has no unbound native toolbar");
    await f.ready();
    const accessoryID = f.accessory()!.props.nativeID;
    assert.ok(typeof accessoryID === "string" && accessoryID.length > 0);
    assert.equal(f.note().props.inputAccessoryViewID, accessoryID);
    assert.equal(f.input().props.inputAccessoryViewID, undefined);
    assert.equal(
      nodes(f.accessory()).some((n) => n.type === "TextInput" || n.type === "ScrollView"),
      false,
      "only the fixed Save toolbar belongs in the accessory; multiline Note stays outside",
    );
    assert.equal(f.bodyButton()!.props.onPress, f.accessoryButton()!.props.onPress);
    assert.equal(f.bodyButton()!.props.loading, f.accessoryButton()!.props.loading);
    assert.equal(f.bodyButton()!.props.disabled, f.accessoryButton()!.props.disabled);
    const measurements: unknown[] = [];
    f.keyboardFrame().props.ref.current = {
      measureInWindow: (callback: unknown) => measurements.push(callback),
    };
    f.keyboardFrame().props.onLayout(layoutEvent(600));
    f.fireKeyboardTimers();
    f.render();
    assert.equal(measurements.length, 0, "iOS Save never waits for a measured keyboard origin");
    assert.equal(f.calculator()!.props.visible, true);
    assert.ok(f.bodyButton(), "custom amount keys retain their body Save");
    assert.equal(f.accessory()!.props.nativeID, accessoryID);
    f.calculator()!.props.onNext();
    f.render();
    assert.ok(f.bodyButton(), "body Save remains until the native keyboard begins appearing");
    f.emitKeyboard("keyboardWillShow");
    f.render();
    assert.equal(f.bodyButton(), undefined, "iOS removes the body bar before keyboard animation");
    assert.ok(f.accessoryButton(), "UIKit has its already-mounted Save toolbar");
    assert.equal(f.accessory()!.props.nativeID, accessoryID);
    assert.equal(f.note().props.inputAccessoryViewID, accessoryID);
    f.emitKeyboard("keyboardDidShow");
    f.render();
    assert.equal(f.bodyButton(), undefined);
    f.openCalculator();
    assert.ok(f.bodyButton(), "amount handoff restores Save before the native didHide event");
    assert.equal(f.calculator()!.props.visible, true);
    assert.equal(
      f.accessory()!.props.nativeID,
      accessoryID,
      "the toolbar never unmounts on handoff",
    );
    f.emitKeyboard("keyboardDidHide");
    f.render();
    assert.ok(f.bodyButton());
    assert.equal(f.accessory()!.props.nativeID, accessoryID);
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["ios", "android"] as const)
    for (const rtl of [false, true])
      for (const focus of ["arrow", "touch"] as const) {
        const f = fixture({ os, rtl });
        await f.ready();
        f.openCalculator();
        const accessoryID = f.accessory()?.props.nativeID;
        const form = () => nodes(f.hooks.tree).find((n) => n.type === "ScrollView")!;
        const resize = (height: number) =>
          form().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
        f.scrolls.length = 0;
        f.endScrolls.length = 0;
        if (focus === "arrow") f.calculator()!.props.onNext();
        else f.note().props.onFocus();
        f.render();
        assert.equal(
          f.calculator()!.props.visible,
          false,
          "Note focus first closes the custom keypad",
        );
        assert.equal(f.noteFocuses, 1, "touch and keypad Next share one native Note focus");
        assert.deepEqual(
          f.endScrolls,
          [],
          "focus leaves the native caret/inset animation in control",
        );
        assert.equal(f.noteFrames().length, 0, "focus does not queue an early final reveal");
        f.fireKeyboardTimers();
        resize(720);
        form().props.onContentSizeChange(390, 760);
        f.emitKeyboard("keyboardWillShow");
        f.render();
        form().props.onScroll({
          nativeEvent: {
            contentOffset: { x: 0, y: 120 },
            contentInset: { top: 0, bottom: 344, left: 0, right: 0 },
          },
        });
        f.note().props.onFocus();
        f.fireNoteFrames();
        assert.deepEqual(
          f.endScrolls,
          [],
          "timers, repeated focus, layout and content-size events never scroll during keyboard opening",
        );
        f.emitKeyboard("keyboardDidShow");
        f.emitKeyboard("keyboardDidShow");
        f.render();
        resize(680);
        form().props.onContentSizeChange(390, 740);
        assert.deepEqual(f.endScrolls, [], "the final reveal waits for its post-keyboard frame");
        assert.equal(
          f.noteFrames().length,
          1,
          "duplicate ready events coalesce into one final frame",
        );
        f.onEndScroll(() => {
          resize(680);
          form().props.onContentSizeChange(390, 740);
          f.emitKeyboard("keyboardDidShow");
        });
        f.fireNoteFrames();
        assert.deepEqual(f.endScrolls, [], "the commit frame waits for native viewport layout");
        assert.equal(f.noteFrames().length, 1, "one final native-layout frame remains");
        f.emitKeyboard("keyboardDidShow");
        assert.equal(
          f.noteFrames().length,
          1,
          "another ready event does not duplicate the final frame",
        );
        f.fireNoteFrames();
        f.render();
        assert.deepEqual(
          f.endScrolls,
          [{ animated: true }],
          "one settled frame reveals the bottom",
        );
        assert.equal(
          f.noteFrames().length,
          0,
          "the request is consumed before native scroll callbacks can reenter keyboard/layout handlers",
        );
        resize(640);
        form().props.onContentSizeChange(390, 760);
        f.note().props.onFocus();
        f.emitKeyboard("keyboardDidShow");
        f.fireNoteFrames();
        assert.equal(
          f.endScrolls.length,
          1,
          "later layouts and focus echoes cannot bounce the page",
        );
        assert.deepEqual(
          f.scrolls,
          [],
          "Note focus scrolls to the complete bottom rather than a partial field offset",
        );
        f.note().props.onChangeText("First line\n\nدوهمه کرښه\nآخرین خط");
        f.render();
        f.noteField().props.onLayout?.({
          nativeEvent: { layout: { x: 0, y: 264, width: 358, height: 212 } },
        });
        form().props.onContentSizeChange(390, 720);
        f.emitKeyboard("keyboardDidShow");
        f.fireNoteFrames();
        f.render();
        assert.deepEqual(
          f.scrolls,
          [],
          "note editing and layout callbacks leave native caret scrolling in control",
        );
        assert.equal(
          f.endScrolls.length,
          1,
          "typing, native insets and later layouts leave the consumed focus request finished",
        );
        if (os === "ios") {
          assert.equal(f.bodyButton(), undefined);
          assert.equal(f.accessory()!.props.nativeID, accessoryID);
        } else assert.ok(f.bodyButton(), "Android retains its native keyboard Save dock");
        assert.equal(f.note().props.value, "First line\n\nدوهمه کرښه\nآخرین خط");
        assert.equal(f.writes.length + f.routes.length, 0);
        f.emitKeyboard("keyboardDidHide");
        f.render();
        assert.ok(f.bodyButton());
        assert.equal(f.endScrolls.length, 1, "hiding the keyboard adds no scroll reset");
        f.hooks.unmount();
        cases++;
      }
  for (const os of ["ios", "android"] as const)
    for (const phase of ["commit", "layout"] as const)
      for (const cancel of [
        "drag",
        "typing",
        "noteBlur",
        "amount",
        "date",
        "more",
        "currency",
        "keyboardHide",
        "account",
        "vault",
        "install",
        "person",
        "type",
        "blur",
        "unmount",
      ] as const) {
        const f = fixture({ os });
        await f.ready();
        if (cancel === "date") showDate(f);
        f.note().props.onFocus();
        f.render();
        const form = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
        const lateNoteLayout = f.noteField().props.onLayout;
        f.emitKeyboard("keyboardDidShow");
        form.props.onLayout(layoutEvent(280));
        if (phase === "layout") f.fireNoteFrames();
        const lateFrames = f.noteFrames();
        assert.equal(lateFrames.length, 1, `the ready keyboard queues one ${phase} Note frame`);
        if (cancel === "drag") form.props.onScrollBeginDrag();
        else if (cancel === "typing") f.note().props.onChangeText("A draft\n\nیادداشت");
        else if (cancel === "noteBlur") f.note().props.onBlur();
        else if (cancel === "amount") f.input().props.onPressIn();
        else if (cancel === "date") dateField(f).props.onToggle();
        else if (cancel === "more") moreOptions(f).props.onPress();
        else if (cancel === "currency") {
          currencyField(f).props.onOpen();
          currencyField(f).props.onChange("USD");
        } else if (cancel === "keyboardHide") f.emitKeyboard("keyboardDidHide");
        else f.transitions[cancel]();
        if (cancel !== "unmount") f.render();
        assert.equal(f.noteFrames().length, 0, `${cancel} cancels the queued ${phase} frame`);
        f.scrolls.length = 0;
        f.endScrolls.length = 0;
        f.fireNoteFrames();
        lateFrames.forEach((callback) => callback());
        form.props.onLayout(layoutEvent(500));
        form.props.onContentSizeChange(390, 760);
        lateNoteLayout?.({ nativeEvent: { layout: { x: 0, y: 264, width: 358, height: 212 } } });
        f.emitKeyboard("keyboardDidShow");
        f.fireNoteFrames();
        assert.deepEqual(
          f.endScrolls,
          [],
          `${cancel} cancels bottom reveal and its late callbacks`,
        );
        assert.deepEqual(f.scrolls, [], `${cancel} leaves the chosen page offset alone`);
        assert.equal(
          f.writes.length + f.routes.length,
          0,
          "a focus reveal never saves or navigates",
        );
        if (cancel !== "unmount") f.hooks.unmount();
        assert.equal(f.hooks.lateWrites, 0);
        cases++;
      }
  for (const os of ["ios", "android"] as const) {
    const f = fixture({ os });
    await f.ready();
    f.note().props.onFocus();
    const form = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
    f.emitKeyboard("keyboardDidShow");
    form.props.onLayout(layoutEvent(280));
    const staleReveal = f.noteFrames()[0];
    assert.ok(staleReveal);
    f.note().props.onBlur();
    f.note().props.onFocus();
    f.render();
    staleReveal();
    assert.deepEqual(f.endScrolls, [], "a canceled frame cannot act on a newer Note focus");
    assert.equal(f.noteFrames().length, 1, "the newer already-shown focus owns one distinct frame");
    f.fireNoteFrames();
    assert.deepEqual(f.endScrolls, [], "refocus also waits through its commit frame");
    f.fireNoteFrames();
    assert.deepEqual(f.endScrolls, [{ animated: true }]);
    f.emitKeyboard("keyboardDidShow");
    f.render();
    const initialReveals = f.endScrolls.length;
    f.note().props.onBlur();
    f.note().props.onFocus();
    f.render();
    assert.equal(f.noteFrames().length, 1);
    f.fireNoteFrames();
    const staleLayout = f.noteFrames()[0];
    assert.ok(staleLayout);
    f.note().props.onBlur();
    f.note().props.onFocus();
    f.render();
    staleLayout();
    assert.equal(f.noteFrames().length, 1, "an old layout frame cannot clear a new commit frame");
    assert.equal(f.endScrolls.length, initialReveals);
    f.fireNoteFrames();
    f.fireNoteFrames();
    assert.equal(
      f.endScrolls.length,
      initialReveals + 1,
      "refocusing with an already-open keyboard completes one fresh bottom reveal",
    );
    form.props.onLayout(layoutEvent(280));
    form.props.onContentSizeChange(390, 760);
    f.emitKeyboard("keyboardDidShow");
    f.fireNoteFrames();
    assert.equal(
      f.endScrolls.length,
      initialReveals + 1,
      "later layouts never replay the already-shown keyboard's consumed request",
    );
    const beforeDrag = f.endScrolls.length;
    form.props.onScrollBeginDrag();
    form.props.onLayout(layoutEvent(260));
    form.props.onContentSizeChange(390, 780);
    f.emitKeyboard("keyboardDidShow");
    f.fireNoteFrames();
    assert.equal(f.endScrolls.length, beforeDrag, "a manual drag ends all latest-focus retries");
    assert.equal(f.writes.length + f.routes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ os: "ios" });
    await f.ready();
    f.note().props.onFocus();
    f.emitKeyboard("keyboardDidShow");
    const oldCommit = f.noteFrames()[0];
    assert.ok(oldCommit);
    f.emitKeyboard("keyboardWillShow");
    assert.equal(
      f.noteFrames().length,
      0,
      "a new keyboard transition cancels an early queued frame",
    );
    oldCommit();
    assert.deepEqual(f.endScrolls, [], "a stale did-show cannot scroll during a new will-show");
    f.emitKeyboard("keyboardDidShow");
    assert.equal(
      f.noteFrames().length,
      1,
      "willShow retains the request for the next settled keyboard",
    );
    f.fireNoteFrames();
    const oldLayout = f.noteFrames()[0];
    assert.ok(oldLayout);
    f.emitKeyboard("keyboardWillHide");
    assert.equal(f.noteFrames().length, 0, "willHide cancels the final viewport-layout frame");
    oldLayout();
    f.emitKeyboard("keyboardDidHide");
    f.emitKeyboard("keyboardDidShow");
    f.fireNoteFrames();
    assert.deepEqual(
      f.endScrolls,
      [],
      "hide cancels the intent rather than postponing a stale jump",
    );
    assert.equal(f.noteFrames().length, 0);
    assert.equal(f.writes.length + f.routes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  {
    const first = fixture({ os: "ios" }),
      second = fixture({ os: "ios" });
    await first.ready();
    await second.ready();
    assert.notEqual(
      first.accessory()!.props.nativeID,
      second.accessory()!.props.nativeID,
      "stacked entry screens cannot bind one another's Note toolbar",
    );
    first.hooks.unmount();
    second.hooks.unmount();
    const android = fixture();
    await android.ready();
    assert.equal(android.accessory(), undefined);
    assert.equal(android.note().props.inputAccessoryViewID, undefined);
    android.note().props.onFocus();
    android.emitKeyboard("keyboardWillShow");
    android.emitKeyboard("keyboardDidShow");
    android.render();
    assert.ok(android.bodyButton(), "Android keeps Save inside its height-avoiding footer");
    android.hooks.unmount();
    cases++;
  }
  for (const invalid of ["", "0", "-1", "1/0", "12+", "10000000000"]) {
    const f = fixture({ os: "ios" });
    await f.ready();
    const nativeSave = f.accessoryButton()!.props.onPress;
    f.input().props.onChangeText(invalid);
    f.note().props.onFocus();
    f.emitKeyboard("keyboardWillShow");
    f.render();
    assert.equal(f.bodyButton(), undefined);
    assert.equal(f.accessoryButton()!.props.disabled, true);
    await nativeSave();
    f.render();
    assert.equal(f.writes.length + f.routes.length + f.notices.length, 0);
    assert.ok(
      words(f.hooks.tree).includes("entry.invalidAmount"),
      `native Save rejects ${invalid}`,
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture({ os: "ios", rtl: true });
    await f.ready();
    f.note().props.onChangeText("  لومړۍ کرښه\n\nیادداشت  ");
    f.render();
    const bodySave = f.bodyButton()!.props.onPress;
    f.input().props.onChangeText("21*2");
    f.note().props.onFocus();
    f.emitKeyboard("keyboardWillShow");
    f.render();
    const nativeSave = f.accessoryButton()!.props.onPress;
    const gate = f.delayedSave();
    const saving = nativeSave();
    void nativeSave();
    void bodySave();
    await f.flush();
    assert.equal(f.writes.length, 1, "native and already-queued body taps share one save lock");
    assert.equal(f.writes[0][2], 42);
    assert.equal(f.writes[0][3], "لومړۍ کرښه\n\nیادداشت");
    assert.equal(f.accessoryButton()!.props.loading, true);
    f.openCalculator();
    assert.equal(f.calculator()!.props.visible, false, "busy native Save cannot reopen the keypad");
    gate.resolve(normal);
    await saving;
    await f.flush();
    assert.equal(f.accessoryButton()!.props.loading, false);
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["android", "ios"] as const) {
    const f = fixture({ os });
    await f.ready();
    f.note().props.onFocus();
    f.emitKeyboard("keyboardWillShow");
    f.emitKeyboard("keyboardDidShow");
    f.render();
    const form = () => nodes(f.hooks.tree).find((n) => n.type === "ScrollView")!;
    // The user has chosen a scroll position; isolate later error visibility
    // from the fresh-focus intent that otherwise follows keyboard layouts.
    form().props.onScrollBeginDrag();
    f.endScrolls.length = 0;
    f.scrolls.length = 0;
    form().props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: os === "ios" ? 500 : 280 } },
    });
    form().props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y: 0 },
        contentInset: { top: 0, bottom: os === "ios" ? 220 : 0, left: 0, right: 0 },
      },
    });
    f.scrolls.length = 0;
    form().props.onContentSizeChange(390, 600);
    assert.equal(
      f.scrolls.length + f.endScrolls.length,
      0,
      "ordinary Note content changes do not force scrolling",
    );
    f.setError(new Error("storage failed"));
    await f.button().props.onPress();
    await f.flush();
    const error = nodes(form()).find((n) => n.type === "Text" && words(n) === "entry.saveFailed");
    assert.ok(error, "save failure stays inside the form after the Note");
    assert.ok(nodes(form()).indexOf(error) > nodes(form()).indexOf(f.note()));
    assert.equal(f.scrolls.length, 0, "an error waits for its own measured bounds");
    if (os === "ios") {
      assert.ok(
        !words(f.accessory()).includes("entry.saveFailed"),
        "the native toolbar stays fixed-height",
      );
      assert.equal(f.bodyButton(), undefined);
    }
    const delayedErrorLayout = error.props.onLayout;
    delayedErrorLayout({ nativeEvent: { layout: { x: 0, y: 430, width: 358, height: 26 } } });
    assert.deepEqual(
      f.scrolls,
      [{ y: 176, animated: true }],
      "an error reveals only its clipped lower edge, including native keyboard insets",
    );
    form().props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y: 176 },
        contentInset: { top: 0, bottom: os === "ios" ? 220 : 0, left: 0, right: 0 },
      },
    });
    form().props.onContentSizeChange(390, 650);
    assert.equal(f.scrolls.length, 1, "an already visible error does not force another scroll");
    form().props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y: 500 },
        contentInset: { top: 16, bottom: os === "ios" ? 220 : 0, left: 0, right: 0 },
      },
    });
    form().props.onContentSizeChange(390, 650);
    assert.deepEqual(
      f.scrolls.at(-1),
      { y: 414, animated: true },
      "an error clipped above aligns its top with the top inset using the nearest reveal",
    );
    assert.equal(
      f.endScrolls.length,
      0,
      "error reveal never jumps to the inset-expanded content end",
    );
    assert.equal(f.button().props.loading, false);
    f.input().props.onChangeText("50");
    f.render();
    delayedErrorLayout({ nativeEvent: { layout: { x: 0, y: 900, width: 358, height: 100 } } });
    form().props.onContentSizeChange(390, 700);
    assert.equal(f.scrolls.length, 2, "a cleared error's delayed layout cannot move the form");
    await f.button().props.onPress();
    await f.flush();
    form().props.onContentSizeChange(390, 720);
    assert.equal(
      f.scrolls.length,
      2,
      "a retry waits for its new error bounds instead of reusing the removed error's frame",
    );
    f.hooks.unmount();
    cases++;
  }
  for (const transition of [
    "account",
    "vault",
    "person",
    "type",
    "install",
    "blur",
    "unmount",
    "refocus",
  ] as const) {
    const f = fixture({ os: "ios" });
    await f.ready();
    f.note().props.onFocus();
    f.emitKeyboard("keyboardWillShow");
    f.render();
    const nativeSave = f.accessoryButton()!.props.onPress;
    f.transitions[transition]();
    await nativeSave();
    await settleUI();
    assert.equal(
      f.writes.length + f.routes.length + f.notices.length,
      0,
      `expired native Save ignored after ${transition}`,
    );
    assert.equal(f.hooks.lateWrites, 0);
    if (transition !== "unmount") f.hooks.unmount();
    cases++;
  }
  // The custom keypad edits the visible amount directly. Save stays in its
  // fixed footer, using the current expression even before React rerenders.
  for (const os of ["android", "ios"] as const)
    for (const rtl of [false, true]) {
      const f = fixture({ os, rtl });
      await f.ready();
      const draftNote = "Rice 10 kg\n\nچای دو پاکت\nوروستۍ کرښه";
      f.note().props.onChangeText(draftNote);
      f.render();
      assert.equal(
        f.input().props.inputMode,
        "none",
        "RN inputMode must suppress its native keyboard",
      );
      assert.equal(f.input().props.showSoftInputOnFocus, false);
      assert.equal(
        nodes(f.hooks.tree).some((n) => n.type === "Modal"),
        false,
      );
      assert.equal(
        nodes(f.hooks.tree).some((n) => n.props.accessibilityLabel === "calculator.open"),
        false,
        "the amount opens the keypad without a separate calculator button",
      );
      f.openCalculator();
      const opened = f.calculator()!;
      assert.ok(opened, "the amount directly activates the inline keypad");
      assert.equal(opened.props.visible, true);
      assert.equal(opened.props.draft.expression, "125.50");
      assert.equal(opened.props.getDraft().expression, "125.50");
      assert.equal(f.note().props.value, draftNote);
      assert.equal(f.writes.length + f.routes.length, 0, "opening cannot save or navigate");
      const save = f.button().props.onPress;
      opened.props.onChange(calculatorDraft("200+49.75"));
      assert.equal(
        opened.props.getDraft().expression,
        "200+49.75",
        "draft ref changes synchronously",
      );
      await save();
      assert.equal(f.writes.length, 1, "Save works while the inline keypad is visible");
      assert.equal(
        f.writes[0][2],
        249.75,
        "same-frame Save uses the new expression rather than old state",
      );
      assert.equal(f.writes[0][3], draftNote, "keypad editing preserves the multiline note");
      assert.deepEqual(f.routes, ["back"]);
      f.hooks.unmount();
      cases++;
    }
  for (const invalid of ["", "0", "-1", "1/0", "12+", "10000000000", "NaN", "Infinity", "1,234"]) {
    const f = fixture();
    await f.ready();
    f.openCalculator();
    const save = f.button().props.onPress;
    f.calculator()!.props.onChange(calculatorDraft(invalid));
    await save();
    f.render();
    assert.equal(
      f.writes.length + f.routes.length + f.notices.length,
      0,
      `invalid expression cannot reuse the last valid amount: ${invalid}`,
    );
    assert.ok(
      words(f.hooks.tree).includes("entry.invalidAmount"),
      "Save explains an invalid amount inline",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.input().props.onChangeText("۱٢٫۵۰+٢");
    f.render();
    assert.equal(f.input().props.value, "12.50+2", "native paste retains normalized arithmetic");
    await f.button().props.onPress();
    assert.equal(f.writes[0][2], 14.5);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    const save = f.button().props.onPress;
    f.input().props.onChangeText("1/3");
    await save();
    assert.equal(
      f.writes[0][2],
      0.33,
      "native input edits and Save share the current exact calculation",
    );
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["android", "ios"] as const) {
    const f = fixture({ os });
    await f.ready();
    f.note().props.onChangeText("  Draft\n\nیادداشت  ");
    f.render();
    f.openCalculator();
    const previous = f.calculator()!;
    previous.props.onChange(calculatorDraft("25*2"));
    f.render();
    previous.props.onNext();
    f.render();
    assert.equal(f.noteFocuses, 1, "the keypad arrow immediately focuses Note");
    assert.equal(f.calculator()!.props.visible, false);
    assert.equal(
      f.calculator()!.type,
      previous.type,
      "the hidden keypad remains mounted for memory",
    );
    assert.equal(f.input().props.value, "25*2", "moving to Note does not replace the expression");
    assert.equal(f.note().props.value, "  Draft\n\nیادداشت  ");
    f.fireKeyboardTimers();
    assert.equal(f.keyboardFocuses, 0, "deferred amount focus cannot steal focus back from Note");
    previous.props.onChange(calculatorDraft("999"));
    previous.props.onNext();
    f.render();
    assert.equal(
      f.input().props.value,
      "25*2",
      "old keypad callbacks are inert while Note is active",
    );
    assert.equal(f.noteFocuses, 1);
    f.openCalculator();
    const reopened = f.calculator()!;
    assert.equal(reopened.props.visible, true);
    assert.equal(
      reopened.props.draft.expression,
      "25*2",
      "tapping the amount resumes its calculation",
    );
    previous.props.onChange(calculatorDraft("888"));
    previous.props.onNext();
    f.render();
    assert.equal(f.input().props.value, "25*2", "old events cannot edit a reopened keypad session");
    assert.equal(f.calculator()!.props.visible, true);
    assert.equal(f.noteFocuses, 1);
    assert.equal(f.writes.length + f.routes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.input().props.onFocus();
    f.render();
    assert.equal(
      f.calculator()!.props.visible,
      true,
      "assistive and hardware focus opens the custom keypad",
    );
    f.note().props.onFocus();
    f.render();
    assert.equal(
      f.calculator()!.props.visible,
      false,
      "touching Note hides the keypad without requiring its arrow",
    );
    f.openCalculator();
    assert.equal(
      f.calculator()!.props.visible,
      true,
      "a repeated tap on an already-focused amount reopens it",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.openCalculator();
    const previous = f.calculator()!;
    const first = { expression: "12.5*2", result: "25" };
    previous.props.onRecord(first);
    f.render();
    assert.deepEqual(f.calculator()!.props.history, [first]);
    f.calculator()!.props.onNext();
    f.render();
    f.openCalculator();
    assert.deepEqual(
      f.calculator()!.props.history,
      [first],
      "history survives moving between Amount and Note",
    );
    previous.props.onRecord({ expression: "999", result: "999" });
    previous.props.onClearHistory();
    f.render();
    assert.deepEqual(
      f.calculator()!.props.history,
      [first],
      "old keypad sessions cannot change history",
    );
    f.calculator()!.props.onClearHistory();
    f.render();
    assert.deepEqual(f.calculator()!.props.history, []);
    assert.equal(f.writes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  for (const transition of [
    "account",
    "vault",
    "person",
    "type",
    "install",
    "blur",
    "unmount",
    "refocus",
  ] as const) {
    const f = fixture();
    await f.ready();
    f.openCalculator();
    f.calculator()!.props.onRecord({ expression: "12.5*2", result: "25" });
    f.render();
    const previous = f.calculator()!;
    f.transitions[transition]();
    previous.props.onChange(calculatorDraft("999"));
    previous.props.onRecord({ expression: "999", result: "999" });
    previous.props.onClearHistory();
    previous.props.onNext();
    if (transition !== "unmount") {
      await f.flush();
      assert.equal(f.input().props.value, "125.50", `stale calculator edit after ${transition}`);
      assert.equal(
        f.calculator()!.props.visible,
        false,
        `scope change hides the keypad: ${transition}`,
      );
      if (transition !== "blur") {
        f.openCalculator();
        assert.deepEqual(f.calculator()!.props.history, [], `history resets after ${transition}`);
      }
    }
    assert.equal(f.writes.length + f.routes.length + f.notices.length + f.noteFocuses, 0);
    assert.equal(f.hooks.lateWrites, 0, `no stale keypad state changes: ${transition}`);
    if (transition !== "unmount") f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.openCalculator();
    f.calculator()!.props.onChange(calculatorDraft("12+"));
    f.render();
    await f.button().props.onPress();
    f.render();
    assert.ok(words(f.hooks.tree).includes("entry.invalidAmount"));
    f.calculator()!.props.onChange(calculatorDraft("12+3"));
    f.render();
    assert.equal(words(f.hooks.tree).includes("entry.invalidAmount"), false);
    await f.button().props.onPress();
    assert.equal(f.writes[0][2], 15);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.openCalculator();
    const previous = f.calculator()!;
    const gate = f.delayedSave();
    const saving = f.button().props.onPress();
    previous.props.onChange(calculatorDraft("999"));
    previous.props.onNext();
    f.render();
    assert.equal(f.calculator()!.props.disabled, true, "pending Save disables the keypad");
    assert.equal(
      f.input().props.value,
      "125.50",
      "same-frame key events cannot change the pending tally",
    );
    assert.equal(f.noteFocuses, 0);
    gate.resolve(normal);
    await saving;
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0][2], 125.5);
    f.hooks.unmount();
    cases++;
  }
  for (const os of ["android", "ios"] as const) {
    const f = fixture({ os });
    await f.ready();
    assert.equal(f.hardwareBack(), false, "an inactive keypad does not consume screen Back");
    f.openCalculator();
    assert.equal(f.hardwareBack(), true, "Back dismisses the custom keypad first");
    f.render();
    assert.equal(f.calculator()!.props.visible, false);
    assert.equal(f.input().props.value, "125.50");
    assert.equal(f.hardwareBack(), false, "a second Back returns to normal navigation");
    assert.deepEqual(f.routes, []);
    f.openCalculator();
    f.calculator()!.props.onNext();
    f.render();
    const form = nodes(f.hooks.tree).find((node) => node.type === "ScrollView")!;
    form.props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 280 } },
    });
    f.scrolls.length = 0;
    f.emitKeyboard("keyboardDidShow");
    f.render();
    f.fireNoteFrames();
    f.fireNoteFrames();
    assert.equal(f.calculator()!.props.visible, false, "native Note keyboard replaces the keypad");
    assert.deepEqual(
      f.scrolls,
      [],
      "both platforms reveal the complete form bottom instead of a clipped Note edge",
    );
    assert.deepEqual(f.endScrolls.at(-1), { animated: true });
    const safeArea = () => nodes(f.hooks.tree).find((node) => node.type === "SafeAreaView")!;
    assert.equal(
      safeArea().props.edges.includes("bottom"),
      false,
      "keyboard-open footer does not add the home-indicator inset twice",
    );
    f.emitKeyboard("keyboardDidHide");
    f.render();
    assert.equal(
      safeArea().props.edges.includes("bottom"),
      os === "android",
      "iOS retains its full-height safe-area frame while Android restores its existing bottom edge",
    );
    assert.equal(
      f.calculator()!.props.visible,
      false,
      "hiding Note's keyboard never reopens the keypad",
    );
    assert.equal(f.hardwareBack(), false);
    const lateNativeEvents = f.nativeHandlers();
    assert.ok(f.nativeSubscriptions > 0);
    f.hooks.unmount();
    assert.equal(
      f.nativeSubscriptions,
      0,
      "keyboard and Back subscriptions are removed on unmount",
    );
    lateNativeEvents.forEach((handler) => handler());
    assert.equal(f.hooks.lateWrites, 0);
    assert.equal(f.writes.length, 0);
    cases++;
  }
  {
    const f = fixture();
    f.setOverLimit(true);
    await f.ready();
    f.openCalculator();
    f.calculator()!.props.onChange(calculatorDraft("75*2"));
    f.render();
    f.fireKeyboardTimers();
    await f.flush();
    assert.deepEqual(
      f.creditChecks.at(-1),
      ["customer", "debt", 150, "vault", "AFN"],
      "credit warning uses the calculated amount",
    );
    assert.ok(words(f.hooks.tree).includes("credit.warning"));
    const checks = f.creditChecks.length;
    f.calculator()!.props.onChange(calculatorDraft("75*"));
    f.render();
    f.fireKeyboardTimers();
    await f.flush();
    assert.equal(
      f.creditChecks.length,
      checks,
      "an unfinished expression never checks the previous amount",
    );
    assert.equal(words(f.hooks.tree).includes("credit.warning"), false);
    assert.equal(f.button().props.disabled, true);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.fireKeyboardTimers();
    f.render();
    assert.equal(
      f.keyboardFocuses,
      1,
      "the initial native amount focus happens after the entry transition",
    );
    assert.equal(f.calculator()!.props.visible, true, "that focus activates the custom keypad");
    assert.equal(f.input().props.showSoftInputOnFocus, false);
    f.hooks.unmount();
    cases++;
  }
  for (const { nativeEdgeToEdge, statusBarHeight } of [
    { nativeEdgeToEdge: false, statusBarHeight: 32 },
    { nativeEdgeToEdge: false, statusBarHeight: 0 },
    { nativeEdgeToEdge: false, statusBarHeight: null },
    { nativeEdgeToEdge: true, statusBarHeight: 32 },
    { nativeEdgeToEdge: "unknown", statusBarHeight: 32 },
  ] as const) {
    const f = fixture({ os: "android", nativeEdgeToEdge, statusBarHeight });
    await f.ready();
    const measurements: ((x: number, y: number) => void)[] = [];
    const wrapper = f.keyboardFrame();
    wrapper.props.ref.current = { measureInWindow: (callback: any) => measurements.push(callback) };
    assert.equal(
      wrapper.props.children.type,
      "KeyboardAvoidingView",
      "the measured wrapper has one avoider child at local y zero",
    );
    const avoider = () => nodes(f.hooks.tree).find((n) => n.type === "KeyboardAvoidingView")!;
    const offset = () => avoider().props.keyboardVerticalOffset;
    assert.equal(
      avoider().props.enabled,
      nativeEdgeToEdge !== false,
      "only a confirmed non-edge-to-edge Android host delegates all avoidance to native resize",
    );
    wrapper.props.onLayout(layoutEvent(600));
    if (nativeEdgeToEdge === false) {
      f.render();
      assert.equal(f.calculator()!.props.availableHeight, 600);
      f.fireKeyboardTimers();
      f.render();
      assert.equal(measurements.length, 0, "native resize needs no origin/status-bar measurement");
      assert.equal(offset(), 0);
      f.note().props.onFocus();
      f.emitKeyboard("keyboardDidShow");
      wrapper.props.onLayout(layoutEvent(443));
      nodes(f.hooks.tree)
        .find((node) => node.type === "ScrollView")!
        .props.onLayout(layoutEvent(443));
      f.render();
      assert.equal(
        f.calculator()!.props.availableHeight,
        443,
        "native parent layout supplies IME bounds",
      );
      assert.equal(measurements.length, 0, "Note focus does not add a second resize measurement");
      assert.equal(avoider().props.enabled, false);
      assert.equal(offset(), 0, "status-bar variants cannot add a second keyboard offset");
      f.fireNoteFrames();
      f.fireNoteFrames();
      assert.deepEqual(f.endScrolls, [{ animated: true }]);
      f.emitKeyboard("keyboardDidHide");
      wrapper.props.onLayout(layoutEvent(731));
      f.render();
      assert.equal(
        f.calculator()!.props.availableHeight,
        731,
        "native parent restores its own height",
      );
      assert.equal(offset(), 0);
      assert.equal(measurements.length, 0);
      assert.equal(f.endScrolls.length, 1);
      assert.equal(f.writes.length + f.routes.length, 0);
      f.hooks.unmount();
      cases++;
      continue;
    }
    assert.equal(measurements.length, 1);
    measurements[0](0, 120);
    f.render();
    assert.equal(
      offset(),
      120,
      "edge-to-edge and unknown hosts retain their measured keyboard origin",
    );
    wrapper.props.onLayout(layoutEvent(600));
    wrapper.props.onLayout(layoutEvent(600));
    const previous = measurements.at(-2)!,
      latest = measurements.at(-1)!;
    latest(0, 136);
    previous(0, 999);
    f.render();
    assert.equal(offset(), 136, "an older measurement cannot overwrite a newer frame");
    f.fireKeyboardTimers();
    measurements.at(-1)!(0, 140);
    f.render();
    assert.equal(offset(), 140, "the post-transition measurement replaces the initial frame");
    f.note().props.onFocus();
    measurements.at(-1)!(0, 144);
    f.render();
    assert.equal(offset(), 144, "focusing Note remeasures the Android origin");
    f.hooks.unmount();
    cases++;
  }
  for (const nativeEdgeToEdge of [true, "unknown"] as const)
    for (const transition of [
      "account",
      "vault",
      "person",
      "type",
      "install",
      "blur",
      "unmount",
      "refocus",
    ] as const) {
      const f = fixture({ os: "android", nativeEdgeToEdge, statusBarHeight: 32 });
      await f.ready();
      const measurements: ((x: number, y: number) => void)[] = [];
      const wrapper = f.keyboardFrame();
      wrapper.props.ref.current = {
        measureInWindow: (callback: any) => measurements.push(callback),
      };
      wrapper.props.onLayout(layoutEvent(600));
      measurements.at(-1)!(0, 120);
      f.render();
      wrapper.props.onLayout(layoutEvent(600));
      const delayed = measurements.at(-1)!;
      f.transitions[transition]();
      delayed(0, 999);
      if (transition !== "unmount") {
        await f.flush();
        assert.equal(
          nodes(f.hooks.tree).find((n) => n.type === "KeyboardAvoidingView")!.props
            .keyboardVerticalOffset,
          120,
          `stale keyboard measurement ignored after ${transition} with ${nativeEdgeToEdge} edge mode`,
        );
        f.hooks.unmount();
      }
      assert.equal(f.hooks.lateWrites, 0);
      cases++;
    }
  {
    const f = fixture();
    await f.ready();
    const field = nodes(f.hooks.tree).find(
      (n) => n.type === "View" && !n.props.ref && n.props.onLayout && nodes(n).includes(f.input()),
    )!;
    field.props.onLayout({ nativeEvent: { layout: { x: 0, y: 132, width: 358, height: 120 } } });
    const form = nodes(f.hooks.tree).find((n) => n.type === "ScrollView")!;
    const resize = (height: number) =>
      form.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } });
    const scroll = (y: number) =>
      form.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } });
    resize(360);
    f.openCalculator();
    assert.equal(
      f.scrolls.length,
      0,
      "opening leaves the customer context in place when the whole amount fits",
    );
    resize(180);
    assert.deepEqual(
      f.scrolls.at(-1),
      { y: 72, animated: true },
      "a clipped lower edge scrolls only far enough to reveal the complete amount",
    );
    scroll(72);
    resize(180);
    assert.equal(
      f.scrolls.length,
      1,
      "no repeated scroll when the amount exactly fits the current viewport",
    );
    scroll(180);
    resize(180);
    assert.deepEqual(
      f.scrolls.at(-1),
      { y: 132, animated: true },
      "a clipped top edge reveals the amount with the nearest scroll",
    );
    scroll(0);
    const beforeLargeViewport = f.scrolls.length;
    resize(360);
    assert.equal(
      f.scrolls.length,
      beforeLargeViewport,
      "growing the viewport does not hide customer context",
    );
    field.props.onLayout({ nativeEvent: { layout: { x: 0, y: 132, width: 358, height: 260 } } });
    assert.deepEqual(
      f.scrolls.at(-1),
      { y: 32, animated: true },
      "the amount's measured height is respected when text or hints grow",
    );
    f.calculator()!.props.onNext();
    f.render();
    const amountScrolls = f.scrolls.length;
    resize(300);
    assert.equal(f.scrolls.length, amountScrolls, "Note does not reuse the amount's field offsets");
    assert.deepEqual(
      f.endScrolls,
      [],
      "Next waits for the native keyboard rather than form layouts",
    );
    f.emitKeyboard("keyboardDidShow");
    f.fireNoteFrames();
    f.fireNoteFrames();
    assert.deepEqual(
      f.endScrolls,
      [{ animated: true }],
      "one post-keyboard command reveals the bottom",
    );
    form.props.onScrollBeginDrag();
    form.props.onScroll({
      nativeEvent: {
        contentOffset: { x: 0, y: 350 },
        contentInset: { top: 12, bottom: 0, left: 0, right: 0 },
      },
    });
    resize(300);
    assert.equal(
      f.scrolls.length,
      amountScrolls,
      "manual Note scrolling retains the chosen offset",
    );
    assert.equal(f.endScrolls.length, 1, "a manual drag cancels further bottom-focus retries");
    assert.equal(f.writes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  for (const status of [undefined, "pending", "refused"] as const) {
    const f = fixture();
    await f.ready();
    f.setResult({ ...normal, admission_status: status, credit_warning: true });
    await f.button().props.onPress();
    await f.flush();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0][0], "customer");
    assert.equal(f.writes[0][2], 125.5);
    assert.equal(f.writes[0][4].vaultId, "vault");
    assert.deepEqual(f.notices, [
      [
        status === "refused"
          ? "credit.blocked"
          : status === "pending"
            ? // An "I gave" tally waiting for the limit check: hand nothing over.
              "credit.pendingHold"
            : "entry.saved",
        status === "refused" ? "error" : status === "pending" ? "info" : "success",
      ],
    ]);
    assert.deepEqual(f.routes, ["back"]);
    assert.equal(
      f.queued.length,
      status ? 0 : 1,
      "pending/refused must not claim a recorded warning",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    // A waiting "I received" hands nothing over, so it keeps the plain words.
    const f = fixture();
    f.transitions.type();
    await f.ready();
    f.setResult({ ...normal, admission_status: "pending" });
    await f.button().props.onPress();
    await f.flush();
    assert.equal(f.writes[0][1], "payment");
    assert.deepEqual(f.notices, [["credit.pending", "info"]]);
    f.hooks.unmount();
    cases++;
  }
  for (const [error, key] of [
    [new RoleGateRejectionError(), "entry.roleDenied"],
    [new EventSigningUnavailableError(), "entry.signingUnavailable"],
    [new TabAuthUnavailableError(), "tab.needsConnection"],
    [new TabClosedError(), "tab.closed"],
    [new TabPermissionError(), "entry.roleDenied"],
    [new TabApiError("credit_limit_exceeded"), "credit.blocked"],
    [new Error("storage failed"), "entry.saveFailed"],
  ] as const) {
    const f = fixture();
    await f.ready();
    f.setError(error);
    await f.button().props.onPress();
    await f.flush();
    assert.ok(words(f.hooks.tree).includes(key));
    assert.equal(f.routes.length + f.notices.length + f.queued.length, 0);
    assert.equal(f.button().props.loading, false);
    f.hooks.unmount();
    cases++;
  }
  const transitions = Object.keys(fixture().transitions) as (keyof ReturnType<
    typeof fixture
  >["transitions"])[];
  for (const outcome of ["success", "refused", "error"] as const)
    for (const transition of transitions) {
      const f = fixture();
      await f.ready();
      const gate = f.delayedSave();
      const saving = f.button().props.onPress();
      await settleUI();
      assert.equal(f.writes.length, 1, "write began before the delayed admission");
      f.transitions[transition]();
      if (outcome === "error") gate.reject(new RoleGateRejectionError());
      else
        gate.resolve({
          ...normal,
          credit_warning: true,
          duplicate_hint: {},
          admission_status: outcome === "refused" ? "refused" : undefined,
        });
      await saving;
      await settleUI();
      assert.equal(
        f.routes.length + f.notices.length + f.queued.length,
        0,
        `${outcome} after ${transition}`,
      );
      assert.equal(f.hooks.lateWrites, 0, `no state writes after unmount: ${transition}`);
      if (transition !== "unmount") {
        f.render();
        assert.ok(
          !words(f.hooks.tree).includes("entry.roleDenied"),
          `no old error after ${transition}`,
        );
        f.hooks.unmount();
      }
      cases++;
    }
  for (const state of ["archived", "none"] as const)
    for (const transition of transitions) {
      const f = fixture();
      await f.ready();
      const gate = f.delayedGuard();
      const saving = f.button().props.onPress();
      await settleUI();
      f.transitions[transition]();
      gate.resolve({ state });
      await saving;
      await settleUI();
      assert.equal(
        f.writes.length + f.routes.length + f.notices.length,
        0,
        `${state} after ${transition}`,
      );
      assert.equal(f.hooks.lateWrites, 0);
      if (transition !== "unmount") f.hooks.unmount();
      cases++;
    }
  for (const transition of [
    "account",
    "vault",
    "person",
    "type",
    "install",
    "blur",
    "unmount",
  ] as const) {
    const f = fixture();
    await f.ready();
    const gate = f.delayedCapture();
    const saving = f.button().props.onPress();
    f.transitions[transition]();
    gate.resolve();
    await saving;
    await settleUI();
    assert.equal(
      f.writes.length + f.routes.length + f.notices.length,
      0,
      `tap scope captured before await: ${transition}`,
    );
    assert.equal(f.hooks.lateWrites, 0);
    if (transition !== "unmount") f.hooks.unmount();
    cases++;
  }
  for (const state of ["archived", "none"] as const) {
    const f = fixture();
    await f.ready();
    const gate = f.delayedGuard();
    const saving = f.button().props.onPress();
    await settleUI();
    gate.resolve({ state });
    await saving;
    await settleUI();
    assert.deepEqual(f.routes, [state === "archived" ? "/vault/archived" : "/"]);
    assert.equal(f.notices.length, 1);
    assert.equal(f.writes.length, 0);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    const gate = f.delayedSave();
    const click = f.button().props.onPress;
    const saving = click();
    void click();
    await settleUI();
    f.blur();
    f.fireKeyboardTimers();
    assert.equal(f.keyboardFocuses, 0, "no late keyboard on hidden screen");
    f.refocus();
    await f.flush();
    assert.equal(f.button().props.loading, true);
    await f.button().props.onPress();
    assert.equal(f.writes.length, 1, "refocus cannot start a second durable write");
    gate.resolve(normal);
    await saving;
    await f.flush();
    assert.equal(f.button().props.loading, false, "completion safely releases busy on return");
    assert.equal(f.notices.length + f.routes.length, 0);
    f.setResult(normal);
    await f.button().props.onPress();
    assert.equal(f.writes.length, 2, "new active tap may save after old write completes");
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    const gate = f.delayedDuplicate();
    f.setResult({ ...normal, duplicate_hint: {}, credit_warning: true });
    const saving = f.button().props.onPress();
    await settleUI();
    f.blur();
    gate.resolve({ other_label: "Peer" });
    await saving;
    assert.equal(
      f.routes.length + f.notices.length + f.queued.length,
      0,
      "duplicate-name read cannot revive feedback after blur",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    const staleClick = f.button().props.onPress;
    f.transitions.person();
    await f.flush();
    await staleClick();
    assert.equal(
      f.writes.length,
      0,
      "old button closure cannot write its amount into a new customer",
    );
    f.hooks.unmount();
    cases++;
  }
  {
    // Audit #24: an amount over the credit limit is flagged while typing,
    // not only after the save.
    const f = fixture();
    f.setOverLimit(true);
    await f.ready();
    f.fireKeyboardTimers();
    await f.flush();
    const warned = () =>
      nodes(f.hooks.tree).some((n) => n.type === "Text" && n.props.children === "credit.warning");
    assert.ok(warned(), "an over-limit amount is flagged before Save");
    f.setOverLimit(false);
    f.input().props.onChangeText("1");
    f.render();
    f.fireKeyboardTimers();
    await f.flush();
    assert.equal(warned(), false, "and clears once the amount is back under");
    f.hooks.unmount();
    cases++;
  }
  {
    // Audit #3: a saved tally is noted so its customer's page can show it
    // even under a search; a refused clerk attempt is not in the ledger.
    savedNotes.length = 0;
    const f = fixture();
    await f.ready();
    f.setResult(normal);
    await f.button().props.onPress();
    await f.flush();
    assert.deepEqual(savedNotes, [["customer", "entry"]]);
    f.hooks.unmount();
    const g = fixture();
    await g.ready();
    g.setResult({ ...normal, admission_status: "refused" });
    await g.button().props.onPress();
    await g.flush();
    assert.equal(savedNotes.length, 1, "a refused attempt is not noted");
    g.hooks.unmount();
    cases++;
  }
  for (const os of ["android", "ios"] as const)
    for (const rtl of [false, true])
      for (const mode of ["create", "edit"] as const) {
        const loadedNote = "Rice 10 kg\n\nچای دو پاکت\n  keep this indentation";
        const changedNote = `${loadedNote}\n\nوروستۍ کرښه`;
        const f = mode === "create" ? fixture({ os, rtl }) : editFixture(os, rtl, loadedNote);
        await f.ready();
        assert.equal(
          f.note().props.value,
          mode === "edit" ? loadedNote : "",
          `${mode}: loaded notes retain their blank lines`,
        );
        assertMultilineForm(f, os, rtl, true);
        f.note().props.onChangeText(changedNote);
        f.render();
        assert.equal(
          f.note().props.value,
          changedNote,
          `${mode}: controlled value retains pasted paragraphs`,
        );
        // Native Return inserts a newline through onChangeText. There is no
        // submit handler to confuse that keystroke with pressing Save.
        f.note().props.onChangeText(`${changedNote}\n`);
        f.render();
        assert.equal(f.note().props.value, `${changedNote}\n`);
        assert.equal(f.writes.length, 0, `${mode}: Return cannot save`);
        f.note().props.onChangeText(changedNote);
        f.render();
        await f.button().props.onPress();
        await settleUI();
        f.render();
        assert.equal(f.writes.length, 1);
        assert.equal(
          f.writes[0][mode === "create" ? 3 : 2],
          changedNote,
          `${mode}/${os}/${rtl ? "RTL" : "LTR"}: Save preserves internal line breaks and whitespace`,
        );
        assert.deepEqual(f.routes, ["back"]);
        f.hooks.unmount();
        cases++;
      }
  for (const os of ["android", "ios"] as const)
    for (const mode of ["create", "edit"] as const)
      for (const value of ["x".repeat(245) + "\n\n" + "ی".repeat(260), "\n \n"]) {
        const f = mode === "create" ? fixture({ os }) : editFixture(os, true, "Loaded\n\noriginal");
        await f.ready();
        assert.equal(f.note().props.maxLength, 500);
        // Bypass the native maxLength to exercise the independent save clamp:
        // pasted/stale values must not evade the actual 500-character limit.
        f.note().props.onChangeText(value);
        f.render();
        await f.button().props.onPress();
        assert.equal(f.writes[0][mode === "create" ? 3 : 2], value.trim().slice(0, 500) || null);
        if (value.length > 500)
          assert.ok(
            f.writes[0][mode === "create" ? 3 : 2].includes("\n\n"),
            "clamping length keeps internal blank lines",
          );
        f.hooks.unmount();
        cases++;
      }
  console.log(`entry-create-ui selftest: ${cases} checks passed`);
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
