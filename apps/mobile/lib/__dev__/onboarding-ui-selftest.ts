// The real onboarding presentation and final handoff, with native/storage
// boundaries only. No account, database, network or build is touched.
import assert from "node:assert/strict";
import { colors } from "../colors";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const native = {
  ActivityIndicator: "Spinner",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
};
const tokens = compileUI("../tokens", {
  "./fonts": {
    fonts: {},
    sansLineHeight: (_size: number, height: number) => height,
    monoLineHeight: (_size: number, height: number) => height,
  },
});
const renderJSX = (type: any, props: any): any =>
  typeof type === "function" ? type(props) : jsx(type, props);
const jsxRuntime = { jsx: renderJSX, jsxs: renderJSX, Fragment: "Fragment" };

function presentation(rtl: boolean) {
  const direction = {
    useIsRTL: () => rtl,
    rowDir: (value: boolean) => ({ flexDirection: value ? "row-reverse" : "row" }),
    textDir: (value: boolean) => ({
      textAlign: value ? "right" : "left",
      writingDirection: value ? "rtl" : "ltr",
    }),
  };
  const i18n = {
    t: (key: string) => (key === "common.back" ? (rtl ? "برگشت" : "Back") : key),
  };
  return {
    direction,
    i18n,
    ui: compileUI("../../components/Onboarding", {
      "react/jsx-runtime": jsxRuntime,
      "@expo/vector-icons": { Ionicons: "Icon" },
      "react-native": native,
      "../lib/colors": { colors },
      "../lib/direction": direction,
      "../lib/i18n": i18n,
      "../lib/tokens": tokens,
    }),
  };
}

function controls() {
  for (const rtl of [false, true]) {
    const { ui } = presentation(rtl);
    let returns = 0;
    const header = ui.OnboardingHeader({ onBack: () => returns++ });
    const back = nodes(header).find((node) => node.type === "Pressable")!;
    const style = flattenStyle(back.props.style({ pressed: false }));
    const icon = nodes(back).find((node) => node.type === "Icon")!;
    assert.equal(flattenStyle(header.props.style).flexDirection, rtl ? "row-reverse" : "row");
    assert.equal(style.flexDirection, rtl ? "row-reverse" : "row", "Back mirrors its own content");
    assert.equal(icon.props.name, rtl ? "chevron-forward" : "chevron-back");
    assert.ok(style.minWidth >= 44 && style.minHeight >= 44, "Back has a complete touch target");
    assert.equal(back.props.accessibilityLabel, rtl ? "برگشت" : "Back");
    assert.equal(back.props.accessibilityRole, "button");
    back.props.onPress();
    assert.equal(returns, 1);

    const disabled = nodes(ui.OnboardingHeader({ onBack: () => {}, disabled: true })).find(
      (node) => node.type === "Pressable",
    )!;
    assert.equal(disabled.props.disabled, true);
    assert.equal(disabled.props.accessibilityState.disabled, true);
    assert.ok(!nodes(ui.OnboardingHeader({})).some((node) => node.type === "Pressable"));

    for (const variant of ["primary", "outline", "ghost"]) {
      for (const loading of [false, true]) {
        const action = ui.OnboardingAction({
          label: "Continue",
          onPress: () => {},
          variant,
          loading,
        });
        const actionStyle = flattenStyle(action.props.style({ pressed: false }));
        assert.ok(actionStyle.minHeight >= 44, "Every action clears the touch floor");
        assert.equal(action.props.accessibilityState.busy, loading);
        assert.equal(action.props.disabled, loading);
        assert.equal(action.props.accessibilityState.disabled, loading);
        const label = nodes(action).find((node) => node.type === "Text")!;
        assert.equal(label.props.children, "Continue", "Loading retains the label and its height");
        assert.equal(label.props.numberOfLines, undefined, "Long translations can wrap");
        if (variant !== "ghost") {
          assert.notEqual(flattenStyle(label.props.style).color, actionStyle.backgroundColor);
        }
      }
    }
    const disabledAction = ui.OnboardingAction({
      label: "Continue",
      onPress: () => {},
      disabled: true,
    });
    assert.equal(disabledAction.props.disabled, true);
  }
}

