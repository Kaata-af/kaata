// Real-signature ownership handover regressions; no native modules or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import ts from "typescript";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import { foldMembership, type ChainCrypto, type MembershipEventLike } from "../chain";
import {
  OWNERSHIP_GRANT_DOMAIN,
  OWNERSHIP_RECEIPT_DOMAIN,
  ownershipTransferGrantBytes,
  ownershipTransferGrantHash,
  verifyOwnershipTransferEvent,
  type OwnershipTransferAuthorization,
  type OwnershipTransferGrant,
  type OwnershipTransferProof,
} from "../ownership-transfer";

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
const canonicalize = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const x = v as Record<string, unknown>;
  return `{${Object.keys(x)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(x[k])}`)
    .join(",")}}`;
};
const b64 = (v: Uint8Array) => Buffer.from(v).toString("base64");
const bytes = (v: string) => Uint8Array.from(Buffer.from(v, "base64"));
const key = (seed: number) => {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, pub: b64(ed.getPublicKey(secret)) };
};
const owner = key(1),
  recipient = key(2),
  server = key(3),
  outsider = key(4);
const V = "10000000-0000-4000-8000-000000000001";
const A = "10000000-0000-4000-8000-000000000002";
const B = "10000000-0000-4000-8000-000000000003";
const C = "10000000-0000-4000-8000-000000000004";
const D = "10000000-0000-4000-8000-000000000005";
const S = "10000000-0000-4000-8000-000000000006";
const TRANSFER = "10000000-0000-4000-8000-000000000007";
const EVENT = "10000000-0000-4000-8000-000000000008";
const eventBytes = (e: MembershipEventLike) =>
  new TextEncoder().encode(
    canonicalize({
      actor_account_id: e.actor_account_id,
      device_id: e.device_id,
      event_id: e.event_id,
      event_type: e.event_type,
      hlc: e.hlc,
      payload: e.payload,
      payload_schema: e.payload_schema,
      relationship_id: e.relationship_id,
      target_id: e.target_id,
      vault_id: e.vault_id,
    }),
  );
const crypto: ChainCrypto = {
  canonicalize,
  verifyEvent: (e, sig, pub) => {
    try {
      return ed.verify(bytes(sig), eventBytes(e), bytes(pub));
    } catch {
      return false;
    }
  },
  verifyRaw: (msg, sig, pub) => {
    try {
      return ed.verify(bytes(sig), msg, bytes(pub));
    } catch {
      return false;
    }
  },
};
const sign = (e: MembershipEventLike, k = owner) => ({
  ...e,
  event_sig_b64: b64(ed.sign(eventBytes(e), k.secret)),
  signer_device_pubkey: k.pub,
});
let seq = 20;
const event = (
  type: string,
  payload: unknown,
  target: string,
  pms: number,
  signer = owner,
  account: string | null = A,
): MembershipEventLike =>
  sign(
    {
      event_id: `10000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`,
      event_type: type,
      vault_id: V,
      target_id: target,
      relationship_id: null,
      hlc: { pms, l: 0, did: D },
      device_id: D,
      actor_account_id: account,
      payload,
      payload_schema: 1,
    },
    signer,
  );
const grant: OwnershipTransferGrant = {
  domain: OWNERSHIP_GRANT_DOMAIN,
  transfer_id: TRANSFER,
  vault_id: V,
  from_account_id: A,
  recipient_email_normalized: "recipient@example.com",
  demote_self_to: "editor",
  issued_at_ms: 2000,
  expires_at_ms: 6000,
};
function authorization(g = grant, k = owner): OwnershipTransferAuthorization {
  return {
    grant: g,
    signer_device_pubkey: k.pub,
    sig_b64: b64(ed.sign(ownershipTransferGrantBytes(g, canonicalize), k.secret)),
  };
}
function handover(
  auth = authorization(),
  to = B,
  pms = 3000,
  id = EVENT,
  signer = server,
): MembershipEventLike {
  const proof: OwnershipTransferProof = {
    authorization: auth,
    receipt: {
      domain: OWNERSHIP_RECEIPT_DOMAIN,
      transfer_id: auth.grant.transfer_id,
      vault_id: V,
      grant_sha256: ownershipTransferGrantHash(auth.grant, canonicalize),
      to_account_id: to,
      accepted_at_ms: pms,
      event_id: id,
      vault_epoch: 2,
    },
  };
  return sign(
    {
      event_id: id,
      event_type: "vault_member_added",
      vault_id: V,
      target_id: to,
      relationship_id: null,
      hlc: { pms, l: 0, did: S },
      device_id: S,
      actor_account_id: null,
      payload: { account_id: to, role: "owner", ownership_transfer: proof },
      payload_schema: 1,
    },
    signer,
  );
}
const genesis = event("vault_member_added", { account_id: A, role: "owner" }, A, 1000);
const transfer = handover();
const fold = (events: MembershipEventLike[]) =>
  foldMembership({
    vaultId: V,
    anchorPubkeyB64: owner.pub,
    serverWitnessPubkeysB64: [server.pub],
    events,
    crypto,
  });
const isTransferred = (events: MembershipEventLike[]) => {
  const s = fold(events);
  assert.equal(s.members.get(A)?.role, "editor");
  assert.equal(s.members.get(B)?.role, "owner");
  return s;
};

const canonicalFixture =
  '{"demote_self_to":"editor","domain":"kaata-ownership-transfer-v1","expires_at_ms":6000,"from_account_id":"10000000-0000-4000-8000-000000000002","issued_at_ms":2000,"recipient_email_normalized":"recipient@example.com","transfer_id":"10000000-0000-4000-8000-000000000007","vault_id":"10000000-0000-4000-8000-000000000001"}';
assert.equal(
  new TextDecoder().decode(ownershipTransferGrantBytes(grant, canonicalize)),
  canonicalFixture,
);
assert.ok(verifyOwnershipTransferEvent(transfer, [server.pub], crypto));
assert.equal(isTransferred([genesis, transfer]).conflicts.length, 0);
assert.equal(isTransferred([transfer, genesis]).conflicts.length, 0);
assert.equal(isTransferred([genesis, transfer, transfer]).conflicts.length, 0);

// A leaked server key alone cannot authorize a handover.
const forgedGrant = handover(authorization(grant, outsider));
assert.equal(fold([genesis, forgedGrant]).members.get(B), undefined);
assert.equal(
  verifyOwnershipTransferEvent(
    handover(authorization(), B, 3000, EVENT, outsider),
    [server.pub],
    crypto,
  ),
  null,
);
const changedGrant = structuredClone(transfer);
(changedGrant.payload as any).ownership_transfer.authorization.grant.recipient_email_normalized =
  "attacker@example.com";
assert.equal(verifyOwnershipTransferEvent(sign(changedGrant, server), [server.pub], crypto), null);

// The exact server envelope, recipient, time, and event identity are bound.
for (const mutate of [
  (e: MembershipEventLike) => {
    e.event_id = C;
  },
  (e: MembershipEventLike) => {
    e.hlc.pms++;
  },
  (e: MembershipEventLike) => {
    e.hlc.l++;
  },
  (e: MembershipEventLike) => {
    e.vault_id = C;
  },
  (e: MembershipEventLike) => {
    e.target_id = C;
  },
  (e: MembershipEventLike) => {
    e.actor_account_id = A;
  },
  (e: MembershipEventLike) => {
    (e.payload as any).account_id = C;
  },
]) {
  const e = structuredClone(transfer);
  mutate(e);
  assert.equal(verifyOwnershipTransferEvent(sign(e, server), [server.pub], crypto), null);
}
assert.equal(
  verifyOwnershipTransferEvent(handover(authorization(), B, 7000), [server.pub], crypto),
  null,
);
assert.equal(
  verifyOwnershipTransferEvent(handover(authorization(), B, 1500), [server.pub], crypto),
  null,
);
assert.equal(
  verifyOwnershipTransferEvent(handover(authorization(), A), [server.pub], crypto),
  null,
);

// The original anchor no longer confers owner authority after the handover.
const reclaim = event("vault_member_role_changed", { account_id: A, role: "owner" }, A, 4000);
const s = isTransferred([genesis, transfer, reclaim]);
assert.equal(s.conflicts.at(-1)?.reason, "signer_not_owner_device");
const replay = handover(authorization(), C, 4500, C);
assert.equal(isTransferred([genesis, transfer, replay]).members.get(C), undefined);
const removal = event("vault_device_removed", { device_id: D }, D, 2500);
assert.equal(fold([genesis, removal, transfer]).members.get(B), undefined);

// A local-origin identity and its account counterpart are demoted together.
const alias = "local:abcdefghijklmnop";
const aliasGenesis = event("vault_member_added", { account_id: alias, role: "owner" }, alias, 1000);
const aliasGrant = { ...grant, from_chain_account_id: alias };
const aliasTransfer = handover(authorization(aliasGrant));
const aliased = fold([aliasGenesis, aliasTransfer, reclaim]);
assert.equal(aliased.members.get(alias)?.role, "editor");
assert.equal(aliased.members.get(A)?.role, "editor");
assert.equal(aliased.members.get(B)?.role, "owner");
assert.equal(aliased.conflicts.at(-1)?.reason, "signer_not_owner_device");

// The existing ordinary-witness cap is unchanged.
const ordinary = event(
  "vault_member_added",
  { account_id: B, role: "owner", witness: {} },
  B,
  3000,
  recipient,
  B,
);
assert.equal(fold([genesis, ordinary]).members.get(B), undefined);
const admitRecipient = event("vault_member_added", { account_id: B, role: "editor" }, B, 1200);
const bindRecipient = event(
  "vault_device_added",
  { account_id: B, device_id: D, device_pubkey: recipient.pub },
  B,
  1500,
);
const reappoint = event(
  "vault_member_role_changed",
  { account_id: A, role: "owner" },
  A,
  4000,
  recipient,
  B,
);
const oldGrantFreshReceipt = handover(authorization(), C, 5500, C);
const consumed = fold([
  genesis,
  admitRecipient,
  bindRecipient,
  transfer,
  reappoint,
  oldGrantFreshReceipt,
]);
assert.equal(consumed.members.get(A)?.role, "owner");
assert.equal(
  consumed.members.get(C),
  undefined,
  "consumed transfer nonce stays consumed after source becomes owner again",
);
assert.equal(consumed.conflicts.at(-1)?.reason, "witness_invalid");
const admitNextOwner = event(
  "vault_member_added",
  { account_id: C, role: "owner" },
  C,
  4000,
  recipient,
  B,
);
const recipientLeaves = event("vault_member_removed", { account_id: B }, B, 4500, recipient, B);
const removedRecipient = fold([
  genesis,
  admitRecipient,
  bindRecipient,
  transfer,
  admitNextOwner,
  recipientLeaves,
  transfer,
]);
assert.equal(
  removedRecipient.members.get(B)?.removed,
  true,
  "replayed immutable receipt cannot resurrect a later removed recipient",
);
console.log(
  "PASS: ownership handover signatures, exact receipt binding, stale replay, removed key, alias demotion, owner authority, and unchanged invite caps",
);

// Exercise actual gate SQL + actual membership appliers, rather than a second
// model of role resolution. Native storage and key access alone are replaced.
const fixture = new Database(":memory:");
fixture.exec(`
CREATE TABLE vaults(id TEXT PRIMARY KEY,vault_epoch INTEGER,vault_trust_anchor_pubkey TEXT);
CREATE TABLE event_log(event_id TEXT PRIMARY KEY,vault_id TEXT,event_type TEXT,target_id TEXT,payload_json TEXT,
 applied_at INTEGER,quarantine_reason TEXT,hlc_physical_ms INTEGER,hlc_logical INTEGER,hlc_device_id TEXT);
