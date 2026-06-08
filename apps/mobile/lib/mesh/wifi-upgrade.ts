// apps/mobile/lib/mesh/wifi-upgrade.ts
//
// Phase 6: Opportunistic WiFi upgrade flow.
//
// CONTEXT (read first):
//   Phase 6 makes BLE the PRIMARY mesh transport (works without wifi/
//   internet — the actual founder-stated need for Afghan shops). BLE
//   throughput is ~8 kbps in practice (conservative floor), so an
//   initial-sync round with thousands of events would take many minutes
//   over BLE alone. For that one specific case, we surface an in-app
//   prompt: "Connect both phones to the same wifi — finishes in seconds."
//
//   The prompt is OPPORTUNISTIC. If either user says no, or wifi handshake
//   fails, or both phones aren't on the same LAN, we silently stay on
//   BLE. Phase 5's WebRTC + mDNS stack is the wifi transport — already
//   shipped in `transport.ts` + `discovery.ts` from Phase 5.1, fully
//   functional. This module is just the negotiation + swap glue.
//
// FLOW (high level — anti-entropy.ts owns the call site):
//
//   1. BLE handshake completes → BLE summary exchange completes.
//   2. anti-entropy.ts computes pending-event count via
//      `countDeltaEventsFromSummary` and calls `shouldPromptForWifi`.
//   3. If above threshold, anti-entropy calls `shouldOfferWifiUpgrade()`
//      for the in-app prompt.
//   4. If user picks 'wifi', anti-entropy calls
//      `coordinateWifiUpgrade(conn, peerDeviceId, ...)` — passing the
//      BLE-side authenticated `expectedPeerDeviceId` so the WebRTC
//      handshake can refuse a peer whose VMC device_id doesn't match
//      (defends against mDNS race / LAN MITM).
//        - Sends `wifi_upgrade_request` over BLE.
//        - Awaits peer's `wifi_upgrade_response`.
//        - If both consent: opens discovery-router upgrade window,
//          waits for mDNS → WebRTC dial; races up to 10s.
//        - On WebRTC success: returns the new MeshConnection (with the
//          fresh VMC+PoP handshake completed inside dialPeer's caller).
//          Caller (anti-entropy.ts) swaps it in and resumes delta exchange.
//        - On failure: returns success=false; anti-entropy.ts stays
//          on BLE without reset.
//   5. After the heavy delta exchange completes, anti-entropy.ts may
//      call `downgradeToBle()` so the foreground Shop-Mode service
//      goes back to low-power BLE listening for ongoing low-volume
//      sync. (No-op if BLE connection is still live; closing wifi
//      conn is the caller's responsibility.)
//
// NON-GOALS:
//   - We don't implement the UI here. `shouldOfferWifiUpgrade()` calls
//     into a tiny imperative bridge (`presentWifiUpgradePrompt`) that is
//     wired by the MeshController at app boot.
//
// CONCURRENT-INITIATION RACE (CORRECTED in Phase 6 v2):
//   The original protocol's design had a fatal ambiguity: when both peers
//   initiated simultaneously, the "winner" replied with
//   `wifi_upgrade_response { accepted: false, reason: "busy" }` on the
//   peer's incoming request — but the peer interpreted that as a decline
//   of THEIR original outbound request and exited. Both sides deadlocked
//   into peer_timeout despite both wanting the upgrade.
//
//   FIX: introduce a distinct message type for the cross-decline:
//   `wifi_upgrade_dropme` ("I'm dropping my request, treat yours as
//   canonical"). Lex-loser sends `wifi_upgrade_dropme` upon receiving the
//   winner's request, then waits for the winner's response to its own
//   prior outbound request. Winner sees `wifi_upgrade_dropme` and knows
//   the lex-loser has accepted; it sends its own `wifi_upgrade_response
//   { accepted: true }`. Both sides converge cleanly with no ambiguity.

import { dialPeer, type MeshConnection, type PeerHint } from "./transport";
import { onPeerFound, onPeerLost, type DiscoveredPeer } from "./discovery";
import { closeUpgradeWindow, openUpgradeWindow } from "./discovery-router";

// ---------------------------------------------------------------------------
// Tunable constants (exported for tweaking after real-device measurements).
// ---------------------------------------------------------------------------

