import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import * as scope from "../currency-scope";
import * as settings from "../currency-settings";
import { Mutex } from "../util/mutex";

function fixture() {
  const store = new Database(":memory:");
  store.exec(`CREATE TABLE vaults(id TEXT PRIMARY KEY,name TEXT,currency TEXT,legacy_currency TEXT,default_entry_currency TEXT,archived_at INTEGER,updated_at INTEGER,vault_trust_anchor_pubkey TEXT);
    CREATE TABLE vault_settings(vault_id TEXT,key TEXT,value TEXT,hlc_pms INTEGER,hlc_l INTEGER,hlc_did TEXT,updated_at INTEGER,PRIMARY KEY(vault_id,key));
    CREATE TABLE entries(id TEXT,currency TEXT,amount_afn REAL);
    INSERT INTO vaults VALUES('v','Shop','AFN','AFN','AFN',NULL,1,'anchor');
    INSERT INTO entries VALUES('old-usd','USD',123.45);`);
  let account: string | null = "owner",
    binding = 1,
    role = "owner",
    clock = 100;
  let beforeApply: (() => void | Promise<void>) | null = null;
  let keyboardDismisses = 0;
  const projectionMutex = new Mutex();
  let afterEnabledRead: (() => void) | null = null;
  let delayRawRead = false;
  let remoteQueued: Promise<void> = Promise.resolve();
  let viewport = { height: 800, top: 24, fontScale: 1 };
  let beforeDiscovery: (() => void) | null = null;
  let discoveryReads = 0;
  const authored: any[] = [],
    toasts: string[] = [];
  const session = () => ({
    accountId: account,
    jwt: account ? `jwt-${account}` : null,
    bindingVersion: binding,
  });
  const auth = {
    captureCurrentSession: async () => session(),
    applyForUnchangedLocalSession: async (expected: any, work: any) => {
      assert.equal(expected.accountId, account, "stale account must not write");
      assert.equal(expected.bindingVersion, binding, "stale binding must not write");
      return work();
    },
  };
  const tx: any = {
    getFirstAsync: async (sql: string, ...args: any[]) => {
      if (
        delayRawRead &&
        sql === "SELECT value FROM vault_settings WHERE vault_id=? AND key='enabled_currencies'"
      ) {
        delayRawRead = false;
        await settleUI();
      }
      return store.prepare(sql).get(...args) ?? null;
    },
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: any[]) => store.prepare(sql).run(...args),
  };
  const dbTx = {
    getDb: async () => tx,
    getAccountIdSync: () => account,
    getActiveVaultIdSync: () => "v",
    getActiveVaultIdSyncMaybe: () => "v",
    getInstallIdSync: () => "device",
    getLocalSelfUserIdSync: () => "self",
  };
  const projection = compileUI("../projection/vault_settings", {
    "../hlc": require("../hlc"),
    "../currency-settings": settings,
  });
  const eventLog = compileUI("../event-log", {
    "expo-crypto": { randomUUID },
    "./db-tx": dbTx,
    "./mesh/device-key": {},
    "./event-sig": {},
    "./money": require("../money"),
    "./money-sql": require("../money-sql"),
    "./tabs/errors": require("../tabs/errors"),
    "./entry-date": require("../entry-date"),
    "./currency-scope": scope,
    "./currency-settings": settings,
    "./projection": {
      applyEvent: async (event: any, options: any) =>
        projectionMutex.runExclusive(async () => {
          await beforeApply?.();
          await options.preflightAbort?.(tx);
          if (role !== "owner")
            return {
              applied: false,
              reason: "role_gate",
              role_gate: {
                reason: "insufficient_role",
                current_role: role,
                required_role: "owner",
              },
            };
          event.hlc = { pms: ++clock, l: 0, did: "device" };
          event.appended_at = clock;
          await projection.applyVaultSettingSet(tx, event);
          authored.push(event);
          return { applied: true };
        }),
    },
  });
  const currency = compileUI("../currency", {
    "./db": {
      getAppMeta: async () => null,
      setAppMeta: async () => {},
      listLedgerCurrencies: async (vaultId: string) => {
        assert.equal(vaultId, "v", "historical choices stay scoped to the requested book");
        discoveryReads++;
        const row = store
          .prepare("SELECT currency,legacy_currency,default_entry_currency FROM vaults WHERE id=?")
          .get(vaultId) as any;
        const used = (
          store.prepare("SELECT DISTINCT currency FROM entries ORDER BY currency").all() as {
            currency: string;
          }[]
        ).map((row) => row.currency);
        beforeDiscovery?.();
        return [...new Set([row.default_entry_currency, row.legacy_currency, ...used])];
      },
    },
    "./db-tx": dbTx,
    "./i18n": { getLocale: () => "en" },
    react: {},
    "./currency-scope": scope,
    "./currency-settings": settings,
  }) as typeof import("../currency");
  const router = compileUI("../vault-router", {
    "./auth": auth,
    "./db-tx": dbTx,
    "./effective-account": {},
    "./event-log": eventLog,
    "./vault-api": {},
    "./ownership-transfer-readiness": {},
    "./currency-settings": settings,
  }) as typeof import("../vault-router");
  const hooks = uiHooks();
  const surfaceModule = compileUI(
    "../../components/SheetSurface",
    {
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        View: "View",
        Platform: { OS: "ios" },
        StyleSheet: { create: (style: any) => style, flatten: flattenStyle },
        useWindowDimensions: () => viewport,
      },
      "react-native-safe-area-context": {
        SafeAreaView: "SafeAreaView",
        useSafeAreaInsets: () => ({ top: viewport.top, bottom: 12, left: 0, right: 0 }),
      },
    },
    { __DEV__: false },
  );
  const Sheet = compileUI("../../components/EnabledCurrenciesSheet", {
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Animated: { View: "AnimatedView" },
      Modal: "Modal",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (s: any) => s, absoluteFill: {}, hairlineWidth: 1 },
      Text: "Text",
      View: "View",
      useWindowDimensions: () => viewport,
    },
    "./SheetSurface": surfaceModule,
    "./Button": { Button: "Button" },
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./SheetHandle": { SheetHandle: "SheetHandle" },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: (visible: boolean) => ({ rendered: visible, opacity: 1, position: {} }),
    },
    "../lib/use-sheet-drag": {
      useSheetDrag: (_visible: boolean, _position: any, onDismiss: any) => ({
        dismiss: onDismiss,
        translateY: 0,
        surfacePanHandlers: {},
        panHandlers: {},
        scrollProps: {},
      }),
    },
    "../lib/colors": require("../colors"),
    "../lib/fonts": { fonts: {} },
    "../lib/direction": { rowDir: () => ({}), textDir: () => ({}) },
    "../lib/i18n": { t: (key: string) => key },
    "../lib/tokens": { icon: { row: 22 } },
    "../lib/design-tokens": {
      SETTINGS_ROW_MIN_HEIGHT: 52,
      SETTINGS_ROW_PADDING_X: 20,
      SETTINGS_ROW_PADDING_Y: 12,
      SETTINGS_SHEET_TOP_RADIUS: 20,
    },
  }).EnabledCurrenciesSheet;
  const componentNames = [
    "BottomSheet",
    "Button",
    "ConfirmDialog",
    "FormField",
    "OptionSheet",
    "ScreenLoading",
  ];
  const mocks: Record<string, any> = Object.fromEntries(
    componentNames.map((name) => [`../../components/${name}`, { [name]: name }]),
  );
  Object.assign(mocks, {
    "../../lib/credit-policy": { KAATA_DEFAULT_ROUTE_ID: "default" },
    "../../components/EnabledCurrenciesSheet": { EnabledCurrenciesSheet: Sheet },
    "@expo/vector-icons": { Ionicons: "Ionicons" },
    "expo-router": {
      useFocusEffect: (effect: any) => hooks.react.useEffect(effect, []),
      useLocalSearchParams: () => ({ id: "v" }),
      useRouter: () => ({ back() {}, push() {}, replace() {} }),
    },
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "android" },
      Keyboard: {
        dismiss: () => {
          keyboardDismisses++;
        },
      },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (s: any) => s },
      Text: "Text",
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../../components/SettingsScreen": Object.fromEntries(
      ["EmptyHint", "NavRow", "ScreenHeader", "SectionGap", "SectionHeader"].map((name) => [
        name,
        name,
      ]),
    ),
    "../../components/Toast": {
      queuePendingToast() {},
      useToast: () => ({ push: (text: string) => toasts.push(text) }),
    },
    "../../lib/event-log": eventLog,
    "../../lib/vault-router": router,
    "../../lib/auth": auth,
    "../../lib/colors": require("../colors"),
    "../../lib/db-tx": { ...dbTx, getActiveVaultId: async () => "v" },
    "../../lib/currency": {
      ...currency,
      getEnabledCurrencies: async (vaultId: string) => {
        const selected = await currency.getEnabledCurrencies(vaultId);
        const callback = afterEnabledRead;
        afterEnabledRead = null;
        callback?.();
        return selected;
      },
    },
    "../../lib/projection": { applyEventMutex: projectionMutex },
    "../../lib/db": { getAppMeta: async () => account, countArchivedPeople: async () => 0 },
    "../../lib/effective-account": {},
    "../../lib/export": {},
    "../../lib/direction": {
      bidiIsolate: (s: string) => s,
      rowDir: () => ({}),
      textDir: () => ({}),
      useIsRTL: () => false,
    },
    "../../lib/fonts": { fonts: {} },
    "../../lib/i18n": { t: (key: string) => key },
    "../../lib/tokens": { icon: { row: 22 } },
    "../../lib/use-vault-role": {
      useVaultRole: () => role,
      useVaultPermission: () => role === "owner",
    },
    "../../constants/env": { SOLO_STORE_MODE: true },
  });
  const screen = compileUI("../../app/vault/settings", mocks).default;
  const sheetProps = () => nodes(hooks.tree).find((node) => node.type === Sheet)!.props;
  const sheetTree = () => Sheet(sheetProps());
  const checkbox = (code: string) =>
    nodes(sheetTree()).find(
      (node) =>
        node.props.accessibilityRole === "checkbox" &&
        node.props.accessibilityLabel.startsWith(code + " "),
    )!;
  const button = (label: string) =>
    nodes(sheetTree()).find((node) => node.type === "Button" && node.props.label === label)!;
  const field = () =>
    nodes(hooks.tree).find(
      (node) => node.type === "NavRow" && node.props.label === "vaultSettings.currencies.label",
    )!;
  return {
    store,
    tx,
    currency,
    router,
    projection,
    eventLog,
    authored,
    hooks,
    screen,
    checkbox,
    button,
    field,
    sheetProps,
    sheetTree,
    keyboardDismisses: () => keyboardDismisses,
    setViewport: (height: number, top: number, fontScale: number) => {
      viewport = { height, top, fontScale };
    },
    queueDuringBaseline: (work: () => void) => {
      delayRawRead = true;
      afterEnabledRead = () => {
        remoteQueued = projectionMutex.runExclusive(async () => work());
      };
    },
    remoteQueued: () => remoteQueued,
    session,
    toasts,
    setRole: (next: string) => {
      role = next;
    },
    changeSession: () => {
      account = "other";
      binding++;
    },
    beforeApply: (work: (() => void | Promise<void>) | null) => {
      beforeApply = work;
    },
    discoveryReads: () => discoveryReads,
    beforeDiscovery: (work: (() => void) | null) => {
      beforeDiscovery = work;
    },
  };
}