CREATE TABLE vault_members_mirror(vault_id TEXT,account_id TEXT,role TEXT,accepted_at INTEGER,revoked_at INTEGER,display_name TEXT,PRIMARY KEY(vault_id,account_id));
CREATE TABLE vault_device_registry(vault_id TEXT,device_pubkey TEXT,device_id TEXT,account_id TEXT,added_at_ms INTEGER,
 removed_at_ms INTEGER,removed_at_l INTEGER,removed_at_did TEXT,PRIMARY KEY(vault_id,device_pubkey));
CREATE TABLE vault_credentials(vault_id TEXT,account_id TEXT,device_id TEXT,device_pubkey TEXT);
CREATE TABLE revocation_list(vault_id TEXT,device_id TEXT,revoked_at INTEGER,lifted_at INTEGER);
CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
`);
const db = {
  getFirstAsync: async (sql: string, ...args: any[]) => fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: any[]) => fixture.prepare(sql).all(...args),
  runAsync: async (sql: string, ...args: any[]) => fixture.prepare(sql).run(...args),
};
let currentAccount: string | null = A,
  identities: string[] = [A];
const load = (file: string, dependencies: Record<string, unknown>) => {
  const exports: any = {};
  const js = ts.transpileModule(readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", js)((name: string) => {
    assert.ok(name in dependencies, `unexpected ${file} dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
};
const gate = load("../../projection/role-gate", {
  "../db-tx": { getAccountIdSync: () => currentAccount },
  "../effective-account": { resolveAccountIdCandidates: async () => identities },
  "../event-sig": {
    verifyEventSignature: (e: MembershipEventLike, sig: string, pub: string) => ({
      valid: crypto.verifyEvent(e, sig, pub),
    }),
  },
  "../hlc": require("../../hlc"),
  "../trust/chain": require("../chain"),
  "../trust/crypto-runtime": { runtimeChainCrypto: crypto },
  "../trust/ownership-transfer": require("../ownership-transfer"),
  "../mesh/device-key": { isOwnDevicePubkey: async (pub: string) => pub === owner.pub },
});
const appliers = load("../../projection/vault_members", {
  "../hlc": require("../../hlc"),
  "../use-vault-role": { invalidateVaultRoleCache: () => gate.invalidateRoleGateCache(V) },
});
function resetProjection() {
  for (const table of [
    "vaults",
    "event_log",
    "vault_members_mirror",
    "vault_device_registry",
    "vault_credentials",
    "revocation_list",
    "app_meta",
  ])
    fixture.prepare(`DELETE FROM ${table}`).run();
  fixture.prepare("INSERT INTO vaults VALUES(?,1,?)").run(V, owner.pub);
  fixture.prepare("INSERT INTO app_meta VALUES('mesh_server_pubkey_primary',?)").run(server.pub);
  currentAccount = A;
  identities = [A];
  gate.invalidateRoleGateCache();
}
async function apply(e: MembershipEventLike, origin = "remote") {
  const projected = { ...e, origin, appended_at: e.hlc.pms };
  fixture
    .prepare(`INSERT OR IGNORE INTO event_log VALUES(?,?,?,?,?,NULL,NULL,?,?,?)`)
    .run(
      e.event_id,
      e.vault_id,
      e.event_type,
      e.target_id,
      JSON.stringify(e.payload),
      e.hlc.pms,
      e.hlc.l,
      e.hlc.did,
    );
  const result = await gate.checkRoleForEvent(db, projected);
  if (result.ok) {
    fixture.exec("BEGIN");
    try {
      if (e.event_type === "vault_member_added")
        await appliers.applyVaultMemberAdded(db, projected);
      if (e.event_type === "vault_member_role_changed")
        await appliers.applyVaultMemberRoleChanged(db, projected);
      fixture
        .prepare("UPDATE event_log SET applied_at=1,quarantine_reason=NULL WHERE event_id=?")
        .run(e.event_id);
      fixture.exec("COMMIT");
    } catch (error) {
      fixture.exec("ROLLBACK");
      throw error;
    }
  } else
    fixture
      .prepare("UPDATE event_log SET quarantine_reason=? WHERE event_id=?")
      .run(result.reason, e.event_id);
  return result;
}
const mirrorRole = (id: string) =>
  (
    fixture
      .prepare("SELECT role FROM vault_members_mirror WHERE vault_id=? AND account_id=?")
      .get(V, id) as any
  )?.role;
