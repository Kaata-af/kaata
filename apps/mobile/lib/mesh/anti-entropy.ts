// apps/mobile/lib/mesh/anti-entropy.ts
//
// HLC-based anti-entropy delta swap over an established MeshConnection.
//
// Design D-ANTI-ENTROPY (Phase 5):
//   1. Handshake — exchange + verify VMCs against pinned server pubkey,
//      then PROOF-OF-POSSESSION: each side challenges the peer with a
//      32-byte CSPRNG nonce; the peer signs (DOMAIN || self_vmc || nonce)
//      with their device privkey and we verify against the device_pubkey
//      embedded in the VMC. Without this step a leaked VMC blob would be
//      usable by any device that ever observed it (migration 009 promises
//      "leaked VMCs are unusable elsewhere" — proof-of-possession is what
//      delivers that promise).
//   2. Summary  — each side sends max HLC per device_id for this vault.
//   3. Delta    — each side streams events the other doesn't have, in
//                 HLC-ASC order, in 500-event batches, until has_more=false
//                 on both sides.
//   4. Disconnect.
//
// Lawful-at-HLC ACL on mesh: VMCs encode (role, vault_epoch). A peer whose
// VMC vault_epoch is STRICTLY LESS THAN ours is rejected — the peer will
// refresh via /v1/check-in on the next online encounter. ACL re-application
// happens locally — applyEvent is the single source of truth, and the
// server's PullEvents path re-stamps actor_account_id retroactively when
// this device next reaches the server.
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
//     phase implements per-session X25519 ECDH (key = ECDH(own_device_priv,
//     peer_device_pub-from-VMC) → HKDF-SHA512 → ChaCha20-Poly1305 per
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
//   - VMC expiry mid-sync: re-checked at each batch boundary with the same
//     EXPIRY_SKEW_TOLERANCE_MS leeway as the initial verifyVMC, avoiding a
//     livelock where a slow-clock peer's VMC verifies once and gets killed
//     on the first batch's mid-session check.
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
import * as Crypto from "expo-crypto";

import { compareHLC, type HLC } from "../hlc";
import { applyEvent } from "../projection";
import { getDb } from "../db-tx";
import type { LedgerEvent } from "../events";
import { isKnownEventType } from "../events";

import {
  MeshHandshakeError,
  MeshVMCExpiredError,
  MeshVMCRevokedError,
  MeshTransportError,
} from "./errors";
import {
  generateEphemeralKeyPair,
  deriveSessionAead,
  wipeEphemeralPriv,
  X25519_PUBKEY_BYTES,
  type EphemeralKeyPair,
  type BleAeadContext,
} from "./aead";
import {
  decodeDevicePubkey,
  EXPIRY_SKEW_TOLERANCE_MS,
  getCachedVMC,
  isRevoked,
  peekVMCDeviceId,
  type ParsedVMC,
  verifyVMC,
} from "./vmc";
import { signWithDeviceKey } from "./device-key";
import type { MeshConnection } from "./transport-interface";

// Domain-separation tag for proof-of-possession signatures. Prevents the
// signed challenge from being usable as a signature on any other Kaata
// message that might be signed by the same device key in the future.
//
// v2 (v0.5.2 final) ALSO binds both ephemeral X25519 pubkeys into the
// signed message. Without that binding, a Hello-mutation attacker could
// substitute their own ephemeral pubkey in transit, the peer signs PoP
// (which only covered nonces + VMC), and the AEAD key would be derived
// against the attacker's pub — leaking traffic. Engineering critique N#2.
// Bumping the domain string also forces a clean rejection if a v1 peer
// somehow connects (their signature won't verify under the v2 message).
const POP_DOMAIN = "kaata-mesh-handshake-pop-v2";

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 1;

