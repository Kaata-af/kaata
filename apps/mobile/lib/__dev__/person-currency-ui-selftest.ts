// Execute the real contact Edit route with scoped, delayed local boundaries.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { getCurrencyNameForLocale } from "../currency-catalog";
import { ltrIsolate } from "../bidi";

class SessionChangedError extends Error {}
class RoleGateRejectionError extends Error {}
class EventSigningUnavailableError extends Error {}
const symbols: Record<string, string> = { AFN: "؋", USD: "$", EUR: "€" };
const currencyLabel = (code: string) => (symbols[code] ? `${code} ${symbols[code]}` : code);
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string"
      ? node
      : node?.props
        ? words(node.props.children)
        : "";

function fixture({
  locale = "en",
  os = "ios",
  override = null,
  enabled = ["AFN", "USD", "EUR"],
}: {
  locale?: "en" | "fa" | "ps";
  os?: "ios" | "android";
  override?: string | null;
  enabled?: string[];
} = {}) {
  const hooks = uiHooks();
  let params = { id: "customer" },
    vault = "vault",
    account: string | null = "account",
    install = "install";
  let role = true,
    active = true,
    bindingVersion = 1;
  let startFocus: (() => void | (() => void)) | undefined, cleanupFocus: (() => void) | undefined;
  let readGate: ReturnType<typeof deferred<string | null>> | undefined;
  let saveGate: ReturnType<typeof deferred<void>> | undefined;
  let captureGate: ReturnType<typeof deferred<void>> | undefined;
  let saveError: Error | undefined;
  const reads: any[] = [],
    calls: any[] = [],
    commits: any[] = [],
    routes: any[] = [],
    notices: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0,
    dismissals = 0;
  const language = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: locale }] },
    "./db": { getAppMeta: async () => null },
  }) as typeof import("../i18n");
  const Screen = compileUI(
    "../../app/person/[id]/edit",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "expo-router": {
        useRouter: () => ({
          back: () => routes.push("back"),
          replace: (to: any) => routes.push(to),
          push: (to: any) => routes.push(to),
        }),
        useLocalSearchParams: () => params,
        useFocusEffect: (fn: () => void | (() => void)) =>
          hooks.react.useEffect(() => {
            startFocus = fn;
            if (active) cleanupFocus = fn() || undefined;
            return () => {
              cleanupFocus?.();
              cleanupFocus = undefined;
            };
          }, [fn]),
      },
      "react-native": {
        Keyboard: {
          dismiss: () => {
            dismissals++;
          },
        },
        KeyboardAvoidingView: "KeyboardAvoidingView",
        Platform: { OS: os },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        TextInput: "TextInput",
        View: "View",
        StyleSheet: { create: (value: any) => value },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "../../../components/BottomSheet": { BottomSheet: "BottomSheet" },
      "../../../components/Button": { Button: "Button" },
      "../../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
      "../../../components/CountryPickerSheet": { CountryPickerSheet: "CountryPickerSheet" },
      "../../../components/OptionSheet": { OptionSheet: "OptionSheet" },
      "../../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
      "../../../components/SettingsScreen": { NavRow: "NavRow", ScreenHeader: "ScreenHeader" },
      "../../../components/Toast": {
        useToast: () => ({ push: (...args: any[]) => notices.push(args) }),
        queuePendingToast: () => {},
      },
      "../../../lib/colors": require("../colors"),
      "../../../lib/design-tokens": require("../design-tokens"),
      "../../../lib/contacts-sync": {
        splitName: (name: string) => {
          const [firstName, ...last] = name.split(" ");
          return { firstName, lastName: last.join(" ") };
        },
      },
      "../../../lib/db-tx": {
        getActiveVaultIdSyncMaybe: () => vault,
        getAccountIdSync: () => account,
        getInstallIdSync: () => install,
      },
      "../../../lib/auth": {
        SessionChangedError,
        captureCurrentSession: async () => {
          const session = { accountId: account, bindingVersion, jwt: "session" };
          if (captureGate) await captureGate.promise;
          return session;
        },
      },
      "../../../lib/db": {
        getPerson: async (id: string) => ({ id, name: `Ahmad ${vault}`, phone: "+93700123456" }),
        archivePerson: async (...args: any[]) => calls.push(args),
        updatePerson: async (...args: any[]) => {
          calls.push(args);
          if (saveGate) await saveGate.promise;
          const expected = args[5];
          if (
            !expected.shouldContinue() ||
            expected.vaultId !== vault ||
            expected.session.accountId !== account ||
            expected.session.bindingVersion !== bindingVersion
          )
            throw new SessionChangedError();
          if (saveError) throw saveError;
          if (expected.defaultCurrency !== undefined) {
            assert.equal(expected.expectedDefaultCurrency, override);
            if (expected.defaultCurrency !== null && !enabled.includes(expected.defaultCurrency))
              throw new Error("disabled currency");
            override = expected.defaultCurrency;
          }
          commits.push(args);
          return { ok: true };
        },
      },
      "../../../lib/person-currency": {
        getPersonDefaultCurrency: async (requestedVault: string, requestedPerson: string) => {
          reads.push([requestedVault, requestedPerson]);
          const gate = readGate;
          readGate = undefined;
          return gate ? gate.promise : override;
        },
      },
      "../../../lib/currency": {
        getEnabledCurrencies: async () => enabled,
        getDefaultEntryCurrency: async () => "AFN",
        getCurrencyLabel: currencyLabel,
        getCurrencyName: (code: string) => getCurrencyNameForLocale(code, locale),
      },
      "../../../lib/direction": {
        ltrIsolate,
        useIsRTL: () => locale !== "en",
        textDir: () => ({}),
        rowDir: () => ({ flexDirection: locale === "en" ? "row" : "row-reverse" }),
      },
      "../../../lib/event-log": { RoleGateRejectionError, EventSigningUnavailableError },
      "../../../lib/fonts": { fonts: {} },
      "../../../lib/i18n": language,
      "../../../lib/phone": {
        getCountry: () => ({ code: "AF", dialCode: "+93", flag: "AF" }),
        getCurrentDefaultCountryCode: () => "AF",
        inferCountryFromE164: () => "AF",
      },
      "../../../lib/tokens": { icon: {}, radius: {}, TOUCH_MIN: 44 },
      "../../../lib/use-customer-groups": {
        useCustomerGroups: () => ({ groups: [], groupsByPerson: {} }),
      },
      "../../../lib/use-vault-role": {
        useActiveVaultWriteCaps: () => ({ resolved: true, canAmend: role }),
      },
    },
    {
      setTimeout: (fn: () => void) => {
        const id = ++timerId;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ).default;
  const render = () => hooks.render(Screen);
  const flush = async () => {
    await settleUI();
    render();
  };
  const find = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!;
  const field = () =>
    nodes(hooks.tree).find(
      (node) =>
        node.type === "NavRow" && node.props.label === language.t("personEdit.currency.label"),
    )!;
  const picker = () => find("OptionSheet");
  const save = () => find("Button");
  const input = () =>
    nodes(hooks.tree).find(
      (node) =>
        node.type === "TextInput" &&
        node.props.accessibilityLabel === language.t("personEdit.firstName.label"),
    )!;
  const open = () => {
    field().props.onPress();
    render();
    return picker();
  };
  const choose = (code: string) => {
    open().props.onSelect(code);
    render();
  };
  const blur = () => {
    active = false;
    cleanupFocus?.();
    cleanupFocus = undefined;
  };
  const change = (
    kind: "account" | "vault" | "person" | "install" | "role" | "blur" | "unmount" | "session",
  ) => {
    if (kind === "account") account = "other-account";
    else if (kind === "vault") vault = "other-vault";
    else if (kind === "person") params = { id: "other-person" };
    else if (kind === "install") install = "other-install";
    else if (kind === "role") role = false;
    else if (kind === "session") bindingVersion++;
    else if (kind === "blur") blur();
    else {
      blur();
      hooks.unmount();
      return;
    }
    render();
  };
  return {
    hooks,
    reads,
    calls,
    commits,
    routes,
    notices,
    language,
    render,
    flush,
    find,
    field,
    picker,
    save,
    input,
    open,
    choose,
    change,
    ready: async () => {
      render();
      await flush();
    },
    delayedRead: () => (readGate = deferred<string | null>()),
    delayedSave: () => (saveGate = deferred<void>()),
    delayedCapture: () => (captureGate = deferred<void>()),
    failSave: (error?: Error) => {
      saveError = error;
    },
    refocus: () => {
      active = true;
      cleanupFocus = startFocus?.() || undefined;
      render();
    },
    runFocusTimers: () => {
      for (const [id, run] of [...timers]) {
        timers.delete(id);
        run();
      }
    },
    get stored() {
      return override;
    },
    get dismissals() {
      return dismissals;
    },
  };
}

async function main() {
  let cases = 0;
  for (const locale of ["en", "fa", "ps"] as const)
    for (const os of ["ios", "android"] as const) {
      const f = fixture({ locale, os });
      await f.ready();
      assert.deepEqual(f.reads, [["vault", "customer"]]);
      assert.ok(
        f.find("ScrollView"),
        "short screens can scroll the extra field and Save above the keyboard",
      );
      assert.equal(f.field().props.disabled, false);
      assert.equal(f.field().props.trailing, f.language.t("personEdit.currency.inherited"));
      assert.equal(f.field().props.hint, undefined, "the compact row has no generic visible hint");
      assert.equal(f.field().props.accessibilityHint, f.language.t("personEdit.currency.hint"));
      assert.ok(
        f.field().props.accessibilityLabel.includes("AFN ؋"),
        "the full inherited currency remains announced",
      );
      const picker = f.open();
      assert.equal(picker.props.isRTL, locale !== "en");
      assert.deepEqual(
        picker.props.options.map((o: any) => o.key),
        ["kaata-default", "AFN", "USD", "EUR"],
      );
      assert.equal(
        picker.props.options[0].label,
        f.language.t("personEdit.currency.inherit", { currency: "AFN ؋" }),
      );
      picker.props.onSelect("USD");
      f.render();
      assert.equal(f.stored, null, "picker changes remain a draft before Save");
      assert.equal(f.field().props.trailing, "USD $");
      f.input().props.onChangeText("Nadia");
      f.render();
      await f.save().props.onPress();
      assert.equal(f.commits.length, 1);
      assert.equal(f.commits[0][1], "Nadia");
      assert.equal(f.commits[0][5].defaultCurrency, "USD");
      assert.equal(f.commits[0][5].expectedDefaultCurrency, null);
      assert.equal(f.commits[0][5].vaultId, "vault");
      assert.equal(f.stored, "USD");
      assert.deepEqual(f.routes, ["back"]);
      f.hooks.unmount();
      cases++;
    }
  {
    const f = fixture({ override: "USD" });
    await f.ready();
    const picker = f.open();
    picker.props.onDismiss();
    f.render();
    assert.equal(f.field().props.trailing, "USD $");
    assert.equal(f.stored, "USD");
    f.choose("kaata-default");
    await f.save().props.onPress();
    assert.equal(f.commits[0][5].defaultCurrency, null);
    assert.equal(f.commits[0][5].expectedDefaultCurrency, "USD");
    assert.equal(f.stored, null);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.choose("USD");
    f.find("ScreenHeader").props.onBack();
    assert.equal(f.commits.length, 0);
    assert.equal(f.stored, null);
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
    cases++;
  }
  for (const override of [null, "USD"] as const) {
    const f = fixture({ override, enabled: ["AFN"] });
    await f.ready();
    assert.equal(
      f.field().props.disabled,
      override === null,
      "single-currency inheritance needs no picker, but a stored override stays clearable",
    );
    if (override) {
      assert.equal(f.field().props.trailing, "USD $");
      assert.equal(
        f.field().props.hint,
        f.language.t("personEdit.currency.unavailable", { currency: "USD $" }),
      );
      assert.deepEqual(
        f.open().props.options.map((o: any) => o.key),
        ["kaata-default", "AFN"],
      );
      f.picker().props.onDismiss();
      f.render();
    }
    f.input().props.onChangeText("Changed");
    f.render();
    await f.save().props.onPress();
    assert.equal(
      "defaultCurrency" in f.commits[0][5],
      false,
      "unrelated Save leaves a dormant preference and its timestamp untouched",
    );
    assert.equal("expectedDefaultCurrency" in f.commits[0][5], false);
    assert.equal(f.stored, override);
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    const oldPicker = f.open();
    oldPicker.props.onDismiss();
    f.render();
    const fresh = f.open();
    oldPicker.props.onSelect("EUR");
    f.render();
    assert.equal(f.picker().props.visible, true);
    assert.equal(f.picker().props.selected, "kaata-default");
    fresh.props.onSelect("JPY");
    f.render();
    assert.equal(
      f.picker().props.visible,
      true,
      "retained or disabled codes cannot enter the draft",
    );
    fresh.props.onSelect("USD");
    f.render();
    const retained = f.open();
    const gate = f.delayedSave();
    const save = f.save().props.onPress;
    const pending = save();
    void save();
    retained.props.onSelect("EUR");
    await f.flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.picker().props.visible, false);
    assert.equal(f.save().props.disabled, true);
    gate.resolve();
    await pending;
    assert.equal(f.commits[0][5].defaultCurrency, "USD");
    f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    await f.ready();
    f.choose("USD");
    f.failSave(new Error("synthetic transaction failure"));
    await f.save().props.onPress();
    f.render();
    assert.equal(f.commits.length, 0);
    assert.equal(f.stored, null);
    assert.equal(f.routes.length, 0);
    assert.equal(f.field().props.trailing, "USD $");
    assert.ok(words(f.hooks.tree).includes(f.language.t("entry.saveFailed")));
    f.failSave();
    await f.save().props.onPress();
    assert.equal(f.commits.length, 1);
    assert.equal(f.stored, "USD");
    f.hooks.unmount();
    cases++;
  }
  for (const kind of [
    "account",
    "vault",
    "person",
    "install",
    "role",
    "blur",
    "unmount",
  ] as const) {
    const f = fixture();
    await f.ready();
    const picker = f.open();
    const save = f.save().props.onPress;
    f.change(kind);
    picker.props.onSelect("USD");
    await save();
    assert.equal(
      f.calls.length,
      0,
      `${kind}: retained picker/Save cannot mutate a different scope or readonly route`,
    );
    assert.equal(f.hooks.lateWrites, 0);
    if (kind !== "unmount") f.hooks.unmount();
    cases++;
  }
  for (const kind of [
    "account",
    "vault",
    "person",
    "install",
    "role",
    "blur",
    "unmount",
    "session",
  ] as const) {
    const f = fixture();
    await f.ready();
    f.choose("USD");
    const gate = f.delayedSave();
    const pending = f.save().props.onPress();
    await f.flush();
    f.change(kind);
    gate.resolve();
    await pending;
    assert.equal(f.commits.length, 0, `${kind}: transaction preflight refuses a stale queued Save`);
    assert.equal(f.routes.length, 0);
    assert.equal(f.notices.length, 0);
    assert.equal(f.hooks.lateWrites, 0);
    if (kind !== "unmount") f.hooks.unmount();
    cases++;
  }
  {
    const f = fixture();
    const read = f.delayedRead();
    f.render();
    await f.flush();
    f.change("vault");
    await f.flush();
    assert.equal(f.field().props.trailing, f.language.t("personEdit.currency.inherited"));
    read.resolve("USD");
    await f.flush();
    assert.equal(f.field().props.trailing, f.language.t("personEdit.currency.inherited"));
    assert.deepEqual(f.reads, [
      ["vault", "customer"],
      ["other-vault", "customer"],
    ]);
    f.choose("EUR");
    let firstNameFocuses = 0;
    f.input().props.ref.current = {
      focus: () => {
        firstNameFocuses++;
      },
    };
    f.runFocusTimers();
    assert.equal(firstNameFocuses, 1);
    f.change("blur");
    f.refocus();
    await f.flush();
    f.runFocusTimers();
    assert.equal(firstNameFocuses, 1, "returning from Groups does not reopen the name keyboard");
    assert.equal(
      f.field().props.trailing,
      "EUR €",
      "returning from a child route preserves the unsaved form",
    );
    await f.save().props.onPress();
    assert.equal(f.stored, "EUR", "first tap after refocus uses current guards");
    f.hooks.unmount();
    cases++;
  }
  console.log(
    `PASS contact currency UI: ${cases} scoped Edit cases, EN/FA/PS on iOS/Android, inherited/enabled/dormant defaults, draft Save/Cancel, atomic request, double taps, rollback/retry, role/session/unmount and late-read guards`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
