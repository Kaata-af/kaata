// Run with: npm run selftest:install-retired
// Synthetic fixtures only: never opens kaata.db, SecureStore, a device or the
// network.
//
// Deleting an account RETIRES every installation that was ever signed in to it,
// and the live backend then answers 410 to that phone's check-in and to sign-in
// with ANY account. This pins the phone's side against the ACTUAL lib/auth.ts,
// lib/api.ts, lib/install-id.ts, lib/i18n.ts, app/onboarding/auth.tsx and
// components/ConfirmDialog.tsx, transpiled with mocks in the
// lib/__dev__/account-deletion-selftest.ts pattern; app_meta is real SQL on an
// in-memory better-sqlite3 database:
//   - a 410 becomes InstallRetiredError (server text kept); other statuses are
//     unchanged;
//   - a 410 records app_meta install_retired, only for the install it was
//     about; no other failure records anything;
//   - a later successful check-in or sign-in for the same install clears it,
//     and a success for an id a reset has replaced clears nothing;
//   - resetRetiredInstall is the local deletion wipe, in order, offline, under
//     a fresh install id, with both deletion keys gone, serialized with session
//     work and invalidating every earlier session snapshot; only the one-shot
//     Apple name survives it, and reaches the next Apple sign-in;
//   - the copy says what happened without overstating it;
//   - the sign-in screen explains a retired install, offers the reset, and
//     erases only from the destructive confirmation;
//   - a destructive ConfirmDialog ignores presses for its first 350 ms after
//     every open, so a double tap cannot confirm it.
// The home sign-in path (app/index.tsx) and Account's notice card
// (app/account.tsx) are not rendered here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";

type Auth = typeof import("../auth");
type Api = typeof import("../api");
type InstallId = typeof import("../install-id");
type I18n = typeof import("../i18n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = { type: unknown; props: Record<string, any> };

const BASE = "https://backend.invalid";
const SESSION_KEY = "kaata.session.jwt";
const USER_KEY = "kaata.session.user";
const CONFIRMATION_KEY = "kaata.account.deletion-confirmation";
const ATTEMPT_KEY = "kaata.account.deletion-attempt";
// app_meta key of lib/auth.ts's one-shot Apple name stash.
const APPLE_NAME_KEY = "apple_pending_display_name";
// The live backend's wording (apps/backend/internal/auth/handler.go and
// internal/checkin/handler.go).
const AUTH_GONE =
  "This installation belongs to a deleted account. Export any local records, then reset the app before signing in.";
const CHECKIN_GONE =
  "install was retired after account deletion; reset this device before continuing";

// Transpile one real module and evaluate it against `mocks`. Anything it
// requires that is not mocked fails loudly, so a new dependency is noticed.
function load<T>(path: string, mocks: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in mocks, `unexpected dependency of ${path}: ${name}`);
    return mocks[name];
  }, exports);
  return exports as T;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Lets every chain that is not waiting on something external run as far as it
// can before the next assertion.
const settle = () => new Promise<void>((done) => setImmediate(done));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected a rejection");
}

// --- app_meta: real SQL on an in-memory database ----------------------------

const fixture = new Database(":memory:");
const sqlite = {
  execAsync: async (sql: string) => {
    fixture.exec(sql);
  },
  runAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).run(...args),
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
};

