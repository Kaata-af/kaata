// Selftest for the M2 membership-chain fold — REAL Ed25519, no mocks.
// Run from apps/mobile/:   bun lib/trust/__dev__/chain-selftest.ts
//
// Exercises every security invariant in docs/m2-membership-chain.md §9 that
// is testable without a device. Crypto is injected noble-direct (the same
// library event-sig uses); the canonicalizer here is a byte-identical copy
// pinned by CANONICAL_FIXTURE below — if lib/event-sig.ts's canonicalize
// ever drifts, update BOTH and the backend's fixture together.

import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import {
  deviceWitnessTuple,
  foldMembership,
  memberWitnessTuple,
  verifyPeerProof,
  WITNESS_FRESHNESS_MS,
  type ChainCrypto,
  type MembershipEventLike,
} from "../chain";

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

// ---------- canonicalize (pinned copy of lib/event-sig.ts) ----------
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalize(x)).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// Cross-side drift pin: this exact string must equal what lib/event-sig.ts
// canonicalize() and the backend's Go canonicalizer produce for the same
// tuple. (Backend pins the same fixture in its witness tests.)
const CANONICAL_FIXTURE_TUPLE = deviceWitnessTuple({
  vault_id: "v-1",
  account_id: "a-1",
  device_id: "d-1",
  device_pubkey_b64: "PUB",
  issued_at_ms: 42,
});
const CANONICAL_FIXTURE =
  '{"account_id":"a-1","device_id":"d-1","device_pubkey_b64":"PUB","issued_at_ms":42,"vault_id":"v-1"}';

