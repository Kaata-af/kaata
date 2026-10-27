// Exercise the real post-onboarding form; the atomic storage engine has its
// own SQLite regressions. No account, native device or backend is used here.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { requireEnabledCurrencies } from "../currency-settings";
import { requireCurrencyCode } from "../currency-scope";
import { CURRENCIES } from "../currency-catalog";

const currencies = CURRENCIES;
const validate = (currency: string, enabled?: readonly string[]) => {
  requireCurrencyCode(currency);
  const codes = requireEnabledCurrencies(enabled ?? [currency]);
  assert.ok(codes.includes(currency));
  return codes;
};

function fixture(
  options: {
    rtl?: boolean;
    account?: string | null;
    forced?: boolean;
    presetGate?: Promise<void>;
    preset?: string;
  } = {},
) {
  const hooks = uiHooks();
  const routes: unknown[] = [],
    toasts: any[] = [],
    writes: any[] = [],
    stages: string[] = [],
    creations: any[] = [],
    registrations: any[] = [];
  let account = options.account ?? null;
  let keyboardDismissals = 0;
  let keyGate: Promise<void> | null = null,
    creationGate: Promise<void> | null = null;
  let failure: Error | null = null;
  const meta = new Map<string, string>([
    ["pending_tab_token", options.preset ? "invitation" : ""],
    ["pending_tab_currency", options.preset ?? ""],
  ]);
  const tx = {
    runAsync: async (sql: string, ...params: unknown[]) => {
      writes.push({ sql, params });
    },
  };
  const Screen = compileUI("../../app/vault/new", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-crypto": { randomUUID: () => "new-vault" },
    "expo-router": {
      useRouter: () => ({
        replace: (route: unknown) => routes.push(route),
        back: () => routes.push("back"),
      }),
      useLocalSearchParams: () => ({ forced: options.forced ? "1" : undefined }),
    },
    "react-native": {
      View: "View",
      Text: "Text",
      ScrollView: "ScrollView",
      KeyboardAvoidingView: "Keyboard",
      Keyboard: { dismiss: () => keyboardDismissals++ },
      Platform: { OS: "ios" },
      StyleSheet: { create: (style: unknown) => style },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeArea" },
    "../../components/Button": { Button: "Button" },
    "../../components/FormField": { FormField: "FormField" },
    "../../components/EnabledCurrenciesSheet": { EnabledCurrenciesSheet: "EnabledCurrenciesSheet" },
    "../../components/CurrencyPickerSheet": { CurrencyPickerSheet: "CurrencyPickerSheet" },
    "../../components/SettingsScreen": { NavRow: "NavRow", ScreenHeader: "Header" },
    "../../components/Toast": {
      useToast: () => ({ push: (...args: unknown[]) => toasts.push(args) }),
    },
    "../../lib/colors": { colors: {} },
    "../../lib/currency": {
      CURRENCIES: currencies,
      DEFAULT_CURRENCY: "AFN",
      getCurrencyName: (code: string) => `name:${code}`,
      currencyNeedsPrecisionHint: () => false,
    },
    "../../lib/db-tx": {
      ACTIVE_VAULT_META_KEY: "active_vault_id",
      getDb: async () => tx,
      getAccountIdSync: () => account,
      setActiveVaultIdCache: (id: string) => stages.push(`cache:${id}`),
      setAppMetaInTx: async (_db: unknown, key: string, value: string) => {
        writes.push({ key, value });
      },
    },
    "../../lib/db": {
      getAppMeta: async (key: string) => {
        await options.presetGate;
        return meta.get(key) ?? null;
      },
      getLocalSelf: async () => ({ name: "Synthetic owner" }),
      setAppMeta: async (key: string, value: string) => {
        meta.set(key, value);
      },
    },
    "../../lib/direction": {
      useIsRTL: () => options.rtl ?? false,
      rowDir: () => ({}),
      textDir: () => ({}),
      bidiIsolate: (value: string) => value,
    },
    "../../lib/event-log": { appendShopProfileUpdated: async () => stages.push("shop-event") },
    "../../lib/i18n": { t: (key: string) => key },
    "../../lib/mesh/device-key": {
      ensureDeviceKey: async () => {
        stages.push("prepare-key");
        await keyGate;
      },
      getDevicePubkey: () => "device-pubkey",
    },
    "../../lib/tokens": { gutter: {}, icon: {}, radius: {}, space: {}, typography: {} },
    "../../lib/trust/account-id": { buildLocalAccountId: (pubkey: string) => `local:${pubkey}` },
    "../../lib/vault-api": {
      createVaultOnServer: async (args: unknown) => {
        registrations.push(args);
      },
    },
    "../../lib/mesh": { notifyVaultSetChanged: async () => stages.push("notify-mesh") },
    "../../lib/vault-initial-currencies": {
      validateInitialVaultCurrencies: validate,
      createVaultWithCurrencies: async (
        args: any,
        initialize: (db: typeof tx) => Promise<void>,
      ) => {
        creations.push(args);
        stages.push("begin");
        await initialize(tx);
        await creationGate;
        if (failure) {
          writes.length = 0;
          throw failure;
        }
        stages.push("committed-currencies-and-genesis");
      },
    },
  }).default;
  const render = () => hooks.render(Screen);
  const flush = async () => {
    await settleUI();
    render();
  };
  render();
  const one = (type: string) => nodes(hooks.tree).find((node) => node.type === type)!;
  const row = (label: string) =>
    nodes(hooks.tree).find((node) => node.type === "NavRow" && node.props.label === label)!;
  const defaultRow = () => row("vaultNew.currency.label");
  const enabledRow = () => row("vaultSettings.currencies.label");
  const defaults = () => one("CurrencyPickerSheet");
  const enabled = () => one("EnabledCurrenciesSheet");
  const name = (value: string) => {
    one("FormField").props.onChangeText(value);
    render();
  };
  const openDefault = () => {
    defaultRow().props.onPress();
    render();
    return defaults().props;
  };
  const pickDefault = (code: string) => {
    openDefault().onSelect(code);
    render();
  };
  const openEnabled = () => {
    enabledRow().props.onPress();
    render();
    return enabled().props;
  };
  return {
    hooks,
    render,
    flush,
    routes,
    toasts,
    writes,
    stages,
    creations,
    registrations,
    meta,
    one,
    defaultRow,
    enabledRow,
    defaults,
    enabled,
    name,
    openDefault,
    pickDefault,
    openEnabled,
    get keyboardDismissals() {
      return keyboardDismissals;
    },
    setKeyGate: (value: Promise<void>) => {
      keyGate = value;
    },
    setCreationGate: (value: Promise<void>) => {
      creationGate = value;
    },
    failCreation: () => {
      failure = new Error("synthetic signed settings failure");
    },
  };
}

