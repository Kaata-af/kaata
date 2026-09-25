// Run the real auth screen with synthetic provider/recovery adapters.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

let slots: any[] = [],
  cursor = 0,
  self: any = { name: "Matee" };
let recovery = { recovered: [] as string[], failed: [] as any[] };
let routes: any[] = [],
  authCalls = 0,
  restoredVault = "";
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
  },
  "react-native": {
    View: "View",
    Text: "Text",
    Pressable: "Pressable",
    ActivityIndicator: "Spinner",
    Platform: { OS: "android", select: (x: any) => x.android },
    StyleSheet: { create: (x: any) => x },
  },
  "react-native-safe-area-context": { SafeAreaView: "Safe" },
  "@expo/vector-icons": { Ionicons: "Icon" },
  "expo-constants": { default: { executionEnvironment: "standalone" } },
  "expo-router": {
    useRouter: () => ({ replace: (r: any) => routes.push(r), canGoBack: () => false }),
  },
  "../../components/GoogleGIcon": { GoogleGIcon: "Google" },
  "../../components/NinjaIcon": { NinjaIcon: "Ninja" },
  "../../components/ConfirmDialog": { ConfirmDialog: "Dialog" },
  "../../lib/recovery": { recoverAllVaults: async () => recovery },
  "../../lib/sync/reconcile": { reconcileVaultRegistrations: async () => {} },
  "../../lib/auth": {
    isGoogleSignInAvailable: () => true,
    isCancellation: () => false,
    SignInFailedError: class extends Error {},
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
    rowDir: () => ({}),
    textDir: () => ({}),
    trackingSafe: () => ({}),
    useIsRTL: () => false,
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
  return mocks[k];
}, out);
function nodes(n: any): any[] {
  return Array.isArray(n) ? n.flatMap(nodes) : n?.props ? [n, ...nodes(n.props.children)] : [];
}
function render(redirected = true) {
  cursor = 0;
  return out.AuthScreen({ redirected });
}
function reset() {
  slots = [];
  routes = [];
  meta.clear();
  authCalls = 0;
  self = { name: "Matee" };
  recovery = { recovered: [], failed: [] };
  restoredVault = "";
}
async function signIn() {
  const tree = render();
  await nodes(tree)
    .find((n) => n.props.accessibilityLabel === "onboardingMode.google.title")
    .props.onPress();
}
async function main() {
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
  assert.deepEqual(routes, ["/"]);
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