function successFixture(
  options: {
    rtl?: boolean;
    name?: string;
    storedName?: string;
    pending?: string;
    failRead?: boolean;
    waitForToken?: Promise<void>;
  } = {},
) {
  const hooks = uiHooks();
  const { ui, direction, i18n } = presentation(options.rtl ?? false);
  const meta = new Map<string, string>([
    ["pending_tab_token", options.pending ?? ""],
    ["pending_tab_currency", "USD"],
  ]);
  const writes: [string, string][] = [];
  const routes: unknown[] = [];
  let tokenReads = 0;
  let vaultCreations = 0;
  const Screen = compileUI("../../app/onboarding/success", {
    "react/jsx-runtime": jsxRuntime,
    react: hooks.react,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": {
      useRouter: () => ({ replace: (value: unknown) => routes.push(value) }),
      useLocalSearchParams: () => ({ name: options.name }),
    },
    "react-native": native,
    "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
    "../../components/Onboarding": ui,
    "../../lib/colors": { colors },
    "../../lib/direction": direction,
    "../../lib/i18n": i18n,
    "../../lib/tokens": tokens,
    "../../lib/db": {
      getLocalSelf: async () => ({ shop_name: options.storedName }),
      getAppMeta: async (key: string) => {
        if (key === "pending_tab_token") {
          tokenReads++;
          if (options.waitForToken) await options.waitForToken;
          if (options.failRead) throw new Error("Synthetic read failure");
        }
        return meta.get(key) ?? null;
      },
      setAppMeta: async (key: string, value: string) => {
        writes.push([key, value]);
        meta.set(key, value);
      },
      createSelfProfile: async () => vaultCreations++,
    },
  }).default;
  const render = () => hooks.render(Screen);
  render();
  return {
    hooks,
    meta,
    writes,
    routes,
    render,
    action: () =>
      nodes(hooks.tree).find((node) => node.props.accessibilityLabel === "onboardingSuccess.cta")!,
    get tokenReads() {
      return tokenReads;
    },
    get vaultCreations() {
      return vaultCreations;
    },
    flush: async () => {
      await settleUI();
      render();
    },
  };
}

