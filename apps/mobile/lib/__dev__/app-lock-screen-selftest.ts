// Executes the lock UI and shared action at their native layout boundaries.
// Native font rasterization is a device check; these guards prevent cropping
// constraints and keep the privacy/authentication contract intact.
import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";
import { colors } from "../colors";

const language = compileUI("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
  "./db": { getAppMeta: async () => null },
}) as typeof import("../i18n");
const words = (node: any): string =>
  Array.isArray(node)
    ? node.map(words).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node?.props
        ? words(node.props.children)
        : "";

function fixture(os: "ios" | "android", locale: "en" | "fa" | "ps") {
  language.setLocale(locale);
  const platform = { OS: os, Version: os === "ios" ? 17 : 31 };
  const fontModule = compileUI("../fonts", {
    "react-native": { Platform: platform },
    "@expo-google-fonts/inter": {},
    "@expo-google-fonts/jetbrains-mono": {},
    "@expo-google-fonts/vazirmatn": {},
  });
  const tokens = compileUI("../tokens", { "./fonts": fontModule });
  const native = {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ActivityIndicator: "Spinner",
    ScrollView: "ScrollView",
    Platform: platform,
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Linking: { sendIntent: async () => {}, openSettings: async () => {} },
    Keyboard: { dismiss() {} },
    useWindowDimensions: () => ({ width: 280, height: 480, fontScale: 2, scale: 2 }),
    StyleSheet: {
      create: (value: any) => value,
      absoluteFill: { position: "absolute" },
      absoluteFillObject: { position: "absolute" },
    },
  };
  const { Button } = compileUI("../../components/Button", {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": native,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "../lib/colors": { colors },
    "../lib/tokens": tokens,
  });
  const hooks = uiHooks();
  let state = {
    initialized: true,
    enabled: true,
    locked: true,
    busy: false,
    error: null as string | null,
    capability: "available",
    appState: "active" as string | null,
    foregroundVersion: 0,
  };
  let fallback = true;
  const rtl = locale !== "en";
  const { AppLockGate } = compileUI("../../components/AppLockGate", {
    "react/jsx-runtime": {
      jsx: (type: any, props: any) =>
        typeof type === "function" && type.name === "LockScreen" ? type(props) : jsx(type, props),
      jsxs: (type: any, props: any) =>
        typeof type === "function" && type.name === "LockScreen" ? type(props) : jsx(type, props),
    },
    react: hooks.react,
    "@expo/vector-icons": { Ionicons: "Icon" },
    "react-native": native,
    "react-native-screens": { FullWindowOverlay: "FullWindowOverlay" },
    "react-native-safe-area-context": {
      SafeAreaProvider: "SafeAreaProvider",
      initialWindowMetrics: { insets: { top: 62, bottom: 34 } },
      useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
    },
    "../lib/app-lock": {
      useAppLock: () => state,
      getAppLockSnapshot: () => state,
      initializeAppLock: async () => {},
      unlockApp: async () => false,
      supportsAppLockDeviceFallback: () => fallback,
    },
    "../lib/app-lock-privacy": {
      useAppLockPrivacy: () =>
        !state.initialized || state.locked || (state.enabled && state.appState !== "active"),
    },
    "../lib/app-lock-screen-privacy": { useAppLockScreenPrivacy() {} },
    "../lib/colors": { colors },
    "../lib/direction": {
      useIsRTL: () => rtl,
      textDir: () => ({ textAlign: rtl ? "right" : "left", writingDirection: rtl ? "rtl" : "ltr" }),
      rowDir: () => ({ flexDirection: rtl ? "row-reverse" : "row" }),
      trackingSafe: () => ({}),
    },
    "../lib/fonts": fontModule,
    "../lib/tokens": tokens,
    "../lib/i18n": language,
    "./Button": { Button: "Button" },
    "./BalanceCardGlass": { BalanceCardGlass: "BalanceCardGlass" },
  });
  const render = (patch: Partial<typeof state> = {}) => {
    state = { ...state, ...patch };
    hooks.render(() =>
      AppLockGate({ children: jsx("PrivateLedger", { children: "PRIVATE-AMOUNT-CUSTOMER-NAME" }) }),
    );
  };
  const byId = (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id)!;
  const buttons = () => nodes(hooks.tree).filter((node) => node.type === "Button");
  return {
    render,
    byId,
    buttons,
    hooks,
    tokens,
    fontModule,
    native,
    Button,
    state: () => state,
    setFallback: (value: boolean) => {
      fallback = value;
    },
  };
}

