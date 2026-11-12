// Real Ed25519 Admin invite intent/acceptance/fold regressions; no network.
import assert from "node:assert/strict";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import { foldMembership, type ChainCrypto, type MembershipEventLike } from "../chain";
import {
  ADMIN_INVITE_GRANT_DOMAIN, ADMIN_INVITE_RECEIPT_DOMAIN,
  adminInviteGrantBytes, adminInviteGrantHash, parseAdminInviteGrant, verifyAdminInviteEvent,
  type AdminInviteGrant, type AdminInviteAuthorization, type AdminInviteProof,
} from "../admin-invite";

ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));
const key = (seed: number) => {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, pub: b64(ed.getPublicKey(secret)) };
};
const owner = key(1), server = key(3), outsider = key(4);
const V = "10000000-0000-4000-8000-000000000001";
const A = "10000000-0000-4000-8000-000000000002";
const B = "10000000-0000-4000-8000-000000000003";
const C = "10000000-0000-4000-8000-000000000004";
const D = "10000000-0000-4000-8000-000000000005";
const S = "10000000-0000-4000-8000-000000000006";
const GRANT = "10000000-0000-4000-8000-000000000007";
const EVENT = GRANT;
const eventBytes = (event: MembershipEventLike) => new TextEncoder().encode(canonicalize({
  actor_account_id: event.actor_account_id, device_id: event.device_id, event_id: event.event_id,
  event_type: event.event_type, hlc: event.hlc, payload: event.payload,
  payload_schema: event.payload_schema, relationship_id: event.relationship_id,
  target_id: event.target_id, vault_id: event.vault_id,
}));
const crypto: ChainCrypto = {
  canonicalize,
  verifyEvent: (event, signature, pubkey) => {
    try { return ed.verify(bytes(signature), eventBytes(event), bytes(pubkey)); } catch { return false; }
  },
  verifyRaw: (message, signature, pubkey) => {
    try { return ed.verify(bytes(signature), message, bytes(pubkey)); } catch { return false; }
  },
};
const sign = (event: MembershipEventLike, signer = owner): MembershipEventLike => ({
  ...event, event_sig_b64: b64(ed.sign(eventBytes(event), signer.secret)), signer_device_pubkey: signer.pub,
});
let sequence = 20;
const event = (type: string, payload: unknown, target: string, pms: number): MembershipEventLike =>
  sign({
    event_id: `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    event_type: type, vault_id: V, target_id: target, relationship_id: null,
    hlc: { pms, l: 0, did: D }, device_id: D, actor_account_id: A, payload, payload_schema: 1,
  });
const grant: AdminInviteGrant = {
  domain: ADMIN_INVITE_GRANT_DOMAIN, grant_id: GRANT, vault_id: V, from_account_id: A,
  recipient_account_id: B, role: "manager", issued_at_ms: 2000, expires_at_ms: 6000,
};
const authorization = (value = grant, signer = owner): AdminInviteAuthorization => ({
  grant: value, signer_device_pubkey: signer.pub,
  sig_b64: b64(ed.sign(adminInviteGrantBytes(value, canonicalize), signer.secret)),
});
function admission(auth = authorization(), to = B, pms = 3000, id = EVENT, signer = server) {
  const proof: AdminInviteProof = {
    authorization: auth,
    receipt: {
      domain: ADMIN_INVITE_RECEIPT_DOMAIN, grant_id: auth.grant.grant_id, vault_id: V,
      grant_sha256: adminInviteGrantHash(auth.grant, canonicalize), to_account_id: to,
      accepted_at_ms: pms, event_id: id, vault_epoch: 2,
    },
  };
  return sign({
    event_id: id, event_type: "vault_member_added", vault_id: V, target_id: to,
    relationship_id: null, hlc: { pms: auth.grant.issued_at_ms, l: 0, did: auth.grant.grant_id },
    device_id: auth.grant.grant_id, actor_account_id: null,
    payload: { account_id: to, role: "manager", admin_invite: proof }, payload_schema: 1,
  }, signer);
}
const genesis = event("vault_member_added", { account_id: A, role: "owner" }, A, 1000);
const accepted = admission();
const fold = (events: MembershipEventLike[]) => foldMembership({
  vaultId: V, anchorPubkeyB64: owner.pub, serverWitnessPubkeysB64: [server.pub], events, crypto,
});
const fixture = '{"domain":"kaata-admin-invite-v1","expires_at_ms":6000,"from_account_id":"10000000-0000-4000-8000-000000000002","grant_id":"10000000-0000-4000-8000-000000000007","issued_at_ms":2000,"recipient_account_id":"10000000-0000-4000-8000-000000000003","role":"manager","vault_id":"10000000-0000-4000-8000-000000000001"}';
assert.equal(new TextDecoder().decode(adminInviteGrantBytes(grant, canonicalize)), fixture);
assert.equal(parseAdminInviteGrant({ ...grant, recipient_account_id: "*" }), null);
assert.equal(parseAdminInviteGrant({ ...grant, role: "owner" }), null);
assert.ok(verifyAdminInviteEvent(accepted, [server.pub], crypto));
for (const ordered of [[genesis, accepted], [accepted, genesis], [genesis, accepted, accepted]]) {
  const state = fold(ordered);
  assert.equal(state.members.get(B)?.role, "manager");
  assert.equal(state.members.get(A)?.role, "owner");
  assert.equal(state.conflicts.length, 0);
}
// Recovery folds the original acceptance, even after its grant has expired.
const later = event("vault_member_added", { account_id: C, role: "viewer" }, C, 900000000);
assert.equal(fold([genesis, later, accepted]).members.get(B)?.role, "manager");
// Neither the server key alone nor an unrelated signing device can grant Admin.
assert.equal(fold([genesis, admission(authorization(grant, outsider))]).members.get(B), undefined);
assert.equal(verifyAdminInviteEvent(admission(authorization(), B, 3000, EVENT, outsider), [server.pub], crypto), null);
assert.equal(verifyAdminInviteEvent(admission(authorization(), C), [server.pub], crypto), null);
assert.equal(verifyAdminInviteEvent(admission(authorization(), B, 7000), [server.pub], crypto), null);
for (const mutate of [
  (e: MembershipEventLike) => { e.event_id = C; },
  (e: MembershipEventLike) => { e.hlc.pms++; },
  (e: MembershipEventLike) => { e.hlc.l++; },
  (e: MembershipEventLike) => { e.device_id = e.hlc.did = C; },
  (e: MembershipEventLike) => { e.vault_id = C; },
  (e: MembershipEventLike) => { e.target_id = C; },
  (e: MembershipEventLike) => { e.actor_account_id = A; },
  (e: MembershipEventLike) => { (e.payload as any).account_id = C; },
  (e: MembershipEventLike) => { (e.payload as any).admin_invite.receipt.grant_sha256 = "00"; },
  (e: MembershipEventLike) => { (e.payload as any).admin_invite.authorization.grant.recipient_account_id = C; },
]) {
  const changed = structuredClone(accepted);
  mutate(changed);
  assert.equal(verifyAdminInviteEvent(sign(changed, server), [server.pub], crypto), null);
}
// One grant never promotes an already admitted member or resurrects removal.
for (const role of ["viewer", "manager", "owner"] as const) {
  const prior = event("vault_member_added", { account_id: B, role }, B, 1500);
  const state = fold([genesis, prior, accepted]);
  assert.equal(state.members.get(B)?.role, role);
  assert.ok(state.conflicts.some((c) => c.event_id === accepted.event_id));
}
const demotion = event("vault_member_role_changed", { account_id: B, role: "viewer" }, B, 3500);
const replayed = admission(authorization(), B, 4000, C);
assert.equal(fold([genesis, accepted, demotion, replayed]).members.get(B)?.role, "viewer");
const removed = event("vault_member_removed", { account_id: B }, B, 3500);
assert.equal(fold([genesis, accepted, removed, replayed]).members.get(B)?.removed, true);
// An owner who loses their seat or signing device cannot admit a new Admin.
const otherOwner = event("vault_member_added", { account_id: C, role: "owner" }, C, 1500);
const ownerDemoted = event("vault_member_role_changed", { account_id: A, role: "editor" }, A, 1800);
assert.equal(fold([genesis, otherOwner, ownerDemoted, accepted]).members.get(B), undefined);
const deviceRemoved = event("vault_device_removed", { device_id: D }, D, 1800);
assert.equal(fold([genesis, deviceRemoved, accepted]).members.get(B), undefined);

console.log("Admin invite signature vector", JSON.stringify({
  canonical_grant: fixture, grant_sha256: adminInviteGrantHash(grant, canonicalize),
  owner_pubkey: owner.pub, owner_signature: authorization().sig_b64,
}));
console.log("PASS Admin invitations: owner intent, exact recipient, immutable acceptance, replay, removed/current roles, device authority and expired-grant recovery");