function kaataFixture(
  options: {
    rtl?: boolean;
    pending?: string;
    stashedCurrency?: string;
    preview?: Promise<{ tab: { currency: string } }>;
  } = {},
) {
  const hooks = uiHooks();
  const { ui, direction, i18n } = presentation(options.rtl ?? false);
  const handlers = new Set<() => boolean>();
  const routes: unknown[] = [];
  const creations: unknown[][] = [];
  const meta = new Map<string, string>([
    ["onboarding_self_name", "Ahmad"],
    ["onboarding_self_phone", "+93700000001"],
    ["pending_tab_token", options.pending ?? ""],
    ["pending_tab_currency", options.stashedCurrency ?? ""],
  ]);
  let createGate: Promise<void> | null = null;
  let failBack = false;
  const router = { replace: (route: unknown) => routes.push(route) };
  const Screen = compileUI("../../app/onboarding/kaata", {
    "react/jsx-runtime": jsxRuntime,
    react: hooks.react,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": {
      useRouter: () => router,
      useFocusEffect: (effect: () => any) => hooks.react.useEffect(effect, [effect]),
    },
    "react-native": {
      ...native,
      Keyboard: { dismiss: () => {} },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      TextInput: "TextInput",
      Platform: { OS: "android" },
      BackHandler: {
        addEventListener: (_event: string, handler: () => boolean) => {
          handlers.add(handler);
          return { remove: () => handlers.delete(handler) };
        },
      },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
    "../../components/Onboarding": ui,
    "../../components/FormField": { FormField: "FormField" },
    "../../components/OptionSheet": { OptionSheet: "OptionSheet" },
    "../../lib/colors": { colors },
    "../../lib/direction": { ...direction, bidiIsolate: (value: string) => value },
    "../../lib/i18n": i18n,
    "../../lib/tokens": tokens,
    "../../lib/auth": {
      getSessionJWT: async () => (options.pending ? "jwt" : null),
      updateAccountPhone: async () => {},
    },
    "../../lib/currency": {
      CURRENCIES: [
        { code: "AFN", symbol: "؋" },
        { code: "USD", symbol: "$" },
        { code: "EUR", symbol: "€" },
      ],
      DEFAULT_CURRENCY: "AFN",
      getCurrencyName: (code: string) => code,
    },
    "../../lib/db": {
      getAppMeta: async (key: string) => meta.get(key) ?? null,
      setAppMeta: async (key: string, value: string) => {
        if (failBack && key === "onboarding_step" && value === "profile")
          throw new Error("Synthetic Back failure");
        meta.set(key, value);
      },
      createSelfProfile: async (...args: unknown[]) => {
        creations.push(args);
        if (createGate) await createGate;
      },
    },
    "../../lib/event-log": { EventSigningUnavailableError: class extends Error {} },
    "../../lib/tabs/link": {
      fetchTabPreview: async () => {
        if (options.preview) return options.preview;
        throw new Error("No invitation");
      },
    },
    "../../lib/use-onboarding-keyboard-scroll": {
      useOnboardingKeyboardScroll: () => ({
        scrollProps: {},
        focusInput: () => {},
        blurInput: () => {},
      }),
    },
  }).default;
  const render = () => hooks.render(Screen);
  render();
  return {
    hooks,
    routes,
    creations,
    meta,
    handlers,
    render,
    back: () => nodes(hooks.tree).find((node) => node.props.accessibilityLabel === "Back")!,
    create: () =>
      nodes(hooks.tree).find((node) => node.props.accessibilityLabel === "onboardingKaata.submit")!,
    field: () => nodes(hooks.tree).find((node) => node.type === "FormField")!,
    defaultSheet: () => nodes(hooks.tree).find((node) => node.type === "OptionSheet")!,
    defaultField: () =>
      nodes(hooks.tree).find(
        (node) =>
          node.type === "Pressable" &&
          node.props.accessibilityLabel?.startsWith("onboardingKaata.currency.label:"),
      )!,
    gate: (promise: Promise<void>) => {
      createGate = promise;
    },
    failBack: (value: boolean) => {
      failBack = value;
    },
    flush: async () => {
      await settleUI();
      render();
    },
  };
}

