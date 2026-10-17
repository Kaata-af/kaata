// Actual proof SQL loader, runtime crypto, canonical bytes and Ed25519.
// Only native crypto entropy and SQLite transport are replaced; all data is
// synthetic. Run: npx tsx lib/trust/__dev__/crypto-cache-proof-selftest.ts
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import * as chain from "../chain";
import * as verificationCache from "../successful-verification-cache";
import * as ownershipTransfer from "../ownership-transfer";
import { compileUI } from "../../__dev__/ui-fixture";

let signatureChecks = 0;
const eventSig = compileUI("../event-sig", {
  "@noble/hashes/sha512": require("@noble/hashes/sha512"),
  "@noble/ed25519": {
    ...ed,
    verify: (...args: Parameters<typeof ed.verify>) => {
      signatureChecks++;
      return ed.verify(...args);
    },
  },
  "expo-crypto": { getRandomBytes: randomBytes },
});
const runtime = compileUI("../trust/crypto-runtime", {
  "../event-sig": eventSig,
  "./successful-verification-cache": verificationCache,
  "./chain": chain,
  "./ownership-transfer": ownershipTransfer,
  "kaata-bt-classic": { verifyEd25519BatchAsync: (items: any[]) => nativeBatch(items) },
});
let nativeBatch: (items: any[]) => Promise<boolean[] | null> = async () => null;
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const ownerSeed = new Uint8Array(32).fill(21);
const peerSeed = new Uint8Array(32).fill(22);
const serverSeed = new Uint8Array(32).fill(23);
const replacementServerSeed = new Uint8Array(32).fill(24);
const key = (seed: Uint8Array) => b64(ed.getPublicKey(seed));
const ownerKey = key(ownerSeed);
const peerKey = key(peerSeed);
const serverKey = key(serverSeed);
const replacementServerKey = key(replacementServerSeed);

