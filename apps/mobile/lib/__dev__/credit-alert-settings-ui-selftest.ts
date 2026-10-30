// Execute the real combined-rule editor/settings route with controlled UI,
// session and persistence boundaries. No phone, account or server is used.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import * as money from "../money";
import * as policy from "../credit-alert-policy";
import type { CreditAlertDraft } from "../../components/CreditAlertRuleEditor";
import { KAATA_DEFAULT_CREDIT_ID } from "../credit-policy";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");

const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join(" ")
    : node && typeof node === "object"
      ? words(node.props?.children)
      : node == null
        ? ""
        : String(node);

function editorFixture(
  options: {
    drafts?: CreditAlertDraft[];
    currencies?: string[];
    rtl?: boolean;
    disabled?: boolean;
  } = {},
) {
  const hooks = uiHooks();
  let drafts = structuredClone(options.drafts ?? []);
  let disabled = options.disabled ?? false;
  let key = 100;
  let changes = 0;
  const module = compileUI("../../components/CreditAlertRuleEditor", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Keyboard: { dismiss() {} },
      Pressable: "Pressable",
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
      StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
    },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "./CurrencyPickerSheet": { CurrencyPickerSheet: "CurrencyPickerSheet" },
    "./Button": { Button: "Button" },
    "../lib/colors": require("../colors"),
    "../lib/currency": { getCurrencyLabel: (code: string) => code },
    "../lib/direction": {
      useIsRTL: () => !!options.rtl,
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({
        writingDirection: rtl ? "rtl" : "ltr",
        textAlign: rtl ? "right" : "left",
      }),
    },
    "../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
    "../lib/format": { formatAmount: String },
    "../lib/i18n": {
      t: (key: string, params?: unknown) => key + (params ? JSON.stringify(params) : ""),
    },
    "../lib/money": money,
    "../lib/credit-alert-policy": policy,
    "../lib/tokens": { radius: { md: 12, sm: 8 }, TOUCH_MIN: 44 },
  }) as typeof import("../../components/CreditAlertRuleEditor");
  const render = () =>
    hooks.render(() =>
      module.CreditAlertRuleEditor({
        drafts,
        currencies: options.currencies ?? ["USD", "AFN", "EUR"],
        disabled,
        validation: true,
        balances: { USD: 500000, AFN: 10000000, EUR: null },
        nextKey: () => key++,
        onChange: (value) => {
          drafts = value;
          changes++;
        },
      }),
    );
  const node = (id: string) => {
    const found = nodes(hooks.tree).find((n) => n.props.testID === id);
    assert.ok(found, `editor control ${id}`);
    return found;
  };
  const button = (label: string, index = 0) => {
    const found = nodes(hooks.tree).filter((n) => n.type === "Button" && n.props.label === label)[
      index
    ];
    assert.ok(found, `editor button ${label}`);
    return found;
  };
  render();
  return {
    module,
    hooks,
    render,
    node,
    button,
    drafts: () => drafts,
    changes: () => changes,
    disable: () => {
      disabled = true;
      render();
    },
    picker: () => nodes(hooks.tree).find((n) => n.type === "CurrencyPickerSheet")!,
  };
}

