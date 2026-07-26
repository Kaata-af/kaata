// apps/mobile/lib/mesh/anti-entropy.ts
//
// HLC-based anti-entropy delta swap over an established MeshConnection.
//
// Design D-ANTI-ENTROPY (M2c/M3.5, chain-only after M4):
//   1. Handshake — each side presents its membership-proof bundle + chain
//      identity (device pubkey/id/account). The verifier folds
//      (peer proof ∪ local events) against the vault anchor
//      (verifyPeerMembership) — a removal we hold locally wins. Then
//      PROOF-OF-POSSESSION (v3): each side challenges the peer with a
//      32-byte CSPRNG nonce; the peer signs (POP_DOMAIN_V3 ||
//      bundle-commitment || nonce || both ephemeral pubkeys) with their
//      device privkey and we verify against their CLAIMED device pubkey,
//      which the chain verdict bound to an account. Without this step a
//      proof bundle observed off the wire would be replayable from any
//      device.
//   2. Summary  — each side sends its per-author RELAYABLE contiguous
//      author_seq frontier (version vector) for this vault.
//   3. Delta    — each side streams the author_seq ranges the other lacks,
//                 in order, in 500-event batches, until has_more=false on
//                 both sides.
//   4. Disconnect.
//
// Lawful-at-HLC ACL on mesh: the membership chain is folded at the event's
// own HLC (role-at-that-HLC), so a removal the verifier holds refuses the
// peer at handshake AND at every batch boundary (reverifyPeerWindow).
// ACL re-application happens locally — applyEvent is the single source of
// truth, and the server's PullEvents path re-stamps actor_account_id
// retroactively when this device next reaches the server.
//
// Transport contract:
//   - MeshConnection (per transport-interface.ts) exposes sendJSON /
//     recvJSON / close. Same shape for BLE (Phase 6 primary) and WebRTC
//     (Phase 6 wifi-upgrade fallback).
//   - WebRTC DTLS gives us authenticated transport-level encryption FREE;
//     we do not double-encrypt at the application layer on that transport.
//   - BLE is a different story: the BLE link layer is UNENCRYPTED unless
//     OS-level bonding is used (which Kaata explicitly avoids — the "Pair
//     this device?" dialog UX cost is too high). The Phase 6 follow-up
//     phase implements per-session X25519 ECDH (key = ECDH(own_ephemeral_priv,
//     peer_ephemeral_pub) → HKDF-SHA512 → ChaCha20-Poly1305 per
//     frame) inside transport-ble.ts. UNTIL that lands, BLE wire traffic
//     is plaintext over the air — see SECURITY CALLOUT in the PR.
//
// Idempotence:
//   - applyEvent's INSERT OR IGNORE on event_id makes delta application
//     idempotent. A peer that re-sends events we already have is a no-op.
//   - Cursors are NOT stored; the next handshake recomputes the max-HLC
//     summary from scratch. Cheap (single GROUP BY query per vault).
//
// Edge cases handled:
//   - Membership change mid-sync: re-checked at each batch boundary by
//     re-folding (peer proof ∪ local events), so a removal that arrived in
//     THIS session's delta stream refuses the peer at the next boundary.
//   - Out-of-order arrival: applyEvent handles via HLC; no reorder buffer.
//   - Partial application: each applyEvent is its own transaction.
//   - Asymmetric volume: separate send / receive batch budgets so a peer
//     with 100k events to send isn't aborted by a peer with 100.

// Side-effect import: ensures the @noble/ed25519 sha512Sync + randomBytes
// shims are installed before any ed.verify/sign call in this module.
// Engineering critique #3: defensive — anti-entropy.ts is reached from
// the mesh barrel + every background-task entry point, and without this
// the shim relies on transitive import order through other modules.
import "./_ed25519-setup";
import * as ed from "@noble/ed25519";
// sha2 (not the deprecated per-hash deep import) — same function, current
// module layout in the installed @noble/hashes.
import { sha256 } from "@noble/hashes/sha2";
import * as Crypto from "expo-crypto";

import { compareHLC, type HLC, tickReceive, serializeHLC, deserializeHLC } from "../hlc";
import { getDb } from "../db-tx";
import { getAppMetaInTx, setAppMetaInTx, getInstallIdSync, getAccountIdSync } from "../db-tx";
import {
  buildOwnProofBundle,
  getLocalMembershipState,
  verifyPeerMembership,
  PROOF_BUNDLE_CAP,
} from "../trust/proof";
import type { MembershipEventLike } from "../trust/chain";
import type { LedgerEvent, VaultRole } from "../events";
import { isKnownEventType } from "../events";
import { parseVaultRole } from "../vault-roles";
// M3.5: the pure version-vector engine (transport-agnostic, bun-tested). The
// mesh delta protocol is now its first load-bearing consumer.
import {
  computeContiguous,
  planRangesToSend,
  type SeqRange,
  type Vector,
} from "../replication/planner";
import type {
  IngestContext as IngestContextType,
  IngestVerdict as IngestVerdictType,
} from "../ingest-types";

// HLC frontier app_meta key — duplicated as a string literal because
// projection/index.ts keeps the constant private. Single source of
// truth is projection/index.ts:46; if that changes, change here too.
const HLC_LAST_KEY = "hlc_last";

import {
  MeshHandshakeError,
  MeshVMCRevokedError,
  MeshTransportError,
  emitMeshFailure,
  type MeshFailureEvent,
} from "./errors";
import {
  generateEphemeralKeyPair,
  deriveSessionAead,
  wipeEphemeralPriv,
  X25519_PUBKEY_BYTES,
  type EphemeralKeyPair,
  type BleAeadContext,
} from "./aead";
import { isRevoked } from "../trust/revocation";
import { ensureDeviceKey, getDevicePubkey, signWithDeviceKey } from "./device-key";
import { isDialableMac } from "./btc-peers";
import { buildLocalAccountId } from "../trust/account-id";
import type { MeshConnection } from "./transport-interface";

// Domain-separation tag for the proof-of-possession signature. Prevents
// the signed challenge from being usable as a signature on any other Kaata
// message that might be signed by the same device key in the future.
//
// The signed transcript binds the signer's OWN presented proof bundle (as
// a sha256 over its canonical event_id list), the verifier's challenge
// nonce, and both ephemeral X25519 pubkeys. The ephemeral-pubkey binding
// closes the Hello-mutation seam: without it a MITM could substitute its
// own ephemeral pubkey in transit, the peer signs a PoP that only covered
// nonces + bundle, and the AEAD key would be derived against the
// attacker's pub — leaking traffic. The bundle commitment stops a MITM
// from splicing a different proof set under a recorded signature. Verified
// against the peer's CLAIMED device_pubkey_b64, which the chain verdict
// bound to an account.
const POP_DOMAIN_V3 = "kaata-pop-v3";

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

// WIRE_VERSION 3 is the membership-chain handshake (M2c,
// docs/m2-membership-chain.md §7) over the author_seq VERSION-VECTOR
// protocol (M3.5): the summary is a per-author contiguous-frontier vector
// (not max_hlc_per_device) and the delta streams author_seq ranges in
// order. Full cutover, no backwards-compat (no users yet): pre-v3 peers
// (incl. the retired v1 VMC handshake) are refused at the version gate
// with an actionable "peer_outdated" failure event.
export const WIRE_VERSION = 3;
const SUPPORTED_WIRE_VERSIONS: ReadonlySet<number> = new Set([3]);

export type HelloMessage = {
  type: "hello";
  // Wire version (3 = membership-chain + author_seq version-vector). Typed
  // as number (not the literal) so we can detect + reject older peers at
  // the version gate with an actionable "peer_outdated" message.
  v: number;
  capabilities: string[];
  // 32-byte CSPRNG nonce as URL-safe base64 (no padding). The peer must
  // return its signature over the v3 PoP transcript (POP_DOMAIN_V3 ||
  // bundle-commitment || this_nonce || both ephemeral pubkeys) in their
  // PopProofMessage. Without this proof-of-possession round, a chain proof
  // observed off the wire would be replayable from any device.
  pop_nonce: string;
  // Phase 6 follow-up: ephemeral X25519 public key (32 bytes, base64url).
  // Combined with the peer's ephemeral pubkey + both pop_nonces it
  // derives a per-session ChaCha20-Poly1305 key for the BLE transport.
  // Mandatory since v0.5.2 — peers without it are rejected as "too old"
  // because the BLE link must NOT carry plaintext ledger data.
  ephemeral_x25519_pubkey: string;
  // pair_nonce binding (chain pair path, docs/m2-membership-chain.md §4
  // row 2).
  //
  // When a joiner is doing their VERY FIRST handshake with a vault they
  // just paired into, they have NO chain yet — they send an EMPTY
  // proof_bundle plus the QR's shop_mode_token echoed here. The owner
  // admits the handshake IFF this nonce exactly matches a live unconsumed
  // pair token for THIS vault, then EMITS the admission events itself
  // (owner-signed vault_member_added + vault_device_added). This converts
  // the surface from "any stranger in BLE range during the 5-min window"
  // to "specifically the device that scanned the QR." Without it, a
  // stranger could harvest vault_id from any plaintext Hello and ride the
  // pair window.
  //
  // Optional on the wire so a peer that's ALREADY in the chain (subsequent
  // handshakes) omits it — its proof bundle covers admission.
  pair_nonce?: string;
  // --- M2c Hello v2 fields (membership-chain handshake) -------------------
  // All optional on the wire so v:1 peers parse cleanly; the version
  // gate + per-field validation make them mandatory on the chain path.
  //
  // Sender's device Ed25519 pubkey (standard base64, 32 bytes raw) —
  // the identity the chain verdict binds to an account, and the key the
  // v3 PoP is verified against.
  device_pubkey_b64?: string;
  // Sender's device id (install id). Cross-checked against the chain's
  // device-registry binding for the claimed pubkey; on the pair path
  // it's the id the owner binds via vault_device_added.
  device_id?: string;
  // Sender's claimed account id. For local-only joiners this is the
  // 'local:<...>' sentinel (buildLocalAccountId over the vault anchor).
  // On the chain path the verdict's account wins (this field is only
  // load-bearing for the pair-admission emission, where no chain entry
  // exists yet).
  account_id?: string;
  // Membership-proof bundle (docs §3): ordinary membership events, same
  // wire shape as delta events. Verified via verifyPeerMembership over
  // (bundle ∪ local events), then ingested through the normal
  // verifyAndIngest pipeline — this is how chains gossip. Empty for a
  // freshly-paired joiner (pair_nonce covers admission-in-progress).
  proof_bundle?: WireMeshEvent[];
  // M-BTC-3.2 follow-up: sender's display name (getLocalSelf().name). On the
  // pair path the OWNER has no other way to learn the joiner's name (the QR is
  // one-directional), so it stamps this into the joiner's vault_member_added —
  // otherwise the owner's Members tab renders the joiner's role label as their
  // name. Optional; sent pre-AEAD, same exposure class as account_id/device_id
  // already in this Hello.
  display_name?: string;
  // Sender's REAL Bluetooth Classic MAC (getLocalAddress, Briar's 3-method).
  // Carried here because the OS masks the accept-side socket address to
  // 02:00:00:00:00:00 on API 31+ — so the device that only ACCEPTS a steady
  // RFCOMM connection (the owner, post-pair) can never learn the dialer's real
  // MAC from the socket and thus can never dial BACK. The masking is purely an
  // OS-socket concern; this application-layer field is unaffected. Read ONLY
  // after verifyPeerChain authenticates the peer (same gate + exposure class as
  // device_id/account_id/display_name above), then cached via addKnownPeer so
  // BOTH peers become dialers and BT-only sync establishes regardless of which
  // side is foregrounded. Optional + validated against isDialableMac on receipt.
  bt_mac?: string;
};

export type PopProofMessage = {
  type: "pop_proof";
  v: typeof WIRE_VERSION;
  // ed25519 signature (base64) by the peer's device privkey over the v3 PoP
  // transcript (POP_DOMAIN_V3 || bundle-commitment || our_nonce || both
  // ephemeral pubkeys). Verified against the peer's claimed device_pubkey,
  // which the chain verdict (or the live pair token) bound to an account.
  sig: string;
};

