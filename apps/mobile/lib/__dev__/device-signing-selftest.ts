// Run with: npx tsx lib/__dev__/device-signing-selftest.ts
// Public synthetic fixtures only. No database, auth, SecureStore or device I/O.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import * as ed from "@noble/ed25519";
import { ed25519 as curves, x25519 } from "@noble/curves/ed25519";
import { twistedEdwards } from "@noble/curves/abstract/edwards";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import ts from "typescript";
import type { SignableEvent } from "../event-sig";

type Signing = typeof import("../mesh/device-signing");
type Expected = { pub?: string; sig?: string; pubB64?: string; sigB64?: string };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const text = (value: string) => new TextEncoder().encode(value);
const hash = (...parts: Uint8Array[]) => sha512(ed.etc.concatBytes(...parts));
const previousHash = ed.etc.sha512Sync;
ed.etc.sha512Sync = hash;

assert.equal(require("@noble/ed25519/package.json").version, "2.3.0");
const curvesPackage = path.join(path.dirname(require.resolve("@noble/curves/ed25519")), "package.json");
assert.equal(JSON.parse(readFileSync(curvesPackage, "utf8")).version, "1.9.7");

// RFC 8032 section 7.1 TEST 1, 2 and 3, independent known answers:
// https://www.rfc-editor.org/rfc/rfc8032.txt
const rfc = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    message: "",
    pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    message: "72",
    pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    message: "af82",
    pub: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
    sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
  },
];

