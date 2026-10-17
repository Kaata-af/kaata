// Real Ed25519 checks plus deterministic cache-bound regressions; no native
// modules, database, network or user data. Run from apps/mobile:
// npx tsx lib/trust/__dev__/successful-verification-cache-selftest.ts
import assert from "node:assert/strict";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import { createSuccessfulVerificationCache } from "../successful-verification-cache";

ed.etc.sha512Sync = (...parts: Uint8Array[]) => sha512(ed.etc.concatBytes(...parts));
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const fromB64 = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));
const seed = new Uint8Array(32).fill(13);
const otherSeed = new Uint8Array(32).fill(14);
const publicKey = b64(ed.getPublicKey(seed));
const otherPublicKey = b64(ed.getPublicKey(otherSeed));
const message = new TextEncoder().encode('{"event_id":"same-id","role":"viewer"}');
const signature = b64(ed.sign(message, seed));
const otherSignature = b64(ed.sign(message, otherSeed));
let checks = 0;
const verify = createSuccessfulVerificationCache((msg, sig, pub) => {
  checks++;
  try {
    return ed.verify(fromB64(sig), msg, fromB64(pub));
  } catch {
    return false;
  }
});

assert.equal(verify(message, signature, publicKey), true);
assert.equal(verify(new Uint8Array(message), signature, publicKey), true);
assert.equal(checks, 1, "equal byte contents reuse a successful check");
const tampered = new TextEncoder().encode('{"event_id":"same-id","role":"owner"}');
assert.equal(verify(tampered, signature, publicKey), false);
assert.equal(verify(tampered, signature, publicKey), false);
assert.equal(checks, 3, "payload tampering fails and failures are never retained");
assert.equal(verify(message, otherSignature, publicKey), false);
assert.equal(verify(message, signature, otherPublicKey), false);
assert.equal(checks, 5, "signature and public key both enter the cache key");

const mutable = new Uint8Array(message);
assert.equal(verify(mutable, signature, publicKey), true);
mutable[0] ^= 1;
assert.equal(verify(mutable, signature, publicKey), false);
assert.equal(checks, 6, "mutating the same byte-array object cannot reuse its result");

// Distinct non-UTF-8 messages must stay distinct, even though a TextDecoder
// would replace both with the same Unicode replacement character.
for (const byte of [0x80, 0x81]) {
  const binary = Uint8Array.of(byte);
  const sig = b64(ed.sign(binary, seed));
  assert.equal(verify(binary, sig, publicKey), true);
  assert.equal(verify(Uint8Array.of(byte ^ 1), sig, publicKey), false);
}
assert.equal(checks, 10);

// A new envelope with a valid signature is verified normally, then reusable.
const signedTampered = b64(ed.sign(tampered, seed));
assert.equal(verify(tampered, signedTampered, publicKey), true);
assert.equal(verify(tampered, signedTampered, publicKey), true);
assert.equal(checks, 11);

const longBinary = Uint8Array.from({ length: 4097 }, (_, i) => i % 256);
const longSignature = b64(ed.sign(longBinary, seed));
assert.equal(verify(longBinary, longSignature, publicKey), true);
assert.equal(verify(new Uint8Array(longBinary), longSignature, publicKey), true);
longBinary[2048] ^= 1;
assert.equal(verify(longBinary, longSignature, publicKey), false);
assert.equal(checks, 13, "chunked binary encoding preserves every byte and boundary");

function counting(limits: Parameters<typeof createSuccessfulVerificationCache>[1]) {
  const calls: string[] = [];
  return {
    calls,
    verify: createSuccessfulVerificationCache((msg, sig, pub) => {
      calls.push(`${[...msg]}:${sig}:${pub}`);
      return true;
    }, limits),
  };
}
const key = Uint8Array.of(1);
const lru = counting({ maxEntries: 2 });
lru.verify(key, "A", "P");
lru.verify(key, "B", "P");
lru.verify(key, "A", "P"); // refresh A; B must be evicted next
lru.verify(key, "C", "P");
lru.verify(key, "A", "P");
assert.equal(lru.calls.length, 3);
lru.verify(key, "B", "P");
assert.equal(lru.calls.length, 4, "entry cap evicts the least recently used success");

const bytes = counting({ maxEntries: 20, maxKeyBytes: 36 });
// Each exact key below occupies 18 bytes, so two fit regardless of entry cap.
bytes.verify(key, "A", "P");
bytes.verify(key, "B", "P");
bytes.verify(key, "A", "P");
bytes.verify(key, "C", "P");
bytes.verify(key, "A", "P");
assert.equal(bytes.calls.length, 3);
bytes.verify(key, "B", "P");
assert.equal(bytes.calls.length, 4, "total key bytes independently trigger LRU eviction");

const oversized = counting({ maxMessageBytes: 1, maxKeyBytes: 36 });
for (let i = 0; i < 2; i++) oversized.verify(Uint8Array.of(1, 2), "A", "P");
for (let i = 0; i < 2; i++) oversized.verify(key, "A".repeat(30), "P");
assert.equal(oversized.calls.length, 4, "oversized messages and keys bypass the cache");
oversized.verify(key, "A", "P");
oversized.verify(key, "A", "P");
assert.equal(oversized.calls.length, 5, "oversized checks do not disable normal caching");
const prefixBudget = counting({ maxKeyBytes: 12 });
prefixBudget.verify(key, "A", "P");
prefixBudget.verify(key, "A", "P");
assert.equal(prefixBudget.calls.length, 2, "key-storage accounting includes length prefixes");

const binaryKeys = counting({});
binaryKeys.verify(Uint8Array.of(0x80), "a:b", "c");
binaryKeys.verify(Uint8Array.of(0x81), "a:b", "c");
binaryKeys.verify(Uint8Array.of(0x80), "a", "b:c");
binaryKeys.verify(Uint8Array.of(0x80), "a:b", "c");
assert.equal(
  binaryKeys.calls.length,
  3,
  "arbitrary text boundaries and binary inputs cannot collide",
);

for (const limits of [{ maxEntries: 0 }, { maxKeyBytes: 0 }]) {
  const disabled = counting(limits);
  disabled.verify(key, "A", "P");
  disabled.verify(key, "A", "P");
  assert.equal(disabled.calls.length, 2, "zero bounds disable caching");
}
for (const limits of [
  { maxEntries: -1 },
  { maxMessageBytes: NaN },
  { maxKeyBytes: 1.5 },
  { maxEntries: Number.MAX_SAFE_INTEGER + 1 },
]) {
  assert.throws(() => counting(limits), /nonnegative safe integers/);
}
let throws = 0;
const throwing = createSuccessfulVerificationCache(() => {
  throws++;
  throw new Error("verifier error");
});
assert.throws(() => throwing(key, "A", "P"), /verifier error/);
assert.throws(() => throwing(key, "A", "P"), /verifier error/);
assert.equal(throws, 2, "verifier errors propagate and are not cached");
const separatePolicy = createSuccessfulVerificationCache(() => false);
assert.equal(separatePolicy(message, signature, publicKey), false);
assert.equal(verify(message, signature, publicKey), true, "each verifier owns its own cache");

console.log(
  "successful verification cache: real-signature tampering, byte identity and LRU bounds passed",
);
