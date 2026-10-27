// Execute the diagnostics screen with synthetic reports and composer boundaries.
// No clipboard, phone, messaging app, network, or private database is accessed.
import assert from "node:assert/strict";
import { colors } from "../colors";
import { compileUI, deferred, flattenStyle, jsx, nodes, settleUI, uiHooks } from "./ui-fixture";

const REPORT = "Synthetic full diagnostics report\naccount=fixture\nproof=verified";
const COMPACT = "Kaata diagnostics · fixture · proof verified";
type SmsResult = "opened" | "cancelled" | "unavailable" | "failed";

function fixture(os: "ios" | "android" = "android", isRTL = false) {
  const hooks = uiHooks();
  const calls = {
    reports: 0,
    compact: [] as string[],
    sms: [] as string[],
    smsGuards: [] as (() => boolean)[],
    whatsapp: [] as string[],
    whatsappGuards: [] as (() => boolean)[],
    shares: [] as { message: string }[],
    clipboard: [] as string[],
    toasts: [] as { message: string; kind: string }[],
    warnings: [] as unknown[][],
  };
  const handlers = {
    report: async () => REPORT,
    sms: async (_text: string): Promise<SmsResult> => "opened",
    whatsapp: async (_text: string): Promise<"app" | "web" | "failed"> => "app",
    clipboard: async (_text: string) => undefined,
  };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const Diagnostics = compileUI(
    "../../app/diagnostics",
    {
      react: hooks.react,
      "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
      "@expo/vector-icons": { Ionicons: "Icon" },
      "expo-application": {
        nativeApplicationVersion: "1.0.0",
        nativeBuildVersion: "123",
      },
      "expo-clipboard": {
        setStringAsync: async (text: string) => {
          calls.clipboard.push(text);
          await handlers.clipboard(text);
        },
      },
      "expo-constants": { default: { expoConfig: { version: "1.0.0" } } },
      "expo-router": { useRouter: () => ({ back: () => undefined }) },
      "react-native": {
        Platform: { OS: os },
        Pressable: "Pressable",
        ScrollView: "ScrollView",
        Text: "Text",
        View: "View",
        DevSettings: {
          reload: () => assert.fail("A production diagnostics action cannot reset data"),
        },
        Share: {
          share: async (payload: { message: string }) => {
            calls.shares.push(payload);
            return { action: "dismissedAction" };
          },
        },
        StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
      },
      "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
      "../components/SettingsScreen": { ScreenHeader: "ScreenHeader" },
      "../components/Toast": {
        useToast: () => ({
          push: (message: string, kind: string) => calls.toasts.push({ message, kind }),
        }),
      },
      "../lib/direction": {
        useIsRTL: () => isRTL,
        trackingSafe: () => ({}),
        textDir: () => ({}),
      },
      "../lib/mobile-copy": { tExtra: (key: string) => key },
      "../lib/i18n": { t: (key: string) => key },
      "../lib/colors": { colors },
      "../lib/fonts": {
        fonts: {},
        monoLineHeight: (_size: number, height: number) => height,
        sansLineHeight: (_size: number, height: number) => height,
      },
      "../lib/tokens": { radius: { sm: 8 }, TOUCH_MIN: 44 },
      "../lib/db": { resetAllLocalData: () => assert.fail("No reset during support handoff") },
      "../lib/diagnostics-report": {
        buildDiagnosticsReport: async () => {
          calls.reports++;
          return handlers.report();
        },
      },
      "../lib/diagnostics-sms": {
        compactDiagnosticsForSms: (report: string) => {
          calls.compact.push(report);
          return COMPACT;
        },
      },
      "../lib/support": {
        openSupportSms: async (text: string, canOpen: () => boolean = () => true) => {
          calls.sms.push(text);
          calls.smsGuards.push(canOpen);
          return handlers.sms(text);
        },
        openSupportWhatsApp: async (text: string, canOpen: () => boolean = () => true) => {
          calls.whatsapp.push(text);
          calls.whatsappGuards.push(canOpen);
          return handlers.whatsapp(text);
        },
      },
      "../modules/kaata-gatt-server": {
        getLastExitReasons: () => [],
        getMemorySnapshot: () => ({}),
      },
    },
    {
      __DEV__: false,
      console: { ...console, warn: (...args: unknown[]) => calls.warnings.push(args) },
      setTimeout: (callback: () => void) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ).default;
  const render = () => hooks.render(Diagnostics);
  render();
  return {
    hooks,
    calls,
    handlers,
    timers,
    render,
    all: () => nodes(hooks.tree),
    button: (id: string) => nodes(hooks.tree).find((node) => node.props.testID === id)!,
    async flush() {
      await settleUI();
      render();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
const actionIds = ["diagnostics-copy", "diagnostics-whatsapp", "diagnostics-sms"] as const;
const expectBusy = (f: Fixture, busy: boolean) => {
  for (const id of actionIds) {
    const button = f.button(id);
    assert.ok(button, `${id} remains mounted`);
    assert.equal(button.props.disabled, busy, `${id} shares the report-action lock`);
  }
};
const fallback = (f: Fixture) =>
  f.all().find((node) => node.type === "Text" && node.props.selectable);

async function main() {
  for (const os of ["android", "ios"] as const) {
    const f = fixture(os, os === "ios");
    assert.equal(f.all().find((node) => node.type === "ScreenHeader")!.props.isRTL, os === "ios");
    assert.ok(f.all().some((node) => node.props.children === "diagnostics.smsHint"));
    for (const id of actionIds) {
      assert.ok(flattenStyle(f.button(id).props.style).minHeight >= 44);
    }
    expectBusy(f, false);
    await f.button("diagnostics-copy").props.onPress();
    await f.flush();
    assert.deepEqual(f.calls.clipboard, [REPORT], "Copy preserves the complete diagnostics report");
    assert.deepEqual(f.calls.compact, []);
    f.calls.toasts.length = 0;
    await f.button("diagnostics-whatsapp").props.onPress();
    await f.flush();
    assert.deepEqual(f.calls.whatsapp, [`diagnostics.support.intro\n\n${REPORT}`]);
    assert.deepEqual(f.calls.compact, [], "WhatsApp keeps its complete report");
    await f.button("diagnostics-sms").props.onPress();
    await f.flush();
    assert.deepEqual(f.calls.compact, [REPORT]);
    assert.deepEqual(
      f.calls.sms,
      [COMPACT],
      "SMS receives the compact report, without the long body",
    );
    assert.deepEqual(f.calls.shares, []);
    assert.deepEqual(f.calls.toasts, [], "Opening a composer never claims the message was sent");
    assert.equal(fallback(f), undefined);
    expectBusy(f, false);
    f.hooks.unmount();
  }

  {
    const f = fixture();
    const report = deferred<string>();
    const composer = deferred<SmsResult>();
    f.handlers.report = () => report.promise;
    f.handlers.sms = () => composer.promise;
    const sms = f.button("diagnostics-sms").props.onPress;
    const whatsapp = f.button("diagnostics-whatsapp").props.onPress;
    const copy = f.button("diagnostics-copy").props.onPress;
    const sending = sms();
    sms();
    whatsapp();
    copy();
    f.render();
    expectBusy(f, true);
    assert.equal(f.calls.reports, 1, "Same-frame taps cannot start duplicate report actions");
    assert.deepEqual(f.calls.sms, []);
    report.resolve(REPORT);
    await f.flush();
    assert.deepEqual(f.calls.sms, [COMPACT]);
    expectBusy(f, true);
    whatsapp();
    copy();
    assert.equal(
      f.calls.reports,
      1,
      "The shared lock remains held while the native composer is open",
    );
    composer.resolve("cancelled");
    await sending;
    await f.flush();
    expectBusy(f, false);
    assert.deepEqual(f.calls.toasts, [], "Cancel is neither a delivery claim nor an error");
    assert.deepEqual(f.calls.whatsapp, []);
    assert.deepEqual(f.calls.clipboard, []);
    assert.deepEqual(f.calls.shares, []);
    assert.equal(fallback(f), undefined);
    await copy();
    await f.flush();
    assert.deepEqual(
      f.calls.clipboard,
      [REPORT],
      "A completed action releases the lock for another channel",
    );
    f.hooks.unmount();
  }

  {
    const f = fixture();
    const handoff = deferred<"app" | "web" | "failed">();
    f.handlers.whatsapp = () => handoff.promise;
    const sms = f.button("diagnostics-sms").props.onPress;
    const copy = f.button("diagnostics-copy").props.onPress;
    const sending = f.button("diagnostics-whatsapp").props.onPress();
    await f.flush();
    expectBusy(f, true);
    sms();
    copy();
    assert.equal(f.calls.reports, 1, "An open WhatsApp handoff also blocks SMS and Copy");
    handoff.resolve("failed");
    await sending;
    await f.flush();
    assert.deepEqual(f.calls.shares, [{ message: `diagnostics.support.intro\n\n${REPORT}` }]);
    assert.deepEqual(
      f.calls.sms,
      [],
      "The existing WhatsApp fallback never sends SMS automatically",
    );
    expectBusy(f, false);
    f.hooks.unmount();
  }

  for (const result of ["unavailable", "failed"] as const) {
    const f = fixture();
    f.handlers.sms = async () => result;
    await f.button("diagnostics-sms").props.onPress();
    await f.flush();
    assert.equal(
      fallback(f)!.props.children,
      COMPACT,
      "A failed SMS handoff leaves a selectable compact report",
    );
    assert.deepEqual(f.calls.toasts, [
      {
        message:
          result === "unavailable"
            ? "diagnostics.toast.smsUnavailable"
            : "diagnostics.toast.smsFailed",
        kind: "error",
      },
    ]);
    assert.deepEqual(f.calls.whatsapp, []);
    assert.deepEqual(f.calls.clipboard, []);
    assert.deepEqual(f.calls.shares, [], "SMS failure never silently changes the chosen channel");
    expectBusy(f, false);
    f.calls.toasts.length = 0;
    f.handlers.sms = async () => (result === "unavailable" ? "cancelled" : "opened");
    await f.button("diagnostics-sms").props.onPress();
    await f.flush();
    assert.equal(
      fallback(f),
      undefined,
      "A subsequent successful or cancelled composer clears old fallback text",
    );
    assert.deepEqual(f.calls.toasts, []);
    expectBusy(f, false);
    f.hooks.unmount();
  }

  for (const failure of ["report", "composer"] as const) {
    const f = fixture();
    if (failure === "report")
      f.handlers.report = async () => {
        throw Error("Synthetic report failure");
      };
    else
      f.handlers.sms = async () => {
        throw Error("Synthetic composer failure");
      };
    await f.button("diagnostics-sms").props.onPress();
    await f.flush();
    assert.deepEqual(f.calls.toasts, [{ message: "diagnostics.toast.smsFailed", kind: "error" }]);
    expectBusy(f, false);
    if (failure === "report") {
      assert.deepEqual(f.calls.compact, []);
      assert.deepEqual(f.calls.sms, []);
      assert.equal(
        fallback(f),
        undefined,
        "A missing report cannot be replaced by invented diagnostics",
      );
    } else assert.equal(fallback(f)!.props.children, COMPACT);
    f.handlers.report = async () => REPORT;
    f.handlers.sms = async () => "opened";
    await f.button("diagnostics-sms").props.onPress();
    await f.flush();
    assert.equal(f.calls.sms.at(-1), COMPACT, "Failure releases the action lock for a retry");
    f.hooks.unmount();
  }

  for (const id of actionIds) {
    const f = fixture();
    const report = deferred<string>();
    f.handlers.report = () => report.promise;
    const retainedAction = f.button(id).props.onPress;
    const sending = retainedAction();
    f.hooks.unmount();
    const lateWrites = f.hooks.lateWrites;
    report.resolve(REPORT);
    await sending;
    await settleUI();
    retainedAction();
    await settleUI();
    assert.equal(f.calls.reports, 1, "A retained action cannot restart after unmount");
    assert.deepEqual(f.calls.sms, []);
    assert.deepEqual(f.calls.whatsapp, []);
    assert.deepEqual(f.calls.clipboard, []);
    assert.deepEqual(f.calls.shares, []);
    assert.deepEqual(f.calls.toasts, []);
    assert.equal(f.hooks.lateWrites, lateWrites, "A late report cannot update an unmounted screen");
  }

  for (const channel of ["sms", "whatsapp"] as const) {
    const f = fixture();
    const handoff = deferred<"failed">();
    f.handlers[channel] = () => handoff.promise;
    const sending = f.button(`diagnostics-${channel}`).props.onPress();
    await f.flush();
    const guard = channel === "sms" ? f.calls.smsGuards[0] : f.calls.whatsappGuards[0];
    assert.equal(guard(), true);
    f.hooks.unmount();
    const lateWrites = f.hooks.lateWrites;
    assert.equal(
      guard(),
      false,
      "A pending adapter can check liveness before any later native handoff",
    );
    handoff.resolve("failed");
    await sending;
    await settleUI();
    assert.deepEqual(f.calls.shares, [], "A late WhatsApp failure cannot open another share sheet");
    assert.deepEqual(f.calls.toasts, []);
    assert.equal(
      f.hooks.lateWrites,
      lateWrites,
      "Late native completion cannot publish fallback or busy state",
    );
  }

  {
    const f = fixture();
    await f.button("diagnostics-copy").props.onPress();
    await f.flush();
    const staleTimers = [...f.timers.values()];
    assert.ok(staleTimers.length > 0);
    f.hooks.unmount();
    assert.equal(f.timers.size, 0, "Copy status timers are removed when the screen closes");
    const lateWrites = f.hooks.lateWrites;
    staleTimers.forEach((callback) => callback());
    assert.equal(
      f.hooks.lateWrites,
      lateWrites,
      "Even a retained timer cannot write after cleanup",
    );
  }
  console.log(
    "PASS diagnostics UI: compact addressed SMS, full-report Copy/WhatsApp, shared same-frame busy lock, composer cancellation, unavailable/error fallback, retry and unmount guards",
  );
}

void main();