async function main() {
  for (const value of [null, "[]", '["AFN","AFN"]', '["usd"]', "[1]", "{}", '"USD"'])
    assert.equal(settings.parseEnabledCurrencies(value), null);
  const compat = fixture();
  assert.deepEqual(
    await compat.currency.getEnabledCurrencies("v"),
    ["AFN", "USD"],
    "before any explicit setting, real USD history stays available",
  );
  await compat.router.changeVaultEnabledCurrencies("v", ["AFN"]);
  const reads = compat.discoveryReads();
  assert.deepEqual(
    await compat.currency.getEnabledCurrencies("v"),
    ["AFN"],
    "explicitly disabled USD history is not forced back into choices",
  );
  assert.equal(compat.discoveryReads(), reads, "an explicit valid list skips historical discovery");
  assert.equal(
    (compat.store.prepare("SELECT amount_afn FROM entries WHERE id='old-usd'").get() as any)
      .amount_afn,
    123.45,
  );
  compat.store.close();
  const racing = fixture();
  racing.beforeDiscovery(() =>
    racing.store
      .prepare(
        "INSERT OR REPLACE INTO vault_settings(vault_id,key,value) VALUES('v','enabled_currencies','[\"AFN\"]')",
      )
      .run(),
  );
  assert.deepEqual(
    await racing.currency.getEnabledCurrencies("v"),
    ["AFN"],
    "a synced explicit choice arriving during discovery wins",
  );
  racing.store.close();
  const f = fixture();
  assert.deepEqual(await f.currency.getEnabledCurrencies("v"), ["AFN", "USD"]);
  f.store.prepare("UPDATE vaults SET default_entry_currency='USD' WHERE id='v'").run();
  assert.deepEqual(
    await f.currency.getEnabledCurrencies("v"),
    ["AFN", "USD"],
    "old book keeps original and default choices",
  );
  await f.router.changeVaultEnabledCurrencies("v", ["USD", "EUR"]);
  assert.deepEqual(await f.currency.getEnabledCurrencies("v"), ["USD", "EUR"]);
  assert.equal(f.authored.at(-1).payload.value, '["USD","EUR"]');
  await assert.rejects(f.router.changeVaultEnabledCurrencies("v", ["EUR"]), /default currency/);
  await assert.rejects(f.router.changeVaultEnabledCurrencies("v", []), /Invalid enabled/);
  await assert.rejects(
    f.eventLog.appendVaultSettingSet({
      targetVaultId: "v",
      key: "enabled_currencies",
      value: "[]",
    }),
    /Invalid enabled/,
  );
  await assert.rejects(
    f.projection.applyVaultSettingSet(f.tx, {
      ...f.authored[0],
      payload: { key: "enabled_currencies", value: "[]" },
    }),
    /Invalid enabled/,
  );
  f.beforeApply(() => {
    f.store.prepare("UPDATE vaults SET default_entry_currency='GBP' WHERE id='v'").run();
  });
  await assert.rejects(
    f.router.changeVaultEnabledCurrencies("v", ["USD", "EUR"]),
    /default currency/,
  );
  f.beforeApply(null);
  assert.deepEqual(
    await f.currency.getEnabledCurrencies("v"),
    ["USD", "EUR", "GBP"],
    "a concurrent default always remains enabled",
  );
  const event = f.authored[0];
  await f.projection.applyVaultSettingSet(f.tx, {
    ...event,
    hlc: { ...event.hlc, pms: 1 },
    payload: { key: "enabled_currencies", value: '["AFN"]' },
  });
  assert.deepEqual(
    await f.currency.getEnabledCurrencies("v"),
    ["USD", "EUR", "GBP"],
    "older synced setting cannot overwrite list",
  );
  assert.deepEqual(f.store.prepare("SELECT * FROM entries").all(), [
    { id: "old-usd", currency: "USD", amount_afn: 123.45 },
  ]);
  const oldSession = f.session();
  f.changeSession();
  await assert.rejects(
    f.router.changeVaultEnabledCurrencies("v", ["GBP"], { session: oldSession }),
  );
  f.store.close();

  const ui = fixture();
  // Counts are read-only UI metadata; no member rows need to be created.
  const originalRead = ui.tx.getFirstAsync;
  ui.tx.getFirstAsync = async (sql: string, ...args: any[]) =>
    sql.includes("COUNT(*)") ? { n: 1 } : originalRead(sql, ...args);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await settleUI();
      ui.hooks.render();
    }
  };
  ui.hooks.render(ui.screen);
  await settle();
  assert.equal(
    nodes(ui.hooks.tree).filter((node) => node.props.accessibilityRole === "checkbox").length,
    0,
    "settings stays a compact select field",
  );
  assert.match(ui.field().props.trailing, /USD/);
  const open = async () => {
    ui.field().props.onPress();
    await settle();
    assert.equal(ui.sheetProps().visible, true);
  };
  await open();
  assert.equal(ui.keyboardDismisses(), 1, "opening the picker dismisses the name keyboard");
  const choicesScroll = nodes(ui.sheetTree()).find((node) => node.type === "ScrollView")!;
  assert.equal(
    nodes(choicesScroll).some((node) => node.type === "Button"),
    false,
    "Save and Cancel remain outside checkbox scrolling",
  );
  assert.equal(ui.checkbox("AFN").props.accessibilityState.checked, true);
  assert.equal(ui.checkbox("AFN").props.disabled, true, "default cannot be unchecked");
  ui.checkbox("USD").props.onPress();
  ui.checkbox("EUR").props.onPress();
  await settle();
  assert.equal(ui.authored.length, 0, "draft checkbox changes never persist");
  assert.deepEqual(await ui.currency.getEnabledCurrencies("v"), ["AFN", "USD"]);
  assert.equal(ui.checkbox("USD").props.accessibilityState.checked, false);
  const retainedSave = ui.button("vaultSettings.name.save").props.onPress;
  ui.button("common.cancel").props.onPress();
  await settle();
  retainedSave();
  await settle();
  assert.equal(ui.sheetProps().visible, false);
  assert.equal(ui.authored.length, 0, "dismissed Save callbacks cannot persist a draft");
  await open();
  assert.equal(ui.checkbox("USD").props.accessibilityState.checked, true);
  assert.equal(
    ui.checkbox("EUR").props.accessibilityState.checked,
    false,
    "Cancel discards draft choices",
  );
  ui.checkbox("USD").props.onPress();
  await settle();
  nodes(ui.sheetTree())
    .find((node) => node.type === "Modal")!
    .props.onRequestClose();
  await settle();
  await open();
  assert.equal(
    ui.checkbox("USD").props.accessibilityState.checked,
    true,
    "Android back discards draft",
  );
  ui.checkbox("EUR").props.onPress();
  await settle();
  nodes(ui.sheetTree())
    .find((node) => node.type === "SheetBackdrop")!
    .props.onDismiss();
  await settle();
  await open();
  assert.equal(
    ui.checkbox("EUR").props.accessibilityState.checked,
    false,
    "backdrop discards draft",
  );
  ui.checkbox("USD").props.onPress();
  ui.checkbox("EUR").props.onPress();
  await settle();
  const save = ui.button("vaultSettings.name.save").props.onPress;
  save();
  save();
  await settle();
  assert.equal(ui.authored.length, 1, "duplicate Save signs one setting");
  assert.deepEqual(await ui.currency.getEnabledCurrencies("v"), ["AFN", "EUR"]);
  assert.equal(ui.sheetProps().visible, false);
  assert.equal(
    (ui.store.prepare("SELECT amount_afn FROM entries").get() as any).amount_afn,
    123.45,
  );
  const defaultPicker = nodes(ui.hooks.tree).find(
    (node) => node.type === "OptionSheet" && node.props.title === "vaultSettings.currency.label",
  )!;
  assert.deepEqual(
    defaultPicker.props.options.map((row: any) => row.key),
    ["AFN", "EUR"],
    "separate default selector is preserved",
  );
  defaultPicker.props.onSelect("EUR");
  await settle();
  await open();
  assert.equal(ui.checkbox("EUR").props.disabled, true, "fresh default stays enabled");
  ui.checkbox("AFN").props.onPress();
  await settle();
  ui.store
    .prepare(
      'UPDATE vault_settings SET value=\'["AFN","EUR","USD"]\' WHERE key=\'enabled_currencies\'',
    )
    .run();
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(ui.authored.length, 2, "remote enabled choices cannot be silently overwritten");
  assert.equal(ui.sheetProps().conflicted, true);
  assert.equal(ui.button("vaultSettings.name.save").props.disabled, true);
  assert.equal(ui.sheetProps().error, "vaultSettings.currencies.changed");
  assert.deepEqual(await ui.currency.getEnabledCurrencies("v"), ["AFN", "EUR", "USD"]);
  ui.button("common.cancel").props.onPress();
  await settle();
  await open();
  assert.equal(
    ui.checkbox("USD").props.accessibilityState.checked,
    true,
    "reopen reads latest live choices",
  );
  ui.beforeApply(() => {
    ui.store
      .prepare("UPDATE vault_settings SET value='USD' WHERE key='default_entry_currency'")
      .run();
    ui.store.prepare("UPDATE vaults SET default_entry_currency='USD' WHERE id='v'").run();
  });
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(
    ui.sheetProps().conflicted,
    true,
    "a default changing at the transaction boundary blocks the stale save",
  );
  assert.equal(ui.authored.length, 2);
  ui.beforeApply(null);
  ui.button("common.cancel").props.onPress();
  await settle();
  await open();
  assert.equal(ui.checkbox("USD").props.disabled, true);
  ui.checkbox("EUR").props.onPress();
  await settle();
  ui.store.prepare("INSERT INTO entries VALUES('unrelated','JPY',4)").run();
  ui.beforeApply(() => {
    throw new Error("synthetic persistence failure");
  });
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(ui.sheetProps().error, "vaultSettings.toast.currencyFailed");
  assert.equal(
    ui.checkbox("EUR").props.accessibilityState.checked,
    false,
    "failed save retains draft for retry",
  );
  assert.equal(ui.authored.length, 2);
  ui.beforeApply(null);
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(
    ui.authored.length,
    3,
    "unrelated ledger changes do not conflict with currency settings",
  );
  assert.deepEqual(await ui.currency.getEnabledCurrencies("v"), ["AFN", "USD"]);
  await open();
  ui.checkbox("EUR").props.onPress();
  await settle();
  const pending = deferred<void>();
  ui.beforeApply(() => pending.promise);
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(ui.button("common.cancel").props.disabled, true);
  nodes(ui.sheetTree())
    .find((node) => node.type === "Modal")!
    .props.onRequestClose();
  assert.equal(
    ui.sheetProps().visible,
    true,
    "in-flight Save cannot pretend to cancel a committed preference",
  );
  pending.resolve();
  await settle();
  ui.beforeApply(null);
  assert.equal(ui.authored.length, 4);
  ui.queueDuringBaseline(() =>
    ui.store
      .prepare("UPDATE vault_settings SET value='[\"AFN\",\"USD\"]' WHERE key='enabled_currencies'")
      .run(),
  );
  await open();
  await ui.remoteQueued();
  assert.ok(
    ui.sheetProps().selected.includes("EUR"),
    "baseline choices precede queued remote apply",
  );
  ui.button("vaultSettings.name.save").props.onPress();
  await settle();
  assert.equal(
    ui.authored.length,
    4,
    "one coherent opening baseline prevents a selected-old/raw-new overwrite",
  );
  assert.equal(ui.sheetProps().conflicted, true);
  ui.setViewport(280, 48, 2.6);
  const shortTree = ui.sheetTree();
  const shortScroll = nodes(shortTree).find((node) => node.type === "ScrollView")!;
  const surface = nodes(shortTree).find((node) => node.type?.name === "SheetSurface")!;
  assert.equal(surface.props.maxHeightRatio, 0.82);
  assert.equal(surface.props.edges, undefined);
  const safe = surface.type(surface.props);
  assert.equal(safe.type, "View", "the native sheet body uses ordinary context-padded layout");
  assert.equal(
    shortTree.props.navigationBarTranslucent,
    undefined,
    "the modal keeps Android's native navigation-bar protection",
  );
  assert.equal(
    flattenStyle(safe.props.style).maxHeight,
    220,
    "short landscape respects the top safe-area gap",
  );
  assert.equal(
    flattenStyle(safe.props.style).paddingBottom,
    12,
    "the iOS context bottom inset is inside the capped surface",
  );
  assert.ok(
    !nodes(shortTree).some(
      (node) => node.type === "AnimatedView" && flattenStyle(node.props.style)?.maxHeight != null,
    ),
  );
  assert.equal(shortScroll.props.style.flexShrink, 1);
  assert.equal(shortScroll.props.style.minHeight, 0);
  assert.ok(
    nodes(shortScroll).some((node) => node.props.children === "vaultSettings.currencies.hint"),
    "large explanatory copy scrolls instead of consuming fixed footer height",
  );
  assert.ok(
    nodes(shortScroll).some((node) => node.props.accessibilityRole === "alert"),
    "long conflict copy remains inside scrolling body",
  );
  assert.equal(
    nodes(shortScroll).some((node) => node.type === "Button"),
    false,
  );
  assert.equal(
    nodes(shortTree).filter((node) => node.type === "Button").length,
    2,
    "both fixed footer actions remain present at short height and large font scale",
  );
  assert.equal(ui.button("common.cancel").props.disabled, false);
  ui.setViewport(800, 24, 1);
  ui.button("common.cancel").props.onPress();
  await settle();
  await open();
  assert.deepEqual(ui.sheetProps().selected, ["AFN", "USD"]);
  const staleRoleSave = ui.button("vaultSettings.name.save").props.onPress;
  ui.setRole("editor");
  ui.hooks.render();
  assert.equal(ui.field().props.disabled, true);
  assert.equal(ui.sheetProps().visible, false);
  staleRoleSave();
  await settle();
  assert.equal(ui.authored.length, 4, "live role loss rejects retained Save callbacks");
  ui.setRole("owner");
  ui.hooks.render();
  await open();
  const retained = ui.button("vaultSettings.name.save").props.onPress;
  ui.hooks.unmount();
  retained();
  assert.equal(ui.authored.length, 4, "dismissed settings cannot write");
  assert.equal(ui.hooks.lateWrites, 0);
  ui.store.close();
  console.log(
    "PASS enabled currencies: compact field, explicit draft Save/Cancel/back/backdrop, default and remote conflict checks, retry/duplicate/stale guards, keyboard dismissal and unchanged historical money",
  );
}
void main();