function editorChecks() {
  const f = editorFixture();
  for (const [raw, minor] of [
    ["0.29", 29],
    [".29", 29],
    ["1.", 100],
    ["۵۰۰۰", 500000],
    ["٥٠٠٠٫٢٩", 500029],
    ["۱۲۳۴۵٫۶۷", 1234567],
    ["9999999999.99", 999999999999],
  ] as const)
    assert.equal(f.module.parseCreditAlertAmount(raw), minor, `exact localized amount ${raw}`);
  for (const raw of ["", "0", "-1", "1.001", "Infinity", "1e3", "99999999999"])
    assert.equal(f.module.parseCreditAlertAmount(raw), null, `invalid amount ${raw}`);
  assert.deepEqual(f.module.creditAlertDraftGroups([]), [], "empty draft is explicit alerts off");
  f.button("creditAlerts.addRule").props.onPress();
  f.render();
  assert.equal(f.drafts().length, 1);
  const first = f.drafts()[0];
  const usd = first.conditions[0];
  f.node(`credit-alert-amount-${usd.key}`).props.onChangeText("۵۰۰۰٫۲۹");
  f.render();
  assert.equal(f.drafts()[0].conditions[0].amount, "5000.29");
  f.button("creditAlerts.addCondition").props.onPress();
  f.render();
  const afn = f.drafts()[0].conditions[1];
  assert.equal(afn.currency, "AFN", "a second AND condition selects an unused denomination");
  f.node(`credit-alert-amount-${afn.key}`).props.onChangeText("۱۰۰۰۰۰");
  f.render();
  f.button("creditAlerts.addRule").props.onPress();
  f.render();
  const second = f.drafts()[1];
  f.node(`credit-alert-amount-${second.conditions[0].key}`).props.onChangeText("8000");
  f.render();
  f.node(`credit-alert-direction-${second.key}-pay`).props.onPress();
  f.render();
  assert.deepEqual(f.module.creditAlertDraftGroups(f.drafts()), [
    {
      direction: "collect",
      conditions: [
        { currency: "USD", threshold_minor: 500029 },
        { currency: "AFN", threshold_minor: 10000000 },
      ],
    },
    { direction: "pay", conditions: [{ currency: "USD", threshold_minor: 800000 }] },
  ]);
  assert.ok(words(f.hooks.tree).includes("creditAlerts.and"));
  assert.ok(words(f.hooks.tree).includes("creditAlerts.or"));
  f.node(`credit-alert-currency-${usd.key}`).props.onPress();
  f.render();
  assert.deepEqual(f.picker().props.allowedCurrencies, ["USD", "EUR"]);
  const old = structuredClone(f.drafts());
  f.picker().props.onSelect("AFN");
  f.render();
  assert.deepEqual(f.drafts(), old, "picker cannot select a duplicate currency in one AND group");
  f.node(`credit-alert-currency-${usd.key}`).props.onPress();
  f.render();
  f.picker().props.onSelect("EUR");
  f.render();
  assert.equal(f.drafts()[0].conditions[0].currency, "EUR");
  assert.ok(
    words(f.hooks.tree).includes("creditAlerts.unknown"),
    "unknown exposure stays explicit in live preview",
  );
  f.node(`credit-alert-remove-condition-${afn.key}`).props.onPress();
  f.render();
  assert.equal(f.drafts()[0].conditions.length, 1);
  f.node(`credit-alert-remove-rule-${second.key}`).props.onPress();
  f.render();
  assert.equal(f.drafts().length, 1);
  const duplicate = structuredClone(f.drafts());
  duplicate[0].conditions.push({ ...duplicate[0].conditions[0], key: 900 });
  assert.equal(f.module.creditAlertDraftGroups(duplicate), null);
  assert.equal(
    f.module.creditAlertDraftGroups(Array.from({ length: 21 }, (_, n) => ({ ...first, key: n }))),
    null,
  );
  const beforeDisable = f.changes();
  f.disable();
  f.node(`credit-alert-amount-${usd.key}`).props.onChangeText("9000");
  f.node(`credit-alert-direction-${first.key}-pay`).props.onPress();
  f.button("creditAlerts.addRule").props.onPress();
  assert.equal(f.changes(), beforeDisable, "disabled controls refuse retained handlers");
  const rtl = editorFixture({ drafts: [first], rtl: true });
  assert.equal(
    flattenStyle(rtl.node(`credit-alert-amount-${usd.key}`).props.style).writingDirection,
    "rtl",
  );
  const used = editorFixture({
    currencies: ["USD", "AFN"],
    drafts: [
      {
        key: 1,
        direction: "collect",
        conditions: [
          { key: 2, currency: "USD", amount: "1" },
          { key: 3, currency: "AFN", amount: "1" },
        ],
      },
    ],
  });
  assert.equal(used.node("credit-alert-currency-2").props.disabled, true);
  assert.equal(used.node("credit-alert-currency-2").props.accessibilityState.disabled, true);
  used.node("credit-alert-currency-2").props.onPress();
  used.render();
  assert.equal(
    used.picker().props.visible,
    false,
    "all-used denominations cannot open an ineffective duplicate picker",
  );
  console.log(
    "PASS actual rule editor: OR/AND, exact localized decimals, directions, currency uniqueness, removal, unknown preview and disabled/RTL controls",
  );
}

