// Execute the real credit-settings screen against controlled storage/session
// boundaries; translations are the actual English and Dari dictionaries.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { fromMinorUnits, normalizeAmountInput, toMinorUnits } from "../money";
import type { CreditPolicy } from "../credit-policy";
import type { VaultRole } from "../events";
import type { CreditLimitNotificationPolicy } from "../credit-limit-notification-policy";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
class SessionChangedError extends Error {}
class ClerkCloudEnrollmentRequiredError extends Error {}
class CreditOnlineSaveRequiredError extends Error {}
class CreditLimitNotificationsUnsupportedError extends Error {}
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string"
      ? node
      : node?.props
        ? words(node.props.children)
        : "";
const policy = (mode: CreditPolicy["mode"], restrictEditors = false): CreditPolicy => ({
  relationship_id: "relationship",
  max_collect_minor: 10000,
  max_pay_minor: 20000,
  mode,
  restrict_editors: restrictEditors,
  updated_at_ms: 1,
});
const DEFAULT_RELATIONSHIP_ID = "00000000-0000-0000-0000-000000000000";
type CurrencySettings = {
  currency: string;
  policy: CreditPolicy | null;
  defaultPolicy: CreditPolicy | null;
};
const copySettings = (rows: readonly CurrencySettings[]) =>
  rows.map((row) => ({
    ...row,
    policy: row.policy ? { ...row.policy } : null,
    defaultPolicy: row.defaultPolicy ? { ...row.defaultPolicy } : null,
  }));

