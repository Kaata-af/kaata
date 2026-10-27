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
  let locale = options.rtl ? "fa" : "en";
  let currencyNameReads = 0;
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
    "../../components/SettingsScreen": { NavRow: "NavRow", ScreenHeader: "Header" },
    "../../components/Toast": {
      useToast: () => ({ push: (...args: unknown[]) => toasts.push(args) }),
    },
    "../../lib/colors": { colors: {} },
    "../../lib/currency": {
      CURRENCIES: currencies,
      DEFAULT_CURRENCY: "AFN",
      getCurrencyName: (code: string) => {
        currencyNameReads++;
        return `${locale}:name:${code}`;
      },
      getCurrencyLabel: (code: string) =>
        `${code} ${currencies.find((item) => item.code === code)?.symbol ?? code}`,
      currencyNeedsPrecisionHint: (code: string) => code === "KWD",
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
      bidiIsolate: (value: string) => `\u2068${value}\u2069`,
    },
    "../../lib/event-log": { appendShopProfileUpdated: async () => stages.push("shop-event") },
    "../../lib/i18n": {
      getLocale: () => locale,
      t: (key: string, values?: unknown) => key + (values ? ` ${JSON.stringify(values)}` : ""),
    },
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
  const enabledRow = () => row("vaultSettings.currencies.label");
  const enabled = () => one("EnabledCurrenciesSheet");
  const name = (value: string) => {
    one("FormField").props.onChangeText(value);
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
    enabledRow,
    enabled,
    name,
    openEnabled,
    get keyboardDismissals() {
      return keyboardDismissals;
    },
    get currencyNameReads() {
      return currencyNameReads;
    },
    setLocale: (value: string) => {
      locale = value;
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
    assert.equal(
      nodes(f.hooks.tree).filter((node) => node.type === "NavRow").length,
      1,
      "One currency field combines enabled choices and their default",
    );
    assert.equal(
      nodes(f.hooks.tree).filter((node) => node.type === "EnabledCurrenciesSheet").length,
      1,
    );
    assert.ok(!nodes(f.hooks.tree).some((node) => node.type === "CurrencyPickerSheet"));
    assert.equal(f.enabled().props.options.length, 155);
    const originalOptions = f.enabled().props.options;
    const originalNameReads = f.currencyNameReads;
    assert.deepEqual(f.enabled().props.selected, ["AFN"]);
    assert.equal(f.enabled().props.defaultCurrency, "AFN");
    assert.match(f.enabledRow().props.hint, /AFN/);
    assert.match(f.enabledRow().props.trailing, /"count":1/);
    const discarded = f.openEnabled();
    assert.equal(f.keyboardDismissals, 1, "Opening the combined sheet dismisses the name keyboard");
    discarded.onSetDefault("USD");
    f.render();
    assert.equal(
      f.enabled().props.defaultCurrency,
      "AFN",
      "An unchecked currency cannot become the draft default",
    );
    discarded.onToggle("USD");
    f.render();
    f.enabled().props.onSetDefault("USD");
    discarded.onToggle("USD");
    f.render();
    assert.deepEqual(
      f.enabled().props.selected,
      ["AFN", "USD"],
      "The new draft default is protected even before React commits",
    );
    assert.equal(f.enabled().props.defaultCurrency, "USD");
    assert.equal(
      f.enabled().props.options,
      originalOptions,
      "Checkbox and default changes reuse the catalog objects",
    );
    assert.equal(
      f.currencyNameReads,
      originalNameReads,
      "Selection does not translate all155currency names again",
    );
    discarded.onToggle("AFN");
    f.render();
    assert.deepEqual(
      f.enabled().props.selected,
      ["USD"],
      "A previous default can be unchecked after the star changes",
    );
    assert.match(
      f.enabledRow().props.hint,
      /AFN/,
      "Draft default changes do not alter the form yet",
    );
    f.name("Draft shop");
    await f.one("Button").props.onPress();
    assert.equal(f.creations.length, 0, "Create cannot bypass an unsaved currency sheet");
    discarded.onDismiss();
    f.render();
    let sheet = f.openEnabled();
    assert.deepEqual(sheet.selected, ["AFN"]);
    assert.equal(
      sheet.defaultCurrency,
      "AFN",
      "Cancel discards both the draft set and draft default",
    );
    sheet.onToggle("USD");
    f.render();
    f.enabled().props.onSetDefault("USD");
    f.enabled().props.onToggle("AFN");
    f.render();
    const saved = f.enabled().props;
    saved.onSave();
    f.render();
    assert.equal(f.enabled().props.defaultCurrency, "USD");
    assert.deepEqual(f.enabled().props.selected, ["USD"]);
    assert.match(f.enabledRow().props.hint, /USD/);
    assert.match(f.enabledRow().props.trailing, /"count":1/);
    discarded.onToggle("EUR");
    discarded.onSetDefault("AFN");
    discarded.onSave();
    f.render();
    assert.deepEqual(
      f.enabled().props.selected,
      ["USD"],
      "Old sessions cannot overwrite the saved pair",
    );
    sheet = f.openEnabled();
    sheet.onToggle("GBP");
    f.render();
    f.enabled().props.onSetDefault("GBP");
    f.render();
    f.enabled().props.onSave();
    f.render();
    assert.deepEqual(f.enabled().props.selected, ["USD", "GBP"]);
    assert.equal(f.enabled().props.defaultCurrency, "GBP");
    assert.ok(
      f.enabledRow().props.accessibilityLabel.includes("USD $"),
      "The nondefault enabled currency remains audible from the field",
    );
    assert.ok(
      f.enabledRow().props.accessibilityLabel.includes("GBP £"),
      "All enabled ISO labels and symbols are announced",
    );
    assert.ok(
      f.enabledRow().props.hint.includes("\u2068GBP £\u2069"),
      "The default summary isolates the currency token within localized prose",
    );
    assert.match(f.enabledRow().props.trailing, /"count":2/);
    sheet = f.openEnabled();
    sheet.onToggle("KWD");
    f.render();
    f.enabled().props.onSetDefault("KWD");
    f.render();
    f.enabled().props.onSave();
    f.render();
    assert.ok(
      nodes(f.hooks.tree).some(
        (node) => node.type === "Text" && node.props.children === "currency.precisionHint",
      ),
      "Three-decimal ISO currencies retain the two-decimal storage explanation",
    );
    const stale = f.openEnabled();
    stale.onDismiss();
    f.render();
    f.openEnabled();
    stale.onSetDefault("USD");
    stale.onToggle("EUR");
    stale.onSave();
    stale.onDismiss();
    f.render();
    assert.equal(f.enabled().props.visible, true);
    assert.equal(
      f.enabled().props.defaultCurrency,
      "KWD",
      "Reopening rejects retained star/save/dismiss callbacks from the previous session",
    );
    f.enabled().props.onDismiss();
    f.render();
    f.setLocale("ps");
    f.render();
    assert.notEqual(
      f.enabled().props.options,
      originalOptions,
      "A locale change refreshes option labels even when RTL stays true",
    );
    assert.equal(f.enabled().props.options[0].label, "ps:name:AFN");
    f.hooks.unmount();
    stale.onSetDefault("USD");
    saved.onSave();
    assert.equal(f.hooks.lateWrites, 0, "Departed sheet callbacks cannot write state");
  }

  const full = fixture();
  await full.flush();
  const fullSheet = full.openEnabled();
  for (const item of currencies.slice(1, 64)) fullSheet.onToggle(item.code);
  full.render();
  const committed = [...full.enabled().props.selected];
  assert.equal(committed.length, 64);
  fullSheet.onToggle(currencies[64].code);
  fullSheet.onSetDefault(currencies[64].code);
  full.render();
  assert.equal(full.enabled().props.defaultCurrency, "AFN");
  assert.deepEqual(
    full.enabled().props.selected,
    committed,
    "Retained callbacks cannot add a65th currency or star an unchecked choice",
  );
  full.enabled().props.onSetDefault("USD");
  fullSheet.onToggle("USD");
  full.render();
  assert.equal(full.enabled().props.defaultCurrency, "USD");
  assert.deepEqual(
    full.enabled().props.selected,
    committed,
    "Changing the default within a full set keeps it selected",
  );
  full.enabled().props.onSave();
  full.render();
  assert.equal(full.enabled().props.defaultCurrency, "USD");
  full.hooks.unmount();

  const preset = fixture({ preset: "USD" });
  await preset.flush();
  assert.equal(preset.enabled().props.defaultCurrency, "USD");
  assert.deepEqual(
    preset.enabled().props.selected,
    ["USD"],
    "Shared-tab preset initializes the saved default and singleton together",
  );
  for (const touch of ["open", "edit", "create"] as const) {
    const pending = deferred<void>();
    const f = fixture({ preset: "USD", presetGate: pending.promise });
    if (touch === "open") f.openEnabled();
    else if (touch === "edit") {
      f.openEnabled().onToggle("EUR");
      f.render();
      f.enabled().props.onSetDefault("EUR");
      f.render();
    } else {
      f.name("Shop");
      const key = deferred<void>();
      f.setKeyGate(key.promise);
      void f.one("Button").props.onPress();
    }
    pending.resolve();
    await f.flush();
    assert.equal(
      f.enabled().props.defaultCurrency,
      touch === "edit" ? "EUR" : "AFN",
      "A late preset cannot clobber an opened, edited or creating form",
    );
    assert.deepEqual(f.enabled().props.selected, touch === "edit" ? ["AFN", "EUR"] : ["AFN"]);
    f.hooks.unmount();
  }

  for (const account of [null, "signed-owner"]) {
    const f = fixture({ account });
    await f.flush();
    f.name("  New shop  ");
    f.openEnabled().onToggle("USD");
    f.render();
    f.enabled().props.onSetDefault("USD");
    f.render();
    f.enabled().props.onSave();
    f.render();
    const key = deferred<void>(),
      commit = deferred<void>();
    f.setKeyGate(key.promise);
    f.setCreationGate(commit.promise);
    const enabledOpener = f.enabledRow().props.onPress;
    const retainedSheet = f.enabled().props;
    const retainedBack = f.one("Header").props.onBack;
    const submit = f.one("Button").props.onPress;
    const first = submit();
    const duplicate = submit();
    f.render();
    assert.equal(f.one("Button").props.disabled, true);
    assert.equal(f.enabledRow().props.disabled, true);
    enabledOpener();
    retainedSheet.onSetDefault("AFN");
    retainedSheet.onToggle("EUR");
    retainedSheet.onSave();
    retainedBack();
    f.one("FormField").props.onChangeText("replaced");
    f.render();
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
    assert.equal(
      f.creations[0].currency,
      "USD",
      "The saved draft default reaches the atomic creation helper",
    );
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