async function main() {
  controls();
  for (const rtl of [false, true]) {
    const success = successFixture({ rtl, name: "Ahmad Grocery" });
    await success.flush();
    const icon = nodes(success.hooks.tree).find(
      (node) => node.props.name === "checkmark-circle-outline",
    )!;
    assert.ok(icon, "Success renders a recognizable outlined confirmation");
    assert.notEqual(icon.props.color, colors.bgDefault, "The confirmation contrasts with the page");
    assert.ok(nodes(success.hooks.tree).some((node) => node.props.children === "Ahmad Grocery"));
    success.action().props.onPress();
    await success.flush();
    assert.deepEqual(success.routes, ["/"]);
    assert.deepEqual(success.writes, [], "Confirmation does not create or rewrite a kaata");
    assert.equal(success.vaultCreations, 0);
  }

  const pendingRead = deferred<void>();
  const linked = successFixture({ pending: "shared-ledger", waitForToken: pendingRead.promise });
  const continueButton = linked.action();
  continueButton.props.onPress();
  continueButton.props.onPress();
  linked.render();
  assert.equal(linked.tokenReads, 1, "Repeated taps consume an invitation only once");
  assert.equal(linked.action().props.disabled, true);
  pendingRead.resolve();
  await linked.flush();
  assert.deepEqual(linked.routes, [{ pathname: "/t/[token]", params: { token: "shared-ledger" } }]);
  assert.deepEqual(linked.writes, [
    ["pending_tab_token", ""],
    ["pending_tab_currency", ""],
  ]);
  assert.equal(linked.vaultCreations, 0);

  const restoredName = successFixture({ name: "  ", storedName: "نام دکان" });
  await restoredName.flush();
  assert.ok(nodes(restoredName.hooks.tree).some((node) => node.props.children === "نام دکان"));

  const fallback = successFixture({ failRead: true });
  fallback.action().props.onPress();
  await fallback.flush();
  assert.deepEqual(fallback.routes, ["/"], "A missing optional invitation never traps setup");
  assert.equal(fallback.vaultCreations, 0);

  const lateRead = deferred<void>();
  const abandoned = successFixture({ name: "Ready kaata", waitForToken: lateRead.promise });
  abandoned.action().props.onPress();
  abandoned.hooks.unmount();
  lateRead.resolve();
  await settleUI();
  assert.deepEqual(
    abandoned.routes,
    [],
    "A completed old callback cannot reopen a departed screen",
  );
  assert.equal(abandoned.hooks.lateWrites, 0);

  for (const rtl of [false, true]) {
    const draft = kaataFixture({ rtl });
    await draft.flush();
    assert.equal(draft.defaultSheet().props.title, "onboardingKaata.currency.label");
    assert.deepEqual(
      draft.defaultSheet().props.options.map((option: { key: string }) => option.key),
      ["AFN", "USD", "EUR"],
    );
    assert.equal(
      nodes(draft.hooks.tree).some((node) => node.type === "EnabledCurrenciesSheet"),
      false,
      "onboarding has no enabled-currencies sheet",
    );
    assert.equal(
      nodes(draft.hooks.tree).some((node) =>
        node.props.accessibilityLabel?.startsWith("vaultSettings.currencies.label:"),
      ),
      false,
      "onboarding keeps only its single currency field",
    );
    draft.defaultField().props.onPress();
    draft.render();
    assert.equal(draft.defaultSheet().props.visible, true);
    assert.equal(draft.defaultSheet().props.isRTL, rtl);
    assert.equal(draft.defaultSheet().props.selected, "AFN");
    draft.defaultSheet().props.onSelect("INVALID");
    draft.render();
    assert.equal(
      draft.defaultSheet().props.selected,
      "AFN",
      "unknown currency choices are ignored",
    );
    const cancelledDraft = draft.defaultSheet().props;
    cancelledDraft.onDismiss();
    draft.render();
    draft.defaultField().props.onPress();
    draft.render();
    cancelledDraft.onSelect("USD");
    cancelledDraft.onDismiss();
    draft.render();
    assert.equal(
      draft.defaultSheet().props.visible,
      true,
      "callbacks from an old sheet cannot close a new one",
    );
    assert.equal(
      draft.defaultSheet().props.selected,
      "AFN",
      "stale picker callbacks cannot alter the current choice",
    );
    draft.defaultSheet().props.onSelect("USD");
    draft.render();
    assert.equal(draft.defaultSheet().props.visible, false);
    assert.ok(draft.defaultField().props.accessibilityLabel.includes("USD"));
    draft.defaultField().props.onPress();
    draft.render();
    assert.equal([...draft.handlers][0](), true);
    draft.render();
    assert.equal(draft.defaultSheet().props.visible, false);
    assert.deepEqual(draft.routes, [], "Back dismisses the currency picker before leaving setup");
    assert.equal(draft.defaultSheet().props.selected, "USD");
    draft.hooks.unmount();
  }

  const preset = kaataFixture({
    pending: "shared",
    stashedCurrency: "USD",
    preview: Promise.resolve({ tab: { currency: "EUR" } }),
  });
  await preset.flush();
  await preset.flush();
  assert.equal(preset.defaultSheet().props.selected, "EUR");
  assert.ok(
    preset.defaultField().props.accessibilityLabel.includes("EUR"),
    "the pending link still presets the single currency field",
  );
  preset.hooks.unmount();
  {
    const latePreset = deferred<{ tab: { currency: string } }>();
    const editing = kaataFixture({ pending: "shared", preview: latePreset.promise });
    await editing.flush();
    editing.defaultField().props.onPress();
    editing.render();
    latePreset.resolve({ tab: { currency: "USD" } });
    await editing.flush();
    assert.equal(
      editing.defaultSheet().props.selected,
      "AFN",
      "opening the currency picker takes ownership before a late preset resolves",
    );
    assert.equal(editing.defaultSheet().props.visible, true);
    editing.defaultSheet().props.onDismiss();
    await editing.flush();
    assert.equal(
      editing.defaultSheet().props.selected,
      "AFN",
      "dismissing still preserves the user's currency intent",
    );
    editing.hooks.unmount();
  }

  const saved = kaataFixture();
  await saved.flush();
  saved.defaultField().props.onPress();
  saved.render();
  saved.defaultSheet().props.onSelect("USD");
  saved.render();
  saved.field().props.onChangeText("  Family kaata  ");
  saved.render();
  const committing = deferred<void>();
  saved.gate(committing.promise);
  const create = saved.create(),
    staleBack = saved.back(),
    staleDefaultField = saved.defaultField(),
    staleDefaultSheet = saved.defaultSheet().props,
    staleNameChange = saved.field().props.onChangeText;
  const created = create.props.onPress();
  create.props.onPress();
  await staleBack.props.onPress();
  assert.equal([...saved.handlers][0](), true);
  saved.render();
  assert.equal(saved.back().props.disabled, true);
  staleDefaultSheet.onSelect("EUR");
  staleDefaultField.props.onPress();
  staleNameChange("Changed while saving");
  saved.render();
  assert.equal(saved.defaultSheet().props.visible, false);
  assert.equal(saved.defaultField().props.disabled, true);
  assert.equal(saved.field().props.value, "  Family kaata  ");
  assert.deepEqual(
    saved.creations,
    [["Ahmad", "Family kaata", "+93700000001", "USD"]],
    "onboarding creates with exactly four arguments and its selected single currency",
  );
  assert.deepEqual(
    saved.routes,
    [],
    "Create and either Back path cannot navigate against each other",
  );
  committing.resolve();
  await created;
  assert.deepEqual(saved.routes, [
    { pathname: "/onboarding/success", params: { name: "Family kaata" } },
  ]);
  assert.equal(saved.meta.get("onboarding_step"), "done");

  const pendingSubmission = deferred<{ tab: { currency: string } }>();
  const submittedPreset = kaataFixture({ pending: "shared", preview: pendingSubmission.promise });
  await submittedPreset.flush();
  submittedPreset.field().props.onChangeText("Frozen kaata");
  submittedPreset.render();
  const submission = deferred<void>();
  submittedPreset.gate(submission.promise);
  const pendingCreation = submittedPreset.create().props.onPress();
  pendingSubmission.resolve({ tab: { currency: "USD" } });
  await submittedPreset.flush();
  assert.equal(
    submittedPreset.defaultSheet().props.selected,
    "AFN",
    "a late preset cannot change a submitted form",
  );
  assert.deepEqual(submittedPreset.creations[0].slice(3), ["AFN"]);
  const afterUnmountCreate = submittedPreset.create().props.onPress;
  const afterUnmountSheet = submittedPreset.defaultSheet().props;
  submittedPreset.hooks.unmount();
  afterUnmountCreate();
  afterUnmountSheet.onSelect("USD");
  afterUnmountSheet.onDismiss();
  submission.resolve();
  await pendingCreation;
  await settleUI();
  assert.deepEqual(
    submittedPreset.routes,
    [],
    "an unmounted creation cannot redirect another screen",
  );
  assert.equal(submittedPreset.hooks.lateWrites, 0);

  const retryBack = kaataFixture();
  await retryBack.flush();
  retryBack.failBack(true);
  await retryBack.back().props.onPress();
  retryBack.render();
  assert.equal(retryBack.back().props.disabled, false);
  assert.ok(nodes(retryBack.hooks.tree).some((node) => node.props.children === "entry.saveFailed"));
  retryBack.failBack(false);
  assert.equal([...retryBack.handlers][0](), true);
  await retryBack.flush();
  assert.deepEqual(retryBack.routes, ["/onboarding/profile"]);
  assert.equal(retryBack.meta.get("onboarding_self_name"), "Ahmad");
  console.log(
    "PASS: onboarding Back in both scripts, accessible actions, stable loading, safe kaata creation/Back, visible success and single-use shared-ledger handoff",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