// ---------- envelope canonicalization (pinned copy of canonicalizeEvent) ----------
function canonicalizeEvent(e: MembershipEventLike): Uint8Array {
  const ordered: Record<string, unknown> = {
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

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

const crypto: ChainCrypto = {
  verifyEvent: (event, sigB64, pubkeyB64) => {
    try {
      return ed.verify(
        Uint8Array.from(Buffer.from(sigB64, "base64")),
        canonicalizeEvent(event),
        Uint8Array.from(Buffer.from(pubkeyB64, "base64")),
      );
    } catch {
      return false;
    }
  },
  verifyRaw: (msg, sigB64, pubkeyB64) => {
    try {
      return ed.verify(
        Uint8Array.from(Buffer.from(sigB64, "base64")),
        msg,
        Uint8Array.from(Buffer.from(pubkeyB64, "base64")),
      );
    } catch {
      return false;
    }
  },
  canonicalize,
};

// ---------- test scaffolding ----------
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

type Keypair = { priv: Uint8Array; pubB64: string };
function keypair(seedByte: number): Keypair {
  const priv = new Uint8Array(32).fill(seedByte);
  return { priv, pubB64: b64(ed.getPublicKey(priv)) };
}

const VAULT = "vault-1";
let hlcCounter = 1000;
let eventCounter = 0;

function makeEvent(args: {
  type: string;
  payload: unknown;
  signer: Keypair;
  deviceId: string;
  account: string | null;
  pms?: number;
  tamper?: (e: MembershipEventLike) => void;
}): MembershipEventLike {
  const e: MembershipEventLike = {
    event_id: `e-${String(++eventCounter).padStart(4, "0")}`,
    event_type: args.type,
    vault_id: VAULT,
    target_id: "t",
    relationship_id: null,
    hlc: { pms: args.pms ?? ++hlcCounter, l: 0, did: args.deviceId },
    device_id: args.deviceId,
    actor_account_id: args.account,
    payload: args.payload,
    payload_schema: 1,
  };
  const sig = ed.sign(canonicalizeEvent(e), args.signer.priv);
  e.event_sig_b64 = b64(sig);
  e.signer_device_pubkey = args.signer.pubB64;
  if (args.tamper) args.tamper(e);
  return e;
}

function witnessSig(serverKey: Keypair, tuple: Record<string, unknown>): string {
  return b64(ed.sign(new TextEncoder().encode(canonicalize(tuple)), serverKey.priv));
}

// Keys: anchor (owner device), staff device, rival device, server, member2 device.
const anchor = keypair(1);
const staffDev = keypair(2);
const rivalDev = keypair(3);
const serverKey = keypair(4);
const member2Dev = keypair(5);

const OWNER = "acct-owner";
const STAFF = "acct-staff";
const MEMBER2 = "acct-member2";

const fold = (events: MembershipEventLike[]) =>
  foldMembership({
    vaultId: VAULT,
    anchorPubkeyB64: anchor.pubB64,
    serverWitnessPubkeysB64: [serverKey.pubB64],
    events,
    crypto,
  });

// ---------- fixtures pin ----------
console.log("canonical fixture");
check(
  "tuple canonical string pinned",
  canonicalize(CANONICAL_FIXTURE_TUPLE) === CANONICAL_FIXTURE,
  {
    got: canonicalize(CANONICAL_FIXTURE_TUPLE),
  },
);

// ---------- genesis ----------
console.log("genesis");
const genesis = makeEvent({
  type: "vault_member_added",
  payload: { account_id: OWNER, role: "owner" },
  signer: anchor,
  deviceId: "dev-anchor",
  account: OWNER,
});
{
  const s = fold([genesis]);
  check("genesis accepted", s.hasGenesis && s.members.get(OWNER)?.role === "owner");
  check("genesis binds anchor device", s.devices.get(anchor.pubB64)?.account_id === OWNER);
}
{
  const fakeGenesis = makeEvent({
    type: "vault_member_added",
    payload: { account_id: "acct-rival", role: "owner" },
    signer: rivalDev,
    deviceId: "dev-rival",
    account: "acct-rival",
  });
  const s = fold([fakeGenesis]);
  check(
    "non-anchor genesis refused",
    !s.hasGenesis && s.conflicts[0]?.reason === "not_genesis_eligible",
  );
}

// ---------- QR path: owner admits staff + binds device ----------
console.log("owner-signed admission");
const staffAdded = makeEvent({
  type: "vault_member_added",
  payload: { account_id: STAFF, role: "editor" },
  signer: anchor,
  deviceId: "dev-anchor",
  account: OWNER,
});
const staffDevAdded = makeEvent({
  type: "vault_device_added",
  payload: { account_id: STAFF, device_id: "dev-staff", device_pubkey: staffDev.pubB64 },
  signer: anchor,
  deviceId: "dev-anchor",
  account: OWNER,
});
{
  const s = fold([genesis, staffAdded, staffDevAdded]);
  check("staff admitted as editor", s.members.get(STAFF)?.role === "editor");
  check("staff device bound", s.devices.get(staffDev.pubB64)?.account_id === STAFF);
  check("no conflicts", s.conflicts.length === 0, s.conflicts);
}

// Invariant 2: a non-owner cannot admit / promote / remove.
console.log("non-owner authority refused");
{
  const rogueAdd = makeEvent({
    type: "vault_member_added",
    payload: { account_id: "acct-friend", role: "editor" },
    signer: staffDev,
    deviceId: "dev-staff",
    account: STAFF,
  });
  const roguePromote = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: STAFF, role: "owner" },
    signer: staffDev,
    deviceId: "dev-staff",
    account: STAFF,
  });
  const s = fold([genesis, staffAdded, staffDevAdded, rogueAdd, roguePromote]);
  check("editor cannot admit", !s.members.has("acct-friend"));
  check("editor cannot self-promote", s.members.get(STAFF)?.role === "editor");
  check(
    "both refusals recorded",
    s.conflicts.filter((c) => c.reason === "signer_not_owner_device").length === 2,
    s.conflicts,
  );
}