// Throws while app_meta does not exist, exactly like the real accessor.
function metaGet(key: string): string | null {
  const row = fixture.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function metaSet(key: string, value: string): void {
  fixture
    .prepare(
      "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// A phone whose app_meta holds this install id and nothing else. The empty
// users table is what a successful sign-in's phone reconcile reads.
function phone(installId: string): void {
  fixture.exec(`DROP TABLE IF EXISTS app_meta;
    DROP TABLE IF EXISTS users;
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (phone_e164 TEXT, is_local_self INTEGER);`);
  metaSet("install_id", installId);
}

// --- native and network boundaries -------------------------------------------

const secure = new Map<string, string>();
const trace: string[] = [];
let accountCache: string | null = null;
// Runs right after a lib/install-id read through lib/db: the point where a
// reset could land between a separate read and a later write.
let afterMetaRead: (() => void) | null = null;
// Holds resetAllLocalData open, so a test can act while the wipe is running.
let resetGate: Promise<void> | null = null;
let onResetStarted: (() => void) | null = null;

const fetchCalls: string[] = [];
// The JSON body of each request, in step with fetchCalls.
const fetchBodies: Array<Record<string, unknown> | undefined> = [];
let respond: (url: string) => Promise<Response> = async () => {
  throw new Error("no reply scripted");
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  fetchCalls.push(url);
  fetchBodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
  return respond(url);
}) as typeof fetch;

const reply = (status: number, body: unknown) => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// What the live backend answers to an accepted check-in and sign-in.
const checkInOk = { server_time: "2026-10-03T08:00:00Z", update: null, announcement: null };
const signInOk = {
  session_jwt: "session.accepted",
  account_id: "account-ok",
  default_vault_id: null,
  user: { email: "ok@example.test", sub: "sub-ok" },
};

// What Apple's native sheet returns. The name comes on the FIRST authorization
// of an Apple ID only; afterwards fullName is null.
type AppleCredential = {
  identityToken: string;
  fullName: { givenName?: string; familyName?: string } | null;
  user: string;
};
const NAMELESS_APPLE: AppleCredential = {
  identityToken: "apple.id.token",
  fullName: null,
  user: "apple",
};
let appleCredential = NAMELESS_APPLE;

const reactNative = { Platform: { OS: "android" } };

// --- the real modules ----------------------------------------------------------

const installId = load<InstallId>("../install-id", {
  "expo-crypto": {
    randomUUID: () => {
      trace.push("randomUUID");
      return randomUUID();
    },
  },
  "./db": {
    getAppMeta: async (key: string) => {
      const value = metaGet(key);
      afterMetaRead?.();
      return value;
    },
    setAppMeta: async (key: string, value: string) => metaSet(key, value),
  },
  "./db-tx": { getDb: async () => sqlite },
});

const auth = load<Auth>("../auth", {
  "expo-constants": { __esModule: true, default: { executionEnvironment: "standalone" } },
  "expo-secure-store": {
    getItemAsync: async (key: string) => secure.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      trace.push(`secure.set:${key}`);
      secure.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      trace.push(`secure.delete:${key}`);
      secure.delete(key);
    },
  },
  "react-native": reactNative,
  "../constants/env": { GOOGLE_IOS_CLIENT_ID: "", GOOGLE_WEB_CLIENT_ID: "web-client" },
  "./api": { getBackendUrl: async () => BASE },
  "./db-tx": {
    getAccountIdSync: () => accountCache,
    getActiveVaultId: async () => null,
    getAppMetaInTx: async (_db: unknown, key: string) => metaGet(key),
    getDb: async () => sqlite,
    refreshAccountIdCache: async () => accountCache,
    setAccountIdCache: (id: string | null) => {
      trace.push(`setAccountIdCache:${id}`);
      accountCache = id;
    },
    setAppMetaInTx: async (_db: unknown, key: string, value: string) => {
      if (key === APPLE_NAME_KEY) trace.push(`meta.set:${key}`);
      metaSet(key, value);
    },
    setInstallIdCache: (id: string) => {
      trace.push(`setInstallIdCache:${id}`);
    },
    setLocalSelfUserIdCache: (id: string | null) => {
      trace.push(`setLocalSelfUserIdCache:${id}`);
    },
  },
  "./db": {
    initDb: async (opts: { installId: string }) => {
      trace.push(`initDb:${opts.installId}`);
    },
    resetAllLocalData: async () => {
      trace.push("resetAllLocalData");
      onResetStarted?.();
      if (resetGate) await resetGate;
      // What the real wipe does to app_meta: every table is dropped.
      fixture.exec("DROP TABLE IF EXISTS app_meta");
    },
  },
  "./effective-account": {},
  "./event-log": {},
  "./phone": {},
  "./install-id": installId,
  // Loaded after a successful sign-in only.
  "./mesh": { registerDeviceKey: async () => {} },
  "./mesh/device-key": {
    clearDeviceKey: () => {
      trace.push("clearDeviceKey");
    },
  },
  "@react-native-google-signin/google-signin": {
    GoogleSignin: {
      hasPlayServices: async () => true,
      signOut: async () => {
        trace.push("google.signOut");
      },
      signIn: async () => ({ data: { idToken: "google.id.token" } }),
    },
    isErrorWithCode: (err: unknown) => typeof err === "object" && err !== null && "code" in err,
    statusCodes: { SIGN_IN_CANCELLED: "SIGN_IN_CANCELLED" },
  },
  "expo-apple-authentication": {
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
    signInAsync: async () => appleCredential,
  },
});

const api = load<Api>("../api", {
  "../constants/env": { BACKEND_URL_FALLBACK: BASE },
  "./auth": auth,
  "./db": { getAppMeta: async (key: string) => metaGet(key) },
  "./install-id": installId,
});

const i18n = load<I18n>("../i18n", {
  "expo-localization": { getLocales: () => [{ languageCode: "en", languageTag: "en-US" }] },
  "./db": { getAppMeta: async () => null },
});

function signIn(provider: "google" | "apple") {
  // Apple's native sheet on iOS; Android would take the browser flow.
  reactNative.Platform.OS = provider === "apple" ? "ios" : "android";
  return provider === "apple" ? auth.signInWithApple() : auth.signInWithGoogle();
}

const checkInPayload = (id: string) => ({
  install_id: id,
  app_version: "2.1.0",
  platform: "android",
  device_locale: "en-US",
});

// --- the onboarding sign-in screen, rendered with a hook-slot React stub -------

let slots: unknown[] = [];
let cursor = 0;
let routes: unknown[] = [];
let crashReports: unknown[] = [];
let resets = 0;
let resetFails = false;
let nextSignInError: unknown = null;
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });

const screen = load<{ AuthScreen: (props: { redirected?: boolean }) => unknown }>(
  "../../app/onboarding/auth",
  {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState: (initial: unknown) => {
        const i = cursor++;
        if (!(i in slots)) slots[i] = initial;
        return [
          slots[i],
          (next: unknown) => {
            slots[i] = next;
          },
        ];
      },
      useRef: (initial: unknown) => {
        const i = cursor++;
        return (slots[i] ??= { current: initial });
      },
      useEffect: () => {},
    },
    "react-native": {
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
      ActivityIndicator: "Spinner",
      Platform: { OS: "android", select: (x: { android: unknown }) => x.android },
      StyleSheet: { create: (x: unknown) => x },
    },
    "react-native-safe-area-context": { SafeAreaView: "Safe" },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "expo-constants": { __esModule: true, default: { executionEnvironment: "standalone" } },
    "expo-router": {
      useRouter: () => ({ replace: (r: unknown) => routes.push(r), canGoBack: () => false }),
    },
    "../../components/GoogleGIcon": { GoogleGIcon: "Google" },
    "../../components/NinjaIcon": { NinjaIcon: "Ninja" },
    "../../components/ConfirmDialog": { ConfirmDialog: "Dialog" },
    "../../lib/recovery": { recoverAllVaults: async () => ({ recovered: [], failed: [] }) },
    "../../lib/sync/reconcile": { reconcileVaultRegistrations: async () => {} },
    "../../lib/auth": {
      isGoogleSignInAvailable: () => true,
      isCancellation: () => false,
      // The REAL classes, so the screen's instanceof checks are the shipped ones.
      SignInFailedError: auth.SignInFailedError,
      InstallRetiredError: auth.InstallRetiredError,
      signInWithGoogle: async () => {
        throw nextSignInError;
      },
      signInWithApple: async () => {
        throw nextSignInError;
      },
      resetRetiredInstall: async () => {
        resets++;
        if (resetFails) throw new Error("synthetic reset failure");
      },
    },
    "../../lib/crash-report": {
      queueCrashReport: async (report: unknown) => {
        crashReports.push(report);
      },
    },
    "../../lib/colors": { colors: {} },
    "../../lib/db": {
      getAppMeta: async () => null,
      setAppMeta: async () => {},
      getLocalSelf: async () => null,
    },
    "../../lib/db-tx": { getActiveVaultIdSyncMaybe: () => null, setActiveVaultId: async () => {} },
    "../../lib/currency": { applyVaultCurrency: async () => {} },
    "../../lib/direction": {
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
      useIsRTL: () => false,
    },
    "../../lib/fonts": { fonts: {}, sansLineHeight: (_size: number, tight: number) => tight },
    "../../lib/i18n": { t: (key: string) => key },
    "../../lib/tokens": { icon: {}, radius: {}, TOUCH_MIN: 44, typography: {} },
  },
);

function nodes(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  const node = tree as Node | null;
  return node?.props ? [node, ...nodes(node.props.children)] : [];
}

function render(): Node[] {
  cursor = 0;
  return nodes(screen.AuthScreen({}));
}

function freshScreen(): void {
  slots = [];
  routes = [];
  crashReports = [];
  resets = 0;
  resetFails = false;
}

async function tap(label: string): Promise<void> {
  const control = render().find((n) => n.props.accessibilityLabel === label);
  assert.ok(control, `no control labelled ${label}`);
  await control.props.onPress();
}

const errorText = () => render().find((n) => n.props.accessibilityLiveRegion === "polite");
const hasResetButton = () =>
  render().some((n) => n.props.accessibilityLabel === "account.retired.reset");

function resetDialog(): Node {
  const dialog = render().find(
    (n) => n.type === "Dialog" && n.props.title === "account.retired.confirm.title",
  );
  assert.ok(dialog, "the reset confirmation is mounted");
  return dialog;
}

// --- the REAL ConfirmDialog, with a hook-slot React stub that runs effects ------
// Every screen's reset confirmation is this component; the AuthScreen stub above
// mounts it only as the "Dialog" placeholder.

type DialogProps = {
  visible: boolean;
  title: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tertiaryLabel?: string;
  tertiaryDestructive?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onTertiary?: () => void;
};

let dialogSlots: unknown[] = [];
let dialogCursor = 0;
let dialogEffects: Array<() => void> = [];
let dialogDirty = false;
// The dialog's only clock: Date.now is pointed here while a dialog case runs.
let clock = 0;

const sameDeps = (a?: unknown[], b?: unknown[]) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// The enter animation starts from requestAnimationFrame, which Node lacks.
Object.assign(globalThis, {
  requestAnimationFrame: (run: () => void) => {
    run();
    return 0;
  },
});

