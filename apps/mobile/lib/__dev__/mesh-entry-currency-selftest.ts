// Real mesh handshake/delta entry points with synthetic SQLite and Ed25519 keys.
// No native radio, phone data, network requests, or release builds.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2";
import ts from "typescript";
import * as errors from "../mesh/errors";
import * as hlc from "../hlc";
import * as planner from "../replication/planner";
import type { MeshConnection } from "../mesh/transport-interface";
import type { HelloMessage, PopProofMessage, WireMeshEvent } from "../mesh/anti-entropy";

(globalThis as { __DEV__?: boolean }).__DEV__ = false;
ed.etc.sha512Sync = (...messages) => sha512(ed.etc.concatBytes(...messages));
const ownKey = new Uint8Array(32).fill(1);
const peerKey = new Uint8Array(32).fill(2);
const peerPub = ed.getPublicKey(peerKey);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const VAULT = "synthetic-vault";
const failures: string[] = [];
const ingested: string[] = [];
const fixture = new Database(":memory:");
fixture.exec(`CREATE TABLE event_log (
  event_id TEXT PRIMARY KEY, event_type TEXT, vault_id TEXT, target_id TEXT,
  relationship_id TEXT, hlc_physical_ms INTEGER, hlc_logical INTEGER,
  hlc_device_id TEXT, device_id TEXT, actor_account_id TEXT, payload_json TEXT,
  payload_schema INTEGER, event_sig_b64 TEXT, signer_device_pubkey TEXT,
  author_seq INTEGER, tombstone_reason TEXT, rejected_at INTEGER
);
CREATE TABLE entries (id TEXT PRIMARY KEY, vault_id TEXT, currency TEXT, original_currency TEXT, is_deleted INTEGER)`);
const sqlite = {
  getFirstAsync: async (sql: string, ...args: unknown[]) =>
    fixture.prepare(sql).get(...args) ?? null,
  getAllAsync: async (sql: string, ...args: unknown[]) => fixture.prepare(sql).all(...args),
};
const mutex = { runExclusive: async (work: () => unknown) => work() };
const mocks: Record<string, unknown> = {
  "./_ed25519-setup": {},
  "@noble/ed25519": ed,
  "@noble/hashes/sha2": { sha256 },
  "expo-crypto": { getRandomBytesAsync: async (size: number) => randomBytes(size) },
  "../hlc": hlc,
  "../db-tx": {
    getDb: async () => sqlite,
    getInstallIdSync: () => "own-device",
    getAccountIdSync: () => "own-account",
  },
  "../trust/proof": {
    PROOF_BUNDLE_CAP: 1000,
    buildOwnProofBundle: async () => [],
    verifyPeerMembership: async () => ({
      ok: true,
      device_id: "peer-device",
      account_id: "peer-account",
      role: "editor",
    }),
  },
  "../events": { isKnownEventType: () => true },
  "../vault-roles": { parseVaultRole: () => "editor" },
  "../replication/planner": planner,
  "./errors": {
    ...errors,
    emitMeshFailure: (event: { kind: string }) => failures.push(event.kind),
  },
  "./aead": {
    X25519_PUBKEY_BYTES: 32,
    generateEphemeralKeyPair: () => ({ privateKey: randomBytes(32), publicKey: randomBytes(32) }),
    deriveSessionAead: () => ({}),
    wipeEphemeralPriv: (key: Uint8Array) => key.fill(0),
  },
  "../trust/revocation": { isRevoked: async () => false },
  "./device-key": {
    ensureDeviceKey: async () => ({
      pubkey_b64: Buffer.from(ed.getPublicKey(ownKey)).toString("base64"),
    }),
    signWithDeviceKey: async (message: Uint8Array) => ed.sign(message, ownKey),
  },
  "./btc-peers": { isDialableMac: () => false },
  "../trust/account-id": {},
  "./local-pair": {
    getLocalPairNonceForVault: async () => null,
    clearLocalPairNonceForVault: async () => {},
  },
  "../db": { getLocalSelf: async () => null },
  "../../modules/kaata-bt-classic": { getLocalAddress: async () => null },
  "../projection/sweep": { sweepMutex: mutex, scheduleSweep: () => {} },
  "../projection/index": { applyEventMutex: mutex },
  "../projection/ingest-row": {},
  "../ingest-types": {
    verifyAndIngest: async (event: { event_id: string }) => {
      ingested.push(event.event_id);
      return { kind: "ingested" };
    },
  },
};
const exports: any = {};
const source = readFileSync(require.resolve("../mesh/anti-entropy"), "utf8");
const code = ts.transpileModule(
  source +
    `
  export const testProtocol = { buildPopMessageV3, buildEntryCurrencyEditPopMessage };
`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
new Function("require", "exports", "console", code)(
  (name: string) => {
    assert.ok(name in mocks, `Unexpected mesh dependency ${name}`);
    return mocks[name];
  },
  exports,
  { ...console, log: () => {} },
);
const mesh = exports as typeof import("../mesh/anti-entropy") & {
  testProtocol: {
    buildPopMessageV3: (
      ids: string[],
      nonce: string,
      ownPub: Uint8Array,
      peerPub: Uint8Array,
    ) => Uint8Array;
    buildEntryCurrencyEditPopMessage: (pop: Uint8Array) => Uint8Array;
  };
};

function addEvent(
  seq: number,
  changes: unknown = { note: "ordinary edit" },
  options: {
    vault?: string;
    tombstone?: string;
    rejected?: number;
    authorSeq?: number | null;
  } = {},
) {
  fixture
    .prepare(`INSERT INTO event_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      `event-${seq}`,
      "entry_amended",
      options.vault ?? VAULT,
      "entry",
      "relationship",
      seq,
      0,
      "own-device",
      "own-device",
      "own-account",
      JSON.stringify({ changes }),
      1,
      "signed",
      b64(ed.getPublicKey(ownKey)),
      options.authorSeq === undefined ? seq : options.authorSeq,
      options.tombstone ?? null,
      options.rejected ?? null,
    );
}

type PeerOptions = {
  kind?: MeshConnection["kind"];
  feature?: "legacy" | "signed" | "unsigned" | "bad-signature" | "replayed" | "stripped";
  frontier?: Record<string, number>;
  incoming?: WireMeshEvent[];
  onDelta?: () => void;
};
function connection(options: PeerOptions = {}) {
  const sent: any[] = [];
  let ownHello: HelloMessage;
  const peerEphemeral = randomBytes(32);
  const peerHello: HelloMessage = {
    type: "hello",
    v: 3,
    capabilities:
      options.feature === "legacy" || options.feature === "stripped"
        ? ["multi-currency-v1"]
        : ["multi-currency-v1", "entry-currency-edit-v1"],
    pop_nonce: b64(randomBytes(32)),
    ephemeral_x25519_pubkey: b64(peerEphemeral),
    device_pubkey_b64: Buffer.from(peerPub).toString("base64"),
    device_id: "peer-device",
    account_id: "peer-account",
    proof_bundle: [],
  };
  let phase = 0;
  const conn = {
    kind: options.kind ?? "memory",
    sendJSON: async (message: any) => {
      sent.push(message);
      if (message.type === "hello") ownHello = message;
    },
    recvJSON: async () => {
      if (phase++ === 0) return peerHello;
      if (phase === 2) {
        const transcript = mesh.testProtocol.buildPopMessageV3(
          [],
          ownHello.pop_nonce,
          peerEphemeral,
          new Uint8Array(Buffer.from(ownHello.ephemeral_x25519_pubkey, "base64url")),
        );
        const proof: PopProofMessage = {
          type: "pop_proof",
          v: 3,
          sig: b64(ed.sign(transcript, peerKey)),
        };
        if (["signed", "bad-signature", "replayed", "stripped"].includes(options.feature ?? "")) {
          const featureTranscript =
            options.feature === "replayed"
              ? mesh.testProtocol.buildPopMessageV3(
                  [],
                  "different-session-nonce",
                  peerEphemeral,
                  new Uint8Array(Buffer.from(ownHello.ephemeral_x25519_pubkey, "base64url")),
                )
              : transcript;
          proof.entry_currency_edit_sig = b64(
            ed.sign(
              mesh.testProtocol.buildEntryCurrencyEditPopMessage(featureTranscript),
              options.feature === "bad-signature" ? ownKey : peerKey,
            ),
          );
        }
        return proof;
      }
      const latest = sent.at(-1);
      if (latest.type === "vector") {
        return { type: "vector", v: 3, vault_id: VAULT, frontier: options.frontier ?? {} };
      }
      options.onDelta?.();
      return { type: "delta", v: 3, events: options.incoming ?? [], has_more: false };
    },
    installAead: () => {},
    close: async () => {},
  } as unknown as MeshConnection;
  return { conn, sent, peerHello };
}

function reset() {
  fixture.exec("DELETE FROM event_log");
  fixture.exec("DELETE FROM entries");
  failures.length = 0;
  ingested.length = 0;
}

async function main() {
  // Shared with MeshEntryCurrencyCompatibilityTest.kt: both implementations
  // must produce and accept these exact bytes/signature, not only self-verify.
  const parityPop = mesh.testProtocol.buildPopMessageV3(
    ["evt-b", "evt-a", "evt-c"],
    "nonce123",
    new Uint8Array(32).fill(0x33),
    new Uint8Array(32).fill(0x44),
  );
  const parityMessage = mesh.testProtocol.buildEntryCurrencyEditPopMessage(parityPop);
  assert.equal(
    Buffer.from(parityMessage).toString("hex"),
    "6b616174612d656e7472792d63757272656e63792d656469742d7631" +
      "6b616174612d706f702d76331ad368e097d0d51fd3c67d1c86d2ec65736bc07d4cb2e0afaaa0ada19051c7d3" +
      "6e6f6e6365313233" +
      "33".repeat(32) +
      "44".repeat(32),
  );
  const paritySignature =
    "Gc3tLgM8gLztUi-SMc_wk2DAmLMja_-1L4pzJg5sbh-PcL1YVoPey1A7jj5QYP_BRyWLZig61iEGCOcsgOxZDg";
  assert.equal(b64(ed.sign(parityMessage, peerKey)), paritySignature);
  assert.ok(
    ed.verify(new Uint8Array(Buffer.from(paritySignature, "base64url")), parityMessage, peerPub),
  );
  assert.equal(mesh.WIRE_VERSION, 3, "ordinary books retain the existing wire version");
  for (const kind of ["memory", "ble", "lan", "btc"] as const) {
    reset();
    addEvent(1);
    const ordinary = connection({ kind, feature: "legacy" });
    assert.equal((await mesh.runAntiEntropy(ordinary.conn, { vaultId: VAULT })).sent, 1);
    assert.equal(failures.length, 0, `${kind}: ordinary books still sync with old apps`);
    reset();
    addEvent(1, { currency: "USD", amount_minor: 123 });
    const affected = connection({ kind, feature: "legacy", frontier: { "own-device": 1 } });
    await assert.rejects(
      mesh.runAntiEntropy(affected.conn, { vaultId: VAULT }),
      /Update the other phone/,
    );
    assert.equal(
      affected.sent.some((message) => message.type === "delta"),
      false,
      `${kind}: an already-advertised amendment still blocks the entire affected book`,
    );
    assert.deepEqual(failures, ["peer_outdated"]);
  }

  for (const feature of ["unsigned", "bad-signature", "replayed", "stripped"] as const) {
    reset();
    addEvent(1, { currency: "USD", amount_minor: 123 });
    const peer = connection({ feature });
    await assert.rejects(
      mesh.runAntiEntropy(peer.conn, { vaultId: VAULT }),
      /Update the other phone/,
    );
    assert.equal(
      peer.sent.some((message) => message.type === "delta"),
      false,
      `${feature}: unproven capability cannot authorize currency edits`,
    );
  }

  reset();
  addEvent(1, { currency: "USD", amount_minor: 123 });
  const updated = connection({ feature: "signed" });
  assert.equal(
    (await mesh.runAntiEntropy(updated.conn, { vaultId: VAULT })).sent,
    1,
    "updated peers with authenticated feature support receive currency amendments",
  );
  const sentHello = updated.sent.find((message) => message.type === "hello") as HelloMessage;
  const sentProof = updated.sent.find((message) => message.type === "pop_proof") as PopProofMessage;
  const ourPop = mesh.testProtocol.buildPopMessageV3(
    [],
    updated.peerHello.pop_nonce,
    new Uint8Array(Buffer.from(sentHello.ephemeral_x25519_pubkey, "base64url")),
    new Uint8Array(Buffer.from(updated.peerHello.ephemeral_x25519_pubkey, "base64url")),
  );
  assert.ok(
    ed.verify(
      new Uint8Array(Buffer.from(sentProof.sig, "base64url")),
      ourPop,
      ed.getPublicKey(ownKey),
    ),
    "ordinary PoP remains valid for old peers",
  );
  assert.ok(
    ed.verify(
      new Uint8Array(Buffer.from(sentProof.entry_currency_edit_sig!, "base64url")),
      mesh.testProtocol.buildEntryCurrencyEditPopMessage(ourPop),
      ed.getPublicKey(ownKey),
    ),
    "our feature support is signed over this exact session",
  );

  reset();
  addEvent(1, { currency: "USD", amount_minor: 123 }, { vault: "different-vault" });
  addEvent(2, { currency: "USD", amount_minor: 123 }, { tombstone: "bad_signature" });
  addEvent(3, { currency: "USD", amount_minor: 123 }, { rejected: 1 });
  await mesh.runAntiEntropy(connection({ feature: "legacy" }).conn, { vaultId: VAULT });
  assert.equal(
    failures.length,
    0,
    "other books and refused events do not activate the feature gate",
  );
  fixture.prepare("INSERT INTO entries VALUES(?,?,?,?,?)").run("ordinary", VAULT, "AFN", "", 0);
  await mesh.runAntiEntropy(connection({ feature: "legacy" }).conn, { vaultId: VAULT });
  assert.equal(failures.length, 0, "empty original-currency metadata is not a feature marker");

  reset();
  addEvent(2, { currency: "USD", amount_minor: 123 }, { authorSeq: null });
  await assert.rejects(
    mesh.runAntiEntropy(connection({ feature: "legacy" }).conn, { vaultId: VAULT }),
    /Update the other phone/,
    "an amendment outside the relayable frontier still affects the book",
  );

  for (const deleted of [0, 1]) {
    reset();
    fixture
      .prepare("INSERT INTO entries VALUES(?,?,?,?,?)")
      .run("restored", VAULT, "AFN", "AFN", deleted);
    await assert.rejects(
      mesh.runAntiEntropy(connection({ feature: "legacy" }).conn, { vaultId: VAULT }),
      /Update the other phone/,
      "snapshot metadata protects reverted/deleted entries without amendment history",
    );
  }

  reset();
  addEvent(1);
  const warm = connection({ feature: "legacy" });
  await assert.rejects(
    mesh.runAntiEntropySession(
      warm.conn,
      { vaultId: VAULT },
      {
        onEstablished: () => addEvent(2, { currency: "USD", amount_minor: 123 }),
      },
    ),
    /Update the other phone/,
  );
  assert.equal(
    warm.sent.some((message) => message.type === "delta"),
    false,
    "a feature arriving after a warm connection handshake is checked before its first delta",
  );

  reset();
  for (let seq = 1; seq <= 501; seq++) addEvent(seq);
  let added = false;
  const ongoing = connection({
    feature: "legacy",
    onDelta: () => {
      if (!added) {
        added = true;
        addEvent(502, { currency: "USD", amount_minor: 123 });
      }
    },
  });
  await assert.rejects(
    mesh.runAntiEntropy(ongoing.conn, { vaultId: VAULT }),
    /Update the other phone/,
  );
  assert.equal(
    ongoing.sent.filter((message) => message.type === "delta").length,
    1,
    "an edit arriving while exchanging deltas stops subsequent batches",
  );
  assert.equal(ingested.length, 0);

  reset();
  const inbound: WireMeshEvent = {
    event_id: "incoming",
    event_type: "entry_amended",
    vault_id: VAULT,
    target_id: "entry",
    relationship_id: "relationship",
    hlc: { pms: 1, l: 0, did: "peer-device" },
    device_id: "peer-device",
    author_seq: 1,
    actor_account_id: "peer-account",
    payload: { changes: { currency: "USD", amount_minor: 123 } },
    schema_version: 1,
  };
  await assert.rejects(
    mesh.runAntiEntropy(connection({ feature: "legacy", incoming: [inbound] }).conn, {
      vaultId: VAULT,
    }),
    /Update the other phone/,
  );
  assert.equal(
    ingested.length,
    0,
    "an unproven peer cannot relay a currency amendment into the book",
  );
  reset();
  await mesh.runAntiEntropy(
    connection({
      feature: "legacy",
      incoming: [{ ...inbound, payload: { changes: { note: "ordinary edit" } } }],
    }).conn,
    { vaultId: VAULT },
  );
  assert.deepEqual(
    ingested,
    ["incoming"],
    "ordinary edits from older peers continue to be ingested",
  );
  console.log(
    "PASS: mesh currency-edit compatibility, authenticated capabilities, all transports and warm-session arrival",
  );
}
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fixture.close());
