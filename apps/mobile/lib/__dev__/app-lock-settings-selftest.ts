// Exercises the real settings component; native authentication is owned by the
// shared app-lock store and never performed against a user's device here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { colors } from "../colors";
import * as tokens from "../design-tokens";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";
import type { AppLockSnapshot } from "../app-lock";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");

function fixture(
  locale: "en" | "fa" | "ps" = "en",
  platform = "android",
  version: number | string = 31,
) {
  language.setLocale(locale);
  let currentLocale = locale;
  const hooks = uiHooks();
  let focused = true;
  let capabilityReads = 0;
  let state: AppLockSnapshot = {
    initialized: true,
    enabled: false,
    locked: false,
    busy: false,
    error: null,
    capability: "available",
    appState: "active",
    foregroundVersion: 0,
  };
  const nativeState = { currentState: "active" };
  const changes: { enabled: boolean; result: ReturnType<typeof deferred<boolean>> }[] = [];
  const settings: { kind: string; action?: string; result: ReturnType<typeof deferred<void>> }[] =
    [];
  const openSettings = () => {
    const result = deferred<void>();
    settings.push({ kind: "app", result });
    return result.promise;
  };
  const component = compileUI("../../components/AppLockSetting", {
    react: hooks.react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-router": { useIsFocused: () => focused },
    "react-native": {
      AppState: nativeState,
      Platform: { OS: platform, Version: version },
      Linking: {
        openSettings,
        sendIntent: (action: string) => {
          const result = deferred<void>();
          settings.push({ kind: "security", action, result });
          return result.promise;
        },
      },
      Pressable: "Pressable",
      Switch: "Switch",
      Text: "Text",
      View: "View",
      StyleSheet: { create: (value: any) => value, hairlineWidth: 0.5 },
    },
    "../lib/app-lock": {
      useAppLock: () => state,
      supportsAppLockDeviceFallback: () =>
        platform === "ios" || (platform === "android" && Number(version) >= 30),
      refreshAppLockCapability: async () => {
        capabilityReads++;
      },
      clearAppLockError: () => {
        state = { ...state, error: null };
      },
      setAppLockEnabled: (enabled: boolean) => {
        const result = deferred<boolean>();
        changes.push({ enabled, result });
        state = { ...state, busy: true };
        return result.promise.then(
          (success) => {
            state = { ...state, ...(success ? { enabled } : {}), busy: false };
            return success;
          },
          (error) => {
            state = { ...state, busy: false };
            throw error;
          },
        );
      },
    },
    "../lib/colors": { colors },
    "../lib/design-tokens": tokens,
    "../lib/fonts": { fonts: { sansRegular: "regular", sansSemi: "semi" } },
    "../lib/direction": {
      rowDir: (rtl: boolean) => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      textDir: (rtl: boolean) => ({ textAlign: rtl ? "right" : "left" }),
      useIsRTL: () => currentLocale !== "en",
    },
    "../lib/i18n": language,
  });
  const render = () => hooks.render(() => component.AppLockSetting());
  const byId = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id);
  const control = () => byId("app-lock-switch")!;
  const text = () =>
    nodes(hooks.tree)
      .filter((node) => node.type === "Text")
      .map((node) => node.props.children);
  const patch = (value: Partial<AppLockSnapshot>) => {
    state = { ...state, ...value };
    if (value.appState) nativeState.currentState = value.appState;
    render();
  };
  render();
  return {
    hooks,
    render,
    byId,
    control,
    text,
    changes,
    settings,
    patch,
    get reads() {
      return capabilityReads;
    },
    setFocused(value: boolean) {
      focused = value;
      render();
    },
    setNativeAppState(value: string) {
      nativeState.currentState = value;
    },
    setLocale(value: "en" | "fa" | "ps") {
      currentLocale = value;
      language.setLocale(value);
      render();
    },
  };
}