const dialogModule = load<{
  ConfirmDialog: (props: DialogProps) => unknown;
  DESTRUCTIVE_ARM_MS: number;
}>("../../components/ConfirmDialog", {
  "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
  react: {
    useState: (initial: unknown) => {
      const i = dialogCursor++;
      if (!(i in dialogSlots)) dialogSlots[i] = initial;
      return [
        dialogSlots[i],
        (next: unknown) => {
          if (Object.is(next, dialogSlots[i])) return;
          dialogSlots[i] = next;
          dialogDirty = true;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const i = dialogCursor++;
      return (dialogSlots[i] ??= { current: initial });
    },
    useEffect: (run: () => void, deps?: unknown[]) => {
      const i = dialogCursor++;
      const previous = dialogSlots[i] as { deps?: unknown[] } | undefined;
      if (sameDeps(previous?.deps, deps)) return;
      dialogSlots[i] = { deps };
      dialogEffects.push(run);
    },
  },
  "expo-blur": { BlurView: "Blur" },
  "react-native": {
    Animated: {
      Value: class {
        constructor(readonly value: number) {}
      },
      View: "Animated.View",
      timing: () => ({}),
      spring: () => ({}),
      // Animations finish at once; the guard must not depend on them.
      parallel: () => ({
        start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
      }),
    },
    Modal: "Modal",
    Platform: { OS: "android", select: (x: { android: unknown }) => x.android },
    Pressable: "Pressable",
    StyleSheet: { create: (x: unknown) => x, absoluteFill: {} },
    Text: "Text",
    View: "View",
  },
  "../lib/colors": { colors: {} },
  "../lib/blur": { SHEET_BLUR_METHOD: "none" },
  "../lib/direction": {
    rowDir: () => ({}),
    textDir: () => ({}),
    trackingSafe: () => ({}),
    useIsRTL: () => false,
  },
  "../lib/fonts": { fonts: {} },
  "../lib/i18n": { t: (key: string) => key },
  "../lib/tokens": { radius: {}, TOUCH_MIN: 44, typography: {} },
});

// Renders until no effect changes state, like a commit followed by its effects.
function renderDialog(props: DialogProps): Node[] {
  for (let pass = 0; pass < 10; pass++) {
    dialogCursor = 0;
    dialogDirty = false;
    const tree = dialogModule.ConfirmDialog(props);
    const effects = dialogEffects;
    dialogEffects = [];
    for (const run of effects) run();
    if (!dialogDirty) return nodes(tree);
  }
  assert.fail("ConfirmDialog never settled");
}

// Runs `run` with Date.now on the test clock, starting from a fresh dialog.
function withDialogClock(run: () => void): void {
  const realNow = Date.now;
  dialogSlots = [];
  clock = 1_000_000;
  Date.now = () => clock;
  try {
    run();
  } finally {
    Date.now = realNow;
  }
}

// --- cases -----------------------------------------------------------------------

const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => cases.push([name, run]);

test("sign-in 410 is InstallRetiredError with the server text, and is recorded", async () => {
  for (const provider of ["google", "apple"] as const) {
    phone("install-a");
    secure.clear();
    fetchCalls.length = 0;
    respond = reply(410, { error: AUTH_GONE });
    const err = await rejection(signIn(provider));
    assert.ok(err instanceof auth.InstallRetiredError, `${provider}: 410 → InstallRetiredError`);
    assert.ok(err instanceof auth.SignInFailedError, "base-class code still sees a server answer");
    assert.equal(err.message, AUTH_GONE, "the server's own wording is kept");
    assert.equal(err.code, "server 410");
    assert.deepEqual(fetchCalls, [`${BASE}/v1/auth/${provider}`]);
    assert.equal(metaGet("install_retired"), "1", `${provider}: the retirement is remembered`);
    assert.equal(secure.has(SESSION_KEY), false, "a refused sign-in installs no session");
  }
  // The status alone is the signal: a body the phone cannot read changes nothing.
  phone("install-a");
  respond = async () => new Response("<html>Gone</html>", { status: 410 });
  const err = await rejection(signIn("google"));
  assert.ok(err instanceof auth.InstallRetiredError, "non-JSON 410 → InstallRetiredError");
  assert.equal(err.message, "This installation belongs to a deleted account.");
  assert.equal(metaGet("install_retired"), "1");
});

test("other sign-in statuses are unchanged and record nothing", async () => {
  for (const status of [400, 401, 403, 409, 500, 503]) {
    phone("install-a");
    respond = reply(status, { error: `refused ${status}` });
    const err = await rejection(signIn(status % 2 ? "apple" : "google"));
    assert.ok(err instanceof auth.SignInFailedError, `${status} stays a SignInFailedError`);
    assert.ok(!(err instanceof auth.InstallRetiredError), `${status} is not a retirement`);
    assert.equal(err.code, `server ${status}`);
    assert.equal(err.message, `refused ${status}`);
    assert.equal(metaGet("install_retired"), null, `${status} must not flag the install`);
  }
  phone("install-a");
  respond = async () => new Response("bad gateway", { status: 502 });
  const err = await rejection(signIn("google"));
  assert.ok(err instanceof auth.SignInFailedError && !(err instanceof auth.InstallRetiredError));
  assert.equal(err.message, "Kaata couldn't complete sign-in. Try again.");
  assert.equal(err.code, "server 502");
  assert.equal(metaGet("install_retired"), null);
});

test("check-in 410 sets install_retired and throws InstallRetiredError", async () => {
  phone("install-a");
  respond = reply(410, { error: CHECKIN_GONE });
  const err = await rejection(api.checkIn(checkInPayload("install-a")));
  assert.ok(err instanceof auth.InstallRetiredError, "410 → InstallRetiredError");
  assert.equal(err.message, CHECKIN_GONE);
  assert.equal(metaGet("install_retired"), "1");
});

test("other check-in failures keep today's behaviour and set no flag", async () => {
  for (const status of [400, 401, 404, 500, 503]) {
    phone("install-a");
    respond = reply(status, { error: "nope" });
    const err = await rejection(api.checkIn(checkInPayload("install-a")));
    assert.ok(err instanceof Error && !(err instanceof auth.InstallRetiredError));
    assert.equal(err.message, `check-in failed: ${status}`);
    assert.equal(metaGet("install_retired"), null, `${status} must not flag the install`);
  }
  phone("install-a");
  const offline = new TypeError("Network request failed");
  respond = async () => {
    throw offline;
  };
  assert.equal(await rejection(api.checkIn(checkInPayload("install-a"))), offline);
  assert.equal(metaGet("install_retired"), null, "offline must not flag the install");
  phone("install-a");
  respond = reply(200, { update: null, announcement: null, force_update: false });
  const resp = await api.checkIn(checkInPayload("install-a"));
  assert.equal(resp.force_update, false);
  assert.equal(metaGet("install_retired"), null);
});

test("a 410 for an id replaced mid-request never flags the fresh install", async () => {
  phone("install-a");
  respond = async () => {
    // A reset minted a new id while this check-in was on the network.
    metaSet("install_id", "install-b");
    return reply(410, { error: CHECKIN_GONE })();
  };
  const err = await rejection(api.checkIn(checkInPayload("install-a")));
  assert.ok(err instanceof auth.InstallRetiredError, "the caller still learns it was refused");
  assert.equal(metaGet("install_retired"), null, "install-b inherits nothing");
});

test("the id check and the flag write cannot be split by a reset", async () => {
  phone("install-a");
  // A reset (fresh app_meta, fresh id) lands right after any separate read.
  afterMetaRead = () => {
    afterMetaRead = null;
    phone("install-b");
  };
  try {
    await installId.markInstallRetired("install-a");
  } finally {
    afterMetaRead = null;
  }
  const current = metaGet("install_id");
  assert.equal(
    metaGet("install_retired"),
    current === "install-a" ? "1" : null,
    `only install-a may carry the flag (current: ${current})`,
  );
});

test("a 410 still surfaces when the flag cannot be written", async () => {
  phone("install-a");
  respond = async () => {
    // A wipe has dropped app_meta while the request was in flight.
    fixture.exec("DROP TABLE app_meta");
    return reply(410, { error: CHECKIN_GONE })();
  };
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    const err = await rejection(api.checkIn(checkInPayload("install-a")));
    assert.ok(err instanceof auth.InstallRetiredError, "the failed write is not the error");
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
});

// A 410 that did not come from our API (a proxy, a captive portal, a parked
// domain after a backend-URL move) must not leave the reset notice up forever.
test("a successful check-in clears install_retired for the same install", async () => {
  phone("install-a");
  respond = reply(410, { error: CHECKIN_GONE });
  await rejection(api.checkIn(checkInPayload("install-a")));
  assert.equal(metaGet("install_retired"), "1", "set");
  respond = reply(200, checkInOk);
  const resp = await api.checkIn(checkInPayload("install-a"));
  assert.equal(resp.server_time, checkInOk.server_time, "the reply still reaches the caller");
  assert.equal(metaGet("install_retired"), null, "cleared by the accepted check-in");
});

test("a successful sign-in clears install_retired for the same install", async () => {
  for (const provider of ["google", "apple"] as const) {
    phone("install-a");
    secure.clear();
    respond = reply(410, { error: AUTH_GONE });
    await rejection(signIn(provider));
    assert.equal(metaGet("install_retired"), "1", `${provider}: set`);
    respond = reply(200, signInOk);
    await signIn(provider);
    assert.equal(secure.get(SESSION_KEY), signInOk.session_jwt, `${provider}: signed in`);
    assert.equal(metaGet("install_retired"), null, `${provider}: cleared by the session`);
  }
});

test("a success for an install id a reset has replaced clears nothing", async () => {
  // The request went out for install-a; meanwhile a reset minted install-b and
  // a 410 for install-b was recorded. install-a's success says nothing about b.
  const resetAndRetireB = (answer: () => Promise<Response>) => async () => {
    phone("install-b");
    metaSet("install_retired", "1");
    return answer();
  };
  phone("install-a");
  respond = resetAndRetireB(reply(200, checkInOk));
  await api.checkIn(checkInPayload("install-a"));
  assert.equal(metaGet("install_retired"), "1", "check-in: install-b keeps its 410");
  phone("install-a");
  secure.clear();
  respond = resetAndRetireB(reply(200, signInOk));
  await signIn("google");
  assert.equal(metaGet("install_retired"), "1", "sign-in: install-b keeps its 410");
});

test("the id check and the clear cannot be split by a reset", async () => {
  phone("install-a");
  metaSet("install_retired", "1");
  // A reset (fresh app_meta, fresh id, its own 410) lands right after any
  // separate read.
  afterMetaRead = () => {
    afterMetaRead = null;
    phone("install-b");
    metaSet("install_retired", "1");
  };
  try {
    await installId.clearInstallRetired("install-a");
  } finally {
    afterMetaRead = null;
  }
  const current = metaGet("install_id");
  assert.equal(
    metaGet("install_retired"),
    current === "install-a" ? null : "1",
    `only install-a's flag may be cleared (current: ${current})`,
  );
});

test("only a real check-in or session reply clears the flag", async () => {
  const flagged = () => {
    phone("install-a");
    secure.clear();
    metaSet("install_retired", "1");
  };
  // A 2xx JSON body without server_time is not our check-in endpoint.
  flagged();
  respond = reply(200, { ok: true });
  await api.checkIn(checkInPayload("install-a"));
  assert.equal(metaGet("install_retired"), "1", "check-in 200 without server_time");
  // A captive portal's page.
  flagged();
  respond = async () => new Response("<html>Wi-Fi login</html>", { status: 200 });
  await rejection(api.checkIn(checkInPayload("install-a")));
  assert.equal(metaGet("install_retired"), "1", "check-in 200 that is not JSON");
  flagged();
  const err = await rejection(signIn("google"));
  assert.ok(err instanceof auth.SignInFailedError);
  assert.equal(err.code, "server 200-badbody");
  assert.equal(metaGet("install_retired"), "1", "sign-in 200 that is not JSON");
  // A 2xx without a session is not an accepted sign-in, whatever happens next.
  flagged();
  respond = reply(200, { user: {} });
  await signIn("apple");
  assert.equal(metaGet("install_retired"), "1", "sign-in 200 without session_jwt");
  // Failures and offline change nothing.
  for (const status of [401, 500, 503]) {
    flagged();
    respond = reply(status, { error: "nope" });
    await rejection(api.checkIn(checkInPayload("install-a")));
    await rejection(signIn("google"));
    assert.equal(metaGet("install_retired"), "1", `${status} clears nothing`);
  }
  flagged();
  respond = async () => {
    throw new TypeError("Network request failed");
  };
  await rejection(api.checkIn(checkInPayload("install-a")));
  assert.equal(metaGet("install_retired"), "1", "offline clears nothing");
});

test("resetRetiredInstall: the local wipe in order, offline, under a fresh id", async () => {
  phone("retired-install");
  metaSet("install_retired", "1");
  metaSet("account_id", "account-x");
  secure.clear();
  secure.set(SESSION_KEY, "session-x");
  secure.set(USER_KEY, '{"email":"x@example.test"}');
  secure.set(CONFIRMATION_KEY, "session-x");
  secure.set(ATTEMPT_KEY, "session-x");
  accountCache = "account-x";
  trace.length = 0;
  fetchCalls.length = 0;
  respond = async () => {
    throw new Error("the reset must not touch the network");
  };
  await auth.resetRetiredInstall();
  const fresh = metaGet("install_id");
  assert.ok(fresh && fresh !== "retired-install", "a FRESH install id was minted");
  assert.deepEqual(trace, [
    "google.signOut",
    "clearDeviceKey",
    "setAccountIdCache:null",
    "resetAllLocalData",
    "setLocalSelfUserIdCache:null",
    "randomUUID",
    `setInstallIdCache:${fresh}`,
    `initDb:${fresh}`,
    `secure.delete:${USER_KEY}`,
    `secure.delete:${SESSION_KEY}`,
    `secure.delete:${CONFIRMATION_KEY}`,
    `secure.delete:${ATTEMPT_KEY}`,
  ]);
  assert.equal(fetchCalls.length, 0, "no request: the server already refuses this install");
  for (const key of [SESSION_KEY, USER_KEY, CONFIRMATION_KEY, ATTEMPT_KEY]) {
    assert.equal(secure.has(key), false, `${key} is gone`);
  }
  assert.equal(accountCache, null);
  assert.equal(metaGet("install_retired"), null, "the fresh install is not retired");
});

test("resetRetiredInstall waits for session-guarded work already running", async () => {
  phone("retired-install");
  secure.clear();
  secure.set(SESSION_KEY, "session-y");
  accountCache = "account-y";
  const snapshot = await auth.captureCurrentSession();
  const entered = deferred();
  const release = deferred();
  const working = auth.applyForCurrentSession(snapshot, async () => {
    entered.resolve();
    await release.promise;
    trace.push("guarded work done");
  });
  await entered.promise;
  trace.length = 0;
  try {
    const resetting = auth.resetRetiredInstall();
    await settle();
    // A copy: asserting on `trace` itself would narrow it to never[] below.
    assert.deepEqual([...trace], [], "nothing is erased while guarded work is still running");
    release.resolve();
    await working;
    await resetting;
    assert.equal(trace[0], "guarded work done");
    assert.ok(trace.includes("resetAllLocalData"));
  } finally {
    // Never leave the session lock held: every later case would hang on it.
    release.resolve();
  }
});

test("session work queued during the wipe waits for it, then is refused", async () => {
  phone("retired-install");
  secure.clear();
  secure.set(SESSION_KEY, "session-z");
  accountCache = "account-z";
  const before = await auth.captureCurrentSession();
  const gate = deferred();
  const started = deferred();
  resetGate = gate.promise;
  onResetStarted = started.resolve;
  try {
    const resetting = auth.resetRetiredInstall();
    await started.promise;
    let ran = false;
    let settled = false;
    const late = auth.applyForCurrentSession(before, async () => {
      ran = true;
    });
    late.then(
      () => (settled = true),
      () => (settled = true),
    );
    await settle();
    assert.equal(settled, false, "queued behind the wipe, not run beside it");
    gate.resolve();
    await resetting;
    await assert.rejects(late, auth.SessionChangedError);
    assert.equal(ran, false, "a pre-reset snapshot can never write into the fresh install");
  } finally {
    // Never leave the wipe parked: it holds the session lock.
    gate.resolve();
    resetGate = null;
    onResetStarted = null;
  }
});

test("resetRetiredInstall bumps the binding version (no ABA reuse)", async () => {
  phone("retired-install");
  secure.clear();
  secure.set(SESSION_KEY, "session-w");
  accountCache = "account-w";
  const before = await auth.captureCurrentSession();
  await auth.resetRetiredInstall();
  // The same JWT and account id come back: only the generation tells them apart.
  secure.set(SESSION_KEY, "session-w");
  accountCache = "account-w";
  let ran = false;
  await assert.rejects(
    auth.applyForCurrentSession(before, async () => {
      ran = true;
    }),
    auth.SessionChangedError,
  );
  assert.equal(ran, false);
});

test("resetRetiredInstall keeps the Apple name stash, written into the fresh db", async () => {
  phone("retired-install");
  const stash = JSON.stringify({ sub: "apple-sub-1", name: "Ahmad Karimi" });
  metaSet(APPLE_NAME_KEY, stash);
  metaSet("install_retired", "1");
  metaSet("account_id", "account-x");
  secure.clear();
  trace.length = 0;
  await auth.resetRetiredInstall();
  const fresh = metaGet("install_id");
  assert.ok(fresh && fresh !== "retired-install", "a fresh install id");
  assert.equal(metaGet(APPLE_NAME_KEY), stash, "the one-shot Apple name survives verbatim");
  assert.equal(metaGet("account_id"), null, "nothing else in app_meta does");
  assert.equal(metaGet("install_retired"), null);
  const written = trace.indexOf(`meta.set:${APPLE_NAME_KEY}`);
  assert.ok(written > trace.indexOf(`initDb:${fresh}`), "re-written after the db is rebuilt");
  assert.equal(trace.lastIndexOf(`meta.set:${APPLE_NAME_KEY}`), written, "exactly once");
  // A spent (empty) stash is not resurrected.
  phone("retired-install");
  metaSet(APPLE_NAME_KEY, "");
  trace.length = 0;
  await auth.resetRetiredInstall();
  assert.equal(metaGet(APPLE_NAME_KEY), null);
  assert.ok(!trace.includes(`meta.set:${APPLE_NAME_KEY}`));
});

test("Apple's one-time name survives a 410 and the reset into the next sign-in", async () => {
  phone("retired-install");
  secure.clear();
  try {
    // First authorization of this Apple ID: the only time Apple sends the name.
    appleCredential = {
      identityToken: "apple.id.token",
      fullName: { givenName: "Ahmad", familyName: "Karimi" },
      user: "apple-sub-1",
    };
    respond = reply(410, { error: AUTH_GONE });
    fetchBodies.length = 0;
    assert.ok((await rejection(signIn("apple"))) instanceof auth.InstallRetiredError);
    assert.equal(fetchBodies[0]?.display_name, "Ahmad Karimi", "sent, and refused");
    await auth.resetRetiredInstall();
    const fresh = metaGet("install_id");
    // Every later authorization of the same Apple ID comes without the name.
    appleCredential = { ...appleCredential, fullName: null };
    respond = reply(200, signInOk);
    fetchBodies.length = 0;
    await signIn("apple");
    assert.deepEqual(fetchBodies[0], {
      install_id: fresh,
      identity_token: "apple.id.token",
      display_name: "Ahmad Karimi",
    });
    assert.equal(metaGet(APPLE_NAME_KEY), "", "delivered, so the stash is spent");
  } finally {
    appleCredential = NAMELESS_APPLE;
  }
});

test("the copy exists in English and in its own Dari", async () => {
  const keys = [
    "account.retired.title",
    "account.retired.body",
    "account.retired.reset",
    "account.retired.confirm.title",
    "account.retired.confirm.body",
    "account.retired.confirm.cta",
    "account.retired.failed",
  ] as const;
  for (const key of keys) {
    const en = i18n.tIn("en", key);
    const fa = i18n.tIn("fa", key);
    assert.ok(en && en !== key, `${key} has English copy`);
    assert.ok(fa && fa !== en, `${key} has its own Dari entry, not the English fallback`);
  }
  // What happened, what still works, and what the reset is for. Never more:
  // the ledger keeps working offline and store updates still arrive, so the
  // notice must not say the phone "needs" a reset or cannot get updates.
  const title = i18n.tIn("en", "account.retired.title");
  const body = i18n.tIn("en", "account.retired.body");
  assert.match(body, /The account this phone last signed in to has been deleted/);
  assert.match(body, /Your kaatas still work on this phone/);
  assert.match(
    body,
    /To sign in or back up again, export anything you need first, then reset this phone/,
  );
  assert.match(body, /erases everything Kaata keeps on it/);
  assert.doesNotMatch(`${title} ${body}`, /needs a reset|update|can't sign in/i);
  const confirm = i18n.tIn("en", "account.retired.confirm.body");
  assert.match(confirm, /erases everything/);
  assert.match(confirm, /cannot be undone/);
  assert.match(confirm, /Export anything you need first/);
  const faTitle = i18n.tIn("fa", "account.retired.title");
  const faBody = i18n.tIn("fa", "account.retired.body");
  assert.match(faBody, /حذف شده/);
  assert.match(faBody, /هنوز کار می‌کنند/);
  assert.match(faBody, /برای ورود یا پشتیبان‌گیری دوباره/);
  assert.match(faBody, /خروجی بگیرید/);
  assert.match(faBody, /پاک می‌کند/);
  // Not "باید" (must), not "به‌روزرسانی" (updates).
  assert.doesNotMatch(`${faTitle} ${faBody}`, /باید|به‌روزرسانی/);
  assert.match(i18n.tIn("fa", "account.retired.confirm.body"), /پاک می‌کند/);
  assert.match(i18n.tIn("fa", "account.retired.confirm.body"), /قابل بازگشت نیست/);
});

test("sign-in screen: a retired install gets its own copy and the reset", async () => {
  for (const provider of ["onboardingMode.google.title", "onboardingMode.apple.title"]) {
    freshScreen();
    nextSignInError = new auth.InstallRetiredError(AUTH_GONE);
    await tap(provider);
    assert.equal(errorText()?.props.children, "account.retired.body");
    assert.ok(
      !render().some((n) => typeof n.props.children === "string" && /410/.test(n.props.children)),
      "no generic '(server 410)'",
    );
    assert.ok(hasResetButton(), "the reset is offered");
    assert.equal(crashReports.length, 0, "a known state is not reported as a crash");
    assert.equal(resetDialog().props.visible, false);
  }
});

test("sign-in screen: only the destructive confirmation erases", async () => {
  freshScreen();
  nextSignInError = new auth.InstallRetiredError(AUTH_GONE);
  await tap("onboardingMode.google.title");
  await tap("account.retired.reset");
  const dialog = resetDialog();
  assert.equal(dialog.props.visible, true);
  assert.equal(dialog.props.destructive, true);
  assert.equal(dialog.props.description, "account.retired.confirm.body");
  assert.equal(dialog.props.confirmLabel, "account.retired.confirm.cta");
  assert.equal(resets, 0, "opening the confirmation erases nothing");
  dialog.props.onCancel();
  assert.equal(resetDialog().props.visible, false);
  assert.equal(resets, 0, "cancel erases nothing");
  await tap("account.retired.reset");
  await resetDialog().props.onConfirm();
  assert.equal(resets, 1);
  assert.deepEqual(routes, ["/onboarding"], "lands where a completed deletion lands");
});

test("sign-in screen: a failed reset stays put and can be retried", async () => {
  freshScreen();
  nextSignInError = new auth.InstallRetiredError(AUTH_GONE);
  resetFails = true;
  await tap("onboardingMode.google.title");
  await tap("account.retired.reset");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await resetDialog().props.onConfirm();
  } finally {
    console.warn = warn;
  }
  assert.equal(resets, 1);
  assert.deepEqual(routes, [], "nothing to navigate to after a failed reset");
  assert.equal(errorText()?.props.children, "account.retired.failed");
  assert.ok(hasResetButton(), "the reset is still offered");
});

test("sign-in screen: other failures keep the coded copy and no reset", async () => {
  freshScreen();
  nextSignInError = new auth.InstallRetiredError(AUTH_GONE);
  await tap("onboardingMode.google.title");
  assert.ok(hasResetButton());
  nextSignInError = new auth.SignInFailedError("server", "unavailable", "503");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await tap("onboardingMode.google.title");
  } finally {
    console.warn = warn;
  }
  assert.equal(errorText()?.props.children, "onboardingMode.signInFailed (server 503)");
  assert.equal(hasResetButton(), false, "a retry that fails differently offers no reset");
  assert.equal(crashReports.length, 1, "real failures are still reported");
});

// The card takes touches while it fades in, and onboarding/auth's "Reset this
// phone" sits near where the dialog's footer appears: the second tap of a
// double tap must not erase the phone.
test("ConfirmDialog: a destructive confirm ignores presses for 350 ms after each open", async () => {
  let confirmed = 0;
  let cancelled = 0;
  const props = (visible: boolean): DialogProps => ({
    visible,
    title: "account.retired.confirm.title",
    confirmLabel: "account.retired.confirm.cta",
    cancelLabel: "common.cancel",
    destructive: true,
    onConfirm: () => confirmed++,
    onCancel: () => cancelled++,
  });
  const press = (label: string) => {
    const button = renderDialog(props(true)).find((n) => n.props.accessibilityLabel === label);
    assert.ok(button, `no button labelled ${label}`);
    button.props.onPress();
  };
  withDialogClock(() => {
    assert.equal(dialogModule.DESTRUCTIVE_ARM_MS, 350);
    renderDialog(props(true));
    press("account.retired.confirm.cta");
    clock += 349;
    press("account.retired.confirm.cta");
    assert.equal(confirmed, 0, "presses inside the first 350 ms are dropped");
    press("common.cancel");
    assert.equal(cancelled, 1, "Cancel answers at once");
    clock += 1;
    press("account.retired.confirm.cta");
    assert.equal(confirmed, 1, "armed at 350 ms");
    // Closed and opened again, much later: the guard re-arms for this open.
    clock += 60_000;
    assert.deepEqual(renderDialog(props(false)), [], "closed");
    renderDialog(props(true));
    press("account.retired.confirm.cta");
    assert.equal(confirmed, 1, "re-armed on the next open");
    clock += 350;
    press("account.retired.confirm.cta");
    assert.equal(confirmed, 2);
    // A clock that jumps backwards must not leave the button dead.
    clock += 60_000;
    renderDialog(props(false));
    renderDialog(props(true));
    clock -= 3_600_000;
    press("account.retired.confirm.cta");
    assert.equal(confirmed, 3, "negative elapsed time arms at once");
  });
});

// A slow second tap can START inside the window and lift after it; the start
// decides. A screen reader's activation has no press-in and uses "now".
test("ConfirmDialog: a destructive press that started inside the window is dropped", async () => {
  let confirmed = 0;
  const props: DialogProps = {
    visible: true,
    title: "account.retired.confirm.title",
    confirmLabel: "account.retired.confirm.cta",
    destructive: true,
    onConfirm: () => confirmed++,
    onCancel: () => {},
  };
  const button = () => {
    const found = renderDialog(props).find(
      (n) => n.props.accessibilityLabel === "account.retired.confirm.cta",
    );
    assert.ok(found, "no confirm button");
    return found;
  };
  withDialogClock(() => {
    renderDialog(props);
    clock += 200;
    const slow = button();
    slow.props.onPressIn();
    clock += 300; // lifted at 500 ms, after the window
    slow.props.onPress();
    assert.equal(confirmed, 0, "a press that started at 200 ms is dropped");
    const fresh = button();
    fresh.props.onPressIn();
    fresh.props.onPress();
    assert.equal(confirmed, 1, "a press that starts after the window confirms");
    button().props.onPress();
    assert.equal(confirmed, 2, "an activation without press-in is judged by now");
  });
});

test("ConfirmDialog: non-destructive actions are unchanged; a destructive third waits", async () => {
  const calls: string[] = [];
  const props = (tertiaryDestructive: boolean): DialogProps => ({
    visible: true,
    title: "account.differentAccount.title",
    confirmLabel: "keep",
    tertiaryLabel: "wipe",
    tertiaryDestructive,
    onConfirm: () => calls.push("keep"),
    onTertiary: () => calls.push("wipe"),
    onCancel: () => calls.push("cancel"),
  });
  const press = (p: DialogProps, label: string) => {
    const button = renderDialog(p).find((n) => n.props.accessibilityLabel === label);
    assert.ok(button, `no button labelled ${label}`);
    button.props.onPress();
  };
  withDialogClock(() => {
    // "Different account on this phone?": Keep is safe, Wipe erases the ledger.
    const guarded = props(true);
    renderDialog(guarded);
    press(guarded, "keep");
    press(guarded, "wipe");
    assert.deepEqual(calls, ["keep"], "Keep answers at once; Wipe waits");
    clock += 350;
    press(guarded, "wipe");
    assert.deepEqual(calls, ["keep", "wipe"]);
  });
  calls.length = 0;
  withDialogClock(() => {
    const plain = props(false);
    renderDialog(plain);
    press(plain, "wipe");
    press(plain, "keep");
    assert.deepEqual(calls, ["wipe", "keep"], "nothing destructive, nothing delayed");
  });
});

async function main() {
  // Fail closed. A case stuck on a promise that can never settle (a session
  // lock left held) empties the event loop and Node exits with whatever code is
  // set at that moment: without this, that silent stop would read as a pass.
  process.exitCode = 1;
  let finished = false;
  process.on("exit", () => {
    if (!finished) console.error("install-retired: a case never finished; treating as failure");
  });
  let failed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${name}\n`, err);
    }
  }
  finished = true;
  console.log(`${cases.length - failed} install-retired regressions passed; ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