type AlertSettings = Awaited<ReturnType<typeof import("../credit-alerts").readCreditAlertSettings>>;
const samplePolicy = (
  relationship = "relationship",
  threshold = 500000,
): policy.CreditAlertPolicy => ({
  relationship_id: relationship,
  updated_at_ms: 10,
  groups: [
    {
      direction: "collect",
      conditions: [
        { currency: "USD", threshold_minor: threshold },
        { currency: "AFN", threshold_minor: 10000000 },
      ],
    },
  ],
});
const settingsFor = (
  own: policy.CreditAlertPolicy | null,
  defaults: policy.CreditAlertPolicy | null = null,
): AlertSettings => ({
  policy: own,
  defaultPolicy: defaults,
  effective: own ?? defaults,
});
class SessionChangedError extends Error {}
class CreditOnlineSaveRequiredError extends Error {}

function screenFixture(
  options: {
    initial?: AlertSettings;
    fresh?: AlertSettings;
    delayRefresh?: boolean;
    role?: string;
    routeId?: string;
    routeVault?: string;
    locale?: "en" | "fa" | "ps";
    signedIn?: boolean;
  } = {},
) {
  const hooks = uiHooks();
  let stored = structuredClone(options.initial ?? settingsFor(samplePolicy()));
  let activeVault = "vault";
  let role = options.role ?? "owner";
  let session = {
    accountId: options.signedIn === false ? null : "owner",
    jwt: options.signedIn === false ? null : "jwt",
    bindingVersion: 1,
  };
  let saveGate: ReturnType<typeof deferred<void>> | null = null;
  let saveFailure: Error | null = null;
  const refreshGate = options.delayRefresh ? deferred<void>() : null;
  let prevention = false;
  let preventionDisabled = false;
  let preventCallback: ((event: { repeat: () => void }) => void) | undefined;
  let ledgerRefresh: () => void = () => {};
  let held = false;
  let balanceReads = 0;
  let requests = 0;
  let registrations = 0;
  const saves: { vault: string; value: policy.CreditAlertPolicy; session: unknown }[] = [];
  const resets: { vault: string; relationship: string }[] = [];
  const notices: string[] = [];
  const routes: string[] = [];
  const editorModule = editorFixture().module;
  const guard = async (before: typeof session, work: () => Promise<unknown>) => {
    if (JSON.stringify(before) !== JSON.stringify(session)) throw new SessionChangedError();
    return work();
  };
  i18n.setLocale(options.locale ?? "en");
  const Screen = compileUI("../../app/person/[id]/credit-alerts", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": {
      useRouter: () => ({ back: () => routes.push("back"), push: () => {} }),
      useLocalSearchParams: () => ({
        id: options.routeId ?? "customer",
        vaultId: options.routeVault ?? "vault",
      }),
      useFocusEffect: (callback: () => void | (() => void)) =>
        hooks.react.useEffect(callback, [callback]),
      usePreventRemove: (prevent: boolean, callback: typeof preventCallback) => {
        prevention = prevent && !preventionDisabled;
        preventCallback = callback;
        return () => {
          preventionDisabled = true;
          prevention = false;
        };
      },
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      Keyboard: { dismiss() {} },
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "android" },
      ScrollView: "ScrollView",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (value: any) => value, hairlineWidth: 1 },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../../../components/Button": { Button: "Button" },
    "../../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../../../components/CreditAlertRuleEditor": {
      CreditAlertRuleEditor: "CreditAlertRuleEditor",
      creditAlertDraftGroups: editorModule.creditAlertDraftGroups,
    },
    "../../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
    "../../../components/Toast": {
      useToast: () => ({ push: (message: string) => notices.push(message) }),
    },
    "../../../lib/auth": {
      SessionChangedError,
      captureCurrentSession: async () => ({ ...session }),
      applyForUnchangedLocalSession: guard,
    },
    "../../../lib/colors": require("../colors"),
    "../../../lib/credit-alerts": {
      readCreditAlertSettings: async () => structuredClone(stored),
      refreshCreditAlerts: async () => {
        if (refreshGate) await refreshGate.promise;
        if (options.fresh) stored = structuredClone(options.fresh);
      },
      creditAlertBalancesInTx: async (
        _db: unknown,
        vault: string,
        relationship: string,
        groups: policy.CreditAlertGroup[],
      ) => {
        assert.equal(held, true, "preview reads the whole currency vector inside the common lock");
        assert.equal(vault, "vault");
        assert.equal(relationship, "relationship");
        balanceReads++;
        return Object.fromEntries(
          groups.flatMap((g) =>
            g.conditions.map((c) => [c.currency, c.currency === "USD" ? 500000 : null]),
          ),
        );
      },
      saveCreditAlertPolicy: async (
        vault: string,
        value: policy.CreditAlertPolicy,
        before: typeof session,
      ) => {
        saves.push({ vault, value: structuredClone(value), session: { ...before } });
        if (saveGate) await saveGate.promise;
        if (saveFailure) throw saveFailure;
        await guard(before, async () => {
          if (role !== "owner" && role !== "manager") throw new Error("Manager required");
          if (value.relationship_id === KAATA_DEFAULT_CREDIT_ID && !before.jwt)
            throw new CreditOnlineSaveRequiredError();
          stored = settingsFor(
            { ...structuredClone(value), updated_at_ms: 20 },
            stored.defaultPolicy,
          );
        });
        return stored.policy;
      },
      deleteCreditAlertPolicy: async (
        vault: string,
        relationship: string,
        before: typeof session,
      ) => {
        resets.push({ vault, relationship });
        if (saveGate) await saveGate.promise;
        if (saveFailure) throw saveFailure;
        await guard(before, async () => {
          stored = settingsFor(null, stored.defaultPolicy);
        });
      },
    },
    "../../../lib/credit-limits": {
      CreditOnlineSaveRequiredError,
      relationshipForCredit: async () => "relationship",
      listCreditCurrencySettings: async () => [{ currency: "AFN" }, { currency: "USD" }],
    },
    "../../../lib/credit-policy": require("../credit-policy"),
    "../../../lib/db": { getPerson: async () => ({ name: "Customer" }) },
    "../../../lib/db-tx": { getActiveVaultIdSyncMaybe: () => activeVault, getDb: async () => ({}) },
    "../../../lib/direction": {
      useIsRTL: () => options.locale === "fa" || options.locale === "ps",
      textDir: (rtl: boolean) => ({ writingDirection: rtl ? "rtl" : "ltr" }),
    },
    "../../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
    "../../../lib/i18n": i18n,
    "../../../lib/money": money,
    "../../../lib/ledger-events": {
      useLedgerRefresh: (_vault: unknown, refresh: () => void) => {
        ledgerRefresh = refresh;
      },
    },
    "../../../lib/projection": {
      applyEventMutex: {
        runExclusive: async (work: () => Promise<unknown>) => {
          assert.equal(held, false);
          held = true;
          try {
            return await work();
          } finally {
            held = false;
          }
        },
      },
    },
    "../../../lib/use-vault-role": {
      readVaultRole: async () => role,
      useActiveVaultWriteCaps: () => ({
        resolved: true,
        canConfigureCredit: role === "owner" || role === "manager",
      }),
    },
    "../../../lib/reminder-notifications": {
      requestReminderNotifications: async () => {
        requests++;
        return "granted";
      },
    },
    "../../../lib/credit-alert-push": {
      syncCreditAlertPushSubscriptions: async (force: boolean) => {
        assert.equal(force, true);
        registrations++;
      },
    },
  }).default;
  const render = () => hooks.render(() => Screen());
  const settle = async () => {
    for (let n = 0; n < 6; n++) {
      await settleUI();
      render();
    }
  };
  const editor = () => {
    const node = nodes(hooks.tree).find((n) => n.type === "CreditAlertRuleEditor");
    assert.ok(node, "loaded rule editor");
    return node;
  };
  const button = (key: Parameters<typeof i18n.t>[0]) => {
    const node = nodes(hooks.tree).find(
      (n) => n.type === "Button" && n.props.label === i18n.t(key),
    );
    assert.ok(node, `screen button ${key}`);
    return node;
  };
  const edit = (amount: string) => {
    const drafts = structuredClone(editor().props.drafts) as CreditAlertDraft[];
    drafts[0].conditions[0].amount = amount;
    editor().props.onChange(drafts);
    render();
  };
  render();
  return {
    hooks,
    render,
    settle,
    editor,
    button,
    edit,
    saves,
    resets,
    notices,
    routes,
    prevent: () => prevention,
    leave: () => preventCallback?.({ repeat: () => routes.push("leave") }),
    dialog: () => nodes(hooks.tree).find((n) => n.type === "ConfirmDialog")!,
    refresh: () => refreshGate?.resolve(),
    ledger: () => ledgerRefresh(),
    balances: () => balanceReads,
    permissionRequests: () => requests,
    registrations: () => registrations,
    holdSave: () => {
      saveGate = deferred<void>();
      return saveGate;
    },
    fail: (error: Error | null) => {
      saveFailure = error;
    },
    switchAccount: () => {
      session = {
        accountId: "replacement",
        jwt: "other",
        bindingVersion: session.bindingVersion + 1,
      };
      render();
    },
    switchVault: () => {
      activeVault = "other-vault";
      render();
    },
    setRole: (value: string) => {
      role = value;
      render();
    },
  };
}

