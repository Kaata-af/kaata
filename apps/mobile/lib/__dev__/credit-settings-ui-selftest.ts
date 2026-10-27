// Execute the real credit-settings screen against controlled storage/session
// boundaries; translations are the actual English and Dari dictionaries.
import assert from "node:assert/strict";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import { fromMinorUnits, normalizeAmountInput, toMinorUnits } from "../money";
import type { CreditPolicy } from "../credit-policy";
import type { VaultRole } from "../events";

const i18n = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
class SessionChangedError extends Error {}
class ClerkCloudEnrollmentRequiredError extends Error {}
class CreditOnlineSaveRequiredError extends Error {}
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

function fixture(
  options: {
    initial?: CreditPolicy;
    fresh?: CreditPolicy;
    delayRefresh?: boolean;
    role?: VaultRole;
    locale?: "en" | "fa";
  } = {},
) {
  const hooks = uiHooks();
  const saves: { vault: string; value: CreditPolicy; session: any }[] = [];
  const notices: string[] = [];
  const routes: string[] = [];
  let currentPolicy = options.initial ?? policy("warn");
  let role = options.role ?? "owner";
  let activeVault = "vault",
    binding = 1;
  const locale = options.locale ?? "en";
  i18n.setLocale(locale);
  const refreshGate = options.delayRefresh ? deferred<void>() : null;
  const guard = async (snapshot: any, work: () => Promise<any>) => {
    if (snapshot.bindingVersion !== binding) throw new SessionChangedError();
    return work();
  };
  const Screen = compileUI("../../app/person/[id]/credit-limit", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "expo-router": {
      useRouter: () => ({ back: () => routes.push("back") }),
      useLocalSearchParams: () => ({ id: "customer", vaultId: "vault" }),
      useFocusEffect: (callback: any) => hooks.react.useEffect(callback, [callback]),
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator",
      KeyboardAvoidingView: "KeyboardAvoidingView",
      Platform: { OS: "android" },
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      StyleSheet: { create: (style: any) => style, hairlineWidth: 1 },
      Text: "Text",
      TextInput: "TextInput",
      View: "View",
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../../../components/Button": { Button: "Button" },
    "../../../components/SelectionMark": { SelectionMark: "SelectionMark" },
    "../../../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
    "../../../components/Toast": {
      useToast: () => ({ push: (message: string) => notices.push(message) }),
    },
    "../../../lib/colors": { colors: require("../colors").colors },
    "../../../lib/currency": { useCurrency: () => "AFN", getCurrencyLabel: (code: string) => code },
    "../../../lib/credit-policy": { KAATA_DEFAULT_ROUTE_ID: "kaata-default" },
    "../../../lib/credit-limits": {
      KAATA_DEFAULT_CREDIT_ID: "00000000-0000-0000-0000-000000000000",
      readCreditPolicy: async () => ({ ...currentPolicy }),
      refreshCreditPolicies: async () => {
        if (refreshGate) await refreshGate.promise;
        if (options.fresh) currentPolicy = options.fresh;
      },
      relationshipForCredit: async () => "relationship",
      saveCreditPolicy: async (vault: string, value: CreditPolicy, session: any) =>
        guard(session, async () => {
          saves.push({ vault, value, session });
          return { ...value, updated_at_ms: 2 };
        }),
      ClerkCloudEnrollmentRequiredError,
      CreditOnlineSaveRequiredError,
    },
    "../../../lib/db-tx": { getActiveVaultIdSyncMaybe: () => activeVault },
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
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
    },
    "../../../lib/db": {
      getPerson: async () => ({ id: "customer", name: locale === "fa" ? "احمد" : "Ahmad" }),
    },
    "../../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, height: number) => height },
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
    notices,
    routes,
    render,
    radios: () => nodes(hooks.tree).filter((node) => node.props.accessibilityRole === "radio"),
    inputs: () => nodes(hooks.tree).filter((node) => node.type === "TextInput"),
    save: () => nodes(hooks.tree).find((node) => node.type === "Button")!,
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
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