// Invariant 1: forged signature anywhere → refused.
console.log("forgery refused");
{
  const tampered = makeEvent({
    type: "vault_member_added",
    payload: { account_id: "acct-evil", role: "owner" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
    tamper: (e) => {
      (e.payload as Record<string, unknown>).role = "owner";
      (e.payload as Record<string, unknown>).account_id = "acct-eviler"; // breaks sig
    },
  });
  const s = fold([genesis, tampered]);
  check("tampered admission refused", !s.members.has("acct-eviler"));
  check("reason bad_signature", s.conflicts[0]?.reason === "bad_signature", s.conflicts);
}

// ---------- online path: witnessed member + device ----------
console.log("witnessed admission");
{
  const issuedAt = hlcCounter + 1;
  const mTuple = memberWitnessTuple({
    vault_id: VAULT,
    account_id: MEMBER2,
    inviter_account_id: OWNER,
    role: "viewer",
    issued_at_ms: issuedAt,
  });
  const m2Added = makeEvent({
    type: "vault_member_added",
    payload: {
      account_id: MEMBER2,
      role: "viewer",
      witness: {
        sig_b64: witnessSig(serverKey, mTuple),
        server_key_id: "primary",
        issued_at_ms: issuedAt,
        inviter_account_id: OWNER,
      },
    },
    signer: member2Dev,
    deviceId: "dev-m2",
    account: MEMBER2,
    pms: issuedAt,
  });
  const dTuple = deviceWitnessTuple({
    vault_id: VAULT,
    account_id: MEMBER2,
    device_id: "dev-m2",
    device_pubkey_b64: member2Dev.pubB64,
    issued_at_ms: issuedAt,
  });
  const m2DevAdded = makeEvent({
    type: "vault_device_added",
    payload: {
      account_id: MEMBER2,
      device_id: "dev-m2",
      device_pubkey: member2Dev.pubB64,
      witness: {
        sig_b64: witnessSig(serverKey, dTuple),
        server_key_id: "primary",
        issued_at_ms: issuedAt,
      },
    },
    signer: member2Dev,
    deviceId: "dev-m2",
    account: MEMBER2,
    pms: issuedAt + 1,
  });
  const s = fold([genesis, m2Added, m2DevAdded]);
  check("witnessed member admitted", s.members.get(MEMBER2)?.role === "viewer");
  check("witnessed device bound", s.devices.get(member2Dev.pubB64)?.account_id === MEMBER2);

  // Stale witness refused.
  const staleAt = issuedAt - WITNESS_FRESHNESS_MS - 1000;
  const staleTuple = deviceWitnessTuple({
    vault_id: VAULT,
    account_id: MEMBER2,
    device_id: "dev-m2b",
    device_pubkey_b64: rivalDev.pubB64,
    issued_at_ms: staleAt,
  });
  const staleAdd = makeEvent({
    type: "vault_device_added",
    payload: {
      account_id: MEMBER2,
      device_id: "dev-m2b",
      device_pubkey: rivalDev.pubB64,
      witness: {
        sig_b64: witnessSig(serverKey, staleTuple),
        server_key_id: "primary",
        issued_at_ms: staleAt,
      },
    },
    signer: rivalDev,
    deviceId: "dev-m2b",
    account: MEMBER2,
    pms: issuedAt + 2,
  });
  const s2 = fold([genesis, m2Added, m2DevAdded, staleAdd]);
  check(
    "stale witness refused",
    s2.conflicts.some((c) => c.reason === "witness_stale"),
    s2.conflicts,
  );

  // Invariant 4: witness alone cannot bind a device key the envelope wasn't
  // signed by (server key leak ≠ admission).
  const mismTuple = deviceWitnessTuple({
    vault_id: VAULT,
    account_id: MEMBER2,
    device_id: "dev-evil",
    device_pubkey_b64: rivalDev.pubB64,
    issued_at_ms: issuedAt,
  });
  const mismatch = makeEvent({
    type: "vault_device_added",
    payload: {
      account_id: MEMBER2,
      device_id: "dev-evil",
      device_pubkey: rivalDev.pubB64,
      witness: {
        sig_b64: witnessSig(serverKey, mismTuple),
        server_key_id: "primary",
        issued_at_ms: issuedAt,
      },
    },
    signer: member2Dev, // NOT the key being bound
    deviceId: "dev-m2",
    account: MEMBER2,
    pms: issuedAt + 3,
  });
  const s3 = fold([genesis, m2Added, m2DevAdded, mismatch]);
  check("witnessed bind requires self-signature", !s3.devices.has(rivalDev.pubB64), s3.conflicts);
}

// ---------- Invariant 3: removal refusal + lawful-at-HLC shape ----------
console.log("removal");
const staffRemoved = makeEvent({
  type: "vault_member_removed",
  payload: { account_id: STAFF },
  signer: anchor,
  deviceId: "dev-anchor",
  account: OWNER,
});
{
  const s = fold([genesis, staffAdded, staffDevAdded, staffRemoved]);
  check("member removed", s.members.get(STAFF)?.removed === true);
  check("devices retired with member", s.devices.get(staffDev.pubB64)?.removed === true);

  // Handshake refusal with local knowledge of the removal, even when the
  // presenter omits it from the proof.
  const verdict = verifyPeerProof({
    vaultId: VAULT,
    anchorPubkeyB64: anchor.pubB64,
    serverWitnessPubkeysB64: [serverKey.pubB64],
    localEvents: [genesis, staffAdded, staffDevAdded, staffRemoved],
    proofEvents: [genesis, staffAdded, staffDevAdded], // removal omitted
    claimedDevicePubkeyB64: staffDev.pubB64,
    crypto,
  });
  check(
    "revoked device refused on handshake",
    !verdict.ok && verdict.reason === "device_removed",
    verdict,
  );
}

// Post-removal authority: the removed staff's signatures stop working, and
// an owner-signed admission AFTER removal re-admits cleanly.
{
  const reAdd = makeEvent({
    type: "vault_member_added",
    payload: { account_id: STAFF, role: "viewer" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s = fold([genesis, staffAdded, staffDevAdded, staffRemoved, reAdd]);
  check("re-admission lifts removal", s.members.get(STAFF)?.removed === false);
  check("re-admission applies new role", s.members.get(STAFF)?.role === "viewer");
}

// ---------- Invariant 6: concurrent owner demotions converge ----------
console.log("owner-vs-owner determinism");
{
  // Promote staff to owner, bind both; then both owners demote each other
  // at the same pms (HLC tie broken by device_id, then event_id).
  const promote = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: STAFF, role: "owner" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const t = ++hlcCounter;
  const ownerDemotesStaff = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: STAFF, role: "viewer" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
    pms: t,
  });
  const staffDemotesOwner = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: OWNER, role: "viewer" },
    signer: staffDev,
    deviceId: "dev-staff",
    account: STAFF,
    pms: t,
  });
  const base = [genesis, staffAdded, staffDevAdded, promote];
  const order1 = fold([...base, ownerDemotesStaff, staffDemotesOwner]);
  const order2 = fold([...base, staffDemotesOwner, ownerDemotesStaff]);
  const summary = (s: ReturnType<typeof fold>) =>
    JSON.stringify({
      owner: s.members.get(OWNER),
      staff: s.members.get(STAFF),
      conflicts: s.conflicts.map((c) => c.reason),
    });
  check("input order irrelevant (deterministic sort)", summary(order1) === summary(order2), {
    a: summary(order1),
    b: summary(order2),
  });
  // dev-anchor < dev-staff lexicographically, so the anchor's demotion folds
  // first; staff is a viewer by the time their demotion is evaluated → it
  // is refused. Exactly one demotion wins, identically everywhere.
  check(
    "deterministic winner",
    order1.members.get(STAFF)?.role === "viewer" && order1.members.get(OWNER)?.role === "owner",
    summary(order1),
  );
}

