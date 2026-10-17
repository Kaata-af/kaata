// Run from any directory with Node. --check verifies the checked-in fixture
// against the exact Noble implementation installed by the mobile lockfile.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

const require = createRequire(import.meta.url);
const installed = JSON.parse(readFileSync(require.resolve("@noble/ed25519/package.json"))).version;
assert.equal(installed, "2.3.0", "Review native acceptance subset when the verifier changes");
ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));
const fixturePath = fileURLToPath(
  new URL("../android/src/test/resources/ed25519-noble-2.3.0.json", import.meta.url),
);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const message = new TextEncoder().encode("Kaata signature subset: حساب مشترک\u0000");
const order = 2n ** 252n + 27742317777372353535851937790883648493n;
const field = 2n ** 255n - 19n;
const numberLE = (value, size = 32) => {
  const output = new Uint8Array(size);
  for (let i = 0; i < size; i++, value >>= 8n) output[i] = Number(value & 255n);
  return output;
};
const fromLE = (data) => BigInt("0x" + Buffer.from(data).reverse().toString("hex"));
const concat = (...parts) => ed.etc.concatBytes(...parts);
const vectors = [];
function add(name, category, signature, msg, publicKey, requiredNative = null) {
  let noble = false;
  try {
    noble = ed.verify(signature, msg, publicKey);
  } catch {
    // The runtime event-sig verifier also converts malformed inputs to false.
  }
  vectors.push({
    name,
    category,
    messageBase64: b64(msg),
    signatureBase64: b64(signature),
    publicKeyBase64: b64(publicKey),
    noble,
    requiredNative,
  });
}
const seed = sha512(new TextEncoder().encode("kaata-native-subset-fixture")).slice(0, 32);
const publicKey = ed.getPublicKey(seed);
const signature = ed.sign(message, seed);
add("unicode message", "canonical", signature, message, publicKey, true);
for (const length of [0, 1, 2, 31, 255, 4096, 16384]) {
  const msg = Uint8Array.from({ length }, (_, i) => (i * 73 + length) & 255);
  add(`message length ${length}`, "canonical", ed.sign(msg, seed), msg, publicKey, true);
}
for (let i = 0; i < 24; i++) {
  const randomSeed = sha512(new TextEncoder().encode(`random-seed-${i}`)).slice(0, 32);
  const msg = sha512(new TextEncoder().encode(`random-message-${i}`)).slice(0, (i * 11) % 64);
  const key = ed.getPublicKey(randomSeed);
  const sig = ed.sign(msg, randomSeed);
  add(`deterministic random valid ${i}`, "random-valid", sig, msg, key, true);
  add(`tampered message ${i}`, "tampered", sig, concat(msg, Uint8Array.of(99)), key, false);
  const badSig = sig.slice();
  badSig[i % 64] ^= 1;
  add(`tampered signature ${i}`, "tampered", badSig, msg, key, false);
  add(`wrong public key ${i}`, "tampered", sig, msg, publicKey, false);
}
for (const length of [0, 1, 31, 32, 63, 65, 96]) {
  add(`signature length ${length}`, "malformed", new Uint8Array(length), message, publicKey, false);
}
for (const length of [0, 1, 31, 33, 64]) {
  add(
    `public key length ${length}`,
    "malformed",
    signature,
    message,
    new Uint8Array(length),
    false,
  );
}
for (const scalar of [order, order + 1n, 2n ** 255n, 2n ** 256n - 1n]) {
  add(
    `noncanonical scalar ${scalar}`,
    "scalar",
    concat(signature.slice(0, 32), numberLE(scalar)),
    message,
    publicKey,
    false,
  );
}