const signingPath = require.resolve("../mesh/device-signing");
const signingSource = readFileSync(signingPath, "utf8");
const signingCompiled = ts.transpileModule(signingSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// The actual helper against a fresh real curve allows first-call and rare hash
// edges without changing production APIs or warming the default BASE first.
function isolatedSigning(curve: typeof curves): Signing {
  const imports: string[] = [];
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(signingCompiled, {
    exports,
    require(name: string) {
      imports.push(name);
      if (name === "./_crypto-polyfill") return {};
      if (name === "@noble/curves/ed25519") return { ed25519: curve };
      throw Error("Unexpected signing dependency: " + name);
    },
  });
  assert.deepEqual(imports, ["./_crypto-polyfill", "@noble/curves/ed25519"]);
  return exports as Signing;
}

const pointPrototype = Object.getPrototypeOf(curves.Point.BASE) as {
  precompute: typeof curves.Point.BASE.precompute;
};
const originalPrecompute = pointPrototype.precompute;
const configurations: Array<[number, boolean]> = [];
pointPrototype.precompute = function (
  this: typeof curves.Point.BASE,
  windowSize = 8,
  isLazy = true,
) {
  if (this === curves.Point.BASE) configurations.push([windowSize, isLazy]);
  return originalPrecompute.call(this, windowSize, isLazy);
};

async function main(): Promise<void> {
  const signing = require("../mesh/device-signing") as Signing;
  assert.deepEqual(configurations, [[4, true]]);
  // Signing is deliberately the first math call on the default helper.
  assert.equal(hex(signing.signDeviceMessage(bytes(rfc[0].message), bytes(rfc[0].seed))), rfc[0].sig);
  for (const operation of ["derive", "sign"] as const) {
    const fresh = isolatedSigning(twistedEdwards({ ...curves.CURVE }));
    const seed = bytes(rfc[0].seed);
    if (operation === "derive") {
      assert.equal(hex(fresh.deriveDeviceSigningPublicKey(seed)), rfc[0].pub);
    } else {
      assert.equal(hex(fresh.signDeviceMessage(new Uint8Array(), seed)), rfc[0].sig);
    }
  }

  // Use the actual canonicalizer, with Expo's unused random provider inert.
  const eventSigPath = require.resolve("../event-sig");
  const eventRequire = createRequire(eventSigPath);
  const eventJs = ts.transpileModule(readFileSync(eventSigPath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const eventExports: Record<string, unknown> = {};
  vm.runInNewContext(eventJs, {
    exports: eventExports,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    require(name: string) {
      if (name === "@noble/ed25519") return ed;
      if (name === "expo-crypto") return {
        getRandomBytes() {
          throw Error("Signing must not request randomness");
        },
      };
      return eventRequire(name);
    },
  });
  const canonicalizeEvent = eventExports.canonicalizeEvent as (event: SignableEvent) => Uint8Array;
  let comparisons = 0;
  function check(seed: Uint8Array, message: Uint8Array, expected: Expected = {}): void {
    const beforeSeed = hex(seed);
    const beforeMessage = hex(message);
    const oldPublicKey = ed.getPublicKey(seed);
    const publicKey = signing.deriveDeviceSigningPublicKey(seed);
    assert.equal(hex(publicKey), hex(oldPublicKey));
    const oldSignature = ed.sign(message, seed);
    const signature = signing.signDeviceMessage(message, seed);
    assert.equal(hex(signature), hex(oldSignature));
    assert.equal(ed.verify(signature, message, oldPublicKey), true);
    assert.equal(hex(signing.signDeviceMessage(message, seed)), hex(signature));
    assert.equal(hex(seed), beforeSeed, "seed input must remain unchanged");
    assert.equal(hex(message), beforeMessage, "message input must remain unchanged");
    if (expected.pub) assert.equal(hex(publicKey), expected.pub);
    if (expected.sig) assert.equal(hex(signature), expected.sig);
    if (expected.pubB64) assert.equal(b64(publicKey), expected.pubB64);
    if (expected.sigB64) assert.equal(b64(signature), expected.sigB64);
    comparisons++;
  }
  for (const fixture of rfc) check(bytes(fixture.seed), bytes(fixture.message), fixture);
  const ascending = Uint8Array.from({ length: 32 }, (_, i) => i);
  check(ascending, text("kaata mesh parity test"), {
    pubB64: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
    sigB64: "AnnOqOCMYIT9nxLaqPj4LyX7gxGbODKk6YxkBRwljKAAfx8ZXUvgKAh8+uU5UxVfeN+Jv+61cWdM6/f812kSAw==",
  });
  const event: SignableEvent = {
    event_id: "evt-123",
    event_type: "entry_created",
    vault_id: "vault-abc",
    target_id: "tgt-1",
    relationship_id: null,
    hlc: { did: "dev-1", l: 7, pms: 1700000000000 },
    device_id: "dev-1",
    actor_account_id: null,
    payload: { z: 1, amount: 4200, name: "Ahmad héllo", nested: { y: [3, 2, 1], x: true } },
    payload_schema: 1,
  };
  check(ascending, canonicalizeEvent(event), {
    sigB64: "lTxJB43VAaZJpRCl51eovKzsvwJKglRu7jLffcnqTTsiJdBA1K6jZ+jtbU/3oOJUfBHaDlE/H5S7n92BGwcbDg==",
  });
  const unicodeEvent: SignableEvent = {
    ...event,
    event_id: "evt-دری",
    payload: {
      note: "سلام احمد؛ حساب جمع شد 🌄\0\n",
      name: "عبدالله",
      nested: { amount_minor: -123456789, nullable: null, flags: [true, false] },
    },
  };
  const canonical = canonicalizeEvent(unicodeEvent);
  assert.equal(hex(canonicalizeEvent({
    ...unicodeEvent,
    payload: {
      nested: { flags: [true, false], nullable: null, amount_minor: -123456789 },
      name: "عبدالله",
      note: "سلام احمد؛ حساب جمع شد 🌄\0\n",
    },
  })), hex(canonical));
  const messages = [
    new Uint8Array(),
    Uint8Array.of(0),
    Uint8Array.of(255),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    canonical,
    ...[31, 32, 63, 64, 65, 255, 256, 1024, 16384, 65536].map((length) =>
      Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 255)),
  ];
  for (let byte = 0; byte < 256; byte++) {
    check(new Uint8Array(32).fill(byte), messages[byte % messages.length]);
  }
  for (let i = 0; i < 32; i++) {
    const seed = sha256(text(`Kaata PUBLIC parity seed ${i}`));
    for (const message of messages) check(seed, message);
  }
  const seedBacking = new Uint8Array(70).fill(53);
  seedBacking.set(ascending, 13);
  const messageBacking = new Uint8Array(canonical.length + 20).fill(29);
  messageBacking.set(canonical, 9);
  const seedBefore = hex(seedBacking);
  const messageBefore = hex(messageBacking);
  check(seedBacking.subarray(13, 45), canonical);
  check(ascending, messageBacking.subarray(9, 9 + canonical.length));
  assert.equal(hex(seedBacking), seedBefore);
  assert.equal(hex(messageBacking), messageBefore);
  assert.equal(comparisons, 743);

  for (const length of [0, 1, 31, 33, 64]) {
    assert.throws(() => signing.deriveDeviceSigningPublicKey(new Uint8Array(length)));
    assert.throws(() => signing.signDeviceMessage(Uint8Array.of(1), new Uint8Array(length)));
  }
  const publicKey = signing.deriveDeviceSigningPublicKey(ascending);
  publicKey.fill(0);
  assert.equal(b64(signing.deriveDeviceSigningPublicKey(ascending)), "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=");
  const signature = signing.signDeviceMessage(canonical, ascending);
  signature.fill(0);
  assert.equal(hex(signing.signDeviceMessage(canonical, ascending)), hex(ed.sign(canonical, ascending)));
  assert.equal(hex(x25519.getPublicKey(new Uint8Array(32).fill(0x11))),
    "7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13");

  // Both installed implementations reject r=0 mod L and allow k=0/S=0.
  // Inject only the test-local hash into real curve/helper code.
  const order = curves.Point.Fn.ORDER;
  const scalar = curves.utils.getExtendedPublicKey(ascending).scalar;
  const mod = (n: bigint) => ((n % order) + order) % order;
  let a = scalar;
  let b = order;
  let x = 1n;
  let y = 0n;
  while (b) {
    const q = a / b;
    [a, b] = [b, a - q * b];
    [x, y] = [y, x - q * y];
  }
  assert.equal(a, 1n);
  const edges = [
    { r: 0n, k: 1n, throws: true },
    { r: order, k: 1n, throws: true },
    { r: 1n, k: 0n },
    { r: order + 1n, k: 0n },
    { r: 1n, k: mod(-x), zeroS: true },
  ];
  for (const edge of edges) {
    function injectedHash(): (message: Uint8Array | string) => Uint8Array {
      let calls = 0;
      return (message) => {
        calls++;
        if (calls === 1) return sha512(message);
        assert.ok(calls <= 3);
        let n = calls === 2 ? edge.r : edge.k;
        const result = new Uint8Array(64);
        for (let i = 0; i < result.length; i++, n >>= 8n) result[i] = Number(n & 255n);
        return result;
      };
    }
    const oldHash = injectedHash();
    ed.etc.sha512Sync = (...parts) => oldHash(ed.etc.concatBytes(...parts));
    const candidate = isolatedSigning(twistedEdwards({ ...curves.CURVE, hash: injectedHash() }));
    if (edge.throws) {
      assert.throws(() => ed.sign(Uint8Array.of(7), ascending));
      assert.throws(() => candidate.signDeviceMessage(Uint8Array.of(7), ascending));
    } else {
      const oldSignature = ed.sign(Uint8Array.of(7), ascending);
      const newSignature = candidate.signDeviceMessage(Uint8Array.of(7), ascending);
      assert.equal(hex(newSignature), hex(oldSignature));
      if (edge.zeroS) assert.equal(hex(newSignature.subarray(32)), "00".repeat(32));
    }
  }
  ed.etc.sha512Sync = hash;

  let timerRan = false;
  let completed = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 0);
  try {
    const message = Uint8Array.of(1, 2, 3);
    const asyncShapedSign = async () => {
      const result = signing.signDeviceMessage(message, ascending);
      completed = true;
      return result;
    };
    const pending = asyncShapedSign();
    assert.equal(completed, true);
    message.fill(0);
    const result = await pending;
    assert.equal(timerRan, false);
    assert.equal(ed.verify(result, Uint8Array.of(1, 2, 3), ed.getPublicKey(ascending)), true);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(configurations, [[4, true]], "math calls must never reset the default BASE table");
  console.log(
    "743 device-signing parity cases passed; first calls, rare edges, immutability and synchronous timing passed.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    pointPrototype.precompute = originalPrecompute;
    ed.etc.sha512Sync = previousHash;
  });
