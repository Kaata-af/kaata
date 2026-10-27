import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

function fixture({ rtl = false, signedIn = true } = {}) {
  const hooks = uiHooks();
  let account: string | null = signedIn ? "account-a" : null;
  let vault: string | null = "vault-a";
  let keyboardDismissed = 0;
  const actions: string[] = [];
  const props = {
    visible: true,
    signedInUser: signedIn
      ? { id: "account-a", name: "Matee", email: "matee@example.invalid" }
      : null,
    activeAccountId: account,
    activeVaultId: vault as string | null,
    vaults: Array.from({ length: 20 }, (_, i) => ({
      id: i === 0 ? "vault-a" : "vault-" + i,
      name: "Kaata " + i,
      archived: false,
      currency: "AFN",
    })),
    archivedCount: 2,
    shopModeEnabled: false,
    onDismiss: () => actions.push("close"),
    onOpenAccount: () => actions.push("account"),
    onSignOut: () => actions.push("sign-out"),
    onSelectVault: (id: string) => actions.push(id),
    onAddVault: () => actions.push("add"),
    onOpenArchived: () => actions.push("archived"),
    onManageCurrentKaata: () => actions.push("manage"),
    onToggleShopMode: () => actions.push("sync"),
  };
  const { ProfileSettingsSheet } = compileUI(
    "../../components/ProfileSettingsSheet",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-native": {
        Keyboard: { dismiss: () => keyboardDismissed++ },
        Image: "Image",
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        Switch: "Switch",
        StyleSheet: { create: (styles: unknown) => styles },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "expo-router": { useRouter: () => ({ replace: (path: string) => actions.push(path) }) },
      "../lib/db-tx": { getAccountIdSync: () => account, getActiveVaultIdSyncMaybe: () => vault },
      "../lib/colors": require("../colors"),
      "../lib/design-tokens": require("../design-tokens"),
      "../lib/currency": { getCurrencySymbol: (code: string) => code },
      "../lib/direction": {
        useIsRTL: () => rtl,
        rowDir: () => ({ flexDirection: rtl ? "row-reverse" : "row" }),
        textDir: () => ({ textAlign: rtl ? "right" : "left" }),
      },
      "../lib/fonts": { fonts: {} },
      "../constants/env": { SOLO_STORE_MODE: false },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/use-vault-summary": { useMembersCount: () => 2 },
      "./InitialAvatar": { InitialAvatar: "Avatar" },
      "./SettingsScreen": {
        ScreenHeader: "ScreenHeader",
        NavRow: "NavRow",
        SectionGap: "Gap",
        SectionHeader: "SectionHeader",
      },
    },
    { __DEV__: false },
  );
  const render = () => hooks.render(() => ProfileSettingsSheet({ ...props }));
  const row = (label: string) =>
    nodes(hooks.tree).find((node) => node.type === "NavRow" && node.props.label === label)!;
  render();
  return {
    hooks,
    props,
    actions,
    render,
    row,
    get keyboardDismissed() {
      return keyboardDismissed;
    },
    setScope(nextAccount: string | null, nextVault: string | null) {
      account = props.activeAccountId = nextAccount;
      vault = props.activeVaultId = nextVault;
    },
    changeLiveScope() {
      account = "other-account";
      vault = "other-vault";
    },
  };
}

