import assert from "node:assert/strict";
import { compileUI, flattenStyle, jsx, nodes, uiHooks } from "./ui-fixture";

const hooks = uiHooks();
let state = {
  initialized: false,
  enabled: false,
  locked: true,
  busy: false,
  error: null as string | null,
  capability: "unknown",
  appState: "active" as string | null,
  foregroundVersion: 0,
};
let unlocks = 0;
let passcodeUnlocks = 0;
let explicitPasscode = true;
let retries = 0;
let keyboardDismissals = 0;
let deviceFallback = true;
let settingsOpened = 0;
let backHandler: (() => boolean) | null = null;
const platform = { OS: "android" };
const privacy = () =>
  !state.initialized || state.locked || (state.enabled && state.appState !== "active");
const runtimeJSX = (type: any, props: any) =>
  typeof type === "function" && type.name === "LockScreen" ? type(props) : jsx(type, props);
const { AppLockGate } = compileUI("../../components/AppLockGate", {
  "react/jsx-runtime": { jsx: runtimeJSX, jsxs: runtimeJSX },
  react: hooks.react,
  "@expo/vector-icons": { Ionicons: "Icon" },
  "react-native": {
    View: "View",
    Text: "Text",
    ScrollView: "ScrollView",
    BackHandler: {
      addEventListener: (_event: string, listener: () => boolean) => {
        backHandler = listener;
        return {
          remove: () => {
            backHandler = null;
          },
        };
      },
    },
    Platform: platform,
    Linking: {
      sendIntent: async () => {
        settingsOpened++;
      },
      openSettings: async () => {},
    },
    ActivityIndicator: "Spinner",
    Keyboard: { dismiss: () => keyboardDismissals++ },
    StyleSheet: { create: (value: any) => value, absoluteFillObject: { position: "absolute" } },
  },
  "react-native-screens": { FullWindowOverlay: "FullWindowOverlay" },
  "react-native-safe-area-context": {
    SafeAreaProvider: "SafeAreaProvider",
    initialWindowMetrics: { insets: { top: 30, bottom: 20 } },
    useSafeAreaInsets: () => ({ top: 30, bottom: 20 }),
  },
  "../lib/app-lock": {
    useAppLock: () => state,
    getAppLockSnapshot: () => state,
    unlockApp: async () => {
      unlocks++;
      return false;
    },
    canUseAppLockPasscode: () => platform.OS === "ios" && explicitPasscode,
    unlockAppWithPasscode: async () => {
      passcodeUnlocks++;
      return false;
    },
    initializeAppLock: async () => {
      retries++;
    },
    supportsAppLockDeviceFallback: () => deviceFallback,
  },
  "../lib/app-lock-privacy": {
    useAppLockPrivacy: privacy,
  },
  "../lib/app-lock-screen-privacy": { useAppLockScreenPrivacy: () => {} },
  "../lib/colors": {
    colors: {
      bgDefault: "white",
      bgMuted: "gray",
      textEmphasis: "black",
      textSubtle: "gray",
      danger: "red",
    },
  },
  "../lib/direction": { useIsRTL: () => false, textDir: () => ({ writingDirection: "ltr" }) },
  "../lib/fonts": {
    fonts: { sansSemi: "semi", sansRegular: "regular", sansMedium: "medium" },
    sansLineHeight: (size: number, tight: number) =>
      platform.OS === "ios" ? Math.max(tight, Math.ceil(size * 1.5625)) : tight,
  },
  "../lib/i18n": { t: (key: string) => key },
  "./BalanceCardGlass": { BalanceCardGlass: "BalanceCardGlass" },
  "../lib/tokens": { radius: { lg: 20, pill: 999 } },
  "./Button": { Button: "Button" },
});
const draft = jsx("Draft", { value: "unsaved note" });
const render = () => hooks.render(() => AppLockGate({ children: draft }));
const cover = () => nodes(hooks.tree).find((node) => node.props.testID === "app-lock-cover");
const button = () => nodes(hooks.tree).find((node) => node.type === "Button")!;
const content = () =>
  nodes(hooks.tree).find((node) => node.props.testID === "app-lock-protected-content")!;
const assertHidden = () => {
  assert.equal(flattenStyle(content().props.style).opacity, 0);
  assert.equal(content().props.pointerEvents, "none");
  assert.equal(content().props.accessibilityElementsHidden, true);
  assert.equal(content().props.importantForAccessibility, "no-hide-descendants");
  assert.equal(content().props.children, draft, "The draft/navigation subtree stays mounted");
};

render();
assertHidden();
assert.ok(cover());
assert.equal(cover()!.props.pointerEvents, "auto");
assert.equal(cover()!.props.onStartShouldSetResponder(), true);
assert.equal(backHandler!(), true, "Android Back cannot discard a concealed draft");
cover()!.props.onLayout();
render();
assert.equal(unlocks, 0, "Loading cannot start authentication");

state = { ...state, initialized: true, locked: false };
render();
assert.equal(cover(), undefined);
assert.equal(backHandler, null);
assert.equal(content().props.pointerEvents, "auto");
assert.equal(unlocks, 0, "Default Off never prompts");
state = { ...state, appState: "background" };
render();
assert.equal(privacy(), false, "Off has no background lock");

state = { ...state, enabled: true, locked: true, appState: "active" };
render();
assertHidden();
assert.equal(unlocks, 0, "Wait until the opaque lock cover is laid out");
cover()!.props.onLayout();
render();
assert.equal(unlocks, 1);
state = { ...state, busy: true };
render();
state = { ...state, busy: false, error: "authentication" };
render();
assert.equal(unlocks, 1, "Native failure/cancellation does not create an automatic retry loop");
const staleUnlock = button().props.onPress;
staleUnlock();
render();
assert.equal(unlocks, 2, "Manual retry remains available");