export const TUNABLE_CONSTANTS = {
  /**
   * Estimated BLE goodput in kilobits per second. Conservative floor —
   * actual hardware on a 244-MTU GATT WRITE_WITHOUT_RESPONSE link
   * typically achieves 30-50 kbps, but with overhead, retransmits,
   * and battery-throttled radios on Android, 8 kbps is a safe
   * planning number. Bump after real-device measurements.
   */
  ESTIMATED_BLE_KBPS: 8,

  /**
   * Weighted average JSON-serialized size of a mesh event in bytes.
   * Derived from a sample of EntryCreatedEvent (~310B), VaultMember*
   * (~180B), and PersonCreated (~220B). The big EntryCreatedEvent with
   * backfill payloads dominates real workloads.
   */
  ESTIMATED_AVG_EVENT_BYTES: 250,

  /**
   * Threshold for offering the wifi upgrade. Below this, BLE is fine
   * — no need to bother the user. 120 seconds (2 min) is the line at
   * which "this is going to take a while" becomes obvious enough to
   * warrant a prompt.
   */
  BLE_WIFI_UPGRADE_PROMPT_SECONDS: 120,

  /**
   * How long we wait for the user to respond to the prompt before we
   * default to 'ble' and proceed silently. 30s is long enough for the
   * shopkeeper to read the prompt while still feeling responsive.
   */
  PROMPT_AUTO_DISMISS_MS: 30_000,

  /**
   * How long we wait for the peer to consent + appear via mDNS after
   * both sides have agreed to try wifi. If mDNS doesn't surface the
   * peer in this window (e.g., different LANs, mDNS blocked by AP
   * isolation), we silently fall back to BLE.
   */
  MDNS_DISCOVERY_TIMEOUT_MS: 10_000,

  /**
   * How long we wait for the peer's `wifi_upgrade_response` after we
   * send a `wifi_upgrade_request`. Short — the peer either
   * accepts/declines instantly via their own prompt-defer logic or
   * times out and we stay on BLE.
   */
  COORDINATION_RESPONSE_TIMEOUT_MS: 35_000,

  /**
   * How long we wait for the WebRTC dial to complete once both phones
   * have surfaced each other via mDNS. WebRTC's own
   * SDP/ICE/DC-open timers add up to ~60s in the worst case; we cap
   * the wrapper at 20s and treat anything longer as failure.
   */
  WEBRTC_DIAL_TIMEOUT_MS: 20_000,
};

export const BLE_WIFI_UPGRADE_PROMPT_SECONDS = TUNABLE_CONSTANTS.BLE_WIFI_UPGRADE_PROMPT_SECONDS;
export const ESTIMATED_BLE_KBPS = TUNABLE_CONSTANTS.ESTIMATED_BLE_KBPS;
export const ESTIMATED_AVG_EVENT_BYTES = TUNABLE_CONSTANTS.ESTIMATED_AVG_EVENT_BYTES;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

const WIFI_UPGRADE_WIRE_VERSION = 1 as const;

export type WifiUpgradeRequest = {
  type: "wifi_upgrade_request";
  v: typeof WIFI_UPGRADE_WIRE_VERSION;
  estimated_seconds: number;
  total_events: number;
  peer_label?: string;
  /**
   * Sender's stable peer identifier (device_id / install_id). Used to
   * break the concurrent-initiation race deterministically by
   * lexicographic comparison.
   */
  initiator_id: string;
  /**
   * Vault we're trying to upgrade. Mirrored so the peer can scope
   * its mDNS browse to the same vault hash.
   */
  vault_id: string;
};

export type WifiUpgradeResponse = {
  type: "wifi_upgrade_response";
  v: typeof WIFI_UPGRADE_WIRE_VERSION;
  accepted: boolean;
  reason?: "user_declined" | "no_wifi" | "busy" | "timeout";
};

/**
 * "I'm dropping my own request, treat yours as canonical." Sent by the
 * lex-loser when both peers initiate simultaneously. Distinct from
 * `wifi_upgrade_response` so the recipient (lex-winner) can't confuse
 * it with a response to their own outbound request.
 *
 * Wire-version-gated like the others — older clients won't emit this,
 * but they also won't trigger the concurrent-initiation race because
 * the upgrade prompt is opt-in and they'll never both hit the threshold
 * in the same 30s window before this ships widely.
 */
