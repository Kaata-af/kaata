import assert from "node:assert/strict";
import { compileUI } from "../../../lib/__dev__/ui-fixture";

async function main() {
  const calls: unknown[][] = [];
  let nativeLoads = 0;
  let result: unknown = { displayName: "kaata (1).backup", uri: "content://provider/document/7" };
  let failure: unknown;
  const platform = { OS: "android" };
  const nativeCall =
    (method: string) =>
    async (...args: string[]) => {
      calls.push([method, ...args]);
      if (failure) throw failure;
      return result;
    };
  const helper = compileUI("../../modules/kaata-save-file/src/index", {
    "react-native": { Platform: platform },
    "expo-modules-core": {
      requireNativeModule: (name: string) => {
        nativeLoads++;
        assert.equal(name, "KaataSaveFile");
        return {
          saveToLocation: nativeCall("location"),
          saveToDownloads: nativeCall("downloads"),
          exportFile: nativeCall("export"),
        };
      },
    },
  });
  const args = ["file:///private/backup", "kaata.backup", "application/octet-stream"] as const;
  assert.equal(nativeLoads, 0, "importing does not load native code or open a picker");
  assert.equal(await helper.saveFileToLocation(...args), result);
  assert.deepEqual(calls.pop(), ["location", ...args]);
  await helper.saveFileToPhone(...args);
  assert.deepEqual(calls.pop(), ["downloads", ...args], "existing Downloads save is unchanged");

  result = null;
  assert.equal(
    await helper.saveFileToLocation(...args),
    null,
    "Android cancellation stays cancellation",
  );
  assert.deepEqual(calls.splice(0), [["location", ...args]], "cancellation has no fallback save");
  for (const code of ["E_BUSY", "E_SOURCE", "E_WRITE", "E_NO_VIEW", "E_UNSUPPORTED"]) {
    failure = Object.assign(new Error(code), { code });
    await assert.rejects(helper.saveFileToLocation(...args), (error) => error === failure);
    assert.deepEqual(
      calls.splice(0),
      [["location", ...args]],
      "failure does not silently save elsewhere",
    );
  }
  failure = undefined;

  platform.OS = "ios";
  assert.equal(await helper.saveFileToLocation(...args), null);
  assert.deepEqual(
    calls.pop(),
    ["export", args[0], args[1]],
    "iOS reuses the single-file exporter",
  );
  result = { displayName: "renamed.backup", uri: "file:///provider/renamed.backup" };
  assert.equal(
    await helper.saveFileToLocation(...args),
    result,
    "native filename/URI receipt stays intact",
  );
  assert.deepEqual(calls.pop(), ["export", args[0], args[1]]);
  await helper.saveFileToPhone(...args);
  assert.deepEqual(calls.pop(), ["export", args[0], args[1]]);
  assert.equal(nativeLoads, 1, "native module is reused");

  platform.OS = "web";
  await assert.rejects(helper.saveFileToLocation(...args), { code: "E_UNSUPPORTED" });
  assert.deepEqual(calls, [], "unsupported platforms do not invoke a native operation");
  console.log("save-file selftest passed: routing, cancellation, errors, receipts, existing saves");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
