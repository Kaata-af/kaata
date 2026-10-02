// Exercise the real focus/keyboard/resize hook with native measurement adapters.
// This verifies visibility arithmetic; OS keyboard animations still need a device.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(require.resolve("../use-onboarding-keyboard-scroll"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const originalRequestFrame = globalThis.requestAnimationFrame;
const originalCancelFrame = globalThis.cancelAnimationFrame;

function fixture(os: "ios" | "android") {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id !== null && id !== undefined) frames.delete(id);
  };
  const listeners = new Map<string, () => void>();
  const cleanups: (() => void)[] = [];
  let keyboard: { screenY: number; height: number } | undefined;
  let viewportHeight = 700;
  let offset = 0;
  const viewportTop = 80; // Includes the safe area and the fixed Back header.
  const formHeight = 700; // Natural form height: fits the unshrunk viewport.
  const scrolls: number[] = [];
  const exports: any = {};
  new Function("require", "exports", source)((name: string) => {
    if (name === "react")
      return {
        useRef: (current: unknown) => ({ current }),
        useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => () => void) => {
          cleanups.push(effect());
        },
      };
    if (name === "react-native")
      return {
        Platform: { OS: os },
        Keyboard: {
          metrics: () => keyboard,
          addListener: (event: string, callback: () => void) => {
            listeners.set(event, callback);
            return { remove: () => listeners.delete(event) };
          },
        },
      };
    throw new Error(`Unexpected import: ${name}`);
  }, exports);
  const hook = exports.useOnboardingKeyboardScroll();
  hook.scrollProps.ref.current = {
    getNativeScrollRef: () => ({
      measureInWindow: (callback: (...coords: number[]) => void) =>
        callback(0, viewportTop, 360, viewportHeight),
    }),
    scrollTo: ({ y }: { y: number }) => {
      // Native scrolling clamps to the content's overflow. The form fits the
      // unshrunk viewport (flexGrow keeps it at least that tall), so only
      // iOS's automatic keyboard inset or a shrunken viewport gives range.
      const inset =
        os === "ios" && keyboard ? Math.max(0, viewportTop + viewportHeight - keyboard.screenY) : 0;
      const clamped = Math.min(y, Math.max(formHeight, viewportHeight) - viewportHeight + inset);
      offset = clamped;
      scrolls.push(clamped);
      hook.scrollProps.onScroll({ nativeEvent: { contentOffset: { y: clamped } } });
    },
  };
  const input = (contentTop: number) => ({
    isFocused: () => true,
    measureInWindow: (callback: (...coords: number[]) => void) =>
      callback(24, viewportTop + contentTop - offset, 250, 44),
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return {
    hook,
    input,
    flush,
    scrolls,
    listeners,
    frames,
    showKeyboard: (screenY: number) => {
      keyboard = { screenY, height: 300 };
      listeners.get("keyboardDidShow")?.();
      flush();
    },
    resize: (height: number) => {
      viewportHeight = height;
      hook.scrollProps.onLayout();
      flush();
    },
    dispose: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

try {
  const ios = fixture("ios");
  assert.equal(ios.hook.scrollProps.automaticallyAdjustKeyboardInsets, true);
  const phone = ios.input(600);
  ios.hook.focusInput(phone);
  ios.flush();
  assert.deepEqual(ios.scrolls, [], "do not move a field that is already visible");
  ios.showKeyboard(480);
  assert.equal(
    ios.scrolls.at(-1),
    268,
    "phone clears keyboard by 24pt including safe-area/header offset",
  );
  ios.hook.focusInput(ios.input(100));
  ios.flush();
  assert.equal(
    ios.scrolls.at(-1),
    68,
    "moving back to the first field keeps its label below the header",
  );
  ios.hook.focusInput(phone);
  ios.flush();
  assert.equal(
    ios.scrolls.at(-1),
    268,
    "Next can reveal phone while the same keyboard remains open",
  );
  const beforeBlur = ios.scrolls.length;
  ios.hook.blurInput(phone);
  ios.showKeyboard(400);
  assert.equal(
    ios.scrolls.length,
    beforeBlur,
    "a picker taking focus must not move its parent form",
  );
  ios.hook.focusInput(phone);
  ios.dispose();
  assert.equal(ios.frames.size, 0);
  assert.equal(ios.listeners.size, 0);

  const android = fixture("android");
  assert.equal(android.hook.scrollProps.automaticallyAdjustKeyboardInsets, false);
  android.hook.focusInput(android.input(600));
  android.flush();
  // Edge-to-edge: the keyboard covers the form but the window keeps its size,
  // so the reveal is clamped and the phone field stays under the keyboard.
  android.showKeyboard(400);
  assert.equal(android.scrolls.at(-1), 0, "without a shrink nothing can scroll on Android");
  android.resize(320); // The Android KeyboardAvoidingView shrinks the viewport.
  assert.equal(android.scrolls.at(-1), 348, "the shrunken viewport reveals the phone field");
  const visibleCount = android.scrolls.length;
  android.resize(320);
  assert.equal(
    android.scrolls.length,
    visibleCount,
    "repeated layout cannot accumulate keyboard spacing",
  );
  android.dispose();

  // Edge-to-edge Android never shrinks the window for the keyboard, so the
  // resize modelled above only exists because each onboarding screen wraps
  // its form in an Android-only KeyboardAvoidingView. Without it the phone
  // field and Continue sit under the keyboard with nothing to scroll.
  for (const screen of ["profile", "kaata"]) {
    const src = readFileSync(require.resolve(`../../app/onboarding/${screen}`), "utf8");
    const avoid = src.indexOf("<KeyboardAvoidingView");
    assert.ok(
      avoid >= 0 &&
        avoid < src.indexOf("<ScrollView") &&
        src.indexOf("</ScrollView>") < src.indexOf("</KeyboardAvoidingView>"),
      `onboarding/${screen}: the form must sit inside a KeyboardAvoidingView`,
    );
    const props = /<KeyboardAvoidingView\b([\s\S]*?)\n\s*>/.exec(src)?.[1] ?? "";
    assert.ok(
      props.includes('behavior="height"') && props.includes('enabled={Platform.OS === "android"}'),
      `onboarding/${screen}: keyboard avoidance must be "height", enabled on Android only (iOS uses scroll insets)`,
    );
  }
  console.log(
    "onboarding-keyboard: focus changes, safe-area offsets, native insets, Android keyboard avoidance, and cleanup passed",
  );
} finally {
  globalThis.requestAnimationFrame = originalRequestFrame;
  globalThis.cancelAnimationFrame = originalCancelFrame;
}