// ---------- M2 security-review adversarial cases ----------
// These cover the exact holes that hid the confirmed P0/P1s.

// Helper: witnessed member_added (online invite path).
function witnessedMemberAdd(args: {
  account: string;
  device: Keypair;
  deviceId: string;
  role: string;
  inviter: string;
  issuedAt: number;
  pms: number;
}): MembershipEventLike {
  const tuple = memberWitnessTuple({
    vault_id: VAULT,
    account_id: args.account,
    inviter_account_id: args.inviter,
    role: args.role as "owner" | "editor" | "viewer",
    issued_at_ms: args.issuedAt,
  });
  return makeEvent({
    type: "vault_member_added",
    payload: {
      account_id: args.account,
      role: args.role,
      witness: {
        sig_b64: witnessSig(serverKey, tuple),
        server_key_id: "primary",
        issued_at_ms: args.issuedAt,
        inviter_account_id: args.inviter,
      },
    },
    signer: args.device,
    deviceId: args.deviceId,
    account: args.account,
    pms: args.pms,
  });
}

console.log("witness role cap (P0)");
{
  // A witness must NEVER mint an owner — only editor/viewer.
  const at = hlcCounter + 50;
  const ownerByWitness = witnessedMemberAdd({
    account: "acct-attacker",
    device: rivalDev,
    deviceId: "dev-att",
    role: "owner",
    inviter: OWNER,
    issuedAt: at,
    pms: at,
  });
  const s = fold([genesis, ownerByWitness]);
  check("witnessed owner admission refused", !s.members.has("acct-attacker"));
  check(
    "reason witness_role_too_high",
    s.conflicts.some((c) => c.reason === "witness_role_too_high"),
    s.conflicts,
  );
}