// M3.5: the summary is now a per-author VERSION VECTOR — for each author
// device, the highest RELAYABLE contiguous author_seq we hold (see
// computeRelayableVector). The peer plans `planRangesToSend(itsVector, ourVector)`
// and streams exactly the author_seq ranges we lack. Replaces max_hlc_per_device.
export type VectorSummaryMessage = {
  type: "vector";
  v: typeof WIRE_VERSION;
  vault_id: string;
  /** author device_id → highest relayable contiguous author_seq held. */
  frontier: Record<string, number>;
};

export type WireMeshEvent = {
  event_id: string;
  event_type: string;
  vault_id: string;
  target_id: string | null;
  relationship_id: string | null;
  hlc: HLC;
  device_id: string;
  // M3.5: the AUTHOR's canonical per-(vault,device) sequence, forwarded
  // VERBATIM by every honest relay (read straight from event_log.author_seq,
  // never re-minted). The receiver persists it (with a slot pre-check) so its
  // version vector advances contiguously. The DELTA path always carries a real
  // number (it selects WHERE author_seq IS NOT NULL); null is reachable only
  // via the membership proof bundle (a row whose seq was slot-sacrificed).
  author_seq: number | null;
  actor_account_id: string | null;
  payload: unknown;
  schema_version: number;
  // Phase 8 D-ROLE-ENFORCEMENT-MOBILE: Ed25519 signature over the
  // canonical event envelope+payload (see lib/event-sig.ts). Required
  // for the receiving peer's role-gate to authenticate the actor.
  // OPTIONAL on the wire (legacy peers may send unsigned events that
  // pre-date this schema version); checkRoleForEvent refuses unsigned
  // remote events at projection time. Older clients that ignore the
  // field are forward-compatible — their unsigned events just get
  // refused on receive, which is the correct behaviour.
  event_sig_b64?: string | null;
  signer_device_pubkey?: string | null;
};

export type DeltaMessage = {
  type: "delta";
  v: typeof WIRE_VERSION;
  events: WireMeshEvent[];
  has_more: boolean;
};

export type ByeMessage = {
  type: "bye";
  v: typeof WIRE_VERSION;
};

type AnyMessage = HelloMessage | PopProofMessage | VectorSummaryMessage | DeltaMessage | ByeMessage;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
// Separate budgets for sent vs received batches. Each side is bounded
// independently so an asymmetric sync — e.g. a fresh device joining a
// vault with 100k events — isn't aborted just because the other side
// drained its outbound queue and now has "0 sent batches" left in a
// shared budget. The original symmetric MAX_BATCHES_PER_SIDE = 200 cap
// silently capped inbound at 100k events whenever the local side ran out.
const MAX_BATCHES_SENT = 400;
const MAX_BATCHES_RECEIVED = 400;
const REVERIFY_EVERY_N_BATCHES = 1;

// ---------------------------------------------------------------------------
// Session entry point
// ---------------------------------------------------------------------------

export type AntiEntropyOptions = {
  vaultId: string;
  /**
   * Per-vault trust anchor pubkey (32 bytes, Ed25519): the owner's device
   * pubkey, fixed at vault creation. Every live vault is chain-anchored
   * (M4), so this is non-null for any vault the dispatch gate selects; the
   * chain handshake folds the membership proof against it. Typed nullable
   * only because loadVaultTrustAnchor() returns null on a malformed/missing
   * row — handshake() refuses such a vault.
   *
   * Callers obtain this via loadVaultTrustAnchor(vaultId) below.
   */
  vaultTrustAnchorPubkey?: Uint8Array | null;
  maxDurationMs?: number;
  /**
   * Optional hooks for the BLE wifi-upgrade decision step (Phase 6). When
   * provided AND the active connection is BLE, anti-entropy will compute
   * the delta volume, ask the user, and on consent perform the upgrade.
   * Injected (not imported) so anti-entropy stays free of the upgrade
   * module's React-bridge surface — keeps unit tests clean.
   *
   * upgradeListenPort is the real WebRTC signaling listener port the
   * peer needs to dial us. Pass 0 ONLY if WebRTC listener isn't up; in
   * that case the upgrade decision is silently skipped (no prompt).
   */
  coordinateUpgrade?: {
    ownDeviceId: string;
    shouldPromptForWifi: (totalEvents: number) => boolean;
    estimateBleSeconds: (totalEvents: number) => number;
    shouldOfferWifiUpgrade: (
      estimatedSeconds: number,
      totalEvents: number,
      peerLabel?: string,
    ) => Promise<"ble" | "wifi" | "cancel">;
    coordinateWifiUpgrade: (
      conn: MeshConnection,
      opts: {
        ownPeerId: string;
        peerId: string;
        vaultId: string;
        estimatedSeconds: number;
        totalEvents: number;
        listenPort: number;
        peerLabel?: string;
      },
    ) => Promise<{
      success: boolean;
      newConnection?: MeshConnection;
      expectedPeerDeviceId?: string;
      reason?: string;
    }>;
  };
  upgradeListenPort?: number;
  peerLabel?: string;
};

export type AntiEntropyResult = {
  sent: number;
  received: number;
  duplicates: number;
  durationMs: number;
  peerDeviceId: string;
};

