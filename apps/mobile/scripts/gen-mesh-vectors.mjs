// Generates cross-language parity vectors for the native (Kotlin) mesh engine.
// Run from apps/mobile:  node scripts/gen-mesh-vectors.mjs
// The output is pasted into the Kotlin unit test (MeshCryptoParityTest) so the
// Kotlin port is PROVEN byte-identical to the JS crypto + canonicalization,
// not assumed. Uses the exact @noble libs the app ships.
import { sha512 } from "@noble/hashes/sha512";
import { hkdf } from "@noble/hashes/hkdf";
import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import * as ed from "@noble/ed25519";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const hex = (b) => Buffer.from(b).toString("hex");
const b64 = (b) => Buffer.from(b).toString("base64");
const b64url = (b) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fill = (n, v) => new Uint8Array(n).fill(v);

// --- canonicalize (copied verbatim from lib/event-sig.ts) ---
function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}
function canonicalizeEvent(e) {
  const ordered = {
    actor_account_id: e.actor_account_id,
    device_id: e.device_id,
    event_id: e.event_id,
    event_type: e.event_type,
    hlc: { did: e.hlc.did, l: e.hlc.l, pms: e.hlc.pms },
    payload: e.payload,
    payload_schema: e.payload_schema,
    relationship_id: e.relationship_id,
    target_id: e.target_id,
    vault_id: e.vault_id,
  };
  return Buffer.from(canonicalize(ordered), "utf8");
}

// --- Ed25519 ---
const edSeed = fill(32, 0); for (let i = 0; i < 32; i++) edSeed[i] = i;
const edPub = ed.getPublicKey(edSeed);
const edMsg = Buffer.from("kaata mesh parity test", "utf8");
const edSig = ed.sign(edMsg, edSeed);

// --- X25519 + HKDF ---
const xPrivA = fill(32, 0x11);
const xPrivB = fill(32, 0x22);
const xPubA = x25519.getPublicKey(xPrivA);
const xPubB = x25519.getPublicKey(xPrivB);
const xShared = x25519.getSharedSecret(xPrivA, xPubB);
const hkInfo = Buffer.from("kaata-mesh-aead-v2", "utf8");
const hkSalt = Buffer.from("parity-salt-1234", "utf8");
const hkOut = hkdf(sha512, xShared, hkSalt, hkInfo, 32);

// --- ChaCha20-Poly1305 IETF ---
const ccKey = fill(32, 0x2a);
const ccNonce = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 5]);
const ccAad = new Uint8Array([0x12, 0x34, 0x00, 0x01, 0x00, 0x00, 0x05]);
const ccPt = Buffer.from("hello", "utf8");
const ccCt = chacha20poly1305(ccKey, ccNonce, ccAad).encrypt(ccPt);

// --- canonicalizeEvent (out-of-order keys, nested, unicode, array) ---
const sampleEvent = {
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
const canonBytes = canonicalizeEvent(sampleEvent);
const canonStr = canonBytes.toString("utf8");
const evtSig = ed.sign(canonBytes, edSeed); // signed by edSeed's device

console.log(
  JSON.stringify(
    {
      ed25519: { seedHex: hex(edSeed), pubB64Std: b64(edPub), msgUtf8: edMsg.toString("utf8"), sigB64Std: b64(edSig) },
      x25519: { privAHex: hex(xPrivA), privBHex: hex(xPrivB), pubAHex: hex(xPubA), pubBHex: hex(xPubB), sharedHex: hex(xShared) },
      hkdf: { saltUtf8: "parity-salt-1234", infoUtf8: "kaata-mesh-aead-v2", outHex: hex(hkOut) },
      chacha: { keyHex: hex(ccKey), nonceHex: hex(ccNonce), aadHex: hex(ccAad), ptUtf8: "hello", ctHex: hex(ccCt) },
      canonicalizeEvent: { canonical: canonStr, canonicalHex: hex(canonBytes), eventSigB64Std: b64(evtSig), signerPubB64Std: b64(edPub) },
    },
    null,
    2,
  ),
);
