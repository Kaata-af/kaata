import { onboardingJSX, onboardingMock } from "./onboarding-fixture";
// Run the real auth screen with synthetic provider/recovery adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { compileUI, flattenStyle } from "./ui-fixture";

let slots: any[] = [],
  cursor = 0,
  self: any = { name: "Matee" };
let recovery = { recovered: [] as string[], failed: [] as any[] };
let routes: any[] = [],
  authCalls = 0,
  restoredVault = "",
  googleAvailable = true,
  appleAvailable = true,
  focused = true,
  rtl = false;
let toasts: unknown[][] = [];
const meta = new Map<string, string>();
const jsx = onboardingJSX;
const mocks: Record<string, any> = {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    useState: (v: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof v === "function" ? v() : v;
      return [
        slots[i],
        (n: any) => {
          slots[i] = n;
        },
      ];
    },
    useRef: (v: any) => {
      const i = cursor++;
      return (slots[i] ??= { current: v });
    },
    useEffect: () => {},
    useCallback: (fn: any) => fn,
  },
  "react-native": {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ActivityIndicator: "Spinner",
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
    Keyboard: { dismiss: () => {} },
    KeyboardAvoidingView: "KeyboardAvoidingView",
    ScrollView: "ScrollView",
    Platform: { OS: "android", select: (x: any) => x.android },
    StyleSheet: { create: (x: any) => x },
  },
  "../../components/Onboarding": onboardingMock,
  "react-native-safe-area-context": { SafeAreaView: "Safe" },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-constants": { default: { executionEnvironment: "standalone" } },
  "expo-router": {
    Stack: { Screen: "StackScreen" },
    useIsFocused: () => focused,
    useFocusEffect: () => {},
    useRouter: () => ({
      replace: (r: any) => routes.push(r),
      push: (r: any) => routes.push(r),
      dismissTo: (r: any) => routes.push({ dismissTo: r }),
      canGoBack: () => false,
    }),
  },
  "../../components/EmailAuthFlow": { EmailAuthFlow: "EmailAuthFlow" },
  "../../components/RestoreProgress": {
    RestoreProgress: "RestoreProgress",
    restoreProgressLabel: () => "progress",
  },
  "../../components/Toast": {
    useToast: () => ({ push: (...args: unknown[]) => toasts.push(args) }),
  },
  "../../lib/use-onboarding-keyboard-scroll": {
    useOnboardingKeyboardScroll: () => ({
      scrollProps: {},
      focusInput: () => {},
      blurInput: () => {},
    }),
  },
  "../../components/GoogleGIcon": { GoogleGIcon: "Google" },
  "../../components/NinjaIcon": { NinjaIcon: "Ninja" },
  "../../components/ConfirmDialog": { ConfirmDialog: "Dialog" },
  "../../lib/recovery": { recoverAllVaults: async () => recovery },
  "../../lib/sync/reconcile": { reconcileVaultRegistrations: async () => {} },
  "../../lib/auth": {
    isGoogleSignInAvailable: () => googleAvailable,
    isAppleSignInAvailable: () => appleAvailable,
    refreshAppleSignInAvailability: async () => appleAvailable,
    isCancellation: () => false,
    SignInFailedError: class extends Error {},
    InstallRetiredError: class extends Error {},
    readEmailFlowPending: async () => null,
    signInWithGoogle: async (guard: any) => {
      assert.equal(typeof guard, "function");
      authCalls++;
      return { name: "Matee", email: "test@example.com" };
    },
    signInWithApple: async (guard: any) => {
      assert.equal(typeof guard, "function");
      authCalls++;
      return { name: "Matee" };
    },
  },
  "../../lib/crash-report": { queueCrashReport: async () => {} },
  "../../lib/colors": { colors: {} },
  "../../lib/db": {
    getAppMeta: async (k: string) => meta.get(k),
    setAppMeta: async (k: string, v: string) => {
      meta.set(k, v);
    },
    getLocalSelf: async () => self,
  },
  "../../lib/db-tx": {
    getActiveVaultIdSyncMaybe: () => (self ? "current-vault" : null),
    setActiveVaultId: async (id: string) => {
      restoredVault = id;
    },
  },
  "../../lib/currency": { applyVaultCurrency: async () => {} },
  "../../lib/direction": {
    ltrIsolate: (value: string) => value,
    rowDir: (isRTL: boolean) => ({ flexDirection: isRTL ? "row-reverse" : "row" }),
    textDir: (isRTL: boolean) => ({
      textAlign: isRTL ? "right" : "left",
      writingDirection: isRTL ? "rtl" : "ltr",
    }),
    trackingSafe: () => ({}),
    useIsRTL: () => rtl,
  },
  "../../lib/fonts": { fonts: {}, sansLineHeight: (_: number, h: number) => h },
  "../../lib/i18n": { t: (k: string) => k },
  "../../lib/tokens": { icon: {}, radius: {}, typography: {} },
};
const out: any = {};
new Function(
  "require",
  "exports",
  ts.transpileModule(readFileSync(require.resolve("../../app/onboarding/auth"), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
)((k: string) => {
  assert.ok(k in mocks, k);
  if (k === "react") return { ...mocks.react, useEffect: (run: () => void) => run() };
  return mocks[k];
}, out);
function nodes(n: any): any[] {
  return Array.isArray(n) ? n.flatMap(nodes) : n?.props ? [n, ...nodes(n.props.children)] : [];
}
function render(redirected = true, emailRoute = false) {
  cursor = 0;
  return out.AuthScreen({ redirected, emailRoute });
}
async function renderEmail(redirected: boolean) {
  render(redirected, true);
  await Promise.resolve();
  return render(redirected, true);
}
function reset() {
  slots = [];
  routes = [];
  meta.clear();
  authCalls = 0;
  self = { name: "Matee" };
  recovery = { recovered: [], failed: [] };
  restoredVault = "";
  googleAvailable = true;
  appleAvailable = true;
  focused = true;
  toasts = [];
  rtl = false;
}
function settingsSignIn() {
  // Exercise the real settings sheet: dismiss its native Modal first, then
  // push the provider page once the existing exit delay has elapsed.
  const sheetMocks: Record<string, any> = {
    ...mocks,
    "./SheetBackdrop": { SheetBackdrop: "SheetBackdrop" },
    "./SheetHandle": { SheetHandle: "SheetHandle" },
    "../lib/use-overlay-animation": {
      useOverlayAnimation: (visible: boolean) => ({ rendered: visible, opacity: 1, position: 0 }),
    },
    "../lib/use-sheet-drag": {
      useSheetDrag: (_visible: boolean, entrance: unknown, onDismiss: () => void) => ({
        translateY: entrance,
        panHandlers: {},
        dismiss: onDismiss,
      }),
    },
    react: { ...mocks.react, useMemo: (fn: any) => fn() },
    "react-native": {
      ...mocks["react-native"],
      Modal: "Modal",
      Image: "Image",
      Switch: "Switch",
      Dimensions: { get: () => ({ height: 800 }) },
      Animated: { View: "AnimatedView", Value: class {} },
    },
    "react-native-safe-area-context": {
      SafeAreaView: "Safe",
      useSafeAreaInsets: () => ({ bottom: 0 }),
    },
    "expo-blur": { BlurView: "Blur" },
    "../lib/colors": mocks["../../lib/colors"],
    "../lib/blur": { SHEET_BLUR_METHOD: "none" },
    "../lib/db-tx": { getAccountIdSync: () => null },
    "../lib/design-tokens": {},
    "../lib/currency": { getCurrencySymbol: (code: string) => code },
    "../lib/direction": mocks["../../lib/direction"],
    "../lib/fonts": mocks["../../lib/fonts"],
    "../constants/env": { SOLO_STORE_MODE: true },
    "../lib/i18n": mocks["../../lib/i18n"],
    "../lib/tokens": { radius: {} },
    "../lib/use-vault-summary": { useMembersCount: () => 1 },
    "./InitialAvatar": { InitialAvatar: "Avatar" },
    "./SettingsScreen": {
      NavRow: "NavRow",
      SectionHeader: "SectionHeader",
      SectionGap: "SectionGap",
    },
  };
  let dismissed = 0;
  let timers = 0;
  let queued: { callback: () => void; delay: number } | null = null;
  const sheet: any = {};
  new Function(
    "require",
    "exports",
    "setTimeout",
    ts.transpileModule(
      readFileSync(require.resolve("../../components/ProfileSettingsSheet"), "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
  )(
    (k: string) => {
      assert.ok(k in sheetMocks, k);
      return sheetMocks[k];
    },
    sheet,
    (callback: () => void, delay: number) => {
      timers++;
      queued = { callback, delay };
    },
  );
  for (const platform of ["android", "ios"]) {
    mocks["react-native"].Platform.OS = platform;
    for (const isRTL of [false, true]) {
      reset();
      rtl = isRTL;
      // The sheet is already mounted and visible; native animation isn't the
      // behavior under test; the tested shared animation hook is stubbed here.
      slots = [];
      cursor = 0;
      queued = null;
      dismissed = 0;
      timers = 0;
      const tree = sheet.ProfileSettingsSheet({
        visible: true,
        signedInUser: null,
        activeAccountId: null,
        activeVaultId: null,
        vaults: [],
        shopModeEnabled: false,
        onDismiss: () => dismissed++,
      });
      const signInRows = nodes(tree).filter((n) =>
        n.props.label?.startsWith("menu.account.signIn"),
      );
      assert.deepEqual(
        signInRows.map((n) => n.props.label),
        ["menu.account.signIn.choose"],
      );
      assert.equal(signInRows[0].props.icon, "log-in-outline");
      signInRows[0].props.onPress();
      signInRows[0].props.onPress();
      assert.equal(dismissed, 1);
      assert.equal(timers, 1, "a second tap during sheet exit never pushes a second page");
      assert.deepEqual(routes, [], "no page opens while the native Modal is closing");
      const scheduled = queued as { callback: () => void; delay: number } | null;
      assert.equal(scheduled?.delay, 220);
      scheduled?.callback();
      assert.deepEqual(routes, ["/sign-in"], "open all providers, not the email-only mode");
      assert.equal(authCalls, 0, "choosing Sign in does not start a provider handshake");
    }
  }
  mocks["react-native"].Platform.OS = "android";
  console.log(
    "PASS: one settings Sign in row in EN/FA on Android/iOS; dismiss before provider page",
  );
}
async function signIn() {
  const tree = render();
  await nodes(tree)
    .find((n) => n.props.accessibilityLabel === "onboardingMode.google.title")
    .props.onPress();
}
async function ninjaMode() {
  // Render the real translated catalog so the warning and CTA cannot silently
  // fall back to an English key on the two RTL onboarding paths.
  const catalog = compileUI("../i18n", {
    "expo-localization": { getLocales: () => [{ languageCode: "en" }] },
    "./db": { getAppMeta: async () => null },
  });
  const originalTranslate = mocks["../../lib/i18n"].t;
  try {
    for (const [locale, title, lossWarning] of [
      ["en", "Continue in ninja mode", /lose this phone.*lose all your data/],
      ["fa", "ادامه در حالت نینجا", /این تلفون.*همهٔ اطلاعات/],
      ["ps", "د نینجا په حالت کې دوام ورکړئ", /ټیلیفون.*ټول معلومات/],
    ] as const) {
      reset();
      rtl = locale !== "en";
      mocks["../../lib/i18n"].t = (key: string) => catalog.tIn(locale, key);
      const tree = render(false);
      const visible = nodes(tree);
      const action = visible.find((node) => node.props.accessibilityLabel === title)!;
      assert.ok(action, `${locale}: ninja CTA is translated`);
      assert.ok(nodes(action).some((node) => node.type === "Ninja" && node.props.size === 30));
      assert.ok(!nodes(action).some((node) => node.props.name === "phone-portrait-outline"));
      assert.equal(action.props.accessibilityRole, "button");
      assert.equal(action.props.disabled, false);
      const warningText = catalog.tIn(locale, "onboardingMode.offline.warning");
      const warning = visible.find((node) => node.props.children === warningText)!;
      assert.ok(warning, `${locale}: phone loss warning is visible before continuing`);
      assert.match(warningText, lossWarning);
      assert.ok(visible.indexOf(warning) > visible.indexOf(action), "warning is below the CTA");
      assert.equal(warning.props.numberOfLines, undefined, "the full warning can wrap");
      assert.equal(flattenStyle(warning.props.style).fontSize, 13);
      assert.equal(flattenStyle(warning.props.style).writingDirection, rtl ? "rtl" : "ltr");
      assert.ok(visible.some((node) => node.props.name === "warning-outline"));
      for (const key of [
        "onboardingMode.offline.label",
        "onboardingMode.offline.body",
        "onboardingMode.offline.title",
        "onboardingMode.expoGoHint",
      ]) {
        assert.notEqual(catalog.tIn(locale, key), key, `${locale}: ${key} is present`);
        assert.doesNotMatch(
          catalog.tIn(locale, key),
          /continue offline|continue without internet|بدون اینترنت|پرته له انټرنېټه/i,
        );
      }
      const redirected = nodes(render(true));
      assert.ok(!redirected.some((node) => node.type === "Ninja"));
      assert.ok(!redirected.some((node) => node.props.children === warningText));
      assert.ok(!redirected.some((node) => node.props.accessibilityLabel === title));

      // Existing stored enum and identity clearing stay compatible. A fast
      // second tap, or a provider tap during the write, cannot start another path.
      reset();
      rtl = locale !== "en";
      meta.set("onboarding_pending_name", "Old provider");
      meta.set("onboarding_pending_email", "old@example.com");
      meta.set("onboarding_pending_phone", "+93700000000");
      const ready = nodes(render(false));
      const start = ready.find((node) => node.props.accessibilityLabel === title)!;
      const continuing = start.props.onPress();
      const busyTree = nodes(render(false));
      const busyAction = busyTree.find((node) => node.props.accessibilityLabel === title)!;
      assert.equal(busyAction.props.accessibilityState.busy, true);
      assert.ok(nodes(busyAction).some((node) => node.type === "Spinner"));
      assert.ok(
        busyTree.filter((node) => node.type === "Pressable").every((node) => node.props.disabled),
      );
      assert.ok(busyTree.some((node) => node.props.children === warningText));
      await start.props.onPress();
      await ready
        .find(
          (node) =>
            node.props.accessibilityLabel === catalog.tIn(locale, "onboardingMode.google.title"),
        )!
        .props.onPress();
      await continuing;
      assert.equal(authCalls, 0, "ninja continuation blocks competing provider calls");
      assert.equal(meta.get("onboarding_auth_method"), "offline");
      for (const key of [
        "onboarding_pending_name",
        "onboarding_pending_email",
        "onboarding_pending_phone",
      ]) {
        assert.equal(meta.get(key), "");
      }
      assert.equal(meta.get("onboarding_step"), "profile");
      assert.deepEqual(routes, ["/onboarding/profile"], "a double tap only continues once");
    }
  } finally {
    mocks["../../lib/i18n"].t = originalTranslate;
    reset();
  }
  console.log(
    "PASS: original ninja icon, translated CTA/loss warning below it, RTL, busy guard and sign-in-only exclusion in EN/FA/PS",
  );
}
async function main() {
  await ninjaMode();
  settingsSignIn();
  // Apply actions to the installed SDK's actual stack router, including the
  // native GO_BACK action fired by an iOS edge swipe. The selector must remain
  // beneath the email form instead of returning all the way to Home.
  const { StackRouter } = require(
    join(
      dirname(require.resolve("expo-router/package.json")),
      "build/react-navigation/routers/StackRouter.js",
    ),
  );
  const stackRouter = StackRouter({ initialRouteName: "index" });
  const stackOptions = {
    routeNames: ["index", "sign-in", "onboarding/auth", "auth/email", "person/[id]"],
    routeParamList: {},
    routeGetIdList: {},
  };
  for (const redirected of [true, false]) {
    reset();
    let state = stackRouter.getInitialState(stackOptions);
    const provider = redirected ? "sign-in" : "onboarding/auth";
    state = stackRouter.getStateForAction(
      state,
      {
        type: "PUSH",
        payload: { name: provider },
      },
      stackOptions,
    );
    nodes(render(redirected))
      .find((n) => n.props.accessibilityLabel === "onboardingMode.email.title")
      .props.onPress();
    assert.deepEqual(routes, [
      {
        pathname: "/auth/email",
        params: { redirected: redirected ? "1" : "0" },
      },
    ]);
    state = stackRouter.getStateForAction(
      state,
      {
        type: "PUSH",
        payload: { name: "auth/email", params: routes[0].params },
      },
      stackOptions,
    );
    state = stackRouter.getStateForAction(state, { type: "GO_BACK" }, stackOptions);
    assert.equal(
      state.routes[state.index].name,
      provider,
      "a native swipe lands on the auth-method selector in either context",
    );
  }
  let wrapperState: any;
  let wrapperRedirected = "1";
  const emailRouteModule: any = {};
  new Function(
    "require",
    "exports",
    ts.transpileModule(readFileSync(require.resolve("../../app/auth/email"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
  )((name: string) => {
    if (name === "../onboarding/auth") return { AuthScreen: "AuthScreen" };
    if (name === "react") return { ...mocks.react, useEffect: (run: () => void) => run() };
    if (name === "expo-router")
      return {
        ...mocks[name],
        useLocalSearchParams: () => ({ redirected: wrapperRedirected }),
        // The real hook returns expo-router's outer slot navigator, whose only
        // route is "__root" with the root Stack nested inside it. Faking the
        // Stack here once hid that the swipe could never be enabled.
        useRootNavigationState: () => ({
          key: "slot",
          index: 0,
          routes: [{ name: "__root", state: wrapperState }],
        }),
        useNavigation: () => ({ getState: () => wrapperState, addListener: () => () => {} }),
      };
    assert.ok(name in mocks, name);
    return mocks[name];
  }, emailRouteModule);
  for (const redirected of [true, false]) {
    wrapperRedirected = redirected ? "1" : "0";
    const provider = redirected ? "sign-in" : "onboarding/auth";
    for (const entry of ["direct", "normal", "already-left"]) {
      reset();
      wrapperState = stackRouter.getInitialState(stackOptions);
      if (entry !== "direct")
        wrapperState = stackRouter.getStateForAction(
          wrapperState,
          {
            type: "PUSH",
            payload: { name: provider },
          },
          stackOptions,
        );
      if (entry !== "already-left")
        wrapperState = stackRouter.getStateForAction(
          wrapperState,
          {
            type: "PUSH",
            payload: { name: "auth/email" },
          },
          stackOptions,
        );
      const tree = emailRouteModule.default();
      assert.equal(tree.props.redirected, redirected);
      assert.equal(tree.props.providerReady, entry === "normal");
      if (entry !== "direct") {
        assert.deepEqual(routes, [], "existing history and a departed route are left alone");
        continue;
      }
      assert.deepEqual(
        routes,
        [`/${provider}`, { pathname: "/auth/email", params: { redirected: wrapperRedirected } }],
        "direct/cold entry rebuilds its provider underneath before enabling gestures",
      );
      wrapperState = stackRouter.getStateForAction(
        wrapperState,
        {
          type: "REPLACE",
          payload: { name: provider },
        },
        stackOptions,
      );
      wrapperState = stackRouter.getStateForAction(
        wrapperState,
        {
          type: "PUSH",
          payload: { name: "auth/email" },
        },
        stackOptions,
      );
      wrapperState = stackRouter.getStateForAction(wrapperState, { type: "GO_BACK" }, stackOptions);
      assert.equal(wrapperState.routes[wrapperState.index].name, provider);
    }
  }
  // A successful email sign-in removes both auth pages before handing off an
  // existing action, exactly as the single provider route previously did.
  for (const [key, destination] of [
    ["pending_tab_person", { pathname: "/person/[id]", params: { id: "person" } }],
    ["pending_tab_token", { pathname: "/t/[token]", params: { token: "person" } }],
    ["pending_invite_token", { pathname: "/invite/[token]", params: { token: "person" } }],
  ] as const) {
    reset();
    meta.set(key, "person");
    await nodes(await renderEmail(true))
      .find((n) => n.type === "EmailAuthFlow")
      .props.onSignedIn({ email: "test@example.com" });
    assert.deepEqual(routes, [{ dismissTo: "/sign-in" }, destination]);
    assert.equal(meta.get("onboarding_step"), "done");
  }
  reset();
  await nodes(await renderEmail(false))
    .find((n) => n.type === "EmailAuthFlow")
    .props.onSignedIn({ email: "test@example.com" });
  assert.deepEqual(routes, [{ dismissTo: "/onboarding/auth" }, "/onboarding/restore"]);
  for (const redirected of [true, false]) {
    for (const email of [true, false]) {
      reset();
      meta.set("account_id", "account-a");
      meta.set("account_deletion_cancelled", "account-a");
      meta.set("pending_tab_token", "kept-intent");
      if (email) {
        await nodes(await renderEmail(redirected))
          .find((n) => n.type === "EmailAuthFlow")
          .props.onSignedIn({ email: "test@example.com" });
      } else {
        nodes(render(redirected))
          .find((n) => n.props.accessibilityLabel === "onboardingMode.google.title")
          .props.onPress();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      assert.deepEqual(
        routes,
        [
          ...(email ? [{ dismissTo: redirected ? "/sign-in" : "/onboarding/auth" }] : []),
          "/onboarding/restore",
        ],
        "cancelled deletion uses recovery from existing Settings and onboarding auth",
      );
      assert.equal(
        meta.get("pending_tab_token"),
        "kept-intent",
        "recovery does not discard the original action",
      );
      assert.equal(meta.get("onboarding_step"), undefined);
    }
  }
  reset();
  meta.set("account_id", "account-a");
  meta.set("account_deletion_cancelled", "account-b");
  await signIn();
  assert.deepEqual(
    routes,
    [{ dismissTo: "/" }],
    "another account's marker leaves the ordinary existing-account route intact",
  );
  assert.equal(meta.get("account_deletion_cancelled"), "account-b");
  console.log(
    "PASS: native email Back preserves selector, including direct/cold entry; email success replaces both auth routes",
  );
  for (const platform of ["android", "ios"]) {
    mocks["react-native"].Platform.OS = platform;
    for (const available of [true, false]) {
      reset();
      googleAvailable = available;
      appleAvailable = true;
      const providerLabels = nodes(render())
        .filter((n) =>
          /onboardingMode\.(google|apple|email)\.title/.test(n.props.accessibilityLabel),
        )
        .map((n) => n.props.accessibilityLabel);
      assert.deepEqual(
        providerLabels,
        [
          ...(platform === "ios"
            ? ["onboardingMode.apple.title", ...(available ? ["onboardingMode.google.title"] : [])]
            : [
                ...(available ? ["onboardingMode.google.title"] : []),
                "onboardingMode.apple.title",
              ]),
          "onboardingMode.email.title",
        ],
        "the destination retains email, Apple and available Google with platform ordering",
      );
    }
  }
  mocks["react-native"].Platform.OS = "android";
  reset();
  assert.equal(
    nodes(render()).some((n) => n.props.accessibilityLabel === "onboardingMode.offline.title"),
    false,
  );
  assert.equal(
    nodes(render(false)).some((n) => n.props.accessibilityLabel === "onboardingMode.offline.title"),
    true,
  );
  reset();
  meta.set("pending_tab_person", "person");
  await signIn();
  assert.deepEqual(routes, [{ pathname: "/person/[id]", params: { id: "person" } }]);
  assert.equal(meta.get("onboarding_step"), "done");
  assert.equal(
    restoredVault,
    "current-vault",
    "recovery must not open this contact in the default book",
  );
  reset();
  self = null;
  recovery.recovered = ["cloud-vault"];
  meta.set("pending_tab_token", "invite");
  await signIn();
  assert.deepEqual(routes, [{ pathname: "/t/[token]", params: { token: "invite" } }]);
  assert.equal(meta.get("onboarding_step"), "done");
  reset();
  meta.set("pending_invite_token", "member");
  await signIn();
  assert.deepEqual(routes, [{ pathname: "/invite/[token]", params: { token: "member" } }]);
  reset();
  await signIn();
  // Back DOWN to the home screen the sign-in was opened from, never a second
  // home on top of it.
  assert.deepEqual(routes, [{ dismissTo: "/" }]);
  assert.deepEqual(
    toasts,
    [["menu.account.signIn.toast", "success"]],
    "Settings sign-in says it worked",
  );
  // Some kaatas did not come back: said, not silent (audit #2).
  reset();
  recovery.recovered = ["cloud-vault"];
  recovery.failed = [{ vaultId: "other", error: "timeout" }];
  await signIn();
  assert.deepEqual(toasts, [["menu.account.signIn.partialToast", "error"]]);
  // Left the page while the kaatas restored: no late jump to another screen.
  reset();
  focused = false;
  await signIn();
  assert.deepEqual(routes, [], "a finish after leaving never navigates");
  assert.equal(meta.get("onboarding_step"), "done", "the restore itself still completes");
  // Apple on Android only when the server's web sign-in is configured.
  reset();
  mocks["react-native"].Platform.OS = "android";
  appleAvailable = false;
  assert.equal(
    nodes(render()).some((n) => n.props.accessibilityLabel === "onboardingMode.apple.title"),
    false,
    "an Apple card that cannot finish is not offered",
  );
  reset();
  self = null;
  await signIn();
  assert.deepEqual(routes, ["/onboarding/profile"]);
  // A first-time invitee who signed in from the kaata invite joins it first
  // and sets up afterwards; the invitation used to be dropped here (audit #7).
  reset();
  self = null;
  meta.set("pending_invite_token", "first-member");
  await signIn();
  assert.deepEqual(routes, [{ pathname: "/invite/[token]", params: { token: "first-member" } }]);
  assert.equal(meta.get("onboarding_step"), "profile", "setup resumes after the join");
  assert.equal(meta.get("pending_invite_token"), "", "the invitation is consumed once");
  reset();
  self = null;
  recovery.failed = [{ vaultId: "*", error: "offline" }];
  const warn = console.warn;
  console.warn = () => {};
  try {
    await signIn();
  } finally {
    console.warn = warn;
  }
  assert.equal(routes.length, 0, "failed recovery cannot masquerade as a new account");
  assert.equal(meta.get("onboarding_step"), undefined);
  assert.ok(
    nodes(render()).some((n) => n.props.children === "auth.error.recoveryUnavailable"),
    "a recovery failure after a good sign-in says so, not 'Sign-in didn't work'",
  );
  console.log(
    "PASS: redirect-only sign-in, provider guard, existing/local/restored/new accounts, intent handoff, active vault and retryable recovery failure",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