export type HelloMessage = {
  type: "hello";
  v: typeof WIRE_VERSION;
  vmc_blob: string;
  capabilities: string[];
  // 32-byte CSPRNG nonce as URL-safe base64 (no padding). The peer must
  // return its signature over (POP_DOMAIN || own_vmc_bytes || this_nonce)
  // in their PopProofMessage. Without this proof-of-possession round, a
  // VMC leaked from a backup or rooted phone would be replayable from any
  // device.
  pop_nonce: string;
  // Phase 6 follow-up: ephemeral X25519 public key (32 bytes, base64url).
  // Combined with the peer's ephemeral pubkey + both pop_nonces it
  // derives a per-session ChaCha20-Poly1305 key for the BLE transport.
  // Mandatory since v0.5.2 — peers without it are rejected as "too old"
  // because the BLE link must NOT carry plaintext ledger data.
  ephemeral_x25519_pubkey: string;
};

export type PopProofMessage = {
  type: "pop_proof";
  v: typeof WIRE_VERSION;
  // ed25519 signature (base64) by the peer's device privkey over the bytes
  // (POP_DOMAIN || peer_vmc_blob || our_nonce). Verified against the
  // device_pubkey embedded in the peer's already-verified VMC.
  sig: string;
};

export type SummaryMessage = {
  type: "summary";
  v: typeof WIRE_VERSION;
  vault_id: string;
  max_hlc_per_device: Record<string, HLC>;
};