// Generate all eight torsion points from one order-eight generator. ZIP215's
// cofactored equation accepts zero-S signatures over these small-order A/R
// pairs. The native strict subset must leave them to the original verifier.
const torsionGenerator = ed.Point.fromHex(
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  true,
);
const torsion = Array.from({ length: 8 }, (_, i) => torsionGenerator.multiply(BigInt(i), false));
// Noble 2.3 refuses to serialize identity in Point.toBytes. Encode it directly
// so these edge fixtures also pin that implementation-specific rejection.
const pointBytes = (point) => (point.is0() ? numberLE(1n) : point.toBytes());
assert.equal(new Set(torsion.map((point) => b64(pointBytes(point)))).size, 8);
for (let a = 0; a < 8; a++) {
  for (let r = 0; r < 8; r++) {
    add(
      `torsion A${a} R${r}`,
      "torsion",
      concat(pointBytes(torsion[r]), new Uint8Array(32)),
      message,
      pointBytes(torsion[a]),
      false,
    );
  }
}
for (let y = 0n; y < 19n; y++) {
  for (const signBit of [0, 128]) {
    const noncanonical = numberLE(field + y);
    noncanonical[31] |= signBit;
    add(
      `unreduced A y=p+${y} sign${signBit}`,
      "noncanonical",
      concat(pointBytes(torsion[1]), new Uint8Array(32)),
      message,
      noncanonical,
      false,
    );
    add(
      `unreduced R y=p+${y} sign${signBit}`,
      "noncanonical",
      concat(noncanonical, new Uint8Array(32)),
      message,
      pointBytes(torsion[1]),
      false,
    );
  }
}
for (const canonical of [numberLE(1n), numberLE(field - 1n)]) {
  const negativeZero = canonical.slice();
  negativeZero[31] |= 128;
  add(
    "negative-zero public key " + b64(canonical),
    "sign-zero",
    concat(pointBytes(torsion[1]), new Uint8Array(32)),
    message,
    negativeZero,
    false,
  );
  add(
    "negative-zero R " + b64(canonical),
    "sign-zero",
    concat(negativeZero, new Uint8Array(32)),
    message,
    publicKey,
    false,
  );
}

// Construct genuinely ZIP215-valid mixed-order signatures, rather than only
// random encodings: [8]R+[8]k(A+T)=[8]SB after selecting S=r+k*a mod L.
const extended = ed.utils.getExtendedPublicKey(seed);
const identityR = numberLE(1n);
const zeroNonceChallenge = fromLE(sha512(concat(identityR, publicKey, message))) % order;
add(
  "valid RFC8032 nonce-zero signature",
  "identity-R",
  concat(identityR, numberLE((zeroNonceChallenge * extended.scalar) % order)),
  message,
  publicKey,
  false,
);
const nonce = 928379182739n;
const ordinaryR = ed.Point.BASE.multiply(nonce);
for (let i = 1; i < 8; i++) {
  for (const [name, a, r, native] of [
    ["mixed A", extended.point.add(torsion[i]), ordinaryR, false],
    ["mixed R", extended.point, ordinaryR.add(torsion[i]), null],
    ["mixed A and R", extended.point.add(torsion[i]), ordinaryR.add(torsion[8 - i]), false],
  ]) {
    const aBytes = a.toBytes();
    const rBytes = r.toBytes();
    const challenge = fromLE(sha512(concat(rBytes, aBytes, message))) % order;
    const scalar = (nonce + challenge * extended.scalar) % order;
    const sig = concat(rBytes, numberLE(scalar));
    assert.equal(ed.verify(sig, message, aBytes), true);
    add(`${name} torsion${i}`, "mixed-order", sig, message, aBytes, native);
  }
}

// Text decoding is part of the acceptance surface too. JS atob and the mesh's
// permissive decoder differ; canonical-only native input must not seed cache
// entries for URL alphabet, ignored junk, missing/extra/interior padding.
const canonical = vectors[0];
for (const [name, changed] of [
  ["URL alphabet", canonical.signatureBase64.replaceAll("+", "-").replaceAll("/", "_")],
  ["missing padding", canonical.signatureBase64.replaceAll("=", "")],
  ["extra padding", canonical.signatureBase64 + "="],
  [
    "interior padding",
    canonical.signatureBase64.slice(0, 12) + "=" + canonical.signatureBase64.slice(12),
  ],
  ["space", " " + canonical.signatureBase64],
  ["invalid character", "!" + canonical.signatureBase64.slice(1)],
]) {
  let noble = false;
  try {
    noble = ed.verify(
      Uint8Array.from(atob(changed), (char) => char.charCodeAt(0)),
      message,
      publicKey,
    );
  } catch {}
  vectors.push({
    ...canonical,
    name: "base64 " + name,
    category: "base64",
    signatureBase64: changed,
    noble,
    requiredNative: false,
  });
}
const output = JSON.stringify({ nobleVersion: installed, vectors }, null, 2) + "\n";
if (process.argv.includes("--check")) assert.equal(readFileSync(fixturePath, "utf8"), output);
else writeFileSync(fixturePath, output);
console.log(
  `Noble ${installed}: ${vectors.length} native subset fixtures ${process.argv.includes("--check") ? "verified" : "generated"}.`,
);