function fixture(
  options: {
    initial?: CreditPolicy;
    fresh?: CreditPolicy;
    delayRefresh?: boolean;
    role?: VaultRole;
    locale?: "en" | "fa";
    currencyCode?: string;
    currencies?: CurrencySettings[];
    freshCurrencies?: CurrencySettings[];
    routeId?: string;
    balances?: Record<string, number>;
    loadError?: Error;
    notification?: boolean;
    defaultNotification?: boolean;
    freshNotification?: boolean;
  } = {},
) {
  const hooks = uiHooks();
  const saves: { vault: string; value: CreditPolicy; session: any }[] = [];
  const notificationSaves: { vault: string; value: CreditLimitNotificationPolicy; session: any }[] =
    [];
  const notificationAttempts: typeof notificationSaves = [];
  const notices: string[] = [];
  const routes: string[] = [];
  const currencyCode = options.currencyCode ?? "AFN";
  const relationshipId =
    options.routeId === "kaata-default" ? DEFAULT_RELATIONSHIP_ID : "relationship";
  let currencySettings = copySettings(
    options.currencies ?? [
      {
        currency: currencyCode,
        policy: {
          ...(options.initial ?? policy("warn")),
          relationship_id: relationshipId,
          currency: currencyCode,
        },
        defaultPolicy: null,
      },
    ],
  );
  const currencyReads: [string, string][] = [];
  const balanceReads: [string, string, string][] = [];
  let saveError: Error | null = null;
  let saveGate: ReturnType<typeof deferred<void>> | null = null;
  let notificationError: Error | null = null;
  let notificationGate: ReturnType<typeof deferred<void>> | null = null;
  let notificationPolicy =
    options.notification === undefined
      ? null
      : {
          relationship_id: relationshipId,
          enabled: options.notification,
          updated_at_ms: 1,
        };
  const defaultNotificationPolicy =
    options.defaultNotification === undefined
      ? null
      : {
          relationship_id: DEFAULT_RELATIONSHIP_ID,
          enabled: options.defaultNotification,
          updated_at_ms: 1,
        };
  const balanceGates = new Map<string, ReturnType<typeof deferred<number>>>();
  let preventRemoval = false;
  let removalDisabled = false;
  let preventCallback: ((event: { repeat: () => void }) => void) | undefined;
  let focused = true;
  let focusStart: (() => void | (() => void)) | undefined;
  let focusCleanup: (() => void) | undefined;
  let role = options.role ?? "owner";
  let activeVault = "vault",
    binding = 1;
  const locale = options.locale ?? "en";
  i18n.setLocale(locale);
  const currency = compileUI("../currency", {
    react: {},
    "./currency-scope": require("../currency-scope"),
    "./currency-settings": require("../currency-settings"),
    "./currency-catalog": require("../currency-catalog"),
    "./db": {},
    "./db-tx": {},
    "./i18n": { getLocale: () => locale },
  }) as typeof import("../currency");
  const refreshGate = options.delayRefresh ? deferred<void>() : null;
  const guard = async (snapshot: any, work: () => Promise<any>) => {
    if (snapshot.bindingVersion !== binding) throw new SessionChangedError();
    return work();
  };
  const Screen = compileUI("../../app/person/[id]/credit-limit", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": {
      useRouter: () => ({ back: () => routes.push("back"), push: () => {} }),
      useLocalSearchParams: () => ({ id: options.routeId ?? "customer", vaultId: "vault" }),
      useFocusEffect: (callback: () => void | (() => void)) =>
        hooks.react.useEffect(() => {
          focusStart = callback;
          if (focused) focusCleanup = callback() || undefined;
          return () => {
            focusCleanup?.();
            focusCleanup = undefined;
          };
        }, [callback]),
      usePreventRemove: (prevent: boolean, callback?: (event: { repeat: () => void }) => void) => {
        preventRemoval = prevent && !removalDisabled;
        preventCallback = callback;
        return () => {
          removalDisabled = true;
          preventRemoval = false;
        };
      },
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      Keyboard: { dismiss() {} },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "android" },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Switch: "Switch",
      StyleSheet: { create: (style: any) => style, hairlineWidth: 1 },
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@expo/vector-icons": { Ionicons: "Ionicon" },
    "../../../components/Button": { Button: "Button" },
    "../../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../../../components/CurrencyPickerSheet": { CurrencyPickerSheet: "CurrencyPickerSheet" },
    "../../../components/SelectionMark": { SelectionMark: "SelectionMark" },
    "../../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
    "../../../components/Toast": {
      useToast: () => ({ push: (message: string) => notices.push(message) }),
    },
    "../../../lib/colors": { colors: require("../colors").colors },
    "../../../lib/currency": {
      getCurrencyLabel: (code: string) => code,
      getCurrencyName: (code: string) => code,
      currencyNeedsPrecisionHint: currency.currencyNeedsPrecisionHint,
    },
    "../../../lib/credit-policy": { KAATA_DEFAULT_ROUTE_ID: "kaata-default" },
    "../../../lib/credit-limits": {
      KAATA_DEFAULT_CREDIT_ID: DEFAULT_RELATIONSHIP_ID,
      listCreditCurrencySettings: async (requestedRelationship: string, vault: string) => {
        currencyReads.push([requestedRelationship, vault]);
        if (options.loadError) throw options.loadError;
        return copySettings(currencySettings);
      },
      readCreditPolicy: async (requestedRelationship: string, _vault: string, code: string) => {
        const row = currencySettings.find((item) => item.currency === code);
        return requestedRelationship === DEFAULT_RELATIONSHIP_ID
          ? (row?.defaultPolicy ?? null)
          : (row?.policy ?? null);
      },
      creditBalanceInTx: async (_db: unknown, vault: string, rel: string, code: string) => {
        balanceReads.push([vault, rel, code]);
        const gate = balanceGates.get(code);
        balanceGates.delete(code);
        return gate ? gate.promise : (options.balances?.[code] ?? 0);
      },
      refreshCreditPolicies: async () => {
        if (refreshGate) await refreshGate.promise;
        if (options.freshNotification !== undefined)
          notificationPolicy = {
            relationship_id: relationshipId,
            enabled: options.freshNotification,
            updated_at_ms: 2,
          };
        if (options.freshCurrencies) currencySettings = copySettings(options.freshCurrencies);
        else if (options.fresh)
          currencySettings[0] = {
            ...currencySettings[0],
            policy: { ...options.fresh, relationship_id: relationshipId, currency: currencyCode },
          };
      },
      relationshipForCredit: async () => "relationship",
      saveCreditPolicy: async (vault: string, value: CreditPolicy, session: any) =>
        guard(session, async () => {
          if (saveError) throw saveError;
          saves.push({ vault, value, session });
          if (saveGate) await saveGate.promise;
          const row = currencySettings.find((item) => item.currency === value.currency);
          if (row) row.policy = { ...value, updated_at_ms: 2 };
          return { ...value, updated_at_ms: 2 };
        }),
      ClerkCloudEnrollmentRequiredError,
      CreditOnlineSaveRequiredError,
    },
    "../../../lib/credit-limit-notifications": {
      CreditLimitNotificationsUnsupportedError,
      loadCreditLimitNotificationSettings: async (vault: string, rel: string) => {
        assert.equal(vault, "vault");
        assert.equal(rel, relationshipId);
        return {
          policy: notificationPolicy ? { ...notificationPolicy } : null,
          defaultPolicy: defaultNotificationPolicy ? { ...defaultNotificationPolicy } : null,
          effective: notificationPolicy
            ? { ...notificationPolicy }
            : defaultNotificationPolicy
              ? { ...defaultNotificationPolicy }
              : null,
        };
      },
      saveCreditLimitNotifications: async (
        vault: string,
        value: CreditLimitNotificationPolicy,
        session: any,
      ) =>
        guard(session, async () => {
          notificationAttempts.push({ vault, value, session });
          if (notificationError) throw notificationError;
          if (notificationGate) await notificationGate.promise;
          notificationPolicy = { ...value, updated_at_ms: 3 };
          notificationSaves.push({ vault, value, session });
          return notificationPolicy;
        }),
    },
    "../../../lib/db-tx": {
      getActiveVaultIdSyncMaybe: () => activeVault,
      getDb: async () => ({}),
    },
    "../../../lib/auth": {
      captureCurrentSession: async () => ({
        jwt: "token",
        accountId: "account",
        bindingVersion: binding,
      }),
      applyForUnchangedLocalSession: guard,
      SessionChangedError,
    },
    "../../../lib/direction": {
      useIsRTL: () => locale === "fa",
      bidiIsolate: (value: string) => value,
      ltrIsolate: (value: string) => value,
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
    },
    "../../../lib/db": {
      getPerson: async () => ({ id: "customer", name: locale === "fa" ? "احمد" : "Ahmad" }),
    },
    "../../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
    "../../../lib/format": { formatAmount: (value: number) => String(value) },
    "../../../lib/i18n": i18n,
    "../../../lib/money": { fromMinorUnits, normalizeAmountInput, toMinorUnits },
    "../../../lib/use-vault-role": {
      readVaultRole: async () => role,
      useActiveVaultWriteCaps: () => ({
        resolved: true,
        canConfigureCredit: role === "owner" || role === "manager",
      }),
    },
  }).default;
  const render = async () => {
    for (let i = 0; i < 5; i++) {
      await settleUI();
      hooks.render(Screen);
    }
  };
  hooks.render(Screen);
  return {
    hooks,
    saves,
    notificationSaves,
    notificationAttempts,
    notices,
    routes,
    currencyReads,
    balanceReads,
    requestLeave: () => {
      if (preventRemoval) preventCallback?.({ repeat: () => routes.push("leave") });
      else routes.push("leave");
    },
    confirm: () => nodes(hooks.tree).find((node) => node.type === "ConfirmDialog")!,
    render,
    blur: () => {
      focused = false;
      focusCleanup?.();
      focusCleanup = undefined;
    },
    refocus: async () => {
      focused = true;
      removalDisabled = false;
      focusCleanup = focusStart?.() || undefined;
      await render();
    },
    radios: () => nodes(hooks.tree).filter((node) => node.props.accessibilityRole === "radio"),
    inputs: () => nodes(hooks.tree).filter((node) => node.type === "TextInput"),
    save: () => nodes(hooks.tree).find((node) => node.type === "Button")!,
    notificationSwitch: () => nodes(hooks.tree).find((node) => node.type === "Switch")!,
    notificationRow: () =>
      nodes(hooks.tree).find(
        (node) =>
          node.type === "View" &&
          (Array.isArray(node.props.children) ? node.props.children : [node.props.children]).some(
            (child: any) => child?.type === "Switch",
          ),
      )!,
    picker: () => nodes(hooks.tree).find((node) => node.type === "CurrencyPickerSheet")!,
    currencyButton: () =>
      nodes(hooks.tree).find(
        (node) =>
          node.type === "Pressable" && node.props.accessibilityLabel === i18n.t("credit.currency"),
      )!,
    selectCurrency: async (code: string) => {
      const button = nodes(hooks.tree).find(
        (node) =>
          node.type === "Pressable" && node.props.accessibilityLabel === i18n.t("credit.currency"),
      )!;
      button.props.onPress();
      await render();
      nodes(hooks.tree)
        .find((node) => node.type === "CurrencyPickerSheet")!
        .props.onSelect(code);
      await render();
    },
    setSaveError: (error: Error | null) => {
      saveError = error;
    },
    delayedSave: () => (saveGate = deferred<void>()),
    setNotificationError: (error: Error | null) => {
      notificationError = error;
    },
    delayedNotificationSave: () => (notificationGate = deferred<void>()),
    delayedBalance: (code: string) => {
      const gate = deferred<number>();
      balanceGates.set(code, gate);
      return gate;
    },
    releaseRefresh: () => refreshGate?.resolve(),
    setRole: (next: VaultRole) => {
      role = next;
    },
    switchVault: () => {
      activeVault = "other-vault";
    },
    switchSession: () => {
      binding++;
    },
  };
}

