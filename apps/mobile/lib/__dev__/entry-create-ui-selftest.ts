// Execute the real entry modal with controlled native/session/storage edges.
// Delayed admissions remain durable; feedback belongs only to its tap's screen.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { normalizeAmountInput, parseAmountInput } from "../money";
import { ENTRY_NOTE_MAX_LENGTH } from "../types";

type PlatformOS = "android" | "ios";
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
  useIsRTL: () => rtl,
  textDir: () => ({ textAlign: rtl ? "right" : "left", writingDirection: rtl ? "rtl" : "ltr" }),
  trackingSafe: () => ({}),
});

class SessionChangedError extends Error {}
class RoleGateRejectionError extends Error {}
class EventSigningUnavailableError extends Error {}
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
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string"
      ? node
      : node?.props
        ? words(node.props.children)
        : "";

function fixture({ os = "android", rtl = false }: { os?: PlatformOS; rtl?: boolean } = {}) {
  const hooks = uiHooks(),
    routes: any[] = [],
    notices: any[] = [],
    queued: any[] = [],
    writes: any[] = [];
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
  let timerID = 0,
    keyboardFocuses = 0,
    overLimit = false;
  const Screen = compileUI(
    "../../app/entry/new",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: hooks.react,
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
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: os },
        ScrollView: "ScrollView",
        StyleSheet: { create: (s: any) => s },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../../components/Button": { Button: "Button" },
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
      "../../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
      "../../lib/db": {
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
      "../../lib/fonts": fontEdges[os],
      "../../lib/i18n": { t: (key: string) => key },
      "../../lib/money": { normalizeAmountInput, parseAmountInput },
      "../../lib/credit-limits": { creditWarning: async () => overLimit },
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
    },
  ).default;
  const render = () => hooks.render(Screen);
  const button = () => nodes(hooks.tree).find((n) => n.type === "Button")!;
  const input = () => nodes(hooks.tree).find((n) => n.type === "TextInput")!;
  const note = () =>
    nodes(hooks.tree).find(
      (n) => n.type === "TextInput" && n.props.accessibilityLabel === "entry.note.label",
    )!;
  const flush = async () => {
    await settleUI();
    render();
  };
  async function ready() {
    render();
    await flush();
    input().props.onChangeText("125.50");
    render();
    input().props.ref.current = { focus: () => keyboardFocuses++ };
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
    render,
    flush,
    ready,
    button,
    input,
    note,
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
    setOverLimit: (value: boolean) => {
      overLimit = value;
    },
    get keyboardFocuses() {
      return keyboardFocuses;
    },
  };
}

// The edit screen has a different storage edge, but uses the same real form
// controls. Keep this fixture limited to loading and saving an editable entry.
function editFixture(os: PlatformOS, rtl: boolean, initialNote: string) {
  const hooks = uiHooks(),
    routes: string[] = [],
    writes: any[] = [];
  const Screen = compileUI(
    "../../app/entry/[id]/edit",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      react: hooks.react,
      "expo-router": {
        useRouter: () => ({ back: () => routes.push("back") }),
        useLocalSearchParams: () => ({ id: "entry" }),
      },
      "react-native": {
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: os },
        ScrollView: "ScrollView",
        StyleSheet: { create: (value: any) => value },
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../../../components/Button": { Button: "Button" },
      "../../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
      "../../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
      "../../../components/Toast": { useToast: () => ({ push: () => {} }) },
      "../../../lib/colors": { colors: require("../colors").colors },
      "../../../lib/credit-limits": { creditWarningForEdit: async () => false },
      "../../../lib/currency": { getCurrentCurrencySymbol: () => "AFN" },
      "../../../lib/db": {
        getEntry: async () => ({
          id: "entry",
          relationship_id: "relationship",
          type: "debt",
          amount_afn: 125.5,
          note: initialNote,
        }),
        updateEntry: async (...args: any[]) => {
          writes.push(args);
        },
        SettledChapterError: class extends Error {},
        TabLinkedEntryError: class extends Error {},
      },
      "../../../lib/direction": directionEdges(rtl),
      "../../../lib/event-log": { EventSigningUnavailableError, RoleGateRejectionError },
      "../../../lib/fonts": fontEdges[os],
      "../../../lib/i18n": { t: (key: string) => key },
      "../../../lib/money": { normalizeAmountInput, parseAmountInput },
      "../../../lib/tabs/db": { getTabLinkForRelationship: async () => null },
      "../../../lib/tokens": { radius: {} },
      "../../../lib/types": { ENTRY_NOTE_MAX_LENGTH },
    },
    {
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
  ).default;
  const render = () => hooks.render(Screen);
  const input = () => nodes(hooks.tree).find((node) => node.type === "TextInput")!;
  const note = () =>
    nodes(hooks.tree).find(
      (node) => node.type === "TextInput" && node.props.accessibilityLabel === "entry.note.label",
    )!;
  const button = () => nodes(hooks.tree).find((node) => node.type === "Button")!;
  return {
    hooks,
    routes,
    writes,
    render,
    input,
    note,
    button,
    ready: async () => {
      render();
      await settleUI();
      render();
    },
  };
}

function assertMultilineForm(
  form: Pick<ReturnType<typeof fixture>, "hooks" | "input" | "note" | "button" | "writes">,
  os: PlatformOS,
  rtl: boolean,
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
  assert.ok(Number.isFinite(style.maxHeight) && style.maxHeight > style.minHeight);
  assert.equal(style.height, undefined, "the textarea can grow before scrolling");
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
  assert.equal(avoider.props.enabled, os === "android");
  assert.equal(scroll.props.automaticallyAdjustKeyboardInsets, os === "ios");
  assert.equal(scroll.props.keyboardShouldPersistTaps, "handled");
  assert.ok(
    nodes(scroll).includes(note) && nodes(scroll).includes(form.button()),
    "Note and Save stay in the same scrollable form",
  );
  assert.equal(flattenStyle(scroll.props.contentContainerStyle).flexGrow, 1);
}

const savedNotes: [string, string][] = [];
async function main() {
  let cases = 0;
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
        assertMultilineForm(f, os, rtl);
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