export type WireMeshEvent = {
  event_id: string;
  event_type: string;
  vault_id: string;
  target_id: string | null;
  relationship_id: string | null;
  hlc: HLC;
  device_id: string;
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

type AnyMessage = HelloMessage | PopProofMessage | SummaryMessage | DeltaMessage | ByeMessage;

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
  localVMCBlob: string;
  vaultId: string;
  /**
   * Phase 7: per-vault trust anchor pubkey (32 bytes, Ed25519). Pass
   * when the vault is local-CA-anchored
   * (vaults.vault_trust_anchor_pubkey populated). The peer's VMC will
   * be verified against this key only, and the peer is required to
   * present a `kaata-mesh-local-v1`-issued VMC. Omit/null for
   * server-anchored vaults — verification falls back to the pinned
   * server pubkey in app_meta and a `kaata-mesh-v1` issuer.
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

  // --- 1. Handshake (VMC + proof-of-possession + epoch compare) ---
  const peerVMC = await handshake(conn, opts);

  // --- 2. Summary exchange ---
  const localSummary = await computeSummary(opts.vaultId);
  const [, peerSummary] = await Promise.all([
    sendMessage(conn, {
      type: "summary",
      v: WIRE_VERSION,
      vault_id: opts.vaultId,
      max_hlc_per_device: localSummary,
    } satisfies SummaryMessage),
    recvTyped<SummaryMessage>(conn, "summary", deadline - Date.now()),
  ]);
  console.log(
    "[mesh.summary] exchanged ourDevices=",
    Object.keys(localSummary).length,
    "peerDevices=",
    Object.keys(peerSummary.max_hlc_per_device).length,
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
  // The estimate uses a one-sided count (delta events we'd SEND) plus the
  // peer's pending count, which we approximate via the symmetric summary:
  // any device the peer's max_hlc trails ours on contributes pending events
  // in the SEND direction; any device our max_hlc trails the peer's
  // contributes in the RECEIVE direction. The actual peer-receive count
  // requires a separate exchange round, deferred — see countDeltaEventsFromSummary.
  if (conn.kind === "ble" && opts.coordinateUpgrade && opts.upgradeListenPort != null) {
    try {
      const sendCount = await countDeltaEventsFromSummary(
        opts.vaultId,
        peerSummary.max_hlc_per_device,
      );
      // We cannot precisely know the peer's pending count without a
      // separate count-exchange round (the summary message only carries
      // head HLCs). For the prompt threshold we use 2× our sendCount as
      // a conservative upper bound — captures the bi-directional case
      // typical at vault-join time.
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
            peerDeviceId: peerVMC.device_id,
          };
        }
        if (choice === "wifi") {
          const upgradeResult = await opts.coordinateUpgrade.coordinateWifiUpgrade(conn, {
            ownPeerId: opts.coordinateUpgrade.ownDeviceId,
            peerId: peerVMC.device_id,
            vaultId: opts.vaultId,
            estimatedSeconds: opts.coordinateUpgrade.estimateBleSeconds(totalEstimated),
            totalEvents: totalEstimated,
            listenPort: opts.upgradeListenPort,
            peerLabel: opts.peerLabel,
          });
          if (upgradeResult.success && upgradeResult.newConnection) {
            // CRITICAL: re-run the full handshake on the new WebRTC
            // connection AND verify the device_id matches the one we
            // authenticated on BLE. This defends against a LAN MITM
            // hijacking the upgrade via mDNS race.
            const wifiConn = upgradeResult.newConnection;
            const expected = upgradeResult.expectedPeerDeviceId;
            try {
              const newPeer = await handshake(wifiConn, opts);
              if (expected && newPeer.device_id !== expected) {
                // Identity mismatch — close WebRTC and stay on BLE.
                try {
                  await wifiConn.close();
                } catch {
                  /* */
                }
                if (__DEV__) {
                  console.warn(
                    "[anti-entropy] wifi-upgrade identity mismatch: BLE=",
                    expected,
                    "WebRTC=",
                    newPeer.device_id,
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
  let sent = 0;
  let received = 0;
  let duplicates = 0;
  const sendState = newSendCursor(peerSummary.max_hlc_per_device);
  let localSentDone = false;
  let peerSentDone = false;
  let sentBatches = 0;
  let receivedBatches = 0;
  let totalLoopIters = 0;

  while (!(localSentDone && peerSentDone)) {
    if (Date.now() > deadline) {
      throw new MeshTransportError(
        `anti-entropy exceeded max duration ${maxDurationMs}ms`,
        "timeout",
      );
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
      await reverifyVMCWindow(peerVMC);
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

  return {
    sent,
    received,
    duplicates,
    durationMs,
    peerDeviceId: peerVMC.device_id,
  };
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

async function handshake(conn: MeshConnection, opts: AntiEntropyOptions): Promise<ParsedVMC> {
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

  const hello: HelloMessage = {
    type: "hello",
    v: WIRE_VERSION,
    vmc_blob: opts.localVMCBlob,
    capabilities: ["v1"],
    pop_nonce: ourNonceB64,
    ephemeral_x25519_pubkey: ourEphemeralPubB64,
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
  // Handshake gate order (Design D-REVOCATION-GOSSIP):
  //
  //   1. Recv peer Hello (vmc_blob + pop_nonce).
  //   2. PEEK the unverified vault_id + device_id out of the blob.
  //   3. revocation_list lookup on (vault_id, device_id) — if present, REJECT
  //      with MeshVMCRevokedError. (Cheap SQL query; skips Ed25519 verify
  //      cost on known-revoked peers, and keeps the rejection reason crisp
  //      even when a removed peer's VMC would still cryptographically
  //      verify because their signature is intact.)
  //   4. verifyVMC — Ed25519 signature + expiry + issuer + role + vault_id
  //      match against the pinned trust anchor (server pubkey OR local-CA
  //      pubkey for Phase 7 local-CA vaults).
  //   5. revocation_list lookup AGAIN on the now-trusted device_id. Defense
  //      in depth: if step 3 was dodged by a malformed/lying blob carrying
  //      a different device_id, we re-check against the verified one.
  //      Idempotent and cheap.
  //   6. vault_epoch comparison — refuse peers strictly older than our
  //      cached vault_epoch (forces them to refresh via /v1/check-in).
  //   7. Proof-of-possession exchange (challenge-response over device key).
  //   8. Summary / delta data exchange.
  //
  // Why the early peek matters: a peer removed via the offline owner-
  // emitted vault_member_removed event (Phase D) still holds a
  // cryptographically valid VMC — the local-CA signature on it doesn't
  // become invalid; only the revocation row makes them unwelcome. The
  // ONLY thing standing between a fired staff member and an active sync
  // session is this revocation_list check, so we run it as early as
  // possible and again post-verify.
  //
  // Race note: revocation gossip received during the SAME batch as an
  // in-flight handshake does NOT kill the current session — the row may
  // not have landed yet when this handshake's checks ran. Acceptable per
  // design: the removed peer can only deliver events they authored
  // BEFORE removal in this batch, and the next handshake will see the
  // updated revocation_list and reject. The mid-session reverifyVMCWindow
  // (every N batches) closes most of this window in practice.
  // -------------------------------------------------------------------------

  // Step 2-3: early revocation check on unverified header fields.
  const peeked = peekVMCDeviceId(peerHello.vmc_blob);
  if (peeked && (await isRevoked(peeked.vault_id, peeked.device_id))) {
    throw new MeshVMCRevokedError(
      `peer device ${peeked.device_id} is revoked from vault ${peeked.vault_id} (early reject, pre-verify)`,
    );
  }
  console.log("[mesh.hs] revocation pre-check OK");

  // Step 4: verify signature + envelope.
  const verifyResult = await verifyVMC(
    peerHello.vmc_blob,
    opts.vaultId,
    opts.vaultTrustAnchorPubkey ?? null,
  );
  if (!verifyResult.valid) {
    if (verifyResult.error === "expired") {
      throw new MeshVMCExpiredError(`peer VMC expired: ${verifyResult.detail ?? ""}`);
    }
    throw new MeshHandshakeError(
      `peer VMC verification failed (${verifyResult.error}): ${verifyResult.detail ?? ""}`,
      "vmc_invalid",
    );
  }
  const peerVMC = verifyResult.vmc;
  console.log(
    "[mesh.hs] VMC verified peer device=",
    peerVMC.device_id.slice(0, 8),
    "role=",
    peerVMC.role,
  );

  // Step 5: re-check revocation against the now-trusted device_id (defense
  // in depth — covers the case where the unverified peek in step 3 returned
  // null due to a malformed blob that nonetheless verified, or where a
  // forged blob in step 3 carried a different device_id than the signed
  // one).
  if (await isRevoked(peerVMC.vault_id, peerVMC.device_id)) {
    throw new MeshVMCRevokedError(
      `peer device ${peerVMC.device_id} is revoked from vault ${peerVMC.vault_id}`,
    );
  }

  // Lawful-at-HLC ACL: refuse peers carrying a STRICTLY LESS vault_epoch
  // than ours. They will refresh on their next online check-in. Equal-or-
  // greater is fine — we may be the stale party in the inverse direction
  // and they'll get the chance to refuse us via the same check on their
  // side. (Both sides being equal is the steady-state case.)
  const ourCached = await getCachedVMC(opts.vaultId);
  if (ourCached && peerVMC.vault_epoch < ourCached.vault_epoch) {
    throw new MeshHandshakeError(
      `peer vault_epoch ${peerVMC.vault_epoch} is older than ours ${ourCached.vault_epoch}; refusing handshake (peer will refresh on next check-in)`,
      "vmc_invalid",
    );
  }
  console.log(
    "[mesh.hs] epoch gate OK peer_epoch=",
    peerVMC.vault_epoch,
    "ours=",
    ourCached?.vault_epoch,
  );

  // --- Proof of possession ---
  //
  // We've verified the peer's VMC blob is a server-signed credential
  // binding (device_pubkey, vault_id, role, ...). What we still don't
  // know is whether the entity at the OTHER end of this socket is the
  // device that owns the matching private key. Without this check,
  // anyone who copies the SQLite vault_credentials row off a phone
  // (e.g. via ADB on a debuggable build, a backup that wasn't excluded
  // from Android's auto-backup, or a rooted phone) can replay the blob
  // and impersonate the legitimate device.
  //
  // Both sides exchange:
  //   1. PoP-proof for the OTHER side's challenge:
  //      sig = ed25519_sign(own_privkey,
  //        POP_DOMAIN || own_vmc_blob_bytes || peer_pop_nonce)
  //   2. Verify the peer's proof against THEIR device_pubkey from THEIR
  //      VMC body, over (POP_DOMAIN || peer_vmc_blob || OUR pop_nonce).
  //
  // The domain tag and our nonce make the signature unforgeable — even
  // an attacker who somehow recorded a previous handshake's PoP sig
  // can't replay it on a new session with a fresh nonce.
  // v2 (v0.5.2 final): bind BOTH ephemeral X25519 pubkeys into the signed
  // PoP message so a Hello-mutation MITM that substitutes a different
  // ephemeral pubkey can't get the peer's PoP to accidentally authenticate
  // the wrong key.
  const ourSigBytes = await signWithDeviceKey(
    buildPopMessageWithEphemerals(
      POP_DOMAIN,
      opts.localVMCBlob,
      peerHello.pop_nonce,
      ourEphemeral.publicKey,
      peerEphemeralPub,
    ),
  );
  console.log("[mesh.hs] our PoP signed sigLen=", ourSigBytes.length);
  const ourProof: PopProofMessage = {
    type: "pop_proof",
    v: WIRE_VERSION,
    sig: bytesToB64Url(ourSigBytes),
  };
  const [, peerProof] = await Promise.all([
    sendMessage(conn, ourProof),
    recvTyped<PopProofMessage>(conn, "pop_proof", 10_000),
  ]);
  console.log("[mesh.hs] peer PoP received");

  const peerDevicePubkey = decodeDevicePubkey(peerVMC.device_pubkey);
  if (!peerDevicePubkey) {
    throw new MeshHandshakeError(
      `peer VMC carries malformed device_pubkey (length != 32)`,
      "vmc_invalid",
    );
  }
  const peerSigBytes = b64UrlDecode(peerProof.sig);
  if (peerSigBytes.length !== 64) {
    throw new MeshHandshakeError(
      `peer PoP signature has wrong length ${peerSigBytes.length} (expected 64)`,
      "pop_failed",
    );
  }
  // Verify the peer's PoP against (POP_DOMAIN || peer_vmc || OUR_nonce ||
  // peer_ephemeral_pub || our_ephemeral_pub). From the peer's perspective
  // their "own pub" is peerEphemeralPub and their "peer pub" is ours, so
  // the argument order is swapped here vs. when we signed our own PoP.
  const popMsg = buildPopMessageWithEphemerals(
    POP_DOMAIN,
    peerHello.vmc_blob,
    ourNonceB64,
    peerEphemeralPub,
    ourEphemeral.publicKey,
  );
  let popOk = false;
  try {
    // SYNC verify — uses sha512Sync shim. Async variant needs crypto.subtle.
    popOk = ed.verify(peerSigBytes, popMsg, peerDevicePubkey);
  } catch (err) {
    if (__DEV__) console.warn("[mesh.hs] ed.verify threw — sha512Sync shim missing?", err);
    popOk = false;
  }
  if (!popOk) {
    throw new MeshHandshakeError(
      `peer failed proof-of-possession check — they hold a valid VMC blob ` +
        `but do not control the matching private key (likely VMC theft attempt)`,
      "pop_failed",
    );
  }
  console.log("[mesh.hs] PoP verified peer=", peerVMC.device_id.slice(0, 8));

  // ---- AEAD key derivation + install ------------------------------------
  //
  // We derive the ChaCha20-Poly1305 key for ALL transports that expose
  // installAead(). On BLE this enables encryption from here on. On WebRTC,
  // BleMeshConnection isn't in play — the WebRTC transport's MeshConnection
  // doesn't implement installAead, so the call is a no-op (DTLS already
  // protects that link). On in-memory test connections: same.
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
  } else if (conn.kind === "ble") {
    // BLE without installAead is a logic bug — fail loud rather than
    // accept plaintext on this transport.
    throw new MeshHandshakeError(
      "BLE connection has no installAead method — AEAD cannot be enabled",
      "transport",
    );
  }

  conn.remoteDeviceId = peerVMC.device_id;
  return peerVMC;
}

async function reverifyVMCWindow(peer: ParsedVMC): Promise<void> {
  const now = Date.now();
  // Apply the same EXPIRY_SKEW_TOLERANCE_MS leeway as the initial verifyVMC
  // — otherwise a peer with a slow clock that passed verify-time would get
  // immediately killed on the first batch's mid-session check, producing
  // a handshake -> abort -> rehandshake -> abort livelock.
  if (peer.expires_at_ms + EXPIRY_SKEW_TOLERANCE_MS < now) {
    throw new MeshVMCExpiredError(
      `peer VMC expired during anti-entropy (expired_at_ms=${peer.expires_at_ms}, now=${now})`,
    );
  }
  if (await isRevoked(peer.vault_id, peer.device_id)) {
    throw new MeshVMCRevokedError(`peer device ${peer.device_id} revoked mid-session`);
  }
}

// v2 PoP message (v0.5.2 final). Binds:
//   POP_DOMAIN ASCII || vmcBlob UTF-8 || pop_nonce UTF-8
//   || own_ephemeral_x25519_pubkey (32 raw bytes)
//   || peer_ephemeral_x25519_pubkey (32 raw bytes)
//
// The ephemeral-pubkey binding closes the Hello-mutation seam where an
// attacker could substitute their own ephemeral pubkey in transit and the
// peer's PoP signature (which only covered nonces + VMC in v1) would
// "authenticate" the attacker's key. With the binding, swapping the
// ephemeral pubkey invalidates every peer's PoP signature.
//
// "own" / "peer" are from the signer's perspective: the signer always
// puts THEIR ephemeral pub first, then the verifier's.
function buildPopMessageWithEphemerals(
  domain: string,
  vmcBlob: string,
  pop_nonce: string,
  ownEphemeralPub: Uint8Array,
  peerEphemeralPub: Uint8Array,
): Uint8Array {
  // eslint-disable-next-line no-undef
  const enc = new TextEncoder();
  const d = enc.encode(domain);
  const v = enc.encode(vmcBlob);
  const n = enc.encode(pop_nonce);
  const out = new Uint8Array(
    d.length + v.length + n.length + ownEphemeralPub.length + peerEphemeralPub.length,
  );
  let off = 0;
  out.set(d, off);
  off += d.length;
  out.set(v, off);
  off += v.length;
  out.set(n, off);
  off += n.length;
  out.set(ownEphemeralPub, off);
  off += ownEphemeralPub.length;
  out.set(peerEphemeralPub, off);
  return out;
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
 * Compute the local max-HLC-per-device-id summary for one vault.
 *
 * Two-pass implementation (safer than the prior single-statement correlated
 * subquery that referenced an outer aggregate from the inner WHERE — that
 * pattern relies on undocumented SQLite behavior and could silently break on
 * a future engine upgrade):
 *
 *   1. SELECT device_id, MAX(hlc_physical_ms) → (device_id, pms) pairs.
 *   2. For each pair, SELECT MAX(hlc_logical) WHERE physical_ms = pms.
 *
 * The schema's CHECK (device_id = hlc_device_id) invariant (migration 007)
 * makes the device-id tiebreak collapse — every row for a given device_id
 * has the same did, so we can omit it from the GROUP BY key.
 */
export async function computeSummary(vaultId: string): Promise<Record<string, HLC>> {
  const db = await getDb();
  const heads = await db.getAllAsync<{
    device_id: string;
    pms: number;
  }>(
    `SELECT device_id, MAX(hlc_physical_ms) AS pms
       FROM event_log
      WHERE vault_id = ? AND rejected_at IS NULL
      GROUP BY device_id`,
    vaultId,
  );

  const out: Record<string, HLC> = {};
  for (const h of heads) {
    const row = await db.getFirstAsync<{ l: number }>(
      `SELECT MAX(hlc_logical) AS l
         FROM event_log
        WHERE vault_id = ?
          AND device_id = ?
          AND hlc_physical_ms = ?
          AND rejected_at IS NULL`,
      vaultId,
      h.device_id,
      h.pms,
    );
    out[h.device_id] = {
      pms: h.pms,
      l: row?.l ?? 0,
      did: h.device_id,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Volume estimation for the wifi-upgrade decision
// ---------------------------------------------------------------------------

/**
 * Count the local rows that are strictly newer than the peer's per-device
 * head HLC — i.e., the number of events we'd SEND in this anti-entropy
 * round. Bounds the wifi-upgrade threshold check without doing the actual
 * fetch.
 *
 * The peer's RECEIVE-direction pending count cannot be computed from a
 * one-sided summary; for the prompt threshold the caller doubles the
 * SEND count as a conservative upper bound (typical vault-join is
 * symmetric — both sides have something the other lacks).
 *
 * device_ids the peer has never seen are treated as floor=null (we send
 * ALL of our events for that device).
 */
export async function countDeltaEventsFromSummary(
  vaultId: string,
  peerMaxHlcPerDevice: Record<string, HLC>,
): Promise<number> {
  const db = await getDb();
  // SUM across all our devices for vault — for each device, count rows
  // strictly above the peer's floor. SQL injection N/A — values bound.
  const rows = await db.getAllAsync<{ device_id: string; cnt: number }>(
    `SELECT device_id, COUNT(*) AS cnt
       FROM event_log
      WHERE vault_id = ? AND rejected_at IS NULL
      GROUP BY device_id`,
    vaultId,
  );
  let total = 0;
  for (const r of rows) {
    const floor = peerMaxHlcPerDevice[r.device_id];
    if (!floor) {
      // Peer has never seen this device — we'd send all rows.
      total += r.cnt;
      continue;
    }
    // Re-query to count rows strictly above the floor.
    const row = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM event_log
        WHERE vault_id = ? AND device_id = ? AND rejected_at IS NULL
          AND (hlc_physical_ms > ?
               OR (hlc_physical_ms = ? AND hlc_logical > ?))`,
      vaultId,
      r.device_id,
      floor.pms,
      floor.pms,
      floor.l,
    );
    total += row?.c ?? 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Send-side cursor
// ---------------------------------------------------------------------------

type SendCursor = {
  pendingDeviceIds: string[];
  floorByDevice: Map<string, HLC>;
  currentDeviceId: string | null;
  currentSentThrough: HLC | null;
};

function newSendCursor(peerMaxHlc: Record<string, HLC>): SendCursor {
  const floor = new Map<string, HLC>();
  for (const [did, hlc] of Object.entries(peerMaxHlc)) {
    floor.set(did, hlc);
  }
  return {
    pendingDeviceIds: [],
    floorByDevice: floor,
    currentDeviceId: null,
    currentSentThrough: null,
  };
}

async function fetchNextBatch(
  vaultId: string,
  cursor: SendCursor,
  limit: number,
): Promise<WireMeshEvent[]> {
  const db = await getDb();
  const batch: WireMeshEvent[] = [];

  if (cursor.currentDeviceId === null && cursor.pendingDeviceIds.length === 0) {
    const rows = await db.getAllAsync<{ device_id: string }>(
      `SELECT DISTINCT device_id FROM event_log
        WHERE vault_id = ? AND rejected_at IS NULL
        ORDER BY device_id ASC`,
      vaultId,
    );
    cursor.pendingDeviceIds = rows.map((r) => r.device_id);
  }

  while (batch.length < limit) {
    if (cursor.currentDeviceId === null) {
      const next = cursor.pendingDeviceIds.shift();
      if (next == null) return batch;
      cursor.currentDeviceId = next;
      cursor.currentSentThrough = cursor.floorByDevice.get(next) ?? null;
    }

    const did = cursor.currentDeviceId;
    const floor = cursor.currentSentThrough;
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
    }>(
      `SELECT event_id, event_type, target_id, relationship_id,
              hlc_physical_ms, hlc_logical, hlc_device_id,
              device_id, actor_account_id, payload_json, payload_schema,
              event_sig_b64, signer_device_pubkey
         FROM event_log
        WHERE vault_id = ?
          AND device_id = ?
          AND rejected_at IS NULL
          AND (hlc_physical_ms > ?
               OR (hlc_physical_ms = ? AND hlc_logical > ?))
        ORDER BY hlc_physical_ms ASC, hlc_logical ASC
        LIMIT ?`,
      vaultId,
      did,
      floor?.pms ?? -1,
      floor?.pms ?? -1,
      floor?.l ?? -1,
      remaining,
    );

    for (const r of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(r.payload_json);
      } catch {
        continue;
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
        actor_account_id: r.actor_account_id,
        payload,
        schema_version: r.payload_schema,
        event_sig_b64: r.event_sig_b64,
        signer_device_pubkey: r.signer_device_pubkey,
      });
      cursor.currentSentThrough = {
        pms: r.hlc_physical_ms,
        l: r.hlc_logical,
        did: r.hlc_device_id,
      };
    }

    if (rows.length < remaining) {
      cursor.currentDeviceId = null;
      cursor.currentSentThrough = null;
    }
  }

  return batch;
}

// ---------------------------------------------------------------------------
// Receive-side application
// ---------------------------------------------------------------------------

async function applyIncomingBatch(
  expectedVaultId: string,
  events: WireMeshEvent[],
): Promise<{ applied: number; duplicates: number }> {
  let applied = 0;
  let duplicates = 0;

  const sorted = [...events].sort((a, b) => compareHLC(a.hlc, b.hlc));

  for (const w of sorted) {
    if (!isKnownEventType(w.event_type)) continue;
    if (w.vault_id !== expectedVaultId) continue;

    const now = Date.now();
    const event: LedgerEvent = {
      event_id: w.event_id,
      event_type: w.event_type,
      vault_id: w.vault_id,
      target_id: w.target_id ?? "",
      relationship_id: w.relationship_id ?? null,
      hlc: w.hlc,
      device_id: w.device_id,
      // author_user_id_local_only is a device-LOCAL field that never crosses
      // the wire (per events.ts envelope comment). Set to "" for remote-origin
      // events; appliers consult it only on local-origin events.
      author_user_id_local_only: "",
      actor_account_id: w.actor_account_id,
      payload: w.payload,
      payload_schema: w.schema_version,
      appended_at: now,
      // Mesh events are NOT server-acked. When this device next reaches the
      // server, the existing sync push path will pick them up because they
      // satisfy WHERE server_acked_at IS NULL — closing the bridge
      // automatically. This is the "emergent bridging" referenced in the
      // Phase 5 plan.
      server_acked_at: null,
      rejected_at: null,
      origin: "remote",
    } as unknown as LedgerEvent;

    try {
      const result = await applyEvent(event, { origin: "remote" });
      if (result.applied) {
        applied++;
      } else {
        duplicates++;
      }
    } catch (err) {
      // Per-event failure is non-fatal: an applier may refuse (e.g.
      // shop_profile_updated arriving before shop_profile row exists), and
      // the next anti-entropy round will retry once the prereq lands.
      //
      // Distinguish role-gate refusals from generic applier throws so
      // logcat triage is O(seconds) instead of "applyEvent failed" 47×.
      const msg = (err as Error)?.message ?? String(err);
      if (msg.includes("role") || msg.includes("unsigned") || msg.includes("signature")) {
        console.warn(
          `[mesh.delta] event REFUSED by role-gate event=${w.event_id} type=${w.event_type} reason=${msg}`,
        );
      } else {
        console.warn(`[mesh.delta] applyEvent failed for ${w.event_id} (${w.event_type})`, err);
      }
    }
  }

  return { applied, duplicates };
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
  const m = raw as { type?: unknown; v?: unknown };
  if (m.v !== WIRE_VERSION) {
    throw new MeshTransportError(
      `recv: unsupported wire version ${String(m.v)} (expected ${WIRE_VERSION})`,
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