export async function runAntiEntropy(
  conn: MeshConnection,
  opts: AntiEntropyOptions,
): Promise<AntiEntropyResult> {
  const startedAt = Date.now();
  const maxDurationMs = opts.maxDurationMs ?? 5 * 60 * 1000;
  const deadline = startedAt + maxDurationMs;

  // --- 1. Handshake ---
  // Chain-only (M4): membership-proof verification against the vault
  // anchor + v3 proof-of-possession. Every live vault is anchored.
  const peer = await handshake(conn, opts);

  // --- 2. Vector exchange (M3.5) ---
  // Each side sends its per-author RELAYABLE contiguous frontier. The peer
  // plans planRangesToSend(itsFrontier, ourFrontier) and streams exactly the
  // author_seq ranges we lack — replaces the HLC max_hlc_per_device summary.
  const localVector = await computeRelayableVector(opts.vaultId);
  const [, peerSummary] = await Promise.all([
    sendMessage(conn, {
      type: "vector",
      v: WIRE_VERSION,
      vault_id: opts.vaultId,
      frontier: localVector,
    } satisfies VectorSummaryMessage),
    recvTyped<VectorSummaryMessage>(conn, "vector", deadline - Date.now()),
  ]);
  const peerVector: Vector = peerSummary.frontier ?? {};
  console.log(
    "[mesh.vector] exchanged ourDevices=",
    Object.keys(localVector).length,
    "peerDevices=",
    Object.keys(peerVector).length,
  );

  if (peerSummary.vault_id !== opts.vaultId) {
    throw new MeshHandshakeError(
      `peer summary vault_id mismatch: expected ${opts.vaultId}, got ${peerSummary.vault_id}`,
      "transport",
    );
  }

  // --- 2.5. (BLE only) WiFi upgrade decision ---
  //
  // On BLE we estimate the delta volume in BOTH directions and prompt the
  // user to switch to wifi if BLE would take > BLE_WIFI_UPGRADE_PROMPT_SECONDS.
  // Skipped for webrtc/memory transports (already on fast wifi).
  //
  // M3.5: the estimate is now exact in the SEND direction — the planned
  // author_seq ranges (planRangesToSend) sum to precisely the events we'll
  // send. The peer's pending (RECEIVE) count still needs a round we don't do,
  // so we keep the 2× conservative doubling for the bi-directional case.
  if (conn.kind === "ble" && opts.coordinateUpgrade && opts.upgradeListenPort != null) {
    try {
      const sendCount = countRangeEvents(planRangesToSend(localVector, peerVector));
      const totalEstimated = Math.max(sendCount, sendCount * 2);
      if (opts.coordinateUpgrade.shouldPromptForWifi(totalEstimated)) {
        const choice = await opts.coordinateUpgrade.shouldOfferWifiUpgrade(
          opts.coordinateUpgrade.estimateBleSeconds(totalEstimated),
          totalEstimated,
        );
        if (choice === "cancel") {
          // User aborted — close cleanly, no delta loop.
          try {
            await sendMessage(conn, { type: "bye", v: WIRE_VERSION });
          } catch {
            /* */
          }
          return {
            sent: 0,
            received: 0,
            duplicates: 0,
            durationMs: Date.now() - startedAt,
            peerDeviceId: peer.deviceId,
          };
        }
        if (choice === "wifi") {
          const upgradeResult = await opts.coordinateUpgrade.coordinateWifiUpgrade(conn, {
            ownPeerId: opts.coordinateUpgrade.ownDeviceId,
            peerId: peer.deviceId,
            vaultId: opts.vaultId,
            estimatedSeconds: opts.coordinateUpgrade.estimateBleSeconds(totalEstimated),
            totalEvents: totalEstimated,
            listenPort: opts.upgradeListenPort,
            peerLabel: opts.peerLabel,
          });
          if (upgradeResult.success && upgradeResult.newConnection) {
            // CRITICAL: re-run the full handshake on the new LAN (TCP)
            // connection AND verify the device_id matches the one we
            // authenticated on BLE. This defends against a LAN MITM
            // hijacking the upgrade via the mDNS race. The handshake also
            // installs the LAN session AEAD (fail-loud if absent).
            const wifiConn = upgradeResult.newConnection;
            const expected = upgradeResult.expectedPeerDeviceId;
            try {
              const newPeer = await handshake(wifiConn, opts);
              if (expected && newPeer.deviceId !== expected) {
                // Identity mismatch — close the LAN conn and stay on BLE.
                try {
                  await wifiConn.close();
                } catch {
                  /* */
                }
                if (__DEV__) {
                  console.warn(
                    "[anti-entropy] wifi-upgrade identity mismatch: BLE=",
                    expected,
                    "LAN=",
                    newPeer.deviceId,
                  );
                }
              } else {
                // Identity confirmed. Recursively run anti-entropy over
                // the new transport, then return — caller closes BLE.
                const result = await runAntiEntropy(wifiConn, opts);
                return result;
              }
            } catch (err) {
              try {
                await wifiConn.close();
              } catch {
                /* */
              }
              if (__DEV__)
                console.warn(
                  "[anti-entropy] wifi-upgrade post-handshake failed, staying on BLE",
                  err,
                );
            }
          }
          // upgrade returned race_lost / mdns_timeout / peer_declined etc.
          // — fall through to the BLE delta loop unchanged.
        }
      }
    } catch (err) {
      // Wifi-upgrade decision must NEVER abort the BLE delta loop;
      // it's strictly opportunistic. Log and continue.
      if (__DEV__) console.warn("[anti-entropy] wifi-upgrade decision threw", err);
    }
  }

  // --- 3 + 4. Delta swap loop ---
  const { sent, received, duplicates } = await runDeltaLoop(
    conn,
    opts,
    peer,
    localVector,
    peerVector,
    deadline,
  );

  // Best-effort bye.
  try {
    await sendMessage(conn, { type: "bye", v: WIRE_VERSION });
    console.log("[mesh.bye] sent");
  } catch {
    /* peer may already have disconnected */
    console.log("[mesh.bye] send failed (peer already gone)");
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    "[mesh.done] sent=",
    sent,
    "received=",
    received,
    "duplicates=",
    duplicates,
    "durationMs=",
    durationMs,
  );

  // JOINER side: a FULL sync completed, so the owner's pair-admission events
  // have replicated back and future handshakes prove membership via the chain —
  // retire our local pair_nonce echo now. Deferred here from handshake() so a
  // mid-sync failure leaves the nonce live for the automatic retry. No-op for
  // the owner (no local pair nonce). Best-effort.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localPair = require("./local-pair") as {
      clearLocalPairNonceForVault: (vaultId: string) => Promise<void>;
    };
    await localPair.clearLocalPairNonceForVault(opts.vaultId);
  } catch (err) {
    if (__DEV__) console.warn("[mesh.done] clearLocalPairNonceForVault failed", err);
  }

  return {
    sent,
    received,
    duplicates,
    durationMs,
    peerDeviceId: peer.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Delta swap loop (shared by one-shot runAntiEntropy + the persistent session)
// ---------------------------------------------------------------------------

/**
 * One vector→delta exchange's delta phase: stream the events the peer lacks and
 * apply the events we lack, in lockstep batches, until both sides drain. Extracted
 * verbatim from runAntiEntropy so the one-shot and persistent paths share ONE
 * copy of this security-relevant loop (reverify at every batch boundary). Caller
 * has already done the handshake + vector exchange and passes both frontiers.
 */
async function runDeltaLoop(
  conn: MeshConnection,
  opts: AntiEntropyOptions,
  peer: PeerSession,
  localVector: Vector,
  peerVector: Vector,
  deadline: number,
): Promise<{ sent: number; received: number; duplicates: number }> {
  let sent = 0;
  let received = 0;
  let duplicates = 0;
  // M3.5: plan the exact author_seq ranges the peer lacks, then stream them in
  // author_seq order so the peer's frontier advances contiguously.
  const sendState = newSendCursor(planRangesToSend(localVector, peerVector));
  let localSentDone = false;
  let peerSentDone = false;
  let sentBatches = 0;
  let receivedBatches = 0;
  let totalLoopIters = 0;

  while (!(localSentDone && peerSentDone)) {
    if (Date.now() > deadline) {
      throw new MeshTransportError(`anti-entropy delta loop exceeded deadline`, "timeout");
    }
    if (sentBatches >= MAX_BATCHES_SENT) {
      throw new MeshTransportError(
        `anti-entropy exceeded ${MAX_BATCHES_SENT} sent batches`,
        "runaway_sent",
      );
    }
    if (receivedBatches >= MAX_BATCHES_RECEIVED) {
      throw new MeshTransportError(
        `anti-entropy exceeded ${MAX_BATCHES_RECEIVED} received batches`,
        "runaway_received",
      );
    }
    totalLoopIters++;

    if (totalLoopIters % REVERIFY_EVERY_N_BATCHES === 0) {
      await reverifyPeerWindow(opts.vaultId, peer);
    }

    let outBatch: WireMeshEvent[] = [];
    if (!localSentDone) {
      outBatch = await fetchNextBatch(opts.vaultId, sendState, BATCH_SIZE);
      if (outBatch.length < BATCH_SIZE) {
        localSentDone = true;
      }
    }

    const outMsg: DeltaMessage = {
      type: "delta",
      v: WIRE_VERSION,
      events: outBatch,
      has_more: !localSentDone,
    };

    console.log(
      "[mesh.delta] iter=",
      totalLoopIters,
      "sending=",
      outBatch.length,
      "sentTotal=",
      sent,
      "receivedTotal=",
      received,
    );
    const [, inMsg] = await Promise.all([
      sendMessage(conn, outMsg),
      recvTyped<DeltaMessage>(conn, "delta", deadline - Date.now()),
    ]);

    sent += outBatch.length;
    // Only count an iteration toward the send budget when we actually had
    // payload to send. Drained-sender iterations (outBatch.length === 0,
    // pumping the peer's inbound stream) don't burn the send budget.
    if (outBatch.length > 0) sentBatches++;

    const applied = await applyIncomingBatch(opts.vaultId, inMsg.events);
    console.log(
      "[mesh.delta] applied=",
      applied.applied,
      "duplicates=",
      applied.duplicates,
      "roleGateRejected=",
      applied.roleGateRejected,
      "peer.has_more=",
      inMsg.has_more,
    );
    received += applied.applied;
    duplicates += applied.duplicates;
    // Same logic on the inbound side: don't burn budget for empty deltas
    // the peer sends as keep-alive while waiting for us.
    if (inMsg.events.length > 0) receivedBatches++;

    if (!inMsg.has_more) {
      peerSentDone = true;
    }
  }

  return { sent, received, duplicates };
}

// ---------------------------------------------------------------------------
// Persistent anti-entropy session (Briar-style warm connection)
// ---------------------------------------------------------------------------
//
// The one-shot runAntiEntropy dials, handshakes, syncs ONCE, and closes — so the
// steady loop paid a fresh RFCOMM connect (~1-2s) + full handshake every cycle.
// That churn was both the "slower than Briar" gap AND a driver of the connect-
// storm crash. This keeps ONE handshaken connection open and loops vector→delta
// ROUNDS over it: one handshake + one connect for the whole session, like Briar's
// ConnectionManager. It NEVER reopens a logical session on a fresh socket, so it
// never skips a handshake (safer than a resume-with-cached-session scheme) — the
// AEAD installed at handshake protects every round, and reverifyPeerWindow runs
// before each round as the revocation backstop.
//
// Symmetry: both the dialer and the listener-accepter run THIS function, so they
// loop in lockstep — every round's vector exchange + delta loop is Promise.all-
// paired, which absorbs the small per-round timing skew. Idle-close (no events
// for IDLE_ROUNDS_BEFORE_CLOSE rounds) is computed from events-moved, which is
// symmetric, so both sides wind down together.

// Per-round hard cap (a stuck round can't pin the socket forever).
// INVARIANT: ROUND_MAX_MS MUST stay > the max roundIntervalMs (the idle
// keep-alive, 30s below). A one-sided wake makes the woken peer block in
// recvTyped("vector") until the other peer's next keep-alive round (up to the
// idle interval); that recv is budgeted by ROUND_MAX_MS, so if the cap ever
// drops below the keep-alive interval, idle rounds time out and warm links
// churn-reconnect. Current margin: 45s cap vs 30s keep-alive = 15s.
const ROUND_MAX_MS = 45_000;
// Whole-session hard cap. At this cap the session ends and the conn is CLOSED;
// the next backstop dial re-establishes a fresh session (close-then-redial, not
// an in-place refresh) — so a long-lived socket can't accumulate native buffers.
// Raised to 20 min (was 5) to keep the warm connection through a realistic shop
// session — the first edit after a lull was paying a full reconnect+handshake
// (~2-5s) every 5 min. A single streaming conn doesn't accumulate buffers (the
// reader drains frames), so a longer cap is safe; the cap is just hygiene.
const SESSION_MAX_MS = 1_200_000;
// Close the session after this many consecutive rounds with zero events moved.
// With the idle interval below (flat 30s keep-alive, Briar-style) this is ~16 min
// of true idle before we drop the warm connection — so the common "first edit
// after a short lull" stays warm/real-time instead of cold-reconnecting.
const IDLE_ROUNDS_BEFORE_CLOSE = 40;

/** Adaptive inter-round wait: snappy right after activity, then a flat 30s
 *  keep-alive when idle (matches Briar's keep-alive) so the link stays WARM for
 *  instant pushes without polling hard. A local write wakes the session
 *  immediately (makeWaker), so this is only the floor for a missed wake / the
 *  idle keep-alive cadence. Pure function of idleRounds → symmetric across peers. */
function roundIntervalMs(idleRounds: number): number {
  if (idleRounds < 3) return 700;
  if (idleRounds < 8) return 3_000;
  return 30_000;
}

/**
 * A re-armable wait that a push-on-write (or a stop/pause) can cut short. LATCHED:
 * a wake() delivered while NOT parked in wait() (e.g. mid-round, the common case
 * for a push that fires during a sync) is remembered so the very next wait()
 * returns immediately instead of dropping the signal and waiting out the timer.
 */
function makeWaker(): { wait: (ms: number) => Promise<void>; wake: () => void } {
  let resolve: (() => void) | null = null;
  let pending = new Promise<void>((r) => (resolve = r));
  let signalled = false;
  return {
    wait: (ms: number) => {
      if (signalled) {
        signalled = false;
        return Promise.resolve();
      }
      return Promise.race([
        pending.then(() => {
          signalled = false;
        }),
        new Promise<void>((r) => setTimeout(r, ms)),
      ]).then(() => {});
    },
    wake: () => {
      signalled = true;
      resolve?.();
      pending = new Promise<void>((r) => (resolve = r));
    },
  };
}

export type AntiEntropySessionHooks = {
  /**
   * Called ONCE right after the handshake with the peer's deviceId, the peer's
   * device pubkey (b64 — for a deterministic both-dial tie-break against the
   * local pubkey), and a wake() that ends the current inter-round wait early. The
   * caller registers the live session (to dedupe future dials) and stores wake()
   * so a local write triggers an immediate round instead of waiting the interval.
   */
  onEstablished?: (peerDeviceId: string, peerPubkeyB64: string, wake: () => void) => void;
  /** Polled between rounds; return true to end the session (shop mode stopping). */
  shouldStop?: () => boolean;
};

/**
 * Persistent warm-connection anti-entropy. Handshakes once, then loops sync
 * rounds over the same open connection until idle / session cap / stop / error.
 * Returns the aggregate of all rounds. The CALLER owns conn.close() (in its
 * finally), exactly like runAntiEntropy.
 */
export async function runAntiEntropySession(
  conn: MeshConnection,
  opts: AntiEntropyOptions,
  hooks?: AntiEntropySessionHooks,
): Promise<AntiEntropyResult> {
  const startedAt = Date.now();
  const sessionMaxMs = opts.maxDurationMs ?? SESSION_MAX_MS;
  const sessionDeadline = startedAt + sessionMaxMs;

  // ONE handshake for the whole session — the expensive part. The conn stays
  // authenticated + AEAD-installed; every round reuses it.
  const peer = await handshake(conn, opts);

  const waker = makeWaker();
  hooks?.onEstablished?.(peer.deviceId, peer.devicePubkeyB64, waker.wake);

  let sent = 0;
  let received = 0;
  let duplicates = 0;
  let idleRounds = 0;

  try {
    while (true) {
      if (hooks?.shouldStop?.()) break;
      if (Date.now() >= sessionDeadline) break;

      // Revocation backstop before every round: re-run the membership verdict so
      // a peer removed since the handshake (or via a prior round's gossip) is
      // refused. Throws on revocation → session ends (caller closes the conn).
      await reverifyPeerWindow(opts.vaultId, peer);

      const roundDeadline = Math.min(sessionDeadline, Date.now() + ROUND_MAX_MS);
      const localVector = await computeRelayableVector(opts.vaultId);
      const [, peerSummary] = await Promise.all([
        sendMessage(conn, {
          type: "vector",
          v: WIRE_VERSION,
          vault_id: opts.vaultId,
          frontier: localVector,
        } satisfies VectorSummaryMessage),
        recvTyped<VectorSummaryMessage>(conn, "vector", roundDeadline - Date.now()),
      ]);
      if (peerSummary.vault_id !== opts.vaultId) {
        throw new MeshHandshakeError(
          `peer summary vault_id mismatch: expected ${opts.vaultId}, got ${peerSummary.vault_id}`,
          "transport",
        );
      }
      const peerVector: Vector = peerSummary.frontier ?? {};

      const r = await runDeltaLoop(conn, opts, peer, localVector, peerVector, roundDeadline);
      sent += r.sent;
      received += r.received;
      duplicates += r.duplicates;

      // Symmetric idle metric: include duplicates so both peers count a round the
      // same way (sent counts events shipped incl. ones the peer already had;
      // received excludes duplicates — without duplicates the two sides' idle
      // counters could drift a round apart and close out of lockstep).
      if (r.sent + r.received + r.duplicates > 0) {
        idleRounds = 0;
      } else {
        idleRounds++;
        if (idleRounds >= IDLE_ROUNDS_BEFORE_CLOSE) break;
      }

      // Wait before the next round; a local write wakes us early for real-time
      // sync. The interval lengthens as the link stays idle (battery).
      await waker.wait(roundIntervalMs(idleRounds));
    }
  } finally {
    // Best-effort bye so the peer's loop winds down on its next recv.
    try {
      await sendMessage(conn, { type: "bye", v: WIRE_VERSION });
    } catch {
      /* peer already gone */
    }
  }

  return {
    sent,
    received,
    duplicates,
    durationMs: Date.now() - startedAt,
    peerDeviceId: peer.deviceId,
  };
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * What the chain handshake authenticates — the identity + role the
 * downstream stages (delta loop, wifi upgrade, mid-session reverify)
 * consume.
 */
type PeerSession = {
  deviceId: string;
  devicePubkeyB64: string;
  accountId: string;
  role: string;
  /** The peer's presented membership-proof bundle, kept so the mid-session
   *  reverify can re-run the SAME verdict the handshake ran (local events
   *  are always merged in, so a removal ingested mid-stream still wins and
   *  kills the session). */
  proofEvents: MembershipEventLike[];
};

/** Plumbing the chain verification path needs, captured once in
 *  handshake() after the Hello exchange. */
type HandshakeWireContext = {
  peerHello: HelloMessage;
  ourNonceB64: string;
  ourEphemeralPub: Uint8Array;
  peerEphemeralPub: Uint8Array;
  /** event_ids of the proof bundle WE sent in our own Hello — the v3
   *  PoP transcript commits to them. */
  ownBundleIds: string[];
};

async function handshake(conn: MeshConnection, opts: AntiEntropyOptions): Promise<PeerSession> {
  console.log("[mesh.hs] start vault=", opts.vaultId.slice(0, 8), "transport=", conn.kind);

  // Generate our challenge nonce. 32 bytes CSPRNG is sufficient for
  // single-use challenge entropy (collision probability is negligible).
  const ourNonceBytes = await Crypto.getRandomBytesAsync(32);
  const ourNonceB64 = bytesToB64Url(ourNonceBytes);

  // Generate the per-session ephemeral X25519 keypair for forward secrecy.
  // The private key NEVER leaves this scope — even a compromise of our
  // long-term device key tomorrow can't decrypt today's BLE traffic
  // because the shared secret depended on this throwaway scalar.
  const ourEphemeral: EphemeralKeyPair = generateEphemeralKeyPair();
  const ourEphemeralPubB64 = bytesToB64Url(ourEphemeral.publicKey);

  // Mythos P2: if we're a joiner whose first handshake with this vault
  // hasn't completed yet, attach the QR's shop_mode_token as pair_nonce
  // so the owner's Path C TOFU has something to bind to. Lookup is
  // best-effort and silent on miss — pinned peers (post-first-handshake)
  // return null here and the field is omitted from Hello entirely.
  let ourPairNonce: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const localPair = require("./local-pair") as {
      getLocalPairNonceForVault: (vaultId: string) => Promise<string | null>;
    };
    ourPairNonce = await localPair.getLocalPairNonceForVault(opts.vaultId);
  } catch {
    // ignore — handshake works without pair_nonce when peer is pinned
  }

  // M2c: gather our v2 identity + membership-proof bundle.
  //
  //   - device_pubkey_b64 / device_id: this install's chain identity.
  //   - account_id: signed-in account, else the deterministic 'local:'
  //     sentinel derived from OUR OWN device pubkey — the exact
  //     resolution lib/trust/backfill.ts uses for chain emission. For
  //     the vault owner that sentinel coincides with the anchor-derived
  //     one (the anchor IS their device key); for a local-only JOINER
  //     it's a distinct per-device sentinel, which is what lets the
  //     owner's admission events carry the joiner's QR-committed role
  //     instead of collapsing the joiner into the owner's account.
  //   - proof_bundle: full local membership set (M2; see
  //     buildOwnProofBundle for the M3 minimal-chain note). Empty when
  //     we have no chain yet — i.e. exactly the freshly-paired joiner
  //     case, where pair_nonce above carries the admission claim.
  const { pubkey_b64: ownDevicePubkeyB64 } = await ensureDeviceKey();
  const ownDeviceId = getInstallIdSync();
  const ownAccountId = getAccountIdSync() ?? buildLocalAccountId(ownDevicePubkeyB64);
  let ownBundle: MembershipEventLike[] = [];
  try {
    ownBundle = await buildOwnProofBundle(opts.vaultId);
  } catch (err) {
    // A bundle-read failure must not kill the handshake outright: an
    // empty bundle is only accepted by the peer inside a live pair
    // window, so this fails closed on their side, loudly here.
    console.warn("[mesh.hs] buildOwnProofBundle failed — sending empty bundle", err);
  }
  const ownBundleIds = ownBundle.map((e) => e.event_id);

  // Our display name, so a peer admitting us (pair path) can stamp it into our
  // vault_member_added. Best-effort — handshake works fine without it.
  let ownDisplayName: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dbMod = require("../db") as {
      getLocalSelf: () => Promise<{ name: string } | null>;
    };
    ownDisplayName = (await dbMod.getLocalSelf())?.name?.trim() || null;
  } catch {
    /* name is best-effort */
  }

  // Our real Bluetooth MAC, so a peer that only ACCEPTS our steady RFCOMM
  // connection (it sees the OS-masked 02:00:00:00:00:00, not our hardware MAC)
  // can learn a dialable address and dial us BACK. Only meaningful on the BTC
  // transport; skip the native call on LAN/BLE/memory. Best-effort + validated
  // by isDialableMac so a null/masked local address is simply omitted.
  let ownBtMac: string | null = null;
  if (conn.kind === "btc") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const btMod = require("../../modules/kaata-bt-classic") as {
        getLocalAddress: () => Promise<string | null>;
      };
      const mac = (await btMod.getLocalAddress())?.trim() ?? null;
      ownBtMac = mac && isDialableMac(mac) ? mac : null;
    } catch {
      /* bt_mac is best-effort */
    }
  }

  const hello: HelloMessage = {
    type: "hello",
    v: WIRE_VERSION,
    capabilities: ["v1"],
    pop_nonce: ourNonceB64,
    ephemeral_x25519_pubkey: ourEphemeralPubB64,
    ...(ourPairNonce ? { pair_nonce: ourPairNonce } : {}),
    device_pubkey_b64: ownDevicePubkeyB64,
    device_id: ownDeviceId,
    ...(ownAccountId ? { account_id: ownAccountId } : {}),
    ...(ownDisplayName ? { display_name: ownDisplayName } : {}),
    ...(ownBtMac ? { bt_mac: ownBtMac } : {}),
    proof_bundle: ownBundle.map(membershipEventToWire),
  };

  const [, peerHello] = await Promise.all([
    sendMessage(conn, hello),
    recvTyped<HelloMessage>(conn, "hello", 10_000),
  ]);
  console.log("[mesh.hs] peer hello received");

  const sharedCaps = peerHello.capabilities.filter((c) => c === "v1");
  if (sharedCaps.length === 0) {
    throw new MeshHandshakeError(
      `no shared capability with peer (peer offered: ${peerHello.capabilities.join(",")})`,
      "transport",
    );
  }
  if (typeof peerHello.pop_nonce !== "string" || peerHello.pop_nonce.length < 16) {
    throw new MeshHandshakeError(
      `peer hello missing or malformed pop_nonce (required for proof-of-possession)`,
      "transport",
    );
  }
  // v0.5.2: ephemeral_x25519_pubkey is mandatory. Peers without it are
  // pre-0.5.2 — the BLE transport can no longer be safely used unencrypted,
  // so we fail loud rather than silently downgrade.
  if (
    typeof peerHello.ephemeral_x25519_pubkey !== "string" ||
    peerHello.ephemeral_x25519_pubkey.length === 0
  ) {
    throw new MeshHandshakeError(
      `peer too old (no ephemeral_x25519_pubkey in Hello). Ask them to update Kaata.`,
      "transport",
    );
  }
  const peerEphemeralPub = b64UrlDecode(peerHello.ephemeral_x25519_pubkey);
  if (peerEphemeralPub.length !== X25519_PUBKEY_BYTES) {
    throw new MeshHandshakeError(
      `peer ephemeral_x25519_pubkey has wrong length ${peerEphemeralPub.length} (expected ${X25519_PUBKEY_BYTES})`,
      "transport",
    );
  }

  // -------------------------------------------------------------------------
  // M3.5 version gate. Only v3 is supported (full cutover — recvTyped already
  // refuses other versions at the wire layer, but we gate the Hello explicitly
  // so a pre-v3 peer gets the actionable 'peer_outdated' UX instead of a
  // generic bad_version). M4: the trust path is chain-only — every live vault
  // is anchored (loadVaultTrustAnchor non-null) and the dispatch gate only
  // selects anchored vaults, so there is a single verification path.
  // -------------------------------------------------------------------------
  const peerWireVersion = typeof peerHello.v === "number" ? peerHello.v : 0;
  if (peerWireVersion < WIRE_VERSION) {
    // Cast: 'peer_outdated' is not yet in errors.ts's MeshFailureEvent union;
    // MeshController matches the kind via string.
    emitMeshFailure({ kind: "peer_outdated" } as unknown as MeshFailureEvent);
    throw new MeshHandshakeError(
      `peer wire version ${peerWireVersion} < ${WIRE_VERSION} — peer must update to the version-vector protocol before it can sync`,
      "vmc_invalid",
    );
  }

  const wire: HandshakeWireContext = {
    peerHello,
    ourNonceB64,
    ourEphemeralPub: ourEphemeral.publicKey,
    peerEphemeralPub,
    ownBundleIds,
  };
  const session = await verifyPeerChain(conn, opts, wire);

  // ---- AEAD key derivation + install ------------------------------------
  //
  // Shared by both paths. We derive the ChaCha20-Poly1305 key for ALL
  // transports that expose installAead(). On BLE and LAN (TCP) this enables
  // encryption from here on — both are plaintext byte channels with no
  // transport-layer crypto, so the session AEAD is the ONLY thing protecting
  // ledger data on the wire. On in-memory test connections installAead is a
  // no-op stub. (WebRTC, which had DTLS and skipped this, was removed in M3.)
  //
  // Binding the AEAD key to BOTH pop_nonces (which the PoP layer just
  // signed) closes any seam where an attacker could derive a different key
  // than the one a verified PoP commits to.
  const aeadCtx: BleAeadContext = deriveSessionAead({
    ownPriv: ourEphemeral.privateKey,
    ownPub: ourEphemeral.publicKey,
    peerPub: peerEphemeralPub,
    ownNonceB64: ourNonceB64,
    peerNonceB64: peerHello.pop_nonce,
  });
  // Mobile-Native critique H5: zero out the ephemeral private key now
  // that the symmetric AEAD key has been derived. Hermes does not
  // zeroize on GC; this shrinks the heap-snapshot exfil window for the
  // forward-secrecy guarantee. The key derivation already used the priv.
  wipeEphemeralPriv(ourEphemeral.privateKey);
  const installer = (
    conn as MeshConnection & {
      installAead?: (ctx: BleAeadContext) => void;
    }
  ).installAead;
  if (typeof installer === "function") {
    installer.call(conn, aeadCtx);
    console.log("[mesh.hs] AEAD key derived + installed", {
      transport: conn.kind,
      sendDir: aeadCtx.sendDirectionTag,
      recvDir: aeadCtx.recvDirectionTag,
    });
  } else if (conn.kind === "ble" || conn.kind === "lan" || conn.kind === "btc") {
    // BLE, LAN, and BTC (Bluetooth Classic RFCOMM) are plaintext byte channels
    // — a missing installAead means we'd run ledger sync in the clear. Fail loud
    // rather than silently accept plaintext (done-criterion 2: a packet capture
    // must show ciphertext only). The earlier kind-only check missed "lan", and
    // "btc" was added when RFCOMM became a real ledger transport (M-BTC-3).
    throw new MeshHandshakeError(
      `${conn.kind} connection has no installAead method — AEAD cannot be enabled`,
      "transport",
    );
  }

  conn.remoteDeviceId = session.deviceId;

  // SYMMETRIZE BT DIALING (#41): on Bluetooth Classic the ACCEPT side gets the
  // OS-masked 02:00:00:00:00:00 as the socket's remoteMac, so a device that only
  // ever accepts a steady connection (the owner, post-pair) can never dial back
  // and BT-only sync goes dark whenever the sole dialer isn't foregrounded. The
  // peer just told us its REAL MAC in the now-AUTHENTICATED Hello (verifyPeerChain
  // succeeded above), so if our socket-derived remoteMac is missing/non-dialable,
  // adopt the Hello's. addKnownPeer (btc-steady onEstablished) then persists it,
  // making BOTH peers dialers. Validated with the shared isDialableMac — never
  // trust the raw wire string. Only touch a BTC conn (remoteMac isn't on the
  // generic MeshConnection).
  if (conn.kind === "btc") {
    const btcConn = conn as MeshConnection & { remoteMac?: string | null };
    const haveDialable = typeof btcConn.remoteMac === "string" && isDialableMac(btcConn.remoteMac);
    const peerMac = typeof peerHello.bt_mac === "string" ? peerHello.bt_mac.trim() : "";
    if (!haveDialable && peerMac && isDialableMac(peerMac)) {
      btcConn.remoteMac = peerMac;
      console.log("[mesh.hs] learned peer bt_mac from Hello (accept-side masked)");
    }
  }

  // NOTE: the joiner's local pair_nonce is deliberately NOT cleared here.
  // Clearing it at handshake-success (before the delta loop) meant any later
  // failure left the OWNER unconverged while the joiner had already retired its
  // nonce — so the automatic retry sent no pair_nonce and was refused with "no
  // live pair token matched". The clear now happens at the END of runAntiEntropy
  // (full sync complete → the owner's admission events have replicated back).
  // Single-use semantics + the 30-min TTL still bound replay.
  return session;
}