async function main() {
  for (const rtl of [false, true]) {
    const f = fixture({ rtl });
    await f.flush();
    assert.deepEqual(f.enabled().props.selected, ["AFN"]);
    assert.equal(f.enabled().props.defaultCurrency, "AFN");
    assert.equal(
      f.defaults().props.allowedCurrencies,
      undefined,
      "default picker offers the complete catalog while the enabled set has room",
    );
    f.pickDefault("USD");
    assert.equal(f.keyboardDismissals, 1, "Opening the default picker releases the name keyboard");
    assert.deepEqual(
      f.enabled().props.selected,
      ["USD"],
      "Changing an untouched singleton replaces its old default",
    );
    const discarded = f.openEnabled();
    assert.equal(f.keyboardDismissals, 2, "Opening enabled choices releases the name keyboard");
    discarded.onToggle("USD");
    f.render();
    assert.deepEqual(
      f.enabled().props.selected,
      ["USD"],
      "The default cannot be unchecked even through a retained callback",
    );
    discarded.onToggle("EUR");
    f.render();
    assert.equal(
      f.enabledRow().props.trailing,
      "USD",
      "Checkbox drafts do not change the committed form",
    );
    f.enabled().props.onDismiss();
    f.render();
    assert.deepEqual(f.openEnabled().selected, ["USD"], "Cancel discards checkbox edits");
    f.enabled().props.onToggle("GBP");
    f.render();
    const saved = f.enabled().props;
    saved.onSave();
    f.render();
    assert.equal(f.enabledRow().props.trailing, "USD · GBP");
    discarded.onToggle("EUR");
    discarded.onSave();
    saved.onToggle("AFN");
    f.render();
    assert.equal(
      f.enabledRow().props.trailing,
      "USD · GBP",
      "Old sheet sessions cannot overwrite saved choices",
    );
    f.pickDefault("EUR");
    assert.deepEqual(
      f.enabled().props.selected,
      ["USD", "GBP", "EUR"],
      "Changing a multi-currency default retains its set and includes the new default",
    );
    const staleDefault = f.openDefault();
    staleDefault.onDismiss();
    f.render();
    f.openDefault();
    staleDefault.onSelect("AFN");
    f.render();
    assert.equal(
      f.defaults().props.selectedCode,
      "EUR",
      "A reopened picker rejects a prior session's selection",
    );
    f.defaults().props.onDismiss();
    f.render();
    f.hooks.unmount();
    staleDefault.onSelect("AFN");
    saved.onSave();
    assert.equal(f.hooks.lateWrites, 0, "Departed picker callbacks cannot write state");
  }

  const full = fixture();
  await full.flush();
  full.openEnabled();
  for (const item of currencies.slice(1, 64)) {
    full.enabled().props.onToggle(item.code);
    full.render();
  }
  full.enabled().props.onSave();
  full.render();
  const committed = [...full.enabled().props.selected];
  assert.equal(committed.length, 64);
  const fullPicker = full.openDefault();
  assert.deepEqual(
    fullPicker.allowedCurrencies,
    committed,
    "a full enabled set cannot offer a new default that would create an invalid 65th choice",
  );
  fullPicker.onSelect(currencies[64].code);
  full.render();
  assert.equal(full.defaults().props.selectedCode, "AFN");
  assert.deepEqual(
    full.enabled().props.selected,
    committed,
    "even a retained callback respects the enabled limit",
  );
  full.defaults().props.onSelect(currencies[1].code);
  full.render();
  assert.equal(
    full.defaults().props.selectedCode,
    currencies[1].code,
    "changing the default within a full enabled set still works",
  );
  assert.deepEqual(full.enabled().props.selected, committed);
  full.hooks.unmount();

  const preset = fixture({ preset: "USD" });
  await preset.flush();
  assert.equal(preset.defaults().props.selectedCode, "USD");
  assert.deepEqual(
    preset.enabled().props.selected,
    ["USD"],
    "A shared-tab preset initializes default and singleton together",
  );
  for (const touch of ["default", "enabled", "create"] as const) {
    const pending = deferred<void>();
    const f = fixture({ preset: "USD", presetGate: pending.promise });
    if (touch === "default") f.openDefault();
    else if (touch === "enabled") f.openEnabled();
    else {
      f.name("Shop");
      const key = deferred<void>();
      f.setKeyGate(key.promise);
      void f.one("Button").props.onPress();
    }
    pending.resolve();
    await f.flush();
    assert.equal(
      f.defaults().props.selectedCode,
      "AFN",
      `${touch}: late preset cannot clobber an engaged form`,
    );
    assert.deepEqual(f.enabled().props.selected, ["AFN"]);
    f.hooks.unmount();
  }

  for (const account of [null, "signed-owner"]) {
    const f = fixture({ account });
    await f.flush();
    f.name("  New shop  ");
    f.openEnabled().onToggle("USD");
    f.render();
    f.enabled().props.onSave();
    f.render();
    const key = deferred<void>(),
      commit = deferred<void>();
    f.setKeyGate(key.promise);
    f.setCreationGate(commit.promise);
    const defaultOpener = f.defaultRow().props.onPress,
      enabledOpener = f.enabledRow().props.onPress;
    const retainedBack = f.one("Header").props.onBack;
    const submit = f.one("Button").props.onPress;
    const first = submit();
    const duplicate = submit();
    f.render();
    assert.equal(f.one("Button").props.disabled, true);
    assert.equal(f.defaultRow().props.disabled, true);
    assert.equal(f.enabledRow().props.disabled, true);
    defaultOpener();
    enabledOpener();
    retainedBack();
    f.one("FormField").props.onChangeText("replaced");
    f.render();
    assert.equal(f.defaults().props.visible, false);
    assert.equal(f.enabled().props.visible, false);
    assert.deepEqual(f.routes, [], "A retained Back action cannot leave creation while busy");
    assert.equal(
      f.one("FormField").props.value,
      "  New shop  ",
      "Busy form rejects retained input edits",
    );
    key.resolve();
    await f.flush();
    assert.equal(f.creations.length, 1, "Same-frame submission cannot create duplicate books");
    assert.equal(f.creations[0].accountId, account);
    assert.equal(f.creations[0].expectedSignerPubkey, "device-pubkey");
    assert.equal(f.creations[0].ownerDisplayName, "Synthetic owner");
    assert.deepEqual(f.creations[0].enabledCurrencies, ["AFN", "USD"]);
    assert.deepEqual(f.routes, []);
    assert.deepEqual(f.toasts, []);
    assert.ok(
      !f.stages.some((stage) => stage.startsWith("cache:")),
      "Active cache cannot flip before signed settings commit",
    );
    commit.resolve();
    await Promise.all([first, duplicate]);
    await f.flush();
    assert.ok(
      f.stages.indexOf("committed-currencies-and-genesis") < f.stages.indexOf("cache:new-vault"),
    );
    assert.deepEqual(f.routes, ["/"]);
    assert.equal(f.toasts.at(-1)?.[1], "success");
    assert.equal(
      f.registrations.length,
      account ? 1 : 0,
      "Server registration still follows sign-in state",
    );
    assert.ok(
      f.writes.some((write) => write.key === "active_vault_id" && write.value === "new-vault"),
    );
  }
  const failed = fixture();
  await failed.flush();
  failed.name("Failure shop");
  failed.failCreation();
  await failed.one("Button").props.onPress();
  await failed.flush();
  assert.deepEqual(failed.routes, []);
  assert.deepEqual(failed.writes, []);
  assert.ok(!failed.stages.some((stage) => stage.startsWith("cache:")));
  assert.equal(failed.toasts.at(-1)?.[1], "error");
  assert.equal(
    failed.one("Button").props.disabled,
    false,
    "Atomic settings failure leaves the form retryable",
  );
  const forced = fixture({ forced: true });
  assert.equal(forced.one("Header").props.onBack, null);
  console.log(
    "PASS new Kaata currencies: default/enabled drafts, Save/Cancel, immutable picker sessions, pending presets, busy/double guards and atomic creation success/failure handoff in EN/FA",
  );
}
void main();