async function main() {
  const store = new Database(":memory:");
  store.exec(`
    CREATE TABLE app_meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE vaults(id TEXT PRIMARY KEY, vault_trust_anchor_pubkey TEXT);
    CREATE TABLE event_log(event_id TEXT PRIMARY KEY, event_type TEXT, vault_id TEXT,
      target_id TEXT, relationship_id TEXT, hlc_physical_ms INTEGER, hlc_logical INTEGER,
      hlc_device_id TEXT, device_id TEXT, actor_account_id TEXT, payload_json TEXT,
      payload_schema INTEGER, event_sig_b64 TEXT, signer_device_pubkey TEXT,
      author_seq INTEGER, tombstone_reason TEXT, server_acked_at INTEGER);
  `);
  const setMeta = async (name: string, value: string) => {
    store.prepare("INSERT OR REPLACE INTO app_meta VALUES(?,?)").run(name, value);
  };
  await setMeta("mesh_server_pubkey_primary", serverKey);
  store.prepare("INSERT INTO vaults VALUES(?,?)").run("vault", ownerKey);
  const db = {
    getFirstAsync: async (sql: string, ...args: any[]) => store.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) => store.prepare(sql).all(...args),
  };
  const proof = compileUI("../trust/proof", {
    "../db": {
      getDb: async () => db,
      getAppMeta: async (name: string) =>
        (store.prepare("SELECT value FROM app_meta WHERE key=?").get(name) as any)?.value ?? null,
      setAppMeta: setMeta,
    },
    "./chain": chain,
    "./crypto-runtime": runtime,
  });
  let seq = 0;
  const events = new Map<string, chain.MembershipEventLike>();
  function add(
    type: string,
    payload: Record<string, unknown>,
    options: { seed?: Uint8Array; ack?: boolean; vault?: string } = {},
  ) {
    const seed = options.seed ?? ownerSeed;
    const isOwner = seed === ownerSeed;
    const event: chain.MembershipEventLike = {
      event_id: `event-${++seq}`,
      event_type: type,
      vault_id: options.vault ?? "vault",
      target_id: String(payload.account_id ?? payload.device_id ?? "target"),
      relationship_id: null,
      hlc: { pms: 1000 + seq, l: 0, did: isOwner ? "owner-device" : "peer-device" },
      device_id: isOwner ? "owner-device" : "peer-device",
      actor_account_id: isOwner ? "owner" : "peer",
      payload,
      payload_schema: 1,
      signer_device_pubkey: key(seed),
    };
    event.event_sig_b64 = b64(ed.sign(eventSig.canonicalizeEvent(event), seed));
    store
      .prepare("INSERT INTO event_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)")
      .run(
        event.event_id,
        type,
        event.vault_id,
        event.target_id,
        null,
        event.hlc.pms,
        0,
        event.hlc.did,
        event.device_id,
        event.actor_account_id,
        JSON.stringify(payload),
        1,
        event.event_sig_b64,
        event.signer_device_pubkey,
        seq,
        options.ack ? 2000 : null,
      );
    events.set(event.event_id, event);
    return event.event_id;
  }
  const signWitness = (tuple: Record<string, unknown>) => ({
    issued_at_ms: 1000,
    server_key_id: "server",
    sig_b64: b64(ed.sign(new TextEncoder().encode(eventSig.canonicalize(tuple)), serverSeed)),
  });
  const genesisId = add(
    "vault_member_added",
    { account_id: "owner", role: "owner" },
    { ack: true },
  );
  const memberId = add(
    "vault_member_added",
    {
      account_id: "peer",
      role: "viewer",
      witness: {
        ...signWitness(
          chain.memberWitnessTuple({
            vault_id: "vault",
            account_id: "peer",
            inviter_account_id: "owner",
            role: "viewer",
            issued_at_ms: 1000,
          }),
        ),
        inviter_account_id: "owner",
      },
    },
    { seed: peerSeed },
  );
  add(
    "vault_device_added",
    {
      account_id: "peer",
      device_id: "peer-device",
      device_pubkey: peerKey,
      witness: signWitness(
        chain.deviceWitnessTuple({
          vault_id: "vault",
          account_id: "peer",
          device_id: "peer-device",
          device_pubkey_b64: peerKey,
          issued_at_ms: 1000,
        }),
      ),
    },
    { seed: peerSeed },
  );

  const local = await proof.getLocalMembershipState("vault");
  assert.equal(local.members.get("peer")?.role, "viewer");
  assert.equal(local.devices.get(peerKey)?.removed, false);
  assert.equal(signatureChecks, 5, "first fold verifies all three events and both witnesses");
  await proof.getLocalMembershipState("vault");
  assert.equal(signatureChecks, 5, "unchanged folds reuse successful event and witness checks");
  assert.equal((await proof.getLocalMembershipState("vault", true)).members.has("peer"), false);
  store.prepare("UPDATE event_log SET server_acked_at=2000").run();
  assert.equal(
    (await proof.getLocalMembershipState("vault", true)).members.get("peer")?.role,
    "viewer",
  );
  assert.equal(
    signatureChecks,
    5,
    "publication changes take effect without repeating identical crypto",
  );

  local.members.get("peer").role = "owner";
  local.devices.get(peerKey).removed = true;
  local.members.clear();
  local.conflicts.push({ event_id: "fake", reason: "bad_signature" });
  const fresh = await proof.getLocalMembershipState("vault");
  assert.equal(fresh.members.get("peer")?.role, "viewer");
  assert.equal(fresh.devices.get(peerKey)?.removed, false);
  assert.deepEqual(fresh.conflicts, []);
  assert.equal(signatureChecks, 5, "mutable returned state cannot poison a later fold");

  await setMeta("mesh_server_pubkey_primary", replacementServerKey);
  const rotated = await proof.getLocalMembershipState("vault");
  assert.equal(
    rotated.members.has("peer"),
    false,
    "removed witness pin revokes that admission path",
  );
  assert.equal(signatureChecks, 6, "witness verification against the replacement key is not a hit");
  await setMeta("mesh_server_pubkey_rotation", serverKey);
  assert.equal((await proof.getLocalMembershipState("vault")).members.get("peer")?.role, "viewer");
  assert.equal(signatureChecks, 8, "rotation slot is evaluated against the current pin set");
  await setMeta("mesh_server_pubkey_primary", serverKey);
  await setMeta("mesh_server_pubkey_rotation", "");

  store.prepare("UPDATE vaults SET vault_trust_anchor_pubkey=? WHERE id='vault'").run(peerKey);
  assert.equal((await proof.getLocalMembershipState("vault")).hasGenesis, false);
  store.prepare("UPDATE vaults SET vault_trust_anchor_pubkey=? WHERE id='vault'").run(ownerKey);
  store
    .prepare("UPDATE event_log SET tombstone_reason='bad_signature' WHERE event_id=?")
    .run(genesisId);
  assert.equal((await proof.getLocalMembershipState("vault")).hasGenesis, false);
  store.prepare("UPDATE event_log SET tombstone_reason=NULL WHERE event_id=?").run(genesisId);
  assert.equal((await proof.getLocalMembershipState("vault")).hasGenesis, true);

  // A previously cached, still-valid signature conveys no authority after
  // current removals. Replaying the old proof cannot hide local revocations.
  const oldProof = await proof.buildOwnProofBundle("vault");
  const removalId = add("vault_member_removed", { account_id: "peer" }, { ack: true });
  assert.equal((await proof.getLocalMembershipState("vault")).members.get("peer")?.removed, true);
  const afterRemoval = signatureChecks;
  assert.deepEqual(
    await proof.verifyPeerMembership({
      vaultId: "vault",
      claimedDevicePubkeyB64: peerKey,
      proofEvents: oldProof,
    }),
    { ok: false, reason: "device_removed" },
  );
  assert.equal(
    signatureChecks,
    afterRemoval,
    "cached cryptography still re-folds current revocations",
  );
  store
    .prepare("UPDATE event_log SET tombstone_reason='bad_signature' WHERE event_id=?")
    .run(removalId);
  assert.equal((await proof.getLocalMembershipState("vault")).members.get("peer")?.removed, false);

  // Same event id, altered payload: neither a previous signature result nor
  // a caller's cached proof may authorize a forged owner promotion.
  const originalMember = JSON.stringify(events.get(memberId)!.payload);
  store
    .prepare("UPDATE event_log SET payload_json=? WHERE event_id=?")
    .run(JSON.stringify({ account_id: "peer", role: "owner" }), memberId);
  const tampered = await proof.getLocalMembershipState("vault");
  assert.equal(tampered.members.has("peer"), false);
  assert.equal(
    tampered.conflicts.find((entry: any) => entry.event_id === memberId)?.reason,
    "bad_signature",
  );
  store
    .prepare("UPDATE event_log SET payload_json=? WHERE event_id=?")
    .run(originalMember, memberId);
  assert.equal((await proof.getLocalMembershipState("vault")).members.get("peer")?.role, "viewer");

  add(
    "vault_device_added",
    { account_id: "peer", device_id: "peer-device", device_pubkey: replacementServerKey },
    { ack: true },
  );
  assert.equal(
    (await proof.getLocalMembershipState("vault")).devices.get(replacementServerKey)?.removed,
    false,
  );
  add("vault_device_removed", { device_id: "peer-device" }, { ack: true });
  const removedDevices = await proof.getLocalMembershipState("vault");
  assert.equal(removedDevices.devices.get(peerKey)?.removed, true);
  assert.equal(removedDevices.devices.get(replacementServerKey)?.removed, true);
  assert.equal(removedDevices.members.get("peer")?.removed, false);

  store.prepare("INSERT INTO vaults VALUES('synthetic-vault',?)").run(ownerKey);
  add(
    "vault_member_added",
    { account_id: "owner", role: "owner", backfill_synthetic: 1 },
    { ack: true, vault: "synthetic-vault" },
  );
  assert.equal((await proof.getLocalMembershipState("synthetic-vault")).hasGenesis, true);
  assert.equal(
    (await proof.getLocalMembershipState("synthetic-vault", true)).hasGenesis,
    false,
    "published proof exclusion of a synthetic owner remains effective after its signature is cached",
  );

  // A separate vault/session context shares only mathematical signature
  // results: its current anchor and exact vault binding remain authoritative.
  store.prepare("INSERT INTO vaults VALUES('other-vault',?)").run(peerKey);
  assert.equal((await proof.getLocalMembershipState("other-vault")).hasGenesis, false);
  assert.equal((await proof.getLocalMembershipState("vault")).members.get("peer")?.role, "viewer");
  store.prepare("UPDATE vaults SET vault_trust_anchor_pubkey=NULL WHERE id='vault'").run();
  assert.equal(await proof.getLocalMembershipState("vault"), null);

  let nativeChecks = 0;
  const verifyNative = (items: any[]) =>
    items.map((item) => {
      nativeChecks++;
      const canonical = (text: string) => Buffer.from(text, "base64").toString("base64") === text;
      if (![item.messageBase64, item.signatureBase64, item.publicKeyBase64].every(canonical))
        return false;
      return ed.verify(
        Uint8Array.from(Buffer.from(item.signatureBase64, "base64")),
        Uint8Array.from(Buffer.from(item.messageBase64, "base64")),
        Uint8Array.from(Buffer.from(item.publicKeyBase64, "base64")),
      );
    });
  nativeBatch = async (items) => verifyNative(items);
  store.prepare("INSERT INTO vaults VALUES('native-vault',?)").run(ownerKey);
  const nativeGenesis = add(
    "vault_member_added",
    { account_id: "owner", role: "owner" },
    { ack: true, vault: "native-vault" },
  );
  const beforeNative = signatureChecks;
  assert.equal((await proof.getLocalMembershipState("native-vault")).hasGenesis, true);
  assert.equal(nativeChecks, 1);
  assert.equal(
    signatureChecks,
    beforeNative,
    "a cold native positive avoids synchronous Noble verification",
  );
  const looseSignature = ` \n${events.get(nativeGenesis)!.event_sig_b64!.replace(/=+$/, "")}`;
  store
    .prepare("UPDATE event_log SET event_sig_b64=? WHERE event_id=?")
    .run(looseSignature, nativeGenesis);
  assert.equal((await proof.getLocalMembershipState("native-vault")).hasGenesis, true);
  assert.equal(
    signatureChecks,
    beforeNative + 1,
    "native refusal of whitespace/unpadded base64 preserves Noble's accepted input",
  );

  store.prepare("INSERT INTO vaults VALUES('native-witness-vault',?)").run(ownerKey);
  add(
    "vault_member_added",
    { account_id: "owner", role: "owner" },
    { ack: true, vault: "native-witness-vault" },
  );
  add(
    "vault_member_added",
    {
      account_id: "peer",
      role: "viewer",
      witness: {
        ...signWitness(
          chain.memberWitnessTuple({
            vault_id: "native-witness-vault",
            account_id: "peer",
            inviter_account_id: "owner",
            role: "viewer",
            issued_at_ms: 1000,
          }),
        ),
        inviter_account_id: "owner",
      },
    },
    { seed: peerSeed, ack: true, vault: "native-witness-vault" },
  );
  add(
    "vault_device_added",
    {
      account_id: "peer",
      device_id: "peer-device",
      device_pubkey: peerKey,
      witness: signWitness(
        chain.deviceWitnessTuple({
          vault_id: "native-witness-vault",
          account_id: "peer",
          device_id: "peer-device",
          device_pubkey_b64: peerKey,
          issued_at_ms: 1000,
        }),
      ),
    },
    { seed: peerSeed, ack: true, vault: "native-witness-vault" },
  );
  const beforeWitnessNoble = signatureChecks,
    beforeWitnessNative = nativeChecks;
  const warmWitness = await proof.getLocalMembershipState("native-witness-vault");
  assert.equal(warmWitness.members.get("peer")?.role, "viewer");
  assert.equal(warmWitness.devices.get(peerKey)?.removed, false);
  assert.equal(
    nativeChecks - beforeWitnessNative,
    5,
    "event, member-witness and device-witness exact bytes are preverified",
  );
  assert.equal(
    signatureChecks,
    beforeWitnessNoble,
    "cold ordinary witness paths perform no synchronous Noble math",
  );
  await setMeta("mesh_server_pubkey_primary", replacementServerKey);
  const beforeMismatch = signatureChecks;
  assert.equal(
    (await proof.getLocalMembershipState("native-witness-vault")).members.has("peer"),
    false,
  );
  assert.equal(
    signatureChecks,
    beforeMismatch + 1,
    "a native witness-pin mismatch still reaches Noble and refuses authority",
  );
  await setMeta("mesh_server_pubkey_primary", serverKey);

  const grant: ownershipTransfer.OwnershipTransferGrant = {
    domain: ownershipTransfer.OWNERSHIP_GRANT_DOMAIN,
    transfer_id: "20000000-0000-4000-8000-000000000001",
    vault_id: "20000000-0000-4000-8000-000000000002",
    from_account_id: "20000000-0000-4000-8000-000000000003",
    recipient_email_normalized: "recipient@example.com",
    demote_self_to: "editor",
    issued_at_ms: 1000,
    expires_at_ms: 2000,
  };
  const grantBytes = ownershipTransfer.ownershipTransferGrantBytes(grant, eventSig.canonicalize);
  const grantSignature = b64(ed.sign(grantBytes, ownerSeed));
  const grantEvent: chain.MembershipEventLike = {
    ...events.get(nativeGenesis)!,
    event_id: "ownership-grant-event",
    vault_id: grant.vault_id,
    payload: {
      account_id: "recipient",
      role: "owner",
      ownership_transfer: {
        authorization: { grant, sig_b64: grantSignature, signer_device_pubkey: ownerKey },
      },
    },
  };
  grantEvent.event_sig_b64 = b64(ed.sign(eventSig.canonicalizeEvent(grantEvent), ownerSeed));
  const beforeGrantNoble = signatureChecks,
    beforeGrantNative = nativeChecks;
  await runtime.prewarmMembershipSignatures([grantEvent], [serverKey]);
  assert.equal(runtime.runtimeChainCrypto.verifyRaw(grantBytes, grantSignature, ownerKey), true);
  assert.equal(signatureChecks, beforeGrantNoble);
  assert.equal(
    nativeChecks - beforeGrantNative,
    2,
    "ownership authorization uses the existing parsed grant-byte constructor",
  );
  assert.equal(
    ownershipTransfer.verifyOwnershipTransferEvent(
      grantEvent,
      [serverKey],
      runtime.runtimeChainCrypto,
    ),
    null,
    "warming a valid grant signature cannot replace missing owner-transfer receipt authority",
  );

  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  nativeBatch = async (items) => {
    entered();
    await gate;
    return verifyNative(items);
  };
  store.prepare("INSERT INTO vaults VALUES('race-vault',?)").run(ownerKey);
  add(
    "vault_member_added",
    { account_id: "owner", role: "owner" },
    { ack: true, vault: "race-vault" },
  );
  const racing = proof.getLocalMembershipState("race-vault");
  await started;
  store.prepare("UPDATE vaults SET vault_trust_anchor_pubkey=NULL WHERE id='race-vault'").run();
  release();
  assert.equal(await racing, null, "anchor state is reloaded after the native await");

  let enteredRemoval!: () => void, releaseRemoval!: () => void;
  const removalStarted = new Promise<void>((resolve) => {
    enteredRemoval = resolve;
  });
  const removalGate = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  nativeBatch = async (items) => {
    enteredRemoval();
    await removalGate;
    return verifyNative(items);
  };
  store.prepare("UPDATE vaults SET vault_trust_anchor_pubkey=? WHERE id='vault'").run(ownerKey);
  add("vault_member_added", { account_id: "new-peer", role: "viewer" }, { ack: true });
  const beforeRemovalAwait = proof.getLocalMembershipState("vault");
  await removalStarted;
  add("vault_member_removed", { account_id: "new-peer" }, { ack: true });
  releaseRemoval();
  assert.equal(
    (await beforeRemovalAwait).members.get("new-peer")?.removed,
    true,
    "removals received during native verification override the earlier input snapshot",
  );
  store.close();
  console.log(
    "crypto cache proof: fresh authority, publication, key rotation, tampering and revocations passed",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
