// Actual event-sig dispatch and unchanged Noble fallback; synthetic bytes only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import type * as Signatures from "../event-sig";

ed.etc.sha512Sync = (...parts) => sha512(ed.etc.concatBytes(...parts));
const source = readFileSync(require.resolve("../event-sig.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type NativeItem = { messageBase64: string; signatureBase64: string; publicKeyBase64: string };
function fixture(
  options: {
    os?: string;
    missing?: boolean;
    native?: (item: NativeItem) => unknown;
  } = {},
) {
  let nativeResolutions = 0;
  let nobleCalls = 0;
  const exports = {} as typeof Signatures;
  vm.runInNewContext(compiled, {
    exports,
    Uint8Array,
    TextEncoder,
    btoa,
    atob,
    require(name: string) {
      if (name === "@noble/hashes/sha512") return { sha512 };
      if (name === "@noble/ed25519")
        return {
          ...ed,
          verify: (...args: Parameters<typeof ed.verify>) => {
            nobleCalls++;
            return ed.verify(...args);
          },
        };
      if (name === "expo-crypto")
        return {
          getRandomBytes() {
            throw Error("No randomness needed");
          },
        };
      if (name === "react-native") return { Platform: { OS: options.os ?? "android" } };
      if (name === "kaata-bt-classic") {
        nativeResolutions++;
        if (options.missing) throw Error("Optional module unavailable");
        return { verifyEd25519Sync: options.native };
      }
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  return { api: exports, counts: () => ({ nativeResolutions, nobleCalls }) };
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const seed = new Uint8Array(32).fill(7);
const pub = b64(ed.getPublicKey(seed));
const event: Signatures.SignableEvent = {
  event_id: "synthetic-event",
  event_type: "entry_created",
  vault_id: "synthetic-vault",
  target_id: "synthetic-entry",
  relationship_id: "synthetic-customer",
  hlc: { pms: 123456, l: 2, did: "synthetic-device" },
  device_id: "synthetic-device",
  actor_account_id: "synthetic-owner",
  payload: { note: "حساب آزمایشی", amount_minor: 1234 },
  payload_schema: 1,
};
const base = fixture({ os: "ios" });
const bytes = base.api.canonicalizeEvent(event);
const sig = b64(ed.sign(bytes, seed));

// A positive native result receives exactly the canonical bytes, then bypasses
// Noble. Authority and signer lookup remain the caller's responsibility.
let nativeCalls = 0;
const accelerated = fixture({
  native(item) {
    nativeCalls++;
    assert.equal(item.messageBase64, b64(bytes));
    assert.equal(item.signatureBase64, sig);
    assert.equal(item.publicKeyBase64, pub);
    return true;
  },
});
assert.equal(accelerated.api.verifyEventSignature(event, sig, pub).valid, true);
assert.equal(accelerated.api.verifyRawSignature(bytes, sig, pub), true);
assert.equal(nativeCalls, 2);
assert.deepEqual(accelerated.counts(), { nativeResolutions: 1, nobleCalls: 0 });

// Every inconclusive result retains the exact original verifier. A previous
// false/error does not cache a mathematical rejection or skip a later attempt.
for (const native of [
  undefined,
  () => null,
  () => false,
  () => 1,
  () => "true",
  () => {
    throw Error("Unavailable native operation");
  },
]) {
  const f = fixture({ native });
  assert.equal(f.api.verifyEventSignature(event, sig, pub).valid, true);
  assert.equal(f.api.verifyRawSignature(bytes, sig, pub), true);
  const tampered = { ...event, hlc: { ...event.hlc, l: event.hlc.l + 1 } };
  const result = f.api.verifyEventSignature(tampered, sig, pub);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, "bad_signature");
  assert.equal(f.counts().nobleCalls, 3);
}
let attempts = 0;
const retry = fixture({
  native() {
    return ++attempts === 1 ? null : true;
  },
});
assert.equal(retry.api.verifyRawSignature(bytes, sig, pub), true);
assert.equal(retry.api.verifyRawSignature(bytes, sig, pub), true);
assert.equal(attempts, 2);
assert.equal(retry.counts().nobleCalls, 1);

for (const options of [{ os: "ios" }, { os: "web" }, { missing: true }]) {
  const f = fixture({
    ...options,
    native: () => {
      throw Error("Must not be called");
    },
  });
  assert.equal(f.api.verifyRawSignature(bytes, sig, pub), true);
  assert.equal(f.api.verifyEventSignature(event, sig, pub).valid, true);
  assert.equal(f.counts().nativeResolutions, options.missing ? 1 : 0);
  assert.equal(f.counts().nobleCalls, 2);
}

const malformed = fixture({
  native: () => {
    throw Error("No malformed inputs may reach native");
  },
});
for (const [badSig, badPub, expected] of [
  ["%", pub, "malformed_sig"],
  [b64(new Uint8Array(63)), pub, "malformed_sig"],
  [sig, "%", "malformed_pubkey"],
  [sig, b64(new Uint8Array(31)), "malformed_pubkey"],
] as const) {
  const result = malformed.api.verifyEventSignature(event, badSig, badPub);
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.reason, expected);
  assert.equal(malformed.api.verifyRawSignature(bytes, badSig, badPub), false);
}
assert.deepEqual(malformed.counts(), { nativeResolutions: 0, nobleCalls: 0 });

// Skip before resolving or encoding an oversized bridge request. Noble keeps
// accepting legitimate larger messages, including full canonical envelopes.
const oversized = fixture({
  native: () => {
    throw Error("Oversized request reached native");
  },
});
const largeEvent = { ...event, payload: { note: "x".repeat(16 * 1024) } };
const largeBytes = oversized.api.canonicalizeEvent(largeEvent);
const largeSig = b64(ed.sign(largeBytes, seed));
assert.ok(largeBytes.length > 16 * 1024);
assert.equal(oversized.api.verifyEventSignature(largeEvent, largeSig, pub).valid, true);
assert.equal(oversized.api.verifyRawSignature(largeBytes, largeSig, pub), true);
assert.deepEqual(oversized.counts(), { nativeResolutions: 0, nobleCalls: 2 });

// The optional accelerator accepts actual byte arrays only. Noble also accepts
// hex strings at runtime; coercing their characters through btoa would verify
// different bytes. Other array types must retain Noble's original rejection.
const foreignBytes = vm.runInNewContext("new Uint8Array([18])") as Uint8Array;
const byte12Signature = b64(ed.sign(Uint8Array.of(0x12), seed));
const byteOneTwoSignature = b64(ed.sign(Uint8Array.of(1, 2), seed));
for (const [message, signature] of [
  ["12", byte12Signature],
  ["12", byteOneTwoSignature],
  [[1, 2], byteOneTwoSignature],
  [new Uint16Array([1, 2]), byteOneTwoSignature],
  [new DataView(new ArrayBuffer(2)), byteOneTwoSignature],
  [new ArrayBuffer(2), byteOneTwoSignature],
  [null, byteOneTwoSignature],
  [foreignBytes, byte12Signature],
] as const) {
  const runtimeMessage = message as unknown as Uint8Array;
  let expected = false;
  try {
    expected = ed.verify(
      Buffer.from(signature, "base64"),
      runtimeMessage,
      Buffer.from(pub, "base64"),
    );
  } catch {
    /* original verifier rejects this runtime input */
  }
  const f = fixture({ native: () => true });
  assert.equal(f.api.verifyRawSignature(runtimeMessage, signature, pub), expected);
  assert.equal(
    f.counts().nativeResolutions,
    0,
    "nonlocal byte views and nonbytes use original semantics",
  );
  assert.equal(f.counts().nobleCalls, 1);
}
const bufferInput = fixture({ native: () => true });
assert.equal(bufferInput.api.verifyRawSignature(Buffer.from(bytes), sig, pub), true);
assert.deepEqual(bufferInput.counts(), { nativeResolutions: 1, nobleCalls: 0 });

// Noble consumes local byte arrays through Uint8Array.from, rather than indexed
// bytes/length. Native encoding must use that same interpretation and preserve
// one observable iteration even when native declines and Noble takes over.
const oneSignature = b64(ed.sign(Uint8Array.of(1), seed));
const twoSignature = b64(ed.sign(Uint8Array.of(2), seed));
const emptySignature = b64(ed.sign(new Uint8Array(), seed));
function customInput(kind: "iterator" | "length" | "throws" | "stateful") {
  const message = Uint8Array.of(1);
  let calls = 0;
  if (kind === "length") {
    Object.defineProperty(message, "length", { value: 0 });
  } else {
    Object.defineProperty(message, Symbol.iterator, {
      value: function* () {
        calls++;
        if (kind === "throws") throw Error("Synthetic iterator failure");
        yield kind === "stateful" ? calls : 2;
      },
    });
  }
  return { message, calls: () => calls };
}
const nativeMath = (item: NativeItem): true | null =>
  ed.verify(
    new Uint8Array(Buffer.from(item.signatureBase64, "base64")),
    new Uint8Array(Buffer.from(item.messageBase64, "base64")),
    new Uint8Array(Buffer.from(item.publicKeyBase64, "base64")),
  )
    ? true
    : null;
for (const native of [nativeMath, () => null] as const) {
  for (const [kind, signature] of [
    ["iterator", oneSignature],
    ["iterator", twoSignature],
    ["length", emptySignature],
    ["length", oneSignature],
    ["throws", oneSignature],
    ["stateful", oneSignature],
  ] as const) {
    const original = customInput(kind);
    let expected = false;
    try {
      expected = ed.verify(
        new Uint8Array(Buffer.from(signature, "base64")),
        original.message,
        new Uint8Array(Buffer.from(pub, "base64")),
      );
    } catch {
      // The unchanged verifier rejects a throwing iterator.
    }
    const input = customInput(kind);
    const f = fixture({ native });
    assert.equal(f.api.verifyRawSignature(input.message, signature, pub), expected, kind);
    assert.equal(input.calls(), kind === "length" ? 0 : 1, "normalize the original only once");
    assert.equal(f.counts().nativeResolutions, kind === "throws" ? 0 : 1);
    assert.equal(
      f.counts().nobleCalls,
      kind === "throws" || (native === nativeMath && expected) ? 0 : 1,
    );
  }
}

// Compose dispatch with the native subset fixture results, whose actual Kotlin
// implementation is tested separately against this same immutable corpus. This
// checks that both native success and all fallback edges retain Noble policy.
const corpus = JSON.parse(
  readFileSync(
    require.resolve("../../modules/kaata-bt-classic/android/src/test/resources/ed25519-noble-2.3.0.json"),
    "utf8",
  ),
) as {
  nobleVersion: string;
  vectors: (NativeItem & { noble: boolean; requiredNative: boolean; name: string })[];
};
assert.equal(corpus.nobleVersion, "2.3.0");
const fixtureKey = (item: NativeItem) =>
  JSON.stringify([item.messageBase64, item.signatureBase64, item.publicKeyBase64]);
const expectedNative = new Map(
  corpus.vectors.map((item) => [fixtureKey(item), item.requiredNative]),
);
const subset = fixture({
  native: (item) => (expectedNative.get(fixtureKey(item)) === true ? true : null),
});
for (const item of corpus.vectors) {
  const message = new Uint8Array(Buffer.from(item.messageBase64, "base64"));
  assert.equal(
    subset.api.verifyRawSignature(message, item.signatureBase64, item.publicKeyBase64),
    item.noble,
    item.name,
  );
}
console.log(
  `PASS native dispatch, bounds, guards, retries and original fallback; ${corpus.vectors.length} Noble policy fixtures`,
);