// ---------------------------------------------------------------------------
// Chain verification path (M2c — the SOLE trust path after M4).
// docs/m2-membership-chain.md §3 (verifier), §4 row 2 (pair flow), §7.
// ---------------------------------------------------------------------------

async function verifyPeerChain(
  conn: MeshConnection,
  opts: AntiEntropyOptions,
  wire: HandshakeWireContext,
): Promise<PeerSession> {
  const { peerHello, ourNonceB64, ourEphemeralPub, peerEphemeralPub } = wire;

  // --- 1. Claimed identity fields (mandatory on the chain path) ---
  const claimedPubkeyB64 = peerHello.device_pubkey_b64;
  let claimedPubkeyBytes: Uint8Array | null = null;
  if (typeof claimedPubkeyB64 === "string" && claimedPubkeyB64.length > 0) {
    try {
      const decoded = b64ToBytes(claimedPubkeyB64);
      if (decoded.length === 32) claimedPubkeyBytes = decoded;
    } catch {
      claimedPubkeyBytes = null;
    }
  }
  if (typeof claimedPubkeyB64 !== "string" || !claimedPubkeyBytes) {
    throw new MeshHandshakeError(
      "peer hello v2 missing or malformed device_pubkey_b64",
      "vmc_invalid",
    );
  }
  const claimedDeviceId = peerHello.device_id;
  if (typeof claimedDeviceId !== "string" || claimedDeviceId.length === 0) {
    throw new MeshHandshakeError("peer hello v2 missing device_id", "vmc_invalid");
  }
  const claimedAccountId = peerHello.account_id;
  if (typeof claimedAccountId !== "string" || claimedAccountId.length === 0) {
    throw new MeshHandshakeError("peer hello v2 missing account_id", "vmc_invalid");
  }
  const rawBundle = Array.isArray(peerHello.proof_bundle) ? peerHello.proof_bundle : [];
  if (rawBundle.length > PROOF_BUNDLE_CAP) {
    throw new MeshHandshakeError(
      `peer proof_bundle too large (${rawBundle.length} > ${PROOF_BUNDLE_CAP})`,
      "vmc_invalid",
    );
  }
  // Wire → MembershipEventLike, dropping structurally-broken entries
  // (the fold would refuse them anyway; filtering keeps the ingest step
  // from tripping on malformed HLCs). NOTE: the v3 PoP commitment below
  // hashes the RAW received event_id list, not the sanitized one — it
  // must match what the peer hashed on their side, byte for byte.
  const peerProofWire = rawBundle.filter(isStructurallyValidWireEvent);
  const peerProofEvents = peerProofWire.map(wireToMembershipEvent);
  const rawBundleIds = rawBundle.map((w) =>
    w && typeof w.event_id === "string" ? w.event_id : "",
  );

  // --- 2. Early revocation check (parity with the legacy gate order:
  // cheap SQL before any Ed25519 work; chain removals fan out to
  // revocation_list via the vault_member_removed applier). ---
  if (await isRevoked(opts.vaultId, claimedDeviceId)) {
    throw new MeshVMCRevokedError(
      `peer device ${claimedDeviceId} is revoked from vault ${opts.vaultId} (chain path, early reject)`,
    );
  }

  // --- 3. Membership verdict: fold (peer proof ∪ our local events). A
  // removal we hold locally wins regardless of what the peer omits —
  // the M2 done-criterion. Epoch checks are intentionally GONE on this
  // path (they retire with VMCs). ---
  const verdict = await verifyPeerMembership({
    vaultId: opts.vaultId,
    claimedDevicePubkeyB64: claimedPubkeyB64,
    proofEvents: peerProofEvents,
  });

  // PAIR PATH (docs §4 row 2): a freshly-paired joiner has NO chain yet
  // — it presents an EMPTY proof bundle plus the QR's pair_nonce. The
  // owner accepts the handshake IFF that nonce matches a live unconsumed
  // pair token for THIS vault (admission-in-progress, gated to this one
  // session), and after PoP succeeds EMITS the admission events itself
  // (owner-signed member add + device bind — the chain-native
  // replacement for the Phase 6.1 joiner-self-add for NEW pairs; the
  // role-gate carve-out stays for old flows). Any other empty/failing
  // proof refuses with the normal verdict reason.
  let admissionToken: { nonce: string; role?: string } | null = null;
  if (!verdict.ok) {
    // Reach the pair fallback whenever the peer is simply NOT-YET-BOUND (a
    // fresh joiner), NOT only when its proof bundle is literally empty. A joiner
    // that gossip-ingested the OWNER's membership events in a prior, link-
    // dropped session (section 6 below) sends a NON-empty bundle on the retry
    // that still doesn't bind ITS OWN pubkey — verdict stays device_not_bound /
    // no_genesis. Gating on length===0 wedged those retries permanently once BLE
    // actually started connecting (pre-existing bug, unmasked by the CCCD
    // subscribe fix). device_removed / member_removed / no_anchor must NOT
    // pair-admit; the SECURITY guard below additionally refuses any already-
    // member or the owner.
    const freshJoiner = verdict.reason === "device_not_bound" || verdict.reason === "no_genesis";
    if (
      freshJoiner &&
      typeof peerHello.pair_nonce === "string" &&
      peerHello.pair_nonce.length > 0
    ) {
      try {
        // M4 (review fix): ATOMICALLY claim the nonce, binding it to the
        // peer's claimed device pubkey, BEFORE PoP. The CAS makes the nonce
        // strictly single-use — a second concurrent handshake riding the same
        // sniffed nonce gets null here and is refused (closes the double-admit
        // TOCTOU). If PoP later fails we release the claim (below) so the
        // legit joiner can retry.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const localPair = require("./local-pair") as {
          claimPairNonce: (
            vaultId: string,
            nonce: string,
            claimedDeviceKeyB64: string,
          ) => Promise<{ nonce: string; role?: string } | null>;
        };
        admissionToken = await localPair.claimPairNonce(
          opts.vaultId,
          peerHello.pair_nonce,
          claimedPubkeyB64,
        );
      } catch (err) {
        console.warn("[mesh.hs] pair token claim threw", err);
        admissionToken = null;
      }
    }
    if (!admissionToken) {
      throw new MeshHandshakeError(
        `peer membership proof refused (${verdict.reason}) and no live pair token matched`,
        "vmc_invalid",
      );
    }
    console.log(
      "[mesh.hs] chain verdict not-ok (",
      verdict.reason,
      ") but live pair token matched — admission-in-progress",
    );
  } else {
    // The chain bound the claimed pubkey to a (device_id, account_id).
    // The claimed device_id MUST match the chain binding — a mismatch
    // means the peer is wearing someone else's install identity.
    if (verdict.device_id !== claimedDeviceId) {
      throw new MeshHandshakeError(
        `peer device_id ${claimedDeviceId} does not match chain binding ${verdict.device_id}`,
        "vmc_invalid",
      );
    }
    // account_id mismatch is only a warn: the chain's account is
    // authoritative for the session, and a benign mismatch exists (a
    // local-only owner whose chain holds the 'local:' sentinel signs
    // into Google later — getAccountIdSync changes, the chain doesn't).
    if (verdict.account_id !== claimedAccountId) {
      console.warn(
        "[mesh.hs] peer claimed account_id differs from chain binding — using chain's",
        claimedAccountId.slice(0, 16),
        "vs",
        verdict.account_id.slice(0, 16),
      );
    }
    console.log(
      "[mesh.hs] chain verdict OK device=",
      verdict.device_id.slice(0, 8),
      "role=",
      verdict.role,
    );
  }

  // --- 4. Proof of possession (v3). The chain (or the pair token)
  // vouches for the CLAIMED pubkey; PoP proves the entity on this
  // socket holds the matching private key. The transcript commits to
  // the signer's OWN presented bundle (sha256 over its canonical
  // event_id list), the verifier's challenge nonce, and both ephemeral
  // X25519 pubkeys (preserving the v2 MITM fix — see POP_DOMAIN_V3). ---
  const ourSigBytes = await signWithDeviceKey(
    buildPopMessageV3(wire.ownBundleIds, peerHello.pop_nonce, ourEphemeralPub, peerEphemeralPub),
  );
  const ourProof: PopProofMessage = {
    type: "pop_proof",
    v: WIRE_VERSION,
    sig: bytesToB64Url(ourSigBytes),
  };
  const [, peerProof] = await Promise.all([
    sendMessage(conn, ourProof),
    recvTyped<PopProofMessage>(conn, "pop_proof", 10_000),
  ]);
  console.log("[mesh.hs] peer PoP received (v3)");

  const peerSigBytes = b64UrlDecode(peerProof.sig);
  if (peerSigBytes.length !== 64) {
    throw new MeshHandshakeError(
      `peer PoP signature has wrong length ${peerSigBytes.length} (expected 64)`,
      "pop_failed",
    );
  }
  // From the peer's perspective: their bundle is the one we RECEIVED,
  // the nonce is OURS, their ephemeral pub comes first.
  const popMsg = buildPopMessageV3(rawBundleIds, ourNonceB64, peerEphemeralPub, ourEphemeralPub);
  let popOk = false;
  try {
    popOk = ed.verify(peerSigBytes, popMsg, claimedPubkeyBytes);
  } catch (err) {
    if (__DEV__) console.warn("[mesh.hs] ed.verify threw — sha512Sync shim missing?", err);
    popOk = false;
  }
  if (!popOk) {
    // M4 (review fix): PoP failed AFTER we claimed the pair nonce — release
    // our claim so a failed (or hostile) attempt doesn't burn the nonce and
    // the legitimate joiner can retry. Only releases a claim WE hold.
    if (admissionToken) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const localPair = require("./local-pair") as {
          releasePairNonceClaim: (nonce: string, claimedDeviceKeyB64: string) => Promise<void>;
        };
        await localPair.releasePairNonceClaim(admissionToken.nonce, claimedPubkeyB64);
      } catch (err) {
        if (__DEV__) console.warn("[mesh.hs] releasePairNonceClaim failed", err);
      }
    }
    throw new MeshHandshakeError(
      `peer failed v3 proof-of-possession — chain (or pair token) vouches for their pubkey ` +
        `but they do not control the matching private key`,
      "pop_failed",
    );
  }
  console.log("[mesh.hs] PoP v3 verified peer=", claimedDeviceId.slice(0, 8));

  // --- 5. Owner-side pair admission (after PoP — never admit a key
  // whose possession wasn't proven). Emits through the normal local
  // append path, which signs with OUR device key automatically; the new
  // events replicate to the joiner in THIS session's delta phase
  // (summary is computed after handshake() returns). ---
  //
  // The account we actually BIND in the chain for a pair joiner (derived
  // from the PoP-proven pubkey, NOT claimedAccountId — see FIX A below).
  // Used as the session account on the pair path so the returned identity
  // matches what landed in the chain rather than the attacker-controlled
  // Hello value.
  let pairAdmittedAccountId: string | null = null;
  if (admissionToken) {
    const role = normalizeTokenRole(admissionToken.role);

    // SECURITY (owner takeover via pair admission, M2 review FIX A):
    // Hello.account_id (claimedAccountId) is ATTACKER-CONTROLLED — a QR
    // scanner can set it to ANY string, including buildLocalAccountId of
    // the vault's anchor pubkey (derivable from the QR's
    // vault_trust_anchor_pubkey). If we honoured it, the owner would emit
    // a vault_device_added attaching the scanner's PoP-proven key to the
    // OWNER's account → the scanner becomes an owner-bound device → full
    // takeover. So for the QR pair flow (the local-CA path by design) we
    // NEVER trust Hello.account_id to name the account. Instead we derive
    // the joiner's account SERVER-INDEPENDENTLY from the PoP-PROVEN device
    // pubkey — the same deterministic sentinel a local-only peer would
    // self-assign — so the account an attacker can name is pinned to the
    // one key they actually proved possession of.
    const joinerAccountId = buildLocalAccountId(claimedPubkeyB64);
    pairAdmittedAccountId = joinerAccountId;

    // SECURITY: a pair token admits a NEW device for a NEW joiner. It must
    // never re-bind to / impersonate an EXISTING member (re-admitting an
    // existing member's new device is the Members-UI re-add path, not QR
    // pair admission). Refuse if the derived joiner account already names
    // a member of this vault, or is the owner's own account. Without this,
    // the attack above survives even after deriving from the pubkey: the
    // attacker mints a fresh keypair whose buildLocalAccountId happens to
    // collide is infeasible, but a benign re-scan of an existing member's
    // QR could silently rebind — and more importantly this is the last
    // line of defence keeping pair admission strictly additive.
    const db = await getDb();
    const existingMirror = await db.getFirstAsync<{ one: number }>(
      `SELECT 1 AS one FROM vault_members_mirror WHERE vault_id = ? AND account_id = ? LIMIT 1`,
      opts.vaultId,
      joinerAccountId,
    );
    // Owner's own account: this device is the anchor holder, so the owner
    // account is the signed-in account if present, else the local sentinel
    // derived from THIS device's (= anchor) pubkey.
    const ownDevicePubkey = getDevicePubkey();
    const ownerAccountId =
      getAccountIdSync() ?? (ownDevicePubkey ? buildLocalAccountId(ownDevicePubkey) : null);
    if (existingMirror || joinerAccountId === ownerAccountId) {
      throw new MeshHandshakeError(
        `pair admission refused: derived joiner account ${joinerAccountId.slice(0, 16)} ` +
          `is an existing member or the owner — pair tokens admit NEW joiners only`,
        "vmc_invalid",
      );
    }

    // Re-fold local knowledge to keep the emissions idempotent across
    // re-pairs (duplicate admissions are no-ops in the fold, but we
    // avoid the duplicate event noise when we can).
    const state = await getLocalMembershipState(opts.vaultId);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const eventLog = require("../event-log") as {
      appendVaultMemberAdded: (args: {
        targetVaultId: string;
        accountId: string;
        role: "owner" | "manager" | "editor" | "clerk" | "viewer";
        displayName?: string | null;
      }) => Promise<{ event_id: string }>;
      appendVaultDeviceAdded: (args: {
        targetVaultId: string;
        accountId: string;
        deviceId: string;
        devicePubkeyB64: string;
      }) => Promise<{ event_id: string }>;
    };
    const member = state?.members.get(joinerAccountId);
    if (!member || member.removed) {
      await eventLog.appendVaultMemberAdded({
        targetVaultId: opts.vaultId,
        accountId: joinerAccountId,
        role,
        // Stamp the joiner's name (from their Hello) so the owner's Members tab
        // shows a real name, not the role label. Null-safe; persisted by the
        // display_name-preserving applier.
        displayName: peerHello.display_name ?? null,
      });
      console.log(
        "[mesh.hs] pair admission: vault_member_added account=",
        joinerAccountId.slice(0, 16),
        "role=",
        role,
      );
    }
    const dev = state?.devices.get(claimedPubkeyB64);
    if (
      !dev ||
      dev.removed ||
      dev.account_id !== joinerAccountId ||
      dev.device_id !== claimedDeviceId
    ) {
      // Bind EXACTLY the PoP-proven pubkey + the joiner's claimed
      // device_id to the derived joiner account — never claimedAccountId.
      await eventLog.appendVaultDeviceAdded({
        targetVaultId: opts.vaultId,
        accountId: joinerAccountId,
        deviceId: claimedDeviceId,
        devicePubkeyB64: claimedPubkeyB64,
      });
      console.log(
        "[mesh.hs] pair admission: vault_device_added device=",
        claimedDeviceId.slice(0, 8),
      );
    }
    // M4 (review fix): the pair window is ALREADY closed — claimPairNonce
    // consumed the nonce atomically (bound to this device's pubkey) BEFORE
    // PoP. No separate consume step; admission only reaches here because we
    // won the claim and then proved possession.
  }

  // --- 6. Gossip the peer's proof events through the normal ingest
  // pipeline. They're ordinary signed events — verifyAndIngest re-checks
  // every signature and dedups known event_ids, so this is safe and
  // usually a no-op; for a fresh joiner it's how the chain (incl.
  // genesis) lands BEFORE the delta loop, so the role-gate's chain
  // source can authenticate the owner's ledger events. Best-effort:
  // verification already succeeded over the in-memory copy. ---
  if (peerProofWire.length > 0) {
    try {
      const ingested = await applyIncomingBatch(opts.vaultId, peerProofWire);
      console.log(
        "[mesh.hs] proof bundle ingested new=",
        ingested.applied,
        "dup=",
        ingested.duplicates,
        "refused=",
        ingested.roleGateRejected,
      );
    } catch (err) {
      console.warn("[mesh.hs] proof bundle ingest failed (will retry via delta/sweep)", err);
    }
  }

  return {
    deviceId: claimedDeviceId,
    devicePubkeyB64: claimedPubkeyB64,
    // On the pair path the bound account is the one we DERIVED from the
    // PoP-proven pubkey (pairAdmittedAccountId), never the attacker-
    // controlled claimedAccountId (FIX A).
    accountId: verdict.ok ? verdict.account_id : (pairAdmittedAccountId ?? claimedAccountId),
    role: verdict.ok ? verdict.role : normalizeTokenRole(admissionToken?.role),
    proofEvents: peerProofEvents,
  };
}