async function run() {
  for (const locale of ["en", "fa"] as const) {
    for (const [initial, checked] of [
      [policy("warn"), 0],
      [policy("clerk_block"), 1],
      [policy("clerk_block", true), 2],
    ] as const) {
      const f = fixture({ initial, locale });
      await f.render();
      const radios = f.radios();
      assert.equal(
        nodes(f.hooks.tree).filter((node) => node.props.accessibilityRole === "radiogroup").length,
        1,
      );
      assert.equal(radios.length, 3);
      assert.deepEqual(
        radios.map((radio) => radio.props.accessibilityState),
        [0, 1, 2].map((index) => ({ checked: index === checked, disabled: false })),
      );
      assert.deepEqual(
        radios.map(words),
        ["credit.warnMode", "credit.hardMode", "credit.editorsMode"].map((key) =>
          i18n.tIn(locale, key as any),
        ),
      );
      for (const radio of radios) {
        assert.equal(
          flattenStyle(radio.props.style({ pressed: false })).flexDirection,
          locale === "fa" ? "row-reverse" : "row",
        );
        assert.equal(
          nodes(radio).find((node) => node.type === "SelectionMark")?.props.selected,
          radio.props.accessibilityState.checked,
        );
      }
      assert.equal(f.inputs()[0].props.value, "100");
      assert.equal(f.inputs()[1].props.value, "200");
      f.hooks.unmount();
    }
  }
  console.log(
    "PASS credit settings: warn/clerk/editor modes load boolean values with selected accessible English/Dari radios and RTL layout",
  );

  for (const [choice, expectedMode, restrictEditors] of [
    [2, "clerk_block", true],
    [1, "clerk_block", false],
    [0, "warn", false],
  ] as const) {
    const f = fixture({ initial: policy("clerk_block", true), role: "manager" });
    await f.render();
    f.radios()[choice].props.onPress();
    f.inputs()[0].props.onChangeText("123.45");
    await f.render();
    f.save().props.onPress();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 1, "a same-frame double save records once");
    assert.deepEqual(f.saves[0], {
      vault: "vault",
      session: { jwt: "token", accountId: "account", bindingVersion: 1 },
      value: {
        relationship_id: "relationship",
        currency: "AFN",
        max_collect_minor: 12345,
        max_pay_minor: 20000,
        mode: expectedMode,
        restrict_editors: restrictEditors,
        updated_at_ms: 0,
      },
    });
    assert.equal(f.notices[0], i18n.t("credit.saved"));
    assert.deepEqual(f.routes, ["back"]);
    f.hooks.unmount();
  }
  console.log(
    "PASS credit settings: admins save each mode with exact amounts and explicit true/false editor scope; double taps save once",
  );

  for (const locale of ["en", "fa"] as const)
    for (const currencyCode of ["AFN", "KWD"] as const) {
      const f = fixture({ locale, currencyCode });
      await f.render();
      const precisionNotes = () =>
        nodes(f.hooks.tree).filter(
          (node) => node.type === "Text" && words(node) === i18n.t("currency.precisionHint"),
        );
      assert.equal(
        precisionNotes().length,
        currencyCode === "KWD" ? 1 : 0,
        "a higher-precision currency explains the current limit once beside both credit fields",
      );
      f.inputs()[0].props.onChangeText("1.234");
      await f.render();
      assert.equal(f.inputs()[0].props.value, "1.234", "invalid precision remains visible");
      f.save().props.onPress();
      await f.render();
      assert.equal(f.saves.length, 0, "an over-precise cap cannot be saved or rounded");
      assert.ok(words(f.hooks.tree).includes(i18n.t("credit.limitInvalid")));
      assert.equal(precisionNotes().length, currencyCode === "KWD" ? 1 : 0);
      f.inputs()[0].props.onChangeText("1.23");
      await f.render();
      f.save().props.onPress();
      await f.render();
      assert.equal(f.saves.length, 1);
      assert.equal(f.saves[0].value.max_collect_minor, 123, "credit limits retain hundredths");
      f.hooks.unmount();
    }
  console.log(
    "PASS credit settings: English/Dari higher-precision currency guidance and exact two-decimal validation",
  );

  for (const role of ["editor", "viewer", "clerk"] as const) {
    const f = fixture({ role });
    await f.render();
    assert.equal(f.save().props.disabled, true);
    assert.ok(
      f.radios().every((radio) => radio.props.disabled && radio.props.accessibilityState.disabled),
    );
    assert.ok(f.inputs().every((input) => !input.props.editable));
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 0);
    f.hooks.unmount();
  }
  const demoted = fixture();
  await demoted.render();
  demoted.setRole("editor");
  await demoted.render();
  assert.equal(demoted.save().props.disabled, true, "live demotion removes save authority");
  demoted.save().props.onPress();
  await demoted.render();
  assert.equal(demoted.saves.length, 0);
  demoted.hooks.unmount();

  const edited = fixture({
    delayRefresh: true,
    fresh: { ...policy("clerk_block", true), max_collect_minor: 50000 },
  });
  await edited.render();
  edited.radios()[1].props.onPress();
  edited.inputs()[0].props.onChangeText("77.25");
  await edited.render();
  edited.releaseRefresh();
  await edited.render();
  assert.equal(
    edited.inputs()[0].props.value,
    "77.25",
    "late network refresh preserves typed caps",
  );
  assert.equal(
    edited.radios()[1].props.accessibilityState.checked,
    true,
    "late refresh preserves the selected scope",
  );
  edited.save().props.onPress();
  await edited.render();
  assert.equal(edited.saves[0].value.restrict_editors, false);
  assert.equal(edited.saves[0].value.max_collect_minor, 7725);
  edited.hooks.unmount();

  const fresh = fixture({ delayRefresh: true, fresh: policy("clerk_block", true) });
  await fresh.render();
  assert.equal(fresh.radios()[0].props.accessibilityState.checked, true);
  fresh.releaseRefresh();
  await fresh.render();
  assert.equal(
    fresh.radios()[2].props.accessibilityState.checked,
    true,
    "an untouched form takes the fresh boolean scope",
  );
  fresh.hooks.unmount();

  const staleVault = fixture({ delayRefresh: true, fresh: policy("clerk_block", true) });
  await staleVault.render();
  staleVault.switchVault();
  staleVault.releaseRefresh();
  await staleVault.render();
  assert.equal(
    staleVault.radios()[0].props.accessibilityState.checked,
    true,
    "another kaata's form cannot repaint from the old response",
  );
  assert.equal(staleVault.save().props.disabled, true);
  staleVault.save().props.onPress();
  await staleVault.render();
  assert.equal(staleVault.saves.length, 0);
  staleVault.hooks.unmount();

  const staleSession = fixture({ delayRefresh: true, fresh: policy("clerk_block", true) });
  await staleSession.render();
  staleSession.switchSession();
  staleSession.releaseRefresh();
  await staleSession.render();
  assert.equal(staleSession.radios()[0].props.accessibilityState.checked, true);
  staleSession.save().props.onPress();
  await staleSession.render();
  assert.equal(staleSession.saves.length, 0, "old session snapshots cannot save");
  staleSession.hooks.unmount();
  console.log(
    "PASS credit settings: editor/viewer/clerk and live-demotion gates, late refresh vs edits, fresh form updates, and session/kaata scope",
  );

  for (const locale of ["en", "fa"] as const) {
    const f = fixture({
      locale,
      currencies: [
        { currency: "AFN", policy: { ...policy("warn"), currency: "AFN" }, defaultPolicy: null },
        {
          currency: "USD",
          policy: {
            ...policy("clerk_block", true),
            currency: "USD",
            max_collect_minor: 50000,
            max_pay_minor: 4000,
          },
          defaultPolicy: null,
        },
        // A disabled historical ISO code absent from the current catalog
        // must remain configurable when the data helper includes it.
        { currency: "ZZZ", policy: null, defaultPolicy: null },
      ],
      balances: { AFN: 2500, USD: -1200, ZZZ: 0 },
    });
    await f.render();
    assert.deepEqual(f.picker().props.allowedCurrencies, ["AFN", "USD", "ZZZ"]);
    assert.equal(f.picker().props.selectedCode, "AFN", "the first/default currency opens first");
    assert.equal(f.inputs().length, 2, "only the selected currency's two caps are rendered");
    assert.ok(f.currencyReads.every(([rel, vault]) => rel === "relationship" && vault === "vault"));
    assert.ok(
      f.balanceReads.every(
        ([vault, rel, code]) => vault === "vault" && rel === "relationship" && code === "AFN",
      ),
      "only the selected customer's selected-currency exposure is requested",
    );
    assert.ok(words(f.hooks.tree).includes(i18n.t("credit.balanceHelp")));
    assert.ok(words(f.hooks.tree).includes(i18n.t("credit.zeroHelp")));
    assert.ok(words(f.hooks.tree).includes(i18n.t("credit.outstanding", { amount: "25" })));
    assert.ok(
      words(f.hooks.tree).includes(i18n.t("credit.limitLeft", { limit: "100", left: "75" })),
      "positive net balance consumes the collect cap",
    );
    assert.ok(
      words(f.hooks.tree).includes(i18n.t("credit.limitLeft", { limit: "200", left: "200" })),
      "the same positive net balance does not consume the pay cap",
    );
    f.inputs()[0].props.onChangeText("321.09");
    f.inputs()[1].props.onChangeText("54.30");
    f.radios()[1].props.onPress();
    await f.render();
    await f.selectCurrency("USD");
    assert.equal(f.inputs()[0].props.value, "500");
    assert.equal(f.inputs()[1].props.value, "40");
    assert.equal(f.radios()[2].props.accessibilityState.checked, true);
    assert.ok(words(f.hooks.tree).includes(i18n.t("credit.outstanding", { amount: "12" })));
    assert.ok(
      words(f.hooks.tree).includes(i18n.t("credit.limitLeft", { limit: "40", left: "28" })),
      "negative net balance consumes the pay cap in its own currency",
    );
    f.inputs()[0].props.onChangeText("12.34");
    f.inputs()[1].props.onChangeText("0");
    f.radios()[0].props.onPress();
    await f.render();
    await f.selectCurrency("AFN");
    assert.equal(f.inputs()[0].props.value, "321.09", "switching restores the AFN draft");
    assert.equal(f.inputs()[1].props.value, "54.30");
    assert.equal(f.radios()[1].props.accessibilityState.checked, true);
    f.save().props.onPress();
    await f.render();
    assert.deepEqual(
      f.saves.map((saved) => saved.value),
      [
        {
          relationship_id: "relationship",
          currency: "AFN",
          max_collect_minor: 32109,
          max_pay_minor: 5430,
          mode: "clerk_block",
          restrict_editors: false,
          updated_at_ms: 0,
        },
      ],
    );
    assert.deepEqual(f.routes, [], "a multi-currency save keeps the settings open");
    await f.selectCurrency("USD");
    assert.equal(f.inputs()[0].props.value, "12.34", "saving AFN preserves the USD draft");
    assert.equal(f.inputs()[1].props.value, "0");
    assert.equal(f.radios()[0].props.accessibilityState.checked, true);
    f.save().props.onPress();
    await f.render();
    assert.deepEqual(f.saves[1].value, {
      relationship_id: "relationship",
      currency: "USD",
      max_collect_minor: 1234,
      max_pay_minor: 0,
      mode: "warn",
      restrict_editors: false,
      updated_at_ms: 0,
    });
    assert.deepEqual(f.notices, [i18n.t("credit.saved"), i18n.t("credit.saved")]);
    await f.selectCurrency("ZZZ");
    assert.equal(f.inputs()[0].props.value, "");
    assert.equal(f.inputs()[1].props.value, "");
    assert.equal(f.radios()[0].props.accessibilityState.checked, true);
    assert.ok(f.balanceReads.some(([, , code]) => code === "USD"));
    assert.ok(f.balanceReads.some(([, , code]) => code === "ZZZ"));
    f.currencyButton().props.onPress();
    await f.render();
    f.picker().props.onSelect("EUR");
    await f.render();
    assert.equal(
      f.picker().props.selectedCode,
      "ZZZ",
      "an unoffered currency cannot enter the form",
    );
    f.picker().props.onDismiss();
    await f.render();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves[2].value.currency, "ZZZ");
    assert.equal(f.saves[2].value.max_collect_minor, null, "blank remains unlimited on collect");
    assert.equal(f.saves[2].value.max_pay_minor, null, "blank remains unlimited on pay");
    f.hooks.unmount();
  }
  console.log(
    "PASS credit settings: independent AFN/USD caps and modes, persistent drafts, selected-only saves/exposure, historical ISO choices and English/Dari currency selection",
  );

  for (const locale of ["en", "fa"] as const) {
    const inherited = {
      ...policy("clerk_block", true),
      relationship_id: DEFAULT_RELATIONSHIP_ID,
      currency: "AFN",
    };
    const f = fixture({
      locale,
      currencies: [
        { currency: "AFN", policy: null, defaultPolicy: inherited },
        {
          currency: "USD",
          policy: {
            ...policy("warn"),
            currency: "USD",
            max_collect_minor: 1234,
            max_pay_minor: null,
          },
          defaultPolicy: { ...inherited, currency: "USD", max_collect_minor: 99999 },
        },
      ],
    });
    await f.render();
    assert.equal(f.inputs()[0].props.value, "100", "inherited collect cap is shown accurately");
    assert.equal(f.inputs()[1].props.value, "200", "inherited pay cap is shown accurately");
    assert.equal(f.radios()[2].props.accessibilityState.checked, true);
    assert.ok(words(f.hooks.tree).includes(i18n.t("credit.usesDefault")));
    f.save().props.onPress();
    await f.render();
    assert.deepEqual(f.saves[0].value, {
      relationship_id: "relationship",
      currency: "AFN",
      max_collect_minor: 10000,
      max_pay_minor: 20000,
      mode: "clerk_block",
      restrict_editors: true,
      updated_at_ms: 0,
    });
    await f.selectCurrency("USD");
    assert.equal(f.inputs()[0].props.value, "12.34");
    assert.equal(f.inputs()[1].props.value, "", "an explicit unlimited cap overrides the default");
    assert.equal(f.radios()[0].props.accessibilityState.checked, true);
    assert.equal(words(f.hooks.tree).includes(i18n.t("credit.usesDefault")), false);
    f.hooks.unmount();
  }
  const newDefaults = fixture({
    routeId: "kaata-default",
    currencies: [
      { currency: "AFN", policy: null, defaultPolicy: null },
      { currency: "USD", policy: null, defaultPolicy: null },
    ],
  });
  await newDefaults.render();
  assert.ok(newDefaults.currencyReads.every(([rel]) => rel === DEFAULT_RELATIONSHIP_ID));
  assert.equal(
    newDefaults.balanceReads.length,
    0,
    "Kaata defaults do not invent a customer balance",
  );
  assert.equal(newDefaults.inputs()[0].props.value, "");
  assert.equal(newDefaults.inputs()[1].props.value, "");
  assert.equal(newDefaults.radios()[0].props.accessibilityState.checked, true);
  assert.ok(words(newDefaults.hooks.tree).includes(i18n.t("credit.defaultHelp")));
  await newDefaults.selectCurrency("USD");
  newDefaults.inputs()[0].props.onChangeText("0");
  newDefaults.inputs()[1].props.onChangeText("10.01");
  await newDefaults.render();
  newDefaults.save().props.onPress();
  await newDefaults.render();
  assert.deepEqual(newDefaults.saves[0].value, {
    relationship_id: DEFAULT_RELATIONSHIP_ID,
    currency: "USD",
    max_collect_minor: 0,
    max_pay_minor: 1001,
    mode: "warn",
    restrict_editors: false,
    updated_at_ms: 0,
  });
  newDefaults.hooks.unmount();
  console.log(
    "PASS credit settings: per-currency inherited values/modes, explicit unlimited overrides, new currencies and independently saved Kaata defaults",
  );

  const initialCurrencies: CurrencySettings[] = [
    { currency: "AFN", policy: { ...policy("warn"), currency: "AFN" }, defaultPolicy: null },
    { currency: "USD", policy: { ...policy("warn"), currency: "USD" }, defaultPolicy: null },
  ];
  const refreshedCurrencies: CurrencySettings[] = initialCurrencies.map((row) => ({
    ...row,
    policy: {
      ...row.policy!,
      mode: "clerk_block",
      restrict_editors: true,
      max_collect_minor: 90000,
    },
  }));
  const multipleDirty = fixture({
    delayRefresh: true,
    currencies: initialCurrencies,
    freshCurrencies: refreshedCurrencies,
  });
  await multipleDirty.render();
  multipleDirty.inputs()[0].props.onChangeText("11.11");
  multipleDirty.radios()[1].props.onPress();
  await multipleDirty.render();
  await multipleDirty.selectCurrency("USD");
  multipleDirty.inputs()[0].props.onChangeText("22.22");
  multipleDirty.inputs()[1].props.onChangeText("33.33");
  await multipleDirty.render();
  multipleDirty.releaseRefresh();
  await multipleDirty.render();
  assert.equal(multipleDirty.inputs()[0].props.value, "22.22");
  assert.equal(multipleDirty.inputs()[1].props.value, "33.33");
  assert.equal(multipleDirty.radios()[0].props.accessibilityState.checked, true);
  await multipleDirty.selectCurrency("AFN");
  assert.equal(multipleDirty.inputs()[0].props.value, "11.11");
  assert.equal(multipleDirty.radios()[1].props.accessibilityState.checked, true);
  multipleDirty.hooks.unmount();

  const oneDirty = fixture({
    delayRefresh: true,
    currencies: initialCurrencies,
    freshCurrencies: refreshedCurrencies,
  });
  await oneDirty.render();
  oneDirty.inputs()[0].props.onChangeText("77.77");
  await oneDirty.render();
  await oneDirty.selectCurrency("USD");
  oneDirty.releaseRefresh();
  await oneDirty.render();
  assert.equal(oneDirty.inputs()[0].props.value, "900", "untouched USD takes its fresh cap");
  assert.equal(oneDirty.radios()[2].props.accessibilityState.checked, true);
  await oneDirty.selectCurrency("AFN");
  assert.equal(oneDirty.inputs()[0].props.value, "77.77", "dirty AFN survives a USD refresh");
  assert.equal(oneDirty.radios()[0].props.accessibilityState.checked, true);
  oneDirty.hooks.unmount();
  console.log(
    "PASS credit settings: refresh preserves dirty caps/modes across all currency drafts and updates untouched currencies",
  );

  const staleBalance = fixture({
    currencies: initialCurrencies,
    balances: { USD: -1200 },
  });
  const oldBalance = staleBalance.delayedBalance("AFN");
  await staleBalance.render();
  await staleBalance.selectCurrency("USD");
  oldBalance.resolve(99999);
  await staleBalance.render();
  assert.equal(staleBalance.picker().props.selectedCode, "USD");
  assert.equal(
    words(staleBalance.hooks.tree).includes("999.99"),
    false,
    "a delayed AFN exposure cannot paint into the selected USD form",
  );
  staleBalance.hooks.unmount();

  const discard = fixture({ currencies: initialCurrencies });
  await discard.render();
  discard.inputs()[0].props.onChangeText("11.11");
  await discard.render();
  await discard.selectCurrency("USD");
  discard.inputs()[0].props.onChangeText("22.22");
  await discard.render();
  discard.save().props.onPress();
  await discard.render();
  assert.equal(discard.saves[0].value.currency, "USD");
  discard.requestLeave();
  await discard.render();
  assert.equal(
    discard.confirm().props.visible,
    true,
    "saving USD does not silently discard the unsaved AFN draft on departure",
  );
  assert.deepEqual(discard.routes, []);
  discard.confirm().props.onCancel();
  await discard.render();
  assert.equal(discard.confirm().props.visible, false);
  await discard.selectCurrency("AFN");
  assert.equal(discard.inputs()[0].props.value, "11.11", "cancelling departure preserves drafts");
  discard.requestLeave();
  await discard.render();
  discard.confirm().props.onConfirm();
  await discard.render();
  assert.deepEqual(discard.routes, ["leave"], "explicit discard repeats the prevented navigation");
  discard.hooks.unmount();
  console.log(
    "PASS credit settings: delayed exposure stays in its currency and unsaved-currency drafts require explicit discard",
  );

  for (const locale of ["en", "fa"] as const)
    for (const inherited of [false, true]) {
      const baseline = { ...policy("warn"), currency: "AFN" };
      const f = fixture({
        locale,
        currencies: [
          {
            currency: "AFN",
            policy: inherited ? null : baseline,
            defaultPolicy: inherited
              ? { ...baseline, relationship_id: DEFAULT_RELATIONSHIP_ID }
              : null,
          },
          { currency: "USD", policy: null, defaultPolicy: null },
        ],
      });
      await f.render();
      f.inputs()[0].props.onChangeText("150");
      f.inputs()[1].props.onChangeText("250");
      f.radios()[1].props.onPress();
      await f.render();
      f.inputs()[0].props.onChangeText("100.00");
      await f.render();
      f.requestLeave();
      await f.render();
      assert.equal(
        f.confirm().props.visible,
        true,
        "unreverted pay/mode changes still need review",
      );
      f.confirm().props.onCancel();
      await f.render();
      f.inputs()[1].props.onChangeText("200.0");
      f.radios()[0].props.onPress();
      await f.render();
      f.requestLeave();
      await f.render();
      assert.equal(
        f.confirm().props.visible,
        false,
        "equivalent amounts and the original mode leave no unsaved changes",
      );
      assert.deepEqual(f.routes, ["leave"], "a fully reverted draft can close without discarding");
      assert.equal(f.saves.length, 0, "reverting an inherited draft does not create an override");
      f.hooks.unmount();
    }

  const oldDialog = fixture({ currencies: initialCurrencies });
  await oldDialog.render();
  oldDialog.inputs()[0].props.onChangeText("123");
  await oldDialog.render();
  oldDialog.requestLeave();
  await oldDialog.render();
  const previousConfirm = oldDialog.confirm();
  assert.equal(previousConfirm.props.visible, true);
  oldDialog.blur();
  await oldDialog.refocus();
  assert.equal(
    oldDialog.confirm().props.visible,
    false,
    "a new focus closes an old discard dialog",
  );
  previousConfirm.props.onConfirm();
  await oldDialog.render();
  assert.deepEqual(oldDialog.routes, [], "an expired discard action cannot navigate the new focus");
  oldDialog.hooks.unmount();

  for (const olderOutcome of ["success", "failure"] as const) {
    const f = fixture({ currencies: initialCurrencies });
    await f.render();
    f.inputs()[0].props.onChangeText("111.11");
    await f.render();
    const oldSave = f.delayedSave();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 1);
    assert.equal(f.save().props.loading, true);
    f.blur();
    await f.refocus();
    assert.equal(f.save().props.loading, false, "a new focus releases the old screen's busy state");
    f.inputs()[0].props.onChangeText("333.33");
    await f.render();
    const newSave = f.delayedSave();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 2, "the new focus can begin its own save");
    if (olderOutcome === "success") oldSave.resolve();
    else oldSave.reject(new Error("old request failed"));
    await f.render();
    assert.equal(
      f.save().props.loading,
      true,
      "an old finally cannot unlock the newer pending save",
    );
    assert.equal(f.save().props.disabled, true);
    assert.equal(f.currencyButton().props.disabled, true);
    assert.equal(
      f.inputs()[0].props.value,
      "333.33",
      "old completion cannot repaint the new draft",
    );
    assert.deepEqual(f.notices, [], "an old focus cannot show save feedback");
    assert.deepEqual(f.routes, []);
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 2, "an old completion cannot admit a duplicate third save");
    newSave.resolve();
    await f.render();
    assert.equal(f.save().props.loading, false);
    assert.equal(f.save().props.disabled, false);
    assert.deepEqual(f.notices, [i18n.t("credit.saved")]);
    assert.equal(f.saves[1].value.max_collect_minor, 33333);
    assert.equal(f.inputs()[0].props.value, "333.33");
    f.hooks.unmount();
  }
  console.log(
    "PASS credit settings: semantically reverted drafts need no discard, focus resets discard actions and older save completions cannot unlock newer saves",
  );

  for (const error of [
    new Error("network unavailable"),
    new ClerkCloudEnrollmentRequiredError(),
    new CreditOnlineSaveRequiredError(),
  ]) {
    const f = fixture({ currencies: initialCurrencies });
    await f.render();
    await f.selectCurrency("USD");
    f.inputs()[0].props.onChangeText("15.25");
    await f.render();
    f.setSaveError(error);
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 0);
    assert.equal(f.inputs()[0].props.value, "15.25", "save failure preserves the selected draft");
    assert.equal(f.picker().props.selectedCode, "USD");
    assert.deepEqual(f.routes, []);
    assert.deepEqual(f.notices, []);
    assert.ok(
      words(f.hooks.tree).includes(
        i18n.t(
          error instanceof ClerkCloudEnrollmentRequiredError
            ? "credit.clerksNeedSignIn"
            : error instanceof CreditOnlineSaveRequiredError
              ? "credit.onlineSave"
              : "credit.saveFailed",
        ),
      ),
    );
    f.setSaveError(null);
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves[0].value.currency, "USD");
    assert.equal(f.saves[0].value.max_collect_minor, 1525);
    f.hooks.unmount();
  }
  const unavailable = fixture({ loadError: new Error("database unavailable") });
  await unavailable.render();
  assert.ok(words(unavailable.hooks.tree).includes(i18n.t("credit.loadFailed")));
  assert.ok(!unavailable.save() || unavailable.save().props.disabled, "failed loading cannot save");
  unavailable.hooks.unmount();

  const savingScope = fixture({ currencies: initialCurrencies });
  await savingScope.render();
  const saveGate = savingScope.delayedSave();
  savingScope.save().props.onPress();
  await savingScope.render();
  assert.equal(savingScope.saves.length, 1);
  assert.equal(savingScope.currencyButton().props.disabled, true);
  savingScope.requestLeave();
  await savingScope.render();
  assert.equal(savingScope.confirm().props.visible, false, "an active save cannot be discarded");
  assert.deepEqual(savingScope.routes, []);
  savingScope.picker().props.onSelect("USD");
  await savingScope.render();
  assert.equal(savingScope.picker().props.selectedCode, "AFN", "a saving currency cannot change");
  savingScope.switchSession();
  saveGate.resolve();
  await savingScope.render();
  assert.deepEqual(savingScope.notices, [], "another session cannot receive save feedback");
  assert.deepEqual(savingScope.routes, []);
  savingScope.hooks.unmount();
  console.log(
    "PASS credit settings: selected-currency retry/errors, failed load, saving currency guard and stale-session feedback",
  );
  await notificationChecks();
}

