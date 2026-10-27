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
  messageBase64: Buffer.from("message").toString("base64"),
  signatureBase64: Buffer.alloc(64, 3).toString("base64"),
  publicKeyBase64: Buffer.alloc(32, 5).toString("base64"),
});
function fixture({ os = "android", native = {}, missing = false, onResolve } = {}) {
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
            onResolve?.();
            return native;
          },
        };
      throw new Error("Unexpected dependency " + name);
    },
  });
  return { verify: exports.verifyEd25519Sync, resolutions: () => resolutions };
}

test("iOS and web do not resolve native modules", () => {
  for (const os of ["ios", "web"]) {
    const f = fixture({ os, native: { verifyEd25519Sync: () => true } });
    assert.equal(f.verify(item()), null);
    assert.equal(f.resolutions(), 0);
  }
});

test("missing/older native APIs and synchronous errors require original verifier", () => {
  for (const options of [
    { missing: true },
    { native: {} },
    { native: { verifyEd25519BatchAsync: async () => [true] } },
    { native: { verifyEd25519Sync: true } },
    {
      native: {
        verifyEd25519Sync() {
          throw new Error("bounded request refused");
        },
      },
    },
    {
      native: {
        get verifyEd25519Sync() {
          throw new Error("native method unavailable");
        },
      },
    },
  ]) {
    assert.equal(fixture(options).verify(item()), null);
  }
});

test("invalid shapes, field types and throwing getters never resolve native", () => {
  const f = fixture({ native: { verifyEd25519Sync: () => true } });
  for (const request of [
    null,
    undefined,
    false,
    1,
    "not an item",
    [],
    [item()],
    Object.assign([], item()),
    new Array(1),
    {},
    { ...item(), messageBase64: 1 },
    { ...item(), signatureBase64: null },
    { ...item(), publicKeyBase64: undefined },
    {
      ...item(),
      get messageBase64() {
        throw Error("bad getter");
      },
    },
  ]) {
    assert.equal(f.verify(request), null);
  }
  assert.equal(f.resolutions(), 0);
});

test("encoding and exact size bounds are checked before native conversion", () => {
  let calls = 0;
  const f = fixture({
    native: {
      verifyEd25519Sync() {
        calls++;
        return true;
      },
    },
  });
  for (const request of [
    { ...item(), signatureBase64: "A".repeat(87) },
    { ...item(), signatureBase64: "A".repeat(89) },
    { ...item(), signatureBase64: "A".repeat(88) }, // 66 decoded bytes
    { ...item(), publicKeyBase64: "A".repeat(43) },
    { ...item(), publicKeyBase64: "A".repeat(45) },
    { ...item(), publicKeyBase64: "A".repeat(44) }, // 33 decoded bytes
    { ...item(), messageBase64: "A".repeat(21849) },
    ...[16385, 16386].map((n) => ({
      ...item(),
      messageBase64: Buffer.alloc(n).toString("base64"),
    })),
    { ...item(), messageBase64: "bWVzc2FnZQ" }, // unpadded: Noble fallback
    { ...item(), messageBase64: " bWVzc2FnZQ==" },
    { ...item(), messageBase64: "bWVz=c2FnZQ=" },
    { ...item(), messageBase64: "AA-_" },
    { ...item(), messageBase64: "AB==" }, // nonzero unused padding bits
    { ...item(), messageBase64: "AAB=" },
    { ...item(), signatureBase64: item().signatureBase64.slice(0, -3) + "B==" },
    { ...item(), publicKeyBase64: item().publicKeyBase64.slice(0, -2) + "B=" },
  ]) {
    assert.equal(f.verify(request), null);
  }
  assert.equal(f.resolutions(), 0);
  assert.equal(calls, 0);

  for (const n of [0, 1, 2, 3, 16383, 16384]) {
    assert.equal(
      f.verify({ ...item(), messageBase64: Buffer.alloc(n, 255).toString("base64") }),
      true,
    );
  }
  assert.equal(calls, 6);
  assert.equal(f.resolutions(), 1);
});

test("trailing newlines, controls and Unicode never resolve native", () => {
  const f = fixture({ native: { verifyEd25519Sync: () => true } });
  for (const suffix of [
    "\n",
    "\r",
    "\t",
    "\0",
    "\u001f",
    "\u0085",
    "\u00a0",
    "\u2028",
    "\u2029",
    "\u200b",
  ]) {
    const messageBase64 = "AAA" + suffix;
    assert.equal(messageBase64.length, 4);
    assert.equal(f.verify({ ...item(), messageBase64 }), null);
  }
  assert.equal(f.resolutions(), 0);
});

test("only strict native true is accepted, never false or malformed values", () => {
  let thenCalls = 0;
  const thenable = {
    then() {
      thenCalls++;
    },
  };
  for (const result of [
    false,
    null,
    undefined,
    0,
    1,
    "true",
    [],
    [true],
    {},
    new Boolean(true),
    thenable,
    Promise.resolve(true),
  ]) {
    const f = fixture({ native: { verifyEd25519Sync: () => result } });
    assert.equal(f.verify(item()), null);
  }
  assert.equal(thenCalls, 0);
  assert.equal(fixture({ native: { verifyEd25519Sync: () => true } }).verify(item()), true);
});

test("an accidentally async rejecting native API is consumed without accepting it", async () => {
  const f = fixture({
    native: { verifyEd25519Sync: () => Promise.reject(Error("wrong async API")) },
  });
  assert.equal(f.verify(item()), null);
  await new Promise((resolve) => setImmediate(resolve));
});

test("native receives copied strings even if module resolution mutates caller storage", () => {
  const original = item();
  let received;
  const native = {
    verifyEd25519Sync(request) {
      received = request;
      original.messageBase64 = "different";
      request.signatureBase64 = "changed native copy";
      return true;
    },
  };
  const f = fixture({
    native,
    onResolve() {
      original.messageBase64 = "changed at resolution";
    },
  });
  assert.equal(f.verify(original), true);
  assert.notEqual(received, original);
  assert.equal(received.messageBase64, item().messageBase64);
  assert.equal(original.signatureBase64, item().signatureBase64);
});

test("native negatives and errors are never cached as verification results", () => {
  let calls = 0;
  const f = fixture({
    native: {
      verifyEd25519Sync() {
        calls++;
        if (calls === 1) return false;
        if (calls === 2) throw Error("transient native error");
        return true;
      },
    },
  });
  const request = item();
  assert.equal(f.verify(request), null);
  assert.equal(f.verify(request), null);
  assert.equal(f.verify(request), true);
  assert.equal(calls, 3);
});

test("synchronous verification finishes immediately with no added macrotask gap", async () => {
  let nativeFinished = false;
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 0);
  try {
    const f = fixture({
      native: {
        verifyEd25519Sync() {
          nativeFinished = true;
          return true;
        },
      },
    });
    const result = f.verify(item());
    assert.equal(nativeFinished, true);
    assert.equal(result, true);
    assert.equal(await result, true);
    assert.equal(timerRan, false);
  } finally {
    clearTimeout(timer);
  }
});