async function main() {
  for (const locale of ["en", "fa", "ps"] as const) {
    const current = fixture(locale);
    assert.equal(
      current.changes.length,
      0,
      "Reading settings never enables the lock or authenticates",
    );
    assert.equal(current.reads, 1, "One non-prompting capability check on focus");
    assert.equal(current.control().props.value, false);
    assert.equal(current.control().props.disabled, false);
    assert.equal(current.control().props.accessibilityLabel, language.t("settings.appLock.label"));
    assert.equal(current.control().props.accessibilityState.checked, false);
    assert.ok(current.text().includes(language.t("settings.appLock.hintOff")));
    assert.ok(current.text().includes(language.t("settings.appLock.fallbackHint")));
    assert.ok(current.text().includes(language.t("settings.appLock.androidPrivacyHint")));
    assert.ok(
      current
        .text()
        .every((value) => typeof value === "string" && !value.startsWith("settings.appLock.")),
    );
    const row = nodes(current.hooks.tree).find(
      (node) => Array.isArray(node.props.style) && flattenStyle(node.props.style)?.flexDirection,
    )!;
    assert.equal(
      flattenStyle(row.props.style).flexDirection,
      locale === "en" ? "row" : "row-reverse",
    );

    const first = current.control();
    first.props.onValueChange(true);
    first.props.onValueChange(true);
    current.render();
    assert.equal(
      current.changes.length,
      1,
      "A second native event cannot launch duplicate authentication",
    );
    assert.equal(
      current.control().props.value,
      false,
      "Do not show enabled before authentication and saving finish",
    );
    assert.equal(current.control().props.disabled, true);
    assert.equal(current.control().props.accessibilityState.busy, true);
    current.changes[0].result.resolve(false);
    await settleUI();
    current.render();
    assert.equal(current.control().props.value, false, "Cancel leaves the lock off");
    assert.equal(current.byId("app-lock-setting-error"), undefined, "Cancel is quiet");

    current.control().props.onValueChange(true);
    current.patch({ appState: "inactive" });
    current.patch({ appState: "active" });
    current.changes[1].result.resolve(true);
    await settleUI();
    current.render();
    assert.equal(
      current.control().props.value,
      true,
      "A real authentication sheet's inactive cycle does not lose success",
    );
    assert.ok(current.text().includes(language.t("settings.appLock.hintOn")));
    first.props.onValueChange(false);
    assert.equal(
      current.changes.length,
      2,
      "A callback from the old enabled-state lease stays retired",
    );

    current.patch({ capability: "not_enrolled" });
    assert.equal(
      current.control().props.disabled,
      false,
      "An existing lock can be turned off using phone credentials after enrollment changes",
    );
    current.control().props.onValueChange(false);
    current.render();
    assert.equal(current.control().props.value, true, "Turning off also waits for authentication");
    current.changes[2].result.resolve(false);
    await settleUI();
    current.render();
    assert.equal(
      current.control().props.value,
      true,
      "Cancelled removal preserves the enabled lock",
    );
    current.control().props.onValueChange(false);
    current.changes[3].result.resolve(true);
    await settleUI();
    current.render();
    assert.equal(current.control().props.value, false);
    assert.equal(
      current.control().props.disabled,
      true,
      "Enabling needs biometric enrollment again",
    );
    current.hooks.unmount();
    assert.equal(current.hooks.lateWrites, 0);
  }

  for (const capability of [
    "unknown",
    "no_hardware",
    "not_enrolled",
    "weak",
    "unavailable",
  ] as const) {
    const current = fixture();
    current.patch({ capability });
    assert.equal(current.control().props.disabled, true);
    current.control().props.onValueChange(true);
    assert.equal(current.changes.length, 0, capability);
    assert.ok(current.text().includes(language.t(`settings.appLock.capability.${capability}`)));
  }
  const ios = fixture("en", "ios");
  assert.ok(
    !ios.text().includes(language.t("settings.appLock.androidPrivacyHint")),
    "iOS does not claim Android screenshot blocking",
  );

  for (const locale of ["en", "fa", "ps"] as const) {
    for (const version of [29, "29", "unknown"]) {
      const legacy = fixture(locale, "android", version);
      assert.ok(legacy.text().includes(language.t("settings.appLock.legacyHint")));
      assert.ok(
        !legacy.text().includes(language.t("settings.appLock.fallbackHint")),
        "Old/unknown Android never promises direct phone-PIN fallback",
      );
      assert.equal(
        legacy.control().props.accessibilityHint,
        language.t("settings.appLock.legacyHint"),
      );
      legacy.patch({ enabled: true, error: "lockout" });
      assert.ok(legacy.text().includes(language.t("settings.appLock.legacyHint")));
      assert.ok(!legacy.text().includes(language.t("settings.appLock.fallbackHint")));
      assert.equal(
        legacy.byId("app-lock-setting-error")?.props.children,
        language.t("settings.appLock.error.legacyLockout"),
      );
      legacy.patch({ enabled: false, error: null, capability: "not_enrolled" });
      assert.ok(legacy.text().includes(language.t("appLock.openSecuritySettings")));
      for (const key of [
        "appLock.biometricOnlySubtitle",
        "appLock.legacyRecovery",
        "appLock.openSecuritySettings",
      ] as const)
        assert.ok(language.t(key) && language.t(key) !== key, "Legacy gate copy is localized");
    }
    const modern = fixture(locale, "android", 30);
    assert.ok(
      modern.text().includes(language.t("settings.appLock.fallbackHint")),
      "Android30 begins supported device-credential fallback",
    );
    assert.ok(!modern.text().includes(language.t("settings.appLock.legacyHint")));
    modern.patch({ enabled: true, error: "lockout" });
    assert.equal(
      modern.byId("app-lock-setting-error")?.props.children,
      language.t("settings.appLock.error.lockout"),
    );
  }

  const waiting = fixture();
  waiting.patch({ initialized: false, capability: "unknown" });
  waiting.control().props.onValueChange(true);
  assert.equal(waiting.changes.length, 0);
  assert.equal(waiting.control().props.disabled, true);

  const stale = fixture();
  const old = stale.control();
  stale.setFocused(false);
  old.props.onValueChange(true);
  stale.setFocused(true);
  old.props.onValueChange(true);
  assert.equal(stale.changes.length, 0, "Focus ABA retires queued switch events");
  const beforeBackground = stale.control();
  stale.setNativeAppState("background");
  beforeBackground.props.onValueChange(true);
  stale.patch({ appState: "background" });
  stale.patch({ appState: "active", foregroundVersion: 1 });
  beforeBackground.props.onValueChange(true);
  assert.equal(stale.changes.length, 0, "Background/foreground ABA also retires old events");
  stale.control().props.onValueChange(true);
  stale.hooks.unmount();
  stale.changes[0].result.reject(new Error("Synthetic departed operation"));
  await settleUI();
  assert.equal(stale.hooks.lateWrites, 0, "No settings state update after unmount");

  const rejected = fixture();
  rejected.control().props.onValueChange(true);
  rejected.changes[0].result.reject(new Error("Synthetic store error"));
  await settleUI();
  rejected.render();
  assert.equal(
    rejected.byId("app-lock-setting-error")?.props.children,
    language.t("settings.appLock.error.storage"),
  );
  assert.equal(rejected.control().props.disabled, false);
  rejected.setLocale("fa");
  assert.equal(
    rejected.byId("app-lock-setting-error")?.props.children,
    language.t("settings.appLock.error.storage"),
    "Visible errors repaint when language changes",
  );
  for (const error of [
    "storage",
    "unavailable",
    "not_enrolled",
    "weak",
    "authentication",
    "lockout",
  ] as const) {
    const current = fixture();
    current.patch({ error });
    assert.equal(
      current.byId("app-lock-setting-error")?.props.children,
      language.t(`settings.appLock.error.${error}`),
    );
    assert.equal(current.byId("app-lock-setting-error")?.props.accessibilityRole, "alert");
  }

  const setup = fixture();
  setup.patch({ capability: "not_enrolled" });
  const oldSetup = setup.byId("app-lock-open-settings")!;
  oldSetup.props.onPress();
  oldSetup.props.onPress();
  assert.equal(setup.settings.length, 1);
  assert.equal(setup.settings[0].action, "android.settings.SECURITY_SETTINGS");
  setup.settings[0].result.reject(new Error("Vendor security screen unavailable"));
  await settleUI();
  assert.equal(setup.settings[1].kind, "app", "Use the public app-settings fallback");
  setup.settings[1].result.resolve();
  await settleUI();
  setup.render();
  setup.patch({ capability: "available" });
  oldSetup.props.onPress();
  assert.equal(setup.settings.length, 2, "A stale enrollment action cannot reopen phone settings");
  assert.equal(
    setup.changes.length,
    0,
    "Completing enrollment never automatically enables app lock",
  );
  assert.equal(setup.control().props.value, false);

  const failedSetup = fixture();
  failedSetup.patch({ capability: "weak" });
  failedSetup.byId("app-lock-open-settings")!.props.onPress();
  failedSetup.settings[0].result.reject(new Error("No security screen"));
  await settleUI();
  failedSetup.settings[1].result.reject(new Error("No app settings"));
  await settleUI();
  failedSetup.render();
  assert.equal(
    failedSetup.byId("app-lock-setting-error")?.props.children,
    language.t("settings.appLock.openSettingsFailed"),
  );

  const retry = fixture();
  retry.patch({ capability: "unavailable" });
  retry.byId("app-lock-check-again")!.props.onPress();
  retry.byId("app-lock-check-again")!.props.onPress();
  await settleUI();
  retry.render();
  assert.equal(retry.reads, 2, "Only one explicit availability retry, without authentication");
  assert.equal(retry.changes.length, 0);

  const accountSource = readFileSync(require.resolve("../../app/account"), "utf8");
  const privacy = accountSource.indexOf('<SectionHeader label={t("account.privacy.section")}');
  const appLock = accountSource.indexOf("<AppLockSetting />");
  assert.ok(
    privacy > 0 && appLock > privacy,
    "The optional device lock belongs in Account's Privacy & data section",
  );
  console.log(
    "PASS app lock settings: manual authenticated enable/disable, quiet cancellation, capability/enrollment recovery, current focus/background leases, busy/error/unmount safety, native-switch accessibility and EN/FA/PS copy",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