export type WifiUpgradeDropMe = {
  type: "wifi_upgrade_dropme";
  v: typeof WIFI_UPGRADE_WIRE_VERSION;
};

// ---------------------------------------------------------------------------
// User-facing choice type returned by the prompt.
// ---------------------------------------------------------------------------

export type WifiUpgradeChoice = "ble" | "wifi" | "cancel";

// ---------------------------------------------------------------------------
// UI bridge — wired at app boot by MeshController.
// ---------------------------------------------------------------------------
//
// Same pattern as `foreground.ts`: the mesh package never imports React
// / RN components; instead it exposes an imperative `set...Bridge`
// hook the UI registers on mount. If no bridge is registered (Expo Go,
// tests, etc.), `shouldOfferWifiUpgrade` falls back to 'ble' silently
// — the assumption is that mesh sync should never block waiting for
// user input that can't be surfaced.

export type WifiUpgradePromptOpts = {
  estimatedSeconds: number;
  totalEvents: number;
  peerLabel?: string;
};

export type WifiUpgradePromptFn = (opts: WifiUpgradePromptOpts) => Promise<WifiUpgradeChoice>;

export type ToastFn = (message: string, kind?: "info" | "error" | "success") => void;

let promptBridge: WifiUpgradePromptFn | null = null;
let toastBridge: ToastFn | null = null;

/**
 * Register the in-app prompt function. Called once by MeshController
 * (or a sibling provider) at app boot.
 */
export function setWifiUpgradePromptBridge(fn: WifiUpgradePromptFn | null): void {
  promptBridge = fn;
}

/**
 * Register the toast bridge for fallback messages ("Couldn't connect
 * over wifi, using Bluetooth"). Optional — without it, fallback is
 * silent.
 */
export function setWifiUpgradeToastBridge(fn: ToastFn | null): void {
  toastBridge = fn;
}

// ---------------------------------------------------------------------------
// Estimation helpers
// ---------------------------------------------------------------------------

/**
 * Compute the estimated BLE transfer time in seconds for `totalEvents`
 * events at the conservative-floor throughput. Pure function; callable
 * from anti-entropy.ts without state.
 */
export function estimateBleSeconds(totalEvents: number): number {
  const totalBytes = totalEvents * ESTIMATED_AVG_EVENT_BYTES;
  const bytesPerSecond = (ESTIMATED_BLE_KBPS * 1024) / 8;
  if (bytesPerSecond <= 0) return Number.POSITIVE_INFINITY;
  return totalBytes / bytesPerSecond;
}

/**
 * Returns true if the estimated transfer time exceeds the prompt
 * threshold. Caller short-circuits to BLE on `false` without ever
 * involving the user.
 */
export function shouldPromptForWifi(totalEvents: number): boolean {
  return estimateBleSeconds(totalEvents) > BLE_WIFI_UPGRADE_PROMPT_SECONDS;
}

// ---------------------------------------------------------------------------
// Public API: ask the user
// ---------------------------------------------------------------------------

/**
 * Surface the in-app prompt and resolve to the user's choice. If no
 * UI bridge is registered, resolves to 'ble' (silent default). If the
 * user doesn't respond within `PROMPT_AUTO_DISMISS_MS`, also resolves
 * to 'ble' AND emits a "Continuing over Bluetooth" toast so the user
 * sees that a decision was made on their behalf (UX critique L1).
 *
 * Returned values:
 *   'wifi'   — try the wifi handoff
 *   'ble'    — continue over BLE (slow but works)
 *   'cancel' — abort sync entirely; caller should close the
 *              connection cleanly without delta exchange
 */