for (const os of ["ios", "android"] as const)
  for (const locale of ["en", "fa", "ps"] as const) {
    const f = fixture(os, locale);
    f.render();
    const screen = f.byId("app-lock-screen");
    const card = f.byId("app-lock-card");
    const title = f.byId("app-lock-title");
    assert.ok(card, "The lock card is present above private content");
    assert.ok(nodes(card).some((node) => node.type === "BalanceCardGlass"));
    assert.equal(words(title), language.t("appLock.title"));
    assert.equal(title.props.accessibilityRole, "header");
    const titleStyle = flattenStyle(title.props.style);
    assert.ok(
      titleStyle.width === "100%" || titleStyle.alignSelf === "stretch",
      "Title gets the available width rather than a glyph-tight intrinsic box",
    );
    assert.equal(titleStyle.textAlign, "center", "Direction must not override centered layout");
    assert.equal(titleStyle.writingDirection, locale === "en" ? "ltr" : "rtl");
    for (const id of ["app-lock-title", "app-lock-subtitle", "app-lock-reassurance"]) {
      const text = f.byId(id);
      assert.ok(text, id);
      const style = flattenStyle(text.props.style);
      assert.equal(
        text.props.numberOfLines,
        undefined,
        `${id} must wrap at small widths and large text`,
      );
      assert.notEqual(text.props.allowFontScaling, false);
      assert.equal(style.height, undefined);
      assert.equal(style.maxHeight, undefined);
      if (os === "ios" && style.lineHeight !== undefined)
        assert.ok(
          style.lineHeight >= Math.ceil(style.fontSize * f.fontModule.SANS_NATURAL_EM),
          `${id} clears Vazirmatn's natural iOS line box`,
        );
    }
    assert.equal(flattenStyle(screen.props.contentContainerStyle).flexGrow, 1);
    assert.equal(
      flattenStyle(screen.props.contentContainerStyle).height,
      undefined,
      "Small screens may scroll the complete card/actions",
    );
    assert.equal(
      flattenStyle(f.byId("app-lock-cover").props.style).backgroundColor,
      colors.bgDefault,
      "Glass never exposes the ledger through the privacy cover",
    );
    assert.ok(!words(screen).includes("PRIVATE-AMOUNT-CUSTOMER-NAME"));
    assert.equal(words(f.byId("app-lock-reassurance")), language.t("appLock.reassurance"));
    assert.equal(words(f.byId("app-lock-status")), language.t("appLock.protected"));
    assert.equal(f.buttons()[0].props.wrapLabel, true);

    f.render({ busy: true });
    assert.equal(f.buttons()[0].props.loading, true);
    assert.equal(f.buttons()[0].props.showLabelWhileLoading, true);
    assert.equal(f.buttons()[0].props.label, language.t("appLock.unlocking"));
    f.render({ busy: false, error: "authentication" });
    assert.ok(
      words(f.byId("app-lock-screen")).includes(
        language.t("settings.appLock.error.authentication"),
      ),
    );
    f.render({ appState: "inactive" });
    assert.equal(f.buttons()[0].props.disabled, true);

    f.render({ initialized: false, enabled: false, locked: true, error: null, appState: "active" });
    assert.equal(words(f.byId("app-lock-title")), language.t("appLock.privacyTitle"));
    assert.ok(
      !words(f.byId("app-lock-screen")).includes(language.t("appLock.reassurance")),
      "Initialization cannot claim an enabled biometric lock",
    );
    assert.equal(f.buttons().length, 0);
    f.render({ error: "storage" });
    assert.equal(f.buttons()[0].props.label, language.t("appLock.retry"));
    assert.equal(f.buttons()[0].props.wrapLabel, true);
    if (os === "android") {
      f.setFallback(false);
      f.render({ initialized: true, enabled: true, locked: true, error: "lockout" });
      assert.equal(words(f.byId("app-lock-subtitle")), language.t("appLock.biometricOnlySubtitle"));
      assert.ok(
        words(f.byId("app-lock-screen")).includes(
          language.t("settings.appLock.error.legacyLockout"),
        ),
      );
      const recovery = f
        .buttons()
        .find((button) => button.props.label === language.t("appLock.openSecuritySettings"))!;
      assert.ok(recovery);
      assert.equal(recovery.props.wrapLabel, true);
    }

    // The shared Button remains compact by default; only lock controls opt in.
    let pressed = 0;
    const label = language.t("appLock.openSecuritySettings");
    let action = f.Button({
      label,
      onPress: () => pressed++,
      icon: "finger-print-outline",
      wrapLabel: true,
      showLabelWhileLoading: true,
      loading: true,
    });
    assert.equal(action.props.disabled, true);
    assert.deepEqual(action.props.accessibilityState, { disabled: true, busy: true });
    assert.equal(action.props.accessibilityLabel, label);
    assert.ok(nodes(action).some((node) => node.type === "Spinner"));
    const caption = nodes(action).find((node) => node.type === "Text")!;
    assert.equal(words(caption), label, "Busy lock actions retain their explanatory label");
    assert.equal(
      caption.props.numberOfLines,
      undefined,
      "Opt-in action label wraps instead of clipping",
    );
    assert.notEqual(caption.props.allowFontScaling, false);
    action = f.Button({ label, onPress: () => pressed++, loading: true });
    assert.ok(nodes(action).some((node) => node.type === "Spinner"));
    assert.equal(
      nodes(action).filter((node) => node.type === "Text").length,
      0,
      "Existing buttons retain spinner-only loading by default",
    );
    action = f.Button({ label, onPress: () => pressed++ });
    assert.equal(nodes(action).find((node) => node.type === "Text")!.props.numberOfLines, 1);
    assert.equal(action.props.disabled, undefined);
    action.props.onPress();
    assert.equal(pressed, 1);
    f.hooks.unmount();
  }
console.log(
  "PASS lock screen design: complete wrapping text and action labels, font metrics, safe scroll/opaque glass, busy/error/recovery and EN/FA/PS on Android/iOS; existing Button defaults preserved",
);