/** D-PAIR-WITH-ROLE: the role committed at QR-issue time is canonical;
 *  ABSENT (legacy pre-role tokens) falls back to "editor" — that era's
 *  designed default. An UNKNOWN literal (roles v2: a future role this build
 *  doesn't recognize) clamps DOWN to "viewer", never up — a restricted role
 *  must degrade to read-only, not gain amend/delete authority. The owner
 *  carries this into the joiner's vault_member_added during pair admission. */
function normalizeTokenRole(role: string | undefined): VaultRole {
  if (role === undefined) return "editor";
  return parseVaultRole(role) ?? "viewer";
}

// ---------------------------------------------------------------------------
// Mid-session re-verification (every N batches)
// ---------------------------------------------------------------------------

async function reverifyPeerWindow(vaultId: string, peer: PeerSession): Promise<void> {
  if (await isRevoked(vaultId, peer.deviceId)) {
    throw new MeshVMCRevokedError(`peer device ${peer.deviceId} revoked mid-session`);
  }
  // Re-run the handshake verdict over (peer proof ∪ local events). Local
  // events are re-read each time, so a removal that arrived in THIS
  // session's own delta stream (revocation gossip) refuses the peer at the
  // next batch boundary. The admission-in-progress case is covered too: by
  // the time the delta loop runs, the owner has already emitted (and
  // locally applied) the admission events, so the fold knows the peer.
  const verdict = await verifyPeerMembership({
    vaultId,
    claimedDevicePubkeyB64: peer.devicePubkeyB64,
    proofEvents: peer.proofEvents,
  });
  if (!verdict.ok) {
    if (verdict.reason === "device_removed" || verdict.reason === "member_removed") {
      throw new MeshVMCRevokedError(
        `peer device ${peer.deviceId} removed from membership chain mid-session (${verdict.reason})`,
      );
    }
    throw new MeshHandshakeError(
      `peer membership verdict degraded mid-session (${verdict.reason})`,
      "vmc_invalid",
    );
  }
}

