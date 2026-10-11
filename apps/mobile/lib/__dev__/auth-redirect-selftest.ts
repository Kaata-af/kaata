// Run the real auth screen with synthetic provider/recovery adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

let slots: any[] = [],
  cursor = 0,
  self: any = { name: "Matee" };
let recovery = { recovered: [] as string[], failed: [] as any[] };
let routes: any[] = [],
  authCalls = 0,
  restoredVault = "",
  googleAvailable = true,
  rtl = false;
const meta = new Map<string, string>();
const jsx = (type: any, props: any) => ({ type, props });
const mocks: Record<string, any> = {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    useState: (v: any) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = v;
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
  "react-native-safe-area-context": { SafeAreaView: "Safe" },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-constants": { default: { executionEnvironment: "standalone" } },
  "expo-router": {
    Stack: { Screen: "StackScreen" },
    useIsFocused: () => true,
    useFocusEffect: () => {},
    useRouter: () => ({
      replace: (r: any) => routes.push(r),
      push: (r: any) => routes.push(r),
      dismissTo: (r: any) => routes.push({ dismissTo: r }),
      canGoBack: () => false,
    }),
  },
  "../../components/EmailAuthFlow": { EmailAuthFlow: "EmailAuthFlow" },
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
    rowDir: () => ({}),
    textDir: () => ({}),
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
  rtl = false;
}
function settingsSignIn() {
  // Exercise the real settings sheet: dismiss its native Modal first, then
  // push the provider page once the existing exit delay has elapsed.
  const sheetMocks: Record<string, any> = {
    ...mocks,
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
      // behavior under test. This initializes its first `rendered` state.
      slots = [true];
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
async function main() {
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
        useRootNavigationState: () => wrapperState,
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
  console.log(
    "PASS: native email Back preserves selector, including direct/cold entry; email success replaces both auth routes",
  );
  for (const platform of ["android", "ios"]) {
    mocks["react-native"].Platform.OS = platform;
    for (const available of [true, false]) {
      reset();
      googleAvailable = available;
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
    nodes(render()).some((n) => n.type === "Ninja"),
    false,
  );
  assert.equal(
    nodes(render(false)).some((n) => n.type === "Ninja"),
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
  reset();
  self = null;
  await signIn();
  assert.deepEqual(routes, ["/onboarding/profile"]);
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
  assert.ok(nodes(render()).some((n) => n.props.children === "onboardingMode.signInFailed"));
  console.log(
    "PASS: redirect-only sign-in, provider guard, existing/local/restored/new accounts, intent handoff, active vault and retryable recovery failure",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
