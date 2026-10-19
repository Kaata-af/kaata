import { onboardingJSX, onboardingMock } from "./onboarding-fixture";
// Real language/calendar/index screens, existing calendar preference module
// and initial-route contract. Storage/navigation/native UI are synthetic.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickInitialRoute, parseOnboardingStep, type OnboardingStep } from "../onboarding-route";
import { formatCalendarDate } from "../jalali";
import { compileUI, deferred, nodes, settleUI, uiHooks } from "./ui-fixture";

function fixture(
  initialLocale: "en" | "fa" | "ps" = "en",
  storedPref = "auto",
  screenName = "calendar",
  initialMeta: Record<string, string> = {},
) {
  const hooks = uiHooks();
  let locale = initialLocale,
    self: any = initialMeta._self ? { name: "Recovered self" } : null,
    deviceLanguage: string = initialLocale;
  let blocked: { key: string; wait: ReturnType<typeof deferred<void>> } | null = null;
  let failingKey: string | null = null;
  const routes: string[] = [],
    writes: [string, string][] = [];
  const handlers = new Set<() => boolean>();
  const meta = new Map<string, string>([
    ["calendar_pref", storedPref],
    ["onboarding_step", "calendar"],
    ["pending_tab_token", "tab-intent"],
    ["pending_invite_token", "invite-intent"],
    ["pending_pair_deeplink", "kaata://pair/keep"],
    ["onboarding_pending_name", "Kept Name"],
    ...Object.entries(initialMeta),
  ]);
  const db = {
    getLocalSelf: async () => self,
    getAppMeta: async (key: string) => meta.get(key) ?? null,
    setAppMeta: async (key: string, value: string) => {
      writes.push([key, value]);
      if (blocked?.key === key) await blocked.wait.promise;
      if (failingKey === key) throw new Error("Disk unavailable");
      meta.set(key, value);
    },
  };
  const i18n = {
    getLocale: () => locale,
    subscribeLocale: () => () => {},
    t: (key: string) => key,
    setLocale: (value: "en" | "fa" | "ps") => {
      locale = value;
    },
  };
  const calendar = compileUI("../calendar", {
    "./db": db,
    "./i18n": i18n,
    "./jalali": require("../jalali"),
    react: hooks.react,
  });
  // _layout initializes the global preference before any screen mounts.
  calendar.setCalendarPref(calendar.parseCalendarPref(storedPref));
  const native = {
    BackHandler: {
      addEventListener: (_: string, fn: () => boolean) => {
        handlers.add(fn);
        return { remove: () => handlers.delete(fn) };
      },
    },
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Text: "Text",
    View: "View",
    ActivityIndicator: "Spinner",
    StyleSheet: { create: (style: any) => style },
  };
  const screens: any = {};
  const mocks = {
    "react/jsx-runtime": { jsx: onboardingJSX, jsxs: onboardingJSX, Fragment: "Fragment" },
    react: hooks.react,
    "expo-router": {
      Redirect: "Redirect",
      useRouter: () => ({ replace: (route: string) => routes.push(route) }),
      useFocusEffect: (fn: () => any) => hooks.react.useEffect(fn, [fn]),
    },
    "expo-localization": { getLocales: () => [{ languageCode: deviceLanguage }] },
    "react-native": native,
    "../../components/Onboarding": onboardingMock,
    "react-native-safe-area-context": { SafeAreaView: "Safe" },
    "@expo/vector-icons": { Ionicons: "Icon" },
    "../../components/Button": { Button: "Button" },
    "../../lib/calendar": calendar,
    "../../lib/colors": { colors: require("../colors").colors },
    "../../lib/db": db,
    "../../lib/i18n": i18n,
    "../../lib/jalali": { formatCalendarDate },
    "../../lib/direction": {
      useIsRTL: () => locale !== "en",
      rowDir: () => ({}),
      textDir: () => ({}),
      trackingSafe: () => ({}),
    },
    "../../lib/fonts": { fonts: {}, sansLineHeight: (_: number, line: number) => line },
    "../../lib/tokens": { icon: { row: 22 }, radius: { lg: 16 }, TOUCH_MIN: 44, typography: {} },
    "../../lib/onboarding-route": { parseOnboardingStep, pickInitialRoute },
  };
  for (const file of ["language", "calendar", "index"])
    screens[file] = compileUI(`../../app/onboarding/${file}`, mocks).default;
  const render = () => hooks.render(screens[screenName]);
  render();
  return {
    hooks,
    routes,
    writes,
    meta,
    handlers,
    calendar,
    render,
    get locale() {
      return locale;
    },
    get tree() {
      return hooks.tree;
    },
    setDeviceLanguage: (value: string) => {
      deviceLanguage = value;
    },
    setSelf: (value: any) => {
      self = value;
    },
    block: (key: string) => {
      blocked = { key, wait: deferred<void>() };
      return blocked.wait;
    },
    fail: (key: string | null) => {
      failingKey = key;
    },
    radio: (value: string) =>
      nodes(hooks.tree).find(
        (node) =>
          node.props.accessibilityRole === "radio" &&
          node.props.accessibilityLabel === `settings.calendar.option.${value}`,
      )!,
    back: () => nodes(hooks.tree).find((node) => node.props.accessibilityLabel === "common.back")!,
    next: () => nodes(hooks.tree).find((node) => node.type === "Button")!,
    language: (value: "English" | "دری" | "پښتو") =>
      nodes(hooks.tree).find((node) => node.props.accessibilityLabel === value)!,
    mountNextScreen: (name: string) => {
      screenName = name;
      render();
    },
  };
}