console.log("witness cannot resurrect removed entry (P0)");
{
  // MEMBER3 is admitted by witness, then owner-removed, then replays the
  // ORIGINAL witnessed admission at a later HLC (within freshness). Must
  // NOT re-enter — only an owner-signed re-add lifts a removal.
  const MEMBER3 = "acct-m3";
  const m3Dev = keypair(7);
  const at = hlcCounter + 100;
  const m3Add = witnessedMemberAdd({
    account: MEMBER3,
    device: m3Dev,
    deviceId: "dev-m3",
    role: "editor",
    inviter: OWNER,
    issuedAt: at,
    pms: at,
  });
  const m3Removed = makeEvent({
    type: "vault_member_removed",
    payload: { account_id: MEMBER3 },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
    pms: at + 10,
  });
  // Replay: a fresh event_id, same witness, HLC after removal.
  const replayTuple = memberWitnessTuple({
    vault_id: VAULT,
    account_id: MEMBER3,
    inviter_account_id: OWNER,
    role: "editor",
    issued_at_ms: at,
  });
  const replay = makeEvent({
    type: "vault_member_added",
    payload: {
      account_id: MEMBER3,
      role: "editor",
      witness: {
        sig_b64: witnessSig(serverKey, replayTuple),
        server_key_id: "primary",
        issued_at_ms: at,
        inviter_account_id: OWNER,
      },
    },
    signer: m3Dev,
    deviceId: "dev-m3",
    account: MEMBER3,
    pms: at + 20,
  });
  const s = fold([genesis, m3Add, m3Removed, replay]);
  check(
    "replayed witness does NOT resurrect removed member",
    s.members.get(MEMBER3)?.removed === true,
  );
  check(
    "reason removed_entry_replay",
    s.conflicts.some((c) => c.reason === "removed_entry_replay"),
    s.conflicts,
  );
}