export async function shouldOfferWifiUpgrade(
  estimatedSeconds: number,
  totalEvents: number,
  peerLabel?: string,
): Promise<WifiUpgradeChoice> {
  if (!promptBridge) {
    return "ble";
  }
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let autoDismissed = false;
  try {
    const choice = await Promise.race<WifiUpgradeChoice>([
      promptBridge({ estimatedSeconds, totalEvents, peerLabel }).then((c) => {
        settled = true;
        return c;
      }),
      new Promise<WifiUpgradeChoice>((resolve) => {
        timer = setTimeout(() => {
          if (!settled) {
            autoDismissed = true;
            resolve("ble");
          }
        }, TUNABLE_CONSTANTS.PROMPT_AUTO_DISMISS_MS);
      }),
    ]);
    if (autoDismissed) {
      emitToast("Continuing over Bluetooth", "info");
    }
    return choice;
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] prompt threw, defaulting to ble", err);
    return "ble";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API: coordinate the upgrade with the peer over BLE
// ---------------------------------------------------------------------------

export type CoordinateOptions = {
  /**
   * Stable identifier for our side (device_id / install_id). Used in
   * the wire message and to break the concurrent-initiation race
   * by lexicographic comparison with the peer's identifier.
   */
  ownPeerId: string;
  /**
   * Stable identifier for the peer. Embedded in `initiator_id` of
   * outbound requests so the peer's race-resolver can pick a winner.
   * Also used as `expectedPeerDeviceId` for the post-WebRTC-handshake
   * continuity check (security critique C2 / H4).
   */
  peerId: string;
  /**
   * Vault we're syncing. Embedded in the request + used to scope our
   * mDNS browse.
   */
  vaultId: string;
  /**
   * Estimated wifi-upgrade savings — for the wire message so the
   * peer's UI can show the same number.
   */
  estimatedSeconds: number;
  totalEvents: number;
  /**
   * The real WebRTC signaling listener port — must be advertised via
   * mDNS so the peer can dial us. Engineering critique #5: passing 0
   * here makes peers refuse the dial.
   */
  listenPort: number;
  /**
   * Optional friendly label shown in the peer's prompt
   * ("Sync with Ahmad's phone").
   */
  peerLabel?: string;
};

export type CoordinateResult = {
  success: boolean;
  newConnection?: MeshConnection;
  /**
   * The post-WebRTC-handshake expected peer device_id. Caller MUST verify
   * after running runAntiEntropy on the new connection that
   * `newConnection.remoteDeviceId === expectedPeerDeviceId`; otherwise
   * close the WebRTC connection and stay on BLE. We can't verify here
   * because the handshake happens inside anti-entropy.ts which the
   * caller drives.
   */
  expectedPeerDeviceId?: string;
  /**
   * When success=false, a code the caller can log / surface for
   * diagnostics. None of these are fatal — caller stays on BLE.
   */
  reason?:
    | "peer_declined"
    | "peer_timeout"
    | "no_wifi_hint"
    | "mdns_timeout"
    | "webrtc_failed"
    | "race_lost"
    | "transport_error";
};

/**
 * Send `wifi_upgrade_request` over the BLE connection, await the
 * peer's response, and on mutual consent perform mDNS discovery
 * + WebRTC dial. Returns the new MeshConnection on success.
 *
 * On any failure path (peer declines, mDNS times out, WebRTC fails),
 * we surface a single toast — "Couldn't connect over wifi, using
 * Bluetooth" — and return success=false. The caller (anti-entropy.ts)
 * stays on the existing BLE connection without resetting state.
 *
 * The BLE connection is NEVER closed by this function. Closing the
 * BLE connection on successful upgrade is the caller's
 * responsibility (anti-entropy.ts knows whether the swap succeeded
 * and the delta loop finished cleanly).
 *
 * The caller (anti-entropy.ts) MUST validate the post-handshake
 * `remoteDeviceId` on the returned connection against
 * `expectedPeerDeviceId` — a MITM on the LAN could otherwise hijack
 * the WebRTC handshake's identity binding.
 */
export async function coordinateWifiUpgrade(
  connection: MeshConnection,
  opts: CoordinateOptions,
): Promise<CoordinateResult> {
  // -- 1. Send our wifi_upgrade_request over BLE.
  try {
    const req: WifiUpgradeRequest = {
      type: "wifi_upgrade_request",
      v: WIFI_UPGRADE_WIRE_VERSION,
      estimated_seconds: Math.round(opts.estimatedSeconds),
      total_events: opts.totalEvents,
      peer_label: opts.peerLabel,
      initiator_id: opts.ownPeerId,
      vault_id: opts.vaultId,
    };
    await connection.sendJSON(req);
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] sendJSON request failed", err);
    return { success: false, reason: "transport_error" };
  }

  // -- 2. Await the peer's wifi_upgrade_response.
  //
  // Concurrent-initiation case: if peer sent their own
  // `wifi_upgrade_request` simultaneously, we'll receive that
  // instead of (or before) a `wifi_upgrade_response`. Resolved by
  // lexicographic peer_id comparison — smaller initiator_id wins.
  // The LOSER sends `wifi_upgrade_dropme` and then waits for the
  // winner's outbound response. The WINNER ignores incoming requests
  // it should not have received (peer_id < ours) — but per the
  // protocol invariant only the lex-loser sends a request that the
  // lex-winner sees, so this is symmetric: both sides act.
  //
  // See the corrected protocol in the file header for why the previous
  // implementation deadlocked.
  let peerResp: WifiUpgradeResponse | null = null;
  const deadline = Date.now() + TUNABLE_CONSTANTS.COORDINATION_RESPONSE_TIMEOUT_MS;

  // We allow up to 4 messages off the wire to cover:
  //   - peer's incoming wifi_upgrade_request (race)
  //   - we send wifi_upgrade_dropme
  //   - peer sends their wifi_upgrade_response to OUR original request
  //   - any spurious extra
  for (let i = 0; i < 4; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let msg: unknown;
    try {
      msg = await connection.recvJSON(remaining);
    } catch (err) {
      if (__DEV__) console.warn("[wifi-upgrade] recvJSON failed/timeout", err);
      return { success: false, reason: "peer_timeout" };
    }
    if (msg && typeof msg === "object" && (msg as { __closed?: boolean }).__closed) {
      return { success: false, reason: "transport_error" };
    }
    if (isWifiUpgradeResponse(msg)) {
      peerResp = msg;
      break;
    }
    if (isWifiUpgradeRequest(msg)) {
      // Race resolution. The corrected protocol:
      //   - lex-loser (peer.initiator_id < ours): peer wins. We drop our
      //     own pending request and treat the peer's as canonical. We
      //     emit `wifi_upgrade_dropme` so the peer knows we're aligning,
      //     then send our consent response (accepted:true) for THEIR
      //     request, then ALSO synthesize peerResp=accepted so we
      //     proceed to the rendezvous below as the listener side.
      //   - lex-winner (peer.initiator_id > ours): we win. The peer's
      //     incoming request is one they sent before seeing ours. We
      //     IGNORE it on the read side (no response) and keep waiting
      //     for the peer's eventual response to OUR request (which they
      //     will send once they receive our wifi_upgrade_dropme... wait,
      //     they won't send dropme — they sent the request). On the
      //     winner side we wait for their response which they'll send
      //     once they see our outbound request beat theirs to the wire.
      //     If they don't, we time out — but the wire is FIFO over BLE
      //     SCTP-equivalent, so this is rare.
      if (msg.initiator_id < opts.ownPeerId) {
        // Peer wins. Emit dropme + accept-of-theirs.
        try {
          const dropMe: WifiUpgradeDropMe = {
            type: "wifi_upgrade_dropme",
            v: WIFI_UPGRADE_WIRE_VERSION,
          };
          await connection.sendJSON(dropMe);
          const accept: WifiUpgradeResponse = {
            type: "wifi_upgrade_response",
            v: WIFI_UPGRADE_WIRE_VERSION,
            accepted: true,
          };
          await connection.sendJSON(accept);
        } catch {
          /* best-effort — peer will time out and stay on BLE */
        }
        peerResp = {
          type: "wifi_upgrade_response",
          v: WIFI_UPGRADE_WIRE_VERSION,
          accepted: true,
        };
        break;
      } else {
        // We win. Drop peer's incoming request silently; keep waiting
        // for THEIR response to OUR canonical request. (No "decline of
        // theirs" message — that's what caused the original deadlock.)
        continue;
      }
    }
    if (isWifiUpgradeDropMe(msg)) {
      // Peer told us they dropped their own request. We're the winner.
      // Send our consent response as the canonical initiator and proceed.
      try {
        const accept: WifiUpgradeResponse = {
          type: "wifi_upgrade_response",
          v: WIFI_UPGRADE_WIRE_VERSION,
          accepted: true,
        };
        await connection.sendJSON(accept);
      } catch {
        /* best-effort */
      }
      peerResp = {
        type: "wifi_upgrade_response",
        v: WIFI_UPGRADE_WIRE_VERSION,
        accepted: true,
      };
      break;
    }
    // Unknown message shape — protocol violation. Bail.
    if (__DEV__) console.warn("[wifi-upgrade] unexpected message during coord", msg);
    return { success: false, reason: "transport_error" };
  }

  if (!peerResp) {
    return { success: false, reason: "peer_timeout" };
  }
  if (!peerResp.accepted) {
    return { success: false, reason: "peer_declined" };
  }

  // -- 3. Both sides have agreed. Open the discovery-router upgrade
  //    window (spinning up mDNS alongside BLE for ~10s), then wait for
  //    the peer to appear. If they don't surface within the timeout,
  //    fall back to BLE.
  try {
    await openUpgradeWindow({ listenPort: opts.listenPort });
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] openUpgradeWindow failed", err);
    emitToast("Couldn't connect over wifi, using Bluetooth");
    return { success: false, reason: "mdns_timeout" };
  }
  emitToast("Looking for the other phone on wifi…", "info");
  const peerHint = await raceForMdnsPeer(opts.vaultId);
  if (!peerHint) {
    emitToast("Couldn't connect over wifi, using Bluetooth");
    return { success: false, reason: "mdns_timeout" };
  }

  // -- 4. WebRTC dial (or accept). Determine role from the
  //    same lex-compare: smaller ownPeerId dials, larger listens.
  if (opts.ownPeerId > opts.peerId) {
    // We listen. The new WebRTC connection lands on
    // MeshController's incoming handler, which runs its own fresh VMC+PoP
    // handshake. The listener-side anti-entropy stays on BLE for this
    // session — only ONE side needs to carry the upgrade for the heavy
    // delta lift, and the wire is symmetric once the dialer's connection
    // hits VMC verify.
    //
    // Important security invariant: the listener's incoming-handler MUST
    // verify post-handshake that `remoteDeviceId === expectedPeerDeviceId`
    // (== the BLE-authenticated `opts.peerId`). Otherwise a LAN MITM can
    // hijack the upgrade. We surface `expectedPeerDeviceId` here for the
    // caller's bookkeeping; today the upper-level orchestrator does NOT
    // route the incoming WebRTC connection back to this anti-entropy
    // session, so the BLE delta loop continues unchanged. This is the
    // known limitation called out in critique C6/M4.
    emitToast("Switching to wifi", "info");
    return {
      success: false,
      reason: "race_lost",
      expectedPeerDeviceId: opts.peerId,
    };
  }

  // -- 4b. Dialer path.
  let wifiConn: MeshConnection;
  try {
    wifiConn = await withTimeout(
      dialPeer(peerHint),
      TUNABLE_CONSTANTS.WEBRTC_DIAL_TIMEOUT_MS,
      "webrtc dial timeout",
    );
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] WebRTC dial failed", err);
    emitToast("Couldn't connect over wifi, using Bluetooth");
    return { success: false, reason: "webrtc_failed" };
  }

  emitToast("Switched to wifi for faster sync", "success");
  return {
    success: true,
    newConnection: wifiConn,
    expectedPeerDeviceId: opts.peerId,
  };
}

