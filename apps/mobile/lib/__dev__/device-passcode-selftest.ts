// Synthetic native boundaries only. No device credentials or Keychain access.
import assert from "node:assert/strict";
import { compileUI, deferred, settleUI } from "./ui-fixture";

function fixture(platform = "ios", native: any = {}) {
  let lookups = 0;
  const index = compileUI("../../modules/kaata-device-auth", {
    "expo-modules-core": {
      requireOptionalNativeModule: (name: string) => {
        assert.equal(name, "KaataDeviceAuth");
        lookups++;
        if (native === "throw") throw new Error("optional native module absent");
        return native;
      },
    },
  });
  const api = compileUI("../device-passcode", {
    "react-native": { Platform: { OS: platform } },
    "../modules/kaata-device-auth": index,
  }) as typeof import("../device-passcode");
  return { api, lookups: () => lookups };
}

async function main() {
  for (const platform of ["android", "web"]) {
    const f = fixture(platform, "throw");
    assert.equal(f.api.supportsDevicePasscode(), false);
    assert.deepEqual(await f.api.authenticateWithDevicePasscode("r", "Unlock", "Cancel"), {
      success: false,
      error: "not_available",
    });
    await f.api.cancelDevicePasscode("r");
    assert.equal(f.lookups(), 0, "Other platforms must not even resolve the iOS module");
  }
  for (const native of [null, "throw", {}, { supportsDevicePasscode: () => true }]) {
    const f = fixture("ios", native);
    assert.equal(f.api.supportsDevicePasscode(), false);
    assert.deepEqual(await f.api.authenticateWithDevicePasscode("r", "Unlock", "Cancel"), {
      success: false,
      error: "not_available",
    });
    await f.api.cancelDevicePasscode("r");
    assert.equal(f.lookups(), 1, "Absent Expo Go/old-build module is resolved only once");
  }

  const replies: ReturnType<typeof deferred<unknown>>[] = [];
  const calls: unknown[][] = [];
  const cancels: string[] = [];
  const module = {
    supportsDevicePasscode: () => true,
    authenticateWithDevicePasscode: (...args: unknown[]) => {
      calls.push(args);
      const response = deferred<unknown>();
      replies.push(response);
      return response.promise;
    },
    cancelDevicePasscode: async (id: string) => {
      cancels.push(id);
    },
  };
  const { api } = fixture("ios", module);
  assert.equal(api.supportsDevicePasscode(), true);
  const first = api.authenticateWithDevicePasscode("request-1", "Open private Kaata", "Cancel");
  assert.equal(
    first,
    api.authenticateWithDevicePasscode("request-1", "Open private Kaata", "Cancel"),
  );
  assert.deepEqual(await api.authenticateWithDevicePasscode("other", "Open", "Cancel"), {
    success: false,
    error: "app_cancel",
  });
  await settleUI();
  assert.deepEqual(calls, [["request-1", "Open private Kaata", "Cancel"]]);
  await api.cancelDevicePasscode("old-request");
  assert.deepEqual(cancels, [], "A stale id cannot cancel a newer prompt");
  replies[0].resolve({ success: true });
  assert.deepEqual(await first, { success: true });

  const second = api.authenticateWithDevicePasscode("request-2", "Open", "Cancel");
  await settleUI();
  await api.cancelDevicePasscode("request-2");
  assert.deepEqual(cancels, ["request-2"]);
  replies[1].resolve({ success: true });
  assert.deepEqual(
    await second,
    { success: false, error: "app_cancel" },
    "Late native success cannot undo cancellation",
  );

  const beforeStarting = calls.length;
  const third = api.authenticateWithDevicePasscode("request-3", "Open", "Cancel");
  await api.cancelDevicePasscode("request-3");
  assert.deepEqual(await third, { success: false, error: "app_cancel" });
  assert.equal(
    calls.length,
    beforeStarting,
    "Cancel before scheduled native entry must not start a prompt",
  );

  const unsafeResults = [
    null,
    undefined,
    true,
    {},
    { success: "true" },
    { success: true, error: "authentication_failed" },
    { success: false, error: "arbitrary native details" },
  ];
  for (const [i, value] of unsafeResults.entries()) {
    const result = api.authenticateWithDevicePasscode(`invalid-result-${i}`, "Open", "Cancel");
    await settleUI();
    replies.at(-1)!.resolve(value);
    assert.deepEqual(await result, { success: false, error: "not_available" });
  }
  for (const error of [
    "user_cancel",
    "system_cancel",
    "authentication_failed",
    "passcode_not_set",
    "lockout",
  ]) {
    const result = api.authenticateWithDevicePasscode(`error-${error}`, "Open", "Cancel");
    await settleUI();
    replies.at(-1)!.resolve({ success: false, error });
    assert.deepEqual(await result, { success: false, error });
  }
  const rejected = api.authenticateWithDevicePasscode("rejected", "Open", "Cancel");
  await settleUI();
  replies.at(-1)!.reject(new Error("synthetic private native detail"));
  assert.deepEqual(await rejected, { success: false, error: "not_available" });
  for (const values of [
    ["", "Open", "Cancel"],
    ["r".repeat(129), "Open", "Cancel"],
    ["r", " ", "Cancel"],
    ["r", "Open", "c".repeat(257)],
  ])
    assert.deepEqual(
      await api.authenticateWithDevicePasscode(...(values as [string, string, string])),
      { success: false, error: "invalid_context" },
    );

  console.log(
    "PASS device passcode wrapper: optional iOS-only route, exact result validation, single-flight prompts, request-scoped cancellation, pre-start and late-success races, native failures and malformed inputs",
  );
}

void main();