async function notificationChecks() {
  const uncapped: CurrencySettings[] = [
    { currency: "AFN", policy: null, defaultPolicy: null },
    { currency: "USD", policy: null, defaultPolicy: null },
  ];
  const capped: CurrencySettings[] = [
    { currency: "AFN", policy: { ...policy("warn"), currency: "AFN" }, defaultPolicy: null },
    { currency: "USD", policy: { ...policy("warn"), currency: "USD" }, defaultPolicy: null },
  ];
  const defaults: { options: Parameters<typeof fixture>[0]; expected: boolean }[] = [
    { options: {}, expected: false },
    { options: { currencies: uncapped }, expected: true },
    { options: { defaultNotification: true }, expected: true },
    { options: { currencies: uncapped, defaultNotification: false }, expected: false },
    { options: { notification: false, defaultNotification: true }, expected: false },
    { options: { notification: true, defaultNotification: false }, expected: true },
  ];
  for (const locale of ["en", "fa"] as const) {
    for (const item of defaults) {
      const f = fixture({ ...item.options, locale });
      await f.render();
      const control = f.notificationSwitch();
      assert.equal(control.props.value, item.expected);
      assert.deepEqual(control.props.accessibilityState, {
        checked: item.expected,
        disabled: false,
      });
      assert.equal(control.props.accessibilityLabel, i18n.t("credit.notifyOwners"));
      assert.equal(control.props.accessibilityHint, i18n.t("credit.notifyHelp"));
      assert.equal(
        flattenStyle(f.notificationRow().props.style).flexDirection,
        locale === "fa" ? "row-reverse" : "row",
      );
      f.requestLeave();
      await f.render();
      assert.equal(
        f.confirm().props.visible,
        false,
        "Initial/default-on display alone is not an unsaved edit",
      );
      assert.deepEqual(f.routes, ["leave"]);
      assert.equal(f.notificationAttempts.length, 0);
      f.hooks.unmount();
    }
  }
  for (const role of ["owner", "manager", "clerk", "editor", "viewer"] as const) {
    const f = fixture({ role });
    await f.render();
    const canConfigure = role === "owner" || role === "manager";
    assert.equal(f.notificationSwitch().props.disabled, !canConfigure);
    assert.equal(f.notificationSwitch().props.accessibilityState.disabled, !canConfigure);
    if (!canConfigure) assert.equal(flattenStyle(f.notificationSwitch().props.style).opacity, 0.55);
    f.notificationSwitch().props.onValueChange(true);
    f.save().props.onPress();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.saves.length, 0, "A notification-only update never rewrites credit caps");
    assert.equal(
      f.notificationAttempts.length,
      Number(canConfigure),
      "Same-frame switch/save and double press submit only once for permitted roles",
    );
    assert.equal(f.notificationSaves.length, Number(canConfigure));
    if (canConfigure) {
      assert.deepEqual(f.notificationSaves[0], {
        vault: "vault",
        value: { relationship_id: "relationship", enabled: true, updated_at_ms: 0 },
        session: { jwt: "token", accountId: "account", bindingVersion: 1 },
      });
      assert.deepEqual(f.notices, [i18n.t("credit.notifySaved")]);
      assert.deepEqual(f.routes, ["back"]);
    }
    f.hooks.unmount();
  }
  console.log(
    "PASS credit notification settings: new-limit ON/legacy OFF, inherited preferences, accessible English/Dari layout, role gates and exact notification-only same-frame saves",
  );

  const shared = fixture({ currencies: capped });
  await shared.render();
  shared.notificationSwitch().props.onValueChange(true);
  await shared.render();
  await shared.selectCurrency("USD");
  assert.equal(
    shared.notificationSwitch().props.value,
    true,
    "One customer-wide switch follows the user across currencies",
  );
  shared.save().props.onPress();
  await shared.render();
  assert.equal(shared.saves.length, 0);
  assert.deepEqual(shared.notificationSaves[0].value, {
    relationship_id: "relationship",
    enabled: true,
    updated_at_ms: 0,
  });
  await shared.selectCurrency("AFN");
  assert.equal(shared.notificationSwitch().props.value, true);
  shared.notificationSwitch().props.onValueChange(false);
  await shared.render();
  shared.requestLeave();
  await shared.render();
  assert.equal(
    shared.confirm().props.visible,
    true,
    "An unsaved switch edit requires explicit discard",
  );
  shared.confirm().props.onCancel();
  await shared.render();
  assert.equal(
    shared.notificationSwitch().props.value,
    false,
    "Cancelling departure keeps the notification draft",
  );
  shared.requestLeave();
  await shared.render();
  shared.confirm().props.onConfirm();
  await shared.render();
  assert.deepEqual(shared.routes, ["leave"]);
  assert.equal(
    shared.notificationAttempts.length,
    1,
    "Discard does not send the unsaved switch value",
  );
  shared.hooks.unmount();

  const refresh = fixture({ delayRefresh: true, freshNotification: false });
  await refresh.render();
  refresh.notificationSwitch().props.onValueChange(true);
  await refresh.render();
  refresh.releaseRefresh();
  await refresh.render();
  assert.equal(
    refresh.notificationSwitch().props.value,
    true,
    "An older cap/settings refresh cannot clobber a touched switch",
  );
  refresh.save().props.onPress();
  await refresh.render();
  assert.equal(refresh.saves.length, 0);
  assert.equal(refresh.notificationSaves[0].value.enabled, true);
  refresh.hooks.unmount();

  for (const brandNew of [false, true]) {
    const partial = fixture({ currencies: brandNew ? uncapped : capped });
    await partial.render();
    if (!brandNew) partial.notificationSwitch().props.onValueChange(true);
    partial.inputs()[0].props.onChangeText("150");
    await partial.render();
    partial.setNotificationError(new Error("notification server unavailable"));
    partial.save().props.onPress();
    await partial.render();
    assert.equal(partial.saves.length, 1);
    assert.equal(partial.notificationAttempts.length, 1);
    assert.equal(partial.notificationSaves.length, 0);
    assert.ok(words(partial.hooks.tree).includes(i18n.t("credit.notifyPartial")));
    assert.equal(partial.notificationSwitch().props.value, true);
    assert.deepEqual(partial.notices, [], "A partial save cannot show complete success");
    assert.deepEqual(partial.routes, [], "A partial save keeps its retry available");
    partial.requestLeave();
    await partial.render();
    assert.equal(
      partial.confirm().props.visible,
      true,
      "The unsaved flag stays dirty after a successful cap save",
    );
    partial.confirm().props.onCancel();
    await partial.render();
    partial.setNotificationError(null);
    partial.save().props.onPress();
    await partial.render();
    assert.equal(
      partial.saves.length,
      1,
      "Retry saves only the unsaved flag, without repeating a successful cap update",
    );
    assert.equal(partial.notificationAttempts.length, 2);
    assert.equal(partial.notificationSaves.length, 1);
    assert.deepEqual(partial.notices, [i18n.t("credit.notifySaved")]);
    partial.hooks.unmount();
  }
  const unsupported = fixture();
  await unsupported.render();
  unsupported.notificationSwitch().props.onValueChange(true);
  await unsupported.render();
  unsupported.setNotificationError(new CreditLimitNotificationsUnsupportedError());
  unsupported.save().props.onPress();
  await unsupported.render();
  assert.equal(unsupported.saves.length, 0);
  assert.ok(words(unsupported.hooks.tree).includes(i18n.t("credit.notifyUnavailable")));
  assert.deepEqual(unsupported.notices, []);
  assert.deepEqual(unsupported.routes, []);
  unsupported.hooks.unmount();
  const partialUnsupported = fixture({ currencies: uncapped });
  await partialUnsupported.render();
  partialUnsupported.inputs()[0].props.onChangeText("150");
  partialUnsupported.setNotificationError(new CreditLimitNotificationsUnsupportedError());
  partialUnsupported.save().props.onPress();
  await partialUnsupported.render();
  assert.equal(partialUnsupported.saves.length, 1);
  assert.equal(partialUnsupported.notificationSaves.length, 0);
  assert.ok(
    words(partialUnsupported.hooks.tree).includes(i18n.t("credit.notifyPartialUnavailable")),
    "An older server is distinguished from a temporary notification-save failure",
  );
  assert.deepEqual(partialUnsupported.notices, []);
  assert.deepEqual(partialUnsupported.routes, []);
  partialUnsupported.hooks.unmount();
  console.log(
    "PASS credit notification settings: shared currency scope, discard/refresh guards, honest partial and unsupported saves, and flag-only retry after successful caps",
  );

  for (const transition of ["vault", "session", "unmount"] as const) {
    const f = fixture();
    await f.render();
    f.notificationSwitch().props.onValueChange(true);
    await f.render();
    const pending = f.delayedNotificationSave();
    f.save().props.onPress();
    await f.render();
    assert.equal(f.notificationAttempts.length, 1);
    assert.equal(f.save().props.loading, true);
    if (transition === "vault") f.switchVault();
    else if (transition === "session") f.switchSession();
    else f.hooks.unmount();
    pending.resolve();
    if (transition === "unmount") {
      await settleUI();
      await settleUI();
    } else {
      await f.render();
      f.hooks.unmount();
    }
    assert.deepEqual(f.notices, [], `${transition}: stale notification saves cannot show success`);
    assert.deepEqual(f.routes, [], `${transition}: stale notification saves cannot navigate`);
    assert.equal(f.hooks.lateWrites, 0, `${transition}: no write targets an unmounted screen`);
  }
  console.log(
    "PASS credit notification settings: late saves cannot leak feedback/navigation across Kaata/session changes or unmount",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
