// Exercise the real invitation screen. All accounts, contacts and amounts are
// synthetic; no server, device, phone book or persisted Kaata is opened.
import assert from "node:assert/strict";
import { compileUI, deferred, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import * as errors from "../tabs/errors";
import type { SharedInvitation, TabGroupResponse, WireTab } from "../tabs/types";

const group = {
  id: "group",
  recording_mode: "notify" as const,
  rev: 1,
  created_at_ms: 1,
  closed_at_ms: null,
  closed_by: null,
  you: "b" as const,
  currencies: ["AFN", "USD"],
  parties: {
    a: { label: "Sender", joined_at_ms: 1, bound: true, vault_id: null, relationship_id: null },
    b: { label: "", joined_at_ms: null, bound: false, vault_id: null, relationship_id: null },
  },
};
const tab: WireTab = {
  id: "afn-tab",
  currency: "AFN",
  recording_mode: "notify",
  rev: 1,
  created_at_ms: 1,
  closed_at_ms: null,
  closed_by: null,
  you: "b",
  parties: group.parties,
  balance: { a: "25", b: "-25" },
  pending_for_you: 0,
};
function fixture(platform: string, rtl: boolean, legacy = false) {
  const hooks = uiHooks();
  const routes: any[] = [],
    joins: any[] = [],
    currencySelections: any[] = [],
    formatted: number[] = [];
  let token = legacy ? "legacy-token" : "g_group-token";
  let invitation: SharedInvitation = legacy
    ? { kind: "tab", tab, entries: [] }
    : { kind: "group", group, tabs: [] };
  let joinGate: ReturnType<typeof deferred<void>> | null = null;
  let joinError: Error | null = null;
  const router = {
    replace: (route: any) => routes.push(route),
    push: (route: any) => routes.push(route),
    back: () => routes.push("back"),
  };
  const fact = {
    id: "vault",
    name: "My Kaata",
    currency: "AFN",
    liveEntries: 0,
    hasAnyTab: false,
    hasOpenTab: false,
    canChangeCurrency: true,
  };
  const candidate = { id: "person", name: "Saved person", phone: null, linked: 0 };
  const data = {
    getLocalSelf: async () => ({ name: "Me" }),
    getAppMeta: async () => null,
    setAppMeta: async () => {},
  };
  const link = {
    tab_id: tab.id,
    relationship_id: "relationship",
    vault_id: "vault",
    currency: "AFN",
    role: "b",
  };
  const edges = {
    ...errors,
    fetchSharedInvitation: async () => invitation,
    listVaultFactsForJoin: async () => [fact],
    switchVaultCurrencyForTab: async () => assert.fail("A group never relabels a Kaata"),
    joinTabGroupAsContact: async (...args: any[]) => {
      joins.push(["group", ...args]);
      if (joinGate) await joinGate.promise;
      if (joinError) throw joinError;
      return { group, links: [link], link };
    },
    joinTabAsContact: async (...args: any[]) => {
      joins.push(["tab", ...args]);
      return link;
    },
  };
  const Screen = compileUI("../../app/t/[token]", {
    react: { ...hooks.react, useDeferredValue: (value: unknown) => value },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": {
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      TextInput: "TextInput",
      ActivityIndicator: "Spinner",
      KeyboardAvoidingView: "KeyboardFrame",
      Platform: { OS: platform },
      StyleSheet: { create: (value: unknown) => value },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": { useRouter: () => router, useLocalSearchParams: () => ({ token }) },
    "../../components/Button": { Button: "Button" },
    "../../components/ConfirmDialog": { ConfirmDialog: "ConfirmDialog" },
    "../../components/ScreenLoading": { ScreenLoading: "ScreenLoading" },
    "../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
    "../../components/Toast": { queuePendingToast: () => {} },
    "../../lib/auth": { getSessionJWT: async () => "synthetic-jwt" },
    "../../lib/colors": { colors: {} },
    "../../lib/contacts-merge": {
      mergeContactSections: () => ({ sections: [], deviceTruncated: false }),
      splitSearchQuery: () => ({ first: "", last: "", phoneDigits: "" }),
    },
    "../../lib/contacts-sync": {
      splitName: (name: string) => ({ firstName: name, lastName: null }),
    },
    "../../lib/currency": {
      getCurrencyLabel: (code: string) => code,
      getCurrencySymbol: () => "؋",
      applyVaultCurrency: async () => {},
      selectLedgerCurrency: async (...args: any[]) => currencySelections.push(args),
    },
    "../../lib/db": data,
    "../../lib/db-tx": {
      getActiveVaultIdSyncMaybe: () => "vault",
      setActiveVaultId: async () => {},
    },
    "../../lib/digits": { toAsciiDigits: (value: string) => value },
    "../../lib/direction": {
      ltrIsolate: (value: string) => value,
      bidiIsolate: (value: string) => value,
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
      useIsRTL: () => rtl,
    },
    "../../lib/fonts": {
      fonts: {},
      monoLineHeight: (_size: number, value: number) => value,
      sansLineHeight: (_size: number, value: number) => value,
    },
    "../../lib/format": {
      formatAmount: (value: number) => {
        formatted.push(value);
        return String(value);
      },
    },
    "../../lib/i18n": {
      t: (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${Object.values(vars).join(",")}` : key,
    },
    "../../lib/money": { fromMinorUnits: (value: number) => value / 100 },
    "../../lib/phone": {
      getCountry: () => ({ code: "AF", dialCode: "+93" }),
      getCurrentDefaultCountryCode: () => "AF",
      inferCountryFromE164: () => "AF",
    },
    "../../lib/tabs/db": {
      getPersonIdForRelationship: async () => "person",
      getTabLink: async () => null,
      listVaultContactsForJoin: async () => [candidate],
      listVaultContactsForGroupJoin: async () => [candidate],
    },
    "../../lib/tabs/direction": { otherRole: (role: string) => (role === "a" ? "b" : "a") },
    "../../lib/tabs/join-plan": {
      planCurrency: (facts: unknown[]) => ({
        matching: facts,
        switchable: [],
        locked: [],
        primary: "join",
      }),
      suggestJoinContact: () => ({
        source: "kaata",
        personId: "person",
        name: candidate.name,
        phone: null,
      }),
    },
    "../../lib/tabs/link": edges,
    "../../lib/tabs/wire": { wireToMinor: (value: string) => Number(value) * 100 },
    "../../lib/tokens": { icon: {}, radius: {}, TOUCH_MIN: 44 },
    "../../lib/use-device-contacts": {
      useDeviceContacts: () => ({
        access: { contacts: [], granted: true },
        busy: false,
        failed: false,
        requestAccess() {},
      }),
    },
    "../../lib/vault-router": { VaultHasOpenTabError: class extends Error {} },
  }).default;
  const render = () => hooks.render(Screen);
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await settleUI();
      render();
    }
  };
  const joinButton = () =>
    nodes(hooks.tree).find(
      (node) => node.type === "Button" && String(node.props.label).startsWith("tab.join.joinAs"),
    )!;
  render();
  return {
    hooks,
    routes,
    joins,
    currencySelections,
    formatted,
    render,
    flush,
    joinButton,
    deferJoin() {
      return (joinGate = deferred<void>());
    },
    failJoin(error: Error) {
      joinError = error;
    },
    changeToken(next: string) {
      token = next;
      invitation = { kind: "group", group: { ...group, id: next }, tabs: [] };
      render();
    },
  };
}
async function main() {
  for (const [code, key] of [
    ["shared_account_pending", "tab.group.pending"],
    ["shared_account_source_unsynced", "tab.group.syncFirst"],
    ["shared_history_pending", "tab.history.pending"],
  ] as const) {
    const failed = fixture("android", true);
    await failed.flush();
    failed.failJoin(new errors.TabApiError(409, code, "Synthetic preparation guard"));
    failed.joinButton().props.onPress();
    await failed.flush();
    assert.ok(
      nodes(failed.hooks.tree).some((node) => node.props.children === key),
      `${code} explains the required recovery step without claiming a successful Join`,
    );
    assert.deepEqual(failed.routes, []);
    assert.equal(
      !!failed.joinButton().props.disabled,
      false,
      "The same invitation remains retryable",
    );
    failed.hooks.unmount();
  }

  for (const platform of ["ios", "android"])
    for (const rtl of [false, true]) {
      const f = fixture(platform, rtl);
      await f.flush();
      assert.ok(f.joinButton(), "One Kaata/contact is one explicit Join action");
      assert.equal(f.joins.length, 0, "Preview never joins automatically");
      assert.ok(
        nodes(f.hooks.tree).some((node) => node.props.testID === "group-invitation-join-to-see"),
      );
      assert.ok(
        nodes(f.hooks.tree).some(
          (node) => node.props.children === "tab.group.currencies:AFN · USD",
        ),
      );
      assert.equal(
        nodes(f.hooks.tree).some((node) =>
          node.props.testID?.startsWith("group-invitation-balance-"),
        ),
        false,
      );
      assert.deepEqual(f.formatted, [], "Prejoin never formats fabricated zero or private amounts");
      const join = f.joinButton().props.onPress;
      join();
      join();
      await f.flush();
      assert.equal(f.joins.length, 1);
      assert.equal(f.joins[0][0], "group");
      assert.deepEqual(f.joins[0][3], { vaultId: "vault", personId: "person" });
      assert.deepEqual(f.routes, [{ pathname: "/person/[id]", params: { id: "person" } }]);
      assert.deepEqual(
        f.currencySelections,
        [],
        "Joining all currencies never relabels the recipient Kaata",
      );
      f.hooks.unmount();
    }
  const legacy = fixture("ios", false, true);
  await legacy.flush();
  assert.ok(legacy.formatted.includes(25), "Legacy invitations retain their own existing preview");
  legacy.joinButton().props.onPress();
  await legacy.flush();
  assert.equal(legacy.joins[0][0], "tab");
  assert.deepEqual(legacy.currencySelections, [["AFN", "vault"]]);
  legacy.hooks.unmount();
  const stale = fixture("android", true);
  await stale.flush();
  const pending = stale.deferJoin();
  stale.joinButton().props.onPress();
  await settleUI();
  stale.changeToken("g_new-invitation");
  await stale.flush();
  stale.changeToken("g_group-token");
  await stale.flush();
  pending.resolve();
  await stale.flush();
  assert.deepEqual(
    stale.routes,
    [],
    "A completed old invitation cannot navigate a replacement route",
  );
  stale.joinButton().props.onPress();
  await stale.flush();
  assert.equal(
    stale.routes.length,
    1,
    "A replaced invitation can still join after the old request finishes",
  );
  stale.hooks.unmount();
  console.log(
    "PASS group invitation UI: private preview, all currency labels, one explicit guarded Join, unchanged Kaata default and legacy flow",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