state = { ...state, appState: "inactive", error: null };
render();
assertHidden();
assert.ok(cover(), "Native authentication interruptions retain the opaque cover");
state = { ...state, appState: "active" };
render();
assert.equal(unlocks, 2, "The native prompt's inactive/active cycle cannot reopen it");

state = { ...state, appState: "background" };
render();
state = { ...state, appState: "active", foregroundVersion: 1 };
render();
assert.equal(unlocks, 3, "One new automatic attempt per true background/foreground");

state = { ...state, locked: false };
render();
assert.equal(cover(), undefined);
assert.equal(content().props.children, draft);
staleUnlock();
assert.equal(unlocks, 3, "A queued locked-screen action cannot authenticate an unlocked app");
state = { ...state, appState: "inactive" };
render();
assertHidden();
state = { ...state, appState: "active" };
render();
assert.equal(cover(), undefined);
assert.equal(unlocks, 3, "Brief interruptions cover content without falsely relocking");

state = { ...state, initialized: false, locked: true, error: "storage" };
render();
cover()!.props.onLayout();
render();
assertHidden();
assert.equal(button().props.label, "appLock.retry");
button().props.onPress();
assert.equal(retries, 1);
assert.equal(unlocks, 3, "Unreadable lock preferences have no unauthenticated bypass");

// iOS covers native-stack modal screens directly in UIWindow. There is no
// UIKit lock-modal presentation/dismissal to collide with preserved sheets.
platform.OS = "ios";
state = {
  ...state,
  initialized: true,
  enabled: true,
  locked: true,
  error: null,
  foregroundVersion: 2,
};
render();
cover()!.props.onLayout();
render();
assert.ok(nodes(hooks.tree).some((node) => node.type === "FullWindowOverlay"));
assert.ok(!nodes(hooks.tree).some((node) => node.type === "NativeModal"));
const passcodeButton = () =>
  nodes(hooks.tree).find((node) => node.props.label === "appLock.auth.passcode");
assert.ok(passcodeButton(), "A native iPhone exposes an explicit passcode alternative");
assert.equal(passcodeButton()!.props.wrapLabel, true);
const passcodePress = passcodeButton()!.props.onPress;
passcodePress();
assert.equal(passcodeUnlocks, 1);
state = { ...state, busy: true };
render();
assert.equal(passcodeButton()!.props.disabled, true);
passcodePress();
assert.equal(passcodeUnlocks, 1, "A retained passcode action cannot overlap authentication");
state = { ...state, busy: false };
explicitPasscode = false;
render();
assert.equal(
  passcodeButton(),
  undefined,
  "Expo Go and older binaries do not advertise unavailable native passcode",
);
passcodePress();
assert.equal(passcodeUnlocks, 1, "An unavailable bridge is not replaced by another Face ID prompt");
explicitPasscode = true;
render();
state = { ...state, appState: "inactive" };
render();
assert.ok(cover());
assert.equal(passcodeButton()!.props.disabled, true);
passcodePress();
assert.equal(passcodeUnlocks, 1, "System prompt inactivity cannot start another passcode sheet");
state = { ...state, appState: "background" };
render();
assertHidden();
assert.ok(cover(), "A quick Home/return never dismisses the privacy cover");
state = { ...state, appState: "active", locked: false };
render();
assert.equal(cover(), undefined);
assert.equal(content().props.pointerEvents, "auto");
assert.equal(content().props.children, draft);
passcodePress();
assert.equal(passcodeUnlocks, 1, "A queued passcode action cannot unlock an already unlocked app");

platform.OS = "android";
deviceFallback = false;
state = { ...state, locked: true, error: "lockout", foregroundVersion: 3 };
render();
cover()!.props.onLayout();
render();
assert.equal(passcodeButton(), undefined, "Android keeps its existing native credential fallback");
assert.ok(
  nodes(hooks.tree).some((node) => node.props.children === "settings.appLock.error.legacyLockout"),
);
const recovery = nodes(hooks.tree).find(
  (node) => node.props.label === "appLock.openSecuritySettings",
)!;
recovery.props.onPress();
assert.equal(settingsOpened, 1);
state = { ...state, appState: "background" };
recovery.props.onPress();
assert.equal(
  settingsOpened,
  1,
  "A stale recovery action cannot open system settings in background",
);

const lateShow = cover()!.props.onLayout;
const latePress = button().props.onPress;
hooks.unmount();
lateShow();
latePress();
passcodePress();
assert.equal(retries, 1);
assert.equal(passcodeUnlocks, 1, "Unmounted passcode actions cannot authenticate");
assert.equal(hooks.lateWrites, 0);
assert.ok(keyboardDismissals > 0);

let selectorReads = 0;
const selector = compileUI("../app-lock-privacy", {
  react: { useSyncExternalStore: (_subscribe: any, get: () => boolean) => get() },
  "./app-lock": {
    getAppLockSnapshot: () => {
      selectorReads++;
      return state;
    },
    subscribeAppLock: () => () => {},
  },
});
assert.equal(selector.getAppLockPrivacy(), true);
state = { ...state, initialized: true, enabled: false, locked: false, appState: null };
assert.equal(selector.useAppLockPrivacy(), false);
state = { ...state, enabled: true };
assert.equal(selector.getAppLockPrivacy(), true);
assert.ok(selectorReads > 0);
console.log(
  "PASS app lock gate: fail-closed loading/storage, persistent drafts, hidden input/accessibility, iOS full-window/native-stack coverage, Android Back containment, one automatic attempt, cancellation/manual retry, background/interruption handling and stale/unmount guards",
);