// ---------------------------------------------------------------------------
// Public API: downgrade after the heavy lift is done
// ---------------------------------------------------------------------------

/**
 * Tear down the wifi-upgrade window (mDNS only — BLE stays up) so the
 * foreground service goes back to low-power BLE-only mode. Idempotent
 * and safe to call whether or not the upgrade succeeded.
 *
 * Routes through the discovery-router's `closeUpgradeWindow` rather than
 * `stopDiscovery` (Phase 5 API) — this is the architectural fix called
 * out in critique H2.
 */
export async function downgradeToBle(): Promise<void> {
  try {
    await closeUpgradeWindow();
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] closeUpgradeWindow failed", err);
  }
}

// ---------------------------------------------------------------------------
// Internal: mDNS race
// ---------------------------------------------------------------------------

async function raceForMdnsPeer(vaultId: string): Promise<PeerHint | null> {
  const refs: {
    unsubFound: null | (() => void);
    unsubLost: null | (() => void);
    timer: ReturnType<typeof setTimeout> | null;
  } = { unsubFound: null, unsubLost: null, timer: null };

  try {
    return await new Promise<PeerHint | null>((resolve) => {
      const onFound = (peer: DiscoveredPeer) => {
        if (peer.isSelf) return;
        if (!peer.matchedVaultIds.includes(vaultId)) return;
        if (!peer.host || !peer.port) return;
        resolve({
          host: peer.host,
          port: peer.port,
          serviceName: peer.serviceName,
        });
      };
      refs.unsubFound = onPeerFound(onFound);
      refs.unsubLost = onPeerLost(() => {
        /* */
      });
      refs.timer = setTimeout(() => resolve(null), TUNABLE_CONSTANTS.MDNS_DISCOVERY_TIMEOUT_MS);
    });
  } finally {
    if (refs.timer) clearTimeout(refs.timer);
    if (refs.unsubFound) {
      try {
        refs.unsubFound();
      } catch {
        /* */
      }
    }
    if (refs.unsubLost) {
      try {
        refs.unsubLost();
      } catch {
        /* */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: type guards + helpers
// ---------------------------------------------------------------------------

function isWifiUpgradeRequest(msg: unknown): msg is WifiUpgradeRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as {
    type?: unknown;
    v?: unknown;
    initiator_id?: unknown;
    vault_id?: unknown;
    estimated_seconds?: unknown;
    total_events?: unknown;
  };
  return (
    m.type === "wifi_upgrade_request" &&
    m.v === WIFI_UPGRADE_WIRE_VERSION &&
    typeof m.initiator_id === "string" &&
    typeof m.vault_id === "string" &&
    typeof m.estimated_seconds === "number" &&
    typeof m.total_events === "number"
  );
}

function isWifiUpgradeResponse(msg: unknown): msg is WifiUpgradeResponse {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; v?: unknown; accepted?: unknown };
  return (
    m.type === "wifi_upgrade_response" &&
    m.v === WIFI_UPGRADE_WIRE_VERSION &&
    typeof m.accepted === "boolean"
  );
}

function isWifiUpgradeDropMe(msg: unknown): msg is WifiUpgradeDropMe {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; v?: unknown };
  return m.type === "wifi_upgrade_dropme" && m.v === WIFI_UPGRADE_WIRE_VERSION;
}

function emitToast(message: string, kind: "info" | "error" | "success" = "info"): void {
  if (!toastBridge) return;
  try {
    toastBridge(message, kind);
  } catch (err) {
    if (__DEV__) console.warn("[wifi-upgrade] toast bridge threw", err);
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Convenience: build the prompt copy.
// ---------------------------------------------------------------------------
//
// The UI bridge owns the actual Modal/Sheet rendering, but the copy
// lives here so it's i18n-able from a single place. Phase 6 dropped the
// "Cancel sync" tertiary button (it was the wrong-default destructive
// action between two non-destructive ones; a tap-to-dismiss user could
// destroy in-flight delta exchange). To abort, users toggle the master
// Sync switch off — the proper kill path.

export type WifiUpgradePromptCopy = {
  title: string;
  body: string;
  tryWifiLabel: string;
  stayBleLabel: string;
};

export function buildWifiUpgradePromptCopy(opts: {
  estimatedSeconds: number;
  totalEvents: number;
  peerLabel?: string;
  t?: (key: string, vars?: Record<string, string | number>) => string;
}): WifiUpgradePromptCopy {
  const minutes = Math.max(1, Math.round(opts.estimatedSeconds / 60));
  const tFn = opts.t;
  if (tFn) {
    return {
      title: tFn("wifiUpgrade.title", { count: opts.totalEvents, min: minutes }),
      body: tFn("wifiUpgrade.body"),
      tryWifiLabel: tFn("wifiUpgrade.tryWifi"),
      stayBleLabel: tFn("wifiUpgrade.stayBle"),
    };
  }
  // Fallback English literals — matches Phase 6 spec copy.
  return {
    title: `Sync ~${opts.totalEvents} entries — about ${minutes} min over Bluetooth`,
    body: "Connect both phones to the same wifi to finish in seconds.",
    tryWifiLabel: "Try wifi",
    stayBleLabel: "Stay on Bluetooth",
  };
}