for (const rtl of [false, true]) {
  const form = fixture({ rtl });
  const tree = form.hooks.tree;
  assert.equal(tree.type, "SafeAreaView", "profile is native-route content, with no custom Modal");
  assert.equal(flattenStyle(tree.props.style).flex, 1);
  const header = nodes(tree).find((node) => node.type === "ScreenHeader")!;
  assert.equal(header.props.title, "menu.title.profile");
  assert.equal(header.props.backLabel, "common.close");
  assert.equal(header.props.isRTL, rtl);
  const scroll = nodes(tree).find((node) => node.type === "ScrollView")!;
  assert.equal(flattenStyle(scroll.props.style).flex, 1);
  assert.equal(flattenStyle(scroll.props.style).minHeight, 0);
  assert.equal(scroll.props.keyboardShouldPersistTaps, "handled");
  assert.ok(
    !nodes(scroll).includes(header),
    "the standard header stays above long scrolling content",
  );
  assert.ok(nodes(scroll).filter((node) => node.type === "NavRow").length >= 20);
  assert.equal(form.keyboardDismissed, 1);
  header.props.onBack();
  header.props.onBack();
  tree.props.onAccessibilityEscape();
  assert.deepEqual(form.actions, ["close"], "native close actions coalesce without a timer");
  form.hooks.unmount();
}

for (const [label, expected] of [
  ["menu.account.settings", "account"],
  ["menu.account.signOut", "sign-out"],
  ["menu.thisKaata.settings", "manage"],
  ["menu.allKaatas.add", "add"],
] as const) {
  const form = fixture();
  const action = form.row(label);
  assert.ok(action, label);
  action.props.onPress();
  action.props.onPress();
  assert.deepEqual(form.actions, [expected], "a profile action runs immediately and once");
  form.hooks.unmount();
}
{
  const form = fixture({ signedIn: false });
  form.row("menu.account.signIn.choose").props.onPress();
  assert.deepEqual(form.actions, ["/sign-in"], "sign-in uses native replacement navigation");
  form.hooks.unmount();
}
for (const invalidation of ["account", "vault", "live", "unmount"] as const) {
  const form = fixture();
  const retained = form.row("menu.account.settings").props.onPress;
  if (invalidation === "account") form.setScope("account-b", "vault-a");
  if (invalidation === "vault") form.setScope("account-a", "vault-b");
  if (invalidation === "live") form.changeLiveScope();
  if (invalidation === "unmount") form.hooks.unmount();
  else form.render();
  retained();
  assert.deepEqual(form.actions, [], "retained callbacks cannot act after " + invalidation);
  if (invalidation !== "unmount") form.hooks.unmount();
  assert.equal(form.hooks.lateWrites, 0);
}

const contextModule = compileUI("../profile-settings-context", {
  react: { createContext: () => ({}) },
  "react/jsx-runtime": { jsx, jsxs: jsx },
});
const createStore = contextModule.createProfileSettingsStore;
{
  const store = createStore();
  const first = {},
    second = {};
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  const form = fixture();
  store.publish(first, true, form.props);
  const snapshot = store.getSnapshot();
  assert.equal(store.getSnapshot(), snapshot, "snapshot identity stays stable between publishes");
  store.publish(second, true, { ...form.props, activePeers: 3 });
  store.clear(first);
  assert.equal(store.getSnapshot().owner, second, "departed Home cannot clear a newer source");
  assert.equal(store.getSnapshot().props.activePeers, 3, "route receives live data and callbacks");
  store.clear(second);
  assert.equal(store.getSnapshot(), null);
  assert.equal(updates, 3);
  unsubscribe();
  store.publish(first, true, form.props);
  assert.equal(updates, 3);
  form.hooks.unmount();
}
{
  const store = createStore();
  const hooks = uiHooks();
  const form = fixture();
  const publisher = compileUI("../profile-settings-context", {
    react: {
      ...hooks.react,
      createContext: () => ({}),
      useContext: () => store,
      useLayoutEffect: hooks.react.useEffect,
    },
    "react/jsx-runtime": { jsx, jsxs: jsx },
  });
  hooks.render(() => publisher.ProfileSettingsSource({ ...form.props, ready: true }));
  const owner = store.getSnapshot().owner;
  assert.equal(store.getSnapshot().props.activeAccountId, "account-a");
  hooks.render(() =>
    publisher.ProfileSettingsSource({ ...form.props, activePeers: 4, ready: true }),
  );
  assert.equal(store.getSnapshot().owner, owner);
  assert.equal(store.getSnapshot().props.activePeers, 4);
  hooks.unmount();
  assert.equal(
    store.getSnapshot(),
    null,
    "unmount clears the bridge instead of retaining stale actions",
  );
  form.hooks.unmount();
}

