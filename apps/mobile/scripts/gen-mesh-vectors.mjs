// Generates cross-language parity vectors for the native (Kotlin) mesh engine.
// Run from apps/mobile:  node scripts/gen-mesh-vectors.mjs
// The output is pasted into the Kotlin unit test (MeshCryptoParityTest) so the
// Kotlin port is PROVEN byte-identical to the JS crypto + canonicalization,
// not assumed. Uses the exact @noble libs the app ships.
import { sha512 } from "@noble/hashes/sha512";
import { hkdf } from "@noble/hashes/hkdf";
import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha2";
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

// --- replication planner (copied verbatim from lib/replication/planner.ts) ---
function computeContiguous(seqs) {
  const valid = seqs.filter((s) => Number.isInteger(s) && s >= 1);
  if (valid.length === 0) return { frontier: 0, gaps: [] };
  const sorted = [...new Set(valid)].sort((a, b) => a - b);
  let frontier = 0;
  let i = 0;
  while (i < sorted.length && sorted[i] === frontier + 1) { frontier = sorted[i]; i++; }
  const gaps = [];
  let prev = frontier;
  for (; i < sorted.length; i++) { const s = sorted[i]; if (s > prev + 1) gaps.push({ from_seq: prev + 1, to_seq: s - 1 }); prev = s; }
  return { frontier, gaps };
}
function planRangesToSend(local, peer) {
  const ranges = [];
  for (const device of Object.keys(local).sort()) {
    const have = local[device] ?? 0; const theirs = peer[device] ?? 0;
    if (have > theirs) ranges.push({ device_id: device, from_seq: theirs + 1, to_seq: have });
  }
  return ranges;
}
function splitIntoBatches(ranges, batchSize) {
  const batches = []; let current = []; let currentCount = 0;
  for (const r of ranges) {
    let from = r.from_seq;
    while (from <= r.to_seq) {
      const room = batchSize - currentCount; const take = Math.min(room, r.to_seq - from + 1);
      current.push({ device_id: r.device_id, from_seq: from, to_seq: from + take - 1 });
      currentCount += take; from += take;
      if (currentCount === batchSize) { batches.push(current); current = []; currentCount = 0; }
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
// --- HLC (copied verbatim from lib/hlc.ts) ---
const MAX_FORWARD_DRIFT_MS = 60_000;
function tickReceive(prev, remote, nowMs, deviceId) {
  const last = prev ?? { pms: 0, l: 0, did: deviceId };
  const remotePms = remote.pms - nowMs > MAX_FORWARD_DRIFT_MS ? nowMs : remote.pms;
  const maxPms = Math.max(nowMs, last.pms, remotePms);
  if (maxPms > last.pms && maxPms > remotePms) return { pms: maxPms, l: 0, did: deviceId };
  if (maxPms === last.pms && maxPms === remotePms) return { pms: maxPms, l: Math.max(last.l, remote.l) + 1, did: deviceId };
  if (maxPms === last.pms) return { pms: last.pms, l: last.l + 1, did: deviceId };
  return { pms: remotePms, l: remote.l + 1, did: deviceId };
}
function compareHLC(a, b) {
  if (a.pms !== b.pms) return a.pms - b.pms;
  if (a.l !== b.l) return a.l - b.l;
  if (a.did < b.did) return -1;
  if (a.did > b.did) return 1;
  return 0;
}
const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const hlc = {
  recv_same_ms: tickReceive({ pms: 100, l: 2, did: "d1" }, { pms: 100, l: 5, did: "d2" }, 100, "d1"),
  recv_remote_ahead: tickReceive({ pms: 100, l: 2, did: "d1" }, { pms: 200, l: 0, did: "d2" }, 150, "d1"),
  recv_drift_clamp: tickReceive({ pms: 100, l: 0, did: "d1" }, { pms: 1000000, l: 0, did: "d2" }, 100, "d1"),
  cmp_l: sign(compareHLC({ pms: 100, l: 2, did: "a" }, { pms: 100, l: 3, did: "a" })),
  cmp_did: sign(compareHLC({ pms: 100, l: 2, did: "a" }, { pms: 100, l: 2, did: "b" })),
  cmp_pms: sign(compareHLC({ pms: 200, l: 0, did: "a" }, { pms: 100, l: 9, did: "b" })),
};

const planner = {
  contiguous_135_56: computeContiguous([1, 3, 5, 6]),
  contiguous_23: computeContiguous([2, 3]),
  contiguous_dups: computeContiguous([3, 1, 2, 2]),
  ranges: planRangesToSend({ a: 5, b: 2 }, { a: 3 }),
  batches: splitIntoBatches([{ device_id: "a", from_seq: 1, to_seq: 5 }], 2),
};

// --- PoP v3 transcript (anti-entropy.ts buildPopMessageV3) ---
function buildPopMessageV3(ids, popNonce, ownPub, peerPub) {
  const enc = new TextEncoder();
  const d = enc.encode("kaata-pop-v3");
  const h = sha256(enc.encode([...ids].sort().join("\n")));
  const n = enc.encode(popNonce);
  const out = new Uint8Array(d.length + h.length + n.length + ownPub.length + peerPub.length);
  let off = 0;
  out.set(d, off); off += d.length;
  out.set(h, off); off += h.length;
  out.set(n, off); off += n.length;
  out.set(ownPub, off); off += ownPub.length;
  out.set(peerPub, off);
  return out;
}
const pop = {
  bundle: ["evt-b", "evt-a", "evt-c"],
  popNonce: "nonce123",
  ownPubHex: hex(fill(32, 0x33)),
  peerPubHex: hex(fill(32, 0x44)),
  transcriptHex: hex(buildPopMessageV3(["evt-b", "evt-a", "evt-c"], "nonce123", fill(32, 0x33), fill(32, 0x44))),
};

console.log(
  JSON.stringify(
    {
      pop,
      hlc,
      planner,
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