// v3 PoP message (chain path — the only path after M4). Binds:
//   POP_DOMAIN_V3 ASCII
//   || sha256(canonical proof-bundle commitment) (32 raw bytes)
//   || pop_nonce UTF-8 (the VERIFIER'S challenge)
//   || own_ephemeral_x25519_pubkey (32 raw bytes)
//   || peer_ephemeral_x25519_pubkey (32 raw bytes)
//
// The signer commits to the exact proof set they presented, so a MITM
// can't splice a different bundle under a recorded signature. Canonical
// form: the bundle's event_ids sorted lexicographically and joined with
// "\n" (transport order doesn't matter; an empty bundle hashes the empty
// string — the pair-admission case). The ephemeral-pubkey binding closes
// the Hello-mutation key-substitution seam (see POP_DOMAIN_V3 above);
// "own" / "peer" are from the signer's perspective.
function buildPopMessageV3(
  bundleEventIds: string[],
  pop_nonce: string,
  ownEphemeralPub: Uint8Array,
  peerEphemeralPub: Uint8Array,
): Uint8Array {
  // eslint-disable-next-line no-undef
  const enc = new TextEncoder();
  const d = enc.encode(POP_DOMAIN_V3);
  const h = sha256(enc.encode([...bundleEventIds].sort().join("\n")));
  const n = enc.encode(pop_nonce);
  const out = new Uint8Array(
    d.length + h.length + n.length + ownEphemeralPub.length + peerEphemeralPub.length,
  );
  let off = 0;
  out.set(d, off);
  off += d.length;
  out.set(h, off);
  off += h.length;
  out.set(n, off);
  off += n.length;
  out.set(ownEphemeralPub, off);
  off += ownEphemeralPub.length;
  out.set(peerEphemeralPub, off);
  return out;
}

// ---------------------------------------------------------------------------
// Proof-bundle wire mapping (M2c). The bundle reuses WireMeshEvent — the
// exact shape the delta loop already speaks — so received proof events
// can be handed straight to applyIncomingBatch for chain gossip.
// ---------------------------------------------------------------------------

function membershipEventToWire(e: MembershipEventLike): WireMeshEvent {
  return {
    event_id: e.event_id,
    event_type: e.event_type,
    vault_id: e.vault_id ?? "",
    target_id: e.target_id,
    relationship_id: e.relationship_id,
    hlc: { pms: e.hlc.pms, l: e.hlc.l, did: e.hlc.did },
    device_id: e.device_id,
    // M3.5: carry the membership event's author_seq through the bundle so the
    // receiver records it and the version vector reflects it (else membership
    // events would be re-sent on the delta channel every round).
    author_seq: e.author_seq ?? null,
    actor_account_id: e.actor_account_id,
    payload: e.payload,
    schema_version: e.payload_schema,
    event_sig_b64: e.event_sig_b64 ?? null,
    signer_device_pubkey: e.signer_device_pubkey ?? null,
  };
}

function wireToMembershipEvent(w: WireMeshEvent): MembershipEventLike {
  return {
    event_id: w.event_id,
    event_type: w.event_type,
    vault_id: w.vault_id,
    target_id: w.target_id ?? "",
    relationship_id: w.relationship_id,
    hlc: { pms: w.hlc.pms, l: w.hlc.l, did: w.hlc.did },
    device_id: w.device_id,
    author_seq: sanitizeWireAuthorSeq(w.author_seq),
    actor_account_id: w.actor_account_id,
    payload: w.payload,
    payload_schema: w.schema_version,
    event_sig_b64: w.event_sig_b64 ?? null,
    signer_device_pubkey: w.signer_device_pubkey ?? null,
  };
}

/** Minimal structural gate for received proof-bundle entries — enough
 *  that compareHLC / the fold / applyIncomingBatch can't trip on a
 *  malformed object. Content validity (signatures, authorization) is
 *  the fold's and verifyAndIngest's job, not this filter's. */