function routeFixture(cold = false) {
  const hooks = uiHooks();
  const store = createStore();
  const owner = {};
  const actions: string[] = [];
  const routes: any[] = [];
  let account = "account-a",
    vault = "vault-a";
  const props = {
    activeAccountId: account,
    activeVaultId: vault,
    visible: true,
    onDismiss: () => actions.push("close"),
    onSignOut: () => actions.push("sign-out"),
    onSelectVault: (id: string) => actions.push(id),
    onToggleShopMode: () => actions.push("sync"),
  };
  if (!cold) store.publish(owner, true, props);
  const router = {
    canGoBack: () => true,
    back: () => routes.push("back"),
    replace: (path: any) => routes.push(path),
  };
  const { default: ProfileScreen } = compileUI("../../app/profile", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": {
      useRouter: () => router,
      useFocusEffect: (run: () => void) => hooks.react.useEffect(run, [run]),
    },
    "../components/ProfileSettingsSheet": { ProfileSettingsSheet: "ProfileSettingsSheet" },
    "../lib/db-tx": { getAccountIdSync: () => account, getActiveVaultIdSyncMaybe: () => vault },
    "../lib/profile-settings-context": {
      useProfileSettingsStore: () => store,
      useProfileSettingsSource: () => store.getSnapshot(),
    },
  });
  const render = () => hooks.render(() => ProfileScreen());
  render();
  return {
    hooks,
    store,
    owner,
    props,
    actions,
    routes,
    render,
    changeScope() {
      account = "account-b";
      vault = "vault-b";
      store.publish(owner, true, { ...props, activeAccountId: account, activeVaultId: vault });
    },
  };
}
for (const [handler, destination] of [
  ["onOpenAccount", "/account"],
  ["onManageCurrentKaata", "/vault/settings"],
  ["onOpenArchived", "/vault/archived"],
  ["onAddVault", "/vault/new"],
] as const) {
  const form = routeFixture();
  form.hooks.tree.props[handler]();
  form.hooks.tree.props[handler]();
  assert.deepEqual(form.routes, [destination], "native route replaces itself exactly once");
  assert.deepEqual(form.actions, ["close"]);
  form.hooks.unmount();
  assert.deepEqual(form.actions, ["close"], "focus cleanup does not dismiss twice");
}
for (const kind of ["sign-out", "vault"] as const) {
  const form = routeFixture();
  if (kind === "sign-out") form.hooks.tree.props.onSignOut();
  else form.hooks.tree.props.onSelectVault("vault-2");
  assert.deepEqual(form.routes, ["back"]);
  assert.deepEqual(form.actions, ["close", kind === "sign-out" ? kind : "vault-2"]);
  form.hooks.unmount();
}
for (const invalidation of ["scope", "source", "unmount"] as const) {
  const form = routeFixture();
  const retained = form.hooks.tree.props.onSignOut;
  if (invalidation === "scope") form.changeScope();
  if (invalidation === "source") form.store.clear(form.owner);
  if (invalidation === "unmount") form.hooks.unmount();
  else form.render();
  retained();
  assert.ok(!form.actions.includes("sign-out"), "departed native profile cannot run old actions");
  if (invalidation !== "unmount") {
    assert.deepEqual(form.routes, ["back"]);
    form.hooks.unmount();
  }
  assert.equal(form.hooks.lateWrites, 0);
}
{
  const form = routeFixture(true);
  form.render();
  assert.deepEqual(
    form.routes,
    [{ pathname: "/", params: { menu: "profile" } }],
    "cold route bootstraps once through Home's real data",
  );
  assert.equal(form.hooks.tree, null);
  form.hooks.unmount();
}
console.log(
  "PASS native profile: route presentation content, live scoped bridge, bounded bootstrap, immediate single-use navigation and stale-action protection",
);