async function main() {
  const initial = {
    hasOnboarded: false,
    onboardingStep: null,
    deviceIsPersian: false,
    accountId: null,
    restoreSkipped: false,
  };
  assert.equal(pickInitialRoute(initial), "onboarding/language");
  assert.equal(pickInitialRoute({ ...initial, deviceIsPersian: true }), "onboarding/calendar");
  for (const step of ["language", "calendar", "auth", "profile", "kaata"] as const) {
    assert.equal(parseOnboardingStep(step), step);
    assert.equal(pickInitialRoute({ ...initial, onboardingStep: step }), `onboarding/${step}`);
  }
  assert.equal(parseOnboardingStep("invalid"), null);
  for (const step of [null, "language", "calendar", "auth", "profile", "kaata", "done"] as const) {
    assert.equal(
      pickInitialRoute({ ...initial, hasOnboarded: true, onboardingStep: step }),
      "index",
      "existing ledgers bypass onboarding",
    );
    for (const skipped of [false, true]) {
      const expected =
        !skipped && (step === "auth" || step === "profile")
          ? "onboarding/restore"
          : step === null || step === "done"
            ? "onboarding/language"
            : `onboarding/${step}`;
      assert.equal(
        pickInitialRoute({
          ...initial,
          accountId: "signed-in",
          onboardingStep: step as OnboardingStep,
          restoreSkipped: skipped,
        }),
        expected,
      );
    }
  }
  const layout = readFileSync(require.resolve("../../app/_layout"), "utf8");
  for (const hasOnboarded of [true, false]) {
    for (const restoreSkipped of [true, false]) {
      assert.equal(
        pickInitialRoute({
          ...initial,
          accountId: "account-a",
          hasOnboarded,
          restoreSkipped,
          cancelledDeletionAccountId: "account-a",
        }),
        "onboarding/restore",
        "account-scoped cancellation overrides a partially minted self and prior skip",
      );
      assert.equal(
        pickInitialRoute({
          ...initial,
          accountId: "account-a",
          hasOnboarded,
          restoreSkipped,
          cancelledDeletionAccountId: "account-b",
        }),
        hasOnboarded ? "index" : "onboarding/language",
      );
    }
  }
  assert.match(layout, /getAppMeta\("account_deletion_cancelled"\)/);
  assert.match(layout, /setCancelledDeletionAccountId\(cancelledDeletion\)/);
  assert.match(
    layout,
    /setOnboardingStep\(parseOnboardingStep\(oStep\)\)/,
    "boot accepts calendar resume via the tested parser",
  );
  assert.match(layout, /name="onboarding\/calendar" options=\{\{ gestureEnabled: false \}\}/);
  assert.match(layout, /initialRouteName=\{pickInitialRoute\(/);

  for (const locale of ["en", "fa", "ps"] as const) {
    const f = fixture(locale);
    assert.equal(
      f.radio(locale !== "en" ? "jalali" : "gregorian").props.accessibilityState.checked,
      true,
      "Auto follows the chosen language initially",
    );
    assert.equal(
      nodes(f.tree).filter((node) => node.props.accessibilityRole === "radio").length,
      3,
    );
    assert.equal(f.radio("qamari").props.accessibilityHint, "settings.calendar.hint.qamari");
    assert.ok(
      nodes(f.radio("qamari")).some(
        (node) => node.props.children === "settings.calendar.hint.qamari",
      ),
      "convention is visible even before selecting Qamari",
    );
    f.radio("qamari").props.onPress();
    f.render();
    assert.equal(
      f.calendar.getCalendarPref(),
      "auto",
      "selection does not change dates until Continue",
    );
    assert.equal(f.radio("qamari").props.accessibilityState.checked, true);
    const before = new Map(f.meta);
    f.next().props.onPress();
    f.next().props.onPress();
    await settleUI();
    f.render();
    assert.equal(f.meta.get("calendar_pref"), "qamari");
    assert.equal(f.calendar.getEffectiveCalendar(), "qamari");
    assert.deepEqual(f.routes, ["/onboarding/auth"], "rapid Continue only advances once");
    assert.deepEqual(f.writes, [
      ["calendar_pref", "qamari"],
      ["onboarding_step", "auth"],
    ]);
    for (const [key, value] of before)
      if (!f.writes.some(([changed]) => changed === key))
        assert.equal(f.meta.get(key), value, `${key}: pending context preserved`);
    f.hooks.unmount();
    assert.equal(f.handlers.size, 0);
  }

  const saved = fixture("en", "qamari");
  assert.equal(
    saved.radio("qamari").props.accessibilityState.checked,
    true,
    "reopened date selection respects the explicit preference",
  );
  await saved.calendar.initCalendarFromPref();
  assert.equal(
    saved.calendar.getEffectiveCalendar(),
    "qamari",
    "real stored-preference reader agrees with the selection",
  );
  saved.hooks.unmount();

  const error = fixture();
  error.radio("qamari").props.onPress();
  error.render();
  error.fail("calendar_pref");
  error.next().props.onPress();
  await settleUI();
  error.render();
  assert.deepEqual(error.routes, []);
  assert.equal(error.meta.get("onboarding_step"), "calendar");
  assert.equal(error.calendar.getEffectiveCalendar(), "gregorian");
  assert.ok(nodes(error.tree).some((node) => node.props.children === "entry.saveFailed"));
  error.fail(null);
  error.next().props.onPress();
  await settleUI();
  assert.deepEqual(error.routes, ["/onboarding/auth"], "storage failure remains retryable");
  error.hooks.unmount();

  const blocked = fixture();
  const wait = blocked.block("calendar_pref");
  blocked.next().props.onPress();
  blocked.render();
  assert.equal(blocked.next().props.disabled, true);
  blocked.back().props.onPress();
  [...blocked.handlers][0]();
  assert.equal(blocked.writes.length, 1, "Back and Android Back cannot race Continue");
  blocked.hooks.unmount();
  wait.resolve();
  await settleUI();
  assert.deepEqual(blocked.routes, []);
  assert.equal(blocked.hooks.lateWrites, 0);
  assert.equal(
    blocked.meta.get("onboarding_step"),
    "calendar",
    "late save cannot advance another navigation flow",
  );

  const back = fixture();
  assert.equal([...back.handlers][0](), true);
  await settleUI();
  assert.equal(back.meta.get("onboarding_step"), "language");
  assert.deepEqual(back.routes, ["/onboarding/language"]);
  back.hooks.unmount();
  for (const locale of ["en", "fa", "ps"] as const) {
    const language = fixture("en", "auto", "language");
    language
      .language(locale === "en" ? "English" : locale === "ps" ? "پښتو" : "دری")
      .props.onPress();
    await settleUI();
    assert.equal(language.locale, locale);
    assert.equal(language.meta.get("locale_pref"), locale);
    assert.equal(language.meta.get("onboarding_step"), "calendar");
    assert.deepEqual(language.routes, ["/onboarding/calendar"]);
    language.hooks.unmount();
  }
  const cancelledLanguage = fixture("en", "auto", "language"),
    languageWait = cancelledLanguage.block("locale_pref");
  cancelledLanguage.language("دری").props.onPress();
  cancelledLanguage.hooks.unmount();
  languageWait.resolve();
  await settleUI();
  assert.deepEqual(cancelledLanguage.routes, []);
  assert.equal(cancelledLanguage.hooks.lateWrites, 0);

  for (const [locale, step, account, expected] of [
    ["en", "calendar", "", "/onboarding/calendar"],
    ["fa", "", "", "/onboarding/calendar"],
    ["ps", "", "", "/onboarding/calendar"],
    ["en", "auth", "existing", "/onboarding/restore"],
    ["fa", "kaata", "existing", "/onboarding/kaata"],
  ] as const) {
    const index = fixture(locale, "auto", "index", { onboarding_step: step, account_id: account });
    await settleUI();
    index.render();
    assert.equal(
      nodes(index.tree).find((node) => node.type === "Redirect")?.props.href,
      expected,
      "Home's /onboarding redirect resumes the same boot contract",
    );
    assert.deepEqual(index.writes, []);
    index.hooks.unmount();
  }
  for (const marker of ["account-a", "account-b"]) {
    const index = fixture("en", "auto", "index", {
      _self: "1",
      account_id: "account-a",
      account_deletion_cancelled: marker,
      onboarding_step: "done",
      restore_skipped_for_account_account_a: "1",
    });
    await settleUI();
    index.render();
    assert.equal(
      nodes(index.tree).find((node) => node.type === "Redirect")?.props.href,
      marker === "account-a" ? "/onboarding/restore" : "/",
      "real onboarding index resumes only this account's interrupted cancellation restore",
    );
    index.hooks.unmount();
  }
  console.log(
    "PASS: onboarding dates follow language; three calendars with Qamari hint, persistent explicit preference, Back/Android Back, restore/resume precedence, pending context and storage/unmount guards",
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
