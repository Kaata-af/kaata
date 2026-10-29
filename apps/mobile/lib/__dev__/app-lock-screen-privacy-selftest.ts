import assert from "node:assert/strict";
import { compileUI, deferred, settleUI, uiHooks } from "./ui-fixture";

function fixture(platform: string) {
  const hooks = uiHooks();
  const calls: string[] = [];
  let imports = 0;
  let prevent: () => Promise<void> = async () => {};
  let iosEnable: () => Promise<void> = async () => {};
  const capture = {
    preventScreenCaptureAsync: async (key: string) => {
      assert.equal(key, "kaata-app-lock");
      calls.push("prevent");
      await prevent();
    },
    allowScreenCaptureAsync: async (key: string) => {
      assert.equal(key, "kaata-app-lock");
      calls.push("allow");
    },
    enableAppSwitcherProtectionAsync: async (blur: number) => {
      assert.equal(blur, 1);
      calls.push("ios-enable");
      await iosEnable();
    },
    disableAppSwitcherProtectionAsync: async () => {
      calls.push("ios-disable");
    },
  };
  const mocks = {
    react: hooks.react,
    "react-native": { Platform: { OS: platform } },
    get "expo-screen-capture"() {
      imports++;
      return capture;
    },
  };
  const api = compileUI("../app-lock-screen-privacy", mocks);
  return {
    api,
    calls,
    hooks,
    get imports() {
      return imports;
    },
    setPrevent(fn: typeof prevent) {
      prevent = fn;
    },
    setIOSEnable(fn: typeof iosEnable) {
      iosEnable = fn;
    },
  };
}

async function main() {
  const android = fixture("android");
  await android.api.setAppLockScreenPrivacy(false);
  assert.equal(android.imports, 0, "Default Off does not load native capture protection");
  const pending = deferred<void>();
  android.setPrevent(() => pending.promise);
  const on = android.api.setAppLockScreenPrivacy(true);
  await settleUI();
  assert.deepEqual(android.calls, ["prevent"]);
  const off = android.api.setAppLockScreenPrivacy(false);
  pending.resolve();
  await Promise.all([on, off]);
  assert.deepEqual(android.calls, ["prevent", "allow"], "Slow enable cannot outlive later disable");

  const ios = fixture("ios");
  await ios.api.setAppLockScreenPrivacy(true);
  await ios.api.setAppLockScreenPrivacy(true);
  assert.deepEqual(
    ios.calls,
    ["ios-enable"],
    "Repeated foreground cannot accumulate iOS observers",
  );
  await ios.api.setAppLockScreenPrivacy(false);
  assert.deepEqual(
    ios.calls,
    ["ios-enable", "ios-disable"],
    "iOS protects previews without blocking unlocked screenshots",
  );
  await ios.api.setAppLockScreenPrivacy(true);
  assert.deepEqual(ios.calls, ["ios-enable", "ios-disable", "ios-enable"]);
  const iosRetry = fixture("ios");
  let iosFailures = 1;
  iosRetry.setIOSEnable(async () => {
    if (iosFailures-- > 0) throw Error("Not ready");
  });
  await assert.rejects(iosRetry.api.setAppLockScreenPrivacy(true));
  await iosRetry.api.setAppLockScreenPrivacy(true);
  await iosRetry.api.setAppLockScreenPrivacy(true);
  assert.deepEqual(
    iosRetry.calls,
    ["ios-enable", "ios-enable"],
    "A failed iOS activation can retry once ready",
  );

  const lifecycle = fixture("android");
  let failures = 1;
  lifecycle.setPrevent(async () => {
    if (failures-- > 0) throw Error("Activity unavailable");
  });
  const render = (state: string) =>
    lifecycle.hooks.render(() => {
      lifecycle.api.useAppLockScreenPrivacy(true, state);
      return { type: "View", props: {} };
    });
  render("background");
  await settleUI();
  assert.deepEqual(lifecycle.calls, ["prevent"]);
  render("active");
  await settleUI();
  assert.deepEqual(
    lifecycle.calls,
    ["prevent", "prevent"],
    "Foreground retries failed native activation",
  );
  render("inactive");
  await settleUI();
  assert.deepEqual(
    lifecycle.calls,
    ["prevent", "prevent"],
    "An interruption never disables protection",
  );
  lifecycle.hooks.unmount();
  await settleUI();
  assert.deepEqual(lifecycle.calls, ["prevent", "prevent", "allow"]);
  console.log(
    "PASS app lock capture privacy: zero default-Off native work, serialized enable/disable, iOS preview-only protection, foreground failure recovery and unmount cleanup",
  );
}
void main();