console.log("last-owner lockout guard (P1)");
{
  // The sole owner cannot remove or self-demote — it would zero the active
  // owner set and brick the vault.
  const selfRemove = makeEvent({
    type: "vault_member_removed",
    payload: { account_id: OWNER },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s1 = fold([genesis, selfRemove]);
  check("sole owner cannot remove self", s1.members.get(OWNER)?.removed === false);
  check(
    "reason last_owner (remove)",
    s1.conflicts.some((c) => c.reason === "last_owner"),
    s1.conflicts,
  );

  const selfDemote = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: OWNER, role: "editor" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s2 = fold([genesis, selfDemote]);
  check("sole owner cannot self-demote", s2.members.get(OWNER)?.role === "owner");
  check(
    "reason last_owner (demote)",
    s2.conflicts.some((c) => c.reason === "last_owner"),
    s2.conflicts,
  );
}

console.log("last-owner lockout via member_added demotion (re-review P0)");
{
  // upsert vector: re-adding the sole owner at a lower role demotes them.
  // Both the owner-signed and witnessed paths must refuse.
  const ownerSignedDemote = makeEvent({
    type: "vault_member_added",
    payload: { account_id: OWNER, role: "editor" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s1 = fold([genesis, ownerSignedDemote]);
  check(
    "owner-signed member_added cannot demote sole owner",
    s1.members.get(OWNER)?.role === "owner",
  );
  check(
    "reason last_owner (added, owner-signed)",
    s1.conflicts.some((c) => c.reason === "last_owner"),
    s1.conflicts,
  );

  const at = hlcCounter + 200;
  const witnessedDemote = witnessedMemberAdd({
    account: OWNER,
    device: rivalDev,
    deviceId: "dev-att2",
    role: "editor", // passes the owner-cap, but demotes the sole owner
    inviter: OWNER,
    issuedAt: at,
    pms: at,
  });
  const s2 = fold([genesis, witnessedDemote]);
  check("witnessed member_added cannot demote sole owner", s2.members.get(OWNER)?.role === "owner");
  check(
    "reason last_owner (added, witnessed)",
    s2.conflicts.some((c) => c.reason === "last_owner"),
    s2.conflicts,
  );

  // Legitimate: with TWO owners, demoting one via member_added is allowed.
  const promoteStaff = makeEvent({
    type: "vault_member_added",
    payload: { account_id: STAFF, role: "owner" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const demoteStaff = makeEvent({
    type: "vault_member_role_changed",
    payload: { account_id: STAFF, role: "editor" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s3 = fold([genesis, promoteStaff, demoteStaff]);
  check(
    "two-owner demotion allowed (not last-owner)",
    s3.members.get(STAFF)?.role === "editor",
    s3.conflicts,
  );
}

console.log("device_id collision removal retires all bound pubkeys (P1)");
{
  // Two distinct pubkeys bound under the same device_id (key rotation /
  // re-bind). A removal by device_id must retire BOTH.
  const dupA = keypair(8);
  const dupB = keypair(9);
  const SHARED = "dev-shared";
  const addStaff = makeEvent({
    type: "vault_member_added",
    payload: { account_id: STAFF, role: "editor" },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const bindA = makeEvent({
    type: "vault_device_added",
    payload: { account_id: STAFF, device_id: SHARED, device_pubkey: dupA.pubB64 },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const bindB = makeEvent({
    type: "vault_device_added",
    payload: { account_id: STAFF, device_id: SHARED, device_pubkey: dupB.pubB64 },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const removeShared = makeEvent({
    type: "vault_device_removed",
    payload: { device_id: SHARED },
    signer: anchor,
    deviceId: "dev-anchor",
    account: OWNER,
  });
  const s = fold([genesis, addStaff, bindA, bindB, removeShared]);
  check(
    "both pubkeys under shared device_id retired",
    s.devices.get(dupA.pubB64)?.removed === true && s.devices.get(dupB.pubB64)?.removed === true,
    { a: s.devices.get(dupA.pubB64), b: s.devices.get(dupB.pubB64) },
  );
}

// ---------- result ----------
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall chain selftests passed");
