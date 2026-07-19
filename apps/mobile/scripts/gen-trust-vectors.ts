// Trust-chain parity vectors for the native (Kotlin) MeshTrust fold.
// Run from apps/mobile:  bun scripts/gen-trust-vectors.ts
//
// Imports the REAL lib/trust/chain.ts fold and runs a signed membership scenario,
// then prints (a) the wire events and (b) the JS fold's resulting state + the
// verifyPeerProof verdicts. MeshTrustParityTest folds the same events in Kotlin
// and asserts identical results — proving the crown-jewel port byte-for-byte.
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import { foldMembership, verifyPeerProof, type MembershipEventLike } from "../lib/trust/chain";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const b64dec = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const seedOf = (v: number) => new Uint8Array(32).fill(v);

// canonicalize / canonicalizeEvent — copied from lib/event-sig.ts (avoids the
// module's expo-crypto import under bun).
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return (
    "{" +
    Object.keys(o)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonicalize(o[k]))
      .join(",") +
    "}"
  );
}
function canonicalizeEvent(e: MembershipEventLike): Uint8Array {
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
  return new TextEncoder().encode(canonicalize(ordered));
}

const crypto = {
  verifyEvent: (e: MembershipEventLike, sig: string, pub: string) =>
    ed.verify(b64dec(sig), canonicalizeEvent(e), b64dec(pub)),
  verifyRaw: (msg: Uint8Array, sig: string, pub: string) =>
    ed.verify(b64dec(sig), msg, b64dec(pub)),
  canonicalize,
};

const anchorSeed = seedOf(0x41);
const anchorPub = b64(ed.getPublicKey(anchorSeed));
const editorSeed = seedOf(0x45);
const editorPub = b64(ed.getPublicKey(editorSeed));
const attackerSeed = seedOf(0x99);
const attackerPub = b64(ed.getPublicKey(attackerSeed));

const VAULT = "vault-t";
let n = 0;
function mk(
  seed: Uint8Array,
  signerPub: string,
  fields: Partial<MembershipEventLike> & {
    event_type: string;
    device_id: string;
    target_id: string;
    payload: unknown;
    pms: number;
  },
): MembershipEventLike {
  const e: MembershipEventLike = {
    event_id: "evt-" + ++n,
    event_type: fields.event_type,
    vault_id: VAULT,
    target_id: fields.target_id,
    relationship_id: null,
    hlc: { pms: fields.pms, l: 0, did: fields.device_id },
    device_id: fields.device_id,
    actor_account_id: null,
    payload: fields.payload,
    payload_schema: 1,
  };
  const sig = b64(ed.sign(canonicalizeEvent(e), seed));
  return { ...e, event_sig_b64: sig, signer_device_pubkey: signerPub };
}

const events: MembershipEventLike[] = [
  mk(anchorSeed, anchorPub, {
    event_type: "vault_member_added",
    device_id: "owner-dev",
    target_id: "acct-owner",
    pms: 1000,
    payload: { account_id: "acct-owner", role: "owner" },
  }),
  mk(anchorSeed, anchorPub, {
    event_type: "vault_member_added",
    device_id: "owner-dev",
    target_id: "acct-editor",
    pms: 1001,
    payload: { account_id: "acct-editor", role: "editor" },
  }),
  mk(anchorSeed, anchorPub, {
    event_type: "vault_device_added",
    device_id: "owner-dev",
    target_id: "editor-dev",
    pms: 1002,
    payload: { account_id: "acct-editor", device_id: "editor-dev", device_pubkey: editorPub },
  }),
  mk(attackerSeed, attackerPub, {
    event_type: "vault_member_added",
    device_id: "bad-dev",
    target_id: "acct-bad",
    pms: 1003,
    payload: { account_id: "acct-bad", role: "editor" },
  }),
];

const state = foldMembership({
  vaultId: VAULT,
  anchorPubkeyB64: anchorPub,
  serverWitnessPubkeysB64: [],
  events,
  crypto,
});

const wire = events.map((e) => ({
  event_id: e.event_id,
  event_type: e.event_type,
  vault_id: e.vault_id,
  target_id: e.target_id,
  relationship_id: e.relationship_id,
  hlc: e.hlc,
  device_id: e.device_id,
  author_seq: 1,
  actor_account_id: e.actor_account_id,
  payload: e.payload,
  schema_version: e.payload_schema,
  event_sig_b64: e.event_sig_b64,
  signer_device_pubkey: e.signer_device_pubkey,
}));

console.log(
  JSON.stringify(
    {
      keys: { anchorPub, editorPub, attackerPub },
      wireEvents: wire,
      foldState: {
        hasGenesis: state.hasGenesis,
        members: [...state.members.values()],
        devices: [...state.devices.values()],
        conflicts: state.conflicts,
      },
      proofEditor: verifyPeerProof({
        vaultId: VAULT,
        anchorPubkeyB64: anchorPub,
        serverWitnessPubkeysB64: [],
        localEvents: events,
        proofEvents: [],
        claimedDevicePubkeyB64: editorPub,
        crypto,
      }),
      proofAttacker: verifyPeerProof({
        vaultId: VAULT,
        anchorPubkeyB64: anchorPub,
        serverWitnessPubkeysB64: [],
        localEvents: events,
        proofEvents: [],
        claimedDevicePubkeyB64: attackerPub,
        crypto,
      }),
    },
    null,
    2,
  ),
);