async function screenChecks() {
  const cached = screenFixture({
    delayRefresh: true,
    fresh: settingsFor(samplePolicy("relationship", 800000)),
  });
  await cached.settle();
  assert.equal(cached.editor().props.drafts[0].conditions[0].amount, "5000");
  assert.equal(cached.permissionRequests(), 0, "opening settings never prompts");
  cached.edit("5000.29");
  assert.equal(cached.prevent(), true);
  cached.refresh();
  await cached.settle();
  assert.equal(
    cached.editor().props.drafts[0].conditions[0].amount,
    "5000.29",
    "late refresh preserves touched draft",
  );
  const hold = cached.holdSave();
  cached.button("creditAlerts.save").props.onPress();
  cached.button("creditAlerts.save").props.onPress();
  cached.render();
  assert.equal(cached.saves.length, 1, "double save queues one attempt");
  assert.equal(cached.editor().props.disabled, true);
  assert.equal(cached.saves[0].value.groups[0].conditions[0].threshold_minor, 500029);
  hold.resolve();
  await cached.settle();
  assert.equal(cached.prevent(), false);
  assert.equal(cached.permissionRequests(), 1);
  assert.equal(cached.registrations(), 1);
  assert.ok(cached.notices.includes(i18n.t("creditAlerts.saved")));
  const beforeBalances = cached.balances();
  cached.ledger();
  await cached.settle();
  assert.ok(cached.balances() > beforeBalances, "ledger applies refresh live exposure preview");
  const fresh = screenFixture({
    delayRefresh: true,
    fresh: settingsFor(samplePolicy("relationship", 800000)),
  });
  await fresh.settle();
  fresh.refresh();
  await fresh.settle();
  assert.equal(
    fresh.editor().props.drafts[0].conditions[0].amount,
    "8000",
    "untouched cache adopts fresh configuration",
  );
  const inherited = screenFixture({
    initial: settingsFor(null, samplePolicy(KAATA_DEFAULT_CREDIT_ID)),
  });
  await inherited.settle();
  assert.ok(words(inherited.hooks.tree).includes(i18n.t("creditAlerts.usesDefault")));
  inherited.editor().props.onChange([]);
  inherited.render();
  inherited.button("creditAlerts.save").props.onPress();
  await inherited.settle();
  assert.deepEqual(
    inherited.saves[0].value.groups,
    [],
    "saving blank rules creates explicit off override",
  );
  assert.equal(inherited.permissionRequests(), 0, "saving off never prompts");
  inherited.button("creditAlerts.reset").props.onPress();
  await inherited.settle();
  assert.equal(inherited.resets.length, 1);
  assert.equal(inherited.editor().props.drafts.length, 1, "reset returns to inherited default");
  const invalid = screenFixture();
  await invalid.settle();
  invalid.edit("0.001");
  invalid.button("creditAlerts.save").props.onPress();
  await invalid.settle();
  assert.equal(invalid.saves.length, 0);
  assert.equal(invalid.editor().props.validation, true);
  assert.ok(words(invalid.hooks.tree).includes(i18n.t("creditAlerts.invalid")));
  const failure = screenFixture();
  await failure.settle();
  failure.edit("9000");
  failure.fail(new Error("offline"));
  failure.button("creditAlerts.save").props.onPress();
  await failure.settle();
  assert.equal(failure.editor().props.drafts[0].conditions[0].amount, "9000");
  assert.equal(failure.prevent(), true);
  assert.equal(failure.permissionRequests(), 0);
  assert.ok(words(failure.hooks.tree).includes(i18n.t("credit.saveFailed")));
  failure.leave();
  failure.render();
  assert.equal(failure.dialog().props.visible, true);
  failure.dialog().props.onCancel();
  failure.render();
  assert.deepEqual(failure.routes, []);
  failure.leave();
  failure.render();
  failure.dialog().props.onConfirm();
  failure.render();
  assert.deepEqual(failure.routes, ["leave"]);
  for (const role of ["editor", "clerk", "viewer"]) {
    const blocked = screenFixture({ role });
    await blocked.settle();
    assert.equal(blocked.editor().props.disabled, true, `${role} cannot edit alerts`);
    blocked.edit("9000");
    blocked.button("creditAlerts.save").props.onPress();
    await blocked.settle();
    assert.equal(blocked.saves.length, 0);
    assert.equal(blocked.editor().props.drafts[0].conditions[0].amount, "5000");
  }
  const defaultOffline = screenFixture({ routeId: "kaata-default", signedIn: false });
  await defaultOffline.settle();
  defaultOffline.button("creditAlerts.save").props.onPress();
  await defaultOffline.settle();
  assert.ok(words(defaultOffline.hooks.tree).includes(i18n.t("credit.onlineSave")));
  const changed = screenFixture();
  await changed.settle();
  changed.edit("6000");
  const pending = changed.holdSave();
  changed.button("creditAlerts.save").props.onPress();
  changed.switchAccount();
  pending.resolve();
  await changed.settle();
  assert.equal(changed.notices.length, 0);
  assert.equal(changed.permissionRequests(), 0);
  const moved = screenFixture();
  await moved.settle();
  const retained = moved.button("creditAlerts.save").props.onPress;
  moved.switchVault();
  retained();
  await moved.settle();
  assert.equal(moved.saves.length, 0, "retained button cannot save into replacement Kaata");
  const unmounted = screenFixture();
  await unmounted.settle();
  const unmountGate = unmounted.holdSave();
  unmounted.button("creditAlerts.save").props.onPress();
  unmounted.hooks.unmount();
  unmountGate.resolve();
  await settleUI();
  assert.equal(unmounted.hooks.lateWrites, 0);
  assert.equal(unmounted.notices.length, 0);
  for (const locale of ["en", "fa", "ps"] as const) {
    i18n.setLocale(locale);
    assert.ok(!i18n.t("creditAlerts.title").startsWith("creditAlerts."));
    assert.ok(!i18n.t("creditAlerts.or").startsWith("creditAlerts."));
    assert.ok(!i18n.t("creditAlerts.and").startsWith("creditAlerts."));
  }
  console.log(
    "PASS actual settings route: cache/refresh drafts, exact save/off/reset, coherent preview, dirty/discard/errors, roles, session/vault/unmount guards and intentional permission timing",
  );
}

void (async () => {
  editorChecks();
  await screenChecks();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