function isStructurallyValidWireEvent(w: unknown): w is WireMeshEvent {
  if (!w || typeof w !== "object") return false;
  const r = w as Record<string, unknown>;
  const hlc = r.hlc as Record<string, unknown> | undefined;
  return (
    typeof r.event_id === "string" &&
    r.event_id.length > 0 &&
    typeof r.event_type === "string" &&
    typeof r.vault_id === "string" &&
    typeof r.device_id === "string" &&
    hlc != null &&
    typeof hlc === "object" &&
    typeof hlc.pms === "number" &&
    typeof hlc.l === "number" &&
    typeof hlc.did === "string"
  );
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line no-undef
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecode(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  // eslint-disable-next-line no-undef
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Vault trust-anchor lookup (Phase 7 Part B)
// ---------------------------------------------------------------------------

function b64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line no-undef
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Load the trust anchor pubkey for a vault. Returns a 32-byte Uint8Array
 * for local-CA vaults, or null for server-anchored vaults (vaults row
 * column is NULL). Callers pass the result through to runAntiEntropy()
 * so the handshake verifies against the correct anchor.
 *
 * Migration 012 adds the vault_trust_anchor_pubkey column. On a device
 * that hasn't yet migrated, the column is missing entirely — the
 * try/catch around the SELECT defends against that case and treats it
 * as server-anchored (back-compat).
 */
export async function loadVaultTrustAnchor(vaultId: string): Promise<Uint8Array | null> {
  const db = await getDb();
  try {
    const row = await db.getFirstAsync<{
      vault_trust_anchor_pubkey: string | null;
    }>(`SELECT vault_trust_anchor_pubkey FROM vaults WHERE id = ?`, vaultId);
    if (!row || !row.vault_trust_anchor_pubkey) return null;
    try {
      const bytes = b64ToBytes(row.vault_trust_anchor_pubkey);
      if (bytes.length !== 32) return null;
      return bytes;
    } catch {
      return null;
    }
  } catch {
    // Column missing (pre-migration-012) — server-anchor fallback.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary computation
// ---------------------------------------------------------------------------

/**
 * M3.5: compute our per-author RELAYABLE contiguous frontier vector — the
 * summary we advertise. For each author device, the highest author_seq N such
 * that we hold AND WILL RELAY all of 1..N. "Relayable" = passes the same relay
 * filter the send query uses (tombstone / unknown_actor / rejected withheld),
 * so everything we advertise we can actually satisfy — no held-but-unsendable
 * holes. computeContiguous gives the contiguous prefix; a withheld seq
 * ceilings it (a bad-sig tombstone at seq N → frontier N-1; an unknown_actor
 * device whose whole stream is withheld → frontier 0, omitted).
 *
 * FORWARD QUARANTINED ROWS (M3.5 review fix). We do NOT withhold quarantined
 * rows (incl. unknown_actor). The original relay filter assumed unknown_actor
 * was all-or-nothing per device so its withheld region was always a suffix —
 * but quarantine is assigned PER EVENT / per-HLC (a device removed at HLC H
 * quarantines only its post-H events; a role-'none' event like account_bound
 * applies unconditionally). author_seq is ONE shared space across all event
 * types for a (vault,device), so a relayable event can sit ABOVE a quarantine
 * hole — withholding the quarantined seq would strand it permanently. A
 * quarantined event is validly SIGNED (only its role is unverifiable locally),
 * so an honest relay forwarding it is safe: the receiver's own role-gate
 * re-quarantines it at apply time (receipt ≠ apply), it never reaches the
 * ledger, and the seq space stays contiguous. We still withhold ONLY
 * tombstone (bad-sig garbage that could poison) and rejected (server-refused).
 *
 * RECEIPT vs RELAY: a tombstoned row still counts as HELD for dedup (event_id
 * PK), but is not relayable, so it ceilings the advertised frontier (rare;
 * the good copy propagates from the author). A corrupt-payload row the sweep
 * hasn't tombstoned yet likewise ceilings the SEND; it self-resolves once the
 * sweep tombstones it.
 */
export async function computeRelayableVector(vaultId: string): Promise<Vector> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ device_id: string; author_seq: number }>(
    `SELECT device_id, author_seq
       FROM event_log
      WHERE vault_id = ?
        AND author_seq IS NOT NULL
        AND tombstone_reason IS NULL
        AND rejected_at IS NULL
      ORDER BY device_id ASC, author_seq ASC`,
    vaultId,
  );
  const perDevice = new Map<string, number[]>();
  for (const r of rows) {
    let list = perDevice.get(r.device_id);
    if (!list) {
      list = [];
      perDevice.set(r.device_id, list);
    }
    list.push(r.author_seq);
  }
  const vector: Vector = {};
  for (const [device, seqs] of perDevice) {
    const frontier = computeContiguous(seqs).frontier;
    // frontier 0 = nothing relayable from seq 1; omit so the wire stays small
    // and planRangesToSend treats it as "peer has nothing" (sends from 1).
    if (frontier > 0) vector[device] = frontier;
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Volume estimation for the wifi-upgrade decision (M3.5)
// ---------------------------------------------------------------------------

/**
 * Total events across the planned author_seq ranges — the EXACT count we'll
 * SEND this round (each inclusive range contributes to_seq - from_seq + 1).
 * Replaces the HLC-floor count; the SEND direction is now exact rather than
 * estimated. (The peer's RECEIVE-direction count still needs a round we don't
 * do, so the caller keeps the 2× doubling.)
 */
function countRangeEvents(ranges: SeqRange[]): number {
  let total = 0;
  for (const r of ranges) total += Math.max(0, r.to_seq - r.from_seq + 1);
  return total;
}

// ---------------------------------------------------------------------------
// Send-side cursor (M3.5: walks the planned author_seq ranges in order)
// ---------------------------------------------------------------------------

type SendCursor = {
  ranges: SeqRange[];
  rangeIdx: number;
  /** Next author_seq to fetch within ranges[rangeIdx]. */
  nextSeq: number;
};

function newSendCursor(ranges: SeqRange[]): SendCursor {
  return { ranges, rangeIdx: 0, nextSeq: ranges[0]?.from_seq ?? 0 };
}

async function fetchNextBatch(
  vaultId: string,
  cursor: SendCursor,
  limit: number,
): Promise<WireMeshEvent[]> {
  const db = await getDb();
  const batch: WireMeshEvent[] = [];

  const advanceRange = () => {
    cursor.rangeIdx++;
    cursor.nextSeq = cursor.ranges[cursor.rangeIdx]?.from_seq ?? 0;
  };

  while (batch.length < limit) {
    const range = cursor.ranges[cursor.rangeIdx];
    if (!range) return batch; // all ranges exhausted
    if (cursor.nextSeq > range.to_seq) {
      advanceRange();
      continue;
    }

    const remaining = limit - batch.length;
    const rows = await db.getAllAsync<{
      event_id: string;
      event_type: string;
      target_id: string | null;
      relationship_id: string | null;
      hlc_physical_ms: number;
      hlc_logical: number;
      hlc_device_id: string;
      device_id: string;
      actor_account_id: string | null;
      payload_json: string;
      payload_schema: number;
      event_sig_b64: string | null;
      signer_device_pubkey: string | null;
      author_seq: number;
    }>(
      // SAME relay filter as computeRelayableVector (forward quarantined; only
      // tombstone/rejected withheld) — the advertised frontier and the
      // sendable set MUST agree, else the peer requests a seq we withhold and
      // its frontier stalls. ORDER BY author_seq so the receiver's frontier
      // advances contiguously.
      `SELECT event_id, event_type, target_id, relationship_id,
              hlc_physical_ms, hlc_logical, hlc_device_id,
              device_id, actor_account_id, payload_json, payload_schema,
              event_sig_b64, signer_device_pubkey, author_seq
         FROM event_log
        WHERE vault_id = ?
          AND device_id = ?
          AND author_seq IS NOT NULL
          AND author_seq >= ?
          AND author_seq <= ?
          AND tombstone_reason IS NULL
          AND rejected_at IS NULL
        ORDER BY author_seq ASC
        LIMIT ?`,
      vaultId,
      range.device_id,
      cursor.nextSeq,
      range.to_seq,
      remaining,
    );

    if (rows.length === 0) {
      // Range drained — move on. (A planned range is contiguous-relayable, so
      // this means we've sent it all.)
      advanceRange();
      continue;
    }

    // Defensive: a planned range should be hole-free, but if the first row is
    // above nextSeq there is a hole at nextSeq we can't relay — ceiling this
    // device's stream rather than sending events above the hole (which would
    // stall the peer's frontier). Self-corrects when the missing seq fills.
    if (rows[0].author_seq > cursor.nextSeq) {
      console.warn(
        `[mesh.fetch] unexpected hole at ${range.device_id}#${cursor.nextSeq} — ceiling device stream`,
      );
      advanceRange();
      continue;
    }

    let ceilinged = false;
    let lastSeq = cursor.nextSeq - 1;
    for (const r of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(r.payload_json);
      } catch (err) {
        // Corrupt payload: ceiling THIS device's stream here — don't relay it
        // or anything above it (sending above would stall the peer at this
        // seq forever). The sweep tombstones such rows, after which
        // computeRelayableVector ceilings the advertised frontier to match.
        console.error(
          `[mesh.fetch] payload_json corrupt for event=${r.event_id} type=${r.event_type} — ceiling device stream`,
          err,
        );
        ceilinged = true;
        break;
      }
      batch.push({
        event_id: r.event_id,
        event_type: r.event_type,
        vault_id: vaultId,
        target_id: r.target_id,
        relationship_id: r.relationship_id,
        hlc: {
          pms: r.hlc_physical_ms,
          l: r.hlc_logical,
          did: r.hlc_device_id,
        },
        device_id: r.device_id,
        author_seq: r.author_seq,
        actor_account_id: r.actor_account_id,
        payload,
        schema_version: r.payload_schema,
        event_sig_b64: r.event_sig_b64,
        signer_device_pubkey: r.signer_device_pubkey,
      });
      lastSeq = r.author_seq;
    }

    if (ceilinged) {
      advanceRange();
    } else {
      cursor.nextSeq = lastSeq + 1;
    }
  }

  return batch;
}

// ---------------------------------------------------------------------------
// Receive-side application
// ---------------------------------------------------------------------------

// Migration 014 / Mythos round-3 design.
//
// applyIncomingBatch was renamed (conceptually) to ingestIncomingBatch:
// we INGEST every signature-verified event durably, then schedule a
// sweep to attempt apply. The legacy "applied / duplicates /
// roleGateRejected" counters survive as the outward shape so the
// caller (runAntiEntropy's logging) doesn't need to change, but their
// meaning is updated:
//
//   - applied: number of NEW rows INSERTED with ingested_at set.
//              "Apply" happens later via the sweep; at batch-end time
//              we don't yet know how many applied. Telemetry reflects
//              receipt count.
//   - duplicates: number of events whose event_id was already in
//                 event_log. Genuine duplicate-by-PK now — the
//                 over-counting Mythos round-2 audit-item #4 flagged
//                 is fixed (we no longer count role-gate rejections
//                 OR applier throws as duplicates).
//   - roleGateRejected: number of tombstone_reason='bad_signature' or
//                       'unsigned_event' INSERTs from verifyAndIngest.
//                       Cryptographic refusals. NAME is preserved for
//                       caller-side log compatibility; semantic is
//                       "cryptographic ingest refusal."
//
// The sweep mutex is taken around the WHOLE batch so a concurrent
// scheduleSweep that fires mid-batch (triggered by our own ingest
// hooks) doesn't interleave with the INSERT loop.
/**
 * M3.5 (review fix): coerce a WIRE author_seq to a clean value before it can
 * reach event_log. author_seq is NOT in the signed envelope, so a PoP-proven
 * peer can put anything here; bound the damage to the documented integer
 * slot-squat by rejecting non-integers / non-positives to null. (The deeper
 * re-stamp/suppression fix — signing author_seq — is deferred per the design.)
 */
function sanitizeWireAuthorSeq(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

async function applyIncomingBatch(
  expectedVaultId: string,
  events: WireMeshEvent[],
): Promise<{ applied: number; duplicates: number; roleGateRejected: number }> {
  // Lazy-import to avoid hauling projection/sweep into mesh's module
  // graph at import time — projection/sweep imports getDb which
  // initializes at runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sweepMutex, scheduleSweep } = require("../projection/sweep") as {
    sweepMutex: { runExclusive: <T>(cb: () => Promise<T> | T) => Promise<T> };
    scheduleSweep: (vaultId: string) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifyAndIngest } = require("../ingest-types") as {
    verifyAndIngest: (event: LedgerEvent, ctx: IngestContextType) => Promise<IngestVerdictType>;
  };
  // The durable-ingest INSERT (event_log row + author_seq slot pre-check + HLC
  // frontier bump) is SHARED with the server-pull / restore paths so the two
  // replication channels can never silently diverge (the root lesson of the
  // 2026-06-25 restore data-loss bug). Lazy-required to match the sweep import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ingestRowInTx } = require("../projection/ingest-row") as {
    ingestRowInTx: (
      tx: Awaited<ReturnType<typeof getDb>>,
      event: LedgerEvent,
      ingestedAtMs: number,
      serverAckedAt: number | null,
    ) => Promise<boolean>;
  };
  // TWO-MUTEX LAYERING: sweepMutex (taken below, whole-batch) only excludes
  // other sweeps / mesh batches. Each ingest TRANSACTION additionally takes
  // applyEventMutex — expo-sqlite's withTransactionAsync is NON-exclusive on
  // the single shared connection, so a concurrent applyEvent / push-ack /
  // ingestPulledEvents BEGIN would tear one of the open txs into autocommit
  // (silent half-ingested state). Lock order is always sweepMutex →
  // applyEventMutex, never the reverse (nothing acquires sweepMutex while
  // holding applyEventMutex — applyEvent schedules its sweep AFTER release,
  // via the debounce timer), so the non-reentrant Mutex cannot deadlock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyEventMutex } = require("../projection/index") as {
    applyEventMutex: { runExclusive: <T>(cb: () => Promise<T> | T) => Promise<T> };
  };

  let ingested = 0;
  let duplicates = 0;
  let cryptoRefused = 0;

  // Mutex-protect the ingest sweep against concurrent sweeps.
  await sweepMutex.runExclusive(async () => {
    const db = await getDb();
    const sorted = [...events].sort((a, b) => compareHLC(a.hlc, b.hlc));

    // IngestContext bound to this batch's vault + db. Hoisted out of
    // the loop so each event reuses the same closure.
    const ctx: IngestContextType = {
      hasEventId: async (eventId: string) => {
        const row = await db.getFirstAsync<{ n: number }>(
          `SELECT 1 AS n FROM event_log WHERE event_id = ? LIMIT 1`,
          eventId,
        );
        return row != null;
      },
      countUnknownActorQuarantine: async (vaultId: string, deviceId: string) => {
        const row = await db.getFirstAsync<{ c: number }>(
          `SELECT COUNT(*) AS c
             FROM event_log
            WHERE vault_id = ? AND device_id = ?
              AND quarantine_reason = 'unknown_actor'`,
          vaultId,
          deviceId,
        );
        return row?.c ?? 0;
      },
      insertIngested: async (event: LedgerEvent, ingestedAtMs: number) => {
        // Durable INSERT (event_log row, applied_at=NULL) + author_seq slot
        // pre-check + HLC frontier bump, in one txn. Shared with the
        // server-pull / restore paths via ingestRowInTx so the durability
        // contract is identical everywhere. serverAckedAt=null: a mesh-relayed
        // event is NOT necessarily on the server yet, so it must remain in the
        // push outbox until the server acks it. applyEventMutex wraps the tx —
        // see the two-mutex layering comment at the require site above.
        await applyEventMutex.runExclusive(() =>
          db.withTransactionAsync(async () => {
            await ingestRowInTx(db, event, ingestedAtMs, null);
          }),
        );
      },
      insertTombstoned: async (event: LedgerEvent, tombstoneReason, ingestedAtMs: number) => {
        // Same two-mutex layering as insertIngested (sweepMutex held by the
        // batch, applyEventMutex around the tx) — see the require site above.
        await applyEventMutex.runExclusive(() =>
          db.withTransactionAsync(async () => {
            // M3.5 (review fix): a tombstoned (bad-sig / corrupt) row is garbage
            // that never applies and is NOT relayable, so it must NOT claim an
            // author_seq slot — otherwise it would squat the seq that the
            // legitimate event owns and strand it (slot pre-check would sacrifice
            // the real event's seq). Persist author_seq = NULL. Dedup still works
            // via the event_id PK. INSERT OR IGNORE so a re-received tombstone is
            // an idempotent no-op rather than a swallowed PK violation.
            await db.runAsync(
              `INSERT OR IGNORE INTO event_log (
               event_id, event_type, vault_id, target_id, relationship_id,
               hlc_physical_ms, hlc_logical, hlc_device_id,
               device_id, author_user_id_local_only, actor_account_id,
               payload_json, payload_schema,
               appended_at, server_acked_at, rejected_at, origin,
               event_sig_b64, signer_device_pubkey,
               ingested_at, applied_at, quarantine_reason, tombstone_reason, author_seq
             ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, NULL, NULL, ?, NULL)`,
              event.event_id,
              event.event_type,
              event.vault_id,
              event.target_id,
              event.relationship_id,
              event.hlc.pms,
              event.hlc.l,
              event.hlc.did,
              event.device_id,
              event.author_user_id_local_only ?? "",
              event.actor_account_id,
              JSON.stringify(event.payload),
              event.payload_schema,
              ingestedAtMs,
              null,
              null,
              "remote",
              event.event_sig_b64 ?? null,
              event.signer_device_pubkey ?? null,
              ingestedAtMs,
              tombstoneReason,
            );
            // Even for tombstones we bump the HLC frontier: we DID see
            // this HLC, and the head advances. Bad-sig events should
            // count for "I have received this" exactly the same as good
            // events — that's the Critical-1 fix's whole point.
            const prevRaw = await getAppMetaInTx(db, HLC_LAST_KEY);
            const prev = prevRaw ? deserializeHLC(prevRaw) : null;
            const merged = tickReceive(prev, event.hlc, Date.now(), getInstallIdSync());
            await setAppMetaInTx(db, HLC_LAST_KEY, serializeHLC(merged));
          }),
        );
      },
    };

    for (const w of sorted) {
      if (!isKnownEventType(w.event_type)) {
        // Schema-invalid at the wire level. The new code path doesn't
        // even insert these — same behavior as today's `continue`,
        // but log loud so an unknown event_type is investigable.
        console.warn(
          `[mesh.delta] skipping unknown event_type ${w.event_type} event=${w.event_id}`,
        );
        continue;
      }
      if (w.vault_id !== expectedVaultId) continue;

      const event: LedgerEvent = {
        event_id: w.event_id,
        event_type: w.event_type,
        vault_id: w.vault_id,
        target_id: w.target_id ?? "",
        relationship_id: w.relationship_id ?? null,
        hlc: w.hlc,
        device_id: w.device_id,
        // M3.5: carry the author's canonical seq through to insertIngested /
        // insertTombstoned, which persist it (with a slot pre-check). Sanitized
        // at this wire boundary so a hostile peer's garbage can't reach the DB.
        author_seq: sanitizeWireAuthorSeq(w.author_seq),
        // author_user_id_local_only never crosses the wire (events.ts
        // envelope comment). Set to "" for remote-origin events.
        author_user_id_local_only: "",
        actor_account_id: w.actor_account_id,
        payload: w.payload,
        payload_schema: w.schema_version,
        appended_at: Date.now(),
        server_acked_at: null,
        rejected_at: null,
        origin: "remote",
        event_sig_b64: w.event_sig_b64 ?? null,
        signer_device_pubkey: w.signer_device_pubkey ?? null,
      } as unknown as LedgerEvent;

      let verdict: IngestVerdictType;
      try {
        verdict = await verifyAndIngest(event, ctx);
      } catch (err) {
        console.warn(`[mesh.delta] verifyAndIngest threw for ${w.event_id}`, err);
        continue;
      }

      switch (verdict.kind) {
        case "ingested":
          ingested++;
          break;
        case "tombstoned":
          if (verdict.reason === "bad_signature" || verdict.reason === "unsigned_event") {
            cryptoRefused++;
            console.warn(
              `[mesh.delta] event tombstoned at ingest event=${w.event_id} reason=${verdict.reason}`,
            );
          } else {
            // 'schema_invalid' tombstones from ingest are rare (no
            // current verifyAndIngest path produces them). Treat as
            // cryptoRefused for log-shape stability.
            cryptoRefused++;
          }
          break;
        case "refused_pre_insert":
          if (verdict.reason === "duplicate") {
            duplicates++;
          } else {
            // Cap hit / missing pubkey / pre-insert bad sig (the last
            // never happens today because verifyAndIngest tombstones
            // bad-sig). Log loud — these are operationally interesting.
            console.warn(
              `[mesh.delta] event refused pre-insert event=${w.event_id} reason=${verdict.reason}`,
            );
          }
          break;
      }
    }

    // Trigger (a): a new ingest MAY cure things in quarantine. Sweep
    // is debounced, so calling once per batch is correct. Inside the
    // mutex so it doesn't double-fire if scheduleSweep was also called
    // by the per-event INSERT triggers.
    scheduleSweep(expectedVaultId);
  });

  return {
    applied: ingested,
    duplicates,
    roleGateRejected: cryptoRefused,
  };
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

async function sendMessage(conn: MeshConnection, msg: AnyMessage): Promise<void> {
  const json = JSON.stringify(msg);
  if (json.length > MAX_MESSAGE_BYTES) {
    throw new MeshTransportError(
      `outbound message too large: ${json.length} bytes > ${MAX_MESSAGE_BYTES}`,
      "msg_too_large",
    );
  }
  try {
    await conn.sendJSON(msg);
  } catch (err) {
    throw new MeshTransportError(`send failed: ${(err as Error).message}`, "send_failed");
  }
}

async function recvTyped<T extends AnyMessage>(
  conn: MeshConnection,
  expectedType: T["type"],
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new MeshTransportError(`recv timeout exhausted (<= 0 ms remaining)`, "timeout");
  }
  let raw: unknown;
  try {
    raw = await conn.recvJSON(timeoutMs);
  } catch (err) {
    throw new MeshTransportError(`recv failed: ${(err as Error).message}`, "recv_failed");
  }
  if (!raw || typeof raw !== "object") {
    throw new MeshTransportError(`recv: non-object message`, "bad_payload");
  }
  // The BTC transport resolves a pending recv with {__closed:true} when the
  // socket drops. Without this check it falls through to the version gate and
  // surfaces the misleading "unsupported wire version undefined" — really it
  // means the peer hung up (or we connected to the wrong RFCOMM service).
  if ((raw as { __closed?: unknown }).__closed === true) {
    // Name the phase we died waiting for ('hello' = start, 'vector'/'delta' =
    // post-handshake ledger sync) so a drop is diagnosable without adb.
    throw new MeshTransportError(
      `recv: connection closed waiting for '${expectedType}' (peer hung up / dropped mid-sync)`,
      "recv_failed",
    );
  }
  const m = raw as { type?: unknown; v?: unknown };
  // M3.5: only v:3 (the author_seq version-vector protocol) is accepted —
  // full cutover, no backwards-compat. A pre-v3 peer is refused here at the
  // transport layer (and at the Hello version gate).
  if (typeof m.v !== "number" || !SUPPORTED_WIRE_VERSIONS.has(m.v)) {
    throw new MeshTransportError(
      `recv: unsupported wire version ${String(m.v)} (expected one of ${[...SUPPORTED_WIRE_VERSIONS].join(",")})`,
      "bad_version",
    );
  }
  if (m.type !== expectedType) {
    throw new MeshTransportError(
      `recv: expected ${expectedType}, got ${String(m.type)}`,
      "bad_type",
    );
  }
  return raw as T;
}