async function runProjection() {
  resetProjection();
  assert.equal((await apply(transfer)).ok, false, "missing owner chain waits for admission");
  assert.equal((await apply(genesis)).ok, true);
  assert.equal((await apply(transfer)).ok, true, "retry heals after owner proof arrives");
  assert.equal(mirrorRole(A), "editor");
  assert.equal(mirrorRole(B), "owner");
  assert.equal((await apply(reclaim)).ok, false, "remote anchor cannot reclaim owner");
  assert.equal(
    (await apply({ ...reclaim, event_id: C }, "local")).ok,
    false,
    "local anchor fallback cannot reclaim owner",
  );
  const localBackdated = event("vault_member_added", { account_id: C, role: "owner" }, C, 2500);
  assert.equal(
    (await apply(localBackdated, "local")).ok,
    false,
    "local author cannot mint a fresh owner by backdating",
  );
  assert.equal(
    (await apply(oldGrantFreshReceipt)).ok,
    false,
    "a second receipt cannot reuse consumed owner authorization",
  );
  const oldReclaim = event("vault_member_role_changed", { account_id: A, role: "owner" }, A, 2500);
  assert.equal(
    (await apply(oldReclaim)).ok,
    true,
    "historically authorized owner event remains valid",
  );
  assert.equal(mirrorRole(A), "editor", "late owner role is shadowed by source side of handover");
  const lateClerk = event("vault_member_role_changed", { account_id: B, role: "clerk" }, B, 4500);
  // Seed a later already-verified role to test per-cell ordering when a handover
  // reaches the projection after subsequent membership changes.
  fixture
    .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,1,NULL,?,?,?)")
    .run(
      lateClerk.event_id,
      V,
      lateClerk.event_type,
      B,
      JSON.stringify(lateClerk.payload),
      4500,
      0,
      D,
    );
  fixture.prepare("UPDATE vault_members_mirror SET role='clerk' WHERE account_id=?").run(B);
  await appliers.applyVaultMemberAdded(db, { ...transfer, appended_at: 3000 });
  assert.equal(mirrorRole(B), "clerk", "replayed old handover cannot undo later recipient role");
  const laterRemoval = event("vault_member_removed", { account_id: B }, B, 5000);
  fixture
    .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,1,NULL,?,?,?)")
    .run(
      laterRemoval.event_id,
      V,
      laterRemoval.event_type,
      B,
      JSON.stringify(laterRemoval.payload),
      5000,
      0,
      D,
    );
  fixture.prepare("UPDATE vault_members_mirror SET revoked_at=5000 WHERE account_id=?").run(B);
  await appliers.applyVaultMemberAdded(db, { ...transfer, appended_at: 3000 });
  assert.equal(
    (
      fixture
        .prepare("SELECT revoked_at FROM vault_members_mirror WHERE account_id=?")
        .get(B) as any
    )?.revoked_at,
    5000,
    "late receipt cannot clear a newer recipient revocation",
  );

  resetProjection();
  identities = [A, alias];
  assert.equal((await apply(aliasGenesis)).ok, true);
  assert.equal((await apply(aliasTransfer)).ok, true);
  assert.equal(mirrorRole(alias), "editor");
  assert.equal(mirrorRole(A), "editor");
  assert.equal(
    (await apply({ ...reclaim, event_id: C }, "local")).ok,
    false,
    "identity candidates cannot retain an alias owner",
  );
  currentAccount = null;
  identities = [alias];
  const signedOut = { ...reclaim, event_id: TRANSFER, actor_account_id: null };
  assert.equal(
    (await apply(signedOut, "local")).ok,
    false,
    "signed-out original device respects Editor role",
  );
  currentAccount = A;
  identities = [];
  assert.equal(
    (await apply({ ...reclaim, event_id: D }, "local")).ok,
    false,
    "unknown local identity has no post-transfer bootstrap authority",
  );

  resetProjection();
  await apply(genesis);
  assert.equal(
    (await apply(forgedGrant)).ok,
    false,
    "server proof cannot replace owner key authority",
  );
  assert.equal(mirrorRole(B), undefined);
  fixture
    .prepare("UPDATE vault_device_registry SET removed_at_ms=2500,removed_at_l=0,removed_at_did=?")
    .run(D);
  assert.equal((await apply(transfer)).ok, false, "removed authorizing device cannot transfer");
  fixture.close();
  console.log(
    "PASS: actual SQLite role gate and atomic projection, missing-proof retry, late delivery, alias identities, signed-out founder, removed key",
  );
}
void runProjection().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
