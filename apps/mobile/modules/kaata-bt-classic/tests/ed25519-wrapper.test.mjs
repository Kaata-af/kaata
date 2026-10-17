import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const item = () => ({
  messageBase64: "bWVzc2FnZQ==",
  signatureBase64: "A".repeat(86) + "==",
  publicKeyBase64: "A".repeat(43) + "=",
});
function fixture({ os = "android", native = {}, missing = false } = {}) {
  let resolutions = 0;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === "react-native") return { Platform: { OS: os } };
      if (name === "expo-modules-core")
        return {
          requireNativeModule: () => {
            resolutions++;
            if (missing) throw new Error("Native module absent");
            return native;
          },
        };
      throw new Error("Unexpected dependency " + name);
    },
  });
  return { verify: exports.verifyEd25519BatchAsync, resolutions: () => resolutions };
}

test("iOS and empty/oversized batches never resolve native modules", async () => {
  const ios = fixture({ os: "ios" });
  assert.equal(await ios.verify([item()]), null);
  assert.equal(ios.resolutions(), 0);
  const android = fixture();
  assert.equal(JSON.stringify(await android.verify([])), "[]");
  assert.equal(await android.verify(Array.from({ length: 65 }, item)), null);
  assert.equal(android.resolutions(), 0);
});

test("absent/older native builds and native rejection preserve JS fallback", async () => {
  for (const options of [
    { missing: true },
    { native: {} },
    {
      native: {
        verifyEd25519BatchAsync: async () => {
          throw new Error("bounded request refused");
        },
      },
    },
  ]) {
    assert.equal(await fixture(options).verify([item()]), null);
  }
});

test("invalid request shapes and field types never resolve native", async () => {
  const f = fixture();
  for (const request of [
    null,
    undefined,
    "not an array",
    { length: 1, 0: item() },
    [null],
    [undefined],
    [1],
    new Array(1),
    [{}],
    [{ ...item(), messageBase64: 1 }],
    [{ ...item(), signatureBase64: null }],
    [{ ...item(), publicKeyBase64: undefined }],
  ]) {
    assert.equal(await f.verify(request), null);
  }
  assert.equal(f.resolutions(), 0);
});

test("oversized signature, key, message and aggregate never cross native boundary", async () => {
  let calls = 0;
  const f = fixture({
    native: {
      verifyEd25519BatchAsync: async () => {
        calls++;
        return [];
      },
    },
  });
  for (const request of [
    [{ ...item(), signatureBase64: "A".repeat(89) }],
    [{ ...item(), signatureBase64: "A".repeat(87) }],
    [{ ...item(), publicKeyBase64: "A".repeat(45) }],
    [{ ...item(), publicKeyBase64: "A".repeat(43) }],
    [{ ...item(), messageBase64: "A".repeat(21849) }],
    Array.from({ length: 17 }, () => ({ ...item(), messageBase64: "A".repeat(21848) })),
  ]) {
    assert.equal(await f.verify(request), null);
  }
  assert.equal(f.resolutions(), 0);
  assert.equal(calls, 0);
});

test("only a complete dense boolean response is accepted", async () => {
  for (const response of [
    null,
    false,
    [],
    [true, false],
    [1],
    ["true"],
    [undefined],
    new Array(1),
    { 0: true, length: 1 },
  ]) {
    const f = fixture({ native: { verifyEd25519BatchAsync: async () => response } });
    assert.equal(await f.verify([item()]), null);
  }
});

test("true and false remain positional and response storage is copied", async () => {
  const nativeResults = [true, false];
  const f = fixture({ native: { verifyEd25519BatchAsync: async () => nativeResults } });
  const results = await f.verify([item(), item()]);
  assert.equal(JSON.stringify(results), "[true,false]");
  nativeResults[0] = false;
  assert.equal(results[0], true);
});

test("native receives a snapshot while the request is in flight", async () => {
  let complete;
  let received;
  const f = fixture({
    native: {
      verifyEd25519BatchAsync: (request) => {
        received = request;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    },
  });
  const original = item();
  const list = [original];
  const pending = f.verify(list);
  original.messageBase64 = "different";
  list.push(item());
  assert.equal(received.length, 1);
  assert.equal(received[0].messageBase64, "bWVzc2FnZQ==");
  complete([true]);
  assert.equal(JSON.stringify(await pending), "[true]");
});
